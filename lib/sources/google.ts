import { google, type Auth } from "googleapis";
import fs from "node:fs";
import { env } from "../config";

// Every scope is read-only.
export const GOOGLE_SCOPES = {
  drive: ["https://www.googleapis.com/auth/drive.readonly"],
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  chat: [
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ],
  directory: ["https://www.googleapis.com/auth/admin.directory.user.readonly"],
};

/** Everything `npm run google-login` asks the signed-in person to allow. */
export const USER_SCOPES = [
  ...GOOGLE_SCOPES.drive,
  ...GOOGLE_SCOPES.gmail,
  ...GOOGLE_SCOPES.chat,
  ...GOOGLE_SCOPES.directory,
];

// Desktop OAuth clients accept any loopback address as the redirect target.
export const LOOPBACK_REDIRECT = "http://127.0.0.1:53682";

/** A person signed in with `npm run google-login`: the connectors read exactly what that person can see. */
export function userAuthConfigured(): boolean {
  const tokenFile = env("GOOGLE_USER_TOKEN_FILE");
  return Boolean(env("GOOGLE_OAUTH_CLIENT_FILE") && tokenFile && fs.existsSync(tokenFile));
}

export function googleConfigured(): boolean {
  return userAuthConfigured() || Boolean(env("GOOGLE_SERVICE_ACCOUNT_KEY_FILE"));
}

export function oauthClient(): Auth.OAuth2Client {
  const file = env("GOOGLE_OAUTH_CLIENT_FILE");
  if (!file || !fs.existsSync(file)) throw new Error("GOOGLE_OAUTH_CLIENT_FILE is not set or the file doesn't exist.");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { client_id?: string; client_secret?: string }>;
  const client = raw.installed ?? raw.web;
  if (!client?.client_id || !client.client_secret) {
    throw new Error(`${file} is not an OAuth client file. Download it from Google Auth Platform → Clients.`);
  }
  return new google.auth.OAuth2(client.client_id, client.client_secret, LOOPBACK_REDIRECT);
}

let signedIn: Auth.OAuth2Client | undefined;

function userAuth(): Auth.OAuth2Client {
  if (!signedIn) {
    signedIn = oauthClient();
    // The refresh token is enough: the client fetches fresh access tokens by itself.
    signedIn.setCredentials(JSON.parse(fs.readFileSync(env("GOOGLE_USER_TOKEN_FILE")!, "utf8")));
  }
  return signedIn;
}

/**
 * The signed-in person when there is one. Otherwise the service account acting as `subject`
 * through domain-wide delegation, which needs a super admin to authorise.
 */
export function googleAuth(subject: string | undefined, scopes: string[]) {
  if (userAuthConfigured()) return userAuth();
  if (!subject) throw new Error("No Google sign-in (npm run google-login) and no user to act as in .env.local.");
  return serviceAccountAuth(env("GOOGLE_SERVICE_ACCOUNT_KEY_FILE") ?? "", scopes, subject);
}

/**
 * Credentials from a service account key file. The email and key are passed explicitly:
 * `new JWT({ keyFile })` never reads the account email from the file in this library
 * version, and Google then rejects the token request with "invalid_grant: account not found".
 */
export function serviceAccountAuth(keyFile: string, scopes: string[], subject?: string) {
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8")) as { client_email?: string; private_key?: string };
  if (!key.client_email || !key.private_key) throw new Error(`${keyFile} is not a service account key file.`);
  return new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes, subject });
}

/** Chat identifies people as `users/{id}` without a name; the Directory API resolves it when allowed. */
export function directoryNames(): (userResource: string | null | undefined) => Promise<string> {
  const adminEmail = env("GOOGLE_ADMIN_EMAIL");
  const auth = userAuthConfigured()
    ? userAuth()
    : adminEmail
      ? serviceAccountAuth(env("GOOGLE_SERVICE_ACCOUNT_KEY_FILE") ?? "", GOOGLE_SCOPES.directory, adminEmail)
      : null;
  const admin = auth ? google.admin({ version: "directory_v1", auth }) : null;
  const cache = new Map<string, Promise<string>>();

  return (resource) => {
    if (!resource) return Promise.resolve("unknown");
    const id = resource.replace(/^users\//, "");
    let name = cache.get(id);
    if (!name) {
      name = admin
        ? admin.users
            .get({ userKey: id, fields: "name(fullName),primaryEmail", viewType: "domain_public" })
            .then((res) => res.data.name?.fullName || res.data.primaryEmail || resource)
            .catch(() => resource)
        : Promise.resolve(resource);
      cache.set(id, name);
    }
    return name;
  };
}
