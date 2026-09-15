import { CHUNK_COLUMNS, getDb, type ChunkRow } from "./db";
import type { Source } from "./types";

// Words that match nearly everything and drown out the useful terms (English and French).
const STOPWORDS = new Set(
  (
    "the a an and or of to in on for with is are was were be been it this that what which who how when where why " +
    "do does did can could should would our we us you your my i me at by from as about into than then there " +
    "le la les un une des et ou de du au aux en dans sur pour par avec est sont était qui que quoi quand comment " +
    "où pourquoi nous vous notre votre nos vos mon ma mes ce cette ces il elle ils elles on se sa son ses"
  ).split(" "),
);

/** Turn free text into an FTS5 query: any keyword matches, prefixes allowed, ranked by BM25. */
export function toMatchQuery(query: string): string | null {
  const useful = keywords(query);
  return useful.length ? useful.map((t) => `"${t}"*`).join(" OR ") : null;
}

/** The distinctive words of a query: lowercased, deduplicated, without filler words. */
export function keywords(query: string, max = 12): string[] {
  const terms = query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms.filter((t) => t.length > 1 && !STOPWORDS.has(t)))].slice(0, max);
}

export function searchChunks(query: string, sources: Source[] | undefined, limit: number): ChunkRow[] {
  const match = toMatchQuery(query);
  if (!match) return [];
  const sourceFilter = sources?.length ? `AND d.source IN (${sources.map(() => "?").join(", ")})` : "";
  return getDb()
    .prepare(
      `SELECT ${CHUNK_COLUMNS}
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       JOIN documents d ON d.id = c.doc_id
       WHERE chunks_fts MATCH ? ${sourceFilter}
       ORDER BY bm25(chunks_fts, 3.0, 1.0, 1.0)
       LIMIT ?`,
    )
    .all(match, ...(sources ?? []), limit) as ChunkRow[];
}
