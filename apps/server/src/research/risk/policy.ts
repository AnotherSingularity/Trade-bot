import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  riskLimitDefinitions,
  riskPolicyVersions,
  type RiskLimitDefinitionRow,
  type RiskPolicyVersionRow,
} from '../../db/schema';

/**
 * Phase 2C §B, §C — Versioned risk-policy registry.
 *
 * A single policy carries N limit definitions. Bumping any limit
 * threshold, formula, breach action, or missing-data action REQUIRES
 * a new policy version — enforced by an implementationHash mismatch
 * and by the unique `(policyKey, policyVersion)` index.
 *
 * Phase 2C policies remain `observer`. Approval to `approved_for_shadow_enforcement`
 * is a Phase 2D (or later) governance decision.
 */

export const RISK_POLICY_KEY = 'risk.portfolio_observer';
export const RISK_POLICY_VERSION = 'p2c-risk-1';

export type LimitScope =
  | 'candidate'
  | 'product'
  | 'strategy_mode'
  | 'correlation_cluster'
  | 'benchmark_beta'
  | 'portfolio'
  | 'daily'
  | 'weekly'
  | 'drawdown'
  | 'liquidity'
  | 'system_integrity';

export type BreachAction = 'observe' | 'reduce' | 'reject' | 'block_all_new_entries' | 'require_reconciliation';
export type MissingDataAction = 'abstain' | 'reject' | 'block_all_new_entries';
export type LimitOperator = 'lte' | 'lt' | 'gte' | 'gt' | 'eq';

export interface RiskLimitDefinition {
  limitKey: string;
  scope: LimitScope;
  measurementKey: string;
  operator: LimitOperator;
  warningThreshold: number | null;
  hardThreshold: number;
  unit: string;
  aggregationMethod: string;
  lookbackWindow: number | null;
  minimumSampleCount: number | null;
  breachAction: BreachAction;
  missingDataAction: MissingDataAction;
  priority: number;
}

export interface RiskPolicy {
  policyKey: string;
  policyVersion: string;
  description: string;
  operatingScope: string;
  status: 'draft' | 'observer' | 'validated_for_research' | 'approved_for_shadow_enforcement' | 'deprecated' | 'disabled';
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  limits: readonly RiskLimitDefinition[];
}

/**
 * The default observer policy. Every threshold here is intentionally
 * conservative and versioned. Bumping any value MUST bump policyVersion.
 */
export const DEFAULT_RISK_POLICY: RiskPolicy = {
  policyKey: RISK_POLICY_KEY,
  policyVersion: RISK_POLICY_VERSION,
  description:
    'Phase 2C observer risk policy. Conservative caps on candidate stop risk, cash reservation, product/mode/cluster concentration, beta exposure, volatility target, liquidity, drawdown, and daily/weekly losses. Enforcement disabled.',
  operatingScope: 'observer',
  status: 'observer',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  limits: [
    {
      limitKey: 'candidate.stop_loss_quote_pct_of_equity',
      scope: 'candidate',
      measurementKey: 'candidate.total_modeled_stop_loss',
      operator: 'lte',
      warningThreshold: 0.005,
      hardThreshold: 0.01,
      unit: 'ratio_of_equity',
      aggregationMethod: 'candidate_absolute',
      lookbackWindow: null,
      minimumSampleCount: null,
      breachAction: 'reduce',
      missingDataAction: 'abstain',
      priority: 100,
    },
    {
      limitKey: 'cash.reserve_remaining_min',
      scope: 'portfolio',
      measurementKey: 'portfolio.cash_reserve_remaining',
      operator: 'gte',
      warningThreshold: 0.05,
      hardThreshold: 0.02,
      unit: 'ratio_of_equity',
      aggregationMethod: 'portfolio_min',
      lookbackWindow: null,
      minimumSampleCount: null,
      breachAction: 'reject',
      missingDataAction: 'reject',
      priority: 50,
    },
    {
      limitKey: 'product.max_quote_exposure_pct',
      scope: 'product',
      measurementKey: 'product.quote_exposure',
      operator: 'lte',
      warningThreshold: 0.1,
      hardThreshold: 0.15,
      unit: 'ratio_of_equity',
      aggregationMethod: 'per_product',
      lookbackWindow: null,
      minimumSampleCount: null,
      breachAction: 'reduce',
      missingDataAction: 'abstain',
      priority: 90,
    },
    {
      limitKey: 'mode.max_quote_exposure_pct',
      scope: 'strategy_mode',
      measurementKey: 'mode.quote_exposure',
      operator: 'lte',
      warningThreshold: 0.4,
      hardThreshold: 0.5,
      unit: 'ratio_of_equity',
      aggregationMethod: 'per_mode',
      lookbackWindow: null,
      minimumSampleCount: null,
      breachAction: 'reduce',
      missingDataAction: 'abstain',
      priority: 85,
    },
    {
      limitKey: 'cluster.max_quote_exposure_pct',
      scope: 'correlation_cluster',
      measurementKey: 'cluster.quote_exposure',
      operator: 'lte',
      warningThreshold: 0.25,
      hardThreshold: 0.35,
      unit: 'ratio_of_equity',
      aggregationMethod: 'per_cluster',
      lookbackWindow: null,
      minimumSampleCount: null,
      breachAction: 'reduce',
      missingDataAction: 'abstain',
      priority: 80,
    },
    {
      limitKey: 'beta.btc_abs_max',
      scope: 'benchmark_beta',
      measurementKey: 'beta.btc_weighted_exposure_abs',
      operator: 'lte',
      warningThreshold: 0.5,
      hardThreshold: 0.8,
      unit: 'ratio_of_equity',
      aggregationMethod: 'portfolio_absolute',
      lookbackWindow: null,
      minimumSampleCount: null,
      breachAction: 'reduce',
      missingDataAction: 'abstain',
      priority: 75,
    },
    {
      limitKey: 'beta.eth_abs_max',
      scope: 'benchmark_beta',
      measurementKey: 'beta.eth_weighted_exposure_abs',
      operator: 'lte',
      warningThreshold: 0.4,
      hardThreshold: 0.7,
      unit: 'ratio_of_equity',
      aggregationMethod: 'portfolio_absolute',
      lookbackWindow: null,
      minimumSampleCount: null,
      breachAction: 'reduce',
      missingDataAction: 'abstain',
      priority: 74,
    },
    {
      limitKey: 'volatility.target',
      scope: 'candidate',
      measurementKey: 'candidate.realized_volatility',
      operator: 'lte',
      warningThreshold: 0.02,
      hardThreshold: 0.03,
      unit: 'log_return',
      aggregationMethod: 'candidate_absolute',
      lookbackWindow: 288,
      minimumSampleCount: 96,
      breachAction: 'reduce',
      missingDataAction: 'abstain',
      priority: 70,
    },
    {
      limitKey: 'liquidity.max_quote_pct_of_24h',
      scope: 'liquidity',
      measurementKey: 'liquidity.turnover_participation',
      operator: 'lte',
      warningThreshold: 0.005,
      hardThreshold: 0.01,
      unit: 'ratio',
      aggregationMethod: 'candidate_absolute',
      lookbackWindow: 288,
      minimumSampleCount: 96,
      breachAction: 'reduce',
      missingDataAction: 'reject',
      priority: 65,
    },
    {
      limitKey: 'daily.max_loss_pct',
      scope: 'daily',
      measurementKey: 'daily.realized_loss',
      operator: 'lte',
      warningThreshold: 0.015,
      hardThreshold: 0.03,
      unit: 'ratio_of_equity',
      aggregationMethod: 'period_absolute',
      lookbackWindow: 1440,
      minimumSampleCount: null,
      breachAction: 'block_all_new_entries',
      missingDataAction: 'block_all_new_entries',
      priority: 40,
    },
    {
      limitKey: 'weekly.max_loss_pct',
      scope: 'weekly',
      measurementKey: 'weekly.realized_loss',
      operator: 'lte',
      warningThreshold: 0.03,
      hardThreshold: 0.06,
      unit: 'ratio_of_equity',
      aggregationMethod: 'period_absolute',
      lookbackWindow: 10080,
      minimumSampleCount: null,
      breachAction: 'block_all_new_entries',
      missingDataAction: 'block_all_new_entries',
      priority: 35,
    },
    {
      limitKey: 'drawdown.max_current_pct',
      scope: 'drawdown',
      measurementKey: 'drawdown.current',
      operator: 'lte',
      warningThreshold: 0.05,
      hardThreshold: 0.1,
      unit: 'ratio_of_peak',
      aggregationMethod: 'portfolio_absolute',
      lookbackWindow: null,
      minimumSampleCount: null,
      breachAction: 'block_all_new_entries',
      missingDataAction: 'block_all_new_entries',
      priority: 30,
    },
    {
      limitKey: 'system.integrity_healthy',
      scope: 'system_integrity',
      measurementKey: 'system.integrity_state',
      operator: 'eq',
      warningThreshold: null,
      hardThreshold: 0,
      unit: 'ordinal',
      aggregationMethod: 'portfolio_state',
      lookbackWindow: null,
      minimumSampleCount: null,
      breachAction: 'reject',
      missingDataAction: 'reject',
      priority: 10,
    },
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegisteredPolicy {
  policy: RiskPolicy;
  row: RiskPolicyVersionRow;
  limits: RiskLimitDefinitionRow[];
}

export async function registerRiskPolicy(policy: RiskPolicy): Promise<RegisteredPolicy> {
  const configurationHash = hashLimits(policy.limits);
  const implementationHash = hashPolicy(policy, configurationHash);
  const existing = await db
    .select()
    .from(riskPolicyVersions)
    .where(and(eq(riskPolicyVersions.policyKey, policy.policyKey), eq(riskPolicyVersions.policyVersion, policy.policyVersion)))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].implementationHash !== implementationHash) {
      throw new Error(
        `risk policy ${policy.policyKey}@${policy.policyVersion} implementationHash mismatch — bump the policyVersion`,
      );
    }
    const limits = await db
      .select()
      .from(riskLimitDefinitions)
      .where(eq(riskLimitDefinitions.policyVersionId, existing[0].id));
    return { policy, row: existing[0], limits };
  }
  await db.insert(riskPolicyVersions).values({
    policyKey: policy.policyKey,
    policyVersion: policy.policyVersion,
    description: policy.description,
    operatingScope: policy.operatingScope,
    status: policy.status,
    effectiveFrom: policy.effectiveFrom,
    effectiveTo: policy.effectiveTo ?? null,
    implementationHash,
    configurationHash,
  });
  const [row] = await db
    .select()
    .from(riskPolicyVersions)
    .where(and(eq(riskPolicyVersions.policyKey, policy.policyKey), eq(riskPolicyVersions.policyVersion, policy.policyVersion)))
    .limit(1);
  for (const limit of policy.limits) {
    await db.insert(riskLimitDefinitions).values({
      policyVersionId: row.id,
      limitKey: limit.limitKey,
      scope: limit.scope,
      measurementKey: limit.measurementKey,
      operator: limit.operator,
      warningThreshold: limit.warningThreshold != null ? limit.warningThreshold.toFixed(12) : null,
      hardThreshold: limit.hardThreshold.toFixed(12),
      unit: limit.unit,
      aggregationMethod: limit.aggregationMethod,
      lookbackWindow: limit.lookbackWindow,
      minimumSampleCount: limit.minimumSampleCount,
      breachAction: limit.breachAction,
      missingDataAction: limit.missingDataAction,
      priority: limit.priority,
    });
  }
  const limits = await db
    .select()
    .from(riskLimitDefinitions)
    .where(eq(riskLimitDefinitions.policyVersionId, row.id));
  return { policy, row, limits };
}

export function findLimit(policy: RiskPolicy, limitKey: string): RiskLimitDefinition | null {
  return policy.limits.find((l) => l.limitKey === limitKey) ?? null;
}

function hashLimits(limits: readonly RiskLimitDefinition[]): string {
  const seed = JSON.stringify(
    [...limits]
      .sort((a, b) => a.limitKey.localeCompare(b.limitKey))
      .map((l) => ({
        k: l.limitKey,
        s: l.scope,
        m: l.measurementKey,
        op: l.operator,
        wt: l.warningThreshold,
        ht: l.hardThreshold,
        u: l.unit,
        ag: l.aggregationMethod,
        lw: l.lookbackWindow,
        min: l.minimumSampleCount,
        ba: l.breachAction,
        md: l.missingDataAction,
        p: l.priority,
      })),
  );
  return createHash('sha256').update(seed).digest('hex');
}

function hashPolicy(policy: RiskPolicy, configurationHash: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        k: policy.policyKey,
        v: policy.policyVersion,
        s: policy.status,
        os: policy.operatingScope,
        d: policy.description,
        from: policy.effectiveFrom.toISOString(),
        to: policy.effectiveTo?.toISOString() ?? null,
        c: configurationHash,
      }),
    )
    .digest('hex');
}
