# Claude handoff: KT-01 Corporate Knowledge Assistant

Read this first when you pick up this project in a new session. It records what the project is, how it runs, the decisions already taken, and what is left. Last updated: 2026-10-17.

## What it is

A Google Chat app for NDI (New Digital Intelligence, new-digital-intelligence.com), called "Knowledge Assistant". It is Claude plus live, **read-only** access to the company's Google sources. Anyone in the company can ask it anything, in a direct message or by @mentioning it in a space. It answers general questions directly. For company questions it searches the sources, cites them, and fact-checks the answer before posting.

It has two engines. The **built-in pipeline** (`lib/assistant.ts`) answers everyone today. The **Managed Agent** (`lib/agent/`, see below) is where the project is going: a Claude Managed Agent built like Claude Cowork or Claude Tag in Slack, with connectors for its tools. It is switched on per person with `AGENT_TRIAL_USERS`, or for everyone with `ASSISTANT_ENGINE=agent`.

The owner is Helmi Lakhder. The bot reads everything as his Google account.

## How to work with the user

- Explain in easy language. When the user has to do something (console clicks, sign-ins), give **one step at a time** and wait for them to confirm it before the next.
- Don't use subagents or multi-agent workflows. Do the work yourself.
- Stay inside this project folder. Never open sibling projects unless asked.
- Commit and push as `HelmiDev03 <helmipaty@gmail.com>`, with no Claude attribution or Co-Authored-By lines. Check that no secrets are staged.
- Never print or commit secrets: `.env.local`, `secrets/`, `data/`. Never commit company data (Drive file names, file IDs, client details) into the code; that goes in the database (see Drive map).
- **Decisions already made; don't re-argue them:**
  - Anyone in the company gets answers, public in spaces, with no per-person permission filtering.
  - The bot reads all of the NDI shared drive, and Helmi's Gmail, Chat spaces and Calendar, plus the Workspace directory and the YouTube channel. Everything is read-only; the bot never takes actions.
  - The only safeguards are: company domain only (`CHAT_ALLOWED_DOMAINS`), no answers in spaces that allow external people, and never repeating credentials.
  - Keep the stack: Next.js/TypeScript. The user chose it over Python/FastAPI/LangGraph.
  - LinkedIn integration is parked.
  - **The Managed Agent design (decided 2026-10-16):**
    - Every source comes through a connector (MCP server), like in Claude Cowork. Don't rebuild what a connector already does.
    - **Fireflies:** Fireflies' own MCP server (`https://api.fireflies.ai/mcp`), signed in with Michael Burian's account. The rule that a meeting is only for the people invited to it lives in the agent's prompt; the user chose that over a hard check in code.
    - **Everything is per person, with no sign-in links (decided 2026-10-17):** Drive, the directory, Gmail, Calendar and Chat. Each person sees exactly what their own account can open.
      - Michael (super admin) approved domain-wide delegation, read-only, for the bot's service account (client ID `111236854153815010074`), with these scopes: `gmail.readonly`, `calendar.readonly`, `chat.spaces.readonly`, `chat.messages.readonly`, `drive.readonly`, `admin.directory.user.readonly`, `admin.directory.group.readonly`, `admin.directory.group.member.readonly`.
      - The agent's tools act as the person asking, and only ever as the verified sender of the Chat message (`lib/agent/people.ts`). Each tool asks only for its own scopes, so a scope that isn't approved breaks only that tool.
      - Drive search stays limited to the NDI shared drive.
      - Chat is per person so the agent can always read the conversation it's asked in.
      - The Fireflies connector stays on Michael's account.
    - **Catalog, tracker and YouTube demo links** are read straight from their Drive files (the YouTube links are in a master database sheet), not through special tools. The directory stays one of our own tools: no connector exists for it.
    - Only read tools are switched on in every connector. Fireflies' and Google's servers can also change things (share, move, send); those stay off.
- Answer style the user asked for:
  - English unless another language is requested.
  - Sources in a collapsible "Sources (n)" card.
  - No status phrases like "partly verified".
  - Every time given in GMT.
  - Plain text with "- " lists.
  - Reply in the main conversation, unless the question was asked inside a thread.

## Architecture

Next.js 16 (read `node_modules/next/dist/docs` before changing Next code; see AGENTS.md), with the Anthropic TypeScript SDK and googleapis.

| Path | Role |
|---|---|
| `app/api/google-chat/route.ts` | Chat add-on HTTP endpoint. Verifies the Google ID token (audience `CHAT_ENDPOINT_URL`, email `CHAT_ADDON_SERVICE_ACCOUNT`), returns `{}` at once, and handles the event in `after()`. |
| `lib/chat/bot.ts` | Event handling: domain and external-space checks, posts a placeholder, reads the thread and memory, calls `answerQuestion` (or the Managed Agent, for trial users or with `ASSISTANT_ENGINE=agent`), edits the placeholder with the answer. |
| `lib/agent/session.ts` | The Managed Agent's runtime: one session per conversation and person, kept in Postgres (`agent_sessions`). It sends the question, runs our tools when the agent calls them, and returns the answer, catching up after a dropped stream. |
| `lib/agent/tools.ts` | The agent's own tools, run in our code, all as the person asking: `search_drive`, `read_drive_file`, `search_people`, `search_groups`, `list_group_members`, `search_gmail`, `read_email_thread`, `search_calendar`, `list_calendars`, `check_availability`, `search_chat`, `read_chat_thread`, `read_space_messages`. |
| `lib/agent/people.ts` | Short-lived access tokens for the person asking, through domain-wide delegation; company addresses only. `asGoogleAccount()` in `lib/live.ts` runs the existing Google code as that token, with every per-account cache kept per account. |
| `lib/agent/prompt.ts`, `scripts/managed-agent.ts` | The agent's rules, and the setup script (`npm run managed-agent`) that creates or updates the agent with the rules plus the Drive map's key files. |
| `lib/chat/render.ts`, `client.ts` | Chat message and card rendering; posting and editing as the bot service account (chat.bot scope), with retries. |
| `lib/chat/store.ts`, `lib/postgres.ts` | Conversation memory and delivery dedupe in Supabase Postgres (`DATABASE_URL`), with a SQLite fallback. |
| `lib/assistant.ts` | The answer pipeline: tool definitions, system prompt, tool loop, fact check, rewrite, final citation formatting. |
| `lib/live.ts` | All live Google reads: Drive search and read (paged, with focus), Gmail, Chat search, space messages, directory, groups, admin roles, YouTube, Calendar, key documents (catalog and tracker), opening a Drive file or folder by id. |
| `lib/drive-map.ts`, `scripts/drive-map.ts` | The Drive map (see below). |
| `lib/sources/office.ts` | PPTX (slide text with section labels) and XLSX parsing with jszip. |
| `lib/text.ts` | `gmt()` times, `hideSecrets()` credential masking safety net, chunking. |
| `lib/sources/google.ts` | Auth: user OAuth token (reads as Helmi), bot service account. `JWT({keyFile})` is broken in this googleapis version, so email and key are passed explicitly. |
| `scripts/google-login.ts` | One-time OAuth sign-in (`npm run google-login`); the user pastes the redirect URL. |
| `app/page.tsx`, `app/api/chat` | Local web chat. Off in production unless `WEB_CHAT_ENABLED=true`. |
| `Dockerfile`, `.dockerignore`, `.gcloudignore` | Ready for Google Cloud Run (standalone output). |
| `scripts/sync.ts`, `scripts/chat-bot.ts` | Legacy: Slack index sync and the local Pub/Sub worker. Not used in production. |

### Answer pipeline (`answerQuestion`)

1. **Investigate.** Claude (`claude-opus-5`, override with `ANTHROPIC_MODEL`) runs a tool loop of at most 10 rounds.
   - The system prompt holds the fixed rules plus the Drive map, cached across questions.
   - Time, asker, space and thread go in the user message, inside a `<context>` block.
   - Citations are `[#id]` markers pointing at passages.
2. **Verify.** A structured fact check (`ANTHROPIC_VERIFY_MODEL`, which defaults to the answer model) sees the cited passages plus related passages from the same search or document. It returns the unbacked claims, `contains_secret` and conflicts.
3. **Correct.** Partial claims are rewritten, then re-checked; the re-check returns `revised_answer` with what is still unbacked removed. A draft whose only problems are unsupported claims goes straight to removal.
4. **Finalize.** Markers become `[n]`, one number per linked page, shown once per answer. Credentials are masked.

### Tools the model has

- **Drive:** `search_drive`, `open_drive_file` (id or link; folders list their contents), `read_result` (paged 40 parts at a time, optional `focus`, e.g. an AI employee code or a spreadsheet column).
- **Gmail and Chat:** `search_gmail`, `search_chat` (returns whole threads for the top hits), `read_space_messages` (current or named space, N days).
- **Directory:** `search_people`, `search_groups`, `list_group_members`, `list_admin_roles` (hidden after a 403).
- **Calendar:** `search_calendar`, `list_calendars`, `check_availability`.
- **YouTube:** `search_youtube` (sort by relevance, date or views; complete lists).
- **Key documents:**
  - `ai_employee_catalog`: the catalog PPTX, source of truth for what each AI employee is.
  - `ai_employee_tracker`: the PoC tracker sheet, with filters for owner, status, domain and `demo_video`, cross-checked with the YouTube channel. Both are configured by `AI_CATALOG_FILE_ID` and `AI_TRACKER_FILE_ID`.

### Drive map

A map of the NDI shared drive is stored in Supabase: table `knowledge_map`, row `drive-map`, RLS on. It is not in the repo. It holds:
- How the drive is organised, with folder ids.
- About 30 "where to look" rules.
- 74 key files with what each holds and who maintains it.
- 54 client project folders.
- Topics with no document. Note: the "Leave/Sabbatical/Payroll Policy" files in Sales and Marketing/Training are **fictional ACME demo files**, not NDI policy.

The bot re-reads the map every 10 minutes and puts it in the system prompt (about 54k characters).
- Show the current map: `npm run drive-map`
- Replace it: `npm run drive-map -- path/to/map.json`

The JSON shape is `DriveMap` in `lib/drive-map.ts`. The map was built on 2026-09-16 by listing the whole drive and reading the key files. Refresh it by hand when the drive changes a lot.

### Managed Agent

Anthropic runs the agent loop; our code only bridges Google Chat and runs our own tools. The TypeScript SDK (0.125) has it under `client.beta.{agents,environments,sessions,vaults}`.
- **Resources** in the Anthropic workspace of `ANTHROPIC_API_KEY`, created 2026-10-16:
  - agent `agent_01ELBePtUXGydeRpFcj7mUuJ` ("NDI Knowledge Assistant", `claude-opus-5-5`, effort medium);
  - environment `env_01DzNSSKGnSf1YFLqWRq6pMy` (cloud, limited networking, MCP servers allowed; no sandbox tools);
  - vault `vlt_011Cg6jEMrVRfz13866ECxRn` ("shared connectors"), holding Michael's Fireflies key as a static bearer credential, and Helmi's Google Drive sign-in as an OAuth credential that Anthropic refreshes;
  - skill `skill_01KcXiyVpoRynvQ2tm658TS3` (`ndi-drive-map`), the Drive map.
- **The Drive map is a skill**, not part of the prompt (the user's choice, 2026-10-17): `SKILL.md` (organisation, where to look, the most important files, files outside the shared drive), `key-files.md` and `clients.md`. `lib/agent/skill.ts` builds it from the database. The prompt holds only the rules, about 2.5k characters, where the map used to make it 35k. Skills need the built-in read tool, so `read`, `grep` and `glob` are on; `bash`, `write`, `edit` and the web tools are off.
- **Update the agent:** edit `lib/agent/prompt.ts`, `skill.ts` or `tools.ts`, then run `npm run managed-agent`. Each run uploads a new skill version from the current Drive map and makes a new agent version. Run it again after the map changes.
- **Tools:**
  - Fireflies' read tools only (`fireflies_search`, `fireflies_fetch`, `fireflies_get_transcripts`, …). Its sharing, moving, renaming and privacy tools are off.
  - Our custom tools from `lib/agent/tools.ts`. Each call pauses the session until `askAgent` sends the result back.
- **Sessions:** one per conversation and person, kept in `agent_sessions` (conversation, asker, session_id). It holds the whole conversation, so follow-ups work without our own memory. A session keeps the agent version it started with, so after an update the next message starts a new session; the conversation's memory starts over then. Sessions and their history stay in the Console (Managed Agents → Sessions), which is the place to debug an answer.
- **Tests on 2026-10-16** (run as Helmi in a DM):
  - catalog question 20 s;
  - pricing file and its owners 21 s;
  - group members 10 s;
  - meeting summary 15 s;
  - follow-up answered from memory 6 s;
  - a made-up colleague got no meeting content.

## Hosting and deploy

- **Railway (the new host, set up 2026-10-17):** service `[KT-01] knowledge-assistant` (id `501508af-ab60-4abd-8698-9b16184f652a`) in the **POCs** project of the NDI workspace, environment production, URL https://kt-01-knowledge-assistant-production.up.railway.app.
  - It builds the `Dockerfile` (Next.js standalone server, port 8080) and redeploys on every push to `main`. There's no 300 s limit as on Vercel.
  - Its 19 variables are production's, copied from Vercel, plus the Managed Agent's, with `CHAT_ENDPOINT_URL` set to the Railway URL. List them with `railway variable list --service "[KT-01] knowledge-assistant"` (that prints values; don't paste them anywhere).
  - The Railway CLI is logged in as Helmi. From Node on Windows, call `C:/Users/helmi/AppData/Roaming/npm/node_modules/@railway/cli/bin/railway.exe`: the npm shim can't be spawned.
  - Vercel keeps running until the Chat app's HTTP endpoint URL points at Railway and a real message has been answered there. Then retire it.
- **Old setup:** branch `pre-managed-agent` is `main` as it was before the Managed Agent (commit `78f5692`). Restore from there if needed.
- **Production:** Vercel project `kt-01-corporate-knowledge-assistant` on the `er` team (team `team_lCL2eN4x0WgeW4BClQl4aeYZ`, project `prj_oSWoJrQcFegc8bAKQL8zLBBY0a3F`), URL https://kt-01-corporate-knowledge-assistant-pi.vercel.app. The Vercel account is Helmi's work Google account, `helmi.lakhder@new-digital-intelligence.com`. Moved here on 2026-09-19 from the old personal account `helmipaty@gmail.com` (team `team_j2liDA1o1xut25GwXWxsxtTL`), which can be retired.
  - The Google Chat app (GCP project `knowledge-assistant-508709`) uses "HTTP endpoint URL" = `…/api/google-chat`.
- **GitHub:** `new-digital-intelligence-com/KT-01-Corporate-Knowledge-Assistant`, now **public**, and the Vercel project is connected to it. A push to `main` deploys by itself; no manual step. To deploy by hand anyway:
  ```
  npx vercel deploy --prod --yes --token "$VERCEL_TOKEN"
  ```
  `VERCEL_TOKEN` is in `.env.local`. Read it without printing it. `.vercelignore` keeps secrets and data out.
- **Production env vars** are set in Vercel (names only):
  - Claude: `ANTHROPIC_API_KEY`.
  - Google and Chat: `CHAT_BOT_KEY_JSON`, `GOOGLE_OAUTH_CLIENT_JSON`, `GOOGLE_USER_TOKEN_JSON`, `GOOGLE_DRIVE_ID`, `CHAT_ALLOWED_DOMAINS`, `CHAT_ENDPOINT_URL`, `CHAT_ADDON_SERVICE_ACCOUNT`, `WEB_CHAT_ENABLED=false`.
  - Sources and storage: `YOUTUBE_CHANNEL`, `AI_CATALOG_FILE_ID`, `AI_TRACKER_FILE_ID`, `DATABASE_URL`.
  - Managed Agent: `MA_AGENT_ID`, `MA_ENVIRONMENT_ID`, `MA_FIREFLIES_VAULT_ID`, plus `AGENT_TRIAL_USERS` (emails that get the agent) or `ASSISTANT_ENGINE=agent` (everyone). `FIREFLIES_API_KEY` and `MA_DRIVE_SKILL_ID` are only needed where `npm run managed-agent` runs.
  - The calendar zone defaults to GMT (`CALENDAR_TIME_ZONE`).
  - Store them as **encrypted**, never as Vercel's "sensitive" type. Sensitive values can never be read back — not by the API, the CLI or the dashboard — so the old project's credentials were unrecoverable and had to be made again from Google.
- **Google sign-in:** if the user OAuth token expires or scopes change, run `npm run google-login` and send the user the link. They paste back the redirect URL, which you pipe into the script. Then update `GOOGLE_USER_TOKEN_JSON` in Vercel.
- **Local `secrets/`** (gitignored, on this machine only, rebuilt 2026-09-19): `google-oauth-client.json` is the Desktop OAuth client from GCP → Credentials (loopback `http://127.0.0.1:53682`); `google-service-account.json` is a key for `knowledge-assistant-bot@knowledge-assistant-508709.iam.gserviceaccount.com`; `google-user-token.json` comes from `npm run google-login`, signed in as `helmi.lakhder@new-digital-intelligence.com`.

## Checking changes

- `npm install` fails on this machine: `better-sqlite3` is compiled with node-gyp and the installed Visual Studio has no Windows SDK. Use `npm install --ignore-scripts`. Everything works except the local SQLite fallback, which production never uses (`DATABASE_URL` points at Supabase).
- `npx tsc --noEmit` and `npx eslint lib scripts app`. There is no test suite. On a fresh clone, run `npx next typegen` first, or `tsc` can't find Next's generated `LayoutProps` type.
- Managed Agent: write a small tsx script outside the repo that loads env with `@next/env` and calls `askAgent({ conversation, asker, prompt, onProgress })` from `lib/agent/session.ts`, with a `<context>` block in the prompt like `agentContext()` in `lib/chat/bot.ts` builds. Use a fresh `conversation` string per test so earlier turns don't carry over.
- Behaviour testing: write a small tsx script outside the repo that loads env with `@next/env`, calls `answerQuestion(question, [], emit, undefined, { spaceType: "DIRECT_MESSAGE", asker: "Helmi Lakhder" })`, and prints the progress events and `renderAnswer(answer).text`. Run questions that hit each source.
- Three QA rounds on 32 questions (2026-09-16): run 1 had 6 good answers and 6 with major issues; run 3 had 20 good and 0 major; the median answer time fell from 48 s to 16 s.

## State (2026-10-17)

**Managed Agent: built and tested locally, not deployed yet.**
- Working: Fireflies through its own connector, Drive and directory through our tools, the Chat bridge with trial mode, and memory per conversation.
- Next: a trial in production for Helmi only (`AGENT_TRIAL_USERS`). Then per-person Gmail, Calendar and Chat, then Google's connectors.

**Done and live:**
- Hosting moved to the new Vercel account (2026-09-19). The old project was deleted, the Chat app's HTTP endpoint URL now points at the new URL, and a real Chat message was answered from it.
- Live search across every source.
- Complete lists: tracker, catalog, YouTube, directory.
- Fact check with date, asker and related passages.
- Paged and focused reading of large files.
- Whole Chat threads.
- GMT times.
- Credential masking.
- Drive map plus `open_drive_file`.
- Demo video filter.
- Labelled catalog slides.
- One citation number per source.

**Open items:**
1. **Move hosting to Google Cloud Run: blocked on billing.**
   - The GCP project `knowledge-assistant-508709` has no billing account, so Cloud Run, Cloud Build, Artifact Registry and Secret Manager can't be enabled.
   - Helmi is Owner of the project, but can't see any billing account and isn't an org admin.
   - The user is sorting it out with the company (super admin, e.g. Michael Burian) or a card.
   - gcloud is no longer on this machine (checked 2026-09-19); install it again before this step.
   - Plan once billing exists:
     1. Enable the four APIs.
     2. Put the secrets in Secret Manager.
     3. Run `gcloud run deploy` in europe-west1 with `--no-cpu-throttling` (so `after()` keeps running) and the env vars.
     4. Point `CHAT_ENDPOINT_URL` and the Chat API HTTP endpoint at the Cloud Run URL.
     5. Test, then retire Vercel.
2. **Slow broad questions.** "Which client projects were active in 2026" takes about 2.5 minutes because the bot opens many folders. Consider a faster route, e.g. letting it trust the map's client list.
3. **Drive map upkeep.** It is a manual snapshot, and new key files won't appear until it is refreshed.
4. **LinkedIn:** parked by the user.
5. **Google's Drive connector is attached but off.**
   - What's done: the agent has `google_drive` (`https://drivemcp.googleapis.com/mcp/v1`) next to Fireflies, with every tool off, and our `search_drive` and `read_drive_file` do the work. As of 2026-10-17 the Drive MCP API is enabled in the GCP project, and there's a new OAuth client of type "Web application" for an AI agent. Helmi's sign-in through that client is in `secrets/google-oauth-agent-client.json` and `secrets/google-user-token-agent.json`, and in the vault.
   - What's still blocked: every Drive tool call still returns "The caller does not have permission". That's Google's preview gate, and Helmi applied to the program.
   - To check: run the probe (initialize, then a `search_files` call, with that sign-in).
   - Once it works: set `GOOGLE_DRIVE_MCP=on` in `.env.local` and run `npm run managed-agent`. Its read tools come on, ours step aside, and the prompt names the right tools.
6. **Google's other connectors need the same preview access.** Gmail (`gmailmcp`), Calendar (`calendarmcp`) and Chat (`chatmcp`, all `…googleapis.com/mcp/v1`) are in the same Workspace Developer Preview Program as Drive. Their APIs also have to be enabled in the GCP project. From 2026-11-11, Google rejects OAuth clients not marked for an AI agent; the new client is one.
7. **The meeting feature built on 2026-09-23** (a hard invite check in code, private replies in spaces) was replaced by this design before it went live. It is kept in `git stash` ("2026-09-23 meeting feature").

## Gotchas

- The NDI Tools sheet and Corporate Information sheet live **outside** the NDI shared drive, so Drive search (limited to `GOOGLE_DRIVE_ID`) won't find them. Open them by id; they are in the Drive map.
- Vercel functions: `maxDuration = 300` on the Chat route. The answer runs in `after()`.
- Chat allows about 1 write per second per space. Replies are capped at about 30 KB.
- The production `ANTHROPIC_API_KEY` was replaced on 2026-10-12. Keep `.env.local` on the same key: the Managed Agent's resources live in that key's workspace, so a key from another workspace can't see them.
- `askAgent` gives up after 240 s and interrupts the session, to stay inside Vercel's 300 s. On Railway this could go higher.
- Vercel's env list endpoint returns **encrypted blobs**, even with `decrypt=true`; they happen to look like base64 JSON. For a real value, read one variable at a time: `GET /v1/projects/{id}/env/{envId}`.
- Never commit Drive file names or ids, client details or anything from `data/` or `secrets/`.
