import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { loadEnvConfig } from "@next/env";
import fs from "node:fs";
import { agentPrompt } from "../lib/agent/prompt";
import { DRIVE_SKILL, driveMapSkill } from "../lib/agent/skill";
import { AGENT_TOOLS } from "../lib/agent/tools";
import { env } from "../lib/config";
import { loadDriveMap } from "../lib/drive-map";

// Creates the Managed Agent's resources once, then updates the agent in place on every later run:
// npm run managed-agent. Prints the ids to keep in .env.local (MA_*). No secret is ever printed.
loadEnvConfig(process.cwd());

const FIREFLIES_MCP = "https://api.fireflies.ai/mcp";
// Google's own Drive server. It answers only for projects in Google's Workspace Developer Preview Program, so until
// GOOGLE_DRIVE_MCP=on it is attached with every tool off, and our own Drive tools do the work.
const GOOGLE_DRIVE_MCP = "https://drivemcp.googleapis.com/mcp/v1";
const GOOGLE_DRIVE_READ_TOOLS = ["search_files", "read_file_content", "list_recent_files", "get_file_metadata", "get_file_permissions"];
// Helmi's sign-in through the AI-agent OAuth client (npm run google-login with these two files).
const GOOGLE_AGENT_CLIENT_FILE = env("GOOGLE_AGENT_OAUTH_CLIENT_FILE") ?? "./secrets/google-oauth-agent-client.json";
const GOOGLE_AGENT_TOKEN_FILE = env("GOOGLE_AGENT_USER_TOKEN_FILE") ?? "./secrets/google-user-token-agent.json";
// Only the tools that read. Fireflies also offers sharing, moving, renaming and privacy changes; those stay off.
const FIREFLIES_READ_TOOLS = [
  "fireflies_search",
  "fireflies_fetch",
  "fireflies_get_transcripts",
  "fireflies_get_transcript",
  "fireflies_get_summary",
  "fireflies_get_active_meetings",
  "fireflies_list_channels",
  "fireflies_get_channel",
  "fireflies_get_soundbites",
];

async function main() {
  const client = new Anthropic();

  let environmentId = env("MA_ENVIRONMENT_ID");
  if (!environmentId) {
    // No sandbox tools are used: the network only needs to reach the MCP servers.
    const environment = await client.beta.environments.create({
      name: "knowledge-assistant",
      config: { type: "cloud", networking: { type: "limited", allow_mcp_servers: true } },
    });
    environmentId = environment.id;
    console.log(`MA_ENVIRONMENT_ID=${environmentId}   (new)`);
  }

  let firefliesVault = env("MA_FIREFLIES_VAULT_ID");
  if (!firefliesVault) {
    const key = env("FIREFLIES_API_KEY");
    if (!key) throw new Error("FIREFLIES_API_KEY is not set.");
    const vault = await client.beta.vaults.create({ display_name: "Knowledge Assistant: Fireflies (Michael)" });
    await client.beta.vaults.credentials.create(vault.id, {
      display_name: "Fireflies MCP, Michael's account",
      auth: { type: "static_bearer", mcp_server_url: FIREFLIES_MCP, token: key },
    });
    firefliesVault = vault.id;
    console.log(`MA_FIREFLIES_VAULT_ID=${firefliesVault}   (new)`);
  }

  // The Drive map names internal files, so it is read from the database here and goes into the agent's
  // configuration on Anthropic's side, never into the code. Re-run this script after the map changes.
  // The shared vault holds the company-wide sign-ins: Fireflies (Michael) and Google Drive (Helmi).
  await client.beta.vaults.update(firefliesVault, { display_name: "Knowledge Assistant: shared connectors" });
  const existing: string[] = [];
  for await (const credential of client.beta.vaults.credentials.list(firefliesVault)) {
    const url = (credential.auth as { mcp_server_url?: string }).mcp_server_url;
    if (url && !credential.archived_at) existing.push(url);
  }
  if (!existing.includes(GOOGLE_DRIVE_MCP)) {
    if (!fs.existsSync(GOOGLE_AGENT_CLIENT_FILE) || !fs.existsSync(GOOGLE_AGENT_TOKEN_FILE)) {
      throw new Error(`Google Drive sign-in missing: run npm run google-login with ${GOOGLE_AGENT_CLIENT_FILE} and ${GOOGLE_AGENT_TOKEN_FILE}.`);
    }
    const raw = JSON.parse(fs.readFileSync(GOOGLE_AGENT_CLIENT_FILE, "utf8"));
    const oauth = raw.web ?? raw.installed;
    const token = JSON.parse(fs.readFileSync(GOOGLE_AGENT_TOKEN_FILE, "utf8"));
    if (!token.refresh_token) throw new Error("The Google sign-in has no refresh token: sign in again with npm run google-login.");
    await client.beta.vaults.credentials.create(firefliesVault, {
      display_name: "Google Drive MCP, Helmi's account",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: GOOGLE_DRIVE_MCP,
        access_token: token.access_token,
        expires_at: token.expiry_date ? new Date(token.expiry_date).toISOString() : null,
        // Anthropic refreshes the access token itself with these.
        refresh: {
          client_id: oauth.client_id,
          refresh_token: token.refresh_token,
          token_endpoint: "https://oauth2.googleapis.com/token",
          token_endpoint_auth: { type: "client_secret_post", client_secret: oauth.client_secret },
        },
      },
    });
    console.log("Google Drive sign-in stored in the shared vault");
  }
  const driveConnector = env("GOOGLE_DRIVE_MCP") === "on";

  // The Drive map names internal files, so it is read from the database here and uploaded as a skill to Anthropic,
  // never put in the code. Each run uploads a new version; run again after the map changes.
  const map = await loadDriveMap();
  if (!map) throw new Error("No Drive map found in the database.");
  const files = await Promise.all(driveMapSkill(map).map((f) => toFile(Buffer.from(f.content, "utf8"), `${DRIVE_SKILL}/${f.path}`)));
  let skillId = env("MA_DRIVE_SKILL_ID");
  if (skillId) {
    await client.skills.versions.create(skillId, { files });
    console.log(`skill ${DRIVE_SKILL}: new version uploaded (Drive map of ${map.generated_at.slice(0, 10)})`);
  } else {
    const skill = await client.skills.create({ display_name: "NDI Drive map", files });
    skillId = skill.id;
    console.log(`MA_DRIVE_SKILL_ID=${skillId}   (new)`);
  }

  const system = agentPrompt(env("GOOGLE_DRIVE_ID"), driveConnector);
  console.log(`prompt: ${system.length} characters`);

  const config = {
    name: "NDI Knowledge Assistant",
    description: "Claude in Google Chat for NDI: company knowledge from Drive, Gmail, Calendar, Chat and Fireflies, read-only.",
    model: { id: "claude-opus-5-5", effort: "medium" as const },
    system,
    mcp_servers: [
      { type: "url" as const, name: "fireflies", url: FIREFLIES_MCP },
      { type: "url" as const, name: "google_drive", url: GOOGLE_DRIVE_MCP },
    ],
    skills: [{ type: "custom" as const, skill_id: skillId, version: "latest" }],
    tools: [
      // Skills are files the agent reads in its sandbox: only the reading tools are on, no shell, no edits, no web.
      {
        type: "agent_toolset_20260401" as const,
        default_config: { enabled: false, permission_policy: { type: "always_allow" as const } },
        configs: (["read", "grep", "glob"] as const).map((name) => ({ name, enabled: true })),
      },
      {
        type: "mcp_toolset" as const,
        mcp_server_name: "fireflies",
        default_config: { enabled: false, permission_policy: { type: "always_allow" as const } },
        configs: FIREFLIES_READ_TOOLS.map((name) => ({ name, enabled: true })),
      },
      {
        type: "mcp_toolset" as const,
        mcp_server_name: "google_drive",
        default_config: { enabled: false, permission_policy: { type: "always_allow" as const } },
        // Only reading, never create_file or copy_file; and nothing at all until Google accepts the project.
        configs: driveConnector ? GOOGLE_DRIVE_READ_TOOLS.map((name) => ({ name, enabled: true })) : [],
      },
      // With Google's Drive connector on, our own Drive search and reading step aside.
      ...AGENT_TOOLS.filter((tool) => !driveConnector || (tool.name !== "search_drive" && tool.name !== "read_drive_file")),
    ],
  };
  console.log(`Google Drive connector: ${driveConnector ? "on (our Drive tools removed)" : "attached, tools off until GOOGLE_DRIVE_MCP=on"}`);

  const agentId = env("MA_AGENT_ID");
  const agent = agentId ? await client.beta.agents.update(agentId, config) : await client.beta.agents.create(config);
  console.log(`MA_AGENT_ID=${agent.id}   (version ${agent.version}${agentId ? ", updated" : ", new"})`);
  if (!agentId || !env("MA_ENVIRONMENT_ID") || !env("MA_FIREFLIES_VAULT_ID")) {
    console.log("\nAdd the new MA_* lines above to .env.local (and to Vercel before deploying).");
  }
}

// Exit explicitly: the database pool would otherwise keep the process alive.
main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
