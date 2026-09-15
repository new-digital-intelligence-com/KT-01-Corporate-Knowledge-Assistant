import { answerQuestion, describeAssistantError } from "../assistant";
import { envList } from "../config";
import { liveGoogleAvailable, threadMessages } from "../live";
import { clip, errorMessage } from "../text";
import type { AssistantEvent, FinalAnswer, HistoryTurn } from "../types";
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
  /** True when the message was posted inside an existing thread. */
  threadReply?: boolean;
  sender?: { type?: string };
}

type Log = (message: string) => void;

const MAX_PARALLEL_ANSWERS = 3;
const PROGRESS_EVERY_MS = 3000;
// Leave room under Chat's limit of about one write per second per space.
const SPACE_WRITE_GAP_MS = 1500;

const WELCOME = [
  "👋 Hi, I'm the *Knowledge Assistant*: Claude, with live access to the company's Drive, Gmail and Chat.",
  "Ask me anything. In a space, mention me: _@Knowledge Assistant what do you think of this AI employee?_",
  "When a question is about the company, I search our sources and link to them.",
].join("\n");

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
    if (added?.name && (await claimEvent(`added:${deliveryId}`).catch(() => true))) {
      log(`added to ${added.name}`);
      await postMessage(added.name, (await isExternalSpace(added, added.name)) ? EXTERNAL_SPACE : WELCOME);
      await finishEvent(`added:${deliveryId}`).catch(() => undefined);
    }
    return;
  }

  const space = payload.space?.name;
  const message = payload.message;
  if (!space || !message) return;
  if (message.sender?.type === "BOT" || chat.user?.type === "BOT") return;

  const eventId = message.name ?? deliveryId;
  // If the memory store is unreachable, answer anyway rather than drop the question.
  const claimed = await claimEvent(eventId).catch((err) => {
    log(`memory unavailable, answering anyway (${errorMessage(err)})`);
    return true;
  });
  if (!claimed) {
    log("duplicate delivery skipped");
    return;
  }

  const question = (message.argumentText ?? message.text ?? "").trim();
  // Reply inside a thread only when the question was asked inside one; otherwise in the main conversation.
  const thread = message.threadReply ? (message.thread?.name ?? null) : null;
  // A DM, or the main flow of a space, is one conversation; each thread is its own.
  const conversation = payload.space?.spaceType === "DIRECT_MESSAGE" ? space : (thread ?? space);
  const asker = chat.user?.email ?? chat.user?.name ?? null;

  const refusal = !isAllowedAsker(chat.user?.email)
    ? NOT_ALLOWED
    : (await isExternalSpace(payload.space, space))
      ? EXTERNAL_SPACE
      : !question
        ? "Ask me anything, for example: _What is GP-01 about?_ or _What do you think of this AI employee?_"
        : null;
  if (refusal) {
    await postMessage(space, refusal, thread);
    await finishEvent(eventId).catch(() => undefined);
    if (question) log(`refused ${asker ?? "unknown"} in ${space}: ${refusal.slice(0, 60)}`);
    return;
  }

  log(`question from ${asker ?? "unknown"} in ${space}: ${clip(question, 80)}`);
  const placeholder = await postMessage(space, renderProgress("Thinking…"), thread);
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
        const [history, threadText] = await Promise.all([
          conversationHistory(conversation).catch((): HistoryTurn[] => []),
          // Asked inside a thread: read the whole thread first, so "that", "above" or "his idea" make sense.
          thread && liveGoogleAvailable() ? threadMessages(thread).catch(() => "") : Promise.resolve(""),
        ]);
        await answerQuestion(question, history, emit, undefined, {
          space,
          spaceName: payload.space?.displayName || undefined,
          spaceType: payload.space?.spaceType,
          asker: chat.user?.displayName || asker || undefined,
          threadMessages: threadText || undefined,
        });
      } catch (err) {
        failure = describeAssistantError(err);
      }
      await edits;

      const reply = answer ? renderAnswer(answer) : `⚠️ ${plain(failure ?? "Something went wrong. Please ask again.")}`;
      if (answer) {
        await saveTurn({ conversation, asker, question, answer: answer.text, status: answer.status }).catch((err) =>
          log(`memory not saved (${errorMessage(err)})`),
        );
      }
      // If the edit still fails after retries, post the reply as a new message rather than lose it.
      await editMessage(placeholder, reply).catch(() => postMessage(space, reply, thread));
      await finishEvent(eventId).catch(() => undefined);
      log(answer ? `answered (${answer.status}, ${answer.citations.length} source(s))` : `failed: ${failure ?? "unknown error"}`);
    });
  } finally {
    openPlaceholders.delete(placeholder);
  }
}
