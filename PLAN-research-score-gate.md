# Research Score Gate — Implementation Plan for Trading Bot

> This plan is for the `solana-trading-bot` repo. It describes how to integrate
> the research bot's scoring model into the trading bot's pipeline as a new gate
> that replaces the momentum gate.
>
> **Updated** with corrections from trading bot codebase review — correct field
> names, BN type handling, checkHistory-based momentum derivation, and full
> cleanup list.

---

## Overview

The research bot (`solana_research_bot`) trains a scoring model from historical
pump.fun token data. The trading bot will:

1. Fetch the model rules from the research bot on startup (and periodically)
2. After the sniper gate passes, compute features from data already in the pipeline
3. Apply the model's scoring rules to produce a 0-100 score
4. Only buy if the score exceeds the configured threshold

**Pipeline after this change:**
```
Cheap Gates → Deep Filters → Sniper Gate → Research Score Gate → Execute
```

The momentum gate is completely removed.

**Key endpoint:** `GET {RESEARCH_BOT_URL}/api/analysis/model?checkpoint={checkpoint}&full=true`
— returns the ScoringModel with rules that the trading bot applies locally.

---

## Step 1: Remove Momentum Gate

### File to delete:
- `pipeline/momentum-gate.ts`

### Files to modify:

| File | Changes |
|------|---------|
| `pipeline/index.ts` | Remove `export * from './momentum-gate'` |
| `pipeline/pipeline.ts` | Remove momentum gate import, `MomentumGateStage` member, momentum gate from constructor, and the `else` branch in Stage 4 (sniper gate always runs). Remove momentum gate from `PipelineConfig`. |
| `pipeline/types.ts` | Remove `MomentumGateData` interface, remove `momentumGate?` from `PipelineContext`, remove `MOMENTUM_*` rejection reason constants |
| `helpers/config-validator.ts` | Remove `momentumGate*` fields from `ValidatedConfig` interface (lines ~83-88). Remove `MOMENTUM_*` env var parsing (lines ~404-429). Remove the sniper/momentum conflict warning (lines ~546-549). Remove momentum config from the returned config object. |
| `index.ts` | Remove `momentumGate:` block from `initPipeline()` call (lines ~486-492) |
| `smoke-test.ts` | Remove `momentumGate:` block from `initPipeline()` call |
| `pipeline/pipeline-stats.ts` | Remove `MOMENTUM_GATE` constant, `momentumGateStats` Map, `recordMomentumGateRejection` function, momentum references in `recordAllGatesPassed` and `recordRejection`, `momentumGate` from `PipelineStatsSnapshot.gateStats` |

### Config changes:
- Remove all `MOMENTUM_*` env vars from config
- Change `SNIPER_GATE_ENABLED` default from `false` to `true` — sniper gate
  is now always on (the env var can remain for emergency disable but should
  default to enabled)

---

## Step 2: Create Research Score Gate

### New file: `pipeline/research-score-gate.ts`

This is a new pipeline stage that runs AFTER the sniper gate.

#### 2a. Feature Names (MUST match research bot exactly)

The research bot uses these feature names in `TokenFeatureVector`
(from `solana_research_bot/src/analysis/feature-engine.ts`). The trading bot
MUST use the same names so the scoring model rules can be applied directly.

```typescript
// These names are the contract between the two bots.
// Do NOT rename them — the model rules reference these exact strings.
interface TokenFeatureVector {
  mint: string;
  checkpointSeconds: number;

  // Raw features
  priceSol: number;
  priceChangeFromInitial: number;
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
  priceAcceleration: number;
  buyAcceleration: number;
  txBurst: number;
  holderConcentration: number; // unique_sellers / sell_count (seller concentration, NOT same as buyerTxRatio)
}
```

#### 2b. Scoring Rule Interface (MUST match research bot exactly)

```typescript
// From solana_research_bot/src/analysis/scoring-model.ts
interface ScoringRule {
  featureName: string;       // matches a key in TokenFeatureVector
  weight: number;            // 0-1, all weights sum to 1
  direction: 'above' | 'below'; // 'above' = higher is better
  threshold: number;         // the threshold that separates winners from losers
  min: number;               // min observed value (for normalization)
  max: number;               // max observed value (for normalization)
}

interface ScoringModel {
  schemaVersion: number;     // currently 1 — validate this on fetch
  checkpointSeconds: number; // e.g. 30
  rules: ScoringRule[];
  sampleCount: number;       // how many tokens the model was trained on
  baseRate2x: number;        // base hit-2x rate (%) before filtering
}
```

#### 2c. Data Mapping — How to Build Features from Pipeline Data

The trading bot already has all the raw data at the point the research score
gate runs. Here's exactly where each feature comes from:

**IMPORTANT: BondingCurveState fields are BN (Big Number) types from
@solana/web3.js, NOT plain numbers.** You MUST call `.toNumber()` or use BN
math when computing features. Lamport values need division by `LAMPORTS_PER_SOL`
(1e9) to convert to SOL.

**IMPORTANT: SniperGateData field names** — use the correct names from the
actual interface:
- `organicBuyerCount` (NOT `organicCount`)
- `sniperWalletCount` (NOT `botCount`)
- `sniperExitCount` (NOT `botExitCount`)

```typescript
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

// Available from prior pipeline stages:
// - ctx.detection: DetectionEvent (mint, bondingCurve, slot, detectedAt)
// - ctx.deepFilters.bondingCurveState: BondingCurveState (fields are BN!)
// - ctx.sniperGate: SniperGateData (organicBuyerCount, sniperWalletCount, etc.)
// - ctx.sniperGate.checkHistory: array of per-poll snapshots

function buildFeatureVector(ctx: PipelineContext): TokenFeatureVector {
  const bcs = ctx.deepFilters.bondingCurveState;
  const sniper = ctx.sniperGate;
  const detection = ctx.detection;

  // Time since creation
  const secondsSinceCreation = (Date.now() - detection.detectedAt) / 1000;

  // Price from bonding curve: virtualSolReserves / virtualTokenReserves
  // NOTE: Both are BN types — convert to number for division
  const virtualSolLamports = bcs.virtualSolReserves.toNumber();
  const virtualTokens = bcs.virtualTokenReserves.toNumber();
  const priceSol = virtualSolLamports / virtualTokens;

  // Real SOL reserves in SOL (not lamports)
  const realSolReserves = bcs.realSolReserves.toNumber() / LAMPORTS_PER_SOL;

  // Transaction data from sniper gate (correct field names!)
  const buyCount = (sniper.organicBuyerCount || 0) + (sniper.sniperWalletCount || 0);
  const sellCount = sniper.sniperExitCount || 0;
  const totalTxCount = buyCount + sellCount;
  const uniqueBuyers = sniper.organicBuyerCount || 0;
  const uniqueSellers = sniper.sniperExitCount || 0;

  // Derived features
  const buyVelocity = secondsSinceCreation > 0 ? buyCount / secondsSinceCreation : 0;
  const sellRatio = totalTxCount > 0 ? sellCount / totalTxCount : 0;
  const buyerTxRatio = buyCount > 0 ? uniqueBuyers / buyCount : 0;
  const realTokens = bcs.realTokenReserves.toNumber();
  const marketCapSol = priceSol * (virtualTokens + realTokens);

  // Momentum features derived from checkHistory (see Step 2d)
  const { buyAcceleration, txBurst } = deriveMomentumFromCheckHistory(sniper.checkHistory);

  return {
    mint: detection.mint.toBase58(),
    checkpointSeconds: secondsSinceCreation,
    priceSol,
    priceChangeFromInitial: 0, // See note below
    realSolReserves,
    totalTxCount,
    buyCount,
    sellCount,
    uniqueBuyers,
    uniqueSellers,
    buyVelocity,
    sellRatio,
    buyerTxRatio,
    marketCapSol,
    priceAcceleration: 0,      // Would need two price reads — set to 0
    buyAcceleration,
    txBurst,
    holderConcentration: sellCount > 0 ? uniqueSellers / sellCount : 0,
  };
}
```

**IMPORTANT NOTES:**
- `priceChangeFromInitial`: In the research bot this compares price at checkpoint
  vs initial. In the trading bot, the deep filters fetch the bonding curve ONCE,
  so we only have one price point. Set this to 0 unless you add a second fetch.
- `priceAcceleration`: Would require two price reads at different times. Set to 0.
- `buyAcceleration` and `txBurst`: Derived from `checkHistory` — see Step 2d.

#### 2d. Deriving Momentum Features from checkHistory (NO sniper gate changes needed)

The `checkHistory` array on `SniperGateData` already contains per-poll snapshots
with `totalBuys`, `organicCount`, and `checkedAt` fields. Use these to compute
momentum features WITHOUT modifying the sniper gate at all:

```typescript
interface CheckHistoryEntry {
  totalBuys: number;
  organicCount: number;
  checkedAt: number; // ms timestamp
}

function deriveMomentumFromCheckHistory(
  checkHistory: CheckHistoryEntry[] | undefined
): { buyAcceleration: number; txBurst: number } {
  if (!checkHistory || checkHistory.length < 2) {
    return { buyAcceleration: 0, txBurst: 0 };
  }

  const first = checkHistory[0];
  const last = checkHistory[checkHistory.length - 1];

  // buyAcceleration: change in buy rate between first and last poll
  const timeDeltaSec = (last.checkedAt - first.checkedAt) / 1000;
  const buyAcceleration = timeDeltaSec > 0
    ? (last.totalBuys - first.totalBuys) / timeDeltaSec
    : 0;

  // txBurst: max new buys between any two consecutive polls
  let maxDelta = 0;
  for (let i = 1; i < checkHistory.length; i++) {
    const delta = checkHistory[i].totalBuys - checkHistory[i - 1].totalBuys;
    if (delta > maxDelta) maxDelta = delta;
  }

  return { buyAcceleration, txBurst: maxDelta };
}
```

This approach keeps the change fully isolated to the research score gate —
no modifications to the sniper gate are needed.

#### 2e. The Scoring Function

```typescript
// This is the core scoring logic. It MUST match the research bot's
// scoreToken() function in solana_research_bot/src/analysis/scoring-model.ts

function scoreToken(model: ScoringModel, features: TokenFeatureVector): number {
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

    totalScore += normalized * rule.weight * 100;
  }

  return Math.round(totalScore * 100) / 100;
}
```

#### 2f. The Stage Implementation

```typescript
// pipeline/research-score-gate.ts

export interface ResearchScoreGateConfig {
  enabled: boolean;                    // default: true
  researchBotUrl: string;              // URL of the research bot API
  modelRefreshIntervalMs: number;      // how often to re-fetch model (default: 300000 = 5 min)
  scoreThreshold: number;              // minimum score to pass (default: 50)
  logOnly: boolean;                    // if true, always pass but log the score
  checkpoint: number;                  // which checkpoint model to use (default: 30)
}

export interface ResearchScoreGateData {
  score: number;                       // 0-100
  signal: 'strong_buy' | 'buy' | 'neutral' | 'avoid';
  scoreThreshold: number;
  modelSampleCount: number;
  modelBaseRate2x: number;
  features: TokenFeatureVector;        // the computed features (for logging)
  featureScores: { name: string; score: number; raw: number }[];
}
```

The stage class should:
1. On construction: fetch model from `GET {researchBotUrl}/api/analysis/model?checkpoint={checkpoint}&full=true`
2. **Validate the model** before caching:
   - Check `data.schemaVersion === 1`
   - Verify each rule in `data.rules` has: `featureName` (string), `weight` (number),
     `direction` ('above'|'below'), `min` (number), `max` (number)
   - If validation fails, log a warning and keep the previous cached model
3. Cache the model in memory
4. Set up a refresh interval to re-fetch periodically
5. On `execute(ctx)`:
   - Build `TokenFeatureVector` from pipeline context (see Step 2c)
   - Run `scoreToken(model, features)` (see Step 2e)
   - If `score >= scoreThreshold` → PASS
   - If `score < scoreThreshold` → REJECT (unless `logOnly: true`)
   - Always attach `ResearchScoreGateData` to the stage result
6. On model fetch failure: log a warning and use the cached model.
   If no model has ever been fetched, PASS the token (graceful degradation)
   and log a warning. This prevents the gate from blocking all trades if the
   research bot is down. **Track a `noModelPassCount` stat** so this is visible
   on the dashboard.
7. On `destroy()`: clear the refresh interval timer

---

## Step 3: Wire Into Pipeline

### Modify `pipeline/pipeline.ts`:

The pipeline currently does:
```
if (sniperGateEnabled) { run sniper gate } else { run momentum gate }
```

Change to:
```
run sniper gate (always)
run research score gate (if enabled)
```

The research score gate is a new Stage 5, running after Stage 4 (sniper gate).

### Modify `pipeline/types.ts`:

Add to `PipelineContext`:
```typescript
interface PipelineContext {
  detection: DetectionEvent;
  cheapGates?: CheapGatesData;
  deepFilters?: DeepFiltersData;
  sniperGate?: SniperGateData;       // was conditional, now always present
  researchScore?: ResearchScoreGateData; // NEW
  rejection?: { stage: string; reason: string; timestamp: number };
}
```

Add rejection reason:
```typescript
RejectionReasons.RESEARCH_SCORE_LOW = 'Research score below threshold';
```

### Modify `pipeline/index.ts`:

```typescript
export * from './research-score-gate';
// Remove: export * from './momentum-gate';
```

---

## Step 4: Environment Variables

Add to the bot's config:

```env
# Research Score Gate
RESEARCH_SCORE_GATE_ENABLED=true
RESEARCH_BOT_URL=https://your-research-bot.railway.app
RESEARCH_SCORE_THRESHOLD=50
RESEARCH_SCORE_CHECKPOINT=30
RESEARCH_SCORE_LOG_ONLY=false
RESEARCH_SCORE_MODEL_REFRESH_INTERVAL=300000
```

Note: `RESEARCH_BOT_URL` may already exist for `market-context.ts`. Reuse it.

---

## Step 5: Logging & Dashboard Integration

### Logging

The research score gate should log:
```json
{
  "event": "research_score_gate",
  "mint": "...",
  "score": 67.3,
  "signal": "buy",
  "threshold": 50,
  "passed": true,
  "features": { "buyVelocity": 0.45, "sellRatio": 0.12, ... },
  "featureScores": [{ "name": "buyVelocity", "score": 12.3, "raw": 0.45 }, ...],
  "modelSampleCount": 150,
  "modelBaseRate2x": 8.2
}
```

### Dashboard Updates

Update the trading bot's dashboard to show research score gate data:

1. **Pipeline view / recent tokens table** — Add a "Research Score" column showing
   the 0-100 score with color coding (green ≥70, yellow ≥55, red <35)
2. **Token detail view** — When clicking into a token, show:
   - Overall research score and signal (strong_buy/buy/neutral/avoid)
   - Feature breakdown table: feature name, raw value, normalized score, weight
   - Which features contributed most (sorted by weighted score descending)
3. **Stats/summary section** — Add research score gate stats:
   - Pass/reject counts and rate
   - Average score for all evaluated tokens vs tokens that passed all gates
   - Score distribution histogram (0-20, 20-40, 40-60, 60-80, 80-100)
4. **Model status indicator** — Show whether the scoring model is loaded,
   when it was last fetched, sample count, and base hit rate

---

## Step 6: Pipeline Stats Integration

Update `pipeline/pipeline-stats.ts`:

### New constants and tracking:
- Add `RESEARCH_SCORE_GATE` constant
- Add `researchScoreGateStats` Map (same pattern as other gate stats)
- Add `'research-score-gate'` case to `recordRejection` method

### Add to `PipelineStatsSnapshot.gateStats`:
```typescript
researchScoreGate: {
  passCount: number;
  rejectCount: number;
  avgScore: number;
  avgScoreForBuys: number;
  scoreDistribution: { '0-20': number; '20-40': number; '40-60': number; '60-80': number; '80-100': number };
}
```

### Add to `RecentToken`:
```typescript
researchScore?: number;
researchSignal?: string;
researchFeatureScores?: { name: string; score: number; raw: number }[];
```

### Update `recordAllGatesPassed`:
- Include research score gate stats in the "all gates passed" path

---

## Future: Two-Way Communication

This plan is designed so that in the future, the trading bot can send outcome
data back to the research bot to improve the model:

1. **Same feature names**: The `TokenFeatureVector` interface is identical in
   both repos. When the trading bot sends features + outcomes to the research
   bot, they slot directly into the training data.

2. **Planned endpoint** (to build later on research bot):
   `POST /api/outcomes` — trading bot sends:
   ```json
   {
     "mint": "...",
     "features": { TokenFeatureVector },
     "entryPrice": 0.000045,
     "exitPrice": 0.000082,
     "holdDuration": 45,
     "outcome": "win",
     "gainPct": 82.2
   }
   ```

3. **Model retraining**: Research bot incorporates real trading outcomes
   (not just passive observation) to retrain the model, creating a feedback loop.

---

## File Summary

| Action | File | Description |
|--------|------|-------------|
| DELETE | `pipeline/momentum-gate.ts` | Remove momentum gate entirely |
| CREATE | `pipeline/research-score-gate.ts` | New scoring gate stage |
| MODIFY | `pipeline/pipeline.ts` | Wire research score gate after sniper gate, remove momentum gate |
| MODIFY | `pipeline/types.ts` | Add `ResearchScoreGateData`, `TokenFeatureVector`, `ScoringRule`, `ScoringModel`. Remove `MomentumGateData`, `momentumGate?` from context, `MOMENTUM_*` rejections. Add `researchScore?` to context, `RESEARCH_SCORE_LOW` rejection |
| MODIFY | `pipeline/index.ts` | Remove momentum-gate export, add research-score-gate export |
| MODIFY | `pipeline/pipeline-stats.ts` | Remove all momentum gate tracking, add research score gate tracking |
| MODIFY | `helpers/config-validator.ts` | Remove `MOMENTUM_*` config, add `RESEARCH_SCORE_*` config, change `SNIPER_GATE_ENABLED` default to `true` |
| MODIFY | `index.ts` | Remove momentumGate config block, add researchScoreGate config block |
| MODIFY | `smoke-test.ts` | Remove momentumGate config block, add researchScoreGate config block |
| MODIFY | Dashboard files | Add research score display to pipeline view, token detail, and stats |

**NOTE:** `pipeline/sniper-gate.ts` does NOT need modification. Momentum features
are derived from the existing `checkHistory` array without changing the sniper gate.

---

## Implementation Order

1. Remove momentum gate from all files (Step 1) — clean break, get it compiling
2. Add types: `ResearchScoreGateData`, `TokenFeatureVector`, `ScoringRule`, `ScoringModel` to `types.ts` (Step 2a, 2b + Step 3 types)
3. Create `research-score-gate.ts` with model fetching, feature building, and scoring (Step 2)
4. Wire into pipeline after sniper gate (Step 3, pipeline part)
5. Add env vars and config to config-validator.ts, index.ts, smoke-test.ts (Step 4)
6. Add logging, pipeline stats, and dashboard updates (Steps 5-6)
7. Test with `RESEARCH_SCORE_LOG_ONLY=true` first to validate scores without affecting trades
