import { google, type chat_v1 } from "googleapis";
import { env, envList } from "../config";
import { upsertDocument } from "../db";
import { clip, errorMessage } from "../text";
import { GOOGLE_SCOPES, directoryNames, googleAuth, googleConfigured, userAuthConfigured } from "./google";
import type { SyncContext } from "./types";

export function chatConfigured(): boolean {
  return googleConfigured() && (userAuthConfigured() || Boolean(env("GOOGLE_CHAT_USER")));
}

/** One document per thread, in named spaces only. Direct messages and group chats are never read. */
export async function syncChat(ctx: SyncContext): Promise<number> {
  const chat = google.chat({ version: "v1", auth: googleAuth(env("GOOGLE_CHAT_USER"), GOOGLE_SCOPES.chat) });
  const nameOf = directoryNames();
  const wanted = new Set(envList("GOOGLE_CHAT_SPACES").map((s) => s.toLowerCase()));

  const spaces: chat_v1.Schema$Space[] = [];
  let pageToken: string | undefined;
  do {
    const res = await chat.spaces.list({ pageSize: 1000, pageToken, filter: 'spaceType = "SPACE"' });
    for (const space of res.data.spaces ?? []) {
      if (!space.name) continue;
      const listed = wanted.has(space.name.toLowerCase()) || wanted.has((space.displayName ?? "").toLowerCase());
      if (!wanted.size || listed) spaces.push(space);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  let updated = 0;
  let seen = 0;
  for (const space of spaces) {
    const label = space.displayName || space.name!;
    const spaceId = space.name!.replace(/^spaces\//, "");
    try {
      // Find threads with activity since the last sync, then rebuild each thread whole.
      const threads = new Set<string>();
      for await (const message of listMessages(chat, space.name!, `createTime > "${ctx.since.toISOString()}"`)) {
        if (message.thread?.name) threads.add(message.thread.name);
        seen++;
      }

      for (const thread of threads) {
        const messages: chat_v1.Schema$Message[] = [];
        for await (const message of listMessages(chat, space.name!, `thread.name = ${thread}`)) {
          if (message.text || message.formattedText || message.fallbackText) messages.push(message);
        }
        if (!messages.length) continue;

        const lines = await Promise.all(
          messages.map(async (m) => {
            const who = m.sender?.displayName || (await nameOf(m.sender?.name));
            const when = (m.createTime ?? "").slice(0, 16).replace("T", " ");
            return `[${when}] ${who}: ${m.text || m.formattedText || m.fallbackText}`;
          }),
        );
        const first = messages[0];
        const last = messages.at(-1)!;
        const saved = upsertDocument({
          id: `gchat:${thread}`,
          source: "gchat",
          title: `${label}: ${clip(first.text ?? first.fallbackText ?? "", 80)}`,
          url: `https://chat.google.com/room/${spaceId}/${thread.split("/threads/")[1] ?? ""}`,
          container: label,
          author: first.sender?.displayName || (await nameOf(first.sender?.name)),
          updatedAt: last.lastUpdateTime ?? last.createTime ?? new Date().toISOString(),
          text: lines.join("\n"),
        });
        if (saved) updated++;
      }
    } catch (err) {
      ctx.log(`gchat: space "${label}" skipped (${errorMessage(err)})`);
    }
    if (seen >= ctx.maxItems) {
      ctx.log("gchat: reached SYNC_MAX_ITEMS_PER_SOURCE, remaining spaces skipped");
      break;
    }
  }
  return updated;
}

async function* listMessages(chat: chat_v1.Chat, parent: string, filter: string) {
  let pageToken: string | undefined;
  do {
    const res = await chat.spaces.messages.list({ parent, filter, pageSize: 1000, pageToken });
    yield* res.data.messages ?? [];
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}
