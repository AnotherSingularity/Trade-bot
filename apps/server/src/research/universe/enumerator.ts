import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  productMetadataObservations,
  universeProducts,
  universeSnapshots,
  type ProductMetadataObservationRow,
  type UniverseProductRow,
  type UniverseSnapshotRow,
} from '../../db/schema';

/**
 * Phase 2A §B — dynamic product enumeration.
 *
 * The enumerator consumes an abstract `ProductUniverseProvider` so
 * research is:
 *   - Testable with deterministic fixtures.
 *   - Replayable from captured metadata.
 *   - Extensible with a future production Coinbase provider.
 *
 * Every discovered product is persisted with the exact metadata the
 * provider returned, plus a deterministic `payloadHash` so identical
 * runs produce identical snapshots.
 */

export const UNIVERSE_ENUMERATOR_VERSION = 'p2a-universe-1';

export interface ProductMetadata {
  productId: string;
  baseCurrency: string;
  quoteCurrency: string;
  productType: 'SPOT' | 'PERP' | 'FUTURE' | 'UNKNOWN';
  tradingStatus: string;
  cancelOnly: boolean;
  limitOnly: boolean;
  postOnly: boolean;
  auctionMode: boolean;
  tradingDisabled: boolean;
  baseIncrement: string;
  quoteIncrement: string;
  baseMinimum: string;
  quoteMinimum?: string | null;
  baseMaximum?: string | null;
  quoteMaximum?: string | null;
  priceIncrement?: string | null;
  approximateVolume24h?: string | null;
  /** Provider's observation time. */
  metadataObservedAt: Date;
  /** Local receipt / availability time. */
  metadataAvailableAt: Date;
  sourceVersion: string;
  raw: unknown;
}

export interface ProductUniverseProvider {
  providerName: string;
  providerVersion: string;
  listAllProducts(): Promise<ProductMetadata[]>;
}

export interface EnumerateInput {
  provider: ProductUniverseProvider;
  now: Date;
  snapshotVersion?: string;
}

export interface EnumerateResult {
  snapshot: UniverseSnapshotRow;
  products: UniverseProductRow[];
  metadataObservations: ProductMetadataObservationRow[];
}

export async function enumerateUniverse(input: EnumerateInput): Promise<EnumerateResult> {
  const raw = await input.provider.listAllProducts();
  // Deterministic dedupe by productId, keep the latest metadataObservedAt.
  const byId = new Map<string, ProductMetadata>();
  for (const m of raw) {
    const prev = byId.get(m.productId);
    if (!prev || m.metadataObservedAt.getTime() >= prev.metadataObservedAt.getTime()) {
      byId.set(m.productId, m);
    }
  }
  const products = Array.from(byId.values()).sort((a, b) => a.productId.localeCompare(b.productId));
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify(
        products.map((p) => ({
          id: p.productId,
          base: p.baseCurrency,
          quote: p.quoteCurrency,
          type: p.productType,
          status: p.tradingStatus,
          bi: p.baseIncrement,
          qi: p.quoteIncrement,
          bm: p.baseMinimum,
          disabled: p.tradingDisabled,
        })),
      ),
    )
    .digest('hex');

  const [{ insertId: snapshotId }] = (await db.insert(universeSnapshots).values({
    snapshotVersion: input.snapshotVersion ?? UNIVERSE_ENUMERATOR_VERSION,
    providerName: input.provider.providerName,
    providerVersion: input.provider.providerVersion,
    observedAt: input.now,
    dataAvailableAt: input.now,
    productCount: products.length,
    payloadHash,
  })) as unknown as { insertId: number }[];

  const [snapshot] = await db
    .select()
    .from(universeSnapshots)
    .where(eq(universeSnapshots.id, snapshotId))
    .limit(1);

  const persistedProducts: UniverseProductRow[] = [];
  const observations: ProductMetadataObservationRow[] = [];
  for (const p of products) {
    // Universe products.
    const [{ insertId: upId }] = (await db.insert(universeProducts).values({
      snapshotId,
      productId: p.productId,
      baseCurrency: p.baseCurrency,
      quoteCurrency: p.quoteCurrency,
      productType: p.productType,
    })) as unknown as { insertId: number }[];
    const [row] = await db
      .select()
      .from(universeProducts)
      .where(eq(universeProducts.id, upId))
      .limit(1);
    persistedProducts.push(row!);

    // Metadata observation — deduped by payloadHash.
    const metaHash = createHash('sha256')
      .update(
        JSON.stringify({
          productId: p.productId,
          sv: p.sourceVersion,
          st: p.tradingStatus,
          co: p.cancelOnly, lo: p.limitOnly, po: p.postOnly, am: p.auctionMode, td: p.tradingDisabled,
          bi: p.baseIncrement, qi: p.quoteIncrement, bm: p.baseMinimum, qm: p.quoteMinimum,
          bx: p.baseMaximum, qx: p.quoteMaximum, pi: p.priceIncrement, av: p.approximateVolume24h,
          ts: p.metadataObservedAt.toISOString(),
        }),
      )
      .digest('hex');
    const existing = await db
      .select()
      .from(productMetadataObservations)
      .where(eq(productMetadataObservations.payloadHash, metaHash))
      .limit(1);
    if (existing.length > 0) {
      observations.push(existing[0]);
      continue;
    }
    const [{ insertId: metaId }] = (await db.insert(productMetadataObservations).values({
      productId: p.productId,
      sourceVersion: p.sourceVersion,
      providerName: input.provider.providerName,
      tradingStatus: p.tradingStatus,
      cancelOnly: p.cancelOnly,
      limitOnly: p.limitOnly,
      postOnly: p.postOnly,
      auctionMode: p.auctionMode,
      tradingDisabled: p.tradingDisabled,
      baseIncrement: p.baseIncrement,
      quoteIncrement: p.quoteIncrement,
      baseMinimum: p.baseMinimum,
      quoteMinimum: p.quoteMinimum ?? null,
      baseMaximum: p.baseMaximum ?? null,
      quoteMaximum: p.quoteMaximum ?? null,
      priceIncrement: p.priceIncrement ?? null,
      approximateVolume24h: p.approximateVolume24h ?? null,
      metadataObservedAt: p.metadataObservedAt,
      metadataAvailableAt: p.metadataAvailableAt,
      payloadHash: metaHash,
      rawPayload: JSON.stringify(p.raw),
    })) as unknown as { insertId: number }[];
    const [obs] = await db
      .select()
      .from(productMetadataObservations)
      .where(eq(productMetadataObservations.id, metaId))
      .limit(1);
    observations.push(obs!);
  }

  return { snapshot: snapshot!, products: persistedProducts, metadataObservations: observations };
}

// ---------------------------------------------------------------------------
// Test-only fixture provider
// ---------------------------------------------------------------------------
export class FixtureProductUniverseProvider implements ProductUniverseProvider {
  readonly providerName = 'FixtureProductUniverseProvider';
  readonly providerVersion = 'p2a-fixture-1';
  constructor(private readonly items: ProductMetadata[]) {}
  async listAllProducts(): Promise<ProductMetadata[]> {
    return [...this.items];
  }
}
