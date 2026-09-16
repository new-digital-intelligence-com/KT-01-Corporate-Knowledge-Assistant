import { getDb } from "../db";
import { postgres } from "../postgres";
import type { HistoryTurn } from "../types";

// Conversation memory and delivery dedupe. A Postgres database (Supabase) when DATABASE_URL is set: it
// survives restarts and is shared by every Vercel instance. Otherwise the local SQLite file, which on
// Vercel is wiped regularly.
//
// Postgres tables (created once in the Supabase SQL editor, row level security on):
//   chat_turns(id identity, conversation, asker, question, answer, status, created_at)
//   chat_deliveries(id primary key, status, claimed_at)

type Turn = { conversation: string; asker: string | null; question: string; answer: string; status: string };

export function memoryBackend(): "postgres" | "sqlite" {
  return postgres() ? "postgres" : "sqlite";
}

let ready = false;

function local() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS chat_deliveries (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation TEXT NOT NULL,
        asker TEXT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_turns_conversation ON chat_turns(conversation, id);
    `);
    ready = true;
  }
  return d;
}

/**
 * Chat can deliver the same event more than once. Returns false when this event is already being
 * handled or was answered, so a repeated delivery doesn't produce a second reply.
 */
export async function claimEvent(id: string): Promise<boolean> {
  const db = postgres();
  if (db) {
    const res = await db.query("insert into chat_deliveries (id, status) values ($1, 'working') on conflict (id) do nothing", [id]);
    return res.rowCount === 1;
  }
  return (
    local()
      .prepare("INSERT OR IGNORE INTO chat_deliveries (id, status, claimed_at) VALUES (?, 'working', ?)")
      .run(id, new Date().toISOString()).changes === 1
  );
}

export async function finishEvent(id: string): Promise<void> {
  const db = postgres();
  if (db) {
    await db.query("update chat_deliveries set status = 'done' where id = $1", [id]);
    return;
  }
  local().prepare("UPDATE chat_deliveries SET status = 'done' WHERE id = ?").run(id);
}

/**
 * Only one Pub/Sub worker runs at a time, so at its startup any event still marked 'working' belongs to a
 * run that stopped before replying. Releasing it lets Pub/Sub's redelivery be answered.
 */
export async function releaseUnfinishedEvents(): Promise<number> {
  const db = postgres();
  if (db) return (await db.query("delete from chat_deliveries where status = 'working'")).rowCount ?? 0;
  return local().prepare("DELETE FROM chat_deliveries WHERE status = 'working'").run().changes;
}

/** The last few questions and answers in a thread, DM or space conversation, oldest first. */
export async function conversationHistory(conversation: string, limit = 3): Promise<HistoryTurn[]> {
  const db = postgres();
  if (db) {
    const res = await db.query<HistoryTurn>(
      "select question, answer from chat_turns where conversation = $1 order by id desc limit $2",
      [conversation, limit],
    );
    return res.rows.reverse();
  }
  const rows = local()
    .prepare("SELECT question, answer FROM chat_turns WHERE conversation = ? ORDER BY id DESC LIMIT ?")
    .all(conversation, limit) as HistoryTurn[];
  return rows.reverse();
}

export async function saveTurn(turn: Turn): Promise<void> {
  const db = postgres();
  if (db) {
    await db.query(
      "insert into chat_turns (conversation, asker, question, answer, status) values ($1, $2, $3, $4, $5)",
      [turn.conversation, turn.asker, turn.question, turn.answer, turn.status],
    );
    return;
  }
  local()
    .prepare(
      `INSERT INTO chat_turns (conversation, asker, question, answer, status, created_at)
       VALUES (@conversation, @asker, @question, @answer, @status, @createdAt)`,
    )
    .run({ ...turn, createdAt: new Date().toISOString() });
}
