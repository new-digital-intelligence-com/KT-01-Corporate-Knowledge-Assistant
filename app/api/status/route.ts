import { getStats } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    return Response.json(getStats());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Index unavailable" }, { status: 500 });
  }
}
