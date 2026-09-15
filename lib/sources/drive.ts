import { google, type drive_v3 } from "googleapis";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import { env, envList } from "../config";
import { upsertDocument } from "../db";
import { errorMessage, htmlToText } from "../text";
import { GOOGLE_SCOPES, googleAuth, googleConfigured, userAuthConfigured } from "./google";
import type { SyncContext } from "./types";

const FOLDER = "application/vnd.google-apps.folder";
const EXPORT_AS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const HTML = "text/html";
const PLAIN = ["text/plain", "text/markdown", "text/csv"];
const MAX_BYTES = 20 * 1024 * 1024;

/** File types whose text can be read: Google Docs/Sheets/Slides, PDF, Word, HTML and plain text. */
export const READABLE_MIME_TYPES = [...Object.keys(EXPORT_AS), PDF, DOCX, HTML, ...PLAIN];

const SHARED_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: "allDrives" } as const;

export function driveConfigured(): boolean {
  return googleConfigured() && (userAuthConfigured() || Boolean(env("GOOGLE_DRIVE_USER")));
}

export async function syncDrive(ctx: SyncContext): Promise<number> {
  const drive = google.drive({ version: "v3", auth: googleAuth(env("GOOGLE_DRIVE_USER"), GOOGLE_SCOPES.drive) });

  const types = [...Object.keys(EXPORT_AS), PDF, DOCX, HTML, ...PLAIN].map((m) => `mimeType = '${m}'`).join(" or ");
  const base = `trashed = false and modifiedTime > '${ctx.since.toISOString()}' and (${types})`;
  const roots = envList("GOOGLE_DRIVE_FOLDER_IDS");
  const queries = roots.length
    ? batches(await descendantFolders(drive, roots), 20).map((ids) => `${base} and (${inParents(ids)})`)
    : [base];

  let updated = 0;
  let seen = 0;
  for (const q of queries) {
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q,
        pageSize: 100,
        pageToken,
        fields: "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, size, owners(displayName))",
        ...SHARED_DRIVES,
      });
      for (const file of res.data.files ?? []) {
        if (seen++ >= ctx.maxItems) {
          ctx.log("drive: reached SYNC_MAX_ITEMS_PER_SOURCE, remaining files skipped");
          return updated;
        }
        if (!file.id || !file.mimeType) continue;
        if (Number(file.size ?? 0) > MAX_BYTES) {
          ctx.log(`drive: "${file.name}" skipped (larger than 20 MB)`);
          continue;
        }
        try {
          const saved = upsertDocument({
            id: `drive:${file.id}`,
            source: "drive",
            title: file.name ?? "Untitled",
            url: file.webViewLink ?? null,
            container: "Google Drive",
            author: file.owners?.[0]?.displayName ?? null,
            updatedAt: file.modifiedTime ?? new Date().toISOString(),
            text: await fileText(drive, file.id, file.mimeType),
          });
          if (saved) updated++;
        } catch (err) {
          ctx.log(`drive: "${file.name}" skipped (${errorMessage(err)})`);
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }
  return updated;
}

export async function fileText(drive: drive_v3.Drive, fileId: string, mimeType: string): Promise<string> {
  const exportAs = EXPORT_AS[mimeType];
  if (exportAs) {
    const res = await drive.files.export({ fileId, mimeType: exportAs }, { responseType: "text" });
    return String(res.data);
  }

  const res = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
  const bytes = new Uint8Array(res.data as unknown as ArrayBuffer);
  if (mimeType === PDF) return (await extractText(bytes, { mergePages: true })).text;
  if (mimeType === DOCX) return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  const text = new TextDecoder().decode(bytes);
  return mimeType === HTML ? htmlToText(text) : text;
}

/** `'<id>' in parents` only matches direct children, so walk the folder tree first. */
async function descendantFolders(drive: drive_v3.Drive, roots: string[]): Promise<string[]> {
  const all = new Set(roots);
  let frontier = roots;
  while (frontier.length) {
    const next: string[] = [];
    for (const ids of batches(frontier, 20)) {
      let pageToken: string | undefined;
      do {
        const res = await drive.files.list({
          q: `trashed = false and mimeType = '${FOLDER}' and (${inParents(ids)})`,
          fields: "nextPageToken, files(id)",
          pageSize: 1000,
          pageToken,
          ...SHARED_DRIVES,
        });
        for (const folder of res.data.files ?? []) {
          if (folder.id && !all.has(folder.id)) {
            all.add(folder.id);
            next.push(folder.id);
          }
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    }
    frontier = next;
  }
  return [...all];
}

function inParents(ids: string[]): string {
  return ids.map((id) => `'${id.replace(/'/g, "")}' in parents`).join(" or ");
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
