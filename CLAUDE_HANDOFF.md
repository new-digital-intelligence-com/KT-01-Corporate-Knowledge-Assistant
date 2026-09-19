# Claude handoff: KT-01 Corporate Knowledge Assistant

Read this first when you pick up this project in a new session. It records what the project is, how it runs, the decisions already taken, and what is left. Last updated: 2026-09-17.

## What it is

A Google Chat app for NDI (New Digital Intelligence, new-digital-intelligence.com), called "Knowledge Assistant". It is Claude plus live, **read-only** access to the company's Google sources. Anyone in the company can ask it anything, in a direct message or by @mentioning it in a space. It answers general questions directly. For company questions it searches the sources, cites them, and fact-checks the answer before posting.

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
| `lib/chat/bot.ts` | Event handling: domain and external-space checks, posts a placeholder, reads the thread and memory, calls `answerQuestion`, edits the placeholder with the answer. |
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

## Hosting and deploy

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
  - The calendar zone defaults to GMT (`CALENDAR_TIME_ZONE`).
  - Store them as **encrypted**, never as Vercel's "sensitive" type. Sensitive values can never be read back — not by the API, the CLI or the dashboard — so the old project's credentials were unrecoverable and had to be made again from Google.
- **Google sign-in:** if the user OAuth token expires or scopes change, run `npm run google-login` and send the user the link. They paste back the redirect URL, which you pipe into the script. Then update `GOOGLE_USER_TOKEN_JSON` in Vercel.
- **Local `secrets/`** (gitignored, on this machine only, rebuilt 2026-09-19): `google-oauth-client.json` is the Desktop OAuth client from GCP → Credentials (loopback `http://127.0.0.1:53682`); `google-service-account.json` is a key for `knowledge-assistant-bot@knowledge-assistant-508709.iam.gserviceaccount.com`; `google-user-token.json` comes from `npm run google-login`, signed in as `helmi.lakhder@new-digital-intelligence.com`.

## Checking changes

- `npm install` fails on this machine: `better-sqlite3` is compiled with node-gyp and the installed Visual Studio has no Windows SDK. Use `npm install --ignore-scripts`. Everything works except the local SQLite fallback, which production never uses (`DATABASE_URL` points at Supabase).
- `npx tsc --noEmit` and `npx eslint lib scripts app`. There is no test suite.
- Behaviour testing: write a small tsx script outside the repo that loads env with `@next/env`, calls `answerQuestion(question, [], emit, undefined, { spaceType: "DIRECT_MESSAGE", asker: "Helmi Lakhder" })`, and prints the progress events and `renderAnswer(answer).text`. Run questions that hit each source.
- Three QA rounds on 32 questions (2026-09-16): run 1 had 6 good answers and 6 with major issues; run 3 had 20 good and 0 major; the median answer time fell from 48 s to 16 s.

## State (2026-09-19)

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
   - gcloud is installed at `~/google-cloud-sdk` and signed in as Helmi.
   - Plan once billing exists:
     1. Enable the four APIs.
     2. Put the secrets in Secret Manager.
     3. Run `gcloud run deploy` in europe-west1 with `--no-cpu-throttling` (so `after()` keeps running) and the env vars.
     4. Point `CHAT_ENDPOINT_URL` and the Chat API HTTP endpoint at the Cloud Run URL.
     5. Test, then retire Vercel.
2. **Slow broad questions.** "Which client projects were active in 2026" takes about 2.5 minutes because the bot opens many folders. Consider a faster route, e.g. letting it trust the map's client list.
3. **Drive map upkeep.** It is a manual snapshot, and new key files won't appear until it is refreshed.
4. **LinkedIn:** parked by the user.

## Gotchas

- The NDI Tools sheet and Corporate Information sheet live **outside** the NDI shared drive, so Drive search (limited to `GOOGLE_DRIVE_ID`) won't find them. Open them by id; they are in the Drive map.
- Vercel functions: `maxDuration = 300` on the Chat route. The answer runs in `after()`.
- Chat allows about 1 write per second per space. Replies are capped at about 30 KB.
- Never commit Drive file names or ids, client details or anything from `data/` or `secrets/`.
