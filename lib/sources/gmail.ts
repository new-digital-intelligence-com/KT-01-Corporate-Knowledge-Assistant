import { google, type gmail_v1 } from "googleapis";
import { env, envList } from "../config";
import { upsertDocument } from "../db";
import { errorMessage, htmlToText } from "../text";
import { GOOGLE_SCOPES, googleAuth, googleConfigured, userAuthConfigured } from "./google";
import type { SyncContext } from "./types";

const DEFAULT_QUERY = "-in:spam -in:trash -in:chats -category:promotions -category:social";

export function gmailConfigured(): boolean {
  return googleConfigured() && (userAuthConfigured() || envList("GMAIL_MAILBOXES").length > 0);
}

/** One document per email thread, for each mailbox listed in GMAIL_MAILBOXES only. */
export async function syncGmail(ctx: SyncContext): Promise<number> {
  const query = `${env("GMAIL_QUERY") ?? DEFAULT_QUERY} after:${Math.floor(ctx.since.getTime() / 1000)}`;
  let updated = 0;

  // Signed in as a person, the API can only read that person's own mailbox ("me").
  const mailboxes = userAuthConfigured() ? ["me"] : envList("GMAIL_MAILBOXES");
  for (const configured of mailboxes) {
    const gmail = google.gmail({ version: "v1", auth: googleAuth(configured, GOOGLE_SCOPES.gmail) });
    const mailbox =
      configured === "me" ? ((await gmail.users.getProfile({ userId: "me" })).data.emailAddress ?? "me") : configured;
    let seen = 0;
    let pageToken: string | undefined;

    do {
      const res = await gmail.users.threads.list({ userId: "me", q: query, maxResults: 100, pageToken });
      pageToken = res.data.nextPageToken ?? undefined;

      for (const { id } of res.data.threads ?? []) {
        if (!id) continue;
        if (seen++ >= ctx.maxItems) {
          ctx.log(`gmail: ${mailbox} reached SYNC_MAX_ITEMS_PER_SOURCE, older threads skipped`);
          pageToken = undefined;
          break;
        }
        try {
          const thread = await gmail.users.threads.get({ userId: "me", id, format: "full" });
          const messages = thread.data.messages ?? [];
          if (!messages.length) continue;
          const saved = upsertDocument({
            id: `gmail:${mailbox}:${id}`,
            source: "gmail",
            title: header(messages[0], "Subject") || "(no subject)",
            url: `https://mail.google.com/mail/u/${mailbox}/#all/${id}`,
            container: mailbox,
            author: header(messages[0], "From") || null,
            updatedAt: messageDate(messages.at(-1)!),
            text: messages
              .map((m) => `[${messageDate(m).slice(0, 16).replace("T", " ")}] ${header(m, "From")}:\n${stripQuoted(bodyText(m.payload))}`)
              .join("\n\n"),
          });
          if (saved) updated++;
        } catch (err) {
          ctx.log(`gmail: ${mailbox} thread ${id} skipped (${errorMessage(err)})`);
        }
      }
    } while (pageToken);
  }
  return updated;
}

function header(message: gmail_v1.Schema$Message, name: string): string {
  const wanted = name.toLowerCase();
  return message.payload?.headers?.find((h) => h.name?.toLowerCase() === wanted)?.value ?? "";
}

function messageDate(message: gmail_v1.Schema$Message): string {
  return new Date(Number(message.internalDate ?? Date.now())).toISOString();
}

function bodyText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  const plain = findPart(part, "text/plain");
  if (plain) return decode(plain);
  const html = findPart(part, "text/html");
  return html ? htmlToText(decode(html)) : "";
}

function findPart(part: gmail_v1.Schema$MessagePart, mimeType: string): string | undefined {
  if (part.mimeType === mimeType && part.body?.data) return part.body.data;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

function decode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** Drop the quoted history each reply repeats; the earlier messages are already in the thread. */
function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((l) => {
    const t = l.trim();
    return /^On .+wrote:$/.test(t) || /^Le .+a écrit\s?:$/.test(t) || t.startsWith("-----Original Message-----");
  });
  return (cut >= 0 ? lines.slice(0, cut) : lines)
    .filter((l) => !l.startsWith(">"))
    .join("\n")
    .trim();
}
