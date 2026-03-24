import Database from 'better-sqlite3';
import {
  TokenFeatureVector,
  LabeledToken,
  FeatureCorrelation,
  extractFeatureVectors,
  buildFullDataset,
  computeCorrelations,
} from './feature-engine';

/**
 * Scoring Model — builds a weighted scoring function from feature correlations
 * and backtests it against labeled data.
 */

/** A scoring rule for a single feature */
export interface ScoringRule {
  featureName: string;
  weight: number;
  /** 'above' = higher value is better, 'below' = lower value is better */
  direction: 'above' | 'below';
  /** The threshold that separates winners from losers */
  threshold: number;
  /** Min-max range for normalization */
  min: number;
  max: number;
}

/** Complete scoring model */
export interface ScoringModel {
  /** Schema version for validation by consumers (trading bot) */
  schemaVersion: number;
  checkpointSeconds: number;
  rules: ScoringRule[];
  /** Trained on N samples */
  sampleCount: number;
  /** Base rate: % of tokens that hit 2x without any filter */
  baseRate2x: number;
}

/** Dual scoring model containing both opportunity and risk models */
export interface DualScoringModel {
  /** Predicts whether token will 2x — higher = more likely to pump */
  opportunityModel: ScoringModel;
  /** Predicts whether token will dump — higher = more likely to rug/dump */
  riskModel: ScoringModel;
}

/** Score result for a single token using dual model */
export interface DualTokenScore {
  mint: string;
  /** 0-100: higher = more likely to 2x */
  opportunityScore: number;
  /** 0-100: higher = more likely to dump */
  riskScore: number;
  featureScores: { name: string; opportunityScore: number; riskScore: number; raw: number }[];
  signal: 'strong_buy' | 'buy' | 'neutral' | 'avoid';
}

/** Score result for a single token */
export interface TokenScore {
  mint: string;
  score: number; // 0-100
  featureScores: { name: string; score: number; raw: number }[];
  signal: 'strong_buy' | 'buy' | 'neutral' | 'avoid';
}

/** Backtest result at a given score threshold */
export interface BacktestResult {
  scoreThreshold: number;
  tokensAboveThreshold: number;
  hitTwoXCount: number;
  hitTwoXRate: number;
  avgMaxGain: number;
  avgFinalGain: number;
  avgMaxDrawdown: number;
  expectedValuePct: number;
  categoryBreakdown: Record<string, number>;
}

/** Full backtest report */
export interface BacktestReport {
  model: ScoringModel;
  baseRate2x: number;
  results: BacktestResult[];
  bestThreshold: BacktestResult;
  featureImportance: { name: string; weight: number; correlation: number }[];
}

/**
 * Build a scoring model from feature correlations.
 * Uses top N features by absolute correlation, weighted by their correlation strength.
 * @param target - 'hitTwoX' (opportunity) or 'maxDrawdownPct' (risk)
 */
export function buildScoringModel(
  correlations: FeatureCorrelation[],
  dataset: LabeledToken[],
  checkpointSeconds: number,
  maxFeatures: number = 8,
  target: 'hitTwoX' | 'maxDrawdownPct' = 'hitTwoX'
): ScoringModel {
  const getCorr = (c: FeatureCorrelation) =>
    target === 'maxDrawdownPct' ? c.correlationWithMaxDrawdown : c.correlationWithHit2x;
  const getThreshold = (c: FeatureCorrelation) =>
    target === 'maxDrawdownPct' ? c.optimalThresholdDrawdown : c.optimalThreshold;

  // Filter to features with meaningful correlation (|r| > 0.05)
  const meaningful = correlations
    .filter(c => Math.abs(getCorr(c)) > 0.05)
    .sort((a, b) => Math.abs(getCorr(b)) - Math.abs(getCorr(a)));
  const topFeatures = meaningful.slice(0, maxFeatures);

  // Compute min/max for normalization
  const rules: ScoringRule[] = topFeatures.map(c => {
    const values = dataset.map(d => d.features[c.featureName as keyof TokenFeatureVector] as number);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const corr = getCorr(c);

    return {
      featureName: c.featureName,
      weight: Math.abs(corr),
      direction: corr > 0 ? 'above' : 'below',
      threshold: Math.abs(getThreshold(c)),
      min,
      max,
    };
  });

  // Normalize weights to sum to 1
  const totalWeight = rules.reduce((sum, r) => sum + r.weight, 0);
  if (totalWeight > 0) {
    for (const r of rules) {
      r.weight /= totalWeight;
    }
  }

  const hit2xCount = dataset.filter(d => d.outcome.hitTwoX).length;

  return {
    schemaVersion: 1,
    checkpointSeconds,
    rules,
    sampleCount: dataset.length,
    baseRate2x: dataset.length > 0 ? (hit2xCount / dataset.length) * 100 : 0,
  };
}

/** Sell-side features allowed in the risk model */
const SELL_SIDE_FEATURES = new Set([
  'sellVelocity',
  'sellAcceleration',
  'topSellerConcentration',
  'sellDistribution',
  'uniqueSellers',
  'sellRatio',
  'buyerTxRatio',
]);

/**
 * Build both opportunity and risk models from a single dataset.
 * The opportunity model uses all features; the risk model is restricted
 * to sell-side features only to avoid overlap.
 */
export function buildDualScoringModel(
  correlations: FeatureCorrelation[],
  dataset: LabeledToken[],
  checkpointSeconds: number,
  maxFeatures: number = 8
): DualScoringModel {
  const sellSideCorrelations = correlations.filter(c => SELL_SIDE_FEATURES.has(c.featureName));
  return {
    opportunityModel: buildScoringModel(correlations, dataset, checkpointSeconds, maxFeatures, 'hitTwoX'),
    riskModel: buildScoringModel(sellSideCorrelations, dataset, checkpointSeconds, maxFeatures, 'maxDrawdownPct'),
  };
}

/**
 * Score a token using the scoring model.
 * Returns a score from 0-100.
 */
export function scoreToken(
  model: ScoringModel,
  features: TokenFeatureVector
): TokenScore {
  const featureScores: { name: string; score: number; raw: number }[] = [];
  let totalScore = 0;

  for (const rule of model.rules) {
    const raw = features[rule.featureName as keyof TokenFeatureVector] as number;
    const range = rule.max - rule.min;

    // Normalize to 0-1
    let normalized = range > 0 ? (raw - rule.min) / range : 0.5;
    normalized = Math.max(0, Math.min(1, normalized));

    // Flip if lower is better
    if (rule.direction === 'below') {
      normalized = 1 - normalized;
    }

    const weighted = normalized * rule.weight * 100;
    featureScores.push({ name: rule.featureName, score: weighted, raw });
    totalScore += weighted;
  }

  // Determine signal
  let signal: TokenScore['signal'] = 'neutral';
  if (totalScore >= 70) signal = 'strong_buy';
  else if (totalScore >= 55) signal = 'buy';
  else if (totalScore < 35) signal = 'avoid';

  return {
    mint: features.mint,
    score: Math.round(totalScore * 100) / 100,
    featureScores,
    signal,
  };
}

/**
 * Score a token using the dual model.
 * Returns both opportunityScore (0-100) and riskScore (0-100).
 */
export function scoreTokenDual(
  dualModel: DualScoringModel,
  features: TokenFeatureVector
): DualTokenScore {
  const oppScore = scoreToken(dualModel.opportunityModel, features);
  const riskScore = scoreToken(dualModel.riskModel, features);

  // Merge feature scores by name
  const allFeatureNames = new Set([
    ...oppScore.featureScores.map(f => f.name),
    ...riskScore.featureScores.map(f => f.name),
  ]);
  const featureScores = [...allFeatureNames].map(name => {
    const opp = oppScore.featureScores.find(f => f.name === name);
    const risk = riskScore.featureScores.find(f => f.name === name);
    return {
      name,
      opportunityScore: opp?.score ?? 0,
      riskScore: risk?.score ?? 0,
      raw: opp?.raw ?? risk?.raw ?? 0,
    };
  });

  return {
    mint: features.mint,
    opportunityScore: oppScore.score,
    riskScore: riskScore.score,
    featureScores,
    signal: oppScore.signal,
  };
}

/** Score trajectory across multiple checkpoints for a single token */
export interface ScoreTrajectory {
  mint: string;
  checkpoints: {
    seconds: number;
    score: number;
    signal: TokenScore['signal'];
    sampleCount: number;
    baseRate2x: number;
  }[];
  /** Score change from first to last checkpoint (positive = improving) */
  scoreSlope: number;
  /** Is the score consistently rising across checkpoints? */
  rising: boolean;
  /** Best checkpoint (highest score) */
  peakCheckpoint: number;
  peakScore: number;
}

/**
 * Compute score trajectory for a token across multiple checkpoints.
 * Builds a separate model at each checkpoint and scores the token,
 * showing how confidence evolves over time.
 */
export function computeScoreTrajectory(
  db: Database.Database,
  mint: string,
  checkpoints: number[] = [5, 10, 15, 30, 45, 60, 90, 120],
): ScoreTrajectory {
  const results: ScoreTrajectory['checkpoints'] = [];

  for (const cp of checkpoints) {
    const dataset = buildFullDataset(db, cp);
    if (dataset.length < 5) continue;

    const correlations = computeCorrelations(dataset);
    const model = buildScoringModel(correlations, dataset, cp);

    const features = extractFeatureVectors(db, cp);
    const tokenFeatures = features.find(f => f.mint === mint);
    if (!tokenFeatures) continue;

    const score = scoreToken(model, tokenFeatures);
    results.push({
      seconds: cp,
      score: score.score,
      signal: score.signal,
      sampleCount: model.sampleCount,
      baseRate2x: model.baseRate2x,
    });
  }

  // Compute trajectory metrics
  let scoreSlope = 0;
  let rising = false;
  let peakCheckpoint = 0;
  let peakScore = 0;

  if (results.length >= 2) {
    const first = results[0];
    const last = results[results.length - 1];
    const timeDiff = last.seconds - first.seconds;
    scoreSlope = timeDiff > 0 ? (last.score - first.score) / timeDiff : 0;

    // Check if rising: each score >= previous
    rising = results.every((r, i) => i === 0 || r.score >= results[i - 1].score);
  }

  if (results.length > 0) {
    const peak = results.reduce((best, r) => r.score > best.score ? r : best, results[0]);
    peakCheckpoint = peak.seconds;
    peakScore = peak.score;
  }

  return {
    mint,
    checkpoints: results,
    scoreSlope,
    rising,
    peakCheckpoint,
    peakScore,
  };
}

/**
 * Backtest the scoring model against the labeled dataset.
 * Tests multiple score thresholds to find the optimal one.
 */
export function backtestModel(
  model: ScoringModel,
  dataset: LabeledToken[]
): BacktestReport {
  // Score all tokens
  const scored = dataset.map(d => ({
    score: scoreToken(model, d.features),
    outcome: d.outcome,
  }));

  // Test thresholds from 20 to 80 in steps of 5
  const results: BacktestResult[] = [];

  for (let threshold = 20; threshold <= 80; threshold += 5) {
    const above = scored.filter(s => s.score.score >= threshold);

    if (above.length === 0) {
      results.push({
        scoreThreshold: threshold,
        tokensAboveThreshold: 0,
        hitTwoXCount: 0,
        hitTwoXRate: 0,
        avgMaxGain: 0,
        avgFinalGain: 0,
        avgMaxDrawdown: 0,
        expectedValuePct: 0,
        categoryBreakdown: {},
      });
      continue;
    }

    const hit2x = above.filter(s => s.outcome.hitTwoX);
    const avgMaxGain = above.reduce((sum, s) => sum + s.outcome.maxGainPct, 0) / above.length;
    const avgFinalGain = above.reduce((sum, s) => sum + s.outcome.finalGainPct, 0) / above.length;
    const avgMaxDrawdown = above.reduce((sum, s) => sum + s.outcome.maxDrawdownPct, 0) / above.length;

    // Category breakdown
    const breakdown: Record<string, number> = {};
    for (const s of above) {
      breakdown[s.outcome.category] = (breakdown[s.outcome.category] ?? 0) + 1;
    }

    results.push({
      scoreThreshold: threshold,
      tokensAboveThreshold: above.length,
      hitTwoXCount: hit2x.length,
      hitTwoXRate: (hit2x.length / above.length) * 100,
      avgMaxGain,
      avgFinalGain,
      avgMaxDrawdown,
      expectedValuePct: avgFinalGain,
      categoryBreakdown: breakdown,
    });
  }

  // Find best threshold: maximize (hit_2x_rate * sqrt(sample_size)) to balance precision vs coverage
  const bestThreshold = results.reduce((best, r) => {
    const score = r.hitTwoXRate * Math.sqrt(r.tokensAboveThreshold);
    const bestScore = best.hitTwoXRate * Math.sqrt(best.tokensAboveThreshold);
    return score > bestScore ? r : best;
  }, results[0]);

  return {
    model,
    baseRate2x: model.baseRate2x,
    results,
    bestThreshold,
    featureImportance: model.rules.map(r => {
      const corr = scored.length > 0 ? r.weight : 0;
      return { name: r.featureName, weight: r.weight, correlation: corr };
    }),
  };
}

/**
 * Generate a human-readable report from backtest results.
 */
export function formatBacktestReport(report: BacktestReport): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════');
  lines.push('  TRADING SIGNAL ANALYSIS REPORT');
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`Checkpoint: ${report.model.checkpointSeconds}s after token creation`);
  lines.push(`Sample size: ${report.model.sampleCount} tokens`);
  lines.push(`Base rate (hit 2x without filter): ${report.baseRate2x.toFixed(1)}%`);
  lines.push('');

  lines.push('─── Feature Importance ───');
  for (const f of report.featureImportance.sort((a, b) => b.weight - a.weight)) {
    const bar = '█'.repeat(Math.round(f.weight * 50));
    lines.push(`  ${f.name.padEnd(25)} ${(f.weight * 100).toFixed(1)}% ${bar}`);
  }
  lines.push('');

  lines.push('─── Scoring Rules ───');
  for (const rule of report.model.rules) {
    const dir = rule.direction === 'above' ? '≥' : '≤';
    lines.push(`  ${rule.featureName.padEnd(25)} ${dir} ${rule.threshold.toFixed(4)}  (weight: ${(rule.weight * 100).toFixed(1)}%)`);
  }
  lines.push('');

  lines.push('─── Backtest Results by Score Threshold ───');
  lines.push('  Threshold  Tokens  Hit2x  Rate     AvgMaxGain  AvgFinalGain  EV');
  lines.push('  ─────────  ──────  ─────  ───────  ──────────  ────────────  ──────');

  for (const r of report.results) {
    if (r.tokensAboveThreshold === 0) continue;
    const marker = r === report.bestThreshold ? ' ◄ BEST' : '';
    lines.push(
      `  ${String(r.scoreThreshold).padStart(5)}     ` +
      `${String(r.tokensAboveThreshold).padStart(5)}  ` +
      `${String(r.hitTwoXCount).padStart(5)}  ` +
      `${r.hitTwoXRate.toFixed(1).padStart(6)}%  ` +
      `${r.avgMaxGain.toFixed(1).padStart(9)}%  ` +
      `${r.avgFinalGain.toFixed(1).padStart(11)}%  ` +
      `${r.expectedValuePct.toFixed(1).padStart(5)}%` +
      marker
    );
  }
  lines.push('');

  if (report.bestThreshold.tokensAboveThreshold > 0) {
    lines.push('─── Best Threshold Detail ───');
    lines.push(`  Score threshold: ${report.bestThreshold.scoreThreshold}`);
    lines.push(`  Tokens passing: ${report.bestThreshold.tokensAboveThreshold}/${report.model.sampleCount}`);
    lines.push(`  Hit 2x rate: ${report.bestThreshold.hitTwoXRate.toFixed(1)}% (vs ${report.baseRate2x.toFixed(1)}% base)`);
    lines.push(`  Improvement: ${(report.bestThreshold.hitTwoXRate / report.baseRate2x).toFixed(1)}x over random`);
    lines.push(`  Avg max gain: ${report.bestThreshold.avgMaxGain.toFixed(1)}%`);
    lines.push(`  Avg final gain: ${report.bestThreshold.avgFinalGain.toFixed(1)}%`);
    lines.push(`  Avg max drawdown: ${report.bestThreshold.avgMaxDrawdown.toFixed(1)}%`);
    lines.push('');
    lines.push('  Category breakdown:');
    for (const [cat, count] of Object.entries(report.bestThreshold.categoryBreakdown)) {
      const pct = ((count as number) / report.bestThreshold.tokensAboveThreshold * 100).toFixed(1);
      lines.push(`    ${cat.padEnd(15)} ${String(count).padStart(4)} (${pct}%)`);
    }
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════');

  return lines.join('\n');
}
