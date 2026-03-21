import { Connection, PublicKey, Logs } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM_ID } from '../pumpfun/constants';
import { log, logError } from '../logger';

export interface WsListenerOptions {
  /** HTTP RPC endpoint (e.g. https://mainnet.helius-rpc.com/?api-key=...) */
  rpcUrl: string;
  /** WebSocket endpoint (e.g. wss://mainnet.helius-rpc.com/?api-key=...) */
  wsUrl: string;
  /** Called when a pump.fun Create transaction signature is detected. */
  onCreateSignature: (signature: string) => void;
  /** Called when the WebSocket disconnects (timestamp in ms). */
  onDisconnect: (disconnectedAtMs: number) => void;
  /** Called when the WebSocket reconnects (total ms spent disconnected). */
  onReconnect: (disconnectDurationMs: number) => void;
}

/**
 * Listens for pump.fun token creation events using Connection.onLogs().
 *
 * Uses the @solana/web3.js Connection class (same approach as the trading bot)
 * instead of raw WebSocket + logsSubscribe. The SDK handles WS connection
 * management, buffering, and reconnection internally.
 *
 * Detects both legacy Create and Token-2022 CreateV2 instructions.
 */
export class WsListener {
  private connection: Connection | null = null;
  private subscriptionId: number | null = null;
  private stopped = false;
  private readonly opts: WsListenerOptions;
  private processedSignatures = new Set<string>();
  private readonly MAX_PROCESSED_CACHE = 5000;

  constructor(opts: WsListenerOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.connection && this.subscriptionId !== null) {
      this.connection.removeOnLogsListener(this.subscriptionId).catch(() => {
        // Ignore cleanup errors
      });
      this.subscriptionId = null;
    }
    this.connection = null;
  }

  private connect(): void {
    if (this.stopped) return;

    log({
      event: 'ws_connecting',
      url: this.opts.wsUrl.replace(/api-key=.*/, 'api-key=***'),
    });

    this.connection = new Connection(this.opts.rpcUrl, {
      wsEndpoint: this.opts.wsUrl,
      commitment: 'confirmed',
    });

    this.subscriptionId = this.connection.onLogs(
      PUMP_FUN_PROGRAM_ID,
      (logs: Logs) => this.handleLogs(logs),
      'confirmed',
    );

    log({
      event: 'ws_subscribed',
      subscriptionId: this.subscriptionId,
    });
  }

  private handleLogs(logs: Logs): void {
    // Skip failed transactions
    if (logs.err) return;

    const signature = logs.signature;

    // Skip duplicates
    if (this.processedSignatures.has(signature)) return;

    // Look for pump.fun Create or CreateV2 instruction in the logs.
    // Must match EXACTLY — not "CreateTokenAccount" or "CreateIdempotent".
    // CreateV2 is for Token-2022 based pump.fun tokens.
    const logMessages = logs.logs || [];
    let isPumpfunCreate = false;

    for (const line of logMessages) {
      if (line === 'Program log: Instruction: Create' || line === 'Program log: Instruction: CreateV2') {
        isPumpfunCreate = true;
        break;
      }
    }

    if (!isPumpfunCreate) return;

    // Track processed signatures to avoid duplicates (bounded cache)
    this.processedSignatures.add(signature);
    if (this.processedSignatures.size > this.MAX_PROCESSED_CACHE) {
      const first = this.processedSignatures.values().next().value;
      if (first !== undefined) this.processedSignatures.delete(first);
    }

    log({
      event: 'ws_create_detected',
      signature,
    });

    this.opts.onCreateSignature(signature);
  }
}
