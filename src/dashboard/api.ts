import http from 'http';
import Database from 'better-sqlite3';

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function errorResponse(res: http.ServerResponse, message: string, status = 400): void {
  jsonResponse(res, { error: message }, status);
}

export function handleApiRequest(
  db: Database.Database,
  url: URL,
  res: http.ServerResponse
): void {
  try {
    if (url.pathname === '/api/tokens') {
      return getTokens(db, url, res);
    }

    if (url.pathname === '/api/token') {
      return getTokenDetail(db, url, res);
    }

    if (url.pathname === '/api/stats') {
      return getStats(db, res);
    }

    errorResponse(res, 'Not found', 404);
  } catch (err) {
    console.error(JSON.stringify({
      event: 'api_error',
      path: url.pathname,
      error: err instanceof Error ? err.message : String(err),
    }));
    errorResponse(res, 'Internal server error', 500);
  }
}

/** GET /api/tokens — List tracked tokens with summary data */
function getTokens(db: Database.Database, url: URL, res: http.ServerResponse): void {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '20', 10) || 20));
  const offset = (page - 1) * limit;

  // Sorting — whitelist allowed columns
  const allowedSorts: Record<string, string> = {
    'last_price': 'last_price',
    'change': 'change_pct',
    'market_cap': 'last_market_cap',
    'created': 't.created_at',
    'analysis_ended': 'analysis_ended_at',
    'snapshots': 'snapshot_count',
  };
  const sortParam = url.searchParams.get('sort') ?? 'analysis_ended';
  const orderParam = url.searchParams.get('order') ?? 'desc';
  const sortCol = allowedSorts[sortParam] ?? 'analysis_ended_at';
  const sortDir = orderParam.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const countRow = db.prepare(`
    SELECT COUNT(DISTINCT t.mint) as total
    FROM tokens t
    INNER JOIN runs r ON r.run_id IN (SELECT run_id FROM token_runs WHERE mint = t.mint)
    WHERE r.status = 'complete'
  `).get() as { total: number };

  const tokens = db.prepare(`
    SELECT
      t.mint,
      t.name,
      t.symbol,
      t.creator,
      t.created_at,
      t.initial_price_sol,
      r.run_id,
      r.started_at as tracked_at,
      (SELECT COUNT(*) FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id) as snapshot_count,
      (SELECT s.price_sol FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id ORDER BY s.seconds_since_creation ASC LIMIT 1) as first_price,
      (SELECT s.price_sol FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id ORDER BY s.seconds_since_creation DESC LIMIT 1) as last_price,
      (SELECT MAX(s.price_sol) FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id) as max_price,
      (SELECT MIN(s.price_sol) FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id AND s.price_sol IS NOT NULL) as min_price,
      (SELECT MAX(s.total_tx_count) FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id) as max_tx_count,
      (SELECT s.market_cap_sol FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id ORDER BY s.seconds_since_creation DESC LIMIT 1) as last_market_cap,
      r.completed_at as analysis_ended_at,
      (SELECT s.snapshot_at FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id ORDER BY s.seconds_since_creation DESC LIMIT 1) as last_snapshot_at,
      CASE
        WHEN (SELECT s.price_sol FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id ORDER BY s.seconds_since_creation ASC LIMIT 1) > 0
        THEN ((SELECT s.price_sol FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id ORDER BY s.seconds_since_creation DESC LIMIT 1)
             - (SELECT s.price_sol FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id ORDER BY s.seconds_since_creation ASC LIMIT 1))
             / (SELECT s.price_sol FROM snapshots s WHERE s.mint = t.mint AND s.run_id = r.run_id ORDER BY s.seconds_since_creation ASC LIMIT 1) * 100
        ELSE 0
      END as change_pct
    FROM tokens t
    INNER JOIN token_runs tr ON tr.mint = t.mint
    INNER JOIN runs r ON r.run_id = tr.run_id AND r.status = 'complete'
    ORDER BY ${sortCol} ${sortDir}
    LIMIT ? OFFSET ?
  `).all(limit, offset) as any[];

  jsonResponse(res, {
    tokens,
    pagination: {
      page,
      limit,
      total: countRow.total,
      totalPages: Math.ceil(countRow.total / limit),
    },
  });
}

/** GET /api/token?mint=...&run_id=... — Full snapshot timeline for a token */
function getTokenDetail(db: Database.Database, url: URL, res: http.ServerResponse): void {
  const mint = url.searchParams.get('mint');
  if (!mint) {
    return errorResponse(res, 'mint parameter required');
  }

  // If run_id not specified, use the most recent run for this token
  let runId = url.searchParams.get('run_id');
  if (!runId) {
    const row = db.prepare(`
      SELECT tr.run_id FROM token_runs tr
      INNER JOIN runs r ON r.run_id = tr.run_id AND r.status = 'complete'
      WHERE tr.mint = ?
      ORDER BY r.started_at DESC
      LIMIT 1
    `).get(mint) as { run_id: string } | undefined;

    if (!row) {
      return errorResponse(res, 'Token not found', 404);
    }
    runId = row.run_id;
  }

  const token = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint);
  if (!token) {
    return errorResponse(res, 'Token not found', 404);
  }

  const snapshots = db.prepare(`
    SELECT * FROM snapshots
    WHERE mint = ? AND run_id = ?
    ORDER BY seconds_since_creation ASC
  `).all(mint, runId);

  const run = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);

  jsonResponse(res, { token, run, snapshots });
}

/** GET /api/stats — Overall dashboard statistics */
function getStats(db: Database.Database, res: http.ServerResponse): void {
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tokens) as total_tokens,
      (SELECT COUNT(*) FROM runs WHERE status = 'complete') as completed_runs,
      (SELECT COUNT(*) FROM runs WHERE status = 'running') as active_runs,
      (SELECT COUNT(*) FROM runs WHERE status = 'failed') as failed_runs,
      (SELECT COUNT(*) FROM snapshots) as total_snapshots,
      (SELECT AVG(cnt) FROM (SELECT COUNT(*) as cnt FROM snapshots GROUP BY mint, run_id)) as avg_snapshots_per_token,
      (SELECT COUNT(DISTINCT creator) FROM tokens) as unique_creators
  `).get();

  const recentRun = db.prepare(`
    SELECT * FROM runs
    WHERE status = 'complete'
    ORDER BY started_at DESC
    LIMIT 1
  `).get();

  // Get active run details if any
  const activeRun = db.prepare(`
    SELECT r.*,
      (SELECT COUNT(DISTINCT tr.mint) FROM token_runs tr WHERE tr.run_id = r.run_id) as tokens_tracking
    FROM runs r
    WHERE r.status = 'running'
    ORDER BY r.started_at DESC
    LIMIT 1
  `).get();

  jsonResponse(res, { stats, recentRun, activeRun });
}
