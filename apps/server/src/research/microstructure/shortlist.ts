import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  microstructureShortlistMemberships,
  microstructureShortlistPolicies,
  microstructureShortlistRuns,
  type MicrostructureShortlistMembershipRow,
  type MicrostructureShortlistPolicyRow,
  type MicrostructureShortlistRunRow,
} from '../../db/schema';

/**
 * Phase 2D §A — Top-N microstructure observation policy.
 *
 * The observer only reconstructs order books for a BOUNDED set of
 * products so the compute budget is finite. Selection is versioned
 * research prioritization — never a trade signal.
 */

export const MS_SHORTLIST_POLICY_KEY = 'ms.shortlist_observer';
export const MS_SHORTLIST_POLICY_VERSION = 'p2d-shortlist-1';
export const MS_SHORTLIST_MAX_PRODUCTS = 32;

export interface MsShortlistPolicyDef {
  policyKey: string;
  policyVersion: string;
  description: string;
  maxProducts: number;
  selectionCriteria: string;
  status: 'draft' | 'observer' | 'deprecated' | 'disabled';
}

export const DEFAULT_MS_SHORTLIST_POLICY: MsShortlistPolicyDef = {
  policyKey: MS_SHORTLIST_POLICY_KEY,
  policyVersion: MS_SHORTLIST_POLICY_VERSION,
  description:
    'Phase 2D observer shortlist. Prefers products that are hygiene-eligible, have complete Phase 2A features, valid fingerprints, valid Phase 2B regimes, healthy RiskEngine state, and approximate liquidity above the minimum. Bounded to 32 products per run.',
  maxProducts: MS_SHORTLIST_MAX_PRODUCTS,
  selectionCriteria:
    'score = hygieneEligible*1 + fingerprintValid*1 + regimeValid*1 + riskHealthy*1 + log10(quoteVolume24h)/10 - dataQualityPenalty; ties broken lexically by productId',
  status: 'observer',
};

export interface MsCandidateEvidence {
  productId: string;
  hygieneEligible: boolean;
  fingerprintValid: boolean;
  regimeValid: boolean;
  riskHealthy: boolean;
  quoteVolume24h: number | null;
  dataQualityPenalty: number | null;
  dataAvailableAt: Date;
}

export interface MsShortlistOutcome {
  productId: string;
  selected: boolean;
  rank: number | null;
  selectionScore: number;
  reasonCodes: string[];
  policyVersion: string;
  inputHash: string;
  observedAt: Date;
  dataAvailableAt: Date;
}

function score(c: MsCandidateEvidence): number {
  let s = 0;
  if (c.hygieneEligible) s += 1;
  if (c.fingerprintValid) s += 1;
  if (c.regimeValid) s += 1;
  if (c.riskHealthy) s += 1;
  if (c.quoteVolume24h != null && c.quoteVolume24h > 0) s += Math.log10(c.quoteVolume24h) / 10;
  if (c.dataQualityPenalty != null) s -= c.dataQualityPenalty;
  return s;
}

function hashEvidence(c: MsCandidateEvidence, policyVersion: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: policyVersion,
        pid: c.productId,
        h: c.hygieneEligible,
        f: c.fingerprintValid,
        r: c.regimeValid,
        rh: c.riskHealthy,
        qv: c.quoteVolume24h,
        dq: c.dataQualityPenalty,
        at: c.dataAvailableAt.toISOString(),
      }),
    )
    .digest('hex');
}

export function evaluateMsShortlist(
  candidates: readonly MsCandidateEvidence[],
  observedAt: Date,
  policy: MsShortlistPolicyDef = DEFAULT_MS_SHORTLIST_POLICY,
): MsShortlistOutcome[] {
  const scored = candidates.map((c) => {
    const s = score(c);
    const reasons: string[] = [];
    if (!c.hygieneEligible) reasons.push('hygiene_ineligible');
    if (!c.fingerprintValid) reasons.push('fingerprint_invalid');
    if (!c.regimeValid) reasons.push('regime_invalid');
    if (!c.riskHealthy) reasons.push('risk_not_healthy');
    if (c.quoteVolume24h == null) reasons.push('missing_quote_volume');
    if (c.dataQualityPenalty != null && c.dataQualityPenalty > 0.3) reasons.push('quality_penalty_high');
    return {
      c,
      s,
      reasons,
      inputHash: hashEvidence(c, policy.policyVersion),
    };
  });
  scored.sort((a, b) => (b.s !== a.s ? b.s - a.s : a.c.productId.localeCompare(b.c.productId)));
  const out: MsShortlistOutcome[] = [];
  for (let i = 0; i < scored.length; i += 1) {
    const row = scored[i];
    const selected = i < policy.maxProducts && row.reasons.length === 0;
    out.push({
      productId: row.c.productId,
      selected,
      rank: selected ? i + 1 : null,
      selectionScore: row.s,
      reasonCodes: selected ? ['top_n'] : row.reasons.length > 0 ? row.reasons : ['below_top_n'],
      policyVersion: policy.policyVersion,
      inputHash: row.inputHash,
      observedAt,
      dataAvailableAt: row.c.dataAvailableAt,
    });
  }
  // Return sorted by productId for stable persistence order.
  return out.sort((a, b) => a.productId.localeCompare(b.productId));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function registerMsShortlistPolicy(
  def: MsShortlistPolicyDef = DEFAULT_MS_SHORTLIST_POLICY,
): Promise<MicrostructureShortlistPolicyRow> {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        key: def.policyKey,
        v: def.policyVersion,
        max: def.maxProducts,
        crit: def.selectionCriteria,
      }),
    )
    .digest('hex');
  const existing = await db
    .select()
    .from(microstructureShortlistPolicies)
    .where(
      and(
        eq(microstructureShortlistPolicies.policyKey, def.policyKey),
        eq(microstructureShortlistPolicies.policyVersion, def.policyVersion),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].implementationHash !== hash) {
      throw new Error(
        `ms shortlist policy ${def.policyKey}@${def.policyVersion} implementationHash mismatch — bump policyVersion`,
      );
    }
    return existing[0];
  }
  await db.insert(microstructureShortlistPolicies).values({
    policyKey: def.policyKey,
    policyVersion: def.policyVersion,
    description: def.description,
    maxProducts: def.maxProducts,
    selectionCriteria: def.selectionCriteria,
    implementationHash: hash,
    status: def.status,
  });
  const [row] = await db
    .select()
    .from(microstructureShortlistPolicies)
    .where(
      and(
        eq(microstructureShortlistPolicies.policyKey, def.policyKey),
        eq(microstructureShortlistPolicies.policyVersion, def.policyVersion),
      ),
    )
    .limit(1);
  return row;
}

export async function startMsShortlistRun(
  policyVersionId: number,
  startedAt: Date,
): Promise<MicrostructureShortlistRunRow> {
  const [{ insertId }] = (await db.insert(microstructureShortlistRuns).values({
    policyVersionId,
    startedAt,
  })) as unknown as { insertId: number }[];
  const [row] = await db.select().from(microstructureShortlistRuns).where(eq(microstructureShortlistRuns.id, insertId)).limit(1);
  return row;
}

export async function persistMsShortlist(
  runId: number,
  outcomes: readonly MsShortlistOutcome[],
): Promise<MicrostructureShortlistMembershipRow[]> {
  const rows: MicrostructureShortlistMembershipRow[] = [];
  for (const o of outcomes) {
    await db.insert(microstructureShortlistMemberships).values({
      runId,
      productId: o.productId,
      selected: o.selected,
      rank: o.rank,
      selectionScore: o.selectionScore.toFixed(10),
      reasonCodes: o.reasonCodes.join(','),
      policyVersion: o.policyVersion,
      inputHash: o.inputHash,
      observedAt: o.observedAt,
      dataAvailableAt: o.dataAvailableAt,
    });
    const [row] = await db
      .select()
      .from(microstructureShortlistMemberships)
      .where(and(eq(microstructureShortlistMemberships.runId, runId), eq(microstructureShortlistMemberships.productId, o.productId)))
      .limit(1);
    rows.push(row);
  }
  await db
    .update(microstructureShortlistRuns)
    .set({
      completedAt: new Date(),
      productsConsidered: outcomes.length,
      productsSelected: outcomes.filter((o) => o.selected).length,
    })
    .where(eq(microstructureShortlistRuns.id, runId));
  return rows;
}
