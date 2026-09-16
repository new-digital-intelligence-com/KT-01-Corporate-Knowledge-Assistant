import { loadEnvConfig } from "@next/env";
import fs from "node:fs";
import { driveMapText, loadDriveMap, saveDriveMap, type DriveMap } from "../lib/drive-map";
import { errorMessage } from "../lib/text";

// Same .env.local / .env files and precedence as `next dev`.
loadEnvConfig(process.cwd());

// npm run drive-map -- <map.json>   store a new Drive map (for the database named in DATABASE_URL)
// npm run drive-map                 show the stored map as the assistant reads it
async function main() {
  const file = process.argv[2];
  if (file) {
    const map = JSON.parse(fs.readFileSync(file, "utf8")) as DriveMap;
    map.generated_at ??= new Date().toISOString();
    for (const field of ["overview_markdown", "routing", "key_files", "clients", "not_in_drive"] as const) {
      if (map[field] === undefined) throw new Error(`${file} has no ${field}`);
    }
    const where = await saveDriveMap(map);
    console.log(`Stored the Drive map (${map.key_files.length} key files, ${map.clients.length} client folders) in ${where === "postgres" ? "the database" : "data/drive-map.json"}.`);
  }
  const stored = await loadDriveMap();
  if (!stored) {
    console.log("No Drive map is stored yet.");
    return;
  }
  const text = driveMapText(stored);
  console.log(file ? `The assistant reads ${text.length} characters of map.` : text);
}

main()
  .catch((err) => {
    console.error(errorMessage(err));
    process.exitCode = 1;
  })
  .finally(() => process.exit());
