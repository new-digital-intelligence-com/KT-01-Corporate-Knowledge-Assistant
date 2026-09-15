import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { model } from "./config";
import { getChunks, getDocumentChunks, getStats, type ChunkRow } from "./db";
import { searchChunks } from "./search";
import { clip } from "./text";
import {
  SOURCES,
  SOURCE_LABELS,
  type AnswerStatus,
  type AssistantEvent,
  type Citation,
  type FinalAnswer,
  type HistoryTurn,
  type Source,
} from "./types";

type Emit = (event: AssistantEvent) => void;
type Passages = Map<number, ChunkRow>;

export class AssistantError extends Error {}

const MAX_TOOL_ROUNDS = 8;
const MARKER = /\[#(\d+)\]/g;

// Server-side refusal fallback: if the model declines, the API re-runs the request on a
// suitable fallback model inside the same call instead of returning an empty refusal.
const BETAS: Anthropic.Beta.AnthropicBeta[] = ["server-side-fallback-2026-07-01"];

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_company_knowledge",
    description:
      "Keyword search over the company's indexed Slack channels, Google Drive files, Gmail threads and Google Chat spaces. " +
      "Returns the best-matching passages with their id, source, title, location, author and date. " +
      "Use short keyword queries rather than full sentences, and search again with synonyms or another language when a search misses.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'expense claim deadline'" },
        sources: {
          type: "array",
          items: { type: "string", enum: [...SOURCES] },
          description: "Optional: only search these sources",
        },
        limit: { type: "integer", minimum: 1, maximum: 15, description: "Maximum passages to return (default 8)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_document",
    description:
      "Read the whole document a passage comes from (the full Slack thread, email thread, chat thread or file), " +
      "returned as passages with ids you can cite.",
    input_schema: {
      type: "object",
      properties: { passage_id: { type: "integer", description: "Any passage id from search results" } },
      required: ["passage_id"],
      additionalProperties: false,
    },
  },
];

function answerSystemPrompt(): string {
  return `You are the internal knowledge assistant for our company. Staff ask you questions, and you answer them only from company sources: Slack channels, Google Drive files, Gmail threads and Google Chat spaces, which you reach through the search_company_knowledge and read_document tools. Nobody reviews your answers before staff read them, so they have to be accurate on their own.

Today's date is ${new Date().toISOString().slice(0, 10)}.

How to answer:
- Search before you answer, even when you think you know. Run several short keyword searches: synonyms, the wording an official document would use, and both English and the language of the question. Open a document with read_document when a passage looks relevant but incomplete.
- Put citation markers right after each sentence they support, using passage ids, like [#123] or [#123][#456]. Every sentence that states something about the company needs at least one marker. Only cite ids that a tool returned in this conversation.
- Use only what the passages say. Don't fill gaps with general knowledge or assumptions about how companies usually work.
- Sources can be outdated or disagree. Prefer the most recent and most authoritative one (an official document over a passing chat remark), give its date when timing matters, and say plainly when sources conflict, citing each side.
- If the passages don't answer the question, say you couldn't find it in company sources, mention anything related you did find, and suggest who or which channel might know. Don't guess.
- Reply in the language of the question. Lead with the direct answer, then only the details that matter, in a few sentences or a short list. Plain text: use "- " for list items and no headings.`;
}

const VERIFY_SYSTEM = `You fact-check answers written by a company knowledge assistant before staff see them. You receive the question, the passages the answer cites, and the draft answer, whose citation markers like [#123] refer to passage ids.

Break the draft into its individual factual claims and judge each one strictly against the passages it cites:
- supported: the cited passages state it, directly or as a plain paraphrase.
- partial: the cited passages back only part of it, or the claim is broader, more certain or more specific (numbers, dates, names, deadlines) than they are.
- unsupported: the cited passages don't state it, or the claim has no citation. Judge only against the passages, never by whether it's true in general.
Sentences that only say something couldn't be found, or suggest where to look, are not claims; leave them out.

In each note, say briefly why, quoting the passage wording when that helps; leave the note empty for a plainly supported claim.
Under conflicts, list disagreements between passages that matter for the question (different figures, dates or rules); otherwise leave it empty.
Set is_not_found_answer to true only when the draft's main message is that the answer isn't in company sources.
Write claims and notes in the language of the draft.`;

const REWRITE_SYSTEM = `You revise answers from a company knowledge assistant so that every statement is backed by the passages provided. Staff read the result without anyone reviewing it.

Keep what the passages support, correct partially supported statements so they say exactly what the passages say, and remove anything the passages don't support. Put citation markers with passage ids, like [#123], right after each sentence they support, citing only the passages provided. If nothing substantive remains, say the answer couldn't be found in company sources. Keep the language, the directness and the plain-text format of the draft ("- " for list items, no headings). Output only the revised answer.`;

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
): Promise<void> {
  if (getStats().documents === 0) {
    throw new AssistantError("The knowledge index is empty. Run `npm run sync` first (see SETUP.md).");
  }

  const passages: Passages = new Map();
  emit({ type: "progress", message: "Searching company sources…" });
  let draft = keepKnownMarkers(await research(question, history, passages, emit, signal), passages);

  emit({ type: "progress", message: `Checking the answer against ${citedIds(draft).length} cited passage(s)…` });
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
async function research(
  question: string,
  history: HistoryTurn[],
  passages: Passages,
  emit: Emit,
  signal?: AbortSignal,
): Promise<string> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const turn of history) {
    messages.push({ role: "user", content: turn.question }, { role: "assistant", content: stripMarkers(turn.answer) });
  }
  messages.push({ role: "user", content: question });

  for (let round = 0; ; round++) {
    const message = await anthropic()
      .beta.messages.stream(
        {
          model: model(),
          max_tokens: 64000,
          betas: BETAS,
          fallbacks: "default",
          cache_control: { type: "ephemeral" },
          system: answerSystemPrompt(),
          tools: TOOLS,
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

    const results: Anthropic.Beta.BetaContentBlockParam[] = calls.map((call) => ({
      type: "tool_result",
      tool_use_id: call.id,
      ...runTool(call, passages, emit),
    }));
    if (round + 1 >= MAX_TOOL_ROUNDS) {
      results.push({ type: "text", text: "That was your last search. Answer now from the passages you already have." });
    }
    messages.push({ role: "user", content: results });
  }
}

function runTool(
  call: Anthropic.Beta.BetaToolUseBlock,
  passages: Passages,
  emit: Emit,
): { content: string; is_error?: boolean } {
  const input = (call.input ?? {}) as Record<string, unknown>;

  if (call.name === "search_company_knowledge") {
    const query = typeof input.query === "string" ? input.query : "";
    const sources = Array.isArray(input.sources)
      ? input.sources.filter((s): s is Source => (SOURCES as readonly unknown[]).includes(s))
      : undefined;
    const limit = typeof input.limit === "number" ? Math.min(Math.max(Math.round(input.limit), 1), 15) : 8;
    const hits = searchChunks(query, sources, limit);
    hits.forEach((hit) => passages.set(hit.chunkId, hit));

    const where = sources?.length ? sources.map((s) => SOURCE_LABELS[s]).join(", ") : "all sources";
    emit({ type: "progress", message: `Searched ${where} for “${query}”: ${hits.length} passage${hits.length === 1 ? "" : "s"}` });
    return {
      content: hits.length
        ? hits.map((hit) => formatPassage(hit, 1500)).join("\n\n")
        : "No passages matched. Try other keywords, synonyms or another language.",
    };
  }

  if (call.name === "read_document") {
    const [passage] = getChunks([Number(input.passage_id)]);
    if (!passage) return { content: `There is no passage with id ${String(input.passage_id)}.`, is_error: true };
    const document = getDocumentChunks(passage.docId).slice(0, 40);
    document.forEach((chunk) => passages.set(chunk.chunkId, chunk));
    emit({ type: "progress", message: `Read “${clip(passage.title, 70)}” (${SOURCE_LABELS[passage.source]})` });
    return { content: document.map((chunk) => formatPassage(chunk, 4000)).join("\n\n") };
  }

  return { content: `Unknown tool: ${call.name}`, is_error: true };
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
  const numbers = new Map<number, number>();
  const citations: Citation[] = [];

  let text = draft
    .replace(MARKER, (_, raw: string) => {
      const id = Number(raw);
      const passage = passages.get(id);
      if (!passage) return "";
      if (!numbers.has(id)) {
        numbers.set(id, citations.length + 1);
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
      return `[${numbers.get(id)}]`;
    })
    .replace(/(\[\d+\])\1+/g, "$1")
    .trim();

  const unbacked = check.claims.filter((c) => c.verdict !== "supported").length;
  let status: AnswerStatus;
  if (check.is_not_found_answer) {
    status = "not_found";
  } else if (citations.length === 0) {
    // Claims with nothing behind them are never shown as an answer.
    status = "not_found";
    if (check.claims.length > 0) text = "I couldn't find a reliable answer to this in company sources.";
  } else {
    status = unbacked === 0 ? "verified" : "partially_verified";
  }

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
  return [...new Set([...text.matchAll(MARKER)].map((m) => Number(m[1])))];
}

/** Code-level check: a citation must point at a passage a tool actually returned. */
function keepKnownMarkers(text: string, passages: Passages): string {
  return text.replace(MARKER, (marker, id: string) => (passages.has(Number(id)) ? marker : ""));
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
