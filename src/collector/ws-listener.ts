import WebSocket from 'ws';
import { PUMP_FUN_PROGRAM_ID } from '../pumpfun/constants';
import { log, logError } from '../logger';

export interface WsListenerOptions {
  wsUrl: string;
  /** Called when a pump.fun Create transaction signature is detected. */
  onCreateSignature: (signature: string) => void;
  /** Called when the WebSocket disconnects (timestamp in ms). */
  onDisconnect: (disconnectedAtMs: number) => void;
  /** Called when the WebSocket reconnects (total ms spent disconnected). */
  onReconnect: (disconnectDurationMs: number) => void;
}

/**
 * WebSocket listener that subscribes to pump.fun Create events via Helius
 * Enhanced WebSocket (transactionSubscribe on the Atlas endpoint).
 *
 * Uses transactionSubscribe instead of logsSubscribe because logsSubscribe
 * with `mentions` receives ALL pump.fun transactions (buys/sells/creates),
 * which overwhelms the standard WS and causes most messages to be dropped.
 * Enhanced WS on Atlas is designed for high-throughput streaming.
 *
 * Includes a heartbeat ping every 10s to keep the connection alive per
 * Helius recommendations.
 */
export class WsListener {
  private ws: WebSocket | null = null;
  private subscriptionId: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private disconnectedAt: number | null = null;
  private stopped = false;
  private readonly opts: WsListenerOptions;
  private readonly RECONNECT_DELAY_MS = 5000;
  private readonly HEARTBEAT_INTERVAL_MS = 10_000;

  constructor(opts: WsListenerOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try {
        if (this.subscriptionId !== null) {
          this.ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'transactionUnsubscribe',
            params: [this.subscriptionId],
          }));
        }
        this.ws.close();
      } catch {
        // Ignore errors during cleanup
      }
      this.ws = null;
      this.subscriptionId = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    log({
      event: 'ws_connecting',
      url: this.opts.wsUrl.replace(/api-key=.*/, 'api-key=***'),
    });

    this.ws = new WebSocket(this.opts.wsUrl);

    this.ws.on('open', () => {
      log({ event: 'ws_connected' });

      if (this.disconnectedAt !== null) {
        const duration = Date.now() - this.disconnectedAt;
        this.opts.onReconnect(duration);
        this.disconnectedAt = null;
      }

      this.startHeartbeat();
      this.subscribe();
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch (err) {
        logError({
          event: 'ws_parse_error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.ws.on('error', (err: Error) => {
      logError({
        event: 'ws_error',
        error: err.message,
      });
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      log({
        event: 'ws_disconnected',
        code,
        reason: reason.toString(),
      });

      this.subscriptionId = null;
      this.ws = null;
      this.stopHeartbeat();

      if (!this.stopped) {
        if (this.disconnectedAt === null) {
          this.disconnectedAt = Date.now();
          this.opts.onDisconnect(this.disconnectedAt);
        }
        this.scheduleReconnect();
      }
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const pumpProgramId = PUMP_FUN_PROGRAM_ID.toBase58();

    const request = {
      jsonrpc: '2.0',
      id: 420,
      method: 'transactionSubscribe',
      params: [
        {
          failed: false,
          accountInclude: [pumpProgramId],
        },
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0,
        },
      ],
    };

    this.ws.send(JSON.stringify(request));
  }

  private handleMessage(msg: any): void {
    // Subscription confirmation
    if (msg.id === 420 && msg.result !== undefined) {
      this.subscriptionId = msg.result;
      log({
        event: 'ws_subscribed',
        subscriptionId: this.subscriptionId,
      });
      return;
    }

    // Transaction notification from transactionSubscribe
    if (msg.method === 'transactionNotification' && msg.params?.result) {
      this.handleTransactionNotification(msg.params.result);
    }
  }

  private handleTransactionNotification(result: any): void {
    const signature = result.signature;
    if (!signature) return;

    // Check log messages for pump.fun Create instruction
    const logs: string[] | undefined =
      result.transaction?.meta?.logMessages;

    if (!logs || !Array.isArray(logs)) return;

    const pumpProgramId = PUMP_FUN_PROGRAM_ID.toBase58();
    let inPumpfun = false;
    let pumpfunDepth = 0;
    let isPumpfunCreate = false;

    for (const line of logs) {
      if (line.includes(`Program ${pumpProgramId} invoke`)) {
        inPumpfun = true;
        pumpfunDepth++;
      } else if (inPumpfun && line.includes(`Program ${pumpProgramId} success`)) {
        pumpfunDepth--;
        if (pumpfunDepth <= 0) {
          inPumpfun = false;
          pumpfunDepth = 0;
        }
      } else if (inPumpfun && line === 'Program log: Instruction: Create') {
        isPumpfunCreate = true;
        break;
      }
    }

    if (!isPumpfunCreate) return;

    log({
      event: 'ws_create_detected',
      signature,
    });

    this.opts.onCreateSignature(signature);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    log({
      event: 'ws_reconnect_scheduled',
      delayMs: this.RECONNECT_DELAY_MS,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.RECONNECT_DELAY_MS);
  }
}
