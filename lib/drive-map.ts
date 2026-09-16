import fs from "node:fs";
import path from "node:path";
import { postgres } from "./postgres";
import { clip, errorMessage } from "./text";

// A map of the company's Google Drive: how it is organised, where to look for what, and its key files with
// ids, so the assistant can open the right file instead of searching blindly. It names internal files and
// clients, so it lives in the private database (Supabase table knowledge_map, row "drive-map"), never in the
// code. Without a database it is read from data/drive-map.json, which is kept out of git.
//
//   create table knowledge_map (id text primary key, content jsonb not null, updated_at timestamptz not null default now());
//   alter table knowledge_map enable row level security;

export interface DriveMapFile {
  id: string;
  name: string;
  type: string;
  path: string;
  modified: string;
  maintained_by: string;
  holds: string;
  use_for: string;
  status: string;
  importance: number;
}

export interface DriveMap {
  generated_at: string;
  overview_markdown: string;
  routing: { topic: string; look_in: string }[];
  key_files: DriveMapFile[];
  clients: { folder: string; id: string; client: string; engagement: string; last_activity: string }[];
  not_in_drive: string[];
}

const MAP_ID = "drive-map";
const LOCAL_FILE = path.join(process.env.VERCEL || process.env.K_SERVICE ? "/tmp" : process.cwd(), "data", "drive-map.json");
const FRESH_MS = 10 * 60_000;

let cached: { at: number; map: Promise<DriveMap | null> } | undefined;

/** The current drive map, or null when none has been stored. Read again every 10 minutes. */
export function loadDriveMap(): Promise<DriveMap | null> {
  if (!cached || Date.now() - cached.at > FRESH_MS) {
    cached = {
      at: Date.now(),
      map: readMap().catch((err) => {
        console.error(`[drive map] not loaded: ${errorMessage(err)}`);
        cached = undefined;
        return null;
      }),
    };
  }
  return cached.map;
}

async function readMap(): Promise<DriveMap | null> {
  const db = postgres();
  if (db) {
    const res = await db
      .query<{ content: DriveMap }>("select content from knowledge_map where id = $1", [MAP_ID])
      // 42P01: the table doesn't exist yet because no map was ever stored.
      .catch((err: { code?: string }) => (err.code === "42P01" ? { rows: [] } : Promise.reject(err)));
    return res.rows[0]?.content ?? null;
  }
  return fs.existsSync(LOCAL_FILE) ? (JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8")) as DriveMap) : null;
}

/** Stores a new map in the database (creating its table the first time), or in the local file without one. */
export async function saveDriveMap(map: DriveMap): Promise<"postgres" | "file"> {
  cached = undefined;
  const db = postgres();
  if (db) {
    await db.query(
      "create table if not exists knowledge_map (id text primary key, content jsonb not null, updated_at timestamptz not null default now())",
    );
    await db.query("alter table knowledge_map enable row level security");
    await db.query(
      "insert into knowledge_map (id, content, updated_at) values ($1, $2, now()) on conflict (id) do update set content = excluded.content, updated_at = now()",
      [MAP_ID, map],
    );
    return "postgres";
  }
  fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(map, null, 1));
  return "file";
}

/** The map as the assistant reads it before searching. */
export function driveMapText(map: DriveMap): string {
  // The more important a file, the more of its description is kept: the map is read with every question.
  const detail: Record<number, [holds: number, useFor: number]> = { 3: [300, 160], 2: [170, 110], 1: [0, 90] };
  const files = [...map.key_files]
    .sort((a, b) => b.importance - a.importance)
    .map((f) => {
      const [holds, useFor] = detail[f.importance] ?? detail[1];
      const who = f.maintained_by ? ` by ${clip(f.maintained_by, 40)}` : "";
      return (
        `- ${f.name} (id ${f.id}; ${f.path.replace(/^NDI\//, "")}; ${f.status}, ${f.modified}${who}): ` +
        `${holds ? `${clip(f.holds, holds)} ` : ""}Use for: ${clip(f.use_for, useFor)}`
      );
    });
  const clients = map.clients.map(
    (c) => `- ${c.folder.replace(/^NDI\/1 Client Projects\//, "")} (id ${c.id}; last ${c.last_activity}): ${clip(c.engagement, 150)}`,
  );
  return [
    `How the company Drive is organised (map made on ${map.generated_at.slice(0, 10)}):`,
    map.overview_markdown.trim(),
    "",
    "Where to look:",
    ...map.routing.map((r) => `- ${r.topic}: ${r.look_in}`),
    "",
    "Key files, most important first:",
    ...files,
    ...(clients.length ? ["", "Client project folders:", ...clients] : []),
    ...(map.not_in_drive.length ? ["", `No document was found for: ${map.not_in_drive.join("; ")}.`] : []),
  ].join("\n");
}
