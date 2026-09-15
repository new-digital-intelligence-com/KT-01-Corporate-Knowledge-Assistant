import { google } from "googleapis";
import { after } from "next/server";
import { handleEvent, type ChatEvent } from "@/lib/chat/bot";
import { env } from "@/lib/config";

// An answer takes one to two minutes. Chat is told "received" at once and the work continues
// in after(), which runs for the route's whole max duration.
export const maxDuration = 300;

const verifier = new google.auth.OAuth2();

/**
 * Receives Google Chat events for the add-on based Chat app (connection: HTTP endpoint URL).
 * Every request must carry an ID token issued to the add-on's service account for this exact URL.
 */
export async function POST(request: Request) {
  const endpoint = env("CHAT_ENDPOINT_URL");
  const addOnAccount = env("CHAT_ADDON_SERVICE_ACCOUNT");
  if (!endpoint || !addOnAccount) {
    return Response.json({ error: "CHAT_ENDPOINT_URL and CHAT_ADDON_SERVICE_ACCOUNT must be set." }, { status: 500 });
  }

  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return new Response("Unauthorized", { status: 401 });
  try {
    const ticket = await verifier.verifyIdToken({ idToken: token, audience: endpoint });
    if (ticket.getPayload()?.email !== addOnAccount) return new Response("Unauthorized", { status: 401 });
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const event = (await request.json().catch(() => null)) as ChatEvent | null;
  if (event?.chat) {
    const deliveryId = crypto.randomUUID();
    after(() =>
      handleEvent(event, deliveryId, (message) => console.log(`[chat] ${message}`)).catch((err) =>
        console.error("[chat] ✗", err),
      ),
    );
  }

  // An empty response acknowledges the event; the reply is posted through the Chat API.
  return Response.json({});
}
