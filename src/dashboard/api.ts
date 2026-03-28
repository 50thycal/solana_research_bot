import http from 'http';
import Database from 'better-sqlite3';
import { logError } from '../logger';
import {
  extractFeatureVectors,
  buildLabeledDataset,
  buildFullDataset,
  computeCorrelations,
  buildDualScoringModel,
  scoreToken,
  scoreTokenDual,
  backtestModel,
  computeScoreTrajectory,
  type TimeRange,
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

    if (url.pathname === '/api/analysis/trajectory') {
      return getTrajectory(db, url, res);
    }

    errorResponse(res, 'Not found', 404);
  } catch (err) {
    logError({
      event: 'api_error',
      path: url.pathname,
      error: err instanceof Error ? err.message : String(err),
    });
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

  // Get active run details — with parallel tracking there can be multiple
  const activeRuns = db.prepare(`
    SELECT r.*,
      (SELECT COUNT(DISTINCT tr.mint) FROM token_runs tr WHERE tr.run_id = r.run_id) as tokens_tracking
    FROM runs r
    WHERE r.status = 'running'
    ORDER BY r.started_at ASC
  `).all() as any[];

  // Build a summary for the frontend
  const activeRun = activeRuns.length > 0 ? {
    // Use the earliest start time
    started_at: activeRuns[0].started_at,
    // Total tokens being tracked across all active runs
    tokens_tracking: activeRuns.length,
    entries_triggered: activeRuns.reduce((sum: number, r: any) => sum + (r.entries_triggered || 0), 0),
    active_count: activeRuns.length,
  } : null;

  jsonResponse(res, { stats, recentRun, activeRun });
}

// ─── Analysis Endpoints ───

/** Parse optional start/end time range from query params (Unix seconds or ISO string) */
function parseTimeRange(url: URL): TimeRange | undefined {
  const startStr = url.searchParams.get('start');
  const endStr = url.searchParams.get('end');
  if (!startStr && !endStr) return undefined;

  const parseTs = (s: string | null): number | undefined => {
    if (!s) return undefined;
    const n = Number(s);
    // If it's a valid number, treat as Unix seconds
    if (!isNaN(n) && n > 0) return n;
    // Otherwise try ISO date parse (returns ms)
    const d = new Date(s);
    if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
    return undefined;
  };

  const startTime = parseTs(startStr);
  const endTime = parseTs(endStr);
  if (!startTime && !endTime) return undefined;
  return { startTime, endTime };
}

/**
 * GET /api/analysis/correlations?checkpoint=30&full=true
 * Returns feature correlations with hit_2x outcome.
 */
function getCorrelations(db: Database.Database, url: URL, res: http.ServerResponse): void {
  const checkpoint = parseInt(url.searchParams.get('checkpoint') ?? '30', 10);
  const full = url.searchParams.get('full') === 'true';
  const timeRange = parseTimeRange(url);

  const dataset = full ? buildFullDataset(db, checkpoint, timeRange) : buildLabeledDataset(db, checkpoint, timeRange);

  if (dataset.length < 5) {
    return jsonResponse(res, {
      error: 'Insufficient data',
      datasetSize: dataset.length,
      checkpoint,
    });
  }

  const correlations = computeCorrelations(dataset);
  const dumpCount = dataset.filter(d => d.outcome.isDump).length;

  // Two sorted views: by hitTwoX correlation (default) and by isDump correlation
  const correlationsByDump = [...correlations].sort(
    (a, b) => Math.abs(b.correlationWithIsDump) - Math.abs(a.correlationWithIsDump)
  );

  jsonResponse(res, {
    checkpoint,
    datasetSize: dataset.length,
    hit2xCount: dataset.filter(d => d.outcome.hitTwoX).length,
    hit2xRate: (dataset.filter(d => d.outcome.hitTwoX).length / dataset.length) * 100,
    dumpCount,
    dumpRate: dataset.length > 0 ? (dumpCount / dataset.length) * 100 : 0,
    correlations,
    correlationsByDump,
  });
}

/**
 * GET /api/analysis/backtest?checkpoint=30&full=true
 * Returns full backtest report with scoring model and results.
 */
function getBacktest(db: Database.Database, url: URL, res: http.ServerResponse): void {
  const checkpoint = parseInt(url.searchParams.get('checkpoint') ?? '30', 10);
  const full = url.searchParams.get('full') === 'true';
  const timeRange = parseTimeRange(url);

  const dataset = full ? buildFullDataset(db, checkpoint, timeRange) : buildLabeledDataset(db, checkpoint, timeRange);

  if (dataset.length < 5) {
    return jsonResponse(res, {
      error: 'Insufficient data',
      datasetSize: dataset.length,
      checkpoint,
    });
  }

  const correlations = computeCorrelations(dataset);
  const dualModel = buildDualScoringModel(correlations, dataset, checkpoint);
  const report = backtestModel(dualModel.opportunityModel, dataset);

  // For the recommended opportunity threshold, compute dump rate at different risk thresholds
  const bestOppThreshold = report.bestThreshold.scoreThreshold;
  const riskThresholds = [50, 60, 70];
  const riskAnalysis = riskThresholds.map(riskThreshold => {
    const filtered = dataset.filter(d => {
      const oppScore = scoreToken(dualModel.opportunityModel, d.features).score;
      const riskScore = scoreToken(dualModel.riskModel, d.features).score;
      return oppScore >= bestOppThreshold && riskScore < riskThreshold;
    });
    const hit2x = filtered.filter(d => d.outcome.hitTwoX).length;
    const dumps = filtered.filter(d => d.outcome.isDump).length;
    return {
      riskThreshold,
      tokensRemaining: filtered.length,
      hit2xRate: filtered.length > 0 ? (hit2x / filtered.length) * 100 : 0,
      dumpRate: filtered.length > 0 ? (dumps / filtered.length) * 100 : 0,
    };
  });

  jsonResponse(res, {
    ...report,
    riskModel: dualModel.riskModel,
    riskAnalysis,
  });
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
  const timeRange = parseTimeRange(url);
  const dataset = buildFullDataset(db, checkpoint, timeRange);
  if (dataset.length < 5) {
    return jsonResponse(res, {
      error: 'Insufficient training data',
      datasetSize: dataset.length,
    });
  }

  const correlations = computeCorrelations(dataset);
  const dualModel = buildDualScoringModel(correlations, dataset, checkpoint);

  // Get features for the requested token
  const features = extractFeatureVectors(db, checkpoint);
  const tokenFeatures = features.find(f => f.mint === mint);

  if (!tokenFeatures) {
    return errorResponse(res, `Token ${mint} not found at ${checkpoint}s checkpoint`, 404);
  }

  const dualScore = scoreTokenDual(dualModel, tokenFeatures);
  // Legacy compatibility: keep returning a single `score` field that maps
  // to the opportunity score used by older trading bot clients.
  const score = scoreToken(dualModel.opportunityModel, tokenFeatures);

  jsonResponse(res, {
    ...dualScore,
    score: score.score,
    model: {
      checkpointSeconds: dualModel.opportunityModel.checkpointSeconds,
      sampleCount: dualModel.opportunityModel.sampleCount,
      baseRate2x: dualModel.opportunityModel.baseRate2x,
    },
    opportunityModel: {
      checkpointSeconds: dualModel.opportunityModel.checkpointSeconds,
      sampleCount: dualModel.opportunityModel.sampleCount,
      baseRate2x: dualModel.opportunityModel.baseRate2x,
    },
    riskModel: {
      checkpointSeconds: dualModel.riskModel.checkpointSeconds,
      sampleCount: dualModel.riskModel.sampleCount,
      baseRate2x: dualModel.riskModel.baseRate2x,
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
  const timeRange = parseTimeRange(url);

  const dataset = full ? buildFullDataset(db, checkpoint, timeRange) : buildLabeledDataset(db, checkpoint, timeRange);

  if (dataset.length < 5) {
    return jsonResponse(res, {
      error: 'Insufficient data',
      datasetSize: dataset.length,
    });
  }

  const correlations = computeCorrelations(dataset);
  const dualModel = buildDualScoringModel(correlations, dataset, checkpoint);
  const dumpCount = dataset.filter(d => d.outcome.isDump).length;

  const datasetStats = {
    totalTokens: dataset.length,
    hit2xCount: dataset.filter(d => d.outcome.hitTwoX).length,
    hit2xRate: (dataset.filter(d => d.outcome.hitTwoX).length / dataset.length) * 100,
    dumpCount,
    dumpRate: dataset.length > 0 ? (dumpCount / dataset.length) * 100 : 0,
    categoryBreakdown: dataset.reduce((acc, d) => {
      acc[d.outcome.category] = (acc[d.outcome.category] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };

  jsonResponse(res, {
    // Backward-compatible: legacy consumers get the opportunity model as `model`
    model: dualModel.opportunityModel,
    // Dual model response
    opportunityModel: dualModel.opportunityModel,
    riskModel: dualModel.riskModel,
    correlations: correlations.slice(0, 10),
    datasetStats,
  });
}

/**
 * GET /api/analysis/trajectory?mint=<mint>
 * Score a token across all checkpoints (5,10,15,30,45,60,90,120s).
 * Shows how the score evolves over time — rising = growing conviction.
 * The trading bot uses this to decide the optimal entry point.
 */
function getTrajectory(db: Database.Database, url: URL, res: http.ServerResponse): void {
  const mint = url.searchParams.get('mint');
  if (!mint) {
    return errorResponse(res, 'mint parameter required');
  }

  const trajectory = computeScoreTrajectory(db, mint);

  if (trajectory.checkpoints.length === 0) {
    return errorResponse(res, `No checkpoint data found for token ${mint}`, 404);
  }

  jsonResponse(res, trajectory);
}
