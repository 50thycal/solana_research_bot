import { PumpfunCreateEvent } from '../pumpfun/parse-create';
import { ClassifiedTx } from '../pumpfun/classify-tx';
import { config } from '../config';

/**
 * Tracks per-token in-memory state across snapshots.
 * Maintains running counts, wallet sets, and parsed signature sets.
 */
export interface TrackedToken {
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  bondingCurvePda: string;
  /** On-chain creation timestamp (unix seconds) */
  createdAt: number;
  /** Collector timestamp when we first saw this token (unix ms) */
  firstSeenAt: number;

  // Running transaction sampling state
  /** Set of already-parsed signature IDs to avoid re-parsing */
  parsedSignatures: Set<string>;
  /** Set of unique buyer wallet addresses */
  buyerWallets: Set<string>;
  /** Set of unique seller wallet addresses */
  sellerWallets: Set<string>;
  /** Running cumulative buy count (extrapolated) */
  estimatedBuyCount: number;
  /** Running cumulative sell count (extrapolated) */
  estimatedSellCount: number;
  /** Total parsed buys from samples (not extrapolated) */
  sampledBuys: number;
  /** Total parsed sells from samples (not extrapolated) */
  sampledSells: number;
  /** Total parsed transactions across all snapshots */
  totalSampled: number;

  /** Last known total_tx_count from getSignaturesForAddress */
  lastTotalTxCount: number;

  /** Timestamp of last snapshot (unix ms) — for cadence tracking */
  lastSnapshotAt: number;

  /** Whether this token is still being tracked */
  active: boolean;
}

/**
 * Create a new TrackedToken from a Create event.
 */
export function createTrackedToken(event: PumpfunCreateEvent): TrackedToken {
  return {
    mint: event.mint,
    creator: event.creator,
    name: event.name,
    symbol: event.symbol,
    bondingCurvePda: event.bondingCurvePda,
    createdAt: event.createdAt,
    firstSeenAt: Date.now(),
    parsedSignatures: new Set(),
    buyerWallets: new Set(),
    sellerWallets: new Set(),
    estimatedBuyCount: 0,
    estimatedSellCount: 0,
    sampledBuys: 0,
    sampledSells: 0,
    totalSampled: 0,
    lastTotalTxCount: 0,
    lastSnapshotAt: 0,
    active: true,
  };
}

/**
 * Determine the current phase for a token based on its age.
 */
export function getTokenPhase(
  createdAtSeconds: number,
  nowMs: number,
  observationEndMs: number
): 'early' | 'observe' | 'outcome' {
  const ageSeconds = (nowMs / 1000) - createdAtSeconds;

  if (ageSeconds <= config.entryMaxSeconds) {
    return 'early';
  }

  if (nowMs <= observationEndMs) {
    return 'observe';
  }

  return 'outcome';
}

/**
 * Get the snapshot interval for a token based on its current phase.
 */
export function getSnapshotInterval(
  phase: 'early' | 'observe' | 'outcome',
  earlyIntervalMs: number,
  observeIntervalMs: number,
  outcomeIntervalMs: number
): number {
  switch (phase) {
    case 'early': return earlyIntervalMs;
    case 'observe': return observeIntervalMs;
    case 'outcome': return outcomeIntervalMs;
  }
}

/**
 * Check if a token should receive a snapshot this tick.
 */
export function shouldSnapshot(
  token: TrackedToken,
  nowMs: number,
  intervalMs: number
): boolean {
  if (!token.active) return false;
  if (token.lastSnapshotAt === 0) return true; // First snapshot
  return (nowMs - token.lastSnapshotAt) >= intervalMs;
}

/**
 * Update a token's running transaction counts after processing a batch of sampled transactions.
 * Uses extrapolation: estimated_buys = (sampled_buys / total_sampled) * total_tx_count
 */
export function updateTxCounts(
  token: TrackedToken,
  classified: ClassifiedTx[],
  totalTxCount: number
): void {
  for (const tx of classified) {
    token.parsedSignatures.add(tx.signature);

    if (tx.classification === 'buy') {
      token.sampledBuys++;
      if (tx.wallet) token.buyerWallets.add(tx.wallet);
    } else if (tx.classification === 'sell') {
      token.sampledSells++;
      if (tx.wallet) token.sellerWallets.add(tx.wallet);
    }
  }

  token.totalSampled += classified.length;
  token.lastTotalTxCount = totalTxCount;

  // Extrapolate counts
  if (token.totalSampled > 0) {
    const buyRatio = token.sampledBuys / token.totalSampled;
    const sellRatio = token.sampledSells / token.totalSampled;
    token.estimatedBuyCount = Math.round(buyRatio * totalTxCount);
    token.estimatedSellCount = Math.round(sellRatio * totalTxCount);
  }
}
