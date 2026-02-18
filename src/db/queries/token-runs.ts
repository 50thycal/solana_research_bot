import Database from 'better-sqlite3';

export interface TokenRunRow {
  run_id: string;
  mint: string;
  first_seen_at: number;
}

/** Link a token to a run with first-seen timestamp. */
export function insertTokenRun(
  db: Database.Database,
  runId: string,
  mint: string,
  firstSeenAt: number
): void {
  db.prepare(`
    INSERT OR IGNORE INTO token_runs (run_id, mint, first_seen_at)
    VALUES (?, ?, ?)
  `).run(runId, mint, firstSeenAt);
}

/** Get all token-run rows for a specific run. */
export function getTokenRunsByRunId(db: Database.Database, runId: string): TokenRunRow[] {
  return db.prepare(
    'SELECT * FROM token_runs WHERE run_id = ?'
  ).all(runId) as TokenRunRow[];
}

/** Get all runs that observed a specific token. */
export function getRunsForToken(db: Database.Database, mint: string): TokenRunRow[] {
  return db.prepare(
    'SELECT * FROM token_runs WHERE mint = ?'
  ).all(mint) as TokenRunRow[];
}
