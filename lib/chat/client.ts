import { randomUUID } from "node:crypto";
import { google, type chat_v1 } from "googleapis";
import { chatBotAuth } from "../sources/google";
import type { ChatReply } from "./render";

// The bot posts as itself (app authentication). This scope needs no admin approval
// and no domain-wide delegation; it only works in spaces the app is a member of.
const SCOPES = ["https://www.googleapis.com/auth/chat.bot"];

// Google Chat rejects messages over 32,000 bytes, text and cards together.
const MAX_BYTES = 30_000;

// Chat allows about one message write per second per space and answers 429 above that.
// The client library doesn't retry POST or PATCH by default, so writes opt in explicitly.
const WRITE_OPTIONS = {
  retryConfig: {
    retry: 5,
    retryDelay: 1000,
    httpMethodsToRetry: ["POST", "PATCH"],
    statusCodesToRetry: [
      [429, 429],
      [500, 599],
    ],
  },
};

let client: chat_v1.Chat | undefined;
const lastWriteAt = new Map<string, number>();

function chat(): chat_v1.Chat {
  client ??= google.chat({ version: "v1", auth: chatBotAuth(SCOPES) });
  return client;
}

/** Posts a message, as a reply in `thread` when given. Returns the new message's resource name. */
export async function postMessage(space: string, reply: string | ChatReply, thread?: string | null): Promise<string> {
  const { text, cardsV2 } = typeof reply === "string" ? { text: reply, cardsV2: undefined } : reply;
  lastWriteAt.set(space, Date.now());
  const res = await chat().spaces.messages.create(
    {
      parent: space,
      // Chosen once per message, so a retried request returns the same message instead of posting twice.
      requestId: randomUUID(),
      ...(thread ? { messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" } : {}),
      requestBody: { text: fit(text, cardsV2), ...(cardsV2 ? { cardsV2 } : {}), ...(thread ? { thread: { name: thread } } : {}) },
    },
    WRITE_OPTIONS,
  );
  if (!res.data.name) throw new Error("Google Chat did not return the new message's name.");
  return res.data.name;
}

/** Replaces a message the bot posted earlier. A plain string changes only the text; a reply also replaces the cards. */
export async function editMessage(name: string, reply: string | ChatReply): Promise<void> {
  lastWriteAt.set(name.split("/messages/")[0], Date.now());
  if (typeof reply === "string") {
    await chat().spaces.messages.patch({ name, updateMask: "text", requestBody: { text: fit(reply) } }, WRITE_OPTIONS);
    return;
  }
  const cardsV2 = reply.cardsV2 ?? [];
  await chat().spaces.messages.patch(
    { name, updateMask: "text,cards_v2", requestBody: { text: fit(reply.text, cardsV2), cardsV2 } },
    WRITE_OPTIONS,
  );
}

export function msSinceLastWrite(space: string): number {
  return Date.now() - (lastWriteAt.get(space) ?? 0);
}

export async function getSpace(name: string): Promise<chat_v1.Schema$Space> {
  return (await chat().spaces.get({ name })).data;
}

function fit(text: string, cards?: chat_v1.Schema$CardWithId[]): string {
  const room = MAX_BYTES - (cards?.length ? Buffer.byteLength(JSON.stringify(cards)) : 0);
  if (Buffer.byteLength(text) <= room) return text;
  let cut = text.slice(0, room);
  while (Buffer.byteLength(cut) > room - 100) cut = cut.slice(0, -500);
  return `${cut.trimEnd()}\n\n_(Answer shortened to fit in Google Chat.)_`;
}
