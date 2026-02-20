/**
 * Database validation for post-deployment verification.
 *
 * Queries the SQLite database and prints a structured summary of:
 *   - Total runs (by mode and status)
 *   - Total tokens, snapshots, outcomes
 *   - Data quality checks (missing fields, snapshot gaps)
 *   - WebSocket reliability stats
 *   - Helius credit usage estimates
 *
 * Usage: MODE=validate node dist/index.js
 *
 * Does NOT use Helius. Reads SQLite only.
 */

import Database from 'better-sqlite3';

interface RunSummary {
  mode: string;
  status: string;
  count: number;
}

interface SnapshotQuality {
  total: number;
  with_price: number;
  with_tx_count: number;
  with_buy_count: number;
  with_unique_buyers: number;
}

interface OutcomeSummary {
  total: number;
  entries_triggered: number;
  hit_2x: number;
  avg_max_gain_pct: number | null;
  avg_max_drawdown_pct: number | null;
}

export async function runValidate(db: Database.Database): Promise<void> {
  console.log(JSON.stringify({
    event: 'validate_start',
    timestamp: new Date().toISOString(),
  }));

  // ── Run summary ─────────────────────────────────────────────────
  const runs = db.prepare(`
    SELECT mode, status, COUNT(*) as count
    FROM runs
    GROUP BY mode, status
    ORDER BY mode, status
  `).all() as RunSummary[];

  const totalRuns = runs.reduce((sum, r) => sum + r.count, 0);
  const completeCollectRuns = runs
    .filter(r => r.mode === 'collect' && r.status === 'complete')
    .reduce((sum, r) => sum + r.count, 0);

  console.log(JSON.stringify({
    event: 'validate_runs',
    totalRuns,
    completeCollectRuns,
    breakdown: runs,
  }));

  // ── Token summary ───────────────────────────────────────────────
  const tokenCount = (db.prepare('SELECT COUNT(*) as count FROM tokens').get() as { count: number }).count;
  const tokenRunCount = (db.prepare('SELECT COUNT(*) as count FROM token_runs').get() as { count: number }).count;

  console.log(JSON.stringify({
    event: 'validate_tokens',
    uniqueTokens: tokenCount,
    tokenRunMappings: tokenRunCount,
  }));

  // ── Snapshot quality ────────────────────────────────────────────
  const quality = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN price_sol IS NOT NULL THEN 1 ELSE 0 END) as with_price,
      SUM(CASE WHEN total_tx_count IS NOT NULL THEN 1 ELSE 0 END) as with_tx_count,
      SUM(CASE WHEN buy_count IS NOT NULL THEN 1 ELSE 0 END) as with_buy_count,
      SUM(CASE WHEN unique_buyers IS NOT NULL THEN 1 ELSE 0 END) as with_unique_buyers
    FROM snapshots
  `).get() as SnapshotQuality;

  const priceCoverage = quality.total > 0
    ? ((quality.with_price / quality.total) * 100).toFixed(1)
    : '0.0';
  const txCoverage = quality.total > 0
    ? ((quality.with_tx_count / quality.total) * 100).toFixed(1)
    : '0.0';
  const buyCoverage = quality.total > 0
    ? ((quality.with_buy_count / quality.total) * 100).toFixed(1)
    : '0.0';

  console.log(JSON.stringify({
    event: 'validate_snapshots',
    totalSnapshots: quality.total,
    priceCoveragePct: priceCoverage,
    txCountCoveragePct: txCoverage,
    buyCountCoveragePct: buyCoverage,
  }));

  // ── Snapshot phase distribution ─────────────────────────────────
  const phases = db.prepare(`
    SELECT phase, COUNT(*) as count
    FROM snapshots
    GROUP BY phase
    ORDER BY phase
  `).all() as { phase: string; count: number }[];

  console.log(JSON.stringify({
    event: 'validate_snapshot_phases',
    phases,
  }));

  // ── Outcome summary ─────────────────────────────────────────────
  const outcomes = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN entry_triggered = 1 THEN 1 ELSE 0 END) as entries_triggered,
      SUM(CASE WHEN hit_2x = 1 THEN 1 ELSE 0 END) as hit_2x,
      AVG(CASE WHEN entry_triggered = 1 THEN max_gain_pct ELSE NULL END) as avg_max_gain_pct,
      AVG(CASE WHEN entry_triggered = 1 THEN max_drawdown_pct ELSE NULL END) as avg_max_drawdown_pct
    FROM outcomes
  `).get() as OutcomeSummary;

  const entryRate = outcomes.total > 0
    ? ((outcomes.entries_triggered / outcomes.total) * 100).toFixed(1)
    : '0.0';
  const hit2xRate = outcomes.entries_triggered > 0
    ? ((outcomes.hit_2x / outcomes.entries_triggered) * 100).toFixed(1)
    : '0.0';

  console.log(JSON.stringify({
    event: 'validate_outcomes',
    totalOutcomes: outcomes.total,
    entriesTriggered: outcomes.entries_triggered,
    entryRatePct: entryRate,
    hit2x: outcomes.hit_2x,
    hit2xRatePct: hit2xRate,
    avgMaxGainPct: outcomes.avg_max_gain_pct !== null
      ? Number(outcomes.avg_max_gain_pct.toFixed(2))
      : null,
    avgMaxDrawdownPct: outcomes.avg_max_drawdown_pct !== null
      ? Number(outcomes.avg_max_drawdown_pct.toFixed(2))
      : null,
  }));

  // ── WebSocket reliability ───────────────────────────────────────
  const wsStats = db.prepare(`
    SELECT
      AVG(ws_disconnect_count) as avg_disconnects,
      AVG(ws_disconnect_ms) as avg_disconnect_ms,
      MAX(ws_disconnect_count) as max_disconnects,
      MAX(ws_disconnect_ms) as max_disconnect_ms
    FROM runs
    WHERE mode = 'collect' AND status = 'complete'
  `).get() as {
    avg_disconnects: number | null;
    avg_disconnect_ms: number | null;
    max_disconnects: number | null;
    max_disconnect_ms: number | null;
  };

  console.log(JSON.stringify({
    event: 'validate_ws_reliability',
    avgDisconnectsPerRun: wsStats.avg_disconnects !== null
      ? Number(wsStats.avg_disconnects.toFixed(1))
      : null,
    avgDisconnectMsPerRun: wsStats.avg_disconnect_ms !== null
      ? Math.round(wsStats.avg_disconnect_ms)
      : null,
    maxDisconnectsInRun: wsStats.max_disconnects,
    maxDisconnectMsInRun: wsStats.max_disconnect_ms,
  }));

  // ── RPC call estimate (from snapshot sample counts) ─────────────
  const rpcEstimate = db.prepare(`
    SELECT
      COUNT(DISTINCT run_id) as runs,
      COUNT(*) as snapshot_rounds,
      SUM(COALESCE(sample_size, 0)) as total_tx_fetched,
      -- Estimate paginated getSignaturesForAddress calls: ceil(total_tx / 1000) per round.
      -- Integer ceiling division: (n + 999) / 1000 using SQLite integer arithmetic.
      SUM((COALESCE(sample_total, 0) + 999) / 1000) as estimated_sig_pages
    FROM snapshots
  `).get() as { runs: number; snapshot_rounds: number; total_tx_fetched: number; estimated_sig_pages: number };

  // Each snapshot round costs:
  //   1 getMultipleAccounts call (bonding curve batch)
  //   ceil(total_tx_count / 1000) getSignaturesForAddress calls (paginated)
  //   sample_size getTransaction calls (one per sampled tx)
  const estimatedCalls =
    rpcEstimate.snapshot_rounds +
    rpcEstimate.estimated_sig_pages +
    rpcEstimate.total_tx_fetched;
  const callsPerRun = rpcEstimate.runs > 0
    ? Math.round(estimatedCalls / rpcEstimate.runs)
    : 0;

  console.log(JSON.stringify({
    event: 'validate_rpc_estimate',
    totalSnapshotRounds: rpcEstimate.snapshot_rounds,
    estimatedSigPages: rpcEstimate.estimated_sig_pages,
    totalTxFetched: rpcEstimate.total_tx_fetched,
    estimatedTotalRpcCalls: estimatedCalls,
    estimatedCallsPerRun: callsPerRun,
    dailyBudgetEstimate: callsPerRun * 6,
    heliusFreeTierLimit: 100000,
  }));

  // ── Overall health check ────────────────────────────────────────
  const issues: string[] = [];

  if (totalRuns === 0) issues.push('No runs found in database');
  if (completeCollectRuns === 0) issues.push('No completed collect runs');
  if (tokenCount === 0) issues.push('No tokens recorded');
  if (quality.total === 0) issues.push('No snapshots recorded');
  if (quality.total > 0 && parseFloat(priceCoverage) < 80) issues.push(`Low price coverage: ${priceCoverage}%`);
  if (quality.total > 0 && parseFloat(buyCoverage) < 50) issues.push(`Low buy count coverage: ${buyCoverage}%`);
  if (callsPerRun > 15000) issues.push(`High RPC usage per run: ${callsPerRun} (budget target: <12,000)`);

  const healthy = issues.length === 0 && totalRuns > 0;

  console.log(JSON.stringify({
    event: 'validate_complete',
    healthy,
    issues: issues.length > 0 ? issues : undefined,
    timestamp: new Date().toISOString(),
  }));
}
