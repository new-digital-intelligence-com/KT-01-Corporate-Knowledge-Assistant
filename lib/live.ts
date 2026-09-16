import {
  google,
  type admin_directory_v1,
  type calendar_v3,
  type chat_v1,
  type drive_v3,
  type gmail_v1,
  type youtube_v3,
} from "googleapis";
import { env } from "./config";
import type { ChunkRow } from "./db";
import { codePattern, employeeCodes, keywords } from "./search";
import { READABLE_MIME_TYPES, fileText } from "./sources/drive";
import { pptxSlides, sheetRows, xlsxSheets, type SheetRow, type SheetTable } from "./sources/office";
import { bodyText, header, messageDate, stripQuoted } from "./sources/gmail";
import { GOOGLE_SCOPES, directoryNames, googleAuth, userAuthConfigured } from "./sources/google";
import { chunkText, clip, gmt, htmlToText } from "./text";

/**
 * Content found live in Google while answering one question. It has the same shape as an indexed
 * passage (minus the id), so citations and the fact check treat both the same way.
 */
export type Found = Omit<ChunkRow, "chunkId"> & {
  /** One line for a results list, when the title and date alone would mislead (a calendar event's start, not its last edit). */
  listLine?: string;
};

/** What a search returns: the passages to show, how many items matched, and whether all of them are shown. */
export interface SearchResult {
  found: Found[];
  total: number;
  /** True when every matching item is among the passages. */
  complete: boolean;
  /** Replaces the plain "N results" line, e.g. with a breakdown by status. */
  summary?: string;
  /** Told to the model with the results, e.g. that a looser match was used. */
  note?: string;
  /** The passages already are a complete list with its own heading, so no results list is added. */
  listed?: boolean;
  /** Where people can see the same results themselves, for the results list's citation. */
  listUrl?: string | null;
}

// Reads return every part of a document; read_result shows them a page at a time.
const MAX_READ_CHARS = 600_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** Items per passage in a long list. Lists are split, never cut. */
const LIST_LINES = 30;
/** Above this many people or groups, results come as a compact list instead of full records. */
const FULL_RECORDS_UP_TO = 25;

/** Live search reads as the person who signed in with `npm run google-login`. */
export function liveGoogleAvailable(): boolean {
  return userAuthConfigured();
}

let clients:
  | {
      drive: drive_v3.Drive;
      gmail: gmail_v1.Gmail;
      chat: chat_v1.Chat;
      admin: admin_directory_v1.Admin;
      youtube: youtube_v3.Youtube;
      calendar: calendar_v3.Calendar;
    }
  | undefined;

function g() {
  clients ??= {
    drive: google.drive({ version: "v3", auth: googleAuth(undefined, GOOGLE_SCOPES.drive) }),
    gmail: google.gmail({ version: "v1", auth: googleAuth(undefined, GOOGLE_SCOPES.gmail) }),
    chat: google.chat({ version: "v1", auth: googleAuth(undefined, GOOGLE_SCOPES.chat) }),
    admin: google.admin({ version: "directory_v1", auth: googleAuth(undefined, GOOGLE_SCOPES.directory) }),
    youtube: google.youtube({ version: "v3", auth: googleAuth(undefined, GOOGLE_SCOPES.youtube) }),
    calendar: google.calendar({ version: "v3", auth: googleAuth(undefined, GOOGLE_SCOPES.calendar) }),
  };
  return clients;
}

/** A long list as passages of LIST_LINES lines, each headed by the list's heading. Nothing is left out. */
function listPassages(base: Found, heading: string, lines: string[]): Found[] {
  if (!lines.length) return [{ ...base, text: heading }];
  const parts = Math.ceil(lines.length / LIST_LINES);
  return Array.from({ length: parts }, (_, i) => ({
    ...base,
    text: `${heading}${parts > 1 ? ` (part ${i + 1} of ${parts})` : ""}\n${lines.slice(i * LIST_LINES, (i + 1) * LIST_LINES).join("\n")}`,
  }));
}

/** The query without its AI employee codes, so "GP-01 architecture" leaves "architecture". */
function withoutCodes(query: string, codes: string[]): string {
  return codes.reduce((rest, code) => rest.replace(codePattern(code, "gi"), " "), query);
}

// ─── Google Drive ────────────────────────────────────────────────────────

const FILE_KINDS: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel workbook",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
};

/** Drive query values can't contain quotes or backslashes. */
function driveTerm(value: string): string {
  return value.replace(/['"\\]/g, "");
}

export async function searchDrive(query: string, limit: number): Promise<SearchResult> {
  // Codes stay whole: split into "gp" and "01" they would match nearly every file.
  const codes = employeeCodes(query);
  const words = keywords(withoutCodes(query, codes), 5).map(driveTerm).filter(Boolean);
  if (!codes.length && !words.length) return { found: [], total: 0, complete: true };

  const types = READABLE_MIME_TYPES.map((m) => `mimeType = '${m}'`).join(" or ");
  // GOOGLE_DRIVE_ID limits search to one shared drive; without it, everything the person can open.
  const driveId = env("GOOGLE_DRIVE_ID");
  const list = (terms: string[]) =>
    g().drive.files.list({
      q: `trashed = false and (${types}) and ${terms.join(" and ")}`,
      pageSize: limit,
      fields: "nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, webViewLink, lastModifyingUser(displayName))",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(driveId ? { corpora: "drive", driveId } : { corpora: "allDrives" }),
    });

  // A title is the strongest sign a file is the one asked for: names with the code and the words first, then
  // with the code alone, then with the words alone, then files whose content matches.
  const nameTerms = [[...codes, ...words], ...(codes.length && words.length ? [codes, words] : [])];
  const pages = await Promise.all([
    ...nameTerms.map((terms) => list(terms.map((term) => `name contains '${term}'`))),
    list([...codes.map((code) => `fullText contains '"${code}"'`), ...words.map((word) => `fullText contains '${word}'`)]),
  ]);

  const named = new Set(pages.slice(0, -1).flatMap((page) => (page.data.files ?? []).map((f) => f.id)));
  const seen = new Set<string>();
  const files = pages
    .flatMap((page) => page.data.files ?? [])
    .filter((f) => f.id && !seen.has(f.id) && Boolean(seen.add(f.id)));
  const found = files.slice(0, limit).map((f) => ({
    docId: `drive:${f.id}`,
    source: "drive" as const,
    title: f.name ?? "Untitled",
    url: f.webViewLink ?? null,
    container: "Google Drive",
    // Drive only says who edited a file last, not who wrote it.
    author: null,
    updatedAt: f.modifiedTime ?? "",
    text: [
      `File "${f.name}" (${FILE_KINDS[f.mimeType ?? ""] ?? f.mimeType ?? "file"}); its ${named.has(f.id) ? "name" : "content"} matches the search.`,
      f.modifiedTime && `Last edited${f.lastModifyingUser?.displayName ? ` by ${f.lastModifyingUser.displayName}` : ""} on ${gmt(f.modifiedTime)}.`,
      f.createdTime && `Created on ${gmt(f.createdTime)}.`,
      "Its content isn't shown here: open it with read_result.",
    ]
      .filter(Boolean)
      .join(" "),
  }));
  return {
    found,
    total: found.length,
    complete: files.length <= limit && pages.every((page) => !page.data.nextPageToken),
    listUrl: `https://drive.google.com/drive/search?q=${encodeURIComponent(query)}`,
  };
}

const FOLDER = "application/vnd.google-apps.folder";

/** A Drive file or folder id from an id or a link (docs.google.com/…/d/<id>, drive.google.com/…/folders/<id>, ?id=<id>). */
export function driveIdFrom(ref: string): string | null {
  const text = ref.trim();
  const fromLink = /\/(?:d|folders)\/([\w-]{20,})|[?&]id=([\w-]{20,})/.exec(text);
  if (fromLink) return fromLink[1] ?? fromLink[2];
  return /^[\w-]{20,}$/.test(text) ? text : null;
}

/** A Drive file or folder by id, as a result that can be read like a search result. */
export async function driveItem(fileId: string): Promise<Found & { folder: boolean }> {
  const f = (
    await g().drive.files.get({
      fileId,
      supportsAllDrives: true,
      fields: "id, name, mimeType, createdTime, modifiedTime, webViewLink, lastModifyingUser(displayName)",
    })
  ).data;
  const folder = f.mimeType === FOLDER;
  return {
    docId: `drive:${fileId}`,
    source: "drive",
    title: f.name ?? fileId,
    url: f.webViewLink ?? null,
    container: "Google Drive",
    author: null,
    updatedAt: f.modifiedTime ?? "",
    folder,
    text: [
      `${folder ? "Folder" : "File"} "${f.name}"${folder ? "" : ` (${FILE_KINDS[f.mimeType ?? ""] ?? f.mimeType ?? "file"})`}.`,
      f.modifiedTime && `Last edited${f.lastModifyingUser?.displayName ? ` by ${f.lastModifyingUser.displayName}` : ""} on ${gmt(f.modifiedTime)}.`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** What a folder holds: subfolders first, then files, newest first. */
export async function listDriveFolder(folder: Found): Promise<Found[]> {
  const folderId = folder.docId.slice("drive:".length);
  const items: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const res = await g().drive.files.list({
      q: `'${driveTerm(folderId)}' in parents and trashed = false`,
      orderBy: "folder,modifiedTime desc",
      pageSize: 500,
      pageToken,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, lastModifyingUser(displayName))",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    items.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && items.length < 2000);

  const lines = items.map((f) =>
    f.mimeType === FOLDER
      ? `- folder "${f.name}" (id ${f.id})`
      : `- "${f.name}" (${FILE_KINDS[f.mimeType ?? ""] ?? f.mimeType}; edited ${f.modifiedTime?.slice(0, 10)}${f.lastModifyingUser?.displayName ? ` by ${f.lastModifyingUser.displayName}` : ""}; id ${f.id})`,
  );
  const folders = items.filter((f) => f.mimeType === FOLDER).length;
  return pieces(
    { ...folder, docId: `drive-folder:${folderId}` },
    `Folder "${folder.title}" holds ${folders} folder(s) and ${items.length - folders} file(s)${pageToken ? " (the first 2000 items)" : ", all listed"}. Open one with open_drive_file and its id.\n${lines.join("\n")}`,
  );
}

/** A Drive file's bytes, exported to `exportAs` for Google files. */
async function driveBytes(fileId: string, exportAs?: string): Promise<Uint8Array> {
  const res = exportAs
    ? await g().drive.files.export({ fileId, mimeType: exportAs }, { responseType: "arraybuffer" })
    : await g().drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
  return new Uint8Array(res.data as unknown as ArrayBuffer);
}

/** A Drive file in parts. With a focus, only what concerns it: a spreadsheet column or rows, or the matching passages. */
async function readDrive(item: Found, focus?: string): Promise<Found[]> {
  const fileId = item.docId.slice("drive:".length);
  const meta = await g().drive.files.get({ fileId, fields: "mimeType, size", supportsAllDrives: true });
  if (Number(meta.data.size ?? 0) > MAX_FILE_BYTES) throw new Error("the file is larger than 20 MB");
  const mimeType = meta.data.mimeType;
  if (!mimeType || !READABLE_MIME_TYPES.includes(mimeType)) throw new Error("this file type can't be read");

  if (focus && (mimeType === GOOGLE_SHEET || mimeType === XLSX)) {
    const tables = await xlsxSheets(await driveBytes(fileId, mimeType === GOOGLE_SHEET ? XLSX : undefined));
    return pieces(item, focusedSheetText(tables, focus));
  }
  const all = pieces(item, await fileText(g().drive, fileId, mimeType));
  if (!focus) return all;
  const { matches } = matchTexts(all.map((part) => part.text), focus);
  const chosen = matches.sort((a, b) => a.index - b.index).map((m) => all[m.index]);
  const heading = `${chosen.length} of the file's ${all.length} parts mention “${focus}”${chosen.length ? ":" : "."}`;
  return chosen.length ? chosen.map((part, i) => (i ? part : { ...part, text: `${heading}\n\n${part.text}` })) : [{ ...item, text: heading }];
}

/**
 * What a spreadsheet says about a term, such as an AI employee code. When the term heads a column (a sheet
 * with one column per AI employee), that column as "row label: value" lines; otherwise the rows containing it.
 */
function focusedSheetText(tables: SheetTable[], focus: string): string {
  const codes = employeeCodes(focus);
  const words = keywords(focus);
  const mentions = (value: string) => {
    const lower = value.normalize("NFKC").toLowerCase();
    if (codes.length) return codes.some((code) => codePattern(code).test(lower));
    return words.length ? words.every((w) => lower.includes(w)) : lower.includes(focus.trim().toLowerCase());
  };

  const parts: string[] = [];
  for (const table of tables) {
    const top = table.rows.slice(0, 5);
    const columns = [...new Set(top.flatMap((row) => row.flatMap((value, col) => (value && mentions(value) ? [col] : []))))];
    if (columns.length && columns.length <= 5) {
      for (const col of columns) {
        const heading = top.map((row) => row[col]).filter(Boolean).join(" / ");
        const lines = table.rows.flatMap((row, r) => {
          const value = row[col];
          if (!value) return [];
          // Label columns sometimes hold "NA" or a link next to the name: keep only the names.
          const names = row.slice(0, Math.min(col, 2)).filter((cell) => cell && cell !== "NA" && !/^https?:\/\//.test(cell));
          const label = names.join(" / ") || `Row ${r + 1}`;
          return [`${label}: ${value}`];
        });
        parts.push(`Sheet "${table.name}", the column headed "${heading}": one line per row, as row label: value.\n${lines.join("\n")}`);
      }
      continue;
    }
    const rows = sheetRows(table).filter((row) => mentions(row.text));
    if (rows.length) parts.push(`Sheet "${table.name}": ${rows.length} row(s) mention “${focus}”.\n${rows.map((row) => row.text).join("\n")}`);
  }
  return parts.join("\n\n") || `Nothing in this spreadsheet mentions “${focus}”.`;
}

// ─── Gmail ───────────────────────────────────────────────────────────────

let mailbox: Promise<string> | undefined;

function myMailbox(): Promise<string> {
  mailbox ??= g()
    .gmail.users.getProfile({ userId: "me" })
    .then((res) => res.data.emailAddress ?? "me")
    .catch((err) => {
      mailbox = undefined;
      throw err;
    });
  return mailbox;
}

/** The signed-in account whose Gmail, Chat and Calendar the tools read, when it can be told. */
export function signedInAccount(): Promise<string | undefined> {
  return liveGoogleAvailable() ? myMailbox().catch(() => undefined) : Promise.resolve(undefined);
}

export async function searchGmail(query: string, limit: number): Promise<SearchResult> {
  if (!query.trim()) return { found: [], total: 0, complete: true };
  const [res, address] = await Promise.all([
    g().gmail.users.threads.list({ userId: "me", q: `${query} -in:spam -in:trash`, maxResults: limit }),
    myMailbox(),
  ]);

  const found = await Promise.all(
    (res.data.threads ?? [])
      .filter((t) => t.id)
      .map(async (t) => {
        const thread = await g().gmail.users.threads.get({
          userId: "me",
          id: t.id!,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        });
        const messages = thread.data.messages ?? [];
        const first = messages[0];
        const last = messages.at(-1);
        const latest = last ? messageDate(last) : "";
        return {
          docId: `gmail:${t.id}`,
          source: "gmail" as const,
          title: (first && header(first, "Subject")) || "(no subject)",
          url: `https://mail.google.com/mail/u/${address}/#all/${t.id}`,
          container: address,
          author: (first && header(first, "From")) || null,
          updatedAt: latest,
          text:
            `${messages.length} message(s). Latest message sent ${gmt(latest)}, from ${last ? header(last, "From") : "unknown"}: ` +
            htmlToText(last?.snippet ?? t.snippet ?? ""),
        };
      }),
  );
  return {
    found,
    total: found.length,
    complete: !res.data.nextPageToken,
    listUrl: `https://mail.google.com/mail/u/${address}/#search/${encodeURIComponent(query)}`,
  };
}

async function readGmail(item: Found): Promise<Found[]> {
  const id = item.docId.slice("gmail:".length);
  const thread = await g().gmail.users.threads.get({ userId: "me", id, format: "full" });
  const text = (thread.data.messages ?? [])
    .map((m) => {
      const cc = header(m, "Cc");
      return (
        `[${gmt(messageDate(m))}] From: ${header(m, "From")}\n` +
        `To: ${header(m, "To")}${cc ? `\nCc: ${cc}` : ""}\n` +
        stripQuoted(bodyText(m.payload))
      );
    })
    .join("\n\n");
  return pieces(item, text);
}

// ─── Google Chat ─────────────────────────────────────────────────────────

let resolveName: ReturnType<typeof directoryNames> | undefined;
const spaces = new Map<string, Promise<chat_v1.Schema$Space>>();

/** A person's name from a Chat user resource ("users/123") or an email. */
function nameOf(user: string | null | undefined): Promise<string> {
  resolveName ??= directoryNames();
  return resolveName(user);
}

function spaceInfo(name: string): Promise<chat_v1.Schema$Space> {
  let space = spaces.get(name);
  if (!space) {
    space = g()
      .chat.spaces.get({ name })
      .then((res) => res.data)
      .catch(() => ({ name }));
    spaces.set(name, space);
  }
  return space;
}

function messageText(m: chat_v1.Schema$Message): string {
  return m.text || m.formattedText || m.fallbackText || "";
}

async function messageLine(m: chat_v1.Schema$Message): Promise<string> {
  const who = m.sender?.displayName || (await nameOf(m.sender?.name));
  return `[${gmt(m.createTime)}] ${who}: ${messageText(m)}`;
}

function chatUrl(space: string, thread: string | null | undefined): string {
  const spaceId = space.replace(/^spaces\//, "");
  const threadId = thread?.split("/threads/")[1];
  return `https://chat.google.com/room/${spaceId}${threadId ? `/${threadId}` : ""}`;
}

/** Messages in named spaces the person belongs to. Direct messages and group chats are left out. */
export async function searchChat(query: string, limit: number): Promise<SearchResult> {
  const words = keywords(query, 8);
  if (!words.length) return { found: [], total: 0, complete: true };
  const res = await g().chat.spaces.messages.search({
    parent: "spaces/-",
    requestBody: { filter: words.join(" "), pageSize: Math.min(limit * 3, 50) },
  });

  const found: Found[] = [];
  const threads: (string | undefined)[] = [];
  let more = Boolean(res.data.nextPageToken);
  for (const result of res.data.results ?? []) {
    const m = result.message;
    if (!m?.name || !messageText(m)) continue;
    if (found.length >= limit) {
      more = true;
      break;
    }
    const spaceName = m.space?.name ?? m.name.split("/messages/")[0];
    const space = await spaceInfo(spaceName);
    if (space.spaceType && space.spaceType !== "SPACE") continue;
    const label = space.displayName || spaceName;
    found.push({
      docId: `gchat:${m.thread?.name ?? m.name}`,
      source: "gchat",
      title: `${label}: ${clip(messageText(m), 70)}`,
      url: chatUrl(spaceName, m.thread?.name),
      container: label,
      author: m.sender?.displayName || (await nameOf(m.sender?.name)),
      updatedAt: m.lastUpdateTime ?? m.createTime ?? "",
      text: await messageLine(m),
    });
    threads.push(m.thread?.name ?? undefined);
  }

  // The best hits come with their whole thread, so replies to the matching message aren't missed.
  await Promise.all(
    found.slice(0, 3).map(async (hit, i) => {
      const thread = threads[i];
      const text = thread ? await threadMessages(thread, 40).catch(() => "") : "";
      if (text.includes("\n")) found[i] = { ...hit, text: `Matching message: ${hit.text}\n\nWhole thread, oldest first:\n${text}` };
    }),
  );
  return { found, total: found.length, complete: !more };
}

async function readChat(item: Found): Promise<Found[]> {
  const ref = item.docId.slice("gchat:".length);
  if (!ref.includes("/threads/")) {
    const message = (await g().chat.spaces.messages.get({ name: ref })).data;
    return pieces(item, await messageLine(message));
  }
  const parent = ref.split("/threads/")[0];
  const messages: chat_v1.Schema$Message[] = [];
  let pageToken: string | undefined;
  do {
    const res = await g().chat.spaces.messages.list({ parent, filter: `thread.name = ${ref}`, pageSize: 200, pageToken });
    messages.push(...(res.data.messages ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && messages.length < 400);
  const lines = await Promise.all(messages.filter((m) => messageText(m)).map(messageLine));
  return pieces(item, lines.join("\n"));
}

/** The latest messages of one thread as "[date] name: text" lines, oldest first. */
export async function threadMessages(thread: string, limit = 30): Promise<string> {
  const parent = thread.split("/threads/")[0];
  const messages: chat_v1.Schema$Message[] = [];
  let pageToken: string | undefined;
  do {
    const res = await g().chat.spaces.messages.list({ parent, filter: `thread.name = ${thread}`, pageSize: 200, pageToken });
    messages.push(...(res.data.messages ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && messages.length < 1000);
  const lines = await Promise.all(messages.filter((m) => messageText(m)).slice(-limit).map(messageLine));
  return lines.join("\n");
}

let spaceList: { at: number; spaces: Promise<chat_v1.Schema$Space[]> } | undefined;

/** The named spaces the signed-in person is in, fetched again every 10 minutes. */
function namedSpaces(): Promise<chat_v1.Schema$Space[]> {
  if (!spaceList || Date.now() - spaceList.at > 10 * 60_000) {
    const loading = (async () => {
      const all: chat_v1.Schema$Space[] = [];
      let pageToken: string | undefined;
      do {
        const res = await g().chat.spaces.list({ pageSize: 1000, pageToken, filter: 'spaceType = "SPACE"' });
        all.push(...(res.data.spaces ?? []));
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken && all.length < 5000);
      return all;
    })();
    loading.catch(() => {
      spaceList = undefined;
    });
    spaceList = { at: Date.now(), spaces: loading };
  }
  return spaceList.spaces;
}

/** A space by its resource name ("spaces/AAAA") or its display name, among the spaces the signed-in person is in. */
export async function findSpace(ref: string): Promise<{ name: string; displayName: string } | { error: string }> {
  const wanted = ref.trim();
  if (/^spaces\/[\w-]+$/.test(wanted)) {
    return { name: wanted, displayName: (await spaceInfo(wanted)).displayName || wanted };
  }
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const target = normalize(wanted);
  const words = keywords(wanted);
  const named = (await namedSpaces()).filter((s) => s.name && s.displayName);
  const exact = named.find((s) => normalize(s.displayName!) === target);
  let partial = named.filter((s) => normalize(s.displayName!).includes(target));
  if (!partial.length && words.length) partial = named.filter((s) => words.every((w) => normalize(s.displayName!).includes(w)));
  const match = exact ?? (partial.length === 1 ? partial[0] : undefined);
  if (match) return { name: match.name!, displayName: match.displayName! };
  if (partial.length) {
    return { error: `Several spaces match “${wanted}”: ${partial.slice(0, 15).map((s) => s.displayName).join("; ")}. Ask again with the exact name.` };
  }
  return { error: `None of the ${named.length} spaces the signed-in account is in is called “${wanted}”.` };
}

/** A space's messages from the last `days` days (the newest `limit`), read as the signed-in person, oldest first. */
export async function readSpaceMessages(space: string, label?: string, days = 14, limit = 150): Promise<Found[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const messages: chat_v1.Schema$Message[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const res = await g().chat.spaces.messages.list({ parent: space, filter: `createTime > "${since}"`, pageSize: 1000, pageToken });
    messages.push(...(res.data.messages ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ++pages < 3);

  const withText = messages.filter((m) => messageText(m));
  const recent = withText.slice(-limit);
  if (!recent.length) return [];
  const name = label || (await spaceInfo(space)).displayName || space;
  const lines = await Promise.all(recent.map(messageLine));
  const scope =
    withText.length > recent.length || pageToken
      ? `the latest ${recent.length} messages of the last ${days} days`
      : `all ${recent.length} messages of the last ${days} days`;
  return pieces(
    {
      docId: `gspace:${space}`,
      source: "gchat",
      title: `${name}: recent messages`,
      url: chatUrl(space, null),
      container: name,
      author: null,
      updatedAt: recent.at(-1)?.createTime ?? "",
      text: "",
    },
    `${name}: ${scope}, from ${gmt(recent[0].createTime)} to ${gmt(recent.at(-1)?.createTime)}, oldest first:\n${lines.join("\n")}`,
  );
}

// ─── Google Workspace directory (read-only) ──────────────────────────────

type ViewType = "admin_view" | "domain_public";
// Admins see full profiles; everyone else only the public ones. Remember which one this sign-in gets.
let userView: ViewType | undefined;

function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e.response?.status ?? e.status;
}

/** Everyone matching a name, an email or directory search syntax (up to 1000 people). */
export async function searchPeople(query: string): Promise<SearchResult> {
  const q = query.trim();
  const list = (viewType: ViewType, pageToken: string | undefined) =>
    g().admin.users.list({ customer: "my_customer", viewType, projection: "full", maxResults: 500, pageToken, ...(q ? { query: q } : {}) });

  const users: admin_directory_v1.Schema$User[] = [];
  let pageToken: string | undefined;
  do {
    let res: Awaited<ReturnType<typeof list>> | undefined;
    if (userView !== "domain_public") {
      try {
        res = await list("admin_view", pageToken);
        userView = "admin_view";
      } catch (err) {
        if (httpStatus(err) !== 403) throw err;
        userView = "domain_public";
      }
    }
    res ??= await list("domain_public", pageToken);
    users.push(...(res.data.users ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && users.length < 1000);

  const matched = q ? `match “${q}”` : "are in the directory";
  const suspended = users.filter((u) => u.suspended).length;
  const breakdown = userView === "admin_view" ? `: ${users.length - suspended} active, ${suspended} suspended` : "";
  const summary = `${users.length} account(s) ${matched}${breakdown}${pageToken ? ". Only the first 1000 were read." : ". All are listed."}`;

  if (users.length <= FULL_RECORDS_UP_TO) {
    return { found: users.map(personFound), total: users.length, complete: !pageToken, summary, listUrl: "https://admin.google.com/ac/users" };
  }
  const lines = users.map((u) => {
    const org = primaryOrg(u);
    const lastLogin = signInDate(u);
    return [
      `- ${u.name?.fullName ?? ""} <${u.primaryEmail ?? ""}>`,
      org?.title,
      org?.department,
      u.suspended ? "suspended" : null,
      u.isAdmin ? "super admin" : u.isDelegatedAdmin ? "delegated admin" : null,
      lastLogin && `last sign-in ${lastLogin}`,
    ]
      .filter(Boolean)
      .join(" | ");
  });
  const base: Found = {
    docId: `directory:users:${q}`,
    source: "directory",
    title: `Workspace users: ${q || "everyone"}`,
    url: "https://admin.google.com/ac/users",
    container: "Workspace users",
    author: null,
    updatedAt: "",
    text: "",
  };
  return {
    found: listPassages(base, `${summary} Ask about one person for their full record.`, lines),
    total: users.length,
    complete: !pageToken,
    summary,
    listed: true,
  };
}

function primaryOrg(u: admin_directory_v1.Schema$User) {
  const orgs = (u.organizations ?? []) as { title?: string; department?: string; primary?: boolean }[];
  return orgs.find((o) => o.primary) ?? orgs[0];
}

function signInDate(u: admin_directory_v1.Schema$User): string | undefined {
  return u.lastLoginTime?.startsWith("1970") ? "never" : u.lastLoginTime ? gmt(u.lastLoginTime) : undefined;
}

function personFound(u: admin_directory_v1.Schema$User): Found {
  const org = primaryOrg(u);
  const manager = ((u.relations ?? []) as { type?: string; value?: string }[]).find((r) => r.type === "manager")?.value;
  const phone = ((u.phones ?? []) as { value?: string }[]).find((p) => p.value)?.value;
  const lastLogin = signInDate(u);
  const lines = [
    `Name: ${u.name?.fullName ?? ""}`,
    `Email: ${u.primaryEmail ?? ""}`,
    `Title: ${org?.title || "not set in the directory"}`,
    org?.department && `Department: ${org.department}`,
    `Manager: ${manager || "not set in the directory"}`,
    phone && `Phone: ${phone}`,
    u.orgUnitPath && `Organizational unit: ${u.orgUnitPath}`,
    u.aliases?.length && `Aliases: ${u.aliases.join(", ")}`,
    typeof u.isAdmin === "boolean" && `Super admin: ${u.isAdmin ? "yes" : "no"}`,
    typeof u.isDelegatedAdmin === "boolean" && `Delegated admin (has an Admin console role): ${u.isDelegatedAdmin ? "yes" : "no"}`,
    typeof u.suspended === "boolean" && `Suspended: ${u.suspended ? "yes" : "no"}`,
    lastLogin && `Last sign-in: ${lastLogin}`,
    u.creationTime && `Account created: ${gmt(u.creationTime)}`,
    (!org?.title || !manager) && "The directory doesn't record everything: a CV, profile or org chart in Drive may.",
  ].filter(Boolean);
  return {
    docId: `directory:user:${u.id}`,
    source: "directory",
    title: `${u.name?.fullName || u.primaryEmail} (${u.primaryEmail})`,
    url: u.id ? `https://admin.google.com/ac/users/${u.id}` : null,
    container: "Workspace users",
    author: null,
    updatedAt: "",
    text: lines.join("\n"),
  };
}

let adminRolesDenied = false;

/** False once Google has refused to show admin roles to the signed-in account, so the tool isn't offered again. */
export function adminRolesReadable(): boolean {
  return liveGoogleAvailable() && !adminRolesDenied;
}

/** Admin console role assignments, for everyone or one person. Needs an admin role that can view roles. */
export async function listAdminRoles(userEmail?: string): Promise<Found[]> {
  const [roles, assignments] = await Promise.all([
    g().admin.roles.list({ customer: "my_customer", maxResults: 100 }),
    g().admin.roleAssignments.list({ customer: "my_customer", maxResults: 200, ...(userEmail ? { userKey: userEmail } : {}) }),
  ]).catch((err) => {
    if (httpStatus(err) === 403) adminRolesDenied = true;
    throw err;
  });
  const roleName = new Map((roles.data.items ?? []).map((role) => [String(role.roleId), role.roleName ?? String(role.roleId)]));
  const items = assignments.data.items ?? [];
  const lines = await Promise.all(
    items.map(async (a) => {
      const who = a.assignedTo ? await nameOf(`users/${a.assignedTo}`) : "unknown";
      const where = a.scopeType === "ORG_UNIT" ? ` (organizational unit ${a.orgUnitId})` : "";
      return `- ${who}: ${roleName.get(String(a.roleId)) ?? a.roleId}${where}`;
    }),
  );
  return pieces(
    {
      docId: `directory:roles:${userEmail ?? "all"}`,
      source: "directory",
      title: userEmail ? `Admin roles of ${userEmail}` : "Admin role assignments",
      url: "https://admin.google.com/ac/roles",
      container: "Workspace admin roles",
      author: null,
      updatedAt: "",
      text: "",
    },
    items.length
      ? `${items.length} admin role assignment(s)${userEmail ? ` for ${userEmail}` : ""}:\n${lines.join("\n")}`
      : `No admin role assignments${userEmail ? ` for ${userEmail}` : ""}.`,
  );
}

function groupUrl(email: string | null | undefined): string | null {
  const [local, domain] = (email ?? "").split("@");
  return local && domain ? `https://groups.google.com/a/${domain}/g/${local}` : null;
}

/** Every group matching a directory query, or every group a person belongs to (up to 1000). */
export async function searchGroups(query: string, memberEmail?: string): Promise<SearchResult> {
  const q = query.trim();
  const groups: admin_directory_v1.Schema$Group[] = [];
  let pageToken: string | undefined;
  do {
    const res = await g().admin.groups.list(
      memberEmail
        ? { userKey: memberEmail, maxResults: 200, pageToken }
        : { customer: "my_customer", maxResults: 200, pageToken, ...(q ? { query: q } : {}) },
    );
    groups.push(...(res.data.groups ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && groups.length < 1000);

  const which = memberEmail ? `that ${memberEmail} belongs to` : q ? `match “${q}”` : "are in the directory";
  const summary = `${groups.length} group(s) ${which}${pageToken ? ". Only the first 1000 were read." : ". All are listed."}`;
  const found = groups.map((group) => ({
    docId: `directory:group:${group.id}`,
    source: "directory" as const,
    title: `${group.name || group.email} (${group.email})`,
    url: groupUrl(group.email),
    container: "Workspace groups",
    author: null,
    updatedAt: "",
    text: [
      `Group: ${group.name ?? ""}`,
      `Email: ${group.email ?? ""}`,
      group.description && `Description: ${group.description}`,
      group.directMembersCount && `Direct members: ${group.directMembersCount}`,
      group.aliases?.length && `Aliases: ${group.aliases.join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n"),
  }));
  if (groups.length <= FULL_RECORDS_UP_TO) {
    return { found, total: groups.length, complete: !pageToken, summary, listUrl: "https://admin.google.com/ac/groups" };
  }

  const lines = groups.map((group) =>
    [`- ${group.name ?? ""} <${group.email ?? ""}>`, group.directMembersCount && `${group.directMembersCount} direct members`, group.description && clip(group.description, 100)]
      .filter(Boolean)
      .join(" | "),
  );
  const base: Found = {
    docId: `directory:groups:${memberEmail ?? q}`,
    source: "directory",
    title: memberEmail ? `Groups of ${memberEmail}` : `Workspace groups: ${q || "all"}`,
    url: "https://admin.google.com/ac/groups",
    container: "Workspace groups",
    author: null,
    updatedAt: "",
    text: "",
  };
  return { found: listPassages(base, summary, lines), total: groups.length, complete: !pageToken, summary, listed: true };
}

/** Everyone in a group, with their role. */
export async function listGroupMembers(groupEmail: string): Promise<Found[]> {
  if (!groupEmail.trim()) return [];
  const members: admin_directory_v1.Schema$Member[] = [];
  let pageToken: string | undefined;
  do {
    const res = await g().admin.members.list({ groupKey: groupEmail.trim(), maxResults: 200, pageToken });
    members.push(...(res.data.members ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && members.length < 1000);

  const lines = members.map((m) => {
    const details = [(m.role ?? "MEMBER").toLowerCase(), m.type && m.type !== "USER" ? m.type.toLowerCase() : null, m.status && m.status !== "ACTIVE" ? m.status.toLowerCase() : null];
    return `- ${m.email ?? m.id} (${details.filter(Boolean).join(", ")})`;
  });
  return pieces(
    {
      docId: `directory:members:${groupEmail}`,
      source: "directory",
      title: `Members of ${groupEmail}`,
      url: groupUrl(groupEmail),
      container: "Workspace groups",
      author: null,
      updatedAt: "",
      text: "",
    },
    `${members.length} member(s) of ${groupEmail}, all listed:\n${lines.join("\n")}`,
  );
}

// ─── YouTube channel (read-only) ─────────────────────────────────────────

// Listing uploads and reading video details cost 1 quota unit per page of 50, where YouTube's own
// search costs 100, so the channel's videos are fetched once in a while and matched here.
const UPLOADS_TO_SCAN = 500;
const UPLOADS_FRESH_MS = 10 * 60_000;

let channel: Promise<{ id: string; title: string; uploads: string }> | undefined;
let videosCache: { at: number; videos: youtube_v3.Schema$Video[]; allUploads: boolean } | undefined;

export type VideoSort = "relevance" | "date" | "views";

export function youtubeConfigured(): boolean {
  return liveGoogleAvailable() && Boolean(env("YOUTUBE_CHANNEL"));
}

function youtubeChannel() {
  channel ??= (async () => {
    const ref = env("YOUTUBE_CHANNEL") ?? "";
    const res = await g().youtube.channels.list({
      part: ["snippet", "contentDetails"],
      ...(/^UC[\w-]{20,}$/.test(ref) ? { id: [ref] } : { forHandle: ref.startsWith("@") ? ref : `@${ref}` }),
    });
    const found = res.data.items?.[0];
    const uploads = found?.contentDetails?.relatedPlaylists?.uploads;
    if (!found?.id || !uploads) throw new Error(`the YouTube channel ${ref} wasn't found`);
    return { id: found.id, title: found.snippet?.title ?? ref, uploads };
  })().catch((err) => {
    channel = undefined;
    throw err;
  });
  return channel;
}

/** The channel's uploads with their details and statistics, newest first. */
async function channelVideos(): Promise<{ videos: youtube_v3.Schema$Video[]; allUploads: boolean }> {
  if (videosCache && Date.now() - videosCache.at < UPLOADS_FRESH_MS) return videosCache;
  const { uploads } = await youtubeChannel();
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await g().youtube.playlistItems.list({ part: ["contentDetails"], playlistId: uploads, maxResults: 50, pageToken });
    ids.push(...(res.data.items ?? []).flatMap((item) => (item.contentDetails?.videoId ? [item.contentDetails.videoId] : [])));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < UPLOADS_TO_SCAN);

  const batches = Array.from({ length: Math.ceil(ids.length / 50) }, (_, i) => ids.slice(i * 50, (i + 1) * 50));
  const details = await Promise.all(
    batches.map((batch) =>
      g().youtube.videos.list({ part: ["snippet", "statistics", "contentDetails", "status"], id: batch, maxResults: 50 }),
    ),
  );
  const byId = new Map(details.flatMap((res) => res.data.items ?? []).map((video) => [video.id, video]));
  const videos = ids
    .flatMap((id) => byId.get(id) ?? [])
    .sort((a, b) => (b.snippet?.publishedAt ?? "").localeCompare(a.snippet?.publishedAt ?? ""));
  videosCache = { at: Date.now(), videos, allUploads: !pageToken };
  return videosCache;
}

/**
 * Channel videos matching the query (codes like "GP-14" exactly, otherwise all keywords, then any),
 * or all videos without one. The best `limit` come in full; when more match, a compact list of all follows.
 */
export async function searchYouTube(query: string, limit: number, sort?: VideoSort): Promise<SearchResult> {
  const [{ videos, allUploads }, { id: channelId, title: channelTitle }] = await Promise.all([channelVideos(), youtubeChannel()]);
  const q = query.trim();
  const codes = employeeCodes(q);
  const words = keywords(withoutCodes(q, codes), 6);

  let note: string | undefined;
  let matches = videos.map((video) => {
    const text = [video.snippet?.title, video.snippet?.description, ...(video.snippet?.tags ?? [])].join("\n").normalize("NFKC").toLowerCase();
    return { video, codes: codes.filter((code) => codePattern(code).test(text)).length, words: words.filter((w) => text.includes(w)).length };
  });
  if (codes.length) {
    matches = matches.filter((m) => m.codes > 0);
  } else if (words.length) {
    const every = matches.filter((m) => m.words === words.length);
    const some = matches.filter((m) => m.words > 0);
    if (!every.length && some.length) note = `No video contains all of “${words.join(" ")}”; these contain some of the words.`;
    matches = every.length ? every : some;
  }

  const order: VideoSort = sort ?? (q ? "relevance" : "date");
  const views = (v: youtube_v3.Schema$Video) => Number(v.statistics?.viewCount ?? 0);
  const published = (v: youtube_v3.Schema$Video) => v.snippet?.publishedAt ?? "";
  matches.sort((a, b) =>
    order === "views"
      ? views(b.video) - views(a.video)
      : order === "date"
        ? published(b.video).localeCompare(published(a.video))
        : b.codes - a.codes || b.words - a.words || published(b.video).localeCompare(published(a.video)),
  );

  const sortedBy = order === "views" ? "most views first" : order === "date" ? "newest first" : "best match first";
  const scanned = allUploads ? `all ${videos.length} uploads` : `the latest ${videos.length} uploads`;
  const summary = `${matches.length} video(s) ${q ? `match “${q}”` : "on the channel"} (${scanned} of ${channelTitle} checked), ${sortedBy}.`;
  const shown = matches.slice(0, limit).map((m) => videoFound(m.video, channelTitle));
  const listUrl = `https://www.youtube.com/channel/${channelId}/videos`;
  if (matches.length <= shown.length) return { found: shown, total: matches.length, complete: true, summary, note, listUrl };

  const lines = matches.map((m, i) => {
    const v = m.video;
    return `${i + 1}. ${v.snippet?.title ?? ""} | published ${gmt(v.snippet?.publishedAt)} | ${views(v)} views | ${v.status?.privacyStatus ?? "?"} | https://youtu.be/${v.id}`;
  });
  const base: Found = {
    docId: `youtube:list:${q}:${order}`,
    source: "youtube",
    title: `${channelTitle}: ${q ? `videos matching “${q}”` : "all videos"}`,
    url: `https://www.youtube.com/channel/${channelId}/videos`,
    container: channelTitle,
    author: null,
    updatedAt: "",
    text: "",
  };
  return {
    found: [...listPassages(base, `${summary} All ${matches.length} are listed:`, lines), ...shown],
    total: matches.length,
    complete: true,
    summary,
    note,
    listed: true,
  };
}

function videoFound(video: youtube_v3.Schema$Video, channelTitle: string): Found {
  const snippet = video.snippet ?? {};
  const stats = video.statistics ?? {};
  const lines = [
    `Title: ${snippet.title ?? ""}`,
    `Link: https://youtu.be/${video.id} (video id ${video.id})`,
    `Published: ${gmt(snippet.publishedAt)}`,
    video.contentDetails?.duration && `Duration: ${readableDuration(video.contentDetails.duration)}`,
    video.status?.privacyStatus && `Visibility: ${video.status.privacyStatus}`,
    `Views: ${stats.viewCount ?? "not shown"}`,
    stats.likeCount && `Likes: ${stats.likeCount}`,
    stats.commentCount && `Comments: ${stats.commentCount}`,
    snippet.tags?.length && `Tags: ${snippet.tags.slice(0, 15).join(", ")}`,
    `Description:\n${snippet.description ?? ""}`,
  ].filter(Boolean);
  return {
    docId: `youtube:${video.id}`,
    source: "youtube",
    title: snippet.title ?? video.id ?? "Video",
    url: video.id ? `https://www.youtube.com/watch?v=${video.id}` : null,
    container: channelTitle,
    author: snippet.channelTitle ?? null,
    updatedAt: snippet.publishedAt ?? "",
    text: lines.join("\n"),
  };
}

/** "PT1H2M3S" → "1:02:03" */
function readableDuration(iso: string): string {
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!match) return iso;
  const [hours, minutes, seconds] = [match[1], match[2], match[3]].map((part) => Number(part ?? 0));
  const mmss = `${String(minutes).padStart(hours ? 2 : 1, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours ? `${hours}:${mmss}` : mmss;
}

// ─── Google Calendar (read-only) ─────────────────────────────────────────

const TWO_WEEKS_MS = 14 * 86_400_000;

/** "2026-09-20" → the start or end of that day; anything else is passed through as given. */
function moment(value: string | undefined, fallback: Date, endOfDay = false): string {
  if (!value?.trim()) return fallback.toISOString();
  const day = /^\d{4}-\d{2}-\d{2}$/.exec(value.trim());
  if (day) return `${value.trim()}T${endOfDay ? "23:59:59" : "00:00:00"}Z`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

let timeZone: Promise<string> | undefined;

/**
 * The time zone every calendar time is shown in: GMT by default, any zone name through
 * CALENDAR_TIME_ZONE, or "auto" for the signed-in person's own calendar zone.
 */
function displayTimeZone(): Promise<string> {
  const configured = (env("CALENDAR_TIME_ZONE") ?? "GMT").trim();
  if (configured.toLowerCase() !== "auto") return Promise.resolve(configured);
  timeZone ??= g()
    .calendar.calendars.get({ calendarId: "primary" })
    .then((res) => res.data.timeZone ?? "GMT")
    .catch(() => "GMT");
  return timeZone;
}

function zoneLabel(zone: string): string {
  return /^(etc\/)?(gmt|utc)$/i.test(zone) ? "GMT" : zone;
}

/** A time with its zone written next to it, e.g. "2026-09-21 09:00 GMT", so it can't be misread. */
function at(value: string | null | undefined, zone: string): string {
  if (!value) return "";
  if (value.length <= 10) return `${value} (all day)`;
  const moment = new Date(value);
  return Number.isNaN(moment.getTime())
    ? value
    : `${moment.toLocaleString("sv-SE", { timeZone: zone, dateStyle: "short", timeStyle: "short" })} ${zoneLabel(zone)}`;
}

function when(event: calendar_v3.Schema$Event, zone: string): string {
  // All-day events end on the day after their last day; show the last day itself.
  if (event.start?.date) {
    const last = event.end?.date ? new Date(Date.parse(`${event.end.date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : event.start.date;
    return last > event.start.date ? `${event.start.date} → ${last} (all day)` : `${event.start.date} (all day)`;
  }
  const start = at(event.start?.dateTime, zone);
  const end = at(event.end?.dateTime, zone);
  return end ? `${start} → ${end}` : start;
}

/** Events in a date range, in one calendar (the person's own by default). */
export async function searchCalendar(
  query: string,
  start: string | undefined,
  end: string | undefined,
  calendarId: string | undefined,
  limit: number,
): Promise<SearchResult> {
  const id = calendarId?.trim() || "primary";
  const now = new Date();
  const timeMin = moment(start, now);
  const timeMax = moment(end, new Date(Date.parse(timeMin) + TWO_WEEKS_MS), true);

  const zone = await displayTimeZone();
  const res = await g().calendar.events.list({
    calendarId: id,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: Math.min(Math.max(limit, 1), 100),
    ...(query.trim() ? { q: query.trim() } : {}),
  });

  const label = res.data.summary ?? id;
  const found = (res.data.items ?? []).map((event) => {
    const attendees = (event.attendees ?? [])
      .map((a) => `${a.displayName || a.email}${a.responseStatus && a.responseStatus !== "needsAction" ? ` (${a.responseStatus})` : ""}`)
      .join(", ");
    const lines = [
      `Title: ${event.summary ?? "(no title)"}`,
      `When: ${when(event, zone)}`,
      event.location && `Where: ${event.location}`,
      event.hangoutLink && `Video call: ${event.hangoutLink}`,
      event.organizer?.email && `Organizer: ${event.organizer.displayName || event.organizer.email}`,
      attendees && `Attendees: ${attendees}`,
      event.recurringEventId && "Part of a recurring series",
      event.status && event.status !== "confirmed" && `Status: ${event.status}`,
      event.description && `Description:\n${clip(htmlToText(event.description), 4000)}`,
    ].filter(Boolean);
    return {
      docId: `calendar:${id}:${event.id}`,
      source: "calendar" as const,
      title: event.summary ?? "(no title)",
      url: event.htmlLink ?? null,
      container: label,
      author: event.organizer?.displayName ?? event.organizer?.email ?? null,
      // When the event happens, not when it was last edited.
      updatedAt: event.start?.dateTime ?? event.start?.date ?? event.updated ?? "",
      listLine: `${event.summary ?? "(no title)"} | ${when(event, zone)}${event.organizer?.email ? ` | organizer ${event.organizer.displayName || event.organizer.email}` : ""}`,
      text: lines.join("\n"),
    };
  });
  const range = `between ${at(timeMin, zone)} and ${at(timeMax, zone)}`;
  const [year, month, day] = timeMin.slice(0, 10).split("-").map(Number);
  return {
    found,
    total: found.length,
    complete: !res.data.nextPageToken,
    listUrl: `https://calendar.google.com/calendar/r/week/${year}/${month}/${day}`,
    summary: res.data.nextPageToken
      ? `The first ${found.length} event(s) ${range}; there are more.`
      : `${found.length} event(s) ${range}${query.trim() ? ` matching “${query.trim()}”` : ""}, all listed.`,
  };
}

/** The calendars the signed-in person can see, own and shared. */
export async function listCalendars(): Promise<Found[]> {
  const res = await g().calendar.calendarList.list({ maxResults: 100, showHidden: false });
  const lines = (res.data.items ?? []).map((c) =>
    `- ${c.summary ?? c.id}${c.primary ? " (main calendar)" : ""} | id: ${c.id} | access: ${c.accessRole ?? "?"}${c.timeZone ? ` | time zone: ${c.timeZone}` : ""}`,
  );
  return pieces(
    {
      docId: "calendar:list",
      source: "calendar",
      title: "Calendars",
      url: "https://calendar.google.com/",
      container: "Calendar",
      author: null,
      updatedAt: "",
      text: "",
    },
    lines.length ? `${lines.length} calendar(s):\n${lines.join("\n")}` : "No calendars found.",
  );
}

/** Busy times for people in the company, to find a free slot. Shows busy blocks only, never event details. */
export async function checkAvailability(emails: string[], start: string | undefined, end: string | undefined): Promise<Found[]> {
  const people = emails.map((email) => email.trim()).filter(Boolean).slice(0, 20);
  if (!people.length) return [];
  const timeMin = moment(start, new Date());
  const timeMax = moment(end, new Date(Date.parse(timeMin) + 7 * 86_400_000), true);

  const zone = await displayTimeZone();
  const [res, names] = await Promise.all([
    g().calendar.freebusy.query({ requestBody: { timeMin, timeMax, items: people.map((id) => ({ id })) } }),
    Promise.all(people.map((email) => nameOf(email).catch(() => email))),
  ]);

  const calendars = res.data.calendars ?? {};
  const lines = people.map((email, i) => {
    const who = names[i] && names[i] !== email ? `${names[i]} (${email})` : email;
    const entry = calendars[email];
    if (entry?.errors?.length) return `- ${who}: calendar not readable (${entry.errors.map((e) => e.reason).join(", ")})`;
    const busy = (entry?.busy ?? []).map((slot) => `  - busy ${at(slot.start, zone)} → ${at(slot.end, zone)}`);
    return busy.length ? `- ${who}:\n${busy.join("\n")}` : `- ${who}: no busy time in this range`;
  });

  return pieces(
    {
      docId: `calendar:freebusy:${people.join(",")}`,
      source: "calendar",
      title: `Availability ${timeMin.slice(0, 10)} → ${timeMax.slice(0, 10)}`,
      url: "https://calendar.google.com/",
      container: "Calendar",
      author: null,
      updatedAt: "",
      text: "",
    },
    `Busy times from ${at(timeMin, zone)} to ${at(timeMax, zone)}, all in ${zoneLabel(zone)}. Any time not listed as busy is free (working hours aren't known):\n${lines.join("\n")}`,
  );
}

// ─── Key AI employee documents: the catalog and the tracker ──────────────

export type KeyDocumentKind = "catalog" | "tracker";

export interface KeyDocumentFilters {
  owner?: string;
  status?: string;
  domain?: string;
  /** Rows without (or with) a demo video, by the tracker's video cell and the YouTube channel. */
  demo_video?: "missing" | "present";
}

const KEY_DOCUMENTS: Record<KeyDocumentKind, { setting: string; label: string }> = {
  catalog: { setting: "AI_CATALOG_FILE_ID", label: "AI Employee Catalog" },
  tracker: { setting: "AI_TRACKER_FILE_ID", label: "AI Employee Tracker" },
};

interface KeyDocument {
  modified: string;
  title: string;
  url: string | null;
  /** Slides of a presentation ("Slide N:\n…"), or chunks of any other text. */
  parts: string[];
  /** Every row of every tab, when the document is a spreadsheet. */
  rows: SheetRow[];
  /** Tabs in workbook order, with every column header seen in them. */
  sheets: { name: string; headers: string[]; rows: number }[];
  /** AI employee code → its name and the slides that show it. */
  codes: Map<string, { name: string; slides: number[] }>;
}

const keyDocuments = new Map<string, KeyDocument>();

export function keyDocumentConfigured(kind: KeyDocumentKind): boolean {
  return liveGoogleAvailable() && Boolean(env(KEY_DOCUMENTS[kind].setting));
}

/** Loads a key document, and loads it again only when Drive says it has changed. */
async function keyDocument(fileId: string): Promise<KeyDocument> {
  const meta = (
    await g().drive.files.get({ fileId, fields: "name, mimeType, webViewLink, modifiedTime, size", supportsAllDrives: true })
  ).data;
  const cached = keyDocuments.get(fileId);
  if (cached && cached.modified === meta.modifiedTime) return cached;
  if (Number(meta.size ?? 0) > MAX_FILE_BYTES) throw new Error(`${meta.name} is larger than 20 MB`);

  const bytes = (exportAs?: string) => driveBytes(fileId, exportAs);

  let parts: string[] = [];
  let tables: SheetTable[] = [];
  if (meta.mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    parts = (await pptxSlides(await bytes())).map((text, i) => `Slide ${i + 1}:\n${text}`);
  } else if (meta.mimeType === GOOGLE_SHEET) {
    tables = await xlsxSheets(await bytes(XLSX));
  } else if (meta.mimeType === XLSX) {
    tables = await xlsxSheets(await bytes());
  } else {
    parts = chunkText(await fileText(g().drive, fileId, meta.mimeType ?? ""));
  }

  const rows = tables.flatMap(sheetRows);
  const loaded: KeyDocument = {
    modified: meta.modifiedTime ?? "",
    title: meta.name ?? fileId,
    url: meta.webViewLink ?? null,
    parts,
    rows,
    sheets: tables.map((table) => {
      const own = rows.filter((row) => row.sheet === table.name);
      return { name: table.name, headers: [...new Set(own.flatMap((row) => Object.keys(row.fields)))], rows: own.length };
    }),
    codes: catalogCodes(parts),
  };
  keyDocuments.set(fileId, loaded);
  return loaded;
}

const CODE_LINE = /^[A-Z]{2}-\d{2}[a-z]?$/;

/**
 * AI employee codes with their names. Overview slides list many codes, each followed by its name; a
 * detail slide shows one code, with the name two lines above it (name, tagline, code).
 */
function catalogCodes(slides: string[]): Map<string, { name: string; slides: number[] }> {
  const codes = new Map<string, { name: string; slides: number[] }>();
  const layout = slides.map((slide) => {
    const lines = slide.split("\n").slice(1);
    return { lines, at: lines.flatMap((line, i) => (CODE_LINE.test(line) ? [i] : [])) };
  });
  for (const overviewPass of [true, false]) {
    layout.forEach(({ lines, at }, index) => {
      if (at.length >= 3 !== overviewPass) return;
      for (const i of at) {
        const entry = codes.get(lines[i]) ?? { name: "", slides: [] };
        const name = overviewPass ? lines[i + 1] : lines[i - 2];
        if (!entry.name && name && !CODE_LINE.test(name)) entry.name = name;
        if (!entry.slides.includes(index + 1)) entry.slides.push(index + 1);
        codes.set(lines[i], entry);
      }
    });
  }
  return codes;
}

/**
 * Which texts match a query. AI employee codes match exactly and on their own, so "DO-25" never falls back
 * to loose words; otherwise all keywords must appear, then any (`loose`); a query of only common words
 * ("to do") is matched as a phrase.
 */
function matchTexts(texts: string[], query: string): { matches: { index: number; score: number }[]; note?: string; loose?: boolean } {
  const lower = texts.map((text) => text.normalize("NFKC").toLowerCase());
  const codes = employeeCodes(query);
  if (codes.length) {
    const matches = lower.flatMap((text, index) => {
      const score = codes.filter((code) => codePattern(code).test(text)).length;
      return score ? [{ index, score }] : [];
    });
    const missing = codes.filter((code) => !lower.some((text) => codePattern(code).test(text)));
    return { matches, note: missing.length ? `Nothing here mentions ${missing.join(", ")}.` : undefined };
  }
  const words = keywords(query, 8);
  if (!words.length) {
    const phrase = query.normalize("NFKC").toLowerCase().trim();
    return { matches: lower.flatMap((text, index) => (text.includes(phrase) ? [{ index, score: 1 }] : [])) };
  }
  const scored = lower.map((text, index) => ({ index, score: words.filter((w) => text.includes(w)).length }));
  const every = scored.filter((m) => m.score === words.length);
  if (every.length) return { matches: every };
  const some = scored.filter((m) => m.score > 0);
  return {
    matches: some,
    loose: some.length > 0,
    note: some.length ? `Nothing contains all of “${words.join(" ")}”; these contain some of the words, best first.` : undefined,
  };
}

/**
 * The tracker's rows or the catalog's slides that match the query. Lists are always complete: when more
 * match than fit in full, all of them come as a compact list.
 */
export async function searchKeyDocument(
  kind: KeyDocumentKind,
  query: string,
  limit: number,
  filters: KeyDocumentFilters = {},
): Promise<SearchResult> {
  const { setting, label } = KEY_DOCUMENTS[kind];
  const fileId = env(setting);
  if (!fileId) throw new Error(`${setting} is not set`);
  const doc = await keyDocument(fileId);
  const base: Found = { docId: `key:${kind}:${fileId}`, source: "drive", title: doc.title, url: doc.url, container: label, author: null, updatedAt: doc.modified, text: "" };
  const overview = !query.trim() && !Object.values(filters).some((value) => value?.trim());
  const videos = filters.demo_video && doc.rows.length && youtubeConfigured() ? await channelVideoLinks(doc).catch(() => undefined) : undefined;
  // The full lists also say how the two documents line up, so "how many catalog AI employees are tracked" has one citable answer.
  const comparison = overview ? await catalogTrackerComparison().catch(() => undefined) : undefined;
  return doc.rows.length
    ? searchRows(doc, base, query.trim(), limit, filters, comparison, videos)
    : searchSlides(doc, base, query.trim(), limit, comparison);
}

/** Tracker columns in the compact listing: label, and the start of the column header it comes from. */
const TRACKER_COLUMNS: [label: string, header: string][] = [
  ["ID", "ndi ai employee id"],
  ["Use case", "use case"],
  ["Domain", "ndi domain"],
  ["Owner", "owner"],
  ["Status", "status"],
  ["Status %", "status %"],
  ["Target date", "target date"],
  ["Remaining PD", "remaining effort"],
  ["Acceptance", "acceptance"],
  ["Demo video", "demo video"],
];

/** The tracker's main tab (the first with an AI employee ID column) and a reader for its key columns. */
function trackerLayout(doc: KeyDocument) {
  const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  const main = doc.sheets.find((s) => s.headers.some((h) => norm(h).startsWith("ndi ai employee id"))) ?? doc.sheets[0];
  const columns = new Map(
    TRACKER_COLUMNS.map(([label, start]) => [
      label,
      main.headers.find((h) => norm(h) === start) ?? main.headers.find((h) => norm(h).startsWith(start)),
    ]),
  );
  const value = (row: SheetRow, label: string) => {
    const key = columns.get(label);
    return key ? (row.fields[key] ?? "").replace(/\s+/g, " ").trim() : "";
  };
  return { main, columns, value };
}

/** Tracker ID → a video on the channel that names it in its title, description or tags (also written "[GP -15]"). */
async function channelVideoLinks(tracker: KeyDocument): Promise<Map<string, string>> {
  const { videos } = await channelVideos();
  const { main, value } = trackerLayout(tracker);
  const texts = videos.map((v) => ({ id: v.id, text: [v.snippet?.title, v.snippet?.description, ...(v.snippet?.tags ?? [])].join("\n") }));
  const links = new Map<string, string>();
  for (const row of tracker.rows.filter((r) => r.sheet === main.name)) {
    const id = value(row, "ID");
    const [letters, rest] = id.split("-");
    if (!letters || !rest) continue;
    const pattern = new RegExp(`\\b${letters}\\s?-?\\s?${rest}\\b`, "i");
    const video = texts.find((v) => pattern.test(v.text));
    if (video?.id) links.set(id, `https://youtu.be/${video.id}`);
  }
  return links;
}

/** How the catalog's AI employee codes and the tracker's IDs line up. */
async function catalogTrackerComparison(): Promise<string | undefined> {
  const catalogId = env(KEY_DOCUMENTS.catalog.setting);
  const trackerId = env(KEY_DOCUMENTS.tracker.setting);
  if (!catalogId || !trackerId) return undefined;
  const [catalog, tracker] = await Promise.all([keyDocument(catalogId), keyDocument(trackerId)]);
  if (!catalog.codes.size || !tracker.rows.length) return undefined;

  const { main, value } = trackerLayout(tracker);
  const tracked = new Map<string, { name: string; rows: number[] }>();
  for (const row of tracker.rows.filter((r) => r.sheet === main.name)) {
    const id = value(row, "ID");
    if (!id) continue;
    const entry = tracked.get(id) ?? { name: value(row, "Use case"), rows: [] };
    entry.rows.push(row.row);
    tracked.set(id, entry);
  }
  const inBoth = [...catalog.codes.keys()].filter((code) => tracked.has(code));
  const onlyCatalog = [...catalog.codes].filter(([code]) => !tracked.has(code)).map(([code, e]) => `${code} ${e.name}`);
  const onlyTracker = [...tracked].filter(([id]) => !catalog.codes.has(id)).map(([id, e]) => `${id} ${e.name}`);
  const repeated = [...tracked].filter(([, e]) => e.rows.length > 1).map(([id, e]) => `${id} (rows ${e.rows.join(", ")})`);
  return (
    `Catalog compared with the tracker: ${inBoth.length} of the catalog's ${catalog.codes.size} AI employee codes have a tracker row. ` +
    `In the catalog but not in the tracker: ${onlyCatalog.join("; ") || "none"}. ` +
    `In the tracker (${tracked.size} distinct IDs) but not in the catalog: ${onlyTracker.join("; ") || "none"}.` +
    (repeated.length ? ` IDs on more than one tracker row: ${repeated.join("; ")}.` : "")
  );
}

function searchRows(
  doc: KeyDocument,
  base: Found,
  query: string,
  limit: number,
  filters: KeyDocumentFilters,
  comparison?: string,
  videos?: Map<string, string>,
): SearchResult {
  const { main, columns, value } = trackerLayout(doc);
  const compact = (row: SheetRow) => {
    const rest = TRACKER_COLUMNS.slice(2).map(([label]) => `${label}: ${clip(value(row, label), 140) || "—"}`);
    return `Row ${row.row}: ${value(row, "ID")} ${value(row, "Use case")} | ${rest.join(" | ")}`;
  };
  // Main-tab rows without an AI employee ID hold totals or notes: never listed or counted as AI employees.
  const isNote = (row: SheetRow) => row.sheet === main.name && Boolean(columns.get("ID")) && !value(row, "ID");
  const notes = doc.rows.filter(isNote);
  const noteText = notes.map((row) => row.text.replace(/^Sheet "[^"]*" · /, "")).join("; ");

  let rows = doc.rows.filter((row) => !isNote(row));
  const conditions: string[] = [];
  const hints: string[] = [];

  const byColumn: [keyof KeyDocumentFilters, string][] = [
    ["owner", "Owner"],
    ["status", "Status"],
    ["domain", "Domain"],
  ];
  for (const [filter, label] of byColumn) {
    const wanted = filters[filter]?.trim();
    if (!wanted) continue;
    if (!columns.get(label)) {
      hints.push(`The tracker has no ${label} column, so the ${filter} filter was ignored.`);
      continue;
    }
    const negate = /^not\s+/i.test(wanted);
    const text = wanted.replace(/^not\s+/i, "").toLowerCase();
    rows = rows.filter((row) => row.sheet === main.name && value(row, label).toLowerCase().includes(text) !== negate);
    conditions.push(`${label} ${negate ? "doesn't contain" : "contains"} “${text}”`);
  }

  if (filters.demo_video) {
    // A video counts when the tracker links one or the channel has one naming the AI employee.
    const cell = (row: SheetRow) => value(row, "Demo video");
    const channel = (row: SheetRow) => videos?.get(value(row, "ID"));
    const mainRows = rows.filter((row) => row.sheet === main.name);
    const onlyChannel = mainRows.filter((row) => !cell(row) && channel(row));
    const onlyCell = videos ? mainRows.filter((row) => cell(row) && !channel(row)) : [];
    rows = mainRows.filter((row) => Boolean(cell(row) || channel(row)) === (filters.demo_video === "present"));
    conditions.push(filters.demo_video === "present" ? "a demo video exists" : "no demo video exists");
    if (!videos) hints.push("The YouTube channel couldn't be checked, so only the tracker's video cells were used.");
    if (onlyChannel.length) {
      hints.push(`Empty video cell in the tracker but a video on the channel: ${onlyChannel.map((row) => `${value(row, "ID")} (${channel(row)})`).join("; ")}.`);
    }
    if (onlyCell.length) {
      hints.push(`Video linked in the tracker but no channel video names the ID (it may be unlisted or titled differently): ${onlyCell.map((row) => value(row, "ID")).join(", ")}.`);
    }
  }

  let ranked = rows.map((row) => ({ row, score: 1 }));
  if (query) {
    const { matches, note } = matchTexts(rows.map((row) => row.text), query);
    if (note) hints.push(note);
    ranked = matches.map((m) => ({ row: rows[m.index], score: m.score }));
    conditions.unshift(`“${query}”`);
  }
  // Rows of the main tab first, then the best matches, then sheet order.
  ranked.sort((a, b) => Number(b.row.sheet === main.name) - Number(a.row.sheet === main.name) || b.score - a.score);
  const matched = ranked.map((m) => m.row);
  const note = hints.join(" ") || undefined;

  const statuses = new Map<string, number>();
  for (const row of matched.filter((r) => r.sheet === main.name)) {
    const status = value(row, "Status") || "no status";
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
  const byStatus = columns.get("Status") && statuses.size ? ` By status: ${[...statuses].map(([s, n]) => `${s} ${n}`).join(", ")}.` : "";

  if (!conditions.length) {
    const own = matched.filter((row) => row.sheet === main.name);
    const others = doc.sheets.filter((s) => s !== main).map((s) => `${s.name} (${s.rows ? `${s.rows} rows` : "empty"})`);
    const summary =
      `The "${main.name}" tab has ${own.length} AI employee rows, all listed below with the key columns.${byStatus}` +
      (notes.length ? ` Not listed or counted: ${notes.length} rows without an AI employee ID, holding totals or notes (${noteText}).` : "") +
      (others.length ? ` Other tabs, not listed: ${others.join(", ")}.` : "") +
      (comparison ? ` ${comparison}` : "") +
      " Ask about one ID to see all of its columns.";
    return { found: listPassages(base, summary, own.map(compact)), total: own.length, complete: true, summary, listed: true };
  }

  const described = conditions.join(" and ");
  if (!matched.length) return { found: [], total: 0, complete: true, note, summary: `No tracker row matches ${described}.` };
  if (matched.length <= limit) {
    const summary = `${matched.length} tracker row(s) match ${described}, all shown with every column.${matched.length > 1 ? byStatus : ""}`;
    const found = matched.map((row) => ({ ...base, text: clip(row.text, 12_000) }));
    found[0] = { ...found[0], text: `${summary}\n\n${found[0].text}` };
    return { found, total: matched.length, complete: true, summary, note, listed: true };
  }
  const summary = `${matched.length} tracker row(s) match ${described}, all listed below with the key columns.${byStatus} Ask about one ID to see all of its columns.`;
  const lines = matched.map((row) => (row.sheet === main.name ? compact(row) : clip(row.text, 600)));
  return { found: listPassages(base, summary, lines), total: matched.length, complete: true, summary, note, listed: true };
}

function searchSlides(doc: KeyDocument, base: Found, query: string, limit: number, comparison?: string): SearchResult {
  const describe = (code: string) => {
    const entry = doc.codes.get(code)!;
    return `${code} ${entry.name || "(name not found)"} (slide${entry.slides.length > 1 ? "s" : ""} ${entry.slides.join(", ")})`;
  };
  const slideLine = (index: number) => {
    const codes = [...doc.codes.keys()].filter((code) => doc.codes.get(code)!.slides.includes(index + 1));
    const about = codes.length
      ? codes.slice(0, 6).map((code) => `${code} ${doc.codes.get(code)!.name}`).join("; ")
      : clip(doc.parts[index].split("\n").slice(1, 3).join(" / "), 120);
    return `Slide ${index + 1}: ${about}${codes.length > 6 ? `; and ${codes.length - 6} more` : ""}`;
  };

  if (!query) {
    const titleSlide = (doc.parts[0] ?? "").replace(/^Slide 1:\n/, "").replace(/\n/g, " / ");
    const stated = Number(/(\d+)\s+AI employees/i.exec(titleSlide)?.[1]);
    const summary =
      `The catalog has ${doc.parts.length} slides and shows ${doc.codes.size} distinct AI employee codes, all listed below with their names and slides.` +
      (titleSlide ? ` Its title slide says: “${clip(titleSlide, 200)}”.` : "") +
      (stated && stated !== doc.codes.size ? ` The title slide's figure (${stated}) differs from the ${doc.codes.size} codes on the slides.` : "") +
      (comparison ? ` ${comparison}` : "");
    return {
      found: listPassages(base, summary, [...doc.codes.keys()].map(describe)),
      total: doc.codes.size,
      complete: true,
      summary,
      listed: true,
    };
  }

  const { matches, note, loose } = matchTexts(doc.parts, query);
  const codeCount = (index: number) => (doc.parts[index].match(/^[A-Z]{2}-\d{2}[a-z]?$/gm) ?? []).length;
  // A slide about one AI employee says more about it than an overview listing many.
  matches.sort((a, b) => b.score - a.score || Number(codeCount(a.index) >= 3) - Number(codeCount(b.index) >= 3) || a.index - b.index);
  const known = employeeCodes(query).filter((code) => doc.codes.has(code)).map(describe);
  // Many slides sharing just some of the words are a list to narrow down, not slides to read.
  const shown = loose && matches.length > 20 ? [] : matches.slice(0, limit);

  let summary = !matches.length
    ? `No slide matches “${query}”.`
    : !shown.length
      ? `${matches.length} slides share some of the words of “${query}”, too many to show in full: all are listed; narrow the query or ask for a code.`
      : `${matches.length} slide(s) match “${query}”${matches.length > shown.length ? `; the best ${shown.length} are shown in full and all ${matches.length} are listed at the end.` : ", all shown."}`;
  if (known.length) summary = `${known.join("; ")}.\n${summary}`;
  if (!matches.length) return { found: [], total: 0, complete: true, summary, note };

  const found: Found[] = shown.map((m) => ({ ...base, text: clip(doc.parts[m.index], 12_000) }));
  if (matches.length > shown.length) {
    found.push(...listPassages(base, `All ${matches.length} slides matching “${query}”:`, matches.map((m) => slideLine(m.index))));
  }
  found[0] = { ...found[0], text: `${summary}\n\n${found[0].text}` };
  return { found, total: matches.length, complete: true, summary, note, listed: true };
}

// ─── Reading a result ────────────────────────────────────────────────────

/** Opens a live search result in full: the Drive file, the email thread or the Chat thread. */
export function readLive(item: Found, focus?: string): Promise<Found[]> {
  if (item.docId.startsWith("drive:")) return readDrive(item, focus);
  if (item.docId.startsWith("gmail:")) return readGmail(item);
  if (item.docId.startsWith("gchat:")) return readChat(item);
  if (item.docId.startsWith("gspace:")) return readSpaceMessages(item.docId.slice("gspace:".length), item.container);
  // Everything else (directory, YouTube, key documents, calendar, results lists) is already complete.
  if (/^(directory|youtube|key|calendar|list|drive-folder):/.test(item.docId)) return Promise.resolve([item]);
  return Promise.reject(new Error("this result can't be opened"));
}

function pieces(item: Found, text: string): Found[] {
  return chunkText(clip(text, MAX_READ_CHARS)).map((part) => ({ ...item, text: part }));
}
