# Research Score Gate — Implementation Plan for Trading Bot

> This plan is for the `solana-trading-bot` repo. It describes how to integrate
> the research bot's scoring model into the trading bot's pipeline as a new gate
> that replaces the momentum gate.

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

---

## Step 1: Remove Momentum Gate

### Files to modify:
- `pipeline/index.ts` — Remove `export * from './momentum-gate'`
- `pipeline/pipeline.ts` — Remove momentum gate import, remove the momentum gate
  stage from the constructor, remove the conditional that chooses between sniper
  gate and momentum gate (always use sniper gate, then research score gate)
- `pipeline/types.ts` — Remove `MomentumGateData` interface and
  `RejectionReasons.MOMENTUM_*` constants if they exist

### File to delete:
- `pipeline/momentum-gate.ts`

### Env vars to remove:
- Any `MOMENTUM_*` env vars from config. The `SNIPER_GATE_ENABLED` toggle that
  fell back to momentum gate should be removed or repurposed — sniper gate is
  now always on.

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
  holderConcentration: number;
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
  checkpointSeconds: number; // e.g. 30
  rules: ScoringRule[];
  sampleCount: number;       // how many tokens the model was trained on
  baseRate2x: number;        // base hit-2x rate (%) before filtering
}
```

#### 2c. Data Mapping — How to Build Features from Pipeline Data

The trading bot already has all the raw data at the point the research score
gate runs. Here's exactly where each feature comes from:

```typescript
// Available from prior pipeline stages:
// - ctx.detection: DetectionEvent (mint, bondingCurve, slot, detectedAt)
// - ctx.deepFilters.bondingCurveState: BondingCurveState
// - ctx.sniperGate: SniperGateData (botCount, organicCount, wallets, etc.)

function buildFeatureVector(ctx: PipelineContext): TokenFeatureVector {
  const bcs = ctx.deepFilters.bondingCurveState;
  const sniper = ctx.sniperGate;
  const detection = ctx.detection;

  // Time since creation
  const secondsSinceCreation = (Date.now() - detection.detectedAt) / 1000;

  // Price from bonding curve: virtualSolReserves / virtualTokenReserves
  const priceSol = bcs.virtualSolReserves / bcs.virtualTokenReserves;

  // Initial price: use the price at detection time
  // (the deep filters fetch bonding curve state early, so this IS the initial price)
  const initialPrice = priceSol; // See note below

  // Transaction data from sniper gate
  // Sniper gate fetches signatures and classifies wallets.
  // buyCount = organicCount + botCount (total buy wallets)
  // sellCount = number of bot exits (sells detected)
  const buyCount = (sniper.organicCount || 0) + (sniper.botCount || 0);
  const sellCount = sniper.botExitCount || 0; // bots that sold
  const totalTxCount = sniper.totalSignatures || buyCount + sellCount;
  const uniqueBuyers = sniper.organicCount || 0; // distinct organic wallets
  const uniqueSellers = sniper.botExitCount || 0;

  // Derived features
  const buyVelocity = secondsSinceCreation > 0 ? buyCount / secondsSinceCreation : 0;
  const sellRatio = (buyCount + sellCount) > 0
    ? sellCount / (buyCount + sellCount) : 0;
  const buyerTxRatio = buyCount > 0 ? uniqueBuyers / buyCount : 0;
  const marketCapSol = priceSol * (bcs.virtualTokenReserves + bcs.realTokenReserves);

  return {
    mint: detection.mint.toBase58(),
    checkpointSeconds: secondsSinceCreation,
    priceSol,
    priceChangeFromInitial: 0, // See note below
    realSolReserves: bcs.realSolReserves,
    totalTxCount,
    buyCount,
    sellCount,
    uniqueBuyers,
    uniqueSellers,
    buyVelocity,
    sellRatio,
    buyerTxRatio,
    marketCapSol,

    // Momentum features — these require a second bonding curve fetch
    // to measure change over time. See Step 2d for implementation.
    priceAcceleration: 0,
    buyAcceleration: 0,
    txBurst: 0,
    holderConcentration: buyCount > 0 ? uniqueBuyers / buyCount : 0,
  };
}
```

**IMPORTANT NOTES:**
- `priceChangeFromInitial`: In the research bot this compares price at checkpoint
  vs initial. In the trading bot, the deep filters fetch the bonding curve ONCE,
  so we only have one price point. Set this to 0 unless you add a second fetch.
- `priceAcceleration` and `buyAcceleration`: These require comparing two points
  in time. The sniper gate already polls multiple times — you can capture the
  first and last poll data to compute these. See Step 2d.
- `txBurst`: This is max transactions in any single interval. The sniper gate
  fetches signatures on each poll — you can track the max delta between polls.

#### 2d. Enhanced Sniper Gate Data (optional but recommended)

To compute momentum features, modify the sniper gate to also capture:

```typescript
// Add to SniperGateData interface in types.ts:
interface SniperGateData {
  // ... existing fields ...

  // New fields for research score gate
  totalSignatures: number;       // total tx signatures seen
  botExitCount: number;          // number of bots that exited
  firstPollBuyCount: number;     // buys at first poll
  lastPollBuyCount: number;      // buys at last poll
  firstPollTimestamp: number;    // ms timestamp of first poll
  lastPollTimestamp: number;     // ms timestamp of last poll
  maxTxDelta: number;            // max new txs between consecutive polls
}
```

This lets the research score gate compute:
```typescript
priceAcceleration = 0; // Still hard without two price reads
buyAcceleration = (lastPollBuyCount - firstPollBuyCount) /
                  ((lastPollTimestamp - firstPollTimestamp) / 1000);
txBurst = maxTxDelta;
```

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
2. Cache the model in memory
3. Set up a refresh interval to re-fetch periodically
4. On `execute(ctx)`:
   - Build `TokenFeatureVector` from pipeline context (see Step 2c)
   - Run `scoreToken(model, features)` (see Step 2e)
   - If `score >= scoreThreshold` → PASS
   - If `score < scoreThreshold` → REJECT (unless `logOnly: true`)
   - Always attach `ResearchScoreGateData` to the stage result
5. On model fetch failure: log a warning and use the cached model.
   If no model has ever been fetched, either always pass (graceful degradation)
   or reject (strict mode) — configurable.

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

Add to the trading bot dashboard's trade journal / diagnostic views:
- Show the research score alongside other pipeline stage data
- Show which features contributed most to the score

---

## Step 6: Pipeline Stats Integration

Update `pipeline/pipeline-stats.ts` to track:
- `researchScorePassCount` / `researchScoreRejectCount`
- `avgResearchScore` (across all tokens evaluated)
- `avgResearchScoreForBuys` (only tokens that passed all gates)
- `researchScoreDistribution` (histogram buckets: 0-20, 20-40, 40-60, 60-80, 80-100)

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
| MODIFY | `pipeline/pipeline.ts` | Wire research score gate after sniper gate |
| MODIFY | `pipeline/types.ts` | Add `ResearchScoreGateData`, remove `MomentumGateData` |
| MODIFY | `pipeline/index.ts` | Update exports |
| MODIFY | `pipeline/sniper-gate.ts` | Add extra fields to `SniperGateData` for momentum features |
| MODIFY | config file | Add `RESEARCH_SCORE_*` env vars |
| MODIFY | `pipeline/pipeline-stats.ts` | Track research score metrics |

---

## Implementation Order

1. Remove momentum gate (Step 1) — clean break, get it compiling
2. Add `ResearchScoreGateData` to types (Step 3, types part)
3. Create `research-score-gate.ts` with model fetching + scoring (Step 2)
4. Wire into pipeline after sniper gate (Step 3, pipeline part)
5. Add env vars and config (Step 4)
6. Update sniper gate to emit extra data for momentum features (Step 2d)
7. Add logging and stats (Steps 5-6)
8. Test with `RESEARCH_SCORE_LOG_ONLY=true` first to validate scores without affecting trades
