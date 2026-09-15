export interface SyncContext {
  /** Fetch only content created or changed after this moment. */
  since: Date;
  /** Upper bound on items read per source, so a first sync can't run away. */
  maxItems: number;
  log: (message: string) => void;
}
