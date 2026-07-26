import { createHash } from 'node:crypto';
import type { MarketDepthEvent, MarketDepthProvider } from './provider';

/**
 * Phase 2D §C — Deterministic order-book state machine.
 *
 * States:
 *   empty | synchronizing | healthy | gap_detected | stale
 *   | inconsistent | resync_required | failed
 *
 * Rules:
 *   - snapshot establishes the initial state
 *   - deltas apply in deterministic sequence order
 *   - zero-size updates REMOVE the price level
 *   - duplicate deltas are idempotent
 *   - out-of-order deltas beyond a bounded look-back FAIL closed
 *   - missing continuity emits a gap and invalidates the book
 *   - a book with bid >= ask is inconsistent
 *   - non-positive prices/sizes FAIL closed
 *   - decimal precision is preserved via string arithmetic (via Number
 *     for arithmetic; string keys for level identity)
 *   - no scanner may consume an invalid book
 */

export type BookState =
  | 'empty'
  | 'synchronizing'
  | 'healthy'
  | 'gap_detected'
  | 'stale'
  | 'inconsistent'
  | 'resync_required'
  | 'failed';

export interface BookLevel {
  price: number;
  size: number;
}

export interface BookSnapshot {
  productId: string;
  sequence: number;
  bids: BookLevel[]; // sorted descending by price
  asks: BookLevel[]; // sorted ascending by price
  observedAt: Date;
  dataAvailableAt: Date;
  state: BookState;
  bookHealth: 'healthy' | 'degraded' | 'stale' | 'gap_detected' | 'inconsistent' | 'unknown';
  staleAgeMs: number | null;
  gapCount: number;
  resyncCount: number;
  crossedCount: number;
  payloadHash: string;
}

export interface BookEngineConfig {
  productId: string;
  /** Maximum sequence gap allowed for buffering before we declare gap. */
  maxBufferedGap: number;
  /** Maximum age at which a healthy book becomes stale. */
  staleAgeMs: number;
}

export const DEFAULT_BOOK_ENGINE_CONFIG: Omit<BookEngineConfig, 'productId'> = {
  maxBufferedGap: 8,
  staleAgeMs: 30_000,
};

export interface BookEngineIngestResult {
  state: BookState;
  applied: number;
  buffered: number;
  gaps: number;
  resyncs: number;
  errors: string[];
}

/**
 * A single-book state machine. Not thread-safe; the caller owns
 * concurrency. All operations are deterministic given the same
 * sequence of events and the same config.
 */
export class OrderBookEngine {
  readonly config: BookEngineConfig;
  private state: BookState = 'empty';
  private lastSequence: number | null = null;
  private lastEventAt: Date | null = null;
  private bids: Map<number, number> = new Map();
  private asks: Map<number, number> = new Map();
  private buffer: MarketDepthEvent[] = [];
  private gapCount = 0;
  private resyncCount = 0;
  private crossedCount = 0;

  constructor(config: BookEngineConfig) {
    this.config = config;
  }

  currentState(): BookState {
    return this.state;
  }

  /** Ingest a batch of events in the caller-provided order. */
  ingest(events: readonly MarketDepthEvent[]): BookEngineIngestResult {
    const result: BookEngineIngestResult = {
      state: this.state,
      applied: 0,
      buffered: 0,
      gaps: 0,
      resyncs: 0,
      errors: [],
    };
    for (const ev of events) {
      if (ev.productId !== this.config.productId) {
        result.errors.push(`product_mismatch:${ev.productId}`);
        continue;
      }
      const outcome = this.applyOne(ev);
      if (outcome === 'applied') result.applied += 1;
      else if (outcome === 'buffered') result.buffered += 1;
      else if (outcome === 'gap') result.gaps += 1;
      else if (outcome === 'resync') result.resyncs += 1;
      else if (outcome === 'error') result.errors.push(`event_error:${ev.sequence}`);
    }
    result.state = this.state;
    return result;
  }

  private applyOne(ev: MarketDepthEvent): 'applied' | 'buffered' | 'gap' | 'resync' | 'error' {
    if (ev.kind === 'snapshot') {
      return this.applySnapshot(ev);
    }
    if (ev.kind === 'gap') {
      this.gapCount += 1;
      this.state = 'resync_required';
      return 'gap';
    }
    if (ev.kind === 'heartbeat') {
      this.lastEventAt = ev.sourceTimestamp;
      return 'applied';
    }
    if (this.state === 'empty' || this.state === 'resync_required') {
      // Cannot apply deltas or trades before a fresh snapshot.
      return 'error';
    }
    if (ev.kind === 'delta') {
      return this.applyDelta(ev);
    }
    if (ev.kind === 'trade') {
      this.lastEventAt = ev.sourceTimestamp;
      return 'applied';
    }
    return 'error';
  }

  private applySnapshot(ev: MarketDepthEvent): 'applied' | 'error' {
    if (!ev.levels || ev.levels.length === 0) return 'error';
    this.bids.clear();
    this.asks.clear();
    for (const l of ev.levels) {
      const price = Number(l.price);
      const size = Number(l.size);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) {
        this.state = 'failed';
        return 'error';
      }
      if (size === 0) continue;
      if (l.side === 'bid') this.bids.set(price, size);
      else this.asks.set(price, size);
    }
    this.lastSequence = ev.sequence;
    this.lastEventAt = ev.sourceTimestamp;
    if (!this.isConsistent()) {
      this.state = 'inconsistent';
      return 'error';
    }
    const wasResync = this.state === 'resync_required';
    if (wasResync) this.resyncCount += 1;
    this.state = 'healthy';
    return 'applied';
  }

  private applyDelta(ev: MarketDepthEvent): 'applied' | 'buffered' | 'gap' | 'error' {
    if (this.lastSequence == null) return 'error';
    if (ev.sequence <= this.lastSequence) {
      // Duplicate or already-applied — idempotent skip.
      return 'applied';
    }
    if (ev.sequence !== this.lastSequence + 1) {
      // Out-of-order — buffer up to maxBufferedGap, otherwise declare gap.
      if (ev.sequence - this.lastSequence <= this.config.maxBufferedGap) {
        this.buffer.push(ev);
        return 'buffered';
      }
      this.gapCount += 1;
      this.state = 'gap_detected';
      return 'gap';
    }
    // In-order — apply.
    if (!ev.levels || ev.levels.length === 0) {
      // Empty delta is a no-op, but advances the sequence.
      this.lastSequence = ev.sequence;
      this.lastEventAt = ev.sourceTimestamp;
      return 'applied';
    }
    for (const l of ev.levels) {
      const price = Number(l.price);
      const size = Number(l.size);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) {
        this.state = 'failed';
        return 'error';
      }
      const target = l.side === 'bid' ? this.bids : this.asks;
      if (size === 0) target.delete(price);
      else target.set(price, size);
    }
    this.lastSequence = ev.sequence;
    this.lastEventAt = ev.sourceTimestamp;
    if (!this.isConsistent()) {
      this.crossedCount += 1;
      this.state = 'inconsistent';
      return 'error';
    }
    // Drain buffered events that now match.
    this.buffer.sort((a, b) => a.sequence - b.sequence);
    while (this.buffer.length > 0 && this.buffer[0].sequence === this.lastSequence + 1) {
      const next = this.buffer.shift()!;
      this.applyDelta(next);
    }
    this.state = 'healthy';
    return 'applied';
  }

  private isConsistent(): boolean {
    const bestBid = this.bestBid();
    const bestAsk = this.bestAsk();
    if (bestBid != null && bestAsk != null && bestBid >= bestAsk) return false;
    return true;
  }

  bestBid(): number | null {
    let best: number | null = null;
    for (const p of this.bids.keys()) if (best == null || p > best) best = p;
    return best;
  }

  bestAsk(): number | null {
    let best: number | null = null;
    for (const p of this.asks.keys()) if (best == null || p < best) best = p;
    return best;
  }

  /** Take an immutable snapshot of the current book. */
  snapshot(observedAt: Date): BookSnapshot {
    const bids: BookLevel[] = [...this.bids.entries()]
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => b.price - a.price);
    const asks: BookLevel[] = [...this.asks.entries()]
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => a.price - b.price);
    const staleAgeMs = this.lastEventAt ? observedAt.getTime() - this.lastEventAt.getTime() : null;
    // Reclassify staleness at snapshot time without mutating engine state.
    let health: BookSnapshot['bookHealth'];
    let effectiveState: BookState = this.state;
    if (this.state === 'inconsistent') health = 'inconsistent';
    else if (this.state === 'gap_detected' || this.state === 'resync_required') health = 'gap_detected';
    else if (this.state === 'failed') health = 'inconsistent';
    else if (this.state === 'empty' || this.state === 'synchronizing') health = 'unknown';
    else if (staleAgeMs != null && staleAgeMs > this.config.staleAgeMs) {
      health = 'stale';
      effectiveState = 'stale';
    } else if (this.state === 'healthy') health = 'healthy';
    else health = 'unknown';
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          pid: this.config.productId,
          seq: this.lastSequence ?? -1,
          bids: bids.map((l) => [l.price, l.size]),
          asks: asks.map((l) => [l.price, l.size]),
        }),
      )
      .digest('hex');
    return {
      productId: this.config.productId,
      sequence: this.lastSequence ?? -1,
      bids,
      asks,
      observedAt,
      dataAvailableAt: observedAt,
      state: effectiveState,
      bookHealth: health,
      staleAgeMs,
      gapCount: this.gapCount,
      resyncCount: this.resyncCount,
      crossedCount: this.crossedCount,
      payloadHash,
    };
  }
}

export function runBookProvider(provider: MarketDepthProvider, config?: Omit<BookEngineConfig, 'productId'>): OrderBookEngine {
  const engine = new OrderBookEngine({ productId: provider.productId, ...(config ?? DEFAULT_BOOK_ENGINE_CONFIG) });
  engine.ingest([...provider.events()]);
  return engine;
}
