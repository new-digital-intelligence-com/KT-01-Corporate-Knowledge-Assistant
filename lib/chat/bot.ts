import { answerQuestion, describeAssistantError } from "../assistant";
import { envList } from "../config";
import { getStats } from "../db";
import { liveGoogleAvailable } from "../live";
import { clip } from "../text";
import type { AssistantEvent, FinalAnswer } from "../types";
import { editMessage, getSpace, msSinceLastWrite, postMessage } from "./client";
import { plain, renderAnswer, renderProgress } from "./render";
import { claimEvent, conversationHistory, finishEvent, saveTurn } from "./store";

/** The parts of a Google Workspace add-on event for Chat that the bot reads. */
export interface ChatEvent {
  chat?: {
    user?: { name?: string; displayName?: string; email?: string; type?: string };
    messagePayload?: { space?: ChatSpace; message?: ChatMessage };
    addedToSpacePayload?: { space?: ChatSpace };
    removedFromSpacePayload?: { space?: ChatSpace };
  };
}

interface ChatSpace {
  name?: string;
  spaceType?: string;
  displayName?: string;
  externalUserAllowed?: boolean;
}

interface ChatMessage {
  name?: string;
  text?: string;
  /** The text without the @mention of the app. */
  argumentText?: string;
  thread?: { name?: string };
  sender?: { type?: string };
}

type Log = (message: string) => void;

const MAX_PARALLEL_ANSWERS = 3;
const PROGRESS_EVERY_MS = 3000;
// Leave room under Chat's limit of about one write per second per space.
const SPACE_WRITE_GAP_MS = 1500;

const WELCOME = [
  "👋 Hi, I'm the *Knowledge Assistant*.",
  "Ask me about how the company works. In a space, mention me: _@Knowledge Assistant how do I submit an expense claim?_",
  "I answer only from company sources, check every answer against them, and link to where each fact comes from.",
].join("\n");

const NOTHING_INDEXED =
  "I'm set up, but no company sources are connected yet, so I can't answer questions. (Admin: sign in with `npm run google-login`.)";

const EXTERNAL_SPACE =
  "I only answer in spaces without people from outside the company, because my answers come from internal sources. Send me a direct message instead.";

const NOT_ALLOWED = "Sorry, I only answer questions from people in the company.";

const INTERRUPTED =
  "⚠️ The assistant restarted before finishing this answer. If no new answer appears shortly, please ask again.";

let running = 0;
const waiting: (() => void)[] = [];
/** Placeholders showing "Searching…" that still need their final text. */
const openPlaceholders = new Set<string>();

/** Runs at most MAX_PARALLEL_ANSWERS answers at once; a finishing answer hands its slot to the next in line. */
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running < MAX_PARALLEL_ANSWERS) running++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/** On a forced stop, tell the people still waiting instead of leaving "Searching…" forever. */
export async function markOpenAnswersInterrupted(): Promise<void> {
  await Promise.allSettled([...openPlaceholders].map((name) => editMessage(name, INTERRUPTED)));
}

/** Spaces that let outside people in never get answers from internal sources. Unreadable counts as external. */
async function isExternalSpace(space: ChatSpace | undefined, name: string): Promise<boolean> {
  if (typeof space?.externalUserAllowed === "boolean") return space.externalUserAllowed;
  return getSpace(name)
    .then((s) => s.externalUserAllowed ?? false)
    .catch(() => true);
}

function isAllowedAsker(email: string | undefined): boolean {
  const domains = envList("CHAT_ALLOWED_DOMAINS").map((d) => d.toLowerCase().replace(/^@/, ""));
  if (!domains.length || !email) return true;
  const lower = email.toLowerCase();
  return domains.some((d) => lower.endsWith(`@${d}`));
}

export async function handleEvent(event: ChatEvent, deliveryId: string, log: Log): Promise<void> {
  const chat = event.chat;
  if (!chat) return;

  if (chat.removedFromSpacePayload) {
    log(`removed from ${chat.removedFromSpacePayload.space?.name ?? "a space"}`);
    return;
  }

  const payload = chat.messagePayload;
  if (!payload) {
    const added = chat.addedToSpacePayload?.space;
    if (added?.name && claimEvent(`added:${deliveryId}`)) {
      log(`added to ${added.name}`);
      await postMessage(added.name, (await isExternalSpace(added, added.name)) ? EXTERNAL_SPACE : WELCOME);
      finishEvent(`added:${deliveryId}`);
    }
    return;
  }

  const space = payload.space?.name;
  const message = payload.message;
  if (!space || !message) return;
  if (message.sender?.type === "BOT" || chat.user?.type === "BOT") return;

  const eventId = message.name ?? deliveryId;
  if (!claimEvent(eventId)) {
    log("duplicate delivery skipped");
    return;
  }

  const question = (message.argumentText ?? message.text ?? "").trim();
  const thread = message.thread?.name ?? null;
  // In a DM every message can start its own thread, so the whole DM is one conversation.
  const conversation = payload.space?.spaceType === "DIRECT_MESSAGE" ? space : (thread ?? space);
  const asker = chat.user?.email ?? chat.user?.name ?? null;

  const refusal = !isAllowedAsker(chat.user?.email)
    ? NOT_ALLOWED
    : (await isExternalSpace(payload.space, space))
      ? EXTERNAL_SPACE
      : !question
        ? "Ask me a question about the company, for example: _How do I submit an expense claim?_"
        : !liveGoogleAvailable() && getStats().documents === 0
          ? NOTHING_INDEXED
          : null;
  if (refusal) {
    await postMessage(space, refusal, thread);
    finishEvent(eventId);
    if (refusal !== NOTHING_INDEXED && question) log(`refused ${asker ?? "unknown"} in ${space}: ${refusal.slice(0, 60)}`);
    return;
  }

  log(`question from ${asker ?? "unknown"} in ${space}: ${clip(question, 80)}`);
  const placeholder = await postMessage(space, renderProgress("Searching company sources…"), thread);
  openPlaceholders.add(placeholder);

  try {
    await withSlot(async () => {
      let answer: FinalAnswer | undefined;
      let failure: string | undefined;
      let lastEdit = Date.now();
      let edits: Promise<void> = Promise.resolve();

      const emit = (e: AssistantEvent) => {
        if (e.type === "answer") answer = e.answer;
        else if (e.type === "error") failure = e.message;
        else if (Date.now() - lastEdit >= PROGRESS_EVERY_MS && msSinceLastWrite(space) >= SPACE_WRITE_GAP_MS) {
          lastEdit = Date.now();
          edits = edits.then(() => editMessage(placeholder, renderProgress(e.message))).catch(() => undefined);
        }
      };

      try {
        await answerQuestion(question, conversationHistory(conversation), emit);
      } catch (err) {
        failure = describeAssistantError(err);
      }
      await edits;

      const reply = answer ? renderAnswer(answer) : `⚠️ ${plain(failure ?? "Something went wrong. Please ask again.")}`;
      if (answer) saveTurn({ conversation, asker, question, answer: answer.text, status: answer.status });
      // If the edit still fails after retries, post the reply as a new message rather than lose it.
      await editMessage(placeholder, reply).catch(() => postMessage(space, reply, thread));
      finishEvent(eventId);
      log(answer ? `answered (${answer.status}, ${answer.citations.length} source(s))` : `failed: ${failure ?? "unknown error"}`);
    });
  } finally {
    openPlaceholders.delete(placeholder);
  }
}
