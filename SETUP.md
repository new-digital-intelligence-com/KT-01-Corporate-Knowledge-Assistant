# Setup

Admin steps to connect the assistant to Slack, Google Drive, Gmail and Google Chat. Allow 30–45 minutes.
Every permission requested here is **read-only**.

## 0. Decide the scope first

- **What to index:**
  - which Slack channels;
  - which Drive folders or shared drives;
  - which mailboxes: shared team mailboxes such as `support@` or `hr-questions@`, not personal inboxes;
  - which Chat spaces.

  Leave out HR cases, finance, legal and anything confidential. **Anyone using the web page gets answers from everything indexed.**
- **Recommended: a dedicated Workspace user**, for example `knowledge-bot@yourcompany.com`, used for Drive and Chat. Add it to the shared drives and Chat spaces you want indexed. The assistant sees exactly what that user sees, so its memberships are the scope.
- **Tell staff** which channels and spaces are indexed.

## 1. Claude API key

1. Go to [console.anthropic.com](https://console.anthropic.com) → **API Keys** → **Create Key**.
2. Put the key in `.env.local` as `ANTHROPIC_API_KEY`.

## 2. Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, then pick your workspace.
2. Paste this manifest and click **Create**:

   ```yaml
   display_information:
     name: Knowledge Assistant
     description: Read-only indexer for the company knowledge assistant
   features:
     bot_user:
       display_name: knowledge-assistant
       always_online: false
   oauth_config:
     scopes:
       bot:
         - channels:read
         - channels:history
         - groups:read
         - groups:history
         - users:read
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

3. **Install to Workspace** → **Allow**.
4. **OAuth & Permissions** → copy the **Bot User OAuth Token** (`xoxb-…`) into `SLACK_BOT_TOKEN`.
5. In every channel to index, run `/invite @knowledge-assistant`. The bot reads only channels it's in, and private channels only if invited.

Keep the app installed in your own workspace only; don't distribute it. Slack sharply rate-limits message history for apps distributed outside the Marketplace; internal apps aren't affected.

## 3. Google Workspace

### 3.1 Cloud project and APIs

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a project, for example `knowledge-assistant`.
2. **APIs & Services → Library**. Enable these four:
   - Google Drive API
   - Gmail API
   - Google Chat API
   - Admin SDK API

### 3.2 Service account and key

1. **IAM & Admin → Service Accounts → Create service account**. Name it `knowledge-assistant-sync` and grant no roles.
2. Open it, then **Keys → Add key → Create new key → JSON**.
3. Save the file as `secrets/google-service-account.json` in this project. The `secrets/` folder is git-ignored.
   - If key creation is blocked, the organisation policy `iam.disableServiceAccountKeyCreation` is on. Allow an exception for this project.
4. On the **Details** tab, copy the **Unique ID** (a long number). You need it in the next step.

### 3.3 Domain-wide delegation

1. Go to [admin.google.com](https://admin.google.com) → **Security → Access and data control → API controls → Manage Domain Wide Delegation → Add new**.
2. **Client ID:** the Unique ID from 3.2.
3. **OAuth scopes:** paste this line exactly:

   ```
   https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/chat.spaces.readonly,https://www.googleapis.com/auth/chat.messages.readonly,https://www.googleapis.com/auth/admin.directory.user.readonly
   ```

4. Click **Authorize**. It usually applies within minutes, but it can take longer.

If you won't use Gmail, leave `gmail.readonly` out. The admin directory scope is only used to show names in Google Chat and is optional.

### 3.4 Google Chat API configuration

The Chat API needs its configuration page filled in, even though the assistant only reads.

1. Go to **APIs & Services → Google Chat API → Configuration**.
2. Enter an app name, an avatar URL and a description.
3. Turn off the interactive features.
4. Under visibility, limit it to yourself.
5. Click **Save**.

### ⚠ About the key

With domain-wide delegation, **the JSON key can read any Drive and any mailbox in the domain**. The code reads only the users and mailboxes you list in `.env.local`, but the key itself is the real boundary.

- Keep it on this machine. Never commit it, email it or paste it into chat.
- Delete the key (**Service account → Keys**) when the proof of concept ends.
- For production, replace the key with a hosted service that uses keyless authentication.

## 4. Configure

```bash
cp .env.example .env.local
```

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | From step 1 |
| `SLACK_BOT_TOKEN` | `xoxb-…` from step 2 |
| `SLACK_CHANNELS` | Optional: limit to these channels |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | `./secrets/google-service-account.json` |
| `GOOGLE_DRIVE_USER` | For example `knowledge-bot@yourcompany.com` |
| `GOOGLE_DRIVE_FOLDER_IDS` | Optional: folder or shared drive IDs (the last part of the folder URL) |
| `GMAIL_MAILBOXES` | For example `support@yourcompany.com,it@yourcompany.com` |
| `GOOGLE_CHAT_USER` | For example `knowledge-bot@yourcompany.com` |
| `GOOGLE_CHAT_SPACES` | Optional: limit to these spaces |
| `GOOGLE_ADMIN_EMAIL` | Optional: your admin email, to show names in Chat |

Leave a source's variables empty to skip that source.

## 5. Run

```bash
npm run sync              # first run reads the last 180 days (SYNC_DAYS)
npm run dev               # open http://localhost:3000
```

Later syncs read only what changed.

```bash
npm run sync -- slack     # one source
npm run sync -- --full    # re-read everything within SYNC_DAYS
```

## Troubleshooting

`npm run sync` prints a hint for the common setup mistakes.

| Error | Fix |
|---|---|
| `unauthorized_client` | Delegation is missing, or its scopes don't match 3.3 exactly. It can also be a delay before new delegation applies. |
| `invalid_grant` | The user in `GOOGLE_*_USER` or `GMAIL_MAILBOXES` isn't a user in your domain. |
| `… has not been used in project … or it is disabled` | Enable that API (3.1). |
| Chat app not found | Fill in the Chat API configuration (3.4). |
| `not_in_channel` | Invite the bot to that channel. |
| `missing_scope` | Update the Slack manifest, then reinstall the app. |
| Page says the index is empty | Run `npm run sync`. |
