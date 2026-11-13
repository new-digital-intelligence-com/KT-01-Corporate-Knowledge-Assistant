import { env } from "../config";

// Fireflies' GraphQL API, read-only, with FIREFLIES_API_KEY (the account whose meetings are posted).
const ENDPOINT = "https://api.fireflies.ai/graphql";
const PAGE = 50;

/** Just enough of a meeting to tell whether it belongs to a series. */
export interface MeetingHeader {
  id: string;
  title: string;
  /** Start time, ms since epoch. */
  date: number;
  /** The calendar event: a recurring series keeps one id; Google adds "_R<date>" when a series is split. */
  calendar_id: string | null;
}

export interface Meeting extends MeetingHeader {
  /** Minutes. */
  duration: number | null;
  organizer_email: string | null;
  participants: string[] | null;
  transcript_url: string;
  meeting_attendees: { displayName: string | null; email: string | null }[] | null;
  /** "processed" once the summary is ready; "skipped" or "failed" when there will be none. */
  meeting_info: { summary_status: string | null } | null;
  summary: {
    overview: string | null;
    short_summary: string | null;
    bullet_gist: string | null;
    action_items: string | null;
    keywords: string[] | null;
  } | null;
}

const HEADER_FIELDS = "id title date calendar_id";
const FIELDS = `
  ${HEADER_FIELDS} duration organizer_email participants transcript_url
  meeting_attendees { displayName email }
  meeting_info { summary_status }
  summary { overview short_summary bullet_gist action_items keywords }
`;

export function firefliesConfigured(): boolean {
  return Boolean(env("FIREFLIES_API_KEY"));
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = env("FIREFLIES_API_KEY");
  if (!key) throw new Error("FIREFLIES_API_KEY is not set.");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null;
  if (!res.ok || !json?.data || json.errors?.length) {
    const reason = json?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Fireflies: ${reason}`);
  }
  return json.data;
}

/** The meetings that started between `from` and `to`, oldest first. */
export function meetingsBetween(from: Date, to: Date): Promise<Meeting[]> {
  return list<Meeting>(FIELDS, from, to);
}

/** The same, with only what the series check needs: cheap enough to cover months. */
export function meetingHeadersBetween(from: Date, to: Date): Promise<MeetingHeader[]> {
  return list<MeetingHeader>(HEADER_FIELDS, from, to);
}

async function list<T extends MeetingHeader>(fields: string, from: Date, to: Date): Promise<T[]> {
  const all: T[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const data = await gql<{ transcripts: T[] | null }>(
      `query($from: DateTime, $to: DateTime, $limit: Int, $skip: Int) {
        transcripts(fromDate: $from, toDate: $to, limit: $limit, skip: $skip) { ${fields} }
      }`,
      { from: from.toISOString(), to: to.toISOString(), limit: PAGE, skip },
    );
    const page = data.transcripts ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all.sort((a, b) => a.date - b.date);
}
