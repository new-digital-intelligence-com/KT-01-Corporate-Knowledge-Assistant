import { google, type admin_directory_v1, type chat_v1, type drive_v3, type gmail_v1, type youtube_v3 } from "googleapis";
import { env } from "./config";
import type { ChunkRow } from "./db";
import { keywords } from "./search";
import { READABLE_MIME_TYPES, fileText } from "./sources/drive";
import { pptxSlides, sheetRecords, xlsxSheets } from "./sources/office";
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

let clients:
  | {
      drive: drive_v3.Drive;
      gmail: gmail_v1.Gmail;
      chat: chat_v1.Chat;
      admin: admin_directory_v1.Admin;
      youtube: youtube_v3.Youtube;
    }
  | undefined;

function g() {
  clients ??= {
    drive: google.drive({ version: "v3", auth: googleAuth(undefined, GOOGLE_SCOPES.drive) }),
    gmail: google.gmail({ version: "v1", auth: googleAuth(undefined, GOOGLE_SCOPES.gmail) }),
    chat: google.chat({ version: "v1", auth: googleAuth(undefined, GOOGLE_SCOPES.chat) }),
    admin: google.admin({ version: "directory_v1", auth: googleAuth(undefined, GOOGLE_SCOPES.directory) }),
    youtube: google.youtube({ version: "v3", auth: googleAuth(undefined, GOOGLE_SCOPES.youtube) }),
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

// ─── Google Workspace directory (read-only) ──────────────────────────────

type ViewType = "admin_view" | "domain_public";
// Admins see full profiles; everyone else only the public ones. Remember which one this sign-in gets.
let userView: ViewType | undefined;

function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e.response?.status ?? e.status;
}

/** People in the directory, by name, email or directory search syntax. */
export async function searchPeople(query: string, limit: number): Promise<Found[]> {
  const q = query.trim();
  const list = (viewType: ViewType) =>
    g().admin.users.list({
      customer: "my_customer",
      viewType,
      projection: "full",
      maxResults: Math.min(Math.max(limit, 1), 50),
      ...(q ? { query: q } : {}),
    });

  let res: Awaited<ReturnType<typeof list>> | undefined;
  if (userView !== "domain_public") {
    try {
      res = await list("admin_view");
      userView = "admin_view";
    } catch (err) {
      if (httpStatus(err) !== 403) throw err;
      userView = "domain_public";
    }
  }
  res ??= await list("domain_public");
  return (res.data.users ?? []).map(personFound);
}

function personFound(u: admin_directory_v1.Schema$User): Found {
  const orgs = (u.organizations ?? []) as { title?: string; department?: string; primary?: boolean }[];
  const org = orgs.find((o) => o.primary) ?? orgs[0];
  const manager = ((u.relations ?? []) as { type?: string; value?: string }[]).find((r) => r.type === "manager")?.value;
  const phone = ((u.phones ?? []) as { value?: string }[]).find((p) => p.value)?.value;
  const lastLogin = u.lastLoginTime?.startsWith("1970") ? "never" : u.lastLoginTime?.slice(0, 10);
  const lines = [
    `Name: ${u.name?.fullName ?? ""}`,
    `Email: ${u.primaryEmail ?? ""}`,
    org?.title && `Title: ${org.title}`,
    org?.department && `Department: ${org.department}`,
    manager && `Manager: ${manager}`,
    phone && `Phone: ${phone}`,
    u.orgUnitPath && `Organizational unit: ${u.orgUnitPath}`,
    u.aliases?.length && `Aliases: ${u.aliases.join(", ")}`,
    typeof u.isAdmin === "boolean" && `Super admin: ${u.isAdmin ? "yes" : "no"}`,
    typeof u.isDelegatedAdmin === "boolean" && `Delegated admin (has an Admin console role): ${u.isDelegatedAdmin ? "yes" : "no"}`,
    typeof u.suspended === "boolean" && `Suspended: ${u.suspended ? "yes" : "no"}`,
    lastLogin && `Last sign-in: ${lastLogin}`,
    u.creationTime && `Account created: ${u.creationTime.slice(0, 10)}`,
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

/** Admin console role assignments, for everyone or one person. Needs an admin role that can view roles. */
export async function listAdminRoles(userEmail?: string): Promise<Found[]> {
  const [roles, assignments] = await Promise.all([
    g().admin.roles.list({ customer: "my_customer", maxResults: 100 }),
    g().admin.roleAssignments.list({ customer: "my_customer", maxResults: 200, ...(userEmail ? { userKey: userEmail } : {}) }),
  ]);
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

/** Groups matching a directory query, or the groups a person belongs to. */
export async function searchGroups(query: string, limit: number, memberEmail?: string): Promise<Found[]> {
  const q = query.trim();
  const res = await g().admin.groups.list(
    memberEmail
      ? { userKey: memberEmail, maxResults: 200 }
      : { customer: "my_customer", maxResults: Math.min(Math.max(limit, 1), 50), ...(q ? { query: q } : {}) },
  );
  return (res.data.groups ?? []).map((group) => ({
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
    `${members.length} member(s) of ${groupEmail}:\n${lines.join("\n")}`,
  );
}

// ─── YouTube channel (read-only) ─────────────────────────────────────────

// Listing uploads costs 1 quota unit per page, where YouTube's own search costs 100, so recent
// uploads are fetched once in a while and matched here.
const UPLOADS_TO_SCAN = 250;
const UPLOADS_FRESH_MS = 10 * 60_000;

let channel: Promise<{ id: string; title: string; uploads: string }> | undefined;
let uploadsCache: { at: number; items: youtube_v3.Schema$PlaylistItem[] } | undefined;

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

async function recentUploads(): Promise<youtube_v3.Schema$PlaylistItem[]> {
  if (uploadsCache && Date.now() - uploadsCache.at < UPLOADS_FRESH_MS) return uploadsCache.items;
  const { uploads } = await youtubeChannel();
  const items: youtube_v3.Schema$PlaylistItem[] = [];
  let pageToken: string | undefined;
  do {
    const res = await g().youtube.playlistItems.list({ part: ["snippet"], playlistId: uploads, maxResults: 50, pageToken });
    items.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && items.length < UPLOADS_TO_SCAN);
  uploadsCache = { at: Date.now(), items };
  return items;
}

/** Channel videos whose title or description contains the keywords; the latest videos when there are none. */
export async function searchYouTube(query: string, limit: number): Promise<Found[]> {
  const words = keywords(query, 6);
  const [items, { title: channelTitle }] = await Promise.all([recentUploads(), youtubeChannel()]);
  const ids = items
    .map((item) => {
      const text = `${item.snippet?.title ?? ""} ${item.snippet?.description ?? ""}`.normalize("NFKC").toLowerCase();
      return { id: item.snippet?.resourceId?.videoId, score: words.length ? words.filter((w) => text.includes(w)).length : 1 };
    })
    .filter((match): match is { id: string; score: number } => Boolean(match.id) && match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((match) => match.id);
  if (!ids.length) return [];

  const res = await g().youtube.videos.list({ part: ["snippet", "statistics", "contentDetails", "status"], id: ids });
  const byId = new Map((res.data.items ?? []).map((video) => [video.id, video]));
  return ids.flatMap((id) => {
    const video = byId.get(id);
    return video ? [videoFound(video, channelTitle)] : [];
  });
}

function videoFound(video: youtube_v3.Schema$Video, channelTitle: string): Found {
  const snippet = video.snippet ?? {};
  const stats = video.statistics ?? {};
  const lines = [
    `Title: ${snippet.title ?? ""}`,
    `Published: ${(snippet.publishedAt ?? "").slice(0, 10)}`,
    video.contentDetails?.duration && `Duration: ${readableDuration(video.contentDetails.duration)}`,
    video.status?.privacyStatus && `Visibility: ${video.status.privacyStatus}`,
    stats.viewCount && `Views: ${stats.viewCount}`,
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

// ─── Key AI employee documents: the catalog and the tracker ──────────────

export type KeyDocumentKind = "catalog" | "tracker";

const KEY_DOCUMENTS: Record<KeyDocumentKind, { setting: string; label: string }> = {
  catalog: { setting: "AI_CATALOG_FILE_ID", label: "AI Employee Catalog" },
  tracker: { setting: "AI_TRACKER_FILE_ID", label: "AI Employee Tracker" },
};

interface KeyDocument {
  modified: string;
  title: string;
  url: string | null;
  /** Slides of a presentation, or one record per spreadsheet row. */
  parts: string[];
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

  let parts: string[];
  if (meta.mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    const res = await g().drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    parts = (await pptxSlides(new Uint8Array(res.data as unknown as ArrayBuffer))).map((text, i) => `Slide ${i + 1}:\n${text}`);
  } else if (meta.mimeType === "application/vnd.google-apps.spreadsheet") {
    const res = await g().drive.files.export(
      { fileId, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { responseType: "arraybuffer" },
    );
    parts = (await xlsxSheets(new Uint8Array(res.data as unknown as ArrayBuffer))).flatMap(sheetRecords);
  } else if (meta.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    const res = await g().drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    parts = (await xlsxSheets(new Uint8Array(res.data as unknown as ArrayBuffer))).flatMap(sheetRecords);
  } else {
    parts = chunkText(await fileText(g().drive, fileId, meta.mimeType ?? ""));
  }

  const loaded = { modified: meta.modifiedTime ?? "", title: meta.name ?? fileId, url: meta.webViewLink ?? null, parts };
  keyDocuments.set(fileId, loaded);
  return loaded;
}

/**
 * The slides (catalog) or rows (tracker) that match the query. An exact phrase such as "GP-01" counts far
 * more than loose words. With no query: the list of slides, or every row.
 */
export async function searchKeyDocument(
  kind: KeyDocumentKind,
  query: string,
  limit: number,
): Promise<{ found: Found[]; total: number }> {
  const { setting, label } = KEY_DOCUMENTS[kind];
  const fileId = env(setting);
  if (!fileId) throw new Error(`${setting} is not set`);
  const doc = await keyDocument(fileId);
  const base: Found = { docId: `key:${kind}:${fileId}`, source: "drive", title: doc.title, url: doc.url, container: label, author: null, updatedAt: doc.modified, text: "" };

  const phrase = query.trim().toLowerCase();
  const words = keywords(query, 8);
  if (!words.length) {
    const overview =
      kind === "catalog"
        ? `${doc.parts.length} slides:\n${doc.parts.map((part, i) => `${i + 1}. ${part.split("\n")[1] ?? ""}`).join("\n")}`
        : doc.parts.join("\n");
    return { found: pieces(base, overview), total: doc.parts.length };
  }

  const matches = doc.parts
    .map((text, index) => {
      const lower = text.normalize("NFKC").toLowerCase();
      return { index, exact: lower.includes(phrase), score: words.filter((w) => lower.includes(w)).length };
    })
    .filter((match) => match.exact || match.score > 0);
  // When the exact phrase appears somewhere (like a code "GP-01"), loose word matches ("gp", "01") are noise.
  const chosen = matches.some((match) => match.exact) ? matches.filter((match) => match.exact) : matches;

  const found = chosen
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((match) => ({ ...base, text: clip(doc.parts[match.index], 12_000) }));
  return { found, total: chosen.length };
}

// ─── Reading a result ────────────────────────────────────────────────────

/** Opens a live search result in full: the Drive file, the email thread or the Chat thread. */
export function readLive(item: Found): Promise<Found[]> {
  if (item.docId.startsWith("drive:")) return readDrive(item);
  if (item.docId.startsWith("gmail:")) return readGmail(item);
  if (item.docId.startsWith("gchat:")) return readChat(item);
  // Directory and YouTube results are already complete.
  if (item.docId.startsWith("directory:") || item.docId.startsWith("youtube:") || item.docId.startsWith("key:")) {
    return Promise.resolve([item]);
  }
  if (item.docId.startsWith("gspace:")) return readSpaceMessages(item.docId.slice("gspace:".length), item.container);
  return Promise.reject(new Error("this result can't be opened"));
}

function pieces(item: Found, text: string): Found[] {
  return chunkText(clip(text, MAX_READ_CHARS))
    .slice(0, MAX_READ_PASSAGES)
    .map((part) => ({ ...item, text: part }));
}
