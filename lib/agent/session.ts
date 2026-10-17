import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config";
import { postgres } from "../postgres";
import { errorMessage } from "../text";
import { runAgentTool, toolProgress } from "./tools";

// The Managed Agent (npm run managed-agent creates it). Each person gets one session per conversation, a DM or a
// thread or a space's main flow, so the agent remembers what was said there. Sessions are kept in Postgres:
//   agent_sessions(conversation, asker, session_id, created_at), created on first use, row level security on.

export class AgentError extends Error {}

// Under Vercel's 300 s limit, with room to post the reply.
const TURN_LIMIT_MS = 240_000;
const RECONNECTS = 2;

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export function agentConfigured(): boolean {
  return Boolean(env("MA_AGENT_ID") && env("MA_ENVIRONMENT_ID"));
}

const localSessions = new Map<string, string>();
let tableReady: Promise<void> | undefined;

function sessionTable(): Promise<void> {
  const db = postgres();
  tableReady ??= db
    ? db
        .query(
          "create table if not exists agent_sessions (conversation text not null, asker text not null, session_id text not null, created_at timestamptz not null default now(), primary key (conversation, asker))",
        )
        .then(() => db.query("alter table agent_sessions enable row level security"))
        .then(() => undefined)
        .catch((err) => {
          tableReady = undefined;
          throw err;
        })
    : Promise.resolve();
  return tableReady;
}

async function storedSession(conversation: string, asker: string): Promise<string | undefined> {
  const db = postgres();
  if (!db) return localSessions.get(`${conversation}\u0000${asker}`);
  await sessionTable();
  const res = await db.query<{ session_id: string }>("select session_id from agent_sessions where conversation = $1 and asker = $2", [conversation, asker]);
  return res.rows[0]?.session_id;
}

async function storeSession(conversation: string, asker: string, sessionId: string): Promise<void> {
  const db = postgres();
  if (!db) {
    localSessions.set(`${conversation}\u0000${asker}`, sessionId);
    return;
  }
  await sessionTable();
  await db.query(
    "insert into agent_sessions (conversation, asker, session_id) values ($1, $2, $3) on conflict (conversation, asker) do update set session_id = excluded.session_id, created_at = now()",
    [conversation, asker, sessionId],
  );
}

let latest: { at: number; version: Promise<number | undefined> } | undefined;

/** The agent's current version, read again every 5 minutes. */
function latestAgentVersion(): Promise<number | undefined> {
  if (!latest || Date.now() - latest.at > 5 * 60_000) {
    latest = {
      at: Date.now(),
      version: anthropic()
        .beta.agents.retrieve(env("MA_AGENT_ID")!)
        .then((agent) => agent.version)
        .catch(() => undefined),
    };
  }
  return latest.version;
}

/**
 * This person's session for this conversation: the stored one while it can still take messages and runs the agent's
 * current version, else a new one. A session keeps the version it started with, so after an update (new tools, a new
 * skill) the conversation starts fresh rather than missing the change.
 */
async function sessionFor(conversation: string, asker: string): Promise<string> {
  const stored = await storedSession(conversation, asker);
  if (stored) {
    const [session, version] = await Promise.all([anthropic().beta.sessions.retrieve(stored).catch(() => null), latestAgentVersion()]);
    const open = session && session.status !== "terminated" && !session.archived_at;
    const current = version === undefined || session?.agent?.version === version;
    if (open && current) return stored;
  }
  const vaults = [env("MA_FIREFLIES_VAULT_ID")].filter((v): v is string => Boolean(v));
  const session = await anthropic().beta.sessions.create({
    agent: env("MA_AGENT_ID")!,
    environment_id: env("MA_ENVIRONMENT_ID")!,
    vault_ids: vaults,
    title: `Chat: ${asker}`,
    metadata: { conversation: conversation.slice(0, 500), asker: asker.slice(0, 500) },
  });
  await storeSession(conversation, asker, session.id);
  return session.id;
}

export interface AgentAsk {
  /** A DM space, a thread, or a space's main flow. */
  conversation: string;
  /** The verified email of the person asking. */
  asker: string;
  /** The <context> block and the question. */
  prompt: string;
  onProgress?: (message: string) => void;
}

type SessionEvent = { id: string; type: string; [key: string]: unknown };

/**
 * One turn: sends the question, runs the agent's custom tools here as it calls them, and returns its answer. A dropped
 * stream is reopened and the events missed meanwhile are read back, so no tool call is left unanswered.
 */
export async function askAgent(ask: AgentAsk): Promise<string> {
  const c = anthropic();
  const sessionId = await sessionFor(ask.conversation, ask.asker);
  const deadline = Date.now() + TURN_LIMIT_MS;
  const seen = new Set<string>();
  const pending: Promise<void>[] = [];
  // Text written before a tool call is the agent thinking aloud; the answer is what it writes after the last one.
  let answer: string[] = [];
  let failure: string | undefined;
  let sentId: string | undefined;

  const reply = (event: SessionEvent) =>
    pending.push(
      (async () => {
        // Personal tools read as the person asking: the verified Chat sender, never what the model passes.
        const outcome = await runAgentTool(String(event.name), event.input, ask.asker);
        await c.beta.sessions.events.send(sessionId, {
          events: [{ type: "user.custom_tool_result", custom_tool_use_id: event.id, content: [{ type: "text", text: outcome.text }], is_error: outcome.isError }],
        });
      })().catch((err) => {
        failure = `A tool failed to answer: ${errorMessage(err)}`;
      }),
    );

  /** Handles one event; true when the turn is over. */
  const handle = (event: SessionEvent): boolean => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    switch (event.type) {
      case "agent.message": {
        const content = (event.content as { type: string; text?: string }[] | undefined) ?? [];
        answer.push(...content.filter((b) => b.type === "text" && b.text).map((b) => b.text!));
        return false;
      }
      case "agent.custom_tool_use":
        answer = [];
        ask.onProgress?.(toolProgress(String(event.name)));
        reply(event);
        return false;
      case "agent.mcp_tool_use":
      case "agent.tool_use":
        answer = [];
        ask.onProgress?.(toolProgress(String(event.name)));
        return false;
      case "session.error":
        failure = errorMessage((event as { error?: { message?: string } }).error?.message ?? "the agent reported an error");
        return false;
      case "session.status_idle": {
        const stop = (event.stop_reason as { type?: string } | undefined)?.type;
        if (stop === "requires_action") return false;
        if (stop !== "end_turn") failure = stop === "budget_reached" ? "The agent reached its spending limit." : `The agent stopped (${stop ?? "unknown"}).`;
        return true;
      }
      case "session.status_terminated":
        failure ??= "The agent's session ended.";
        return true;
    }
    return false;
  };

  let done = false;
  for (let attempt = 0; attempt <= RECONNECTS && !done; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try {
      const stream = await c.beta.sessions.events.stream(sessionId, undefined, { signal: controller.signal });
      if (attempt === 0) {
        // Stream first, then send: nothing the agent does in between is missed.
        const sent = await c.beta.sessions.events.send(sessionId, { events: [{ type: "user.message", content: [{ type: "text", text: ask.prompt }] }] });
        sentId = sent.data?.[0]?.id;
      } else {
        for (const event of await eventsSince(sessionId, sentId)) if ((done = handle(event))) break;
      }
      if (!done) {
        for await (const event of stream as AsyncIterable<SessionEvent>) if ((done = handle(event))) break;
      }
    } catch (err) {
      if (Date.now() >= deadline) break;
      if (attempt === RECONNECTS) throw new AgentError(`Lost the connection to the agent: ${errorMessage(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() >= deadline) break;
  }
  await Promise.all(pending);

  if (!done) {
    await c.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] }).catch(() => undefined);
    throw new AgentError("This is taking longer than I can wait. Please ask again, maybe a little more narrowly.");
  }
  const text = answer.join("\n\n").trim();
  if (!text) throw new AgentError(failure ?? "The agent gave no answer. Please ask again.");
  return text;
}

/** The session's events after our message, oldest first, to catch up after a dropped stream. */
async function eventsSince(sessionId: string, afterId: string | undefined): Promise<SessionEvent[]> {
  const all: SessionEvent[] = [];
  for await (const event of anthropic().beta.sessions.events.list(sessionId)) all.push(event as unknown as SessionEvent);
  const from = afterId ? all.findIndex((e) => e.id === afterId) : -1;
  return from >= 0 ? all.slice(from + 1) : all;
}
