import type { chat_v1 } from "googleapis";
import { clip } from "../text";
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
  return {
    text,
    cardsV2: [
      {
        cardId: "sources",
        card: {
          sections: [
            {
              header: `Sources (${answer.citations.length})`,
              collapsible: true,
              uncollapsibleWidgetsCount: 0,
              widgets: answer.citations.map((c) => ({ textParagraph: { text: sourceHtml(c) } })),
            },
          ],
        },
      },
    ],
  };
}

export function renderProgress(message: string): string {
  return `🔎 _${plain(message).replace(/_/g, " ")}_`;
}

// Card text uses Chat's small HTML subset: <b>, <a href>, <br>, <font color>.
function sourceHtml(c: Citation): string {
  const label = SOURCE_LABELS[c.source];
  const title = escapeHtml(clip(c.title, 120));
  const url = safeUrl(c.url);
  const meta = [label, c.container !== label ? c.container : null, c.updatedAt.slice(0, 10)]
    .filter(Boolean)
    .map((part) => escapeHtml(part!))
    .join(" · ");
  const link = url ? `<a href="${escapeHtml(url)}">${title}</a>` : title;
  return `<b>${c.n}.</b> ${link}<br><font color="#80868b">${meta}</font>`;
}

function safeUrl(url: string | null | undefined): string | null {
  return url && /^https:\/\/[^\s<>|"]+$/.test(url) ? url : null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
