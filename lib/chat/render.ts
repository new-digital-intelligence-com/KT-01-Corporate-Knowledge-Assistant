import { SOURCE_LABELS, type AnswerStatus, type FinalAnswer } from "../types";

// Google Chat's own formatting: *bold*, _italic_, <url|text> links, "- " lists.
const STATUS: Record<AnswerStatus, string> = {
  verified: "✅ *Verified against company sources*",
  partially_verified: "⚠️ *Partly verified:* some statements aren't fully backed by the sources",
  not_found: "🔍 *Not found in company sources*",
};

/**
 * In Chat text, `<…>` creates links and mentions (`<users/all>` notifies everyone). Text that comes
 * from documents or from the model is neutralised before the bot adds its own markup.
 */
export function plain(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

export function renderAnswer(answer: FinalAnswer): string {
  const byNumber = new Map(answer.citations.map((c) => [c.n, c]));
  const body = plain(answer.text)
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/\[(\d+)\]/g, (marker, n: string) => {
      const url = safeUrl(byNumber.get(Number(n))?.url);
      return url ? `<${url}|[${n}]>` : marker;
    });

  const parts = [STATUS[answer.status], body];

  if (answer.conflicts.length) {
    parts.push(`*Sources disagree:*\n${answer.conflicts.map((c) => `- ${plain(c)}`).join("\n")}`);
  }

  const flagged = answer.checks.filter((c) => c.verdict !== "supported");
  if (answer.status === "partially_verified" && flagged.length) {
    parts.push(`*Not fully backed by the sources:*\n${flagged.map((c) => `- ${plain(c.claim)}`).join("\n")}`);
  }

  if (answer.citations.length) {
    const lines = answer.citations.map((c) => {
      const url = safeUrl(c.url);
      const title = url ? `<${url}|${linkText(c.title)}>` : plain(c.title);
      const meta = [SOURCE_LABELS[c.source], plain(c.container), c.updatedAt.slice(0, 10)].filter(Boolean).join(" · ");
      return `${c.n}. ${title} (${meta})`;
    });
    parts.push(`*Sources*\n${lines.join("\n")}`);
  }

  return parts.join("\n\n");
}

export function renderProgress(message: string): string {
  return `🔎 _${plain(message).replace(/_/g, " ")}_`;
}

function safeUrl(url: string | null | undefined): string | null {
  return url && /^https:\/\/[^\s<>|]+$/.test(url) ? url : null;
}

function linkText(text: string): string {
  return text.replace(/[<>|]/g, " ").slice(0, 120);
}
