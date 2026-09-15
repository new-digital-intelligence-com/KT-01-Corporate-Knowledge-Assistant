import { google, type chat_v1, type drive_v3, type gmail_v1 } from "googleapis";
import { env } from "./config";
import type { ChunkRow } from "./db";
import { keywords } from "./search";
import { READABLE_MIME_TYPES, fileText } from "./sources/drive";
import { bodyText, header, messageDate, stripQuoted } from "./sources/gmail";
import { GOOGLE_SCOPES, directoryNames, googleAuth, userAuthConfigured } from "./sources/google";
import { chunkText, clip, htmlToText } from "./text";

/**
 * Content found live in Google while answering one question. It has the same shape as an indexed
 * passage (minus the id), so citations and the fact check treat both the same way.
 */
export type Found = Omit<ChunkRow, "chunkId">;

const MAX_READ_CHARS = 80_000;
const MAX_READ_PASSAGES = 40;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Live search reads as the person who signed in with `npm run google-login`. */
export function liveGoogleAvailable(): boolean {
  return userAuthConfigured();
}

let clients: { drive: drive_v3.Drive; gmail: gmail_v1.Gmail; chat: chat_v1.Chat } | undefined;

function g() {
  clients ??= {
    drive: google.drive({ version: "v3", auth: googleAuth(undefined, GOOGLE_SCOPES.drive) }),
    gmail: google.gmail({ version: "v1", auth: googleAuth(undefined, GOOGLE_SCOPES.gmail) }),
    chat: google.chat({ version: "v1", auth: googleAuth(undefined, GOOGLE_SCOPES.chat) }),
  };
  return clients;
}

// ─── Google Drive ────────────────────────────────────────────────────────

export async function searchDrive(query: string, limit: number): Promise<Found[]> {
  const words = keywords(query, 5);
  if (!words.length) return [];
  const content = words.map((w) => `fullText contains '${w.replace(/['\\]/g, "")}'`).join(" and ");
  const types = READABLE_MIME_TYPES.map((m) => `mimeType = '${m}'`).join(" or ");
  // GOOGLE_DRIVE_ID limits search to one shared drive; without it, everything the person can open.
  const driveId = env("GOOGLE_DRIVE_ID");

  const res = await g().drive.files.list({
    q: `trashed = false and (${types}) and ${content}`,
    pageSize: limit,
    fields: "files(id, name, modifiedTime, webViewLink, owners(displayName), lastModifyingUser(displayName))",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...(driveId ? { corpora: "drive", driveId } : { corpora: "allDrives" }),
  });

  return (res.data.files ?? [])
    .filter((f) => f.id)
    .map((f) => ({
      docId: `drive:${f.id}`,
      source: "drive" as const,
      title: f.name ?? "Untitled",
      url: f.webViewLink ?? null,
      container: "Google Drive",
      author: f.lastModifyingUser?.displayName ?? f.owners?.[0]?.displayName ?? null,
      updatedAt: f.modifiedTime ?? "",
      text: `File "${f.name}" contains the searched words. Its content isn't shown here: open it with read_result.`,
    }));
}

async function readDrive(item: Found): Promise<Found[]> {
  const fileId = item.docId.slice("drive:".length);
  const meta = await g().drive.files.get({ fileId, fields: "mimeType, size", supportsAllDrives: true });
  if (Number(meta.data.size ?? 0) > MAX_FILE_BYTES) throw new Error("the file is larger than 20 MB");
  if (!meta.data.mimeType || !READABLE_MIME_TYPES.includes(meta.data.mimeType)) throw new Error("this file type can't be read");
  return pieces(item, await fileText(g().drive, fileId, meta.data.mimeType));
}

// ─── Gmail ───────────────────────────────────────────────────────────────

let mailbox: Promise<string> | undefined;

function myMailbox(): Promise<string> {
  mailbox ??= g()
    .gmail.users.getProfile({ userId: "me" })
    .then((res) => res.data.emailAddress ?? "me");
  return mailbox;
}

export async function searchGmail(query: string, limit: number): Promise<Found[]> {
  if (!query.trim()) return [];
  const [res, address] = await Promise.all([
    g().gmail.users.threads.list({ userId: "me", q: `${query} -in:spam -in:trash`, maxResults: limit }),
    myMailbox(),
  ]);

  return Promise.all(
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
        return {
          docId: `gmail:${t.id}`,
          source: "gmail" as const,
          title: (first && header(first, "Subject")) || "(no subject)",
          url: `https://mail.google.com/mail/u/${address}/#all/${t.id}`,
          container: address,
          author: (first && header(first, "From")) || null,
          updatedAt: last ? messageDate(last) : "",
          text: `${messages.length} message(s). Latest, from ${last ? header(last, "From") : "unknown"}: ${htmlToText(last?.snippet ?? t.snippet ?? "")}`,
        };
      }),
  );
}

async function readGmail(item: Found): Promise<Found[]> {
  const id = item.docId.slice("gmail:".length);
  const thread = await g().gmail.users.threads.get({ userId: "me", id, format: "full" });
  const text = (thread.data.messages ?? [])
    .map((m) => {
      const cc = header(m, "Cc");
      return (
        `[${messageDate(m).slice(0, 16).replace("T", " ")}] From: ${header(m, "From")}\n` +
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
  return `[${(m.createTime ?? "").slice(0, 16).replace("T", " ")}] ${who}: ${messageText(m)}`;
}

function chatUrl(space: string, thread: string | null | undefined): string {
  const spaceId = space.replace(/^spaces\//, "");
  const threadId = thread?.split("/threads/")[1];
  return `https://chat.google.com/room/${spaceId}${threadId ? `/${threadId}` : ""}`;
}

/** Messages in named spaces the person belongs to. Direct messages and group chats are left out. */
export async function searchChat(query: string, limit: number): Promise<Found[]> {
  const words = keywords(query, 8);
  if (!words.length) return [];
  const res = await g().chat.spaces.messages.search({
    parent: "spaces/-",
    requestBody: { filter: words.join(" "), pageSize: Math.min(limit * 3, 50) },
  });

  const found: Found[] = [];
  for (const result of res.data.results ?? []) {
    const m = result.message;
    if (!m?.name || !messageText(m)) continue;
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
    if (found.length >= limit) break;
  }
  return found;
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

/** The latest messages in a space (from the last two weeks, newest `limit`), read as the signed-in person. */
export async function readSpaceMessages(space: string, label?: string, limit = 40): Promise<Found[]> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const messages: chat_v1.Schema$Message[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const res = await g().chat.spaces.messages.list({ parent: space, filter: `createTime > "${since}"`, pageSize: 1000, pageToken });
    messages.push(...(res.data.messages ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ++pages < 3);

  const recent = messages.filter((m) => messageText(m)).slice(-limit);
  if (!recent.length) return [];
  const name = label || (await spaceInfo(space)).displayName || space;
  const lines = await Promise.all(recent.map(messageLine));
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
    lines.join("\n"),
  );
}

// ─── Reading a result ────────────────────────────────────────────────────

/** Opens a live search result in full: the Drive file, the email thread or the Chat thread. */
export function readLive(item: Found): Promise<Found[]> {
  if (item.docId.startsWith("drive:")) return readDrive(item);
  if (item.docId.startsWith("gmail:")) return readGmail(item);
  if (item.docId.startsWith("gchat:")) return readChat(item);
  if (item.docId.startsWith("gspace:")) return readSpaceMessages(item.docId.slice("gspace:".length), item.container);
  return Promise.reject(new Error("this result can't be opened"));
}

function pieces(item: Found, text: string): Found[] {
  return chunkText(clip(text, MAX_READ_CHARS))
    .slice(0, MAX_READ_PASSAGES)
    .map((part) => ({ ...item, text: part }));
}
