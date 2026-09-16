// Shared between the server and the browser, so nothing here may import server-only modules.

export const SOURCES = ["slack", "drive", "gmail", "gchat", "directory", "youtube", "calendar"] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABELS: Record<Source, string> = {
  slack: "Slack",
  drive: "Google Drive",
  gmail: "Gmail",
  gchat: "Google Chat",
  directory: "Workspace directory",
  youtube: "YouTube",
  calendar: "Calendar",
};

export interface Citation {
  n: number;
  chunkId: number;
  source: Source;
  title: string;
  url: string | null;
  container: string;
  author: string | null;
  updatedAt: string;
  excerpt: string;
}

export type Verdict = "supported" | "partial" | "unsupported";

export interface ClaimCheck {
  claim: string;
  verdict: Verdict;
  note: string;
}

export type AnswerStatus = "verified" | "partially_verified" | "not_found";

export interface FinalAnswer {
  /** Answer text with citation markers rewritten to [1], [2], … */
  text: string;
  status: AnswerStatus;
  citations: Citation[];
  checks: ClaimCheck[];
  conflicts: string[];
  /** True when the first draft failed the check and was rewritten. */
  rewritten: boolean;
  /** How many company facts the check found fully backed (checks only lists the others). */
  supportedCount?: number;
}

export type AssistantEvent =
  | { type: "progress"; message: string }
  | { type: "answer"; answer: FinalAnswer }
  | { type: "error"; message: string };

/** Where and by whom a question was asked, so the assistant can tell what "this" or "here" means. */
export interface AskContext {
  /** Chat space resource name, e.g. spaces/AAAA. */
  space?: string;
  spaceName?: string;
  spaceType?: string;
  asker?: string;
  /** The messages of the thread the question was asked in, oldest first. */
  threadMessages?: string;
  /** The Google account the live tools read as (Gmail, Chat, Calendar). */
  account?: string;
}

export interface HistoryTurn {
  question: string;
  answer: string;
}

export interface IndexStats {
  sources: { source: Source; documents: number; newest: string | null; lastSync: string | null }[];
  documents: number;
  chunks: number;
  /** Drive, Gmail and Chat are searched live at question time. */
  liveGoogle?: boolean;
}
