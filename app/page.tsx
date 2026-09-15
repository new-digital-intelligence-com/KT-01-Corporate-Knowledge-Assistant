"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  SOURCE_LABELS,
  type AssistantEvent,
  type FinalAnswer,
  type HistoryTurn,
  type IndexStats,
  type Source,
  type Verdict,
} from "@/lib/types";
import styles from "./page.module.css";

interface Turn {
  id: number;
  question: string;
  progress: string[];
  answer?: FinalAnswer;
  error?: string;
  done: boolean;
}

const EXAMPLES = [
  "What is our remote work policy?",
  "How do I submit an expense claim, and is there a deadline?",
  "What did we decide about pricing for next quarter?",
];

const VERDICT: Record<Verdict, { mark: string; label: string; className: string }> = {
  supported: { mark: "✓", label: "Supported", className: styles.verdictSupported },
  partial: { mark: "≈", label: "Partly supported", className: styles.verdictPartial },
  unsupported: { mark: "✗", label: "Not supported", className: styles.verdictUnsupported },
};

const PILL: Record<Source, string> = {
  slack: styles.pillSlack,
  drive: styles.pillDrive,
  gmail: styles.pillGmail,
  gchat: styles.pillChat,
};

export default function Home() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [stats, setStats] = useState<IndexStats | null | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => !t.done);

  useEffect(() => {
    fetch("/api/status")
      .then((res) => (res.ok ? res.json() : null))
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  function update(id: number, change: (turn: Turn) => Turn) {
    setTurns((all) => all.map((t) => (t.id === id ? change(t) : t)));
  }

  function handle(id: number, event: AssistantEvent) {
    if (event.type === "progress") update(id, (t) => ({ ...t, progress: [...t.progress, event.message] }));
    else if (event.type === "answer") update(id, (t) => ({ ...t, answer: event.answer }));
    else update(id, (t) => ({ ...t, error: event.message }));
  }

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    const id = Date.now();
    const history: HistoryTurn[] = turns
      .filter((t) => t.answer)
      .slice(-3)
      .map((t) => ({ question: t.question, answer: t.answer!.text }));
    setTurns((all) => [...all, { id, question, progress: [], done: false }]);
    setInput("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) handle(id, JSON.parse(line) as AssistantEvent);
        if (done) break;
      }
      if (buffer.trim()) handle(id, JSON.parse(buffer) as AssistantEvent);
    } catch (err) {
      update(id, (t) => ({ ...t, error: err instanceof Error ? err.message : "Something went wrong." }));
    } finally {
      update(id, (t) => ({ ...t, done: true }));
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Company Knowledge Assistant</h1>
          <p className={styles.subtitle}>Searches Google Drive, Gmail and Google Chat live, and checks every answer against what it read.</p>
        </div>
        <IndexSummary stats={stats} />
      </header>

      <main className={styles.thread}>
        {turns.length === 0 && (
          <div className={styles.empty}>
            <p>Ask anything about how the company works. Every answer links to the messages and documents it comes from.</p>
            <div className={styles.examples}>
              {EXAMPLES.map((example) => (
                <button key={example} type="button" className={styles.example} onClick={() => ask(example)}>
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
        <div ref={endRef} />
      </main>

      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <div className={styles.composerInner}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={2}
            placeholder="Ask a question…"
            aria-label="Your question"
          />
          <button type="submit" disabled={busy || !input.trim()}>
            {busy ? "Working…" : "Ask"}
          </button>
        </div>
      </form>
    </div>
  );
}

function IndexSummary({ stats }: { stats: IndexStats | null | undefined }) {
  if (stats === undefined) return null;
  if (stats === null) return <p className={styles.indexWarning}>Index unavailable</p>;
  if (!stats.liveGoogle && stats.documents === 0) {
    return <p className={styles.indexWarning}>No sources connected: run npm run google-login</p>;
  }
  return (
    <ul className={styles.index} aria-label="Sources">
      {stats.liveGoogle && <li className={styles.indexItem}>Live: Google Drive · Gmail · Google Chat</li>}
      {stats.sources
        .filter((s) => s.documents > 0)
        .map((s) => (
          <li key={s.source} className={styles.indexItem} title={s.lastSync ? `Last synced ${formatDate(s.lastSync)}` : undefined}>
            {SOURCE_LABELS[s.source]} · {s.documents.toLocaleString()}
          </li>
        ))}
    </ul>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const working = !turn.done && !turn.answer && !turn.error;
  return (
    <section className={styles.turn}>
      <p className={styles.question}>{turn.question}</p>
      {working && (
        <div className={styles.progress} aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <ul>
            {(turn.progress.length ? turn.progress.slice(-4) : ["Starting…"]).map((message, i) => (
              <li key={i}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {turn.error && <p className={styles.error}>{turn.error}</p>}
      {turn.answer && <AnswerView answer={turn.answer} turn={turn} />}
    </section>
  );
}

function AnswerView({ answer, turn }: { answer: FinalAnswer; turn: Turn }) {
  return (
    <article className={styles.answer}>
      <div className={styles.answerText}>{renderText(answer.text, turn.id)}</div>

      {answer.conflicts.length > 0 && (
        <div className={styles.conflicts}>
          <strong>Sources disagree</strong>
          <ul>
            {answer.conflicts.map((conflict, i) => (
              <li key={i}>{conflict}</li>
            ))}
          </ul>
        </div>
      )}

      {answer.citations.length > 0 && (
        <details className={styles.sourcesDetails}>
          <summary>Sources ({answer.citations.length})</summary>
          <ol className={styles.sources}>
          {answer.citations.map((c) => (
            <li key={c.n} id={`cite-${turn.id}-${c.n}`} className={styles.source}>
              <div className={styles.sourceHead}>
                <span className={styles.sourceNum}>{c.n}</span>
                <span className={`${styles.pill} ${PILL[c.source]}`}>{SOURCE_LABELS[c.source]}</span>
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noopener noreferrer">
                    {c.title}
                  </a>
                ) : (
                  <span>{c.title}</span>
                )}
              </div>
              <div className={styles.sourceMeta}>{[c.container, c.author, formatDate(c.updatedAt)].filter(Boolean).join(" · ")}</div>
              <blockquote className={styles.excerpt}>{c.excerpt}</blockquote>
            </li>
          ))}
          </ol>
        </details>
      )}

      <details className={styles.checks}>
        <summary>How this answer was checked</summary>
        {answer.checks.length > 0 ? (
          <ul className={styles.checkList}>
            {answer.checks.map((check, i) => {
              const verdict = VERDICT[check.verdict];
              return (
                <li key={i} className={`${styles.check} ${verdict.className}`}>
                  <span className={styles.mark} title={verdict.label} aria-label={verdict.label}>
                    {verdict.mark}
                  </span>
                  <span>
                    {check.claim}
                    {check.note && <span className={styles.note}> {check.note}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>No factual statements to check.</p>
        )}
        {answer.rewritten && (
          <p>The first draft contained statements the sources didn&apos;t back, so it was rewritten and checked again.</p>
        )}
        <ol className={styles.steps}>
          {turn.progress.map((message, i) => (
            <li key={i}>{message}</li>
          ))}
        </ol>
      </details>
    </article>
  );
}

function renderText(text: string, turnId: number): ReactNode[] {
  return text.split(/\n{2,}/).map((block, i) => {
    const lines = block.split("\n").filter((line) => line.trim());
    if (lines.length && lines.every((line) => /^\s*[-•*]\s+/.test(line))) {
      return (
        <ul key={i}>
          {lines.map((line, j) => (
            <li key={j}>{renderInline(line.replace(/^\s*[-•*]\s+/, ""), turnId)}</li>
          ))}
        </ul>
      );
    }
    return (
      <p key={i}>
        {lines.map((line, j) => (
          <span key={j}>
            {j > 0 && <br />}
            {renderInline(line, turnId)}
          </span>
        ))}
      </p>
    );
  });
}

function renderInline(text: string, turnId: number): ReactNode[] {
  return text
    .split(/(\[\d+\]|\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, i) => {
      const cite = /^\[(\d+)\]$/.exec(part);
      if (cite) {
        return (
          <a key={i} href={`#cite-${turnId}-${cite[1]}`} className={styles.cite} aria-label={`Source ${cite[1]}`}>
            {cite[1]}
          </a>
        );
      }
      if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
      return part;
    });
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
