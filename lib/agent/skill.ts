import type { DriveMap, DriveMapFile } from "../drive-map";

// The Drive map as a skill the agent reads only when a question needs it, instead of carrying it in every prompt.
// The map names internal files and clients, so the skill is built from the database at setup time and uploaded to
// Anthropic; nothing of it is stored in the code.

export const DRIVE_SKILL = "ndi-drive-map";

export interface SkillFile {
  /** Relative to the skill folder, e.g. "SKILL.md". */
  path: string;
  content: string;
}

function fileLine(f: DriveMapFile): string {
  const who = f.maintained_by ? `, maintained by ${f.maintained_by}` : "";
  return [
    `- ${f.name} (id ${f.id}; ${f.type}; ${f.path.replace(/^NDI\//, "")}; ${f.status}, ${f.modified}${who})`,
    f.holds && `  Holds: ${f.holds}`,
    f.use_for && `  Use for: ${f.use_for}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function driveMapSkill(map: DriveMap): SkillFile[] {
  const byImportance = [...map.key_files].sort((a, b) => b.importance - a.importance);
  const top = byImportance.filter((f) => f.importance >= 3);
  const outside = byImportance.filter((f) => !f.path.startsWith("NDI/"));

  const skill = [
    "---",
    `name: ${DRIVE_SKILL}`,
    "description: Where things are in NDI's Google Drive. How the NDI shared drive is organised, which folder or file to open for what, the key files with their ids (what each holds, who maintains it) and the client project folders. Read it before searching Drive for company documents, AI employees, clients, pricing, processes, templates or anything else kept in Drive.",
    "---",
    "",
    `# NDI Google Drive map (made on ${map.generated_at.slice(0, 10)})`,
    "",
    "Open a file or folder directly by its id with the Drive reading tool instead of searching for it. Search when this map doesn't cover the question, or for anything newer than the map.",
    "",
    "## How the drive is organised",
    "",
    map.overview_markdown.trim(),
    "",
    "## Where to look",
    "",
    ...map.routing.map((r) => `- ${r.topic}: ${r.look_in}`),
    "",
    "## The most important files",
    "",
    "All key files, with what each holds and who maintains it, are in key-files.md. The most important ones:",
    ...top.map((f) => `- ${f.name} (id ${f.id}): ${f.use_for}`),
    "",
    ...(outside.length
      ? [
          "## Files outside the shared drive",
          "",
          "Drive search doesn't reach these; open them by id:",
          ...outside.map((f) => `- ${f.name} (id ${f.id})`),
          "",
        ]
      : []),
    "## Client projects",
    "",
    `clients.md lists all ${map.clients.length} client project folders with their ids, last activity and what each engagement is.`,
    ...(map.not_in_drive.length ? ["", "## No document was found for", "", ...map.not_in_drive.map((t) => `- ${t}`)] : []),
    "",
  ].join("\n");

  const keyFiles = [`# Key files of the NDI Google Drive, most important first (${map.key_files.length})`, "", ...byImportance.map(fileLine), ""].join("\n");

  const clients = [
    `# Client project folders (${map.clients.length})`,
    "",
    ...map.clients.map((c) => `- ${c.client} (folder id ${c.id}; ${c.folder.replace(/^NDI\//, "")}; last activity ${c.last_activity}): ${c.engagement}`),
    "",
  ].join("\n");

  return [
    { path: "SKILL.md", content: skill },
    { path: "key-files.md", content: keyFiles },
    { path: "clients.md", content: clients },
  ];
}
