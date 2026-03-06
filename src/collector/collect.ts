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
 * Continuously: wait for the next new token on pump.fun, track it for
 * TRACKING_DURATION_SECONDS at SNAPSHOT_INTERVAL_SECONDS intervals,
 * then wait for the next one. One token at a time.
 */
export async function runCollect(db: Database.Database): Promise<void> {
  const rpc = new RpcClient(config.heliusRpcUrl);
  let stopped = false;

  process.removeAllListeners('SIGTERM');
  process.on('SIGTERM', () => {
    console.log(JSON.stringify({ event: 'sigterm_handling' }));
    stopped = true;
    setTimeout(() => process.exit(0), 5000);
  });

  // WebSocket listener queues Create signatures.
  // We only accept one when we're idle (not tracking).
  let pendingSignature: string | null = null;
  let accepting = true;
  let wsDisconnects = { count: 0, totalMs: 0 };

  const wsListener = new WsListener({
    wsUrl: config.heliusWsUrl,
    onCreateSignature: (signature: string) => {
      if (accepting && pendingSignature === null) {
        pendingSignature = signature;
      }
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
    trackingDurationSeconds: config.trackingDurationSeconds,
    snapshotIntervalSeconds: config.snapshotIntervalSeconds,
  }));

  try {
    while (!stopped) {
      // Wait for the next token
      console.log(JSON.stringify({ event: 'waiting_for_token' }));
      accepting = true;
      pendingSignature = null;

      while (pendingSignature === null && !stopped) {
        await sleep(500);
      }
      if (stopped) break;

      accepting = false; // Block new tokens while tracking
      const signature = pendingSignature!;

      console.log(JSON.stringify({ event: 'resolving_token', signature }));
      const event = await rpc.fetchCreateTransaction(signature);
      if (!event) {
        console.log(JSON.stringify({ event: 'token_resolve_failed', signature }));
        continue;
      }

      // Create a run for this token
      const runId = uuidv4();
      insertRun(db, runId, 'collect', configSnapshot());

      // Fetch initial bonding curve state
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

      // Track this token
      const snapshotCount = await trackToken(db, rpc, runId, event, stopped);

      if (wsDisconnects.count > 0) {
        incrementWsDisconnect(db, runId, wsDisconnects.totalMs);
        wsDisconnects = { count: 0, totalMs: 0 };
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
  } catch (err) {
    console.error(JSON.stringify({
      event: 'collect_error',
      error: err instanceof Error ? err.message : String(err),
    }));
    throw err;
  } finally {
    wsListener.stop();
  }
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
  stopped: boolean
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

  while (Date.now() < trackingEndMs && !stopped) {
    const snapshotStart = Date.now();

    try {
      const curveMap = await rpc.fetchBondingCurves([token.bondingCurvePda]);
      const curve = curveMap.get(token.bondingCurvePda) ?? null;

      const now = Date.now();
      const secondsSinceCreation = (now / 1000) - token.createdAt;

      // Fetch signature count
      const signatures = await rpc.fetchSignatures(token.bondingCurvePda, { maxResults: 1000 });
      const totalTxCount = (signatures.length === 0 && state.lastTotalTxCount > 0)
        ? state.lastTotalTxCount
        : signatures.length;
      const txCountDelta = Math.max(0, totalTxCount - state.lastTotalTxCount);

      // Sample transactions for buy/sell classification
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

      // Extrapolate buy/sell counts
      let buyCount = 0;
      let sellCount = 0;
      if (state.totalSampled > 0) {
        buyCount = Math.round((state.sampledBuys / state.totalSampled) * totalTxCount);
        sellCount = Math.round((state.sampledSells / state.totalSampled) * totalTxCount);
      }

      const uniqueBuyers = state.buyerWallets.size;
      const uniqueSellers = state.sellerWallets.size;

      // Derived features
      const buyVelocity = secondsSinceCreation > 0 ? buyCount / secondsSinceCreation : null;
      const totalBuySell = buyCount + sellCount;
      const sellRatio = totalBuySell > 0 ? sellCount / totalBuySell : null;
      const buyerTxRatio = (buyCount > 0 && uniqueBuyers > 0) ? uniqueBuyers / buyCount : null;

      // Market cap: price * total token supply
      const marketCapSol = (curve && curve.priceSol > 0 && curve.tokenTotalSupply > 0)
        ? curve.priceSol * curve.tokenTotalSupply
        : null;

      // Volume velocity: rough proxy using txCountDelta * price
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

    // Wait for next interval
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
