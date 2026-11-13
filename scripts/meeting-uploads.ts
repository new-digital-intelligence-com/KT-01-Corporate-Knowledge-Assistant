import { loadEnvConfig } from "@next/env";
import fs from "node:fs";
import { meetingHeadersBetween, meetingsBetween } from "../lib/meetings/fireflies";
import { draftMeetings, handledIds, postDraft, recordSkip, runMeetingUploads, uploadsSpace, type Draft } from "../lib/meetings/uploads";

// Same .env.local / .env files and precedence as `next dev`.
loadEnvConfig(process.cwd());

// npm run meeting-uploads -- draft <from> <to> <drafts.json>   draft the meetings between two dates; posts nothing
// npm run meeting-uploads -- post <drafts.json> <id,id,...>     post those drafts, and remember the rest of the file as skipped
// npm run meeting-uploads -- run                                one run of the hourly job
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "draft") {
    const [from, to, out] = args;
    if (!from || !to || !out) throw new Error("usage: draft <from> <to> <drafts.json>");
    const meetings = await meetingsBetween(new Date(from), new Date(to));
    // The series check looks 90 days back from each meeting.
    const history = await meetingHeadersBetween(new Date(new Date(from).getTime() - 91 * 24 * 3600_000), new Date(to));
    const handled = await handledIds(meetings.map((m) => m.id));
    console.log(`${meetings.length} meetings, ${handled.size} already handled, ${history.length} in the history`);
    const drafts = await draftMeetings(
      meetings.filter((m) => !handled.has(m.id)),
      history,
      (d) => {
        if (d.decision !== "skip" || !d.reason.startsWith("Part of a regular")) console.log(`- ${d.decision.padEnd(4)} ${d.at.slice(0, 16)} ${d.title}`);
      },
    );
    fs.writeFileSync(out, JSON.stringify(drafts, null, 1));
    console.log(`\nSaved ${drafts.length} drafts to ${out}`);
    return;
  }
  if (command === "post") {
    const [file, list] = args;
    if (!file || !list) throw new Error("usage: post <drafts.json> <id,id,...>");
    const drafts = JSON.parse(fs.readFileSync(file, "utf8")) as Draft[];
    const ids = new Set(list.split(",").map((id) => id.trim()).filter(Boolean));
    const unknown = [...ids].filter((id) => !drafts.some((d) => d.id === id && d.decision === "post"));
    if (unknown.length) throw new Error(`No postable draft for: ${unknown.join(", ")}`);
    const space = uploadsSpace();
    for (const draft of [...drafts].sort((a, b) => a.at.localeCompare(b.at))) {
      if (ids.has(draft.id)) {
        const name = await postDraft(draft, space);
        console.log(`${name ? "posted" : "already handled"}: ${draft.title}`);
        // Chat allows about one write per second per space.
        await new Promise((r) => setTimeout(r, 1500));
      } else if (draft.decision !== "wait") {
        await recordSkip(draft, draft.decision === "post" ? "Not approved for posting." : draft.reason);
      }
    }
    return;
  }
  if (command === "run") {
    console.log(await runMeetingUploads());
    return;
  }
  throw new Error("usage: draft <from> <to> <drafts.json> | post <drafts.json> <ids> | run");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
