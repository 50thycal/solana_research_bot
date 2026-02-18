import Database from 'better-sqlite3';

export interface OutcomeRow {
  id: number;
  mint: string;
  label_run_id: string;
  collect_run_id: string;
  entry_triggered: number;
  entry_price_sol: number | null;
  entry_seconds: number | null;
  entry_snapshot_id: number | null;
  max_price_sol: number | null;
  max_price_seconds: number | null;
  min_price_after_entry: number | null;
  final_price_sol: number | null;
  max_gain_pct: number | null;
  max_drawdown_pct: number | null;
  final_gain_pct: number | null;
  hit_2x: number | null;
  time_to_2x_seconds: number | null;
  time_to_peak_seconds: number | null;
  entry_config_json: string | null;
}

export interface OutcomeInsert {
  mint: string;
  labelRunId: string;
  collectRunId: string;
  entryTriggered: number;
  entryPriceSol: number | null;
  entrySeconds: number | null;
  entrySnapshotId: number | null;
  maxPriceSol: number | null;
  maxPriceSeconds: number | null;
  minPriceAfterEntry: number | null;
  finalPriceSol: number | null;
  maxGainPct: number | null;
  maxDrawdownPct: number | null;
  finalGainPct: number | null;
  hit2x: number | null;
  timeTo2xSeconds: number | null;
  timeToPeakSeconds: number | null;
  entryConfigJson: string | null;
}

/** Insert an outcome row. */
export function insertOutcome(db: Database.Database, o: OutcomeInsert): void {
  db.prepare(`
    INSERT INTO outcomes (
      mint, label_run_id, collect_run_id,
      entry_triggered, entry_price_sol, entry_seconds, entry_snapshot_id,
      max_price_sol, max_price_seconds, min_price_after_entry, final_price_sol,
      max_gain_pct, max_drawdown_pct, final_gain_pct,
      hit_2x, time_to_2x_seconds, time_to_peak_seconds,
      entry_config_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    o.mint, o.labelRunId, o.collectRunId,
    o.entryTriggered, o.entryPriceSol, o.entrySeconds, o.entrySnapshotId,
    o.maxPriceSol, o.maxPriceSeconds, o.minPriceAfterEntry, o.finalPriceSol,
    o.maxGainPct, o.maxDrawdownPct, o.finalGainPct,
    o.hit2x, o.timeTo2xSeconds, o.timeToPeakSeconds,
    o.entryConfigJson
  );
}

/**
 * Delete all outcomes for a given collect run (enables re-labeling).
 * Returns the number of rows deleted.
 */
export function deleteOutcomesForCollectRun(
  db: Database.Database,
  collectRunId: string
): number {
  const result = db.prepare(
    'DELETE FROM outcomes WHERE collect_run_id = ?'
  ).run(collectRunId);
  return result.changes;
}

/**
 * Delete all outcomes for a given label run.
 * Returns the number of rows deleted.
 */
export function deleteOutcomesForLabelRun(
  db: Database.Database,
  labelRunId: string
): number {
  const result = db.prepare(
    'DELETE FROM outcomes WHERE label_run_id = ?'
  ).run(labelRunId);
  return result.changes;
}

/** Get all outcomes for a collect run. */
export function getOutcomesForCollectRun(
  db: Database.Database,
  collectRunId: string
): OutcomeRow[] {
  return db.prepare(
    'SELECT * FROM outcomes WHERE collect_run_id = ?'
  ).all(collectRunId) as OutcomeRow[];
}
