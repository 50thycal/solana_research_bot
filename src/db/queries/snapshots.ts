import Database from 'better-sqlite3';

export interface SnapshotRow {
  id: number;
  mint: string;
  run_id: string;
  snapshot_at: number;
  seconds_since_creation: number;
  phase: string;
  virtual_sol_reserves: number | null;
  virtual_token_reserves: number | null;
  real_sol_reserves: number | null;
  real_token_reserves: number | null;
  price_sol: number | null;
  total_tx_count: number | null;
  tx_count_delta: number | null;
  buy_count: number | null;
  sell_count: number | null;
  unique_buyers: number | null;
  unique_sellers: number | null;
  sample_size: number | null;
  sample_total: number | null;
  sample_method: string | null;
  buy_velocity: number | null;
  volume_velocity_sol: number | null;
  buyer_tx_ratio: number | null;
  sell_ratio: number | null;
}

export interface SnapshotInsert {
  mint: string;
  runId: string;
  snapshotAt: number;
  secondsSinceCreation: number;
  phase: string;
  virtualSolReserves: number | null;
  virtualTokenReserves: number | null;
  realSolReserves: number | null;
  realTokenReserves: number | null;
  priceSol: number | null;
  totalTxCount: number | null;
  txCountDelta: number | null;
  buyCount: number | null;
  sellCount: number | null;
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
  sampleSize: number | null;
  sampleTotal: number | null;
  sampleMethod: string | null;
  buyVelocity: number | null;
  volumeVelocitySol: number | null;
  buyerTxRatio: number | null;
  sellRatio: number | null;
}

/** Insert a snapshot row. Returns the inserted row's id. */
export function insertSnapshot(db: Database.Database, s: SnapshotInsert): number {
  const result = db.prepare(`
    INSERT INTO snapshots (
      mint, run_id, snapshot_at, seconds_since_creation, phase,
      virtual_sol_reserves, virtual_token_reserves, real_sol_reserves, real_token_reserves, price_sol,
      total_tx_count, tx_count_delta,
      buy_count, sell_count, unique_buyers, unique_sellers,
      sample_size, sample_total, sample_method,
      buy_velocity, volume_velocity_sol, buyer_tx_ratio, sell_ratio
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.mint, s.runId, s.snapshotAt, s.secondsSinceCreation, s.phase,
    s.virtualSolReserves, s.virtualTokenReserves, s.realSolReserves, s.realTokenReserves, s.priceSol,
    s.totalTxCount, s.txCountDelta,
    s.buyCount, s.sellCount, s.uniqueBuyers, s.uniqueSellers,
    s.sampleSize, s.sampleTotal, s.sampleMethod,
    s.buyVelocity, s.volumeVelocitySol, s.buyerTxRatio, s.sellRatio
  );
  return Number(result.lastInsertRowid);
}

/** Get all snapshots for a token in a specific run, ordered by time. */
export function getSnapshotsForToken(
  db: Database.Database,
  mint: string,
  runId: string
): SnapshotRow[] {
  return db.prepare(`
    SELECT * FROM snapshots
    WHERE mint = ? AND run_id = ?
    ORDER BY seconds_since_creation ASC
  `).all(mint, runId) as SnapshotRow[];
}

/** Get all snapshots for a run, ordered by mint then time. */
export function getSnapshotsForRun(db: Database.Database, runId: string): SnapshotRow[] {
  return db.prepare(`
    SELECT * FROM snapshots
    WHERE run_id = ?
    ORDER BY mint, seconds_since_creation ASC
  `).all(runId) as SnapshotRow[];
}

/** Get distinct mints that have snapshots for a given run. */
export function getMintsWithSnapshots(db: Database.Database, runId: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT mint FROM snapshots WHERE run_id = ?
  `).all(runId) as { mint: string }[];
  return rows.map(r => r.mint);
}
