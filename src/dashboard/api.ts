import http from 'http';
import Database from 'better-sqlite3';
import {
  extractFeatureVectors,
  buildLabeledDataset,
  buildFullDataset,
  computeCorrelations,
  buildScoringModel,
  scoreToken,
  backtestModel,
} from '../analysis';

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

    if (url.pathname === '/api/analysis/correlations') {
      return getCorrelations(db, url, res);
    }

    if (url.pathname === '/api/analysis/backtest') {
      return getBacktest(db, url, res);
    }

    if (url.pathname === '/api/analysis/score') {
      return getScore(db, url, res);
    }

    if (url.pathname === '/api/analysis/model') {
      return getModel(db, url, res);
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

  // Filters
  const search = url.searchParams.get('search') ?? '';
  const parseNum = (v: string | null): number | null => {
    if (v == null || v === '') return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };
  const minPrice = parseNum(url.searchParams.get('min_price'));
  const maxPrice = parseNum(url.searchParams.get('max_price'));
  const minChange = parseNum(url.searchParams.get('min_change'));
  const maxChange = parseNum(url.searchParams.get('max_change'));
  const minMcap = parseNum(url.searchParams.get('min_mcap'));
  const maxMcap = parseNum(url.searchParams.get('max_mcap'));

  // Build dynamic WHERE clauses for filters (applied to outer query via HAVING-style CTE)
  const filterClauses: string[] = [];
  const filterParams: unknown[] = [];

  if (search) {
    filterClauses.push(`(t.name LIKE ? OR t.symbol LIKE ? OR t.mint LIKE ?)`);
    const like = `%${search}%`;
    filterParams.push(like, like, like);
  }

  const baseQuery = `
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
    ${filterClauses.length > 0 ? 'WHERE ' + filterClauses.join(' AND ') : ''}
  `;

  // Wrap in CTE to filter on computed columns (last_price, change_pct, last_market_cap)
  const havingClauses: string[] = [];
  const havingParams: unknown[] = [];
  if (minPrice != null) { havingClauses.push('last_price >= ?'); havingParams.push(minPrice); }
  if (maxPrice != null) { havingClauses.push('last_price <= ?'); havingParams.push(maxPrice); }
  if (minChange != null) { havingClauses.push('change_pct >= ?'); havingParams.push(minChange); }
  if (maxChange != null) { havingClauses.push('change_pct <= ?'); havingParams.push(maxChange); }
  if (minMcap != null) { havingClauses.push('last_market_cap >= ?'); havingParams.push(minMcap); }
  if (maxMcap != null) { havingClauses.push('last_market_cap <= ?'); havingParams.push(maxMcap); }

  const havingWhere = havingClauses.length > 0 ? 'WHERE ' + havingClauses.join(' AND ') : '';

  const countRow = db.prepare(`
    SELECT COUNT(*) as total FROM (${baseQuery}) sub ${havingWhere}
  `).get(...filterParams, ...havingParams) as { total: number };

  const tokens = db.prepare(`
    SELECT * FROM (${baseQuery}) sub ${havingWhere}
    ORDER BY ${sortCol} ${sortDir}
    LIMIT ? OFFSET ?
  `).all(...filterParams, ...havingParams, limit, offset) as any[];

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

// ─── Analysis Endpoints ───

/**
 * GET /api/analysis/correlations?checkpoint=30&full=true
 * Returns feature correlations with hit_2x outcome.
 */
function getCorrelations(db: Database.Database, url: URL, res: http.ServerResponse): void {
  const checkpoint = parseInt(url.searchParams.get('checkpoint') ?? '30', 10);
  const full = url.searchParams.get('full') === 'true';

  const dataset = full ? buildFullDataset(db, checkpoint) : buildLabeledDataset(db, checkpoint);

  if (dataset.length < 5) {
    return jsonResponse(res, {
      error: 'Insufficient data',
      datasetSize: dataset.length,
      checkpoint,
    });
  }

  const correlations = computeCorrelations(dataset);

  jsonResponse(res, {
    checkpoint,
    datasetSize: dataset.length,
    hit2xCount: dataset.filter(d => d.outcome.hitTwoX).length,
    hit2xRate: (dataset.filter(d => d.outcome.hitTwoX).length / dataset.length) * 100,
    correlations,
  });
}

/**
 * GET /api/analysis/backtest?checkpoint=30&full=true
 * Returns full backtest report with scoring model and results.
 */
function getBacktest(db: Database.Database, url: URL, res: http.ServerResponse): void {
  const checkpoint = parseInt(url.searchParams.get('checkpoint') ?? '30', 10);
  const full = url.searchParams.get('full') === 'true';

  const dataset = full ? buildFullDataset(db, checkpoint) : buildLabeledDataset(db, checkpoint);

  if (dataset.length < 5) {
    return jsonResponse(res, {
      error: 'Insufficient data',
      datasetSize: dataset.length,
      checkpoint,
    });
  }

  const correlations = computeCorrelations(dataset);
  const model = buildScoringModel(correlations, dataset, checkpoint);
  const report = backtestModel(model, dataset);

  jsonResponse(res, report);
}

/**
 * GET /api/analysis/score?mint=<mint>&checkpoint=30
 * Score a specific token using the trained model.
 * This is the endpoint the trading bot calls to get a buy signal.
 */
function getScore(db: Database.Database, url: URL, res: http.ServerResponse): void {
  const mint = url.searchParams.get('mint');
  if (!mint) {
    return errorResponse(res, 'mint parameter required');
  }

  const checkpoint = parseInt(url.searchParams.get('checkpoint') ?? '30', 10);

  // Build model from historical data
  const dataset = buildFullDataset(db, checkpoint);
  if (dataset.length < 5) {
    return jsonResponse(res, {
      error: 'Insufficient training data',
      datasetSize: dataset.length,
    });
  }

  const correlations = computeCorrelations(dataset);
  const model = buildScoringModel(correlations, dataset, checkpoint);

  // Get features for the requested token
  const features = extractFeatureVectors(db, checkpoint);
  const tokenFeatures = features.find(f => f.mint === mint);

  if (!tokenFeatures) {
    return errorResponse(res, `Token ${mint} not found at ${checkpoint}s checkpoint`, 404);
  }

  const score = scoreToken(model, tokenFeatures);

  jsonResponse(res, {
    ...score,
    model: {
      checkpointSeconds: model.checkpointSeconds,
      sampleCount: model.sampleCount,
      baseRate2x: model.baseRate2x,
    },
  });
}

/**
 * GET /api/analysis/model?checkpoint=30&full=true
 * Returns the current scoring model (rules + weights).
 * The trading bot can cache this and run scoring locally.
 */
function getModel(db: Database.Database, url: URL, res: http.ServerResponse): void {
  const checkpoint = parseInt(url.searchParams.get('checkpoint') ?? '30', 10);
  const full = url.searchParams.get('full') === 'true';

  const dataset = full ? buildFullDataset(db, checkpoint) : buildLabeledDataset(db, checkpoint);

  if (dataset.length < 5) {
    return jsonResponse(res, {
      error: 'Insufficient data',
      datasetSize: dataset.length,
    });
  }

  const correlations = computeCorrelations(dataset);
  const model = buildScoringModel(correlations, dataset, checkpoint);

  jsonResponse(res, {
    model,
    correlations: correlations.slice(0, 10), // Top 10 features
    datasetStats: {
      totalTokens: dataset.length,
      hit2xCount: dataset.filter(d => d.outcome.hitTwoX).length,
      hit2xRate: (dataset.filter(d => d.outcome.hitTwoX).length / dataset.length) * 100,
      categoryBreakdown: dataset.reduce((acc, d) => {
        acc[d.outcome.category] = (acc[d.outcome.category] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    },
  });
}
