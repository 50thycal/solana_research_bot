import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { config, configSnapshot } from '../config';
import { insertRun, completeRun, incrementWsDisconnect } from '../db/queries/runs';
import { insertToken } from '../db/queries/tokens';
import { insertTokenRun } from '../db/queries/token-runs';
import { insertSnapshot, SnapshotInsert } from '../db/queries/snapshots';
import { WsListener } from './ws-listener';
import { RpcClient } from './rpc-client';
import { classifyTransaction, ClassifiedTx } from '../pumpfun/classify-tx';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run collect mode.
 * Tracks up to MAX_CONCURRENT_TOKENS tokens in parallel.
 * When a slot opens up, the next new token from the WebSocket queue is picked up.
 */
export async function runCollect(db: Database.Database): Promise<void> {
  const rpc = new RpcClient(config.heliusRpcUrl);
  let stopped = false;
  const maxConcurrent = config.maxConcurrentTokens;

  process.removeAllListeners('SIGTERM');
  process.on('SIGTERM', () => {
    console.log(JSON.stringify({ event: 'sigterm_handling' }));
    stopped = true;
    setTimeout(() => process.exit(0), 5000);
  });

  // Latest signature seen — always overwritten so we only ever track
  // a token from its moment of creation, never a stale queued one.
  let latestSignature: string | null = null;
  let activeCount = 0;
  let wsDisconnects = { count: 0, totalMs: 0 };

  const wsListener = new WsListener({
    wsUrl: config.heliusWsUrl,
    onCreateSignature: (signature: string) => {
      // Always overwrite — we only want the freshest token
      latestSignature = signature;
    },
    onDisconnect: () => {
      console.log(JSON.stringify({ event: 'ws_disconnect' }));
    },
    onReconnect: (disconnectDurationMs: number) => {
      wsDisconnects.count++;
      wsDisconnects.totalMs += disconnectDurationMs;
    },
  });

  wsListener.start();
  console.log(JSON.stringify({
    event: 'collect_started',
    maxConcurrentTokens: maxConcurrent,
    trackingDurationSeconds: config.trackingDurationSeconds,
    snapshotIntervalSeconds: config.snapshotIntervalSeconds,
  }));

  try {
    while (!stopped) {
      // If we have a free slot and a fresh token, grab it immediately
      if (activeCount < maxConcurrent && latestSignature !== null) {
        const signature = latestSignature;
        latestSignature = null; // consumed — next slot gets the next fresh token
        activeCount++;

        // Fire and forget — trackTokenLifecycle manages its own cleanup
        trackTokenLifecycle(db, rpc, signature, wsDisconnects, () => stopped)
          .catch((err) => {
            console.error(JSON.stringify({
              event: 'token_lifecycle_error',
              signature,
              error: err instanceof Error ? err.message : String(err),
            }));
          })
          .finally(() => {
            activeCount--;
          });

        // Don't sleep — check immediately if we can start another
        continue;
      }

      // Poll for new tokens or free slots
      await sleep(500);
    }
  } catch (err) {
    console.error(JSON.stringify({
      event: 'collect_error',
      error: err instanceof Error ? err.message : String(err),
    }));
    throw err;
  } finally {
    // Wait briefly for active trackers to finish
    const waitStart = Date.now();
    while (activeCount > 0 && Date.now() - waitStart < 4000) {
      await sleep(200);
    }
    wsListener.stop();
  }
}

/**
 * Full lifecycle for a single token: resolve, insert, track, complete.
 */
async function trackTokenLifecycle(
  db: Database.Database,
  rpc: RpcClient,
  signature: string,
  wsDisconnects: { count: number; totalMs: number },
  isStopped: () => boolean
): Promise<void> {
  console.log(JSON.stringify({ event: 'resolving_token', signature }));

  // The WebSocket fires almost instantly, but the RPC getTransaction endpoint
  // needs time to index the tx. Wait a bit before the first attempt, then retry
  // with increasing backoff: 2s initial, then 2s, 3s, 4s between retries.
  await sleep(2000);

  let event = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    event = await rpc.fetchCreateTransaction(signature);
    if (event) break;
    if (attempt < 4) {
      console.log(JSON.stringify({ event: 'token_resolve_retry', signature, attempt }));
      await sleep((attempt + 1) * 1000); // 2s, 3s, 4s backoff
    }
  }
  if (!event) {
    console.log(JSON.stringify({ event: 'token_resolve_failed', signature }));
    return;
  }

  const runId = uuidv4();
  insertRun(db, runId, 'collect', configSnapshot());

  const curves = await rpc.fetchBondingCurves([event.bondingCurvePda]);
  const initialCurve = curves.get(event.bondingCurvePda) ?? null;

  insertToken(db, {
    mint: event.mint,
    creator: event.creator,
    name: event.name,
    symbol: event.symbol,
    createdAt: event.createdAt,
    initialVirtualSol: initialCurve?.virtualSolReserves ?? null,
    initialVirtualToken: initialCurve?.virtualTokenReserves ?? null,
    initialPriceSol: initialCurve?.priceSol ?? null,
    bondingCurvePda: event.bondingCurvePda,
  });

  insertTokenRun(db, runId, event.mint, Date.now());

  console.log(JSON.stringify({
    event: 'tracking_token',
    runId,
    mint: event.mint,
    name: event.name,
    symbol: event.symbol,
    durationSeconds: config.trackingDurationSeconds,
    intervalSeconds: config.snapshotIntervalSeconds,
  }));

  const snapshotCount = await trackToken(db, rpc, runId, event, isStopped);

  if (wsDisconnects.count > 0) {
    incrementWsDisconnect(db, runId, wsDisconnects.totalMs);
    // Note: shared disconnect counter — minor inaccuracy is acceptable
  }

  completeRun(db, runId, 1, 0);

  console.log(JSON.stringify({
    event: 'token_tracking_complete',
    runId,
    mint: event.mint,
    name: event.name,
    symbol: event.symbol,
    snapshotCount,
  }));
}

interface TokenEvent {
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  createdAt: number;
  bondingCurvePda: string;
}

async function trackToken(
  db: Database.Database,
  rpc: RpcClient,
  runId: string,
  token: TokenEvent,
  isStopped: () => boolean
): Promise<number> {
  const state = {
    parsedSignatures: new Set<string>(),
    buyerWallets: new Set<string>(),
    sellerWallets: new Set<string>(),
    sampledBuys: 0,
    sampledSells: 0,
    totalSampled: 0,
    lastTotalTxCount: 0,
  };

  const trackingEndMs = Date.now() + config.trackingDurationSeconds * 1000;
  let snapshotCount = 0;

  while (Date.now() < trackingEndMs && !isStopped()) {
    const snapshotStart = Date.now();

    try {
      const curveMap = await rpc.fetchBondingCurves([token.bondingCurvePda]);
      const curve = curveMap.get(token.bondingCurvePda) ?? null;

      const now = Date.now();
      const secondsSinceCreation = (now / 1000) - token.createdAt;

      const signatures = await rpc.fetchSignatures(token.bondingCurvePda, { maxResults: 1000 });
      const totalTxCount = (signatures.length === 0 && state.lastTotalTxCount > 0)
        ? state.lastTotalTxCount
        : signatures.length;
      const txCountDelta = Math.max(0, totalTxCount - state.lastTotalTxCount);

      let sampleSize = 0;
      const unparsed = signatures.filter(s => !state.parsedSignatures.has(s.signature));
      const sampleCount = Math.min(unparsed.length, config.maxTxSamplePerSnapshot);

      if (sampleCount > 0) {
        const sampled = uniformSample(unparsed, sampleCount);
        const classified: ClassifiedTx[] = [];

        for (const sig of sampled) {
          const tx = await rpc.fetchTransaction(sig.signature);
          if (!tx) continue;
          const { classification, wallet } = classifyTransaction(tx.accountKeys, tx.instructions);
          classified.push({ signature: sig.signature, classification, wallet });
        }

        for (const tx of classified) {
          state.parsedSignatures.add(tx.signature);
          if (tx.classification === 'buy') {
            state.sampledBuys++;
            if (tx.wallet) state.buyerWallets.add(tx.wallet);
          } else if (tx.classification === 'sell') {
            state.sampledSells++;
            if (tx.wallet) state.sellerWallets.add(tx.wallet);
          }
        }

        state.totalSampled += classified.length;
        sampleSize = classified.length;
      }

      state.lastTotalTxCount = totalTxCount;

      let buyCount = 0;
      let sellCount = 0;
      if (state.totalSampled > 0) {
        buyCount = Math.round((state.sampledBuys / state.totalSampled) * totalTxCount);
        sellCount = Math.round((state.sampledSells / state.totalSampled) * totalTxCount);
      }

      const uniqueBuyers = state.buyerWallets.size;
      const uniqueSellers = state.sellerWallets.size;

      const buyVelocity = secondsSinceCreation > 0 ? buyCount / secondsSinceCreation : null;
      const totalBuySell = buyCount + sellCount;
      const sellRatio = totalBuySell > 0 ? sellCount / totalBuySell : null;
      const buyerTxRatio = (buyCount > 0 && uniqueBuyers > 0) ? uniqueBuyers / buyCount : null;

      const marketCapSol = (curve && curve.priceSol > 0 && curve.tokenTotalSupply > 0)
        ? curve.priceSol * curve.tokenTotalSupply
        : null;

      const volumeVelocitySol = (curve && config.snapshotIntervalSeconds > 0)
        ? (curve.priceSol * txCountDelta) / config.snapshotIntervalSeconds
        : null;

      const snapshot: SnapshotInsert = {
        mint: token.mint,
        runId,
        snapshotAt: now,
        secondsSinceCreation,
        phase: 'tracking',
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
        sampleTotal: totalTxCount,
        sampleMethod: sampleSize > 0 ? 'random_uniform' : null,
        buyVelocity,
        volumeVelocitySol,
        buyerTxRatio,
        sellRatio,
        marketCapSol,
      };

      insertSnapshot(db, snapshot);
      snapshotCount++;

      console.log(JSON.stringify({
        event: 'snapshot',
        mint: token.mint,
        snapshotNum: snapshotCount,
        secondsSinceCreation: Math.round(secondsSinceCreation),
        priceSol: curve?.priceSol ?? null,
        marketCapSol: marketCapSol != null ? Math.round(marketCapSol * 1000) / 1000 : null,
        totalTxCount,
        txCountDelta,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        event: 'snapshot_error',
        mint: token.mint,
        error: err instanceof Error ? err.message : String(err),
      }));
    }

    const elapsed = Date.now() - snapshotStart;
    const waitMs = Math.max(0, config.snapshotIntervalSeconds * 1000 - elapsed);
    if (waitMs > 0 && Date.now() + waitMs < trackingEndMs) {
      await sleep(waitMs);
    } else if (Date.now() >= trackingEndMs) {
      break;
    }
  }

  return snapshotCount;
}

function uniformSample<T>(arr: T[], count: number): T[] {
  if (count >= arr.length) return [...arr];
  const copy = [...arr];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}
