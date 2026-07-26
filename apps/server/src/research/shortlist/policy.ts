import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { shortlistDecisions, type ShortlistDecisionRow } from '../../db/schema';
import type { FeatureResult } from '../features/contract';

/**
 * Phase 2A §I — Deterministic shortlist policy.
 *
 * Purpose: select the products for which Stage 2 features are worth
 * running. This is a CANDIDATE FILTER, not a trade signal. The
 * policy is:
 *
 *   1. Product must have Stage 1 hygiene = eligible.
 *   2. Product must have a MINIMUM VIABLE feature signature — enough
 *      valid Stage 1 features that a fingerprint could conceivably
 *      be composed.
 *   3. Score the product deterministically by combining:
 *        - inverse illiquidity (Amihud → higher = worse, so we invert),
 *        - quote-volume rank,
 *        - low data-quality penalty,
 *        - benchmark correlation stability (via btcCorrelation).
 *      Any feature returning a non-`valid` result contributes ZERO
 *      to that dimension — never a neutral fill.
 *   4. Rank ascending by score. Top-N shortlisted. Ties broken by
 *      product-id lexical order for determinism.
 *   5. Products that fail the minimum viability check are recorded
 *      with `shortlisted=false` and reason codes so research can
 *      always explain why a product is missing.
 *
 * All parameters — policyVersion, N, viability threshold — are
 * versioned so any change forces a new policy identifier in the
 * shortlist_decisions row.
 */

export const SHORTLIST_POLICY_VERSION = 'p2a-shortlist-1';

export interface ShortlistPolicyConfig {
  policyVersion: string;
  topN: number;
  minValidFeatures: number;
  requiredFeatureKeys: readonly string[];
}

export const DEFAULT_SHORTLIST_POLICY: ShortlistPolicyConfig = {
  policyVersion: SHORTLIST_POLICY_VERSION,
  topN: 20,
  minValidFeatures: 12,
  requiredFeatureKeys: [
    'ms.stdev_log_return',
    'liq.amihud',
    'liq.quote_volume_24h',
    'info.data_quality_penalty',
    'bench.btc_corr',
  ],
};

export interface CandidateFeatureBundle {
  productId: string;
  hygieneEligible: boolean;
  results: Map<string, FeatureResult>;
}

export interface ShortlistOutcome {
  productId: string;
  shortlisted: boolean;
  rank: number | null;
  score: number | null;
  reasonCodes: string[];
  policyVersion: string;
  inputHash: string;
}

interface RankedProduct {
  productId: string;
  score: number;
  reasonCodes: string[];
  inputHash: string;
}

export function evaluateShortlist(
  candidates: readonly CandidateFeatureBundle[],
  config: ShortlistPolicyConfig = DEFAULT_SHORTLIST_POLICY,
): ShortlistOutcome[] {
  const outcomes: ShortlistOutcome[] = [];
  const ranked: RankedProduct[] = [];

  for (const c of candidates) {
    const reasons: string[] = [];
    if (!c.hygieneEligible) {
      reasons.push('hygiene_not_eligible');
    }
    for (const k of config.requiredFeatureKeys) {
      const r = c.results.get(k);
      if (!r || r.status !== 'valid') {
        reasons.push(`missing_required:${k}`);
      }
    }
    const validCount = countValid(c.results);
    if (validCount < config.minValidFeatures) {
      reasons.push('below_min_valid_features');
    }
    const inputHash = hashCandidate(c, config);
    if (reasons.length > 0) {
      outcomes.push({
        productId: c.productId,
        shortlisted: false,
        rank: null,
        score: null,
        reasonCodes: reasons,
        policyVersion: config.policyVersion,
        inputHash,
      });
      continue;
    }
    const score = scoreCandidate(c);
    if (!Number.isFinite(score)) {
      outcomes.push({
        productId: c.productId,
        shortlisted: false,
        rank: null,
        score: null,
        reasonCodes: ['score_non_finite'],
        policyVersion: config.policyVersion,
        inputHash,
      });
      continue;
    }
    ranked.push({ productId: c.productId, score, reasonCodes: ['scored'], inputHash });
  }

  ranked.sort((a, b) =>
    a.score !== b.score ? a.score - b.score : a.productId.localeCompare(b.productId),
  );
  for (let i = 0; i < ranked.length; i += 1) {
    const r = ranked[i];
    const shortlisted = i < config.topN;
    outcomes.push({
      productId: r.productId,
      shortlisted,
      rank: shortlisted ? i + 1 : null,
      score: r.score,
      reasonCodes: shortlisted ? ['top_n'] : ['below_top_n'],
      policyVersion: config.policyVersion,
      inputHash: r.inputHash,
    });
  }
  outcomes.sort((a, b) => a.productId.localeCompare(b.productId));
  return outcomes;
}

function countValid(map: Map<string, FeatureResult>): number {
  let n = 0;
  for (const r of map.values()) if (r.status === 'valid') n += 1;
  return n;
}

/**
 * Lower score = better candidate. Each contributor is bounded so no
 * single feature dominates.
 */
function scoreCandidate(c: CandidateFeatureBundle): number {
  const amihud = pickValid(c, 'liq.amihud');
  const qvol = pickValid(c, 'liq.quote_volume_24h');
  const qual = pickValid(c, 'info.data_quality_penalty');
  const corr = pickValid(c, 'bench.btc_corr');

  const illiqPenalty = amihud != null ? Math.min(4, Math.log10(1 + amihud * 1e12)) : 4;
  const volumeBonus = qvol != null ? -Math.min(4, Math.log10(1 + qvol) / 2) : 0;
  const qualityPenalty = qual != null ? 4 * qual : 4;
  const corrPenalty = corr != null ? 2 * (1 - Math.abs(corr)) : 2;

  return illiqPenalty + volumeBonus + qualityPenalty + corrPenalty;
}

function pickValid(c: CandidateFeatureBundle, key: string): number | null {
  const r = c.results.get(key);
  if (!r || r.status !== 'valid' || r.value == null) return null;
  return typeof r.value === 'number' ? r.value : null;
}

function hashCandidate(c: CandidateFeatureBundle, config: ShortlistPolicyConfig): string {
  const parts: Array<[string, string | number | null]> = [];
  const keys = [...c.results.keys()].sort();
  for (const k of keys) {
    const r = c.results.get(k)!;
    parts.push([k, r.value != null && typeof r.value === 'number' ? r.value : null]);
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        productId: c.productId,
        parts,
        config: {
          policyVersion: config.policyVersion,
          topN: config.topN,
          minValid: config.minValidFeatures,
          required: [...config.requiredFeatureKeys].sort(),
        },
      }),
    )
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PersistShortlistInput {
  snapshotId: number;
  now: Date;
  outcomes: readonly ShortlistOutcome[];
}

export async function persistShortlist(input: PersistShortlistInput): Promise<ShortlistDecisionRow[]> {
  const rows: ShortlistDecisionRow[] = [];
  for (const o of input.outcomes) {
    await db.insert(shortlistDecisions).values({
      snapshotId: input.snapshotId,
      productId: o.productId,
      shortlisted: o.shortlisted,
      rank: o.rank,
      score: o.score != null ? o.score.toFixed(6) : null,
      reasonCodes: o.reasonCodes.length > 0 ? o.reasonCodes.join(',') : 'ok',
      policyVersion: o.policyVersion,
      inputHash: o.inputHash,
      decidedAt: input.now,
    });
    const [row] = await db
      .select()
      .from(shortlistDecisions)
      .where(
        and(
          eq(shortlistDecisions.snapshotId, input.snapshotId),
          eq(shortlistDecisions.productId, o.productId),
        ),
      )
      .limit(1);
    rows.push(row!);
  }
  return rows;
}
