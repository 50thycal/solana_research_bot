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
  sellDistribution: number; // unique_sellers / sell_count — seller concentration (0 = no sells, lower = concentrated selling)

  // Momentum freshness features
  timeSincePeakVelocity: number; // seconds between peak buy_velocity and checkpoint — shorter = momentum is live
  buyVelocityTrend: number;      // slope of buy_velocity across last 2-3 snapshots — positive = accelerating, negative = decelerating

  // Sell-pressure features
  sellVelocity: number;             // sells per second since creation
  sellAcceleration: number;         // rate of change of sell velocity vs previous snapshot
  topSellerConcentration: number;   // fraction of sell txs from top 3 wallets
  volumeVelocitySol: number;        // SOL volume per second in the snapshot interval
}

/** A token with features + outcome label */
export interface LabeledToken {
  features: TokenFeatureVector;
  outcome: {
    entryTriggered: boolean;
    hitTwoX: boolean;
    /** True when category is rug, pump_dump, or pump_then_dump */
    isDump: boolean;
    maxGainPct: number;
    maxDrawdownPct: number;
    finalGainPct: number;
    maxPriceSeconds: number;
    category: 'moon' | 'pump_dump' | 'pump_then_dump' | 'rug' | 'slow_bleed' | 'flat';
  };
}

/** Feature correlation result */
export interface FeatureCorrelation {
  featureName: string;
  /** Point-biserial correlation with hit_2x (range -1 to 1) */
  correlationWithHit2x: number;
  /** Point-biserial correlation with isDump (range -1 to 1) */
  correlationWithIsDump: number;
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
  /** Optimal threshold for isDump prediction */
  optimalThresholdDump: number;
  /** Accuracy at optimal isDump threshold */
  accuracyAtThresholdDump: number;
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

  // For momentum freshness features, get all snapshots up to checkpoint for each token
  const velocityRows = db.prepare(`
    SELECT mint, buy_velocity, seconds_since_creation
    FROM snapshots
    WHERE seconds_since_creation <= ? AND seconds_since_creation >= 0
      AND buy_velocity IS NOT NULL
    ORDER BY mint, seconds_since_creation ASC
  `).all(checkpointSeconds) as any[];

  // Group by mint
  const velocityByMint = new Map<string, { velocity: number; seconds: number }[]>();
  for (const r of velocityRows) {
    if (!velocityByMint.has(r.mint)) velocityByMint.set(r.mint, []);
    velocityByMint.get(r.mint)!.push({ velocity: r.buy_velocity, seconds: r.seconds_since_creation });
  }

  return rows.map((row: any) => {
    const prev = prevMap.get(row.mint);
    const initialPrice = row.initial_price_sol ?? row.price_sol ?? 0;
    const currentPrice = row.price_sol ?? 0;
    const prevPrice = prev?.price_sol ?? currentPrice;
    const prevBuyVelocity = prev?.buy_velocity ?? 0;

    // Compute timeSincePeakVelocity and buyVelocityTrend
    const velocityHistory = velocityByMint.get(row.mint) ?? [];
    let timeSincePeakVelocity = checkpointSeconds; // default: peak was at start (worst case)
    let buyVelocityTrend = 0;

    if (velocityHistory.length > 0) {
      // Find when peak velocity occurred
      let peakIdx = 0;
      for (let i = 1; i < velocityHistory.length; i++) {
        if (velocityHistory[i].velocity > velocityHistory[peakIdx].velocity) {
          peakIdx = i;
        }
      }
      timeSincePeakVelocity = checkpointSeconds - velocityHistory[peakIdx].seconds;

      // Compute velocity trend from last 2-3 snapshots leading up to checkpoint
      const recent = velocityHistory.slice(-3);
      if (recent.length >= 2) {
        // Simple linear slope: (last - first) / time_span
        const first = recent[0];
        const last = recent[recent.length - 1];
        const timeDiff = last.seconds - first.seconds;
        buyVelocityTrend = timeDiff > 0
          ? (last.velocity - first.velocity) / timeDiff
          : 0;
      }
    }

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
      sellDistribution: (row.sell_count ?? 0) > 0
        ? (row.unique_sellers ?? 0) / (row.sell_count ?? 0)
        : 0,

      // Momentum freshness
      timeSincePeakVelocity,
      buyVelocityTrend,

      // Sell-pressure
      sellVelocity: row.sell_velocity ?? 0,
      sellAcceleration: row.sell_acceleration ?? 0,
      topSellerConcentration: row.top_seller_concentration ?? 0,
      volumeVelocitySol: row.volume_velocity_sol ?? 0,
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

    // Recompute outcome relative to checkpoint price, not entry trigger price
    // This way the model learns "will it 2x from where I'd buy at this checkpoint?"
    const checkpointPrice = f.priceSol;
    const snapshots = db.prepare(`
      SELECT price_sol, seconds_since_creation
      FROM snapshots WHERE mint = ? AND price_sol IS NOT NULL
      ORDER BY seconds_since_creation ASC
    `).all(o.mint) as any[];

    const postCheckpointPrices = snapshots
      .filter((s: any) => s.seconds_since_creation > checkpointSeconds)
      .map((s: any) => s.price_sol);

    if (postCheckpointPrices.length === 0 || checkpointPrice <= 0) continue;

    const maxPrice = Math.max(...postCheckpointPrices);
    const finalPrice = postCheckpointPrices[postCheckpointPrices.length - 1];
    const minAfterCheckpoint = Math.min(...postCheckpointPrices);

    const maxGain = ((maxPrice - checkpointPrice) / checkpointPrice) * 100;
    const finalGain = ((finalPrice - checkpointPrice) / checkpointPrice) * 100;
    const maxDrawdown = ((minAfterCheckpoint - checkpointPrice) / checkpointPrice) * 100;
    const maxPriceSeconds = o.max_price_seconds ?? 0;

    let category: LabeledToken['outcome']['category'] = 'flat';
    if (maxGain >= 100 && finalGain >= 50) category = 'moon';
    else if (maxGain >= 50 && finalGain <= 0) category = 'pump_dump';
    else if (maxGain >= 30 && finalGain < maxGain * -0.5) category = 'pump_then_dump';
    else if (maxDrawdown <= -80) category = 'rug';
    else if (maxGain < 50 && finalGain < -30) category = 'slow_bleed';

    labeled.push({
      features: f,
      outcome: {
        entryTriggered: true,
        hitTwoX: maxGain >= 100,
        isDump: category === 'rug' || category === 'pump_dump' || category === 'pump_then_dump',
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
      // Recompute outcome relative to checkpoint price, not entry trigger price
      const checkpointPrice = f.priceSol;
      const snapshots = db.prepare(`
        SELECT price_sol, seconds_since_creation
        FROM snapshots WHERE mint = ? AND price_sol IS NOT NULL
        ORDER BY seconds_since_creation ASC
      `).all(mint) as any[];

      const postCheckpointPrices = snapshots
        .filter((s: any) => s.seconds_since_creation > checkpointSeconds)
        .map((s: any) => s.price_sol);

      if (postCheckpointPrices.length === 0 || checkpointPrice <= 0) continue;

      const maxPrice = Math.max(...postCheckpointPrices);
      const finalPrice = postCheckpointPrices[postCheckpointPrices.length - 1];
      const minAfterCheckpoint = Math.min(...postCheckpointPrices);

      const maxGain = ((maxPrice - checkpointPrice) / checkpointPrice) * 100;
      const finalGain = ((finalPrice - checkpointPrice) / checkpointPrice) * 100;
      const maxDrawdown = ((minAfterCheckpoint - checkpointPrice) / checkpointPrice) * 100;

      let category: LabeledToken['outcome']['category'] = 'flat';
      if (maxGain >= 100 && finalGain >= 50) category = 'moon';
      else if (maxGain >= 50 && finalGain <= 0) category = 'pump_dump';
      else if (maxGain >= 30 && finalGain < maxGain * -0.5) category = 'pump_then_dump';
      else if (maxDrawdown <= -80) category = 'rug';
      else if (maxGain < 50 && finalGain < -30) category = 'slow_bleed';

      labeled.push({
        features: f,
        outcome: {
          entryTriggered: o.entry_triggered === 1,
          hitTwoX: maxGain >= 100,
          isDump: category === 'rug' || category === 'pump_dump' || category === 'pump_then_dump',
          maxGainPct: maxGain,
          maxDrawdownPct: maxDrawdown,
          finalGainPct: finalGain,
          maxPriceSeconds: o.max_price_seconds ?? 0,
          category,
        },
      });
    } else {
      // No outcome row — derive from snapshots
      // Use the checkpoint price as reference (this is where we'd actually buy)
      const snapshots = db.prepare(`
        SELECT price_sol, seconds_since_creation
        FROM snapshots WHERE mint = ? AND price_sol IS NOT NULL
        ORDER BY seconds_since_creation ASC
      `).all(mint) as any[];

      if (snapshots.length < 2) continue;

      // Find the snapshot closest to the checkpoint to use as reference price
      const checkpointSnapshot = snapshots.reduce((best: any, s: any) =>
        Math.abs(s.seconds_since_creation - checkpointSeconds) < Math.abs(best.seconds_since_creation - checkpointSeconds)
          ? s : best
      );
      const checkpointPrice = checkpointSnapshot.price_sol;

      // Only look at prices AFTER the checkpoint for outcome measurement
      const postCheckpointPrices = snapshots
        .filter((s: any) => s.seconds_since_creation > checkpointSeconds)
        .map((s: any) => s.price_sol);

      // If no post-checkpoint data, we can't measure the outcome
      if (postCheckpointPrices.length === 0) continue;

      const maxPrice = Math.max(...postCheckpointPrices);
      const finalPrice = postCheckpointPrices[postCheckpointPrices.length - 1];
      const minAfterCheckpoint = Math.min(...postCheckpointPrices);

      const maxGain = checkpointPrice > 0 ? ((maxPrice - checkpointPrice) / checkpointPrice) * 100 : 0;
      const finalGain = checkpointPrice > 0 ? ((finalPrice - checkpointPrice) / checkpointPrice) * 100 : 0;
      const maxDrawdown = checkpointPrice > 0 ? ((minAfterCheckpoint - checkpointPrice) / checkpointPrice) * 100 : 0;

      let category: LabeledToken['outcome']['category'] = 'flat';
      if (maxGain >= 100 && finalGain >= 50) category = 'moon';
      else if (maxGain >= 50 && finalGain <= 0) category = 'pump_dump';
      else if (maxGain >= 30 && finalGain < maxGain * -0.5) category = 'pump_then_dump';
      else if (maxDrawdown <= -80) category = 'rug';
      else if (maxGain < 50 && finalGain < -30) category = 'slow_bleed';

      labeled.push({
        features: f,
        outcome: {
          entryTriggered: false,
          hitTwoX: maxGain >= 100,
          isDump: category === 'rug' || category === 'pump_dump' || category === 'pump_then_dump',
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
    'priceAcceleration', 'buyAcceleration', 'txBurst', 'sellDistribution',
    'timeSincePeakVelocity', 'buyVelocityTrend',
    'sellVelocity', 'sellAcceleration', 'topSellerConcentration', 'volumeVelocitySol',
  ];

  const results: FeatureCorrelation[] = [];

  /** Compute point-biserial correlation and optimal threshold for a binary label array */
  function computePBCorrelation(values: number[], binaryLabels: number[]): {
    correlation: number;
    mean1: number;
    mean0: number;
    separationRatio: number;
    optimalThreshold: number;
    accuracyAtThreshold: number;
  } {
    const n = values.length;
    const n1 = binaryLabels.filter(l => l === 1).length;
    const n0 = n - n1;

    if (n1 === 0 || n0 === 0) {
      return { correlation: 0, mean1: 0, mean0: 0, separationRatio: 0, optimalThreshold: 0, accuracyAtThreshold: 0 };
    }

    const mean1 = values.filter((_, i) => binaryLabels[i] === 1).reduce((a, b) => a + b, 0) / n1;
    const mean0 = values.filter((_, i) => binaryLabels[i] === 0).reduce((a, b) => a + b, 0) / n0;
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
      for (const direction of [1, -1]) {
        let tp = 0, tn = 0, fp = 0, fn = 0;
        for (let j = 0; j < n; j++) {
          const predicted = direction === 1 ? (values[j] >= threshold ? 1 : 0) : (values[j] < threshold ? 1 : 0);
          if (predicted === 1 && binaryLabels[j] === 1) tp++;
          else if (predicted === 0 && binaryLabels[j] === 0) tn++;
          else if (predicted === 1 && binaryLabels[j] === 0) fp++;
          else fn++;
        }
        const sensitivity = tp + fn > 0 ? tp / (tp + fn) : 0;
        const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
        const balancedAcc = (sensitivity + specificity) / 2;
        if (balancedAcc > bestAccuracy) {
          bestAccuracy = balancedAcc;
          bestThreshold = direction === 1 ? threshold : -threshold;
        }
      }
    }

    return { correlation, mean1, mean0, separationRatio, optimalThreshold: bestThreshold, accuracyAtThreshold: bestAccuracy };
  }

  for (const name of featureNames) {
    const values = dataset.map(d => d.features[name] as number);
    const hit2xLabels = dataset.map(d => d.outcome.hitTwoX ? 1 : 0);
    const dumpLabels = dataset.map(d => d.outcome.isDump ? 1 : 0);

    const hit2x = computePBCorrelation(values, hit2xLabels);
    const dump = computePBCorrelation(values, dumpLabels);

    results.push({
      featureName: name,
      correlationWithHit2x: hit2x.correlation,
      correlationWithIsDump: dump.correlation,
      meanWhenHit2x: hit2x.mean1,
      meanWhenNoHit2x: hit2x.mean0,
      separationRatio: hit2x.separationRatio,
      optimalThreshold: hit2x.optimalThreshold,
      accuracyAtThreshold: hit2x.accuracyAtThreshold,
      optimalThresholdDump: dump.optimalThreshold,
      accuracyAtThresholdDump: dump.accuracyAtThreshold,
    });
  }

  return results.sort((a, b) => Math.abs(b.correlationWithHit2x) - Math.abs(a.correlationWithHit2x));
}
