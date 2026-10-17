import type { BetaManagedAgentsCustomToolParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import {
  asGoogleAccount,
  checkAvailability,
  driveIdFrom,
  driveItem,
  findSpace,
  listCalendars,
  listDriveFolder,
  listGroupMembers,
  readLive,
  readSpaceMessages,
  searchCalendar,
  searchChat,
  searchDrive,
  searchGmail,
  searchGroups,
  searchPeople,
  type Found,
  type SearchResult,
} from "../live";
import { errorMessage } from "../text";
import { PERSON_SCOPES, personAccessToken } from "./people";

// The Managed Agent's own tools, run here in our code. Every one reads as the person asking (Drive, the directory,
// Gmail, Calendar and Chat), through the admin's domain-wide delegation, so each person sees only what their own
// account can see. Which person that is comes from the verified Chat sender, never from the model. Every tool only reads.

/** Parts of a file one read returns (about 1,200 characters each); the rest comes with `start`. */
const READ_PARTS = 40;

type Args = Record<string, unknown>;

interface AgentTool {
  definition: BetaManagedAgentsCustomToolParams;
  /** The read-only scopes it reads the asker's own account with. */
  scopes: string[];
  /** Shown in Chat while it runs; never names a file, a search or a person. */
  progress: string;
  run: (args: Args) => Promise<string>;
}

const text = (args: Args, key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
const count = (args: Args, key: string, fallback: number, max: number) =>
  typeof args[key] === "number" ? Math.min(Math.max(Math.round(args[key] as number), 1), max) : fallback;

function listing(where: string, result: SearchResult): string {
  if (!result.found.length) return result.summary ?? `Nothing in ${where} matched. Try fewer or other words.`;
  const head =
    result.summary ??
    (result.complete ? `${result.total} result(s) in ${where}, all shown.` : `The first ${result.found.length} result(s) in ${where}; more match.`);
  return [head, result.note, ...result.found.map(entry)].filter(Boolean).join("\n\n");
}

function entry(f: Found): string {
  const id = f.docId.replace(/^(drive|gmail|gchat):/, "");
  return [`${f.title}${id !== f.docId ? ` (id ${id})` : ""}${f.url ? ` ${f.url}` : ""}`, f.text].filter(Boolean).join("\n");
}

function paged(title: string, url: string | null, all: Found[], start: number, tool: string, focus = ""): string {
  const total = all.length;
  const shown = all.slice(start - 1, start - 1 + READ_PARTS);
  if (!shown.length) return total ? `This has ${total} parts, so there is nothing from part ${start} on.` : "There is no readable text.";
  const end = start - 1 + shown.length;
  const scope = start === 1 && end === total ? `All ${total} part(s)` : `Parts ${start}-${end} of ${total}`;
  const more = end < total ? `\n\nMore parts remain: ${tool} with start ${end + 1}${focus ? "" : ", or with a focus for one topic"}.` : "";
  return `“${title}” ${url ?? ""}\n${scope}:\n\n${shown.map((p) => p.text).join("\n\n")}${more}`;
}

const blank = (docId: string, source: Found["source"]): Found => ({ docId, source, title: "", url: null, container: "", author: null, updatedAt: "", text: "" });

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): BetaManagedAgentsCustomToolParams {
  return { type: "custom", name, description, input_schema: { type: "object", properties, ...(required.length ? { required } : {}) } };
}

const TOOLS: AgentTool[] = [
  // ─── Drive and the directory: the company account ───
  {
    definition: tool(
      "search_drive",
      "Search the NDI shared drive for files whose name or text contains ALL the given keywords; files whose name " +
        "matches come first. AI employee codes like 'GP-01' match exactly. Returns files with their id and link, not " +
        "their content: read the relevant ones with read_drive_file. If nothing matches, try fewer words or synonyms.",
      {
        query: { type: "string", description: "1-3 keywords, e.g. 'architecture details'" },
        limit: { type: "integer", minimum: 1, maximum: 15, description: "Maximum files (default 8)" },
      },
      ["query"],
    ),
    scopes: PERSON_SCOPES.drive,
    progress: "Searching the Drive…",
    run: async (args) => {
      const query = text(args, "query");
      if (!query) return "Give one to three keywords to search for.";
      return listing(`the NDI shared drive for “${query}”`, await searchDrive(query, count(args, "limit", 8, 15)));
    },
  },
  {
    definition: tool(
      "read_drive_file",
      `Read a Drive file by its id or link: Docs, Sheets, Slides, PDF, Word, Excel and PowerPoint, ${READ_PARTS} parts at a ` +
        "time (the result says when more parts remain; ask for them with start). With a focus (an AI employee code or " +
        "words) you get only what concerns it: for a spreadsheet, the rows or column about it. A folder id lists the folder.",
      {
        file: { type: "string", description: "The file or folder id, or its Google Drive / Docs link" },
        start: { type: "integer", minimum: 1, description: "The part to start from (default 1)" },
        focus: { type: "string", description: "Optional: an AI employee code or words, e.g. 'GP-01'" },
      },
      ["file"],
    ),
    scopes: PERSON_SCOPES.drive,
    progress: "Reading a file…",
    run: async (args) => {
      const fileId = driveIdFrom(text(args, "file"));
      if (!fileId) return "Give a Drive file or folder id, or its link.";
      const item = await driveItem(fileId);
      if (item.folder) return (await listDriveFolder(item)).map((part) => part.text).join("\n\n");
      const focus = text(args, "focus");
      const all = await readLive({ ...item, folder: undefined } as Found, focus || undefined);
      return paged(item.title, item.url, all, count(args, "start", 1, 100_000), "read_drive_file", focus);
    },
  },
  {
    definition: tool(
      "search_people",
      "Look up people in the company's Google Workspace directory: name, email, title, department, manager, phone, " +
        "admin status and last sign-in. The query is a name, an email, or directory syntax such as \"orgDepartment='Sales'\"; " +
        "leave it empty for everyone. Always returns every match with the total.",
      { query: { type: "string", description: "A name, an email, or directory search syntax" } },
    ),
    scopes: PERSON_SCOPES.directory,
    progress: "Looking up the directory…",
    run: async (args) => listing("the directory", await searchPeople(text(args, "query"))),
  },
  {
    definition: tool(
      "search_groups",
      "Find Google Workspace groups with their email, description and member count: search with directory syntax like " +
        "email:sales* (empty for all groups), or pass member_email for the groups one person belongs to.",
      {
        query: { type: "string", description: "Directory search syntax, e.g. email:sales*" },
        member_email: { type: "string", description: "A person's email, to list the groups they belong to" },
      },
    ),
    scopes: PERSON_SCOPES.directory,
    progress: "Looking up the directory…",
    run: async (args) => listing("Workspace groups", await searchGroups(text(args, "query"), text(args, "member_email") || undefined)),
  },
  {
    definition: tool(
      "list_group_members",
      "List the members of a Google Workspace group, with each member's role: owner, manager or member.",
      { group_email: { type: "string", description: "The group's email address" } },
      ["group_email"],
    ),
    scopes: PERSON_SCOPES.directory,
    progress: "Looking up the directory…",
    run: async (args) => {
      const rows = await listGroupMembers(text(args, "group_email"));
      return rows.length ? rows.map((r) => r.text).join("\n\n") : `No members found for ${text(args, "group_email")}.`;
    },
  },

  // ─── Gmail, Calendar and Chat: the person asking ───
  {
    definition: tool(
      "search_gmail",
      "Search the Gmail mailbox of the person asking (only theirs), using Gmail search syntax: keywords, \"exact phrase\", " +
        "from:, to:, subject:, after:YYYY/MM/DD, before:YYYY/MM/DD, has:attachment. Returns matching threads, newest first, " +
        "with the latest message's time and snippet; read one with read_email_thread.",
      {
        query: { type: "string", description: "Gmail search, e.g. 'subject:invoice after:2026/06/01'" },
        limit: { type: "integer", minimum: 1, maximum: 15, description: "Maximum threads (default 8)" },
      },
      ["query"],
    ),
    scopes: PERSON_SCOPES.gmail,
    progress: "Checking your Gmail…",
    run: async (args) => listing("Gmail", await searchGmail(text(args, "query"), count(args, "limit", 8, 15))),
  },
  {
    definition: tool(
      "read_email_thread",
      "Read a whole email thread from the mailbox of the person asking, by its id from search_gmail: every message with its time, sender, recipients and text.",
      {
        thread_id: { type: "string", description: "The thread id from search_gmail" },
        start: { type: "integer", minimum: 1, description: "The part to start from (default 1)" },
      },
      ["thread_id"],
    ),
    scopes: PERSON_SCOPES.gmail,
    progress: "Reading an email…",
    run: async (args) => {
      const id = text(args, "thread_id").replace(/^gmail:/, "");
      if (!id) return "Give a thread id from search_gmail.";
      return paged("Email thread", null, await readLive(blank(`gmail:${id}`, "gmail")), count(args, "start", 1, 100_000), "read_email_thread");
    },
  },
  {
    definition: tool(
      "search_calendar",
      "Read events from the calendar of the person asking: title, time (in GMT), location, organizer, attendees and their " +
        "responses, video link and description. Without dates it covers the next two weeks. Dates can be '2026-09-20' or a " +
        "full timestamp; the end is inclusive. Use calendar_id for another calendar from list_calendars.",
      {
        query: { type: "string", description: "Optional words to match in the event, e.g. 'stand-up'" },
        start: { type: "string", description: "Start of the range, e.g. '2026-09-20' (default: now)" },
        end: { type: "string", description: "Last day or time of the range, inclusive (default: two weeks after the start)" },
        calendar_id: { type: "string", description: "Calendar id (default: their own calendar)" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum events (default 25)" },
      },
    ),
    scopes: PERSON_SCOPES.calendar,
    progress: "Checking your calendar…",
    run: async (args) =>
      listing(
        "the calendar",
        await searchCalendar(text(args, "query"), text(args, "start") || undefined, text(args, "end") || undefined, text(args, "calendar_id") || undefined, count(args, "limit", 25, 100)),
      ),
  },
  {
    definition: tool("list_calendars", "List the calendars the person asking can see (their own and shared ones), with ids and access level.", {}),
    scopes: PERSON_SCOPES.calendar,
    progress: "Checking your calendar…",
    run: async () => (await listCalendars()).map((row) => row.text).join("\n\n"),
  },
  {
    definition: tool(
      "check_availability",
      "Show when people in the company are busy (in GMT), to find a free slot for a meeting: busy blocks only, never what the meetings are. Without dates it covers the next 7 days; the end is inclusive.",
      {
        emails: { type: "array", items: { type: "string" }, description: "Email addresses to check" },
        start: { type: "string", description: "Start of the range, e.g. '2026-09-20' (default: now)" },
        end: { type: "string", description: "Last day or time of the range, inclusive (default: 7 days later)" },
      },
      ["emails"],
    ),
    scopes: PERSON_SCOPES.calendar,
    progress: "Checking calendars…",
    run: async (args) => {
      const emails = Array.isArray(args.emails) ? args.emails.filter((e): e is string => typeof e === "string") : [];
      if (!emails.length) return "Give at least one email address.";
      return (await checkAvailability(emails, text(args, "start") || undefined, text(args, "end") || undefined)).map((row) => row.text).join("\n\n");
    },
  },
  {
    definition: tool(
      "search_chat",
      "Search Google Chat messages in the named spaces the person asking is in, with plain keywords. Returns matching " +
        "messages with sender, time and space (the best ones with their whole thread); read a thread with read_chat_thread.",
      {
        query: { type: "string", description: "Keywords, e.g. 'release date mobile app'" },
        limit: { type: "integer", minimum: 1, maximum: 15, description: "Maximum messages (default 8)" },
      },
      ["query"],
    ),
    scopes: PERSON_SCOPES.chat,
    progress: "Searching Chat…",
    run: async (args) => listing("Google Chat", await searchChat(text(args, "query"), count(args, "limit", 8, 15))),
  },
  {
    definition: tool(
      "read_chat_thread",
      "Read a whole Chat thread by its id from search_chat (spaces/…/threads/…), oldest message first.",
      { thread: { type: "string", description: "The thread id, spaces/…/threads/…" } },
      ["thread"],
    ),
    scopes: PERSON_SCOPES.chat,
    progress: "Reading a Chat thread…",
    run: async (args) => {
      const thread = text(args, "thread").replace(/^gchat:/, "");
      if (!thread.startsWith("spaces/")) return "Give a thread id like spaces/AAAA/threads/BBBB.";
      return (await readLive(blank(`gchat:${thread}`, "gchat"))).map((p) => p.text).join("\n\n") || "This thread has no messages with text.";
    },
  },
  {
    definition: tool(
      "read_space_messages",
      "Read a Chat space's messages from the last days, oldest first, with times: the space the question was asked in " +
        "(its id is in the context) or another space by name, to catch up on it or summarise it.",
      {
        space: { type: "string", description: "The space's id 'spaces/…' or its name as shown in Chat" },
        days: { type: "integer", minimum: 1, maximum: 60, description: "How many days back to read (default 14)" },
      },
      ["space"],
    ),
    scopes: PERSON_SCOPES.chat,
    progress: "Reading a Chat space…",
    run: async (args) => {
      const found = await findSpace(text(args, "space"));
      if ("error" in found) return found.error;
      const days = count(args, "days", 14, 60);
      const rows = await readSpaceMessages(found.name, found.displayName, days);
      return rows.length ? rows.map((r) => r.text).join("\n\n") : `No messages in ${found.displayName} in the last ${days} days.`;
    },
  },
];

export const AGENT_TOOLS: BetaManagedAgentsCustomToolParams[] = TOOLS.map((t) => t.definition);

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

/** A progress line for Chat while a tool runs. Never names a file or a search: others may read it. */
export function toolProgress(name: string): string {
  const known = TOOLS.find((t) => t.definition.name === name);
  if (known) return known.progress;
  if (name.startsWith("fireflies")) return "Checking meetings…";
  if (name.startsWith("slack_")) return "Checking Slack…";
  // The built-in read, grep and glob only ever read the Drive map skill in the agent's sandbox.
  if (name === "read" || name === "grep" || name === "glob") return "Checking the Drive map…";
  return "Working on it…";
}

/** Runs one of our tools as `asker`, the verified sender of the Chat message, with only the scopes that tool needs. */
export async function runAgentTool(name: string, input: unknown, asker: string): Promise<ToolOutcome> {
  const found = TOOLS.find((t) => t.definition.name === name);
  if (!found) return { text: `Unknown tool: ${name}`, isError: true };
  const args = (input ?? {}) as Args;
  try {
    const token = await personAccessToken(asker, found.scopes);
    const text = await asGoogleAccount(token, () => found.run(args));
    return { text, isError: false };
  } catch (err) {
    return { text: `${name} failed: ${errorMessage(err)}`, isError: true };
  }
}
