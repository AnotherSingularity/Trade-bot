import type {
  StreamChannel,
  SubscribePayload,
  WebSocketFrame,
  WebSocketHandlers,
  WebSocketProvider,
} from './streams';

/**
 * Phase 1.2-OPS §A — real Coinbase Advanced Trade WebSocket adapter.
 *
 * Wraps the Node 22 native `WebSocket` global (no third-party ws
 * dependency). Only public market-data channels are used
 *   (heartbeats | status | ticker | candles | market_trades)
 * — Level 2 is intentionally deferred to a later phase.
 *
 * The fetch barrier (Gate 3D §J) does not intercept WebSocket
 * frames; the barrier's guarantee is scoped to `POST
 * /api/v3/brokerage/orders`. This module opens exactly the market-data
 * WebSocket and nothing else.
 */

export const COINBASE_ADAPTER_VERSION = 'p1_2-ops-coinbase-ws-1';

export class CoinbaseAdvancedTradeStreamProvider implements WebSocketProvider {
  private ws: WebSocket | null = null;
  private connected = false;

  async connect(endpoint: string, handlers: WebSocketHandlers): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wsCtor = (globalThis as any).WebSocket as new (url: string) => WebSocket;
        if (!wsCtor) {
          reject(new Error('CoinbaseAdvancedTradeStreamProvider: WebSocket not available'));
          return;
        }
        this.ws = new wsCtor(endpoint);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws.addEventListener('open', () => {
        this.connected = true;
        opened = true;
        handlers.onOpen();
        resolve();
      });
      this.ws.addEventListener('message', (ev: MessageEvent) => {
        const raw = typeof ev.data === 'string' ? ev.data : ev.data?.toString?.() ?? '';
        handlers.onMessage({ raw } as WebSocketFrame);
      });
      this.ws.addEventListener('error', (ev: Event) => {
        const message = (ev as unknown as { message?: string }).message ?? 'websocket_error';
        handlers.onError(new Error(message));
        if (!opened) reject(new Error(message));
      });
      this.ws.addEventListener('close', (ev: Event) => {
        this.connected = false;
        const closeEv = ev as unknown as { code?: number; reason?: string };
        handlers.onClose(closeEv.code ?? 1000, closeEv.reason ?? '');
      });
    });
  }

  async send(payload: SubscribePayload): Promise<void> {
    if (!this.ws || !this.connected) {
      throw new Error('CoinbaseAdvancedTradeStreamProvider: not connected');
    }
    this.ws.send(JSON.stringify(payload));
  }

  async close(reason: string): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close(1000, reason);
      } catch {
        // ignore — connection may already be closed
      }
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/** Reference names for the audit trail — do not construct here. */
export const COINBASE_MARKET_DATA_CHANNELS: readonly StreamChannel[] = [
  'heartbeats',
  'status',
  'ticker',
  'candles',
  'market_trades',
];
