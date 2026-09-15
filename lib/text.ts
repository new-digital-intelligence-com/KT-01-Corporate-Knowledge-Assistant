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

export function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : flat.slice(0, max).trimEnd() + "…";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}
