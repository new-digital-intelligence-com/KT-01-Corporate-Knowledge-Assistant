import { answerQuestion, describeAssistantError } from "@/lib/assistant";
import type { AssistantEvent, HistoryTurn } from "@/lib/types";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { question?: unknown; history?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return Response.json({ error: "Ask a question." }, { status: 400 });

  const history: HistoryTurn[] = (Array.isArray(body?.history) ? body.history : [])
    .filter((t): t is HistoryTurn => typeof t?.question === "string" && typeof t?.answer === "string")
    .slice(-3);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AssistantEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // The browser disconnected; nobody is listening any more.
        }
      };
      try {
        await answerQuestion(question, history, emit, request.signal);
      } catch (err) {
        emit({ type: "error", message: describeAssistantError(err) });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by a disconnect.
        }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
