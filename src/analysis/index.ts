export {
  extractFeatureVectors,
  buildLabeledDataset,
  buildFullDataset,
  computeCorrelations,
  type TokenFeatureVector,
  type LabeledToken,
  type FeatureCorrelation,
  type TimeRange,
} from './feature-engine';

export {
  buildScoringModel,
  buildDualScoringModel,
  scoreToken,
  scoreTokenDual,
  backtestModel,
  formatBacktestReport,
  computeScoreTrajectory,
  type ScoringModel,
  type DualScoringModel,
  type ScoringRule,
  type TokenScore,
  type DualTokenScore,
  type ScoreTrajectory,
  type BacktestResult,
  type BacktestReport,
} from './scoring-model';
