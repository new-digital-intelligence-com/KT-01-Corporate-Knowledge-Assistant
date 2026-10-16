import type { BetaManagedAgentsCustomToolParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import {
  driveIdFrom,
  driveItem,
  listDriveFolder,
  listGroupMembers,
  readLive,
  searchDrive,
  searchGroups,
  searchPeople,
  type Found,
  type SearchResult,
} from "../live";
import { errorMessage } from "../text";

// Tools the Managed Agent calls that run here, in our code, as the company's Google account: the NDI shared drive
// and the Workspace directory. Google's own Drive connector can take over the Drive ones once we have its preview.

/** Parts of a file one read returns (about 1,200 characters each); the rest comes with `start`. */
const READ_PARTS = 40;

export const AGENT_TOOLS: BetaManagedAgentsCustomToolParams[] = [
  {
    type: "custom",
    name: "search_drive",
    description:
      "Search the NDI shared drive for files whose name or text contains ALL the given keywords; files whose name " +
      "matches come first. AI employee codes like 'GP-01' match exactly. Returns files with their id and link, not " +
      "their content: read the relevant ones with read_drive_file. If nothing matches, try fewer words or synonyms.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "1-3 keywords, e.g. 'architecture details'" },
        limit: { type: "integer", minimum: 1, maximum: 15, description: "Maximum files (default 8)" },
      },
      required: ["query"],
    },
  },
  {
    type: "custom",
    name: "read_drive_file",
    description:
      `Read a Drive file by its id or link: Docs, Sheets, Slides, PDF, Word, Excel and PowerPoint, ${READ_PARTS} parts at ` +
      "a time (the result says when more parts remain; ask for them with start). With a focus (an AI employee code or " +
      "words) you get only what concerns it: for a spreadsheet, the rows or column about it. A folder id lists the folder.",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", description: "The file or folder id, or its Google Drive / Docs link" },
        start: { type: "integer", minimum: 1, description: "The part to start from (default 1)" },
        focus: { type: "string", description: "Optional: an AI employee code or words, e.g. 'GP-01'" },
      },
      required: ["file"],
    },
  },
  {
    type: "custom",
    name: "search_people",
    description:
      "Look up people in the company's Google Workspace directory: name, email, title, department, manager, phone, " +
      "admin status and last sign-in. The query is a name, an email, or directory syntax such as \"orgDepartment='Sales'\"; " +
      "leave it empty for everyone. Always returns every match with the total.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "A name, an email, or directory search syntax" } },
    },
  },
  {
    type: "custom",
    name: "search_groups",
    description:
      "Find Google Workspace groups with their email, description and member count: search with directory syntax like " +
      "email:sales* (empty for all groups), or pass member_email for the groups one person belongs to.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Directory search syntax, e.g. email:sales*" },
        member_email: { type: "string", description: "A person's email, to list the groups they belong to" },
      },
    },
  },
  {
    type: "custom",
    name: "list_group_members",
    description: "List the members of a Google Workspace group, with each member's role: owner, manager or member.",
    input_schema: {
      type: "object",
      properties: { group_email: { type: "string", description: "The group's email address" } },
      required: ["group_email"],
    },
  },
];

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

/** A progress line for Chat while a tool runs. Never names a file or a search: others may read it. */
export function toolProgress(name: string): string {
  if (name === "search_drive") return "Searching the Drive…";
  if (name === "read_drive_file") return "Reading a file…";
  if (name.startsWith("fireflies")) return "Checking meetings…";
  return "Looking up the directory…";
}

export async function runAgentTool(name: string, input: unknown): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
  const count = (key: string, fallback: number, max: number) =>
    typeof args[key] === "number" ? Math.min(Math.max(Math.round(args[key] as number), 1), max) : fallback;

  try {
    switch (name) {
      case "search_drive": {
        const query = text("query");
        if (!query) return { text: "Give one to three keywords to search for.", isError: true };
        return { text: listing(`the NDI shared drive for “${query}”`, await searchDrive(query, count("limit", 8, 15))), isError: false };
      }
      case "read_drive_file":
        return { text: await readFile(text("file"), count("start", 1, 100_000), text("focus")), isError: false };
      case "search_people":
        return { text: listing("the directory", await searchPeople(text("query"))), isError: false };
      case "search_groups": {
        const member = text("member_email");
        return { text: listing("Workspace groups", await searchGroups(text("query"), member || undefined)), isError: false };
      }
      case "list_group_members": {
        const rows = await listGroupMembers(text("group_email"));
        return { text: rows.length ? rows.map((r) => r.text).join("\n\n") : `No members found for ${text("group_email")}.`, isError: false };
      }
    }
    return { text: `Unknown tool: ${name}`, isError: true };
  } catch (err) {
    return { text: `${name} failed: ${errorMessage(err)}`, isError: true };
  }
}

function listing(where: string, result: SearchResult): string {
  if (!result.found.length) return result.summary ?? `Nothing in ${where} matched. Try fewer or other words.`;
  const head =
    result.summary ??
    (result.complete ? `${result.total} result(s) in ${where}, all shown.` : `The first ${result.found.length} result(s) in ${where}; more match.`);
  return [head, result.note, ...result.found.map(entry)].filter(Boolean).join("\n\n");
}

function entry(f: Found): string {
  const id = f.docId.startsWith("drive:") ? `id ${f.docId.slice("drive:".length)}` : "";
  return [`${f.title}${id ? ` (${id})` : ""}${f.url ? ` ${f.url}` : ""}`, f.text].filter(Boolean).join("\n");
}

async function readFile(ref: string, start: number, focus: string): Promise<string> {
  const fileId = driveIdFrom(ref);
  if (!fileId) return "Give a Drive file or folder id, or its link.";
  const item = await driveItem(fileId);
  if (item.folder) return (await listDriveFolder(item)).map((part) => part.text).join("\n\n");

  const parts = await readLive({ ...item, folder: undefined } as Found, focus || undefined);
  const total = parts.length;
  const shown = parts.slice(start - 1, start - 1 + READ_PARTS);
  if (!shown.length) return total ? `This file has ${total} parts, so there is nothing from part ${start} on.` : "This file has no readable text.";
  const end = start - 1 + shown.length;
  const scope = start === 1 && end === total ? `The whole file, all ${total} part(s)` : `Parts ${start}-${end} of ${total}`;
  const more = end < total ? `\n\nMore parts remain: read_drive_file with start ${end + 1}${focus ? "" : ", or with a focus for one topic"}.` : "";
  return `“${item.title}” ${item.url ?? ""}\n${scope}:\n\n${shown.map((p) => p.text).join("\n\n")}${more}`;
}
