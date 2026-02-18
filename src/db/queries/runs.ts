import Database from 'better-sqlite3';

export interface RunRow {
  run_id: string;
  mode: string;
  started_at: number;
  completed_at: number | null;
  tokens_observed: number;
  entries_triggered: number;
  status: string;
  ws_disconnect_count: number;
  ws_disconnect_ms: number;
  config_json: string | null;
}

/** Insert a new run row with status='running'. */
export function insertRun(
  db: Database.Database,
  runId: string,
  mode: string,
  configJson: string
): void {
  db.prepare(`
    INSERT INTO runs (run_id, mode, started_at, status, config_json)
    VALUES (?, ?, ?, 'running', ?)
  `).run(runId, mode, Date.now(), configJson);
}

/** Update run status to 'complete' with final counts. */
export function completeRun(
  db: Database.Database,
  runId: string,
  tokensObserved: number,
  entriesTriggered: number
): void {
  db.prepare(`
    UPDATE runs
    SET status = 'complete',
        completed_at = ?,
        tokens_observed = ?,
        entries_triggered = ?
    WHERE run_id = ?
  `).run(Date.now(), tokensObserved, entriesTriggered, runId);
}

/** Update run status to 'partial' (SIGTERM). */
export function partialRun(
  db: Database.Database,
  runId: string,
  tokensObserved: number
): void {
  db.prepare(`
    UPDATE runs
    SET status = 'partial',
        completed_at = ?,
        tokens_observed = ?
    WHERE run_id = ?
  `).run(Date.now(), tokensObserved, runId);
}

/** Update run status to 'failed'. */
export function failRun(db: Database.Database, runId: string): void {
  db.prepare(`
    UPDATE runs
    SET status = 'failed',
        completed_at = ?
    WHERE run_id = ?
  `).run(Date.now(), runId);
}

/** Increment WebSocket disconnect counters. */
export function incrementWsDisconnect(
  db: Database.Database,
  runId: string,
  disconnectMs: number
): void {
  db.prepare(`
    UPDATE runs
    SET ws_disconnect_count = ws_disconnect_count + 1,
        ws_disconnect_ms = ws_disconnect_ms + ?
    WHERE run_id = ?
  `).run(disconnectMs, runId);
}

/** Update entries_triggered count (used by label mode). */
export function updateEntriesTriggered(
  db: Database.Database,
  runId: string,
  count: number
): void {
  db.prepare(`
    UPDATE runs SET entries_triggered = ? WHERE run_id = ?
  `).run(count, runId);
}

/** Get a single run by ID. */
export function getRun(db: Database.Database, runId: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined;
}

/** Get all completed collect runs. */
export function getCompletedCollectRuns(db: Database.Database): RunRow[] {
  return db.prepare(
    "SELECT * FROM runs WHERE mode = 'collect' AND status = 'complete' ORDER BY started_at"
  ).all() as RunRow[];
}

/**
 * Crash recovery: mark any runs still in 'running' status as 'failed'.
 * Returns the number of rows updated.
 */
export function markStaleRunsAsFailed(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE runs
    SET status = 'failed',
        completed_at = ?
    WHERE status = 'running'
  `).run(Date.now());
  return result.changes;
}
