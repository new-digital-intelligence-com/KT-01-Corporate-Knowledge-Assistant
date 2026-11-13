import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/config";
import { runMeetingUploads } from "@/lib/meetings/uploads";

// One run reads Fireflies and sorts the new meetings with Claude: well under a minute when a few are new.
export const maxDuration = 300;

// A run still going when the next call arrives (it shouldn't, an hour apart) makes that call a no-op.
let running = false;

function authorized(request: Request, secret: string): boolean {
  const given = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Called every hour by the Railway cron service: posts the client meetings recorded in Fireflies since the last run to
 * the Client Meeting Uploads space. Needs CRON_SECRET, FIREFLIES_API_KEY and MEETING_UPLOADS_SPACE.
 */
export async function POST(request: Request) {
  const secret = env("CRON_SECRET");
  if (!secret) return Response.json({ error: "CRON_SECRET is not set." }, { status: 500 });
  if (!authorized(request, secret)) return new Response("Unauthorized", { status: 401 });
  if (running) return Response.json({ skipped: "A run is still going." }, { status: 409 });

  running = true;
  try {
    const counts = await runMeetingUploads((line) => console.log(`[meetings] ${line}`));
    console.log(`[meetings] run: ${JSON.stringify(counts)}`);
    return Response.json(counts);
  } catch (err) {
    console.error("[meetings] ✗", err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    running = false;
  }
}
