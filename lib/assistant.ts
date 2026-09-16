import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { env, model } from "./config";
import { getChunks, getDocumentChunks, getStats, type ChunkRow } from "./db";
import {
  checkAvailability,
  keyDocumentConfigured,
  listAdminRoles,
  listCalendars,
  listGroupMembers,
  liveGoogleAvailable,
  readLive,
  readSpaceMessages,
  searchCalendar,
  searchChat,
  searchDrive,
  searchKeyDocument,
  searchGmail,
  searchGroups,
  searchPeople,
  searchYouTube,
  youtubeConfigured,
  type Found,
} from "./live";
import { searchChunks } from "./search";
import { clip, errorMessage } from "./text";
import {
  SOURCES,
  SOURCE_LABELS,
  type AnswerStatus,
  type AskContext,
  type AssistantEvent,
  type Citation,
  type FinalAnswer,
  type HistoryTurn,
  type Source,
} from "./types";

type Emit = (event: AssistantEvent) => void;
type Passages = Map<number, ChunkRow>;
type ToolResult = { content: string; is_error?: boolean };

/** Everything found while answering one question, keyed by the id the model cites. */
interface Research {
  passages: Passages;
  /** Gives content found live an id of its own and remembers it. */
  add: (found: Found) => ChunkRow;
}

export class AssistantError extends Error {}

const MAX_TOOL_ROUNDS = 10;
// [#123], or a bare long id like [900000008]: the model sometimes drops the "#". Short numbers like [2026] are left alone.
const MARKER = /\[#(\d+)\]|\[(\d{5,})\]/g;
// Live results get ids far above indexed passage ids, so the two never collide.
const LIVE_ID_START = 900_000_000;

// Server-side refusal fallback: if the model declines, the API re-runs the request on a
// suitable fallback model inside the same call instead of returning an empty refusal.
const BETAS: Anthropic.Beta.AnthropicBeta[] = ["server-side-fallback-2026-07-01"];

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

const LIMIT = { type: "integer", minimum: 1, maximum: 10, description: "Maximum results (default 6)" };

const SEARCH_DRIVE: Anthropic.Beta.BetaTool = {
  name: "search_drive",
  description:
    "Search Google Drive live for files whose name or content contains ALL the given keywords. " +
    "Returns matching files with ids, but not their content: open the relevant ones with read_result. " +
    "Use 1–3 distinctive keywords; if nothing matches, try fewer words, synonyms or another language.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "1–3 keywords, e.g. 'travel expenses'" }, limit: LIMIT },
    required: ["query"],
    additionalProperties: false,
  },
};

const SEARCH_GMAIL: Anthropic.Beta.BetaTool = {
  name: "search_gmail",
  description:
    "Search the Gmail mailbox live using Gmail search syntax: keywords, \"exact phrase\", from:, to:, subject:, " +
    "after:YYYY/MM/DD, before:YYYY/MM/DD, has:attachment. Returns matching email threads with the latest message's " +
    "snippet; open the relevant ones with read_result to read the whole thread.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "Gmail search, e.g. 'subject:invoice after:2026/06/01'" }, limit: LIMIT },
    required: ["query"],
    additionalProperties: false,
  },
};

const SEARCH_CHAT: Anthropic.Beta.BetaTool = {
  name: "search_chat",
  description:
    "Search Google Chat messages live across the company's Chat spaces, using plain keywords. " +
    "Returns matching messages with sender, date and space; open one with read_result to read its whole thread.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "Keywords, e.g. 'release date mobile app'" }, limit: LIMIT },
    required: ["query"],
    additionalProperties: false,
  },
};

const SEARCH_INDEX: Anthropic.Beta.BetaTool = {
  name: "search_company_knowledge",
  description:
    "Keyword search over previously indexed company content (for example Slack). Returns passages with ids. " +
    "Use short keyword queries rather than full sentences.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords, e.g. 'expense claim deadline'" },
      sources: { type: "array", items: { type: "string", enum: [...SOURCES] }, description: "Optional: only these sources" },
      limit: { type: "integer", minimum: 1, maximum: 15, description: "Maximum passages (default 8)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const READ_RESULT: Anthropic.Beta.BetaTool = {
  name: "read_result",
  description:
    "Open a search result by its id: the full Drive file, email thread or Chat thread (or indexed document), " +
    "returned as passages with ids you can cite.",
  input_schema: {
    type: "object",
    properties: { result_id: { type: "integer", description: "The id of a search result or passage" } },
    required: ["result_id"],
    additionalProperties: false,
  },
};

const READ_SPACE: Anthropic.Beta.BetaTool = {
  name: "read_space_messages",
  description:
    "Read the most recent messages of the Google Chat space where the question was asked, to understand what " +
    "\"this\", \"here\" or the ongoing discussion refers to. Returns the messages as passages with ids you can cite.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

const SEARCH_PEOPLE: Anthropic.Beta.BetaTool = {
  name: "search_people",
  description:
    "Look up people in the company's Google Workspace directory (read-only): name, email, title, department, manager, " +
    "phone, organizational unit and account status. The query is a name, an email, or directory search syntax such as " +
    "\"name:'Jane Smith'\", \"email:jane*\", \"orgDepartment='Sales'\", \"orgTitle:'Engineer'\" or \"isSuspended=false\". " +
    "Leave the query empty to list people.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A name, an email, or directory search syntax" },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum people (default 6)" },
    },
    required: [],
    additionalProperties: false,
  },
};

const SEARCH_GROUPS: Anthropic.Beta.BetaTool = {
  name: "search_groups",
  description:
    "Find Google Workspace groups (read-only) with their email, description and member count. Either search with " +
    "directory syntax like \"name:'Sales*'\" or \"email:team*\" (leave both fields empty to list all groups), or pass " +
    "member_email to get the groups one person belongs to.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Directory search syntax, e.g. \"email:sales*\"" },
      member_email: { type: "string", description: "A person's email, to list the groups they belong to" },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum groups (default 6)" },
    },
    required: [],
    additionalProperties: false,
  },
};

const LIST_GROUP_MEMBERS: Anthropic.Beta.BetaTool = {
  name: "list_group_members",
  description: "List the members of a Google Workspace group (read-only), with each member's role: owner, manager or member.",
  input_schema: {
    type: "object",
    properties: { group_email: { type: "string", description: "The group's email address" } },
    required: ["group_email"],
    additionalProperties: false,
  },
};

const AI_CATALOG: Anthropic.Beta.BetaTool = {
  name: "ai_employee_catalog",
  description:
    "The NDI AI Employee Catalog (the PowerPoint in Cross AI Employees), the source of truth for what each AI employee " +
    "is: code, name, category, purpose, capabilities and integrations. Pass an AI employee's code (e.g. 'GP-01'), name " +
    "or a topic to get the matching slides; leave the query empty for the list of slides.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "e.g. 'GP-01' or 'onboarding'" },
      limit: { type: "integer", minimum: 1, maximum: 12, description: "Maximum slides (default 6)" },
    },
    required: [],
    additionalProperties: false,
  },
};

const AI_TRACKER: Anthropic.Beta.BetaTool = {
  name: "ai_employee_tracker",
  description:
    "The AI Employee PoC Creation Tracker spreadsheet, across all its tabs: the current progress of each AI employee, " +
    "such as who it's assigned to, its status and dates. Pass an AI employee's code (e.g. 'GP-01'), a person or a status " +
    "to get the matching rows; leave the query empty to get every row.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "e.g. 'GP-01', 'Oleg' or 'in progress'" },
      limit: { type: "integer", minimum: 1, maximum: 60, description: "Maximum rows (default 25)" },
    },
    required: [],
    additionalProperties: false,
  },
};

const SEARCH_CALENDAR: Anthropic.Beta.BetaTool = {
  name: "search_calendar",
  description:
    "Read events from the signed-in person's Google Calendar (read-only): title, time, location, organizer, attendees " +
    "and their responses, video link and description. Without dates it covers the next two weeks. Dates can be " +
    "'2026-09-20' or a full timestamp. Use calendar_id for another calendar from list_calendars.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional words to match in the event, e.g. 'stand-up'" },
      start: { type: "string", description: "Start of the range, e.g. '2026-09-20' (default: now)" },
      end: { type: "string", description: "End of the range (default: two weeks after the start)" },
      calendar_id: { type: "string", description: "Calendar id (default: the person's own calendar)" },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum events (default 10)" },
    },
    required: [],
    additionalProperties: false,
  },
};

const LIST_CALENDARS: Anthropic.Beta.BetaTool = {
  name: "list_calendars",
  description: "List the calendars the signed-in person can see (own and shared), with their ids and access level.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

const CHECK_AVAILABILITY: Anthropic.Beta.BetaTool = {
  name: "check_availability",
  description:
    "Show when people in the company are busy, to find a free slot for a meeting. Returns busy blocks only, never what " +
    "the meetings are. Without dates it covers the next 7 days.",
  input_schema: {
    type: "object",
    properties: {
      emails: { type: "array", items: { type: "string" }, description: "Email addresses to check" },
      start: { type: "string", description: "Start of the range, e.g. '2026-09-20' (default: now)" },
      end: { type: "string", description: "End of the range (default: 7 days later)" },
    },
    required: ["emails"],
    additionalProperties: false,
  },
};

const LIST_ADMIN_ROLES: Anthropic.Beta.BetaTool = {
  name: "list_admin_roles",
  description:
    "List Google Workspace Admin console role assignments (read-only), such as Super Admin or User Management Admin, " +
    "for everyone or for one person. This can fail if the signed-in account isn't allowed to view roles; say so if it does.",
  input_schema: {
    type: "object",
    properties: { user_email: { type: "string", description: "Optional: only this person's roles" } },
    required: [],
    additionalProperties: false,
  },
};

const SEARCH_YOUTUBE: Anthropic.Beta.BetaTool = {
  name: "search_youtube",
  description:
    "Search the company's YouTube channel (read-only) by keywords in video titles and descriptions; leave the query " +
    "empty to get the latest videos. Returns each video's title, link, publish date, duration, visibility, views, likes, " +
    "tags and full description.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords, e.g. 'front office assistant demo'" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum videos (default 6)" },
    },
    required: [],
    additionalProperties: false,
  },
};

function availableTools(context: AskContext): Anthropic.Beta.BetaTool[] {
  const tools: Anthropic.Beta.BetaTool[] = [];
  if (liveGoogleAvailable()) tools.push(SEARCH_DRIVE, SEARCH_GMAIL, SEARCH_CHAT, SEARCH_PEOPLE, SEARCH_GROUPS, LIST_GROUP_MEMBERS, LIST_ADMIN_ROLES);
  if (liveGoogleAvailable()) tools.push(SEARCH_CALENDAR, LIST_CALENDARS, CHECK_AVAILABILITY);
  if (keyDocumentConfigured("catalog")) tools.push(AI_CATALOG);
  if (keyDocumentConfigured("tracker")) tools.push(AI_TRACKER);
  if (youtubeConfigured()) tools.push(SEARCH_YOUTUBE);
  if (liveGoogleAvailable() && context.space) tools.push(READ_SPACE);
  if (getStats().documents > 0) tools.push(SEARCH_INDEX);
  tools.push(READ_RESULT);
  return tools;
}

function answerSystemPrompt(context: AskContext): string {
  const where = context.spaceName
    ? `This question was asked in the Google Chat space "${context.spaceName}".`
    : context.spaceType === "DIRECT_MESSAGE"
      ? "This question was asked in a direct message with you."
      : "";
  const who = context.asker ? ` It was asked by ${context.asker}.` : "";
  const keyDocuments =
    env("AI_CATALOG_FILE_ID") || env("AI_TRACKER_FILE_ID")
      ? "\n- For anything about NDI's AI employees, check the two key documents first: ai_employee_catalog is the source of truth for what each AI employee is, and ai_employee_tracker holds its current progress (assignee, status, dates). If other documents disagree, the catalog wins on what an AI employee is and the tracker wins on progress; mention the difference."
      : "";

  return `You are Claude, the AI assistant of our company, working inside Google Chat. You are a capable general assistant: you explain, reason, give honest opinions and recommendations, draft and edit text, brainstorm and use your general knowledge. You also have live, read-only access to the company's Google Drive, Gmail, Google Chat, Google Workspace directory (people, groups and admin roles), YouTube channel and Google Calendar through your tools. Anyone in the company can ask you anything.

Today's date is ${new Date().toISOString().slice(0, 10)}. ${where}${who}

How to work:
- Decide whether the question involves the company: its AI employees, projects, clients, people, teams, groups, documents, decisions or anything that happened internally. If it does, search the company sources before answering, even when you think you know: short keyword queries in the sources that fit, then open the most relevant results with read_result and base company facts on what you read.
- Words like "this", "here", "this AI employee" or "this project" usually refer to the topic of the space you were asked in. Use the space name, and read its recent messages when that helps.${keyDocuments}
- If the question doesn't need company information (general knowledge, how-to, writing, brainstorming, opinions on a general topic), answer directly without searching.
- Cite company facts: put markers written exactly like [#123] (always with the #) right after each sentence that states something about the company, using ids from tool results, and only ids a tool returned in this conversation. Your own reasoning, opinions, general knowledge and suggestions don't get markers.
- Never present guesses about the company as facts. If the sources don't cover something company-specific, say so plainly, then still help as far as you can and make clear which part is your own view.
- When asked for your opinion or an assessment, give a genuine, specific one: strengths, weaknesses, risks and concrete suggestions, grounded in what you found.
- Before stating how many of something there are, make sure you have the complete list: tool results say how many items matched, and when only part is shown, fetch the rest first. Make every count you state match the items you list.
- Sources can be outdated or disagree. Prefer the most recent and most authoritative one, and say when they conflict.
- Write in English, even when the question or the sources are in another language, unless the person asks for a specific language. Lead with the direct answer and keep it as short as the question allows. Plain text: use "- " for list items and no headings.`;
}

const VERIFY_SYSTEM = `You fact-check answers written by the company's AI assistant before staff see them. You receive the question, the company passages the answer cites, and the draft answer, whose citation markers like [#123] refer to passage ids.

Only check statements that present facts about the company: its people, clients, projects, AI employees, documents, numbers, dates, decisions or what someone said. Leave everything else out: general knowledge, explanations, reasoning, opinions, assessments, recommendations and suggestions are the assistant's own contribution and are not checked.

Judge each company fact strictly against the passages it cites:
- supported: the cited passages state it, directly or as a plain paraphrase.
- partial: the cited passages back only part of it, or the statement is broader, more certain or more specific (numbers, dates, names, deadlines) than they are.
- unsupported: the cited passages don't state it, or the company fact has no citation.
Sentences that only say something couldn't be found are not facts; leave them out.
Counts and totals are company facts too: a stated number ("you own 7") that disagrees with the passages or with the number of items the draft itself lists is at best partial.

In each note, say briefly why, quoting the passage wording when that helps; leave the note empty for a plainly supported fact.
Under conflicts, list disagreements between passages that matter for the question; otherwise leave it empty.
Set is_not_found_answer to true only when the draft's main message is that the requested company information couldn't be found.
Write claims and notes in English.`;

const REWRITE_SYSTEM = `You revise answers from the company's AI assistant. A fact-check found company facts in the draft that the cited passages don't fully back.

Fix only those: correct partially supported statements so they say exactly what the passages say, and remove, or clearly mark as uncertain, anything the passages don't support. Keep everything else as it is, including general knowledge, reasoning, opinions and recommendations. Keep citation markers with passage ids, like [#123], after company facts, citing only the passages provided. Keep the language, the directness and the plain-text format of the draft ("- " for list items, no headings). Output only the revised answer.`;

const VerificationSchema = z.object({
  is_not_found_answer: z.boolean(),
  claims: z.array(
    z.object({
      claim: z.string(),
      verdict: z.enum(["supported", "partial", "unsupported"]),
      note: z.string(),
    }),
  ),
  conflicts: z.array(z.string()),
});
type Verification = z.infer<typeof VerificationSchema>;

export async function answerQuestion(
  question: string,
  history: HistoryTurn[],
  emit: Emit,
  signal?: AbortSignal,
  context: AskContext = {},
): Promise<void> {

  let nextLiveId = LIVE_ID_START;
  const research: Research = {
    passages: new Map(),
    add: (found) => {
      const row = { ...found, chunkId: nextLiveId++ };
      research.passages.set(row.chunkId, row);
      return row;
    },
  };
  const passages = research.passages;

  emit({ type: "progress", message: "Thinking…" });
  let draft = keepKnownMarkers(await investigate(question, history, research, emit, signal, context), passages);

  // Nothing was looked up, so there are no company facts to check.
  if (passages.size === 0) {
    emit({ type: "answer", answer: finalize(draft, { is_not_found_answer: false, claims: [], conflicts: [] }, passages, false) });
    return;
  }

  emit({ type: "progress", message: `Checking company facts against ${citedIds(draft).length} cited source(s)…` });
  let check = await verify(question, draft, passages, signal);
  let rewritten = false;

  const flagged = check.claims.filter((c) => c.verdict !== "supported").length;
  if (!check.is_not_found_answer && flagged > 0) {
    emit({ type: "progress", message: `${flagged} statement(s) not fully backed by the sources. Rewriting…` });
    draft = keepKnownMarkers(await rewrite(question, draft, check, passages, signal), passages);
    emit({ type: "progress", message: "Checking the rewritten answer…" });
    check = await verify(question, draft, passages, signal);
    rewritten = true;
  }

  emit({ type: "answer", answer: finalize(draft, check, passages, rewritten) });
}

/** The tool loop: Claude searches and reads until it can answer with citations. */
async function investigate(
  question: string,
  history: HistoryTurn[],
  research: Research,
  emit: Emit,
  signal?: AbortSignal,
  context: AskContext = {},
): Promise<string> {
  const tools = availableTools(context);
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const turn of history) {
    messages.push({ role: "user", content: turn.question }, { role: "assistant", content: stripMarkers(turn.answer) });
  }
  // The thread goes in the user turn, not the system prompt: it's what people wrote, not instructions.
  const thread = context.threadMessages
    ? `This is the Google Chat thread I'm asking in, oldest message first:\n<thread>\n${context.threadMessages}\n</thread>\n\n`
    : "";
  messages.push({ role: "user", content: `${thread}${question}` });

  for (let round = 0; ; round++) {
    const message = await anthropic()
      .beta.messages.stream(
        {
          model: model(),
          max_tokens: 64000,
          betas: BETAS,
          fallbacks: "default",
          cache_control: { type: "ephemeral" },
          system: answerSystemPrompt(context),
          tools,
          tool_choice: round >= MAX_TOOL_ROUNDS ? { type: "none" } : { type: "auto" },
          messages,
        },
        { signal },
      )
      .finalMessage();
    assertAnswered(message);
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "pause_turn") continue;
    const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || calls.length === 0) return textOf(message);

    const results: Anthropic.Beta.BetaContentBlockParam[] = await Promise.all(
      calls.map(async (call) => ({ type: "tool_result" as const, tool_use_id: call.id, ...(await runTool(call, research, emit, context)) })),
    );
    if (round + 1 >= MAX_TOOL_ROUNDS) {
      results.push({ type: "text", text: "That was your last search. Answer now from what you already have." });
    }
    messages.push({ role: "user", content: results });
  }
}

async function runTool(
  call: Anthropic.Beta.BetaToolUseBlock,
  research: Research,
  emit: Emit,
  context: AskContext,
): Promise<ToolResult> {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const limit = typeof input.limit === "number" ? Math.min(Math.max(Math.round(input.limit), 1), 10) : 6;

  try {
    switch (call.name) {
      case "search_drive":
        return listFound("Google Drive", query, await searchDrive(query, limit), research, emit);
      case "search_gmail":
        return listFound("Gmail", query, await searchGmail(query, limit), research, emit);
      case "search_chat":
        return listFound("Google Chat", query, await searchChat(query, limit), research, emit);

      case "search_company_knowledge": {
        const sources = Array.isArray(input.sources)
          ? input.sources.filter((s): s is Source => (SOURCES as readonly unknown[]).includes(s))
          : undefined;
        const max = typeof input.limit === "number" ? Math.min(Math.max(Math.round(input.limit), 1), 15) : 8;
        const hits = searchChunks(query, sources, max);
        hits.forEach((hit) => research.passages.set(hit.chunkId, hit));
        emit({ type: "progress", message: `Searched the index for “${query}”: ${hits.length} passage(s)` });
        return {
          content: hits.length
            ? hits.map((hit) => formatPassage(hit, 1500)).join("\n\n")
            : "No passages matched. Try other keywords, synonyms or another language.",
        };
      }

      case "ai_employee_catalog":
      case "ai_employee_tracker": {
        const kind = call.name === "ai_employee_catalog" ? "catalog" : "tracker";
        const [fallback, cap] = kind === "tracker" ? [25, 60] : [6, 12];
        const max = typeof input.limit === "number" ? Math.min(Math.max(Math.round(input.limit), 1), cap) : fallback;
        const { found, total } = await searchKeyDocument(kind, query, max);
        const rows = found.map(research.add);
        const unit = kind === "tracker" ? "row" : "slide";
        emit({ type: "progress", message: `Checked the AI employee ${kind} for “${query || "everything"}”: ${total} ${unit}(s)` });
        if (!rows.length) {
          return { content: `Nothing in the ${kind} matched “${query}”. Try the AI employee's code, name or another keyword.` };
        }
        // State the total so a list is never mistaken for complete when it was cut off.
        const summary = !query
          ? `The ${kind} has ${total} ${unit}(s).`
          : total > found.length
            ? `${total} ${unit}(s) match “${query}”; only ${found.length} are shown. Call again with limit ${Math.min(total, cap)} before counting or listing them all.`
            : `${total} ${unit}(s) match “${query}”, all shown below.`;
        return { content: `${summary}\n\n${rows.map((row) => formatPassage(row, 12_000)).join("\n\n")}` };
      }

      case "list_admin_roles": {
        const person = typeof input.user_email === "string" ? input.user_email.trim() : "";
        emit({ type: "progress", message: person ? `Checking admin roles of ${person}` : "Checking admin role assignments" });
        const rows = (await listAdminRoles(person || undefined)).map(research.add);
        return { content: rows.map((row) => formatPassage(row, 6000)).join("\n\n") };
      }

      case "search_youtube":
        return listFound("YouTube", query || "latest videos", await searchYouTube(query, Math.min(limit, 20)), research, emit);

      case "search_calendar": {
        const found = await searchCalendar(
          query,
          typeof input.start === "string" ? input.start : undefined,
          typeof input.end === "string" ? input.end : undefined,
          typeof input.calendar_id === "string" ? input.calendar_id : undefined,
          typeof input.limit === "number" ? Math.min(Math.max(Math.round(input.limit), 1), 50) : 10,
        );
        const range = [input.start, input.end].filter(Boolean).join(" → ") || "the next two weeks";
        return listFound("the calendar", query ? `${query} (${range})` : range, found, research, emit);
      }

      case "list_calendars": {
        const rows = (await listCalendars()).map(research.add);
        emit({ type: "progress", message: "Listing calendars" });
        return { content: rows.map((row) => formatPassage(row, 4000)).join("\n\n") };
      }

      case "check_availability": {
        const emails = Array.isArray(input.emails) ? input.emails.filter((e): e is string => typeof e === "string") : [];
        if (!emails.length) return { content: "Give at least one email address.", is_error: true };
        emit({ type: "progress", message: `Checking when ${emails.join(", ")} are busy` });
        const rows = (
          await checkAvailability(
            emails,
            typeof input.start === "string" ? input.start : undefined,
            typeof input.end === "string" ? input.end : undefined,
          )
        ).map(research.add);
        return { content: rows.map((row) => formatPassage(row, 6000)).join("\n\n") };
      }

      case "search_people":
        return listFound("the Workspace directory", query || "everyone", await searchPeople(query, limit), research, emit);

      case "search_groups": {
        const member = typeof input.member_email === "string" ? input.member_email.trim() : "";
        const found = await searchGroups(query, limit, member || undefined);
        return listFound("Workspace groups", member ? `groups of ${member}` : query || "all groups", found, research, emit);
      }

      case "list_group_members": {
        const group = typeof input.group_email === "string" ? input.group_email.trim() : "";
        emit({ type: "progress", message: `Listing members of ${group}` });
        const rows = (await listGroupMembers(group)).map(research.add);
        return { content: rows.length ? rows.map((row) => formatPassage(row, 6000)).join("\n\n") : `No members found for ${group}.` };
      }

      case "read_space_messages": {
        if (!context.space) return { content: "The space for this question isn't known.", is_error: true };
        emit({ type: "progress", message: `Reading recent messages in ${context.spaceName ?? "this space"}` });
        const rows = (await readSpaceMessages(context.space, context.spaceName)).map(research.add);
        return {
          content: rows.length ? rows.map((row) => formatPassage(row, 4000)).join("\n\n") : "No recent messages in this space.",
        };
      }

      case "read_result": {
        const id = Number(input.result_id);
        const item = research.passages.get(id) ?? getChunks([id])[0];
        if (!item) return { content: `There is no result with id ${String(input.result_id)}.`, is_error: true };
        emit({ type: "progress", message: `Reading “${clip(item.title, 70)}” (${SOURCE_LABELS[item.source]})` });
        const parts =
          item.chunkId >= LIVE_ID_START
            ? (await readLive(item)).map(research.add)
            : getDocumentChunks(item.docId)
                .slice(0, 40)
                .map((chunk) => {
                  research.passages.set(chunk.chunkId, chunk);
                  return chunk;
                });
        return {
          content: parts.length ? parts.map((p) => formatPassage(p, 4000)).join("\n\n") : "This item has no readable text.",
        };
      }
    }
    return { content: `Unknown tool: ${call.name}`, is_error: true };
  } catch (err) {
    emit({ type: "progress", message: `${call.name} failed: ${clip(errorMessage(err), 80)}` });
    return { content: `${call.name} failed: ${errorMessage(err)}`, is_error: true };
  }
}

function listFound(label: string, query: string, found: Found[], research: Research, emit: Emit): ToolResult {
  const rows = found.map(research.add);
  emit({ type: "progress", message: `Searched ${label} for “${query}”: ${rows.length} result(s)` });
  return {
    content: rows.length
      ? rows.map((row) => formatPassage(row, 1500)).join("\n\n")
      : `Nothing in ${label} matched “${query}”. Try fewer or other keywords, synonyms or another language.`,
  };
}

async function verify(question: string, draft: string, passages: Passages, signal?: AbortSignal): Promise<Verification> {
  const cited = citedIds(draft)
    .map((id) => passages.get(id))
    .filter((p): p is ChunkRow => Boolean(p));

  const response = await anthropic().beta.messages.parse(
    {
      model: model(),
      max_tokens: 16000,
      betas: BETAS,
      fallbacks: "default",
      output_config: { format: betaZodOutputFormat(VerificationSchema) },
      system: VERIFY_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `<question>\n${question}\n</question>\n\n` +
            `<cited_passages>\n${cited.map((p) => formatPassage(p, 6000)).join("\n\n") || "(none)"}\n</cited_passages>\n\n` +
            `<draft_answer>\n${draft}\n</draft_answer>`,
        },
      ],
    },
    { signal },
  );
  assertAnswered(response);
  if (!response.parsed_output) throw new AssistantError("The answer check returned no result. Please ask again.");
  return response.parsed_output;
}

async function rewrite(
  question: string,
  draft: string,
  check: Verification,
  passages: Passages,
  signal?: AbortSignal,
): Promise<string> {
  const findings = check.claims
    .filter((c) => c.verdict !== "supported")
    .map((c) => `- ${c.verdict}: ${c.claim}${c.note ? ` (${c.note})` : ""}`)
    .join("\n");

  const message = await anthropic()
    .beta.messages.stream(
      {
        model: model(),
        max_tokens: 32000,
        betas: BETAS,
        fallbacks: "default",
        system: REWRITE_SYSTEM,
        messages: [
          {
            role: "user",
            content:
              `<question>\n${question}\n</question>\n\n` +
              `<passages>\n${rewritePassages(draft, passages).map((p) => formatPassage(p, 2000)).join("\n\n")}\n</passages>\n\n` +
              `<draft_answer>\n${draft}\n</draft_answer>\n\n` +
              `<fact_check>\nThese statements in the draft are not fully backed by the passages they cite:\n${findings}\n</fact_check>`,
          },
        ],
      },
      { signal },
    )
    .finalMessage();
  assertAnswered(message);
  return textOf(message);
}

/** Cited passages first, so the cap never drops what the draft relied on. */
function rewritePassages(draft: string, passages: Passages): ChunkRow[] {
  const cited = new Set(citedIds(draft));
  const all = [...passages.values()];
  return [...all.filter((p) => cited.has(p.chunkId)), ...all.filter((p) => !cited.has(p.chunkId))].slice(0, 60);
}

function finalize(draft: string, check: Verification, passages: Passages, rewritten: boolean): FinalAnswer {
  // One number per document: several passages from the same file share its citation.
  const numbers = new Map<string, number>();
  const citations: Citation[] = [];

  const text = draft
    .replace(MARKER, (_, hashed?: string, bare?: string) => {
      const id = Number(hashed ?? bare);
      const passage = passages.get(id);
      if (!passage) return "";
      if (!numbers.has(passage.docId)) {
        numbers.set(passage.docId, citations.length + 1);
        citations.push({
          n: citations.length + 1,
          chunkId: id,
          source: passage.source,
          title: passage.title,
          url: passage.url,
          container: passage.container,
          author: passage.author,
          updatedAt: passage.updatedAt,
          excerpt: clip(passage.text, 320),
        });
      }
      return `[${numbers.get(passage.docId)}]`;
    })
    .replace(/(\[\d+\])\1+/g, "$1")
    // Safety net: a passage id must never reach the reader as plain text.
    .replace(/\s?\[\d{5,}\]/g, "")
    .trim();

  const unbacked = check.claims.filter((c) => c.verdict !== "supported").length;
  const status: AnswerStatus = check.is_not_found_answer ? "not_found" : unbacked === 0 ? "verified" : "partially_verified";

  return { text, status, citations, checks: check.claims, conflicts: check.conflicts, rewritten };
}

function formatPassage(p: ChunkRow, maxChars: number): string {
  const attr = (value: string) => value.replace(/"/g, "'").replace(/\s+/g, " ");
  return (
    `<passage id="${p.chunkId}" source="${SOURCE_LABELS[p.source]}" title="${attr(p.title)}" ` +
    `location="${attr(p.container)}" author="${attr(p.author ?? "unknown")}" date="${p.updatedAt.slice(0, 10)}">\n` +
    `${clip(p.text, maxChars)}\n</passage>`
  );
}

function citedIds(text: string): number[] {
  return [...new Set([...text.matchAll(MARKER)].map((m) => Number(m[1] ?? m[2])))];
}

/** Code-level check: a citation must point at something a tool actually returned. */
function keepKnownMarkers(text: string, passages: Passages): string {
  return text.replace(MARKER, (marker, hashed?: string, bare?: string) => (passages.has(Number(hashed ?? bare)) ? marker : ""));
}

function stripMarkers(text: string): string {
  return text.replace(/\s?\[#?\d+\]/g, "");
}

function textOf(message: { content: Anthropic.Beta.BetaContentBlock[] }): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** A message fit to show the person who asked, for any error the pipeline can throw. */
export function describeAssistantError(err: unknown): string {
  if (err instanceof AssistantError) return err.message;
  if (err instanceof Anthropic.APIUserAbortError) return "Request cancelled.";
  if (err instanceof Anthropic.AuthenticationError) {
    return "Claude rejected the API key. Check ANTHROPIC_API_KEY in .env.local, then restart.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude's rate limit was reached. Wait a moment and ask again.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`.trim();
  console.error(err);
  return err instanceof Error ? err.message : "Something went wrong.";
}

function assertAnswered(message: { stop_reason: string | null }): void {
  if (message.stop_reason === "refusal") {
    throw new AssistantError("The model declined to answer this question.");
  }
}
