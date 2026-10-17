import type { chat_v1 } from "googleapis";
import { clip, hideSecrets } from "../text";
import { SOURCE_LABELS, type Citation, type FinalAnswer } from "../types";

/** A Chat message: text, plus cards for anything that needs layout (like a collapsible list). */
export interface ChatReply {
  text: string;
  cardsV2?: chat_v1.Schema$CardWithId[];
}

/**
 * In Chat text, `<…>` creates links and mentions (`<users/all>` notifies everyone). Text that comes
 * from documents or from the model is neutralised before the bot adds its own markup.
 */
export function plain(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

/** The answer as text with linked [n] markers, and its sources in a card section that starts collapsed. */
export function renderAnswer(answer: FinalAnswer): ChatReply {
  const byNumber = new Map(answer.citations.map((c) => [c.n, c]));
  const text = plain(answer.text)
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/\[(\d+)\]/g, (marker, n: string) => {
      const url = safeUrl(byNumber.get(Number(n))?.url);
      return url ? `<${url}|[${n}]>` : marker;
    });

  if (!answer.citations.length) return { text };
  return { text, cardsV2: [sourcesCard(answer.citations.map(sourceHtml))] };
}

/**
 * The Managed Agent's answer as a Chat message. Its bold titles and names, "- " lists and links stay Chat text (a
 * Markdown heading or a "* " bullet is turned into those), and every link is also listed in a collapsible Sources card.
 */
export function renderAgentReply(answer: string): ChatReply {
  const sources: { title: string; url: string }[] = [];
  let text = plain(hideSecrets(answer))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*$/.exec(line);
      if (heading) return heading[1] ? `**${heading[1].replace(/\*\*/g, "")}**` : "";
      return line.replace(/^(\s*)[*•]\s+/, "$1- ");
    })
    .join("\n")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)<>|"]+)\)/g, (_, label: string, url: string) => {
      const title = label.replace(/[*|‹›]/g, "").trim() || url;
      if (!sources.some((s) => s.url === url)) sources.push({ title, url });
      return `<${url}|${title}>`;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // A closing "Sources: …" paragraph would only repeat the card.
  const paragraphs = text.split("\n\n");
  const last = paragraphs[paragraphs.length - 1];
  if (paragraphs.length > 1 && /^\*?sources?\b/i.test(last) && last.includes("<https://")) {
    text = paragraphs.slice(0, -1).join("\n\n");
  }

  if (!sources.length) return { text };
  return { text, cardsV2: [sourcesCard(sources.map((s, i) => entryHtml(i + 1, s.title, s.url, linkKind(s.url))))] };
}

export function renderProgress(message: string): string {
  return `🔎 _${plain(message).replace(/_/g, " ")}_`;
}

/** The "Sources (n)" card: one collapsed section, one line per source. */
function sourcesCard(entries: string[]): chat_v1.Schema$CardWithId {
  return {
    cardId: "sources",
    card: {
      sections: [
        {
          header: `Sources (${entries.length})`,
          collapsible: true,
          uncollapsibleWidgetsCount: 0,
          widgets: entries.map((text) => ({ textParagraph: { text } })),
        },
      ],
    },
  };
}

function sourceHtml(c: Citation): string {
  const label = SOURCE_LABELS[c.source];
  const meta = [label, c.container !== label ? c.container : null, c.updatedAt.slice(0, 10)].filter(Boolean).join(" · ");
  return entryHtml(c.n, c.title, c.url, meta);
}

// Card text uses Chat's small HTML subset: <b>, <a href>, <br>, <font color>.
function entryHtml(n: number, title: string, url: string | null | undefined, meta: string): string {
  const name = escapeHtml(clip(title, 120));
  const safe = safeUrl(url);
  const link = safe ? `<a href="${escapeHtml(safe)}">${name}</a>` : name;
  return `<b>${n}.</b> ${link}${meta ? `<br><font color="#80868b">${escapeHtml(meta)}</font>` : ""}`;
}

/** What a link points at, for the Sources card: "Google Sheets", "Fireflies", "Slack"… */
function linkKind(url: string): string {
  let host: string;
  let path: string;
  try {
    ({ hostname: host, pathname: path } = new URL(url));
  } catch {
    return "";
  }
  host = host.replace(/^www\./, "");
  if (host === "docs.google.com") {
    if (path.startsWith("/document/")) return "Google Docs";
    if (path.startsWith("/spreadsheets/")) return "Google Sheets";
    if (path.startsWith("/presentation/")) return "Google Slides";
    if (path.startsWith("/forms/")) return "Google Forms";
    return "Google Drive";
  }
  if (host.endsWith(".slack.com")) return "Slack";
  return LINK_KINDS[host] ?? host;
}

const LINK_KINDS: Record<string, string> = {
  "drive.google.com": "Google Drive",
  "mail.google.com": "Gmail",
  "calendar.google.com": "Google Calendar",
  "chat.google.com": "Google Chat",
  "app.fireflies.ai": "Fireflies",
  "youtube.com": "YouTube",
  "youtu.be": "YouTube",
};

function safeUrl(url: string | null | undefined): string | null {
  return url && /^https:\/\/[^\s<>|"]+$/.test(url) ? url : null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
