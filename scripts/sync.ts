import { loadEnvConfig } from "@next/env";
import { getState, getStats, setState } from "../lib/db";
import { envInt } from "../lib/config";
import { errorMessage } from "../lib/text";
import { SOURCE_LABELS, type Source } from "../lib/types";
import { chatConfigured, syncChat } from "../lib/sources/gchat";
import { driveConfigured, syncDrive } from "../lib/sources/drive";
import { gmailConfigured, syncGmail } from "../lib/sources/gmail";
import { slackConfigured, syncSlack } from "../lib/sources/slack";
import type { SyncContext } from "../lib/sources/types";

// Same .env.local / .env files and precedence as `next dev`.
loadEnvConfig(process.cwd());

const CONNECTORS: { source: Source; configured: () => boolean; needs: string; run: (ctx: SyncContext) => Promise<number> }[] = [
  { source: "slack", configured: slackConfigured, needs: "SLACK_BOT_TOKEN", run: syncSlack },
  { source: "drive", configured: driveConfigured, needs: "npm run google-login (or GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GOOGLE_DRIVE_USER)", run: syncDrive },
  { source: "gmail", configured: gmailConfigured, needs: "npm run google-login (or GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GMAIL_MAILBOXES)", run: syncGmail },
  { source: "gchat", configured: chatConfigured, needs: "npm run google-login (or GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GOOGLE_CHAT_USER)", run: syncChat },
];

// The raw API errors that setup mistakes produce, mapped to the step that fixes them.
const HINTS: [RegExp, string][] = [
  [/unauthorized_client/i, "domain-wide delegation is missing or its scopes don't match exactly (SETUP.md 3.3). New delegations can take a while to apply."],
  [/invalid_grant/i, "the Google sign-in expired or was removed: run npm run google-login again (with a service account: the user to act as doesn't exist)."],
  [/admin_policy_enforced|access blocked|access_denied/i, "your Workspace admin settings block this app: ask a super admin to trust it in Security → API controls."],
  [/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i, "a permission was not ticked at sign-in: run npm run google-login again and allow every box."],
  [/ENOENT/i, "GOOGLE_SERVICE_ACCOUNT_KEY_FILE points to a file that doesn't exist."],
  [/has not been used in project|is disabled/i, "enable this API in the Google Cloud project (SETUP.md 3.1)."],
  [/Chat app not found|chat app/i, "fill in the Google Chat API configuration page (SETUP.md 3.4)."],
  [/invalid_auth|not_authed/i, "SLACK_BOT_TOKEN is wrong. Copy the xoxb- token again (SETUP.md 2)."],
  [/missing_scope/i, "the Slack app is missing a scope. Update the manifest and reinstall the app (SETUP.md 2)."],
];

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const only = args.filter((a) => !a.startsWith("--"));
  const unknown = only.filter((name) => !CONNECTORS.some((c) => c.source === name));
  if (unknown.length) {
    console.error(`Unknown source: ${unknown.join(", ")}. Use any of: ${CONNECTORS.map((c) => c.source).join(", ")}`);
    process.exit(1);
  }

  const days = envInt("SYNC_DAYS", 180);
  const maxItems = envInt("SYNC_MAX_ITEMS_PER_SOURCE", 5000);
  let failed = false;

  for (const connector of CONNECTORS) {
    if (only.length && !only.includes(connector.source)) continue;
    const label = SOURCE_LABELS[connector.source];
    if (!connector.configured()) {
      console.log(`- ${label}: not configured (set ${connector.needs})`);
      continue;
    }

    // Overlap the previous run by an hour so nothing written during it is missed.
    const last = full ? undefined : getState(`lastSync:${connector.source}`);
    const since = last ? new Date(Date.parse(last) - 60 * 60 * 1000) : new Date(Date.now() - days * 86_400_000);
    const startedAt = new Date().toISOString();
    console.log(`… ${label}: reading changes since ${since.toISOString().slice(0, 10)}`);

    try {
      const updated = await connector.run({ since, maxItems, log: (message) => console.log(`  ${message}`) });
      setState(`lastSync:${connector.source}`, startedAt);
      console.log(`✓ ${label}: ${updated} document(s) added or updated`);
    } catch (err) {
      failed = true;
      const message = errorMessage(err);
      const hint = HINTS.find(([pattern]) => pattern.test(message))?.[1];
      console.error(`✗ ${label}: ${message}${hint ? `\n  → ${hint}` : ""}`);
    }
  }

  const stats = getStats();
  console.log(`\nIndex: ${stats.documents} documents, ${stats.chunks} passages (data/knowledge.sqlite)`);
  if (failed) process.exitCode = 1;
}

main();
