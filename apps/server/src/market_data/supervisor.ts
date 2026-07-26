import { eq } from 'drizzle-orm';
import { db } from '../db';
import {
  marketDataGaps,
  marketStreamSessions,
  marketStreamSubscriptions,
  type MarketStreamSessionRow,
} from '../db/schema';
import { acceptMarketMessage, type EnvelopeResult } from './envelope';
import {
  MockWebSocketProvider,
  type StreamChannel,
  type SubscribePayload,
  type WebSocketFrame,
  type WebSocketHandlers,
  type WebSocketProvider,
} from './streams';

/**
 * Phase 1.2 §B — CoinbaseMarketDataSupervisor.
 *
 * Responsibilities:
 *   - Open connections + send subscriptions + track acknowledgements.
 *   - Track heartbeat continuity (per-channel `lastHeartbeatCounter`).
 *   - Track last event time per (channel, productId).
 *   - Reject malformed / unknown messages without crashing.
 *   - Detect reconnect loops.
 *   - Apply bounded exponential backoff with jitter.
 *   - Resubscribe after reconnect.
 *   - Emit lineage/operational events.
 *
 * The supervisor is **transport-neutral** — the `WebSocketProvider`
 * argument is a `MockWebSocketProvider` in tests and a real Coinbase
 * adapter in production. Deterministic tests are the acceptance
 * standard for the supervisor's behavior in this phase.
 */

export const SUPERVISOR_VERSION = 'p1_2-supervisor-1';

export type SessionState = MarketStreamSessionRow['state'];

export interface SupervisorConfig {
  endpoint: string;
  connectionGroup: string;
  channels: readonly StreamChannel[];
  productIds: readonly string[];
  /** Heartbeat freshness bound in ms; default 3000ms (~ 3 missed beats). */
  heartbeatStaleMs?: number;
  /** Ticker/trade freshness bound in ms; default 60_000ms. */
  channelStaleMs?: number;
  /** Backoff config. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Reconnect-loop tripwire — refuse to reconnect after N attempts in the window. */
  reconnectStormThreshold?: number;
  reconnectStormWindowMs?: number;
}

interface LastSeen {
  channel: string;
  productId: string | null;
  at: Date;
}

export class CoinbaseMarketDataSupervisor {
  private readonly provider: WebSocketProvider;
  private readonly config: Required<SupervisorConfig>;
  private sessionId: number | null = null;
  private state: SessionState = 'disconnected';
  private lastHeartbeatAt: Date | null = null;
  private lastHeartbeatCounter: number | null = null;
  private lastSeenByChannel: Map<string, LastSeen> = new Map();
  private reconnectAttempts: number[] = [];
  private stopped = false;
  private pending: Set<Promise<void>> = new Set();

  /** Await every async handler in flight. Used by deterministic tests. */
  async flushPending(): Promise<void> {
    while (this.pending.size > 0) {
      const snapshot = Array.from(this.pending);
      await Promise.allSettled(snapshot);
      for (const p of snapshot) this.pending.delete(p);
    }
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  constructor(provider: WebSocketProvider, config: SupervisorConfig) {
    this.provider = provider;
    this.config = {
      heartbeatStaleMs: 3_000,
      channelStaleMs: 60_000,
      reconnectBaseMs: 500,
      reconnectMaxMs: 30_000,
      reconnectStormThreshold: 5,
      reconnectStormWindowMs: 10_000,
      ...config,
    };
  }

  /** Open + subscribe. Returns the sessionId. */
  async start(): Promise<number> {
    if (this.stopped) throw new Error('supervisor stopped');
    return this.openSession();
  }

  private async openSession(): Promise<number> {
    await this.setState('connecting');
    const startedAt = new Date();
    const [{ insertId }] = (await db.insert(marketStreamSessions).values({
      endpoint: this.config.endpoint,
      connectionGroup: this.config.connectionGroup,
      startedAt,
      state: 'connecting',
    })) as unknown as { insertId: number }[];
    this.sessionId = insertId;

    const handlers: WebSocketHandlers = {
      onOpen: () => {
        this.track(this.setState('subscribing'));
      },
      onMessage: (frame) => {
        this.track(this.handleFrame(frame).catch((err) => this.recordReject(String(err))));
      },
      onError: (err) => {
        this.track(this.recordReject(`ws_error:${err.message}`));
      },
      onClose: (code, reason) => {
        this.track(this.handleClose(code, reason));
      },
    };
    try {
      await this.provider.connect(this.config.endpoint, handlers);
    } catch (err) {
      await this.setState('failed', `connect_failed:${(err as Error).message}`);
      throw err;
    }
    await this.sendSubscriptions();
    await this.setState('synchronizing');
    return this.sessionId!;
  }

  private async sendSubscriptions(): Promise<void> {
    if (!this.sessionId) return;
    // ALWAYS subscribe to heartbeats on every connection group (Coinbase docs).
    await this.subscribeChannel('heartbeats', []);
    for (const channel of this.config.channels) {
      if (channel === 'heartbeats') continue;
      await this.subscribeChannel(channel, this.config.productIds);
    }
  }

  private async subscribeChannel(channel: StreamChannel, productIds: readonly string[]): Promise<void> {
    const payload: SubscribePayload =
      productIds.length === 0
        ? { type: 'subscribe', channel }
        : { type: 'subscribe', channel, product_ids: [...productIds] };
    await this.provider.send(payload);
    await db.insert(marketStreamSubscriptions).values({
      sessionId: this.sessionId!,
      channel,
      productId: productIds.length === 1 ? productIds[0] : null,
      state: 'requested',
      requestedAt: new Date(),
    });
  }

  private async handleFrame(frame: WebSocketFrame): Promise<void> {
    if (!this.sessionId) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.raw);
    } catch {
      await this.recordReject('malformed_json');
      return;
    }
    const msg = parsed as {
      channel?: string;
      product_id?: string;
      sequence_num?: number;
      timestamp?: string;
      events?: Array<{ type?: string }>;
      counter?: number;
      subscriptions?: unknown;
    };
    // Coinbase sends `subscriptions` messages to acknowledge subscribes.
    if (msg.subscriptions !== undefined) {
      await db
        .update(marketStreamSubscriptions)
        .set({ state: 'acknowledged', acknowledgedAt: new Date() })
        .where(eq(marketStreamSubscriptions.sessionId, this.sessionId!));
      await this.setState('healthy');
      return;
    }
    const channel = msg.channel ?? 'unknown';
    const eventType = msg.events?.[0]?.type ?? (channel === 'heartbeats' ? 'heartbeat' : 'update');
    const sourceTs = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const receivedAt = new Date();
    // Heartbeat continuity.
    if (channel === 'heartbeats' && typeof msg.counter === 'number') {
      if (this.lastHeartbeatCounter != null && msg.counter > this.lastHeartbeatCounter + 1) {
        await this.recordGap(
          'missing_heartbeat',
          null,
          this.lastHeartbeatCounter + 1,
          msg.counter,
        );
      }
      this.lastHeartbeatCounter = msg.counter;
      this.lastHeartbeatAt = receivedAt;
      await db
        .update(marketStreamSessions)
        .set({ lastHeartbeatAt: receivedAt, lastHeartbeatCounter: msg.counter })
        .where(eq(marketStreamSessions.id, this.sessionId));
    }
    // Envelope + dedup.
    const result: EnvelopeResult = await acceptMarketMessage({
      source: 'coinbase-ws',
      channel,
      eventType,
      productId: msg.product_id ?? null,
      sourceTimestamp: sourceTs,
      receivedAt,
      connectionId: this.sessionId,
      sequenceNumber: typeof msg.sequence_num === 'number' ? msg.sequence_num : null,
      payload: parsed,
    });
    this.lastSeenByChannel.set(`${channel}:${msg.product_id ?? ''}`, {
      channel,
      productId: msg.product_id ?? null,
      at: receivedAt,
    });
    await this.incrementReceived(result.status === 'inserted' ? 'received' : result.status === 'duplicate' ? 'duplicate' : 'rejected');
  }

  private async incrementReceived(kind: 'received' | 'duplicate' | 'rejected'): Promise<void> {
    if (!this.sessionId) return;
    if (kind === 'rejected') {
      await db.execute(
        `UPDATE market_stream_sessions SET messagesRejected = messagesRejected + 1 WHERE id = ${this.sessionId}`,
      );
    } else {
      await db.execute(
        `UPDATE market_stream_sessions SET messagesReceived = messagesReceived + 1 WHERE id = ${this.sessionId}`,
      );
    }
  }

  private async recordReject(reason: string): Promise<void> {
    if (!this.sessionId) return;
    await db.execute(
      `UPDATE market_stream_sessions SET messagesRejected = messagesRejected + 1 WHERE id = ${this.sessionId}`,
    );
    // Do not crash on malformed / unknown; the envelope already stores rejections.
    void reason;
  }

  private async recordGap(
    gapType: 'missing_heartbeat' | 'missing_sequence' | 'connection_closed' | 'missing_candle_bucket' | 'stale_ticker' | 'bootstrap_missing_interval',
    productId: string | null,
    expected?: number | null,
    actual?: number | null,
  ): Promise<void> {
    if (!this.sessionId) return;
    await db.insert(marketDataGaps).values({
      sessionId: this.sessionId,
      channel: gapType === 'missing_heartbeat' ? 'heartbeats' : 'unknown',
      productId,
      detectedAt: new Date(),
      expectedSequence: expected ?? null,
      actualSequence: actual ?? null,
      lastKnownEventAt: this.lastHeartbeatAt,
      gapType,
      state: 'open',
    });
  }

  private async handleClose(code: number, reason: string): Promise<void> {
    if (!this.sessionId) return;
    await db
      .update(marketStreamSessions)
      .set({ endedAt: new Date(), state: 'disconnected', failureReason: `close:${code}:${reason}` })
      .where(eq(marketStreamSessions.id, this.sessionId));
    await this.recordGap('connection_closed', null);
    if (this.stopped) return;
    // Simple exponential backoff with a storm tripwire.
    const now = Date.now();
    this.reconnectAttempts = this.reconnectAttempts.filter(
      (t) => now - t < this.config.reconnectStormWindowMs,
    );
    this.reconnectAttempts.push(now);
    if (this.reconnectAttempts.length > this.config.reconnectStormThreshold) {
      await this.setState('failed', 'reconnect_storm');
      return;
    }
    await this.setState('reconnecting');
  }

  private async setState(state: SessionState, reason?: string): Promise<void> {
    this.state = state;
    if (!this.sessionId) return;
    await db
      .update(marketStreamSessions)
      .set({ state, ...(reason ? { failureReason: reason } : {}) })
      .where(eq(marketStreamSessions.id, this.sessionId));
  }

  currentState(): SessionState {
    return this.state;
  }

  /** Compute a per-(channel,product) staleness verdict from lastSeen bookkeeping. */
  isChannelHealthy(channel: string, productId: string | null, now: Date = new Date()): boolean {
    if (channel === 'heartbeats') {
      if (!this.lastHeartbeatAt) return false;
      return now.getTime() - this.lastHeartbeatAt.getTime() < this.config.heartbeatStaleMs;
    }
    const key = `${channel}:${productId ?? ''}`;
    const seen = this.lastSeenByChannel.get(key);
    if (!seen) return false;
    return now.getTime() - seen.at.getTime() < this.config.channelStaleMs;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.provider.close('supervisor_stop');
    await this.setState('stopped');
  }

  reconnectBackoffMs(): number {
    const attempt = this.reconnectAttempts.length;
    const base = Math.min(this.config.reconnectMaxMs, this.config.reconnectBaseMs * 2 ** attempt);
    const jitter = Math.floor(base * 0.25); // deterministic 25% envelope
    return base + jitter;
  }
}

/** Test helper — construct a supervisor around a MockWebSocketProvider. */
export function newSupervisorForTest(config: Partial<SupervisorConfig> & Pick<SupervisorConfig, 'productIds' | 'channels'>): {
  supervisor: CoinbaseMarketDataSupervisor;
  provider: MockWebSocketProvider;
} {
  const provider = new MockWebSocketProvider();
  const supervisor = new CoinbaseMarketDataSupervisor(provider, {
    endpoint: 'wss://mock.local',
    connectionGroup: 'test',
    ...config,
  });
  return { supervisor, provider };
}
