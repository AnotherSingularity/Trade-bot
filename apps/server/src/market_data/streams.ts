/**
 * Phase 1.2 §A/§B — abstract WebSocket provider.
 *
 * The `WebSocketProvider` interface lets the supervisor be exercised
 * against a deterministic mock in tests and against real Coinbase in
 * production. Tests instantiate `MockWebSocketProvider`; the runtime
 * uses `CoinbaseAdvancedTradeStreamProvider` (below) which wraps the
 * public Coinbase Advanced Trade endpoint
 *   `wss://advanced-trade-ws.coinbase.com`
 *
 * Only the market-data channels are used in this phase:
 *   heartbeats | status | ticker | candles | market_trades
 *
 * Level 2 is intentionally deferred to a later phase.
 */

export const COINBASE_WS_ENDPOINT = 'wss://advanced-trade-ws.coinbase.com';

export type StreamChannel = 'heartbeats' | 'status' | 'ticker' | 'candles' | 'market_trades';

export interface SubscribePayload {
  type: 'subscribe' | 'unsubscribe';
  channel: StreamChannel;
  product_ids?: string[];
}

export interface WebSocketFrame {
  raw: string;
}

export interface WebSocketProvider {
  /** Open the socket. Resolves when connected. */
  connect(endpoint: string, handlers: WebSocketHandlers): Promise<void>;
  /** Send a subscribe/unsubscribe message. */
  send(payload: SubscribePayload): Promise<void>;
  /** Close the socket cleanly. */
  close(reason: string): Promise<void>;
  /** True if currently connected. */
  isConnected(): boolean;
}

export interface WebSocketHandlers {
  onOpen(): void;
  onMessage(frame: WebSocketFrame): void;
  onError(err: Error): void;
  onClose(code: number, reason: string): void;
}

// ---------------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------------

export class MockWebSocketProvider implements WebSocketProvider {
  private handlers: WebSocketHandlers | null = null;
  private connected = false;
  private sent: SubscribePayload[] = [];

  async connect(_endpoint: string, handlers: WebSocketHandlers): Promise<void> {
    this.handlers = handlers;
    this.connected = true;
    handlers.onOpen();
  }
  async send(payload: SubscribePayload): Promise<void> {
    if (!this.connected) throw new Error('MockWebSocketProvider: not connected');
    this.sent.push(payload);
  }
  async close(reason: string): Promise<void> {
    this.connected = false;
    this.handlers?.onClose(1000, reason);
  }
  isConnected(): boolean {
    return this.connected;
  }
  // Test-only: inject a message frame as if the server sent it. The
  // handler runs synchronously to completion; callers use `await settle()`
  // to flush async work spawned by the handler (DB inserts, etc.).
  emit(frame: WebSocketFrame): void {
    if (!this.connected) throw new Error('MockWebSocketProvider: not connected');
    this.handlers!.onMessage(frame);
  }
  async emitAndSettle(frame: WebSocketFrame): Promise<void> {
    this.emit(frame);
    await this.settle();
  }
  emitError(err: Error): void {
    this.handlers?.onError(err);
  }
  serverClose(code: number, reason: string): void {
    this.connected = false;
    this.handlers?.onClose(code, reason);
  }
  async serverCloseAndSettle(code: number, reason: string): Promise<void> {
    this.serverClose(code, reason);
    await this.settle();
  }
  /** Flush pending microtasks so async supervisor handlers finish before the caller checks state. */
  async settle(): Promise<void> {
    // Drain the microtask queue a few times to catch chained awaits.
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  sentPayloads(): ReadonlyArray<SubscribePayload> {
    return this.sent;
  }
}
