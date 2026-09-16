// Read lazily: the sync script loads .env.local after its imports have run.

export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function envList(name: string): string[] {
  return (env(name) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env(name) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function model(): string {
  return env("ANTHROPIC_MODEL") ?? "claude-opus-5";
}

/** The model that fact-checks and corrects answers: the answering model unless ANTHROPIC_VERIFY_MODEL is set. */
export function verifyModel(): string {
  return env("ANTHROPIC_VERIFY_MODEL") ?? model();
}
