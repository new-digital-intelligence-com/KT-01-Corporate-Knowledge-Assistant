import { getStats } from "@/lib/db";
import { liveGoogleAvailable } from "@/lib/live";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    return Response.json({ ...getStats(), liveGoogle: liveGoogleAvailable() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Index unavailable" }, { status: 500 });
  }
}
