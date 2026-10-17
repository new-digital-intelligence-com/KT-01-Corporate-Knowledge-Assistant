import { envList } from "../config";
import { delegatedAuth } from "../sources/google";

// Each person's own Gmail, Calendar and Chat. The super admin approved the bot's service account once (domain-wide
// delegation, read-only), so nobody has to connect anything: the bot reads as the person asking, and only as them.
// The asker is always the verified sender of the Chat message, never something the model or the question says.

export const PERSON_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages.readonly",
];

const tokens = new Map<string, { token: string; until: number }>();

/** A short-lived access token for this person's own Google account. Only company addresses get one. */
export async function personAccessToken(email: string): Promise<string> {
  const address = email.trim().toLowerCase();
  const domains = envList("CHAT_ALLOWED_DOMAINS").map((d) => d.toLowerCase().replace(/^@/, ""));
  if (!address.includes("@") || (domains.length && !domains.some((d) => address.endsWith(`@${d}`)))) {
    throw new Error("Only company accounts can be read.");
  }
  const cached = tokens.get(address);
  if (cached && cached.until > Date.now()) return cached.token;
  const { access_token, expiry_date } = await delegatedAuth(address, PERSON_SCOPES).authorize();
  if (!access_token) throw new Error("Google gave no access token for this account.");
  tokens.set(address, { token: access_token, until: (expiry_date ?? Date.now() + 50 * 60_000) - 60_000 });
  if (tokens.size > 500) tokens.delete(tokens.keys().next().value!);
  return access_token;
}
