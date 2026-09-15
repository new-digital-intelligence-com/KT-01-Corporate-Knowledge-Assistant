import { getDb } from "../db";
import type { HistoryTurn } from "../types";

let ready = false;

function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS chat_deliveries (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,            -- 'working' until the reply is posted, then 'done'
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
 * Pub/Sub delivers at least once. Returns false when this event is already being handled
 * or was answered, so a repeated delivery doesn't produce a second reply.
 */
export function claimEvent(id: string): boolean {
  return (
    db()
      .prepare("INSERT OR IGNORE INTO chat_deliveries (id, status, claimed_at) VALUES (?, 'working', ?)")
      .run(id, new Date().toISOString()).changes === 1
  );
}

export function finishEvent(id: string): void {
  db().prepare("UPDATE chat_deliveries SET status = 'done' WHERE id = ?").run(id);
}

/**
 * Only one worker runs at a time, so at startup any event still marked 'working' belongs to a
 * run that stopped before replying. Releasing it lets Pub/Sub's redelivery be answered.
 */
export function releaseUnfinishedEvents(): number {
  return db().prepare("DELETE FROM chat_deliveries WHERE status = 'working'").run().changes;
}

/** The last few questions and answers in a thread (or DM), oldest first. */
export function conversationHistory(conversation: string, limit = 3): HistoryTurn[] {
  const rows = db()
    .prepare("SELECT question, answer FROM chat_turns WHERE conversation = ? ORDER BY id DESC LIMIT ?")
    .all(conversation, limit) as HistoryTurn[];
  return rows.reverse();
}

export function saveTurn(turn: { conversation: string; asker: string | null; question: string; answer: string; status: string }) {
  db()
    .prepare(
      `INSERT INTO chat_turns (conversation, asker, question, answer, status, created_at)
       VALUES (@conversation, @asker, @question, @answer, @status, @createdAt)`,
    )
    .run({ ...turn, createdAt: new Date().toISOString() });
}
