import { WebClient } from "@slack/web-api";
import { env, envList } from "../config";
import { upsertDocument } from "../db";
import { clip, errorMessage } from "../text";
import type { SyncContext } from "./types";

interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  user?: string;
  username?: string;
  subtype?: string;
  text?: string;
}

const SKIPPED_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
]);

export function slackConfigured(): boolean {
  return Boolean(env("SLACK_BOT_TOKEN"));
}

/**
 * One document per thread (the whole thread), and one per channel-day for messages outside threads.
 * The bot reads only channels it has been invited to.
 */
export async function syncSlack(ctx: SyncContext): Promise<number> {
  const client = new WebClient(env("SLACK_BOT_TOKEN"));
  const auth = await client.auth.test();
  const workspaceUrl = (auth.url ?? "").replace(/\/$/, "");

  const names = new Map<string, string>();
  for await (const page of client.paginate("users.list", { limit: 200 })) {
    const members = (page as { members?: { id?: string; name?: string; real_name?: string; profile?: { real_name?: string } }[] })
      .members ?? [];
    for (const m of members) if (m.id) names.set(m.id, m.profile?.real_name || m.real_name || m.name || m.id);
  }

  const wanted = new Set(envList("SLACK_CHANNELS").map((c) => c.replace(/^#/, "").toLowerCase()));
  const channels: { id: string; name: string }[] = [];
  for await (const page of client.paginate("conversations.list", {
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit: 200,
  })) {
    const list = (page as { channels?: { id?: string; name?: string; is_member?: boolean }[] }).channels ?? [];
    for (const c of list) {
      if (!c.id || !c.name) continue;
      const listed = wanted.has(c.name.toLowerCase()) || wanted.has(c.id.toLowerCase());
      if (wanted.size ? listed : c.is_member) channels.push({ id: c.id, name: c.name });
    }
  }
  if (!channels.length) ctx.log("slack: the bot is not in any channel yet. Invite it with /invite @knowledge-assistant");

  const render = (text: string) =>
    text
      .replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g, (_, id: string) => `@${names.get(id) ?? id}`)
      .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
      .replace(/<(https?:[^>]+)>/g, "$1")
      .replace(/<!(here|channel|everyone)>/g, "@$1")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const author = (m: SlackMessage) => (m.user && names.get(m.user)) || m.username || m.user || "unknown";
  const line = (m: SlackMessage) => `[${tsToIso(m.ts!).slice(0, 16).replace("T", " ")}] ${author(m)}: ${render(m.text ?? "")}`;
  const link = (channelId: string, ts: string) =>
    workspaceUrl ? `${workspaceUrl}/archives/${channelId}/p${ts.replace(".", "")}` : null;

  // Start at midnight so each channel-day document is always rebuilt from the whole day.
  const start = new Date(ctx.since);
  start.setUTCHours(0, 0, 0, 0);
  const oldest = String(start.getTime() / 1000);

  let updated = 0;
  let seen = 0;
  for (const channel of channels) {
    if (seen >= ctx.maxItems) {
      ctx.log("slack: reached SYNC_MAX_ITEMS_PER_SOURCE, remaining channels skipped");
      break;
    }
    const byDay = new Map<string, SlackMessage[]>();
    try {
      for await (const page of client.paginate("conversations.history", { channel: channel.id, oldest, limit: 200 })) {
        for (const m of (page as { messages?: SlackMessage[] }).messages ?? []) {
          if (!m.ts || !m.text || (m.subtype && SKIPPED_SUBTYPES.has(m.subtype))) continue;
          seen++;

          if (m.reply_count && m.thread_ts === m.ts) {
            const thread: SlackMessage[] = [];
            for await (const replies of client.paginate("conversations.replies", { channel: channel.id, ts: m.ts, limit: 200 })) {
              thread.push(...((replies as { messages?: SlackMessage[] }).messages ?? []).filter((r) => r.ts && r.text));
            }
            seen += Math.max(thread.length - 1, 0);
            const saved = upsertDocument({
              id: `slack:${channel.id}:${m.ts}`,
              source: "slack",
              title: `#${channel.name} thread: ${clip(render(m.text), 80)}`,
              url: link(channel.id, m.ts),
              container: `#${channel.name}`,
              author: author(m),
              updatedAt: tsToIso(thread.at(-1)?.ts ?? m.ts),
              text: thread.map(line).join("\n"),
            });
            if (saved) updated++;
          } else {
            const day = tsToIso(m.ts).slice(0, 10);
            const bucket = byDay.get(day) ?? [];
            bucket.push(m);
            byDay.set(day, bucket);
          }
        }
      }
    } catch (err) {
      ctx.log(`slack: #${channel.name} skipped (${errorMessage(err)})`);
      continue;
    }

    for (const [day, messages] of byDay) {
      messages.sort((a, b) => Number(a.ts) - Number(b.ts));
      const saved = upsertDocument({
        id: `slack:${channel.id}:day:${day}`,
        source: "slack",
        title: `#${channel.name}, ${day}`,
        url: link(channel.id, messages[0].ts!),
        container: `#${channel.name}`,
        author: null,
        updatedAt: tsToIso(messages.at(-1)!.ts!),
        text: messages.map(line).join("\n"),
      });
      if (saved) updated++;
    }
  }
  return updated;
}

function tsToIso(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString();
}
