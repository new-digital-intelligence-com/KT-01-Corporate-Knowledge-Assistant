import { loadEnvConfig } from "@next/env";
import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { env } from "../lib/config";
import { LOOPBACK_REDIRECT, USER_SCOPES, oauthClient } from "../lib/sources/google";
import { errorMessage } from "../lib/text";

// Same .env.local / .env files and precedence as `next dev`.
loadEnvConfig(process.cwd());

async function main() {
  const tokenFile = env("GOOGLE_USER_TOKEN_FILE");
  if (!tokenFile) throw new Error("Set GOOGLE_USER_TOKEN_FILE in .env.local, e.g. ./secrets/google-user-token.json");
  const client = oauthClient();

  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: USER_SCOPES });
  console.log("\nStep 1. Open this link in your browser, signed in with the account the assistant should read as:\n");
  console.log(url);
  console.log("\nStep 2. Click Allow (everything is read-only).");
  console.log(`        Your browser then opens ${LOOPBACK_REDIRECT}/… and shows an error page. That's expected.`);
  console.log("Step 3. Copy the whole address from the browser's address bar and paste it below.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pasted = (await rl.question("Paste the address here: ")).trim();
  rl.close();

  const code = pasted.startsWith("http") ? new URL(pasted).searchParams.get("code") : pasted;
  if (!code) throw new Error("That address has no ?code=… in it. Copy the address of the page Google sent you to after Allow.");

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google didn't return a long-lived token. Remove the app at https://myaccount.google.com/permissions and run this again.");
  }

  const granted = new Set((tokens.scope ?? "").split(" "));
  const missing = USER_SCOPES.filter((s) => !granted.has(s));

  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });

  client.setCredentials(tokens);
  const profile = await google.gmail({ version: "v1", auth: client }).users.getProfile({ userId: "me" }).catch(() => null);

  console.log(`\n✓ Signed in${profile?.data.emailAddress ? ` as ${profile.data.emailAddress}` : ""}. Saved to ${tokenFile}.`);
  if (missing.length) {
    console.log(`⚠ Not allowed: ${missing.map((s) => s.split("/").pop()).join(", ")}. Those sources won't sync. Run this again and tick every box.`);
  }
  console.log("Next: npm run sync");
}

main().catch((err) => {
  console.error(`✗ ${errorMessage(err)}`);
  process.exit(1);
});
