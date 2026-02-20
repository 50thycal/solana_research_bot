import Database from 'better-sqlite3';
import { RpcClient } from './rpc-client';
import {
  TrackedToken,
  getTokenPhase,
  getSnapshotInterval,
  shouldSnapshot,
  updateTxCounts,
} from './token-tracker';
import { classifyTransaction, ClassifiedTx } from '../pumpfun/classify-tx';
import { insertSnapshot, SnapshotInsert } from '../db/queries/snapshots';
import { config } from '../config';

/**
 * Run a single snapshot round for all tracked tokens.
 * 1. Filter tokens that are due for a snapshot this tick.
 * 2. Batch-fetch bonding curve states.
 * 3. For each token: fetch signature count, sample transactions (if not outcome phase).
 * 4. Compute derived features and insert snapshot rows.
 */
export async function runSnapshotRound(
  db: Database.Database,
  rpc: RpcClient,
  tokens: Map<string, TrackedToken>,
  runId: string,
  observationEndMs: number
): Promise<number> {
  const now = Date.now();
  let snapshotsInserted = 0;

  // Determine which tokens need a snapshot this tick
  const dueTokens: TrackedToken[] = [];
  for (const token of tokens.values()) {
    if (!token.active) continue;

    const phase = getTokenPhase(token.createdAt, now, observationEndMs);
    const interval = getSnapshotInterval(
      phase,
      config.earlySnapshotIntervalMs,
      config.snapshotIntervalMs,
      config.outcomeSnapshotIntervalMs
    );

    if (shouldSnapshot(token, now, interval)) {
      dueTokens.push(token);
    }
  }

  if (dueTokens.length === 0) return 0;

  // 1. Batch-fetch bonding curve states
  const pdas = dueTokens.map(t => t.bondingCurvePda);
  const curveStates = await rpc.fetchBondingCurves(pdas);

  // 2. For each due token, fetch signatures and optionally sample transactions
  let txSamplesThisRound = 0;

  for (const token of dueTokens) {
    const phase = getTokenPhase(token.createdAt, now, observationEndMs);
    const curve = curveStates.get(token.bondingCurvePda) ?? null;
    const secondsSinceCreation = (now / 1000) - token.createdAt;

    // Fetch signature count. During the early phase (first 120 s), tokens cannot
    // yet have accumulated 1 000+ transactions, so a single page is sufficient and
    // avoids turning every 5-second snapshot tick into 5 sequential RPC calls.
    // For observe/outcome phases, paginate up to 5 000 so totalTxCount remains
    // accurate for high-volume tokens that would otherwise freeze at the RPC cap.
    const sigMaxResults = phase === 'early' ? 1000 : 5000;
    const signatures = await rpc.fetchSignatures(token.bondingCurvePda, { maxResults: sigMaxResults });

    // If we received 0 signatures but the token previously had transactions, treat
    // this as a transient RPC failure and keep the last known count.  A genuine
    // brand-new token has lastTotalTxCount === 0, so the fallback is a no-op there.
    const totalTxCount = (signatures.length === 0 && token.lastTotalTxCount > 0)
      ? token.lastTotalTxCount
      : signatures.length;
    const txCountDelta = Math.max(0, totalTxCount - token.lastTotalTxCount);

    // Sample transactions (skip during outcome phase per spec)
    let buyCount = token.estimatedBuyCount;
    let sellCount = token.estimatedSellCount;
    let uniqueBuyers = token.buyerWallets.size;
    let uniqueSellers = token.sellerWallets.size;
    let sampleSize = 0;
    let sampleTotal = totalTxCount;

    if (phase !== 'outcome' && txSamplesThisRound < config.maxTxSamplePerRound) {
      // Find unparsed signatures
      const unparsed = signatures.filter(s => !token.parsedSignatures.has(s.signature));

      // Sample up to MAX_TX_SAMPLE_PER_TOKEN uniformly at random
      const sampleCount = Math.min(
        unparsed.length,
        config.maxTxSamplePerToken,
        config.maxTxSamplePerRound - txSamplesThisRound
      );

      if (sampleCount > 0) {
        const sampled = uniformSample(unparsed, sampleCount);
        const classified: ClassifiedTx[] = [];

        for (const sig of sampled) {
          const tx = await rpc.fetchTransaction(sig.signature);
          if (!tx) continue;

          const { classification, wallet } = classifyTransaction(tx.accountKeys, tx.instructions);
          classified.push({
            signature: sig.signature,
            classification,
            wallet,
          });
        }

        updateTxCounts(token, classified, totalTxCount);
        sampleSize = classified.length;
        txSamplesThisRound += sampleSize;

        // Update local vars with new estimates
        buyCount = token.estimatedBuyCount;
        sellCount = token.estimatedSellCount;
        uniqueBuyers = token.buyerWallets.size;
        uniqueSellers = token.sellerWallets.size;
      }
    } else {
      // Update total tx count even if not sampling
      token.lastTotalTxCount = totalTxCount;
    }

    // Compute derived features
    const buyVelocity = secondsSinceCreation > 0 ? buyCount / secondsSinceCreation : null;

    // Use time since last snapshot as the velocity window (not total age).
    // Fall back to secondsSinceCreation on the very first snapshot (lastSnapshotAt === 0).
    const velocityWindowSeconds = token.lastSnapshotAt > 0
      ? (now - token.lastSnapshotAt) / 1000
      : secondsSinceCreation;

    const volumeVelocitySol = (curve && velocityWindowSeconds > 0)
      ? (curve.priceSol * txCountDelta) / velocityWindowSeconds
      : null;

    const buyerTxRatio = (buyCount > 0 && uniqueBuyers > 0)
      ? uniqueBuyers / buyCount
      : null;

    const totalBuySell = buyCount + sellCount;
    const sellRatio = totalBuySell > 0
      ? sellCount / totalBuySell
      : null;

    // Insert snapshot
    const snapshot: SnapshotInsert = {
      mint: token.mint,
      runId,
      snapshotAt: now,
      secondsSinceCreation,
      phase,
      virtualSolReserves: curve?.virtualSolReserves ?? null,
      virtualTokenReserves: curve?.virtualTokenReserves ?? null,
      realSolReserves: curve?.realSolReserves ?? null,
      realTokenReserves: curve?.realTokenReserves ?? null,
      priceSol: curve?.priceSol ?? null,
      totalTxCount,
      txCountDelta,
      buyCount,
      sellCount,
      uniqueBuyers,
      uniqueSellers,
      sampleSize,
      sampleTotal,
      sampleMethod: sampleSize > 0 ? 'random_uniform' : null,
      buyVelocity,
      volumeVelocitySol,
      buyerTxRatio,
      sellRatio,
    };

    insertSnapshot(db, snapshot);
    token.lastSnapshotAt = now;
    snapshotsInserted++;
  }

  return snapshotsInserted;
}

/**
 * Uniform random sampling from an array without replacement.
 */
function uniformSample<T>(arr: T[], count: number): T[] {
  if (count >= arr.length) return [...arr];

  // Fisher-Yates partial shuffle
  const copy = [...arr];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}
