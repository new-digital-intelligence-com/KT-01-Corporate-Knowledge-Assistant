# Company Knowledge Assistant (proof of concept)

Staff ask a question in a web chat. The assistant answers only from company content in Slack, Google Drive, Gmail and Google Chat. Every answer cites its sources and is checked against them before anyone sees it, with no human reviewer.

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in: see SETUP.md
npm run sync                 # copy company content into the local index
npm run dev                  # http://localhost:3000
```

Connecting Slack and Google (app, service account, delegation) is covered step by step in **[SETUP.md](SETUP.md)**.

## How an answer is produced

1. **Research.** Claude searches the index with several keyword queries and reads the documents that look relevant. It writes an answer with a passage citation after every claim.
2. **Citation check (code).** Citations that point to passages Claude never retrieved are removed.
3. **Fact check (Claude).** A separate call splits the answer into claims and marks each one *supported*, *partial* or *unsupported*, judged strictly against the cited passages. It also flags conflicts between sources.
4. **Rewrite.** If any claim isn't fully supported, the answer is rewritten from the passages and checked again, once.
5. **Result.**
   - The page shows a status: *verified*, *partly verified* or *not found*.
   - Citations are numbered and link back to the Slack message, Drive file, email thread or Chat thread.
   - A "How this answer was checked" panel lists each claim and its verdict.
   - An answer with no backed claims is never shown as an answer.

The model is `claude-opus-5`. It uses the API's server-side refusal fallback, so a declined request is retried on a suitable fallback model within the same call.

## What gets indexed

| Source | One document per | Scope |
|---|---|---|
| Slack | thread, or channel-day for messages outside threads | channels the bot is invited to (or `SLACK_CHANNELS`) |
| Google Drive | file: Docs, Sheets, Slides, PDF, Word, text | what `GOOGLE_DRIVE_USER` can see (or `GOOGLE_DRIVE_FOLDER_IDS`) |
| Gmail | email thread | only the mailboxes in `GMAIL_MAILBOXES` |
| Google Chat | thread | named spaces `GOOGLE_CHAT_USER` belongs to; never direct messages |

The index is a local SQLite file, `data/knowledge.sqlite`. Documents are split into passages of about 1,200 characters and searched by keyword (BM25, accent-insensitive). Nothing is sent anywhere except the passages Claude reads while answering.

## Layout

| Path | Holds |
|---|---|
| `lib/sources/` | One connector per source, plus Google auth |
| `lib/db.ts`, `lib/search.ts` | Index storage and search |
| `lib/assistant.ts` | Research loop, citation check, fact check, rewrite |
| `app/api/chat/route.ts` | Streams progress and the final answer as NDJSON |
| `app/page.tsx` | Chat UI |
| `scripts/sync.ts` | `npm run sync` |

## Limits of this proof of concept

- **No login and no per-user permissions.** Anyone who can open the page gets answers from everything indexed. Run it locally, and don't deploy it as is.
- **Keyword search, not semantic search.** Claude makes up for it with several searches in different wordings, but a question worded very differently from the sources can still miss.
- **Slack:** a new reply to a thread older than the last sync is only picked up by `npm run sync -- --full`.
- **Attachments** inside Slack, Gmail and Chat messages aren't indexed. Drive files are.
- **Voice** (for example ElevenLabs) isn't included. It can be added later on top of the same answer pipeline.
