import Database from 'better-sqlite3';

/**
 * Feature Engine — extracts early-stage feature vectors from snapshots
 * and correlates them with token outcomes to find predictive signals.
 */

/** A feature vector extracted at a specific time checkpoint for a token */
export interface TokenFeatureVector {
  mint: string;
  checkpointSeconds: number;

  // Raw features from snapshots
  priceSol: number;
  priceChangeFromInitial: number; // % change from first snapshot
  realSolReserves: number;
  totalTxCount: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  buyVelocity: number;
  sellRatio: number;
  buyerTxRatio: number;
  marketCapSol: number;

  // Derived momentum features
  priceAcceleration: number; // price change rate of change
  buyAcceleration: number;  // buy velocity change over window
  txBurst: number;          // max tx_count_delta in window
  holderConcentration: number; // unique_sellers / sell_count — seller concentration (0 = no sells, lower = concentrated selling)
}

/** A token with features + outcome label */
export interface LabeledToken {
  features: TokenFeatureVector;
  outcome: {
    entryTriggered: boolean;
    hitTwoX: boolean;
    maxGainPct: number;
    maxDrawdownPct: number;
    finalGainPct: number;
    maxPriceSeconds: number;
    category: 'moon' | 'pump_dump' | 'rug' | 'slow_bleed' | 'flat';
  };
}

/** Feature correlation result */
export interface FeatureCorrelation {
  featureName: string;
  /** Point-biserial correlation with hit_2x (range -1 to 1) */
  correlationWithHit2x: number;
  /** Mean feature value for tokens that hit 2x */
  meanWhenHit2x: number;
  /** Mean feature value for tokens that did NOT hit 2x */
  meanWhenNoHit2x: number;
  /** Separation ratio — how well this feature separates winners from losers */
  separationRatio: number;
  /** Optimal threshold that maximizes balanced accuracy */
  optimalThreshold: number;
  /** Accuracy at optimal threshold */
  accuracyAtThreshold: number;
}

/** Optional time range filter for analysis */
export interface TimeRange {
  startTime?: number; // Unix timestamp (seconds)
  endTime?: number;   // Unix timestamp (seconds)
}

/**
 * Extract feature vectors for all tokens at a given checkpoint (seconds since creation).
 * Uses the closest snapshot to the requested checkpoint.
 * Optionally filters tokens by creation time range.
 */
export function extractFeatureVectors(
  db: Database.Database,
  checkpointSeconds: number,
  maxCheckpointDrift: number = 10,
  timeRange?: TimeRange
): TokenFeatureVector[] {
  // Build optional time filter on token creation date
  let timeFilter = '';
  const timeParams: number[] = [];
  if (timeRange?.startTime) {
    timeFilter += ' AND t.created_at >= ?';
    timeParams.push(timeRange.startTime);
  }
  if (timeRange?.endTime) {
    timeFilter += ' AND t.created_at <= ?';
    timeParams.push(timeRange.endTime);
  }

  // Get the closest snapshot to the checkpoint for each token
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT
        s.*,
        t.initial_price_sol,
        ROW_NUMBER() OVER (PARTITION BY s.mint ORDER BY ABS(s.seconds_since_creation - ?) ASC) as rn,
        ABS(s.seconds_since_creation - ?) as drift
      FROM snapshots s
      JOIN tokens t ON t.mint = s.mint
      WHERE 1=1${timeFilter}
    )
    SELECT * FROM ranked
    WHERE rn = 1 AND drift <= ?
  `).all(checkpointSeconds, checkpointSeconds, ...timeParams, maxCheckpointDrift) as any[];

  // Collect mints that passed the time filter for use in subsequent queries
  const mintSet = new Set(rows.map((r: any) => r.mint));

  // For momentum features, also get the snapshot ~10s before the checkpoint
  const prevRows = db.prepare(`
    WITH ranked AS (
      SELECT
        s.mint,
        s.price_sol,
        s.buy_velocity,
        s.total_tx_count,
        s.tx_count_delta,
        ROW_NUMBER() OVER (PARTITION BY s.mint ORDER BY ABS(s.seconds_since_creation - ?) ASC) as rn
      FROM snapshots s
    )
    SELECT * FROM ranked WHERE rn = 1
  `).all(checkpointSeconds - 10) as any[];

  const prevMap = new Map(prevRows.map((r: any) => [r.mint, r]));

  // For each token, also get the max tx_count_delta in the window up to checkpoint
  const burstRows = db.prepare(`
    SELECT mint, MAX(tx_count_delta) as max_burst
    FROM snapshots
    WHERE seconds_since_creation <= ? AND seconds_since_creation >= 0
    GROUP BY mint
  `).all(checkpointSeconds) as any[];

  const burstMap = new Map(burstRows.map((r: any) => [r.mint, r.max_burst ?? 0]));

  return rows.map((row: any) => {
    const prev = prevMap.get(row.mint);
    const initialPrice = row.initial_price_sol ?? row.price_sol ?? 0;
    const currentPrice = row.price_sol ?? 0;
    const prevPrice = prev?.price_sol ?? currentPrice;
    const prevBuyVelocity = prev?.buy_velocity ?? 0;

    return {
      mint: row.mint,
      checkpointSeconds,
      priceSol: currentPrice,
      priceChangeFromInitial: initialPrice > 0
        ? ((currentPrice - initialPrice) / initialPrice) * 100
        : 0,
      realSolReserves: row.real_sol_reserves ?? 0,
      totalTxCount: row.total_tx_count ?? 0,
      buyCount: row.buy_count ?? 0,
      sellCount: row.sell_count ?? 0,
      uniqueBuyers: row.unique_buyers ?? 0,
      uniqueSellers: row.unique_sellers ?? 0,
      buyVelocity: row.buy_velocity ?? 0,
      sellRatio: row.sell_ratio ?? 0,
      buyerTxRatio: row.buyer_tx_ratio ?? 0,
      marketCapSol: row.market_cap_sol ?? 0,

      // Momentum
      priceAcceleration: prevPrice > 0
        ? ((currentPrice - prevPrice) / prevPrice) * 100
        : 0,
      buyAcceleration: (row.buy_velocity ?? 0) - prevBuyVelocity,
      txBurst: burstMap.get(row.mint) ?? 0,
      holderConcentration: (row.sell_count ?? 0) > 0
        ? (row.unique_sellers ?? 0) / (row.sell_count ?? 0)
        : 0,
    };
  });
}

/**
 * Build labeled dataset by joining feature vectors with outcomes.
 */
export function buildLabeledDataset(
  db: Database.Database,
  checkpointSeconds: number,
  timeRange?: TimeRange
): LabeledToken[] {
  const features = extractFeatureVectors(db, checkpointSeconds, 10, timeRange);
  const featureMap = new Map(features.map(f => [f.mint, f]));

  // Get outcomes
  const outcomes = db.prepare(`
    SELECT * FROM outcomes WHERE entry_triggered = 1
  `).all() as any[];

  const labeled: LabeledToken[] = [];

  for (const o of outcomes) {
    const f = featureMap.get(o.mint);
    if (!f) continue;

    const maxGain = o.max_gain_pct ?? 0;
    const finalGain = o.final_gain_pct ?? 0;
    const maxDrawdown = o.max_drawdown_pct ?? 0;
    const maxPriceSeconds = o.max_price_seconds ?? 0;

    let category: LabeledToken['outcome']['category'] = 'flat';
    if (maxGain >= 100 && finalGain >= 50) category = 'moon';
    else if (maxGain >= 50 && finalGain <= 0) category = 'pump_dump';
    else if (maxDrawdown <= -80) category = 'rug';
    else if (maxGain < 50 && finalGain < -30) category = 'slow_bleed';

    labeled.push({
      features: f,
      outcome: {
        entryTriggered: true,
        hitTwoX: o.hit_2x === 1,
        maxGainPct: maxGain,
        maxDrawdownPct: maxDrawdown,
        finalGainPct: finalGain,
        maxPriceSeconds: maxPriceSeconds,
        category,
      },
    });
  }

  return labeled;
}

/**
 * Also build labeled dataset including tokens that did NOT trigger entry.
 * These are tokens with snapshots but no outcome row (or entry_triggered = 0).
 * We label them based on their price trajectory from snapshots alone.
 */
export function buildFullDataset(
  db: Database.Database,
  checkpointSeconds: number,
  timeRange?: TimeRange
): LabeledToken[] {
  const features = extractFeatureVectors(db, checkpointSeconds, 10, timeRange);
  const featureMap = new Map(features.map(f => [f.mint, f]));

  // Get all outcomes (both triggered and not)
  const outcomes = db.prepare(`SELECT * FROM outcomes`).all() as any[];
  const outcomeMap = new Map(outcomes.map((o: any) => [o.mint, o]));

  const labeled: LabeledToken[] = [];

  for (const [mint, f] of featureMap) {
    const o = outcomeMap.get(mint);

    if (o) {
      const maxGain = o.max_gain_pct ?? 0;
      const finalGain = o.final_gain_pct ?? 0;
      const maxDrawdown = o.max_drawdown_pct ?? 0;

      let category: LabeledToken['outcome']['category'] = 'flat';
      if (maxGain >= 100 && finalGain >= 50) category = 'moon';
      else if (maxGain >= 50 && finalGain <= 0) category = 'pump_dump';
      else if (maxDrawdown <= -80) category = 'rug';
      else if (maxGain < 50 && finalGain < -30) category = 'slow_bleed';

      labeled.push({
        features: f,
        outcome: {
          entryTriggered: o.entry_triggered === 1,
          hitTwoX: o.hit_2x === 1,
          maxGainPct: maxGain,
          maxDrawdownPct: maxDrawdown,
          finalGainPct: finalGain,
          maxPriceSeconds: o.max_price_seconds ?? 0,
          category,
        },
      });
    } else {
      // No outcome row — derive from snapshots
      const snapshots = db.prepare(`
        SELECT price_sol, seconds_since_creation
        FROM snapshots WHERE mint = ? AND price_sol IS NOT NULL
        ORDER BY seconds_since_creation ASC
      `).all(mint) as any[];

      if (snapshots.length < 2) continue;

      const entryPrice = snapshots[0].price_sol;
      const prices = snapshots.map((s: any) => s.price_sol);
      const maxPrice = Math.max(...prices);
      const finalPrice = prices[prices.length - 1];
      const minAfterFirst = Math.min(...prices.slice(1));

      const maxGain = entryPrice > 0 ? ((maxPrice - entryPrice) / entryPrice) * 100 : 0;
      const finalGain = entryPrice > 0 ? ((finalPrice - entryPrice) / entryPrice) * 100 : 0;
      const maxDrawdown = entryPrice > 0 ? ((minAfterFirst - entryPrice) / entryPrice) * 100 : 0;

      let category: LabeledToken['outcome']['category'] = 'flat';
      if (maxGain >= 100 && finalGain >= 50) category = 'moon';
      else if (maxGain >= 50 && finalGain <= 0) category = 'pump_dump';
      else if (maxDrawdown <= -80) category = 'rug';
      else if (maxGain < 50 && finalGain < -30) category = 'slow_bleed';

      labeled.push({
        features: f,
        outcome: {
          entryTriggered: false,
          hitTwoX: maxGain >= 100,
          maxGainPct: maxGain,
          maxDrawdownPct: maxDrawdown,
          finalGainPct: finalGain,
          maxPriceSeconds: 0,
          category,
        },
      });
    }
  }

  return labeled;
}

/**
 * Compute feature correlations with hit_2x outcome.
 * Uses point-biserial correlation and threshold optimization.
 */
export function computeCorrelations(dataset: LabeledToken[]): FeatureCorrelation[] {
  if (dataset.length < 5) return [];

  const featureNames: (keyof TokenFeatureVector)[] = [
    'priceSol', 'priceChangeFromInitial', 'realSolReserves', 'totalTxCount',
    'buyCount', 'sellCount', 'uniqueBuyers', 'uniqueSellers',
    'buyVelocity', 'sellRatio', 'buyerTxRatio', 'marketCapSol',
    'priceAcceleration', 'buyAcceleration', 'txBurst', 'holderConcentration',
  ];

  const results: FeatureCorrelation[] = [];

  for (const name of featureNames) {
    const values = dataset.map(d => d.features[name] as number);
    const labels = dataset.map(d => d.outcome.hitTwoX ? 1 : 0);

    // Point-biserial correlation
    const n = values.length;
    const n1 = labels.filter(l => l === 1).length;
    const n0 = n - n1;

    if (n1 === 0 || n0 === 0) {
      results.push({
        featureName: name,
        correlationWithHit2x: 0,
        meanWhenHit2x: 0,
        meanWhenNoHit2x: 0,
        separationRatio: 0,
        optimalThreshold: 0,
        accuracyAtThreshold: 0,
      });
      continue;
    }

    const mean1 = values.filter((_, i) => labels[i] === 1).reduce((a, b) => a + b, 0) / n1;
    const mean0 = values.filter((_, i) => labels[i] === 0).reduce((a, b) => a + b, 0) / n0;
    const meanAll = values.reduce((a, b) => a + b, 0) / n;
    const stdAll = Math.sqrt(values.reduce((sum, v) => sum + (v - meanAll) ** 2, 0) / n);

    const correlation = stdAll > 0
      ? ((mean1 - mean0) / stdAll) * Math.sqrt((n1 * n0) / (n * n))
      : 0;

    const separationRatio = mean0 !== 0 ? Math.abs(mean1 / mean0) : Math.abs(mean1);

    // Find optimal threshold (maximize balanced accuracy)
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    let bestThreshold = 0;
    let bestAccuracy = 0;

    for (let i = 0; i < sorted.length - 1; i++) {
      const threshold = (sorted[i] + sorted[i + 1]) / 2;

      // Try both directions (feature > threshold = positive, or < threshold = positive)
      for (const direction of [1, -1]) {
        let tp = 0, tn = 0, fp = 0, fn = 0;
        for (let j = 0; j < n; j++) {
          const predicted = direction === 1 ? (values[j] >= threshold ? 1 : 0) : (values[j] < threshold ? 1 : 0);
          if (predicted === 1 && labels[j] === 1) tp++;
          else if (predicted === 0 && labels[j] === 0) tn++;
          else if (predicted === 1 && labels[j] === 0) fp++;
          else fn++;
        }
        const sensitivity = tp + fn > 0 ? tp / (tp + fn) : 0;
        const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
        const balancedAcc = (sensitivity + specificity) / 2;

        if (balancedAcc > bestAccuracy) {
          bestAccuracy = balancedAcc;
          bestThreshold = direction === 1 ? threshold : -threshold; // negative = "below threshold is positive"
        }
      }
    }

    results.push({
      featureName: name,
      correlationWithHit2x: correlation,
      meanWhenHit2x: mean1,
      meanWhenNoHit2x: mean0,
      separationRatio,
      optimalThreshold: bestThreshold,
      accuracyAtThreshold: bestAccuracy,
    });
  }

  return results.sort((a, b) => Math.abs(b.correlationWithHit2x) - Math.abs(a.correlationWithHit2x));
}
