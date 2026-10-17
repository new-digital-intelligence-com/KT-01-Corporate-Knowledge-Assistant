import { envList } from "../config";
import { delegatedAuth } from "../sources/google";

// Each person's own Google account: Drive, the directory, Gmail, Calendar and Chat. The super admin approved the bot's
// service account once (domain-wide delegation, read-only), so nobody has to connect anything: the bot reads as the
// person asking, and only as them, so everyone sees exactly what their own account can see. The asker is always the
// verified sender of the Chat message, never something the model or the question says.

const GOOGLE = "https://www.googleapis.com/auth";

/** The read-only scopes each tool group asks for; each must be approved in the Admin console's domain-wide delegation. */
export const PERSON_SCOPES = {
  drive: [`${GOOGLE}/drive.readonly`],
  directory: [`${GOOGLE}/admin.directory.user.readonly`, `${GOOGLE}/admin.directory.group.readonly`, `${GOOGLE}/admin.directory.group.member.readonly`],
  gmail: [`${GOOGLE}/gmail.readonly`],
  calendar: [`${GOOGLE}/calendar.readonly`],
  chat: [`${GOOGLE}/chat.spaces.readonly`, `${GOOGLE}/chat.messages.readonly`],
};

const tokens = new Map<string, { token: string; until: number }>();

/**
 * A short-lived access token for this person's own Google account, with only the scopes one tool needs, so a scope
 * the admin hasn't approved yet breaks that tool alone. Only company addresses get one.
 */
export async function personAccessToken(email: string, scopes: string[]): Promise<string> {
  const address = email.trim().toLowerCase();
  const domains = envList("CHAT_ALLOWED_DOMAINS").map((d) => d.toLowerCase().replace(/^@/, ""));
  if (!address.includes("@") || (domains.length && !domains.some((d) => address.endsWith(`@${d}`)))) {
    throw new Error("Only company accounts can be read.");
  }
  const key = `${address} ${scopes.join(" ")}`;
  const cached = tokens.get(key);
  if (cached && cached.until > Date.now()) return cached.token;
  try {
    const { access_token, expiry_date } = await delegatedAuth(address, scopes).authorize();
    if (!access_token) throw new Error("Google gave no access token for this account.");
    tokens.set(key, { token: access_token, until: (expiry_date ?? Date.now() + 50 * 60_000) - 60_000 });
    if (tokens.size > 1000) tokens.delete(tokens.keys().next().value!);
    return access_token;
  } catch (err) {
    if (/unauthorized_client/i.test(String((err as Error).message))) {
      throw new Error("the Google admin hasn't approved this kind of access for the assistant yet (domain-wide delegation).");
    }
    throw err;
  }
}
