import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { postMessage } from "../chat/client";
import { env } from "../config";
import { loadDriveMap } from "../drive-map";
import { postgres } from "../postgres";
import { clip, errorMessage, gmt, hideSecrets } from "../text";
import { meetingHeadersBetween, meetingsBetween, type Meeting, type MeetingHeader } from "./fireflies";

// Client meetings recorded in Fireflies, posted to a Chat space (MEETING_UPLOADS_SPACE) as a short summary plus the
// transcript link. Each meeting is decided once and remembered in Postgres (table meeting_uploads), so an hourly
// run posts only what is new. Which meetings count, and the summary, come from Claude.

// Read when used: scripts load .env.local after their imports have run.
const model = () => env("MEETINGS_MODEL") ?? "claude-opus-5-5";
// If the model declines, the API re-runs the request on a fallback model inside the same call.
const BETAS: Anthropic.Beta.AnthropicBeta[] = ["server-side-fallback-2026-07-01"];
// How far back an hourly run looks: Fireflies can take a while to finish a summary.
const LOOKBACK_MS = 2 * 24 * 3600_000;

export type Decision = "post" | "skip" | "wait";

export interface Draft {
  id: string;
  title: string;
  /** Start time, ISO. */
  at: string;
  minutes: number;
  url: string;
  decision: Decision;
  client: string;
  reason: string;
  summary: string;
  /** The Chat message as it would be posted; "" unless the decision is "post". */
  text: string;
}

const SortSchema = z.object({
  client_meeting: z.boolean(),
  client: z.string(),
  reason: z.string(),
  summary: z.string(),
});

const SYSTEM = `You sort meetings recorded in Fireflies for NDI (New Digital Intelligence), an AI delivery consultancy, and write the summary that is shared in the team's "Client Meeting Uploads" Google Chat space. The space is for real client meetings, the business conversations with a client, not for the day-to-day running of projects.

Post (client_meeting true) only a one-off business meeting with a client or a prospective client, such as:
- a first meeting or an introduction;
- a presentation or demo of what NDI offers;
- shaping a new project, use case, opportunity or proposal, or a commercial discussion;
- a conversation with the client's people about their business, needs or priorities, or about the relationship or the account, even when the ongoing project comes up too (for example a catch-up with a client's manager or executive).
A partner of NDI can be there too.

Don't post (client_meeting false):
- working sessions on work already agreed, even with the client: stand-ups and dailies, status calls, jour fixe, steering committees, sprint planning or open-items sessions, technical workshops and deep dives, specification walkthroughs, training, UAT and testing, rollout, cutover and go-live calls, and the kick-off of work already agreed;
- any meeting that is part of a regular series. The input says how often the same meeting ran before; words like "daily", "weekly", "monthly", "jour fixe" or "stand-up" in the title also mark a series;
- meetings among NDI people only; talks with investors or about investing in NDI; job interviews and hiring; NDI's own suppliers, vendors, advisers or freelancers; personal meetings or anything unrelated to NDI's business; meetings with almost nothing said.
Judge by who attended (their email domains) and what most of the meeting was about, not by the title alone. The known clients list helps, but a new client won't be on it. When it is unclear whether the other side is a client or prospect at all, answer no.

Fields:
- client: the client's company name as people at NDI would say it (short, no legal suffix); if the meeting doesn't name it, the company of their email domain; "" when it is not a client meeting.
- reason: one short sentence on why, for the person checking your decision.
- summary: "" unless it is a client meeting. Otherwise 2 or 3 short sentences in English, at most 60 words: what the meeting was about, what was decided or where things stand, and the main next steps with who owns them. Plain text: no bullets, no Markdown, no timestamps. Leave out talk about investment in NDI, people's pay or health, other personal matters, and any password or credential.`;

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/**
 * Drafts for the given meetings: post, skip, or wait for Fireflies' summary. Posts nothing. `history` holds the
 * meetings of the months before, to tell a regular series from a one-off meeting.
 */
export async function draftMeetings(
  meetings: Meeting[],
  history: MeetingHeader[],
  onDraft?: (draft: Draft) => void,
): Promise<Draft[]> {
  const clients = await knownClients();
  const drafts: Draft[] = new Array(meetings.length);
  let next = 0;
  // A few at a time: each is one short Claude call.
  await Promise.all(
    Array.from({ length: Math.min(4, meetings.length) }, async () => {
      while (next < meetings.length) {
        const i = next++;
        drafts[i] = await draftMeeting(meetings[i], series(meetings[i], history), clients);
        onDraft?.(drafts[i]);
      }
    }),
  );
  return drafts;
}

/** How a meeting relates to the ones before it: Google or Outlook calls it recurring, or it ran on other days. */
function series(meeting: MeetingHeader, history: MeetingHeader[]): { recurring: boolean; earlierDays: number } {
  const event = calendarSeries(meeting.calendar_id);
  const title = titleKey(meeting.title);
  const day = dayOf(meeting.date);
  const days = new Set<string>();
  let sameEvent = false;
  for (const other of history) {
    if (other.id === meeting.id || other.date >= meeting.date || other.date < meeting.date - SERIES_WINDOW_MS) continue;
    if (dayOf(other.date) === day) continue;
    const eventMatch = Boolean(event) && calendarSeries(other.calendar_id) === event;
    sameEvent ||= eventMatch;
    if (eventMatch || titleKey(other.title) === title) days.add(dayOf(other.date));
  }
  // A split Google series ("this and following events") carries "_R<date>"; the same calendar event on another day
  // is a series too. A title alone needs two earlier days, so meeting the same person twice isn't a series.
  const splitSeries = /_R\d{8}T\d{6}Z?$/.test(meeting.calendar_id ?? "");
  return { recurring: splitSeries || sameEvent || days.size >= 2, earlierDays: days.size };
}

// The series check looks this far back.
const SERIES_WINDOW_MS = 90 * 24 * 3600_000;

function calendarSeries(id: string | null): string {
  return (id ?? "").replace(/_R\d{8}T\d{6}Z?$/, "");
}

/** The title without the flags people put in front ("BLOCKER:", "TO BE CONFIRMED:") or a trailing dot. */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\s*((blocker|to be confirmed|tbc|tentative|canceled|cancelled|moved|updated invitation)\s*:\s*)+/g, "")
    .replace(/[.\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function draftMeeting(
  meeting: Meeting,
  seriesInfo: { recurring: boolean; earlierDays: number },
  clients: string,
): Promise<Draft> {
  const base = {
    id: meeting.id,
    title: meeting.title.trim(),
    at: new Date(meeting.date).toISOString(),
    minutes: Math.round(meeting.duration ?? 0),
    url: meeting.transcript_url,
    client: "",
    summary: "",
    text: "",
  };
  const status = meeting.meeting_info?.summary_status ?? null;
  const summary = summaryText(meeting);
  if (seriesInfo.recurring) {
    return { ...base, decision: "skip", reason: "Part of a regular series of meetings." };
  }
  if (status === "skipped" || status === "failed") {
    return { ...base, decision: "skip", reason: "Fireflies made no summary: almost nothing was said or recorded." };
  }
  if (!summary || (status && status !== "processed")) {
    return { ...base, decision: "wait", reason: "Fireflies is still writing the summary." };
  }

  let response;
  try {
    response = await anthropic().beta.messages.parse({
      model: model(),
      max_tokens: 16000,
      betas: BETAS,
      fallbacks: "default",
      output_config: { format: betaZodOutputFormat(SortSchema), effort: "medium" },
      system: SYSTEM,
      messages: [{ role: "user", content: `${clients}\n\n${meetingText(meeting, seriesInfo.earlierDays)}\n\n${summary}` }],
    });
  } catch (err) {
    // An API error after the SDK's own retries: try this meeting again on the next run.
    return { ...base, decision: "wait", reason: `Claude call failed: ${errorMessage(err)}` };
  }
  const sorted = response.parsed_output;
  if (response.stop_reason === "refusal" || !sorted) {
    return { ...base, decision: "skip", reason: "Claude returned no decision for this meeting." };
  }
  if (!sorted.client_meeting || !sorted.summary.trim()) {
    return { ...base, decision: "skip", reason: sorted.reason };
  }
  const draft: Draft = {
    ...base,
    decision: "post",
    client: sorted.client.trim(),
    reason: sorted.reason,
    summary: hideSecrets(sorted.summary.trim()),
  };
  return { ...draft, text: messageText(draft) };
}

/** The message posted to the space, in Chat's own markup. */
function messageText(draft: Draft): string {
  const heading = draft.client ? `${draft.client} · ${draft.title}` : draft.title;
  return [
    `*${heading}*`,
    `${gmt(draft.at)}${draft.minutes ? ` · ${draft.minutes} min` : ""}`,
    "",
    draft.summary,
    "",
    `<${draft.url}|Fireflies transcript>`,
  ].join("\n");
}

function meetingText(meeting: Meeting, earlierDays: number): string {
  const people = new Map<string, string>();
  for (const a of meeting.meeting_attendees ?? []) {
    const email = a.email?.toLowerCase();
    if (email) people.set(email, a.displayName?.trim() || "");
  }
  for (const email of meeting.participants ?? []) {
    for (const one of email.split(/[,;\s]+/)) if (one.includes("@") && !people.has(one.toLowerCase())) people.set(one.toLowerCase(), "");
  }
  const attendees = [...people].map(([email, name]) => (name ? `${name} <${email}>` : email));
  return [
    "<meeting>",
    `Title: ${meeting.title}`,
    `When: ${gmt(new Date(meeting.date).toISOString())}${meeting.duration ? `, ${Math.round(meeting.duration)} min` : ""}`,
    `Organizer: ${meeting.organizer_email ?? "unknown"}`,
    `Attendees: ${attendees.join(", ") || "unknown"}`,
    `Earlier days with a meeting of the same title or calendar event, last 90 days: ${earlierDays}`,
    "</meeting>",
  ].join("\n");
}

/** Fireflies' own summary of the meeting, or "" while it isn't ready. */
function summaryText(meeting: Meeting): string {
  const s = meeting.summary;
  const parts = [
    ["Overview", s?.overview],
    ["Short summary", s?.short_summary],
    ["Key points", s?.bullet_gist],
    ["Action items", s?.action_items],
    ["Keywords", s?.keywords?.join(", ")],
  ].filter((p): p is [string, string] => Boolean(p[1]?.trim()));
  if (!parts.some(([label]) => label !== "Keywords")) return "";
  return `<fireflies_summary>\n${parts.map(([label, text]) => `${label}:\n${clip(text.trim(), 6000)}`).join("\n\n")}\n</fireflies_summary>`;
}

/** The client names in the Drive map, as a hint. */
async function knownClients(): Promise<string> {
  const map = await loadDriveMap();
  const names = [...new Set((map?.clients ?? []).map((c) => c.client.trim()).filter(Boolean))].sort();
  return `<known_clients>\n${names.join("\n") || "(none)"}\n</known_clients>`;
}

// ── Storage ──────────────────────────────────────────────────────────────────────────────────────────

let ready: Promise<void> | undefined;
function table(): Promise<void> {
  const db = postgres();
  if (!db) return Promise.reject(new Error("DATABASE_URL is not set: meeting uploads need Postgres to remember what was posted."));
  ready ??= db
    .query(
      "create table if not exists meeting_uploads (transcript_id text primary key, meeting_at timestamptz, title text, status text not null, client text, reason text, message_name text, updated_at timestamptz not null default now())",
    )
    .then(() => db.query("alter table meeting_uploads enable row level security"))
    .then(() => undefined)
    .catch((err) => {
      ready = undefined;
      throw err;
    });
  return ready;
}

/** The meeting ids already posted or skipped. */
export async function handledIds(ids: string[]): Promise<Set<string>> {
  await table();
  const res = await postgres()!.query<{ transcript_id: string }>(
    "select transcript_id from meeting_uploads where transcript_id = any($1)",
    [ids],
  );
  return new Set(res.rows.map((r) => r.transcript_id));
}

/** Remembers a meeting that won't be posted, so later runs leave it alone. */
export async function recordSkip(draft: Draft, reason = draft.reason): Promise<void> {
  await table();
  await postgres()!.query(
    "insert into meeting_uploads (transcript_id, meeting_at, title, status, client, reason) values ($1, $2, $3, 'skipped', $4, $5) on conflict (transcript_id) do nothing",
    [draft.id, draft.at, draft.title, draft.client || null, reason],
  );
}

/**
 * Posts a drafted meeting to the space, once: the row is claimed before posting, so two runs can't both post it.
 * Returns the message name, or null when it was already handled.
 */
export async function postDraft(draft: Draft, space: string): Promise<string | null> {
  if (draft.decision !== "post" || !draft.text) throw new Error(`${draft.id} has no message to post.`);
  await table();
  const db = postgres()!;
  const claimed = await db.query(
    "insert into meeting_uploads (transcript_id, meeting_at, title, status, client, reason) values ($1, $2, $3, 'posting', $4, $5) on conflict (transcript_id) do nothing",
    [draft.id, draft.at, draft.title, draft.client, draft.reason],
  );
  if (!claimed.rowCount) return null;
  let name: string;
  try {
    name = await postMessage(space, draft.text);
  } catch (err) {
    // Not posted: free the meeting for the next run.
    await db.query("delete from meeting_uploads where transcript_id = $1 and status = 'posting'", [draft.id]);
    throw err;
  }
  await db.query(
    "update meeting_uploads set status = 'posted', message_name = $2, updated_at = now() where transcript_id = $1",
    [draft.id, name],
  );
  return name;
}

export function uploadsSpace(): string {
  const space = env("MEETING_UPLOADS_SPACE");
  if (!space) throw new Error("MEETING_UPLOADS_SPACE is not set.");
  return space.startsWith("spaces/") ? space : `spaces/${space}`;
}

/** One hourly run: drafts the meetings of the last two days not handled yet, posts the client ones, oldest first. */
export async function runMeetingUploads(log: (line: string) => void = console.log): Promise<{ posted: number; skipped: number; waiting: number }> {
  const space = uploadsSpace();
  const now = new Date();
  const meetings = await meetingsBetween(new Date(now.getTime() - LOOKBACK_MS), now);
  const handled = await handledIds(meetings.map((m) => m.id));
  const fresh = meetings.filter((m) => !handled.has(m.id));
  if (!fresh.length) return { posted: 0, skipped: 0, waiting: 0 };
  const history = await meetingHeadersBetween(new Date(now.getTime() - LOOKBACK_MS - SERIES_WINDOW_MS), now);
  const drafts = await draftMeetings(fresh, history);
  const counts = { posted: 0, skipped: 0, waiting: 0 };
  for (const draft of drafts) {
    if (draft.decision === "wait") {
      counts.waiting++;
      if (draft.reason.startsWith("Claude call failed")) log(`retry later ${draft.id} (${draft.title}): ${draft.reason}`);
    } else if (draft.decision === "skip") {
      await recordSkip(draft);
      counts.skipped++;
      log(`skipped ${draft.id} (${draft.title}): ${draft.reason}`);
    } else if (await postDraft(draft, space)) {
      counts.posted++;
      log(`posted ${draft.id} (${draft.client} · ${draft.title})`);
    }
  }
  return counts;
}
