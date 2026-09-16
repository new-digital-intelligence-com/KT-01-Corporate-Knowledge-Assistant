/** Split a document into overlapping passages small enough to cite precisely. */
export function chunkText(text: string, target = 1200, overlap = 200): string[] {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];
  if (clean.length <= target) return [clean];

  const pieces: string[] = [];
  for (const line of clean.split("\n")) {
    if (line.length <= target) {
      pieces.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += target - overlap) pieces.push(line.slice(i, i + target));
  }

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 1 > target) {
      chunks.push(current.trim());
      // Carry the end of the previous passage over, cut at a word boundary.
      const tail = current.slice(-overlap);
      const space = tail.indexOf(" ");
      current = (space >= 0 ? tail.slice(space + 1) : tail) + "\n";
    }
    current += piece + "\n";
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/** "2026-09-12T10:55:00Z" → "2026-09-12 10:55 GMT". A plain date stays as it is. */
export function gmt(value: string | null | undefined): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(0, 16).replace("T", " ")} GMT`;
}

// Passwords written next to a label ("password: x", "credentials ndi / nextgen!"), and well-known key formats.
// The label ends at a word boundary, needs a separator, and the value must have a letter plus a digit or symbol,
// so "passwords/ID numbers" or "login 24/7" stay as they are.
const LABELLED_SECRET =
  /\b(passwords?|passwort|passcode|pwd|kennwort|mot de passe|credentials?|login)\b(\s*[:=]\s*|\s+(?:is|are)\s*[:=]?\s*|\s+)("[^"\n]+"|'[^'\n]+'|`[^`\n]+`|(?=[^\s/,;()]*\p{L})[^\s/,;()]+\s*\/\s*(?=[^\s,;()]*\p{L})(?=[^\s,;()]*[\d!@#$%^&*?+=~])[^\s,;()]+|(?=[^\s,;()]*\p{L})(?=[^\s,;()]*[\d!@#$%^&*?+=~])[^\s,;()]+)/giu;
const KEY_FORMATS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bsb_secret_[A-Za-z0-9_-]{10,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\b1\/\/[A-Za-z0-9_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** Masks passwords and keys, as a last safety net before text reaches people. */
export function hideSecrets(text: string): string {
  let out = text
    .replace(LABELLED_SECRET, (_, label: string, gap: string) => `${label}${gap || " "}[hidden]`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/gi, "$1[hidden]@");
  for (const format of KEY_FORMATS) out = out.replace(format, "[hidden]");
  return out;
}

export function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : flat.slice(0, max).trimEnd() + "…";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}
