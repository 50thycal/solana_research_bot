import { openDatabase, closeDatabase } from '../db/init';
import { config } from '../config';
import {
  buildLabeledDataset,
  buildFullDataset,
  computeCorrelations,
  extractFeatureVectors,
} from './feature-engine';
import {
  buildScoringModel,
  backtestModel,
  formatBacktestReport,
  scoreToken,
  BacktestReport,
} from './scoring-model';

/**
 * CLI entry point for running analysis.
 *
 * Usage:
 *   npx tsx src/analysis/run-analysis.ts [checkpoint_seconds]
 *
 * Options:
 *   --full         Include all tokens, not just those with outcomes
 *   --checkpoints  Run analysis at multiple checkpoints (15,30,60,90,120)
 *   --json         Output as JSON instead of formatted text
 *   --score <mint> Score a specific token instead of running full analysis
 */

async function main() {
  const args = process.argv.slice(2);
  const useFullDataset = args.includes('--full');
  const multiCheckpoint = args.includes('--checkpoints');
  const jsonOutput = args.includes('--json');
  const scoreMintIdx = args.indexOf('--score');

  const db = openDatabase(config.dbPath);

  try {
    // Check data availability
    const tokenCount = (db.prepare('SELECT COUNT(*) as n FROM tokens').get() as any).n;
    const snapshotCount = (db.prepare('SELECT COUNT(*) as n FROM snapshots').get() as any).n;
    const outcomeCount = (db.prepare('SELECT COUNT(*) as n FROM outcomes').get() as any).n;

    console.log(`Database: ${config.dbPath}`);
    console.log(`Tokens: ${tokenCount} | Snapshots: ${snapshotCount} | Outcomes: ${outcomeCount}`);
    console.log('');

    if (snapshotCount === 0) {
      console.log('No snapshot data available. Run the collector first.');
      return;
    }

    // Score a specific token
    if (scoreMintIdx >= 0 && args[scoreMintIdx + 1]) {
      const mint = args[scoreMintIdx + 1];
      await scoreSpecificToken(db, mint, useFullDataset);
      return;
    }

    // Determine checkpoints to analyze
    const checkpoints = multiCheckpoint
      ? [15, 30, 45, 60, 90, 120]
      : [parseInt(args.find((a: string) => !a.startsWith('--')) ?? '30', 10)];

    const allReports: BacktestReport[] = [];

    for (const checkpoint of checkpoints) {
      console.log(`\n▶ Analyzing at checkpoint: ${checkpoint}s`);

      const dataset = useFullDataset
        ? buildFullDataset(db, checkpoint)
        : buildLabeledDataset(db, checkpoint);

      if (dataset.length < 5) {
        console.log(`  Insufficient data: only ${dataset.length} tokens with features at ${checkpoint}s`);
        continue;
      }

      console.log(`  Dataset size: ${dataset.length} tokens`);
      console.log(`  Hit 2x: ${dataset.filter(d => d.outcome.hitTwoX).length} (${(dataset.filter(d => d.outcome.hitTwoX).length / dataset.length * 100).toFixed(1)}%)`);

      const correlations = computeCorrelations(dataset);
      const model = buildScoringModel(correlations, dataset, checkpoint);
      const report = backtestModel(model, dataset);
      allReports.push(report);

      if (jsonOutput) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatBacktestReport(report));
      }
    }

    // Multi-checkpoint comparison
    if (multiCheckpoint && allReports.length > 1 && !jsonOutput) {
      console.log('\n═══════════════════════════════════════════════════════');
      console.log('  CHECKPOINT COMPARISON');
      console.log('═══════════════════════════════════════════════════════');
      console.log('  Checkpoint  Samples  BaseRate  BestRate  Improvement  Coverage');
      console.log('  ──────────  ───────  ────────  ────────  ───────────  ────────');

      for (const r of allReports) {
        const improvement = r.baseRate2x > 0
          ? (r.bestThreshold.hitTwoXRate / r.baseRate2x).toFixed(1)
          : 'N/A';
        const coverage = r.model.sampleCount > 0
          ? ((r.bestThreshold.tokensAboveThreshold / r.model.sampleCount) * 100).toFixed(1)
          : '0';

        console.log(
          `  ${String(r.model.checkpointSeconds).padStart(6)}s    ` +
          `${String(r.model.sampleCount).padStart(5)}    ` +
          `${r.baseRate2x.toFixed(1).padStart(6)}%   ` +
          `${r.bestThreshold.hitTwoXRate.toFixed(1).padStart(6)}%   ` +
          `${String(improvement).padStart(8)}x     ` +
          `${coverage.padStart(5)}%`
        );
      }
      console.log('');
      console.log('  ► Lower checkpoint = faster decision but less data');
      console.log('  ► Higher checkpoint = more signal but higher opportunity cost');
      console.log('');
    }

  } finally {
    closeDatabase(db);
  }
}

async function scoreSpecificToken(
  db: ReturnType<typeof openDatabase>,
  mint: string,
  useFullDataset: boolean
) {
  const checkpoint = 30;
  const dataset = useFullDataset
    ? buildFullDataset(db, checkpoint)
    : buildLabeledDataset(db, checkpoint);

  if (dataset.length < 5) {
    console.log('Insufficient data to build model.');
    return;
  }

  const correlations = computeCorrelations(dataset);
  const model = buildScoringModel(correlations, dataset, checkpoint);

  // Get the features for this specific token
  const features = extractFeatureVectors(db, checkpoint);
  const tokenFeatures = features.find(f => f.mint === mint);

  if (!tokenFeatures) {
    console.log(`Token ${mint} not found at ${checkpoint}s checkpoint.`);
    return;
  }

  const score = scoreToken(model, tokenFeatures);

  console.log(`\nToken: ${mint}`);
  console.log(`Score: ${score.score}/100`);
  console.log(`Signal: ${score.signal.toUpperCase()}`);
  console.log('');
  console.log('Feature breakdown:');
  for (const f of score.featureScores.sort((a, b) => b.score - a.score)) {
    const bar = '█'.repeat(Math.round(f.score));
    console.log(`  ${f.name.padEnd(25)} ${f.score.toFixed(1).padStart(5)} pts  (raw: ${f.raw.toFixed(6)})  ${bar}`);
  }
}

main().catch(err => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
