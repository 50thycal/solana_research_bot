import WebSocket from 'ws';
import { PUMP_FUN_PROGRAM_ID } from '../pumpfun/constants';

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
 * WebSocket listener that subscribes to pump.fun Create events via Helius logsSubscribe.
 * Implements reconnection with 5s backoff as specified.
 *
 * Since logsSubscribe only provides logs + signature (not account keys),
 * this emits the tx signature so the collector can fetch full details via getTransaction.
 */
export class WsListener {
  private ws: WebSocket | null = null;
  private subscriptionId: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectedAt: number | null = null;
  private stopped = false;
  private readonly opts: WsListenerOptions;
  private readonly RECONNECT_DELAY_MS = 5000;

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
    if (this.ws) {
      try {
        if (this.subscriptionId !== null) {
          this.ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'logsUnsubscribe',
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

    console.log(JSON.stringify({
      event: 'ws_connecting',
      url: this.opts.wsUrl.replace(/api-key=.*/, 'api-key=***'),
    }));

    this.ws = new WebSocket(this.opts.wsUrl);

    this.ws.on('open', () => {
      console.log(JSON.stringify({ event: 'ws_connected' }));

      if (this.disconnectedAt !== null) {
        const duration = Date.now() - this.disconnectedAt;
        this.opts.onReconnect(duration);
        this.disconnectedAt = null;
      }

      this.subscribe();
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch (err) {
        console.error(JSON.stringify({
          event: 'ws_parse_error',
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    });

    this.ws.on('error', (err: Error) => {
      console.error(JSON.stringify({
        event: 'ws_error',
        error: err.message,
      }));
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log(JSON.stringify({
        event: 'ws_disconnected',
        code,
        reason: reason.toString(),
      }));

      this.subscriptionId = null;
      this.ws = null;

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

    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        {
          mentions: [PUMP_FUN_PROGRAM_ID.toBase58()],
        },
        {
          commitment: 'confirmed',
        },
      ],
    };

    this.ws.send(JSON.stringify(request));
  }

  private handleMessage(msg: any): void {
    // Subscription confirmation
    if (msg.id === 1 && msg.result !== undefined) {
      this.subscriptionId = msg.result;
      console.log(JSON.stringify({
        event: 'ws_subscribed',
        subscriptionId: this.subscriptionId,
      }));
      return;
    }

    // Log notification
    if (msg.method === 'logsNotification' && msg.params?.result?.value) {
      this.handleLogNotification(msg.params.result.value);
    }
  }

  private handleLogNotification(value: any): void {
    const { signature, err, logs } = value;

    // Skip failed transactions
    if (err) return;
    if (!logs || !Array.isArray(logs)) return;

    // Check if this is a Create instruction
    const hasCreate = logs.some((log: string) =>
      log.includes('Program log: Instruction: Create')
    );
    if (!hasCreate) return;

    console.log(JSON.stringify({
      event: 'ws_create_detected',
      signature,
    }));

    this.opts.onCreateSignature(signature);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    console.log(JSON.stringify({
      event: 'ws_reconnect_scheduled',
      delayMs: this.RECONNECT_DELAY_MS,
    }));

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.RECONNECT_DELAY_MS);
  }
}
