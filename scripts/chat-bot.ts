import { loadEnvConfig } from "@next/env";
import { PubSub, type Message } from "@google-cloud/pubsub";
import fs from "node:fs";
import { handleEvent, markOpenAnswersInterrupted, type ChatEvent } from "../lib/chat/bot";
import { releaseUnfinishedEvents } from "../lib/chat/store";
import { env, envList } from "../lib/config";
import { getStats } from "../lib/db";
import { errorMessage } from "../lib/text";

// Same .env.local / .env files and precedence as `next dev`.
loadEnvConfig(process.cwd());

// How long a stop waits for answers in progress before giving up on them.
const DRAIN_TIMEOUT_MS = 120_000;

// The raw errors that setup mistakes produce, mapped to the setup step that fixes them.
const HINTS: [RegExp, string][] = [
  [/PERMISSION_DENIED|7 PERMISSION/i, "the bot's service account needs Pub/Sub Subscriber on the subscription (setup Step 4C)."],
  [/NOT_FOUND|5 NOT_FOUND/i, "check CHAT_PUBSUB_SUBSCRIPTION: it must be projects/<project>/subscriptions/<name>."],
  [/invalid_grant|ENOENT/i, "CHAT_BOT_KEY_FILE is missing or not a valid service account key (setup Step 3)."],
  [/not a member|app not found|403/i, "the Chat app must be configured (Step 5) and added to this space or DM."],
];

function log(message: string) {
  console.log(`${new Date().toTimeString().slice(0, 8)}  ${message}`);
}

function withHint(message: string): string {
  const hint = HINTS.find(([pattern]) => pattern.test(message))?.[1];
  return hint ? `${message}\n          → ${hint}` : message;
}

function main() {
  const subscriptionName = env("CHAT_PUBSUB_SUBSCRIPTION");
  const keyFile = env("CHAT_BOT_KEY_FILE");
  const projectId = subscriptionName && /^projects\/([^/]+)\/subscriptions\/[^/]+$/.exec(subscriptionName)?.[1];

  if (!subscriptionName || !projectId) {
    console.error("✗ Set CHAT_PUBSUB_SUBSCRIPTION in .env.local, e.g. projects/<project>/subscriptions/chat-events-sub");
    process.exit(1);
  }
  if (!keyFile || !fs.existsSync(keyFile)) {
    console.error(`✗ CHAT_BOT_KEY_FILE ${keyFile ? `(${keyFile}) doesn't exist` : "is not set"} in .env.local`);
    process.exit(1);
  }
  if (!env("ANTHROPIC_API_KEY")) {
    console.warn("⚠ ANTHROPIC_API_KEY is not set: the bot will reply with an error until you add it and restart.");
  }
  if (!envList("CHAT_ALLOWED_DOMAINS").length) {
    console.warn("⚠ CHAT_ALLOWED_DOMAINS is not set: anyone who can reach the app may ask questions.");
  }

  const released = releaseUnfinishedEvents();
  if (released) log(`${released} question(s) from the last run weren't finished; they'll be answered when Pub/Sub redelivers them`);

  const subscription = new PubSub({ projectId, keyFilename: keyFile }).subscription(subscriptionName, {
    // Unacknowledged messages count toward this, so work waiting for a free slot creates backpressure.
    flowControl: { maxMessages: 6 },
  });

  const inflight = new Set<Promise<void>>();
  let stopping = false;

  subscription.on("message", (message: Message) => {
    if (stopping) {
      message.nack();
      return;
    }
    let event: ChatEvent;
    try {
      event = JSON.parse(message.data.toString("utf8")) as ChatEvent;
    } catch {
      message.ack();
      log("✗ ignored a message that isn't a Chat event");
      return;
    }
    // Acknowledge only once handled: the client library keeps extending the deadline meanwhile,
    // and a message still unacknowledged when the worker dies is redelivered later.
    const work: Promise<void> = handleEvent(event, message.id, log)
      .catch((err) => log(`✗ ${withHint(errorMessage(err))}`))
      .finally(() => {
        message.ack();
        inflight.delete(work);
      });
    inflight.add(work);
  });

  subscription.on("error", (err) => log(`✗ Pub/Sub: ${withHint(errorMessage(err))}`));

  // The subscriber closes itself after an error it won't retry. Exit so the failure is visible.
  subscription.on("close", () => {
    if (stopping) return;
    log("✗ Pub/Sub stopped delivering messages after an error. Exiting; fix the error above and start again.");
    process.exit(1);
  });

  const stop = async () => {
    if (stopping) {
      log("forced exit");
      process.exit(1);
    }
    stopping = true;
    log(`stopping… finishing ${inflight.size} answer(s) in progress (up to 2 minutes; press Ctrl+C again to force)`);
    const drained = await Promise.race([
      Promise.allSettled([...inflight]).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)),
    ]);
    if (!drained) await markOpenAnswersInterrupted();
    await subscription.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const { documents } = getStats();
  log(`Knowledge Assistant is listening on ${subscriptionName}`);
  log(`Index: ${documents} documents${documents === 0 ? " (empty, so the bot will say it has no sources yet)" : ""}`);
  log("Send the app a message in Google Chat. Press Ctrl+C to stop.");
}

main();
