import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { chunkText } from "./text";
import { SOURCES, type IndexStats, type Source } from "./types";

export interface DocInput {
  /** Stable across syncs: `<source>:<native id>`. */
  id: string;
  source: Source;
  title: string;
  url: string | null;
  /** Channel, folder, mailbox or space. */
  container: string;
  author: string | null;
  updatedAt: string;
  text: string;
}

export interface ChunkRow {
  chunkId: number;
  docId: string;
  source: Source;
  title: string;
  url: string | null;
  container: string;
  author: string | null;
  updatedAt: string;
  text: string;
}

const DB_PATH = path.join(process.cwd(), "data", "knowledge.sqlite");

export const CHUNK_COLUMNS = `c.id AS chunkId, d.id AS docId, d.source, d.title, d.url, d.container,
  d.author, d.updated_at AS updatedAt, c.text`;

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      container TEXT NOT NULL,
      author TEXT,
      updated_at TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id, ordinal);
    -- remove_diacritics lets "conges" match "congés".
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      title, container, text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

/** Returns false when the document is unchanged since the last sync. */
export function upsertDocument(doc: DocInput): boolean {
  const d = getDb();
  const text = doc.text.trim();
  if (!text) return false;

  const existing = d
    .prepare("SELECT updated_at AS updatedAt, text FROM documents WHERE id = ?")
    .get(doc.id) as { updatedAt: string; text: string } | undefined;
  if (existing && existing.updatedAt === doc.updatedAt && existing.text === text) return false;

  const insertChunk = d.prepare("INSERT INTO chunks (doc_id, ordinal, text) VALUES (?, ?, ?)");
  const insertFts = d.prepare("INSERT INTO chunks_fts (rowid, title, container, text) VALUES (?, ?, ?, ?)");

  d.transaction(() => {
    d.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)").run(doc.id);
    d.prepare("DELETE FROM chunks WHERE doc_id = ?").run(doc.id);
    d.prepare(
      `INSERT INTO documents (id, source, title, url, container, author, updated_at, text)
       VALUES (@id, @source, @title, @url, @container, @author, @updatedAt, @text)
       ON CONFLICT(id) DO UPDATE SET source = excluded.source, title = excluded.title, url = excluded.url,
         container = excluded.container, author = excluded.author, updated_at = excluded.updated_at,
         text = excluded.text`,
    ).run({
      id: doc.id,
      source: doc.source,
      title: doc.title,
      url: doc.url,
      container: doc.container,
      author: doc.author,
      updatedAt: doc.updatedAt,
      text,
    });
    chunkText(text).forEach((chunk, ordinal) => {
      const { lastInsertRowid } = insertChunk.run(doc.id, ordinal, chunk);
      insertFts.run(lastInsertRowid, doc.title, doc.container, chunk);
    });
  })();
  return true;
}

export function getChunks(ids: number[]): ChunkRow[] {
  if (!ids.length) return [];
  return getDb()
    .prepare(
      `SELECT ${CHUNK_COLUMNS} FROM chunks c JOIN documents d ON d.id = c.doc_id
       WHERE c.id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(...ids) as ChunkRow[];
}

export function getDocumentChunks(docId: string): ChunkRow[] {
  return getDb()
    .prepare(
      `SELECT ${CHUNK_COLUMNS} FROM chunks c JOIN documents d ON d.id = c.doc_id
       WHERE c.doc_id = ? ORDER BY c.ordinal`,
    )
    .all(docId) as ChunkRow[];
}

export function getState(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setState(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function getStats(): IndexStats {
  const d = getDb();
  const rows = d
    .prepare("SELECT source, COUNT(*) AS documents, MAX(updated_at) AS newest FROM documents GROUP BY source")
    .all() as { source: Source; documents: number; newest: string }[];
  const { chunks } = d.prepare("SELECT COUNT(*) AS chunks FROM chunks").get() as { chunks: number };
  const sources = SOURCES.map((source) => {
    const row = rows.find((r) => r.source === source);
    return {
      source,
      documents: row?.documents ?? 0,
      newest: row?.newest ?? null,
      lastSync: getState(`lastSync:${source}`) ?? null,
    };
  });
  return { sources, documents: sources.reduce((sum, s) => sum + s.documents, 0), chunks };
}
