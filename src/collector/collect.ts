import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { config, configSnapshot } from '../config';
import { insertRun, completeRun, partialRun, failRun, incrementWsDisconnect } from '../db/queries/runs';
import { insertToken } from '../db/queries/tokens';
import { insertTokenRun } from '../db/queries/token-runs';
import { WsListener } from './ws-listener';
import { RpcClient } from './rpc-client';
import { TrackedToken, createTrackedToken, getTokenPhase } from './token-tracker';
import { runSnapshotRound } from './snapshot-round';
import { PumpfunCreateEvent } from '../pumpfun/parse-create';

/** Minimum tick interval for the main loop (ms) */
const TICK_INTERVAL_MS = 1000;

interface CollectState {
  runId: string;
  db: Database.Database;
  rpc: RpcClient;
  wsListener: WsListener;
  tokens: Map<string, TrackedToken>;
  observationEndMs: number;
  hardCapEndMs: number;
  stopped: boolean;
  /** Pending Create tx signatures to resolve */
  pendingSignatures: string[];
  /** Set of signatures already resolved or in-flight */
  seenSignatures: Set<string>;
}

/**
 * Run the collect mode.
 * This is the main entry point called from index.ts.
 */
export async function runCollect(db: Database.Database): Promise<void> {
  const runId = uuidv4();
  const rpc = new RpcClient(config.heliusRpcUrl);
  const now = Date.now();

  const state: CollectState = {
    runId,
    db,
    rpc,
    wsListener: null as any, // Set below
    tokens: new Map(),
    observationEndMs: now + config.observationWindowMinutes * 60 * 1000,
    hardCapEndMs: now + config.maxTrackMinutes * 60 * 1000,
    stopped: false,
    pendingSignatures: [],
    seenSignatures: new Set(),
  };

  // Insert the run record
  insertRun(db, runId, 'collect', configSnapshot());

  console.log(JSON.stringify({
    event: 'collect_init',
    runId,
    observationWindowMinutes: config.observationWindowMinutes,
    maxTrackMinutes: config.maxTrackMinutes,
    maxTokensPerRun: config.maxTokensPerRun,
  }));

  // Set up WebSocket listener
  state.wsListener = new WsListener({
    wsUrl: config.heliusWsUrl,
    onCreateSignature: (signature: string) => {
      if (!state.seenSignatures.has(signature)) {
        state.seenSignatures.add(signature);
        state.pendingSignatures.push(signature);
      }
    },
    onDisconnect: (disconnectedAtMs: number) => {
      console.log(JSON.stringify({
        event: 'ws_disconnect_recorded',
        runId,
        disconnectedAtMs,
      }));
    },
    onReconnect: (disconnectDurationMs: number) => {
      incrementWsDisconnect(db, runId, disconnectDurationMs);
      console.log(JSON.stringify({
        event: 'ws_reconnect_recorded',
        runId,
        disconnectDurationMs,
      }));
    },
  });

  // Set up SIGTERM handler
  const sigTermHandler = async () => {
    console.log(JSON.stringify({ event: 'sigterm_handling', runId }));
    state.stopped = true;
    state.wsListener.stop();
    partialRun(db, runId, state.tokens.size);
  };
  process.removeAllListeners('SIGTERM');
  process.on('SIGTERM', () => {
    sigTermHandler().catch(console.error);
    // Give 5s for cleanup then exit
    setTimeout(() => process.exit(0), 5000);
  });

  try {
    // Start WebSocket listener
    state.wsListener.start();

    // Main loop
    await mainLoop(state);

    // Finalize
    state.wsListener.stop();
    completeRun(db, runId, state.tokens.size, 0);

    console.log(JSON.stringify({
      event: 'collect_complete',
      runId,
      tokensObserved: state.tokens.size,
      totalSnapshots: '(see DB)',
    }));
  } catch (err) {
    state.wsListener.stop();
    failRun(db, runId);

    console.error(JSON.stringify({
      event: 'collect_error',
      runId,
      error: err instanceof Error ? err.message : String(err),
    }));

    throw err;
  }
}

/**
 * Main event loop — runs at TICK_INTERVAL_MS.
 * Each tick:
 * 1. Resolve pending Create signatures into tracked tokens.
 * 2. Run snapshot round for due tokens.
 * 3. Check if tokens have completed their outcome horizon and deactivate.
 * 4. Check termination conditions.
 */
async function mainLoop(state: CollectState): Promise<void> {
  while (!state.stopped) {
    const now = Date.now();

    // Hard cap check
    if (now >= state.hardCapEndMs) {
      console.log(JSON.stringify({
        event: 'hard_cap_reached',
        runId: state.runId,
      }));
      break;
    }

    // 1. Resolve pending Create signatures
    await resolvePendingSignatures(state);

    // 2. Run snapshot round
    const inObservation = now < state.observationEndMs;
    try {
      const inserted = await runSnapshotRound(
        state.db,
        state.rpc,
        state.tokens,
        state.runId,
        state.observationEndMs
      );

      if (inserted > 0) {
        console.log(JSON.stringify({
          event: 'snapshot_round',
          runId: state.runId,
          snapshotsInserted: inserted,
          activeTokens: countActive(state.tokens),
          inObservation,
        }));
      }
    } catch (err) {
      console.error(JSON.stringify({
        event: 'snapshot_round_error',
        runId: state.runId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }

    // 3. Deactivate tokens that have completed their outcome horizon
    deactivateCompletedTokens(state, now);

    // 4. Check if all tokens are done (post-observation)
    if (!inObservation && countActive(state.tokens) === 0) {
      console.log(JSON.stringify({
        event: 'all_tokens_complete',
        runId: state.runId,
      }));
      break;
    }

    // Wait for next tick
    await sleep(TICK_INTERVAL_MS);
  }
}

/**
 * Resolve pending Create tx signatures into full token records.
 * Fetches the transaction via RPC, parses the Create instruction,
 * and adds the token to tracking.
 */
async function resolvePendingSignatures(state: CollectState): Promise<void> {
  // Process up to 5 pending signatures per tick to avoid blocking
  const toProcess = state.pendingSignatures.splice(0, 5);

  for (const signature of toProcess) {
    // Skip if we're past observation window or at token cap
    if (Date.now() >= state.observationEndMs) continue;
    if (state.tokens.size >= config.maxTokensPerRun) continue;

    try {
      const event = await state.rpc.fetchCreateTransaction(signature);
      if (!event) continue;

      // Skip if we already track this mint
      if (state.tokens.has(event.mint)) continue;

      // Fetch initial bonding curve state
      const curves = await state.rpc.fetchBondingCurves([event.bondingCurvePda]);
      const initialCurve = curves.get(event.bondingCurvePda) ?? null;

      // Create tracked token
      const tracked = createTrackedToken(event);
      state.tokens.set(event.mint, tracked);

      // Insert into database
      insertToken(state.db, {
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

      insertTokenRun(state.db, state.runId, event.mint, Date.now());

      console.log(JSON.stringify({
        event: 'token_added',
        runId: state.runId,
        mint: event.mint,
        name: event.name,
        symbol: event.symbol,
        tokenCount: state.tokens.size,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        event: 'resolve_signature_error',
        signature,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
}

/**
 * Deactivate tokens that have completed their outcome horizon.
 *
 * A token is done when:
 * - entry_time + OUTCOME_WINDOW_SECONDS has elapsed (if entry triggered), OR
 * - created_at + ENTRY_MAX_SECONDS + OUTCOME_WINDOW_SECONDS has elapsed (if no entry yet)
 *
 * Since we don't know entry status during collection (that's label-time),
 * we use the conservative bound: created_at + ENTRY_MAX_SECONDS + OUTCOME_WINDOW_SECONDS.
 */
function deactivateCompletedTokens(state: CollectState, nowMs: number): void {
  const maxTrackSeconds = config.entryMaxSeconds + config.outcomeWindowSeconds;

  for (const token of state.tokens.values()) {
    if (!token.active) continue;

    const tokenAgeSeconds = (nowMs / 1000) - token.createdAt;
    if (tokenAgeSeconds >= maxTrackSeconds) {
      token.active = false;

      console.log(JSON.stringify({
        event: 'token_deactivated',
        mint: token.mint,
        ageSeconds: Math.round(tokenAgeSeconds),
        reason: 'outcome_horizon_complete',
      }));
    }
  }
}

function countActive(tokens: Map<string, TrackedToken>): number {
  let count = 0;
  for (const t of tokens.values()) {
    if (t.active) count++;
  }
  return count;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
