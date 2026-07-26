import { db } from '../../db';
import {
  candidateRiskDecisions,
  championRiskComparisons,
  portfolioRiskSnapshots,
  riskLimitBreaches,
} from '../../db/schema';

/**
 * Phase 2C §AC — Portfolio-risk observer report.
 *
 * Aggregates observer outputs into a health / limit-breach / agreement
 * summary. The report NEVER claims profitability, Sharpe improvement,
 * sizing improvement, portfolio optimization or live-capital readiness.
 */

export interface RiskObserverReport {
  snapshotsConsidered: number;
  totalOpenRiskLatest: number;
  cashUtilizationLatest: number;
  unprotectedExposureLatest: number;
  productExposureConcentration: number | null;
  modeExposureConcentration: number | null;
  clusterExposureConcentration: number | null;
  btcBetaExposureLatest: number | null;
  ethBetaExposureLatest: number | null;
  dailyLossLatest: number;
  weeklyLossLatest: number;
  currentDrawdownLatest: number;
  historicalVaRLatest: number | null;
  historicalEsLatest: number | null;
  worstStressLossLatest: number | null;
  candidateDecisionCounts: Array<{ decision: string; count: number }>;
  bindingLimitDistribution: Array<{ bindingLimit: string; count: number }>;
  sizeReductionSummary: { count: number; averageMultiplier: number | null };
  rejectionReasons: Array<{ reason: string; count: number }>;
  abstentionReasons: Array<{ reason: string; count: number }>;
  missingDataRate: number;
  championRiskAgreement: { agree: number; risk_reduced: number; risk_rejected: number; risk_abstained: number; unresolved: number };
  systemIntegrityFailureCount: number;
  kellyStatus: 'disabled';
}

export async function buildRiskReport(): Promise<RiskObserverReport> {
  const snapshots = await db.select().from(portfolioRiskSnapshots);
  const decisions = await db.select().from(candidateRiskDecisions);
  const breaches = await db.select().from(riskLimitBreaches);
  const comparisons = await db.select().from(championRiskComparisons);
  const latest = snapshots[snapshots.length - 1] ?? null;

  const decisionCounts = countBy(decisions.map((d) => d.decision));
  const bindings = countBy(decisions.map((d) => d.bindingLimit ?? 'none'));
  const reduces = decisions.filter((d) => d.decision === 'reduce_size');
  const avgMultiplier = reduces.length > 0 ? reduces.reduce((s, d) => s + Number(d.sizeMultiplier), 0) / reduces.length : null;
  const rejections = decisions.filter((d) => d.decision === 'reject');
  const abstentions = decisions.filter((d) => d.decision === 'abstain');
  const totalDecisions = decisions.length;
  const missingData = decisions.filter((d) => d.decision === 'data_failure' || d.decision === 'abstain').length;
  const integrityFailures = snapshots.filter((s) => s.systemIntegrityState === 'invalid' || s.systemIntegrityState === 'reconciliation_required').length;
  return {
    snapshotsConsidered: snapshots.length,
    totalOpenRiskLatest: latest ? Number(latest.totalOpenStopRisk) : 0,
    cashUtilizationLatest: latest ? Number(latest.grossExposure) / Math.max(1, Number(latest.cash)) : 0,
    unprotectedExposureLatest: latest ? Number(latest.unprotectedExposure) : 0,
    productExposureConcentration: null,
    modeExposureConcentration: null,
    clusterExposureConcentration: null,
    btcBetaExposureLatest: latest?.btcBetaExposure != null ? Number(latest.btcBetaExposure) : null,
    ethBetaExposureLatest: latest?.ethBetaExposure != null ? Number(latest.ethBetaExposure) : null,
    dailyLossLatest: latest ? Number(latest.dailyLoss) : 0,
    weeklyLossLatest: latest ? Number(latest.weeklyLoss) : 0,
    currentDrawdownLatest: latest ? Number(latest.currentDrawdown) : 0,
    historicalVaRLatest: latest?.historicalVaR != null ? Number(latest.historicalVaR) : null,
    historicalEsLatest: latest?.historicalExpectedShortfall != null ? Number(latest.historicalExpectedShortfall) : null,
    worstStressLossLatest: latest?.worstStressLoss != null ? Number(latest.worstStressLoss) : null,
    candidateDecisionCounts: decisionCounts.map(([k, count]) => ({ decision: k, count })),
    bindingLimitDistribution: bindings.map(([k, count]) => ({ bindingLimit: k, count })),
    sizeReductionSummary: { count: reduces.length, averageMultiplier: avgMultiplier },
    rejectionReasons: countBy(rejections.map((r) => r.reasonCodes.split(',')[0] ?? 'unknown')).map(([reason, count]) => ({ reason, count })),
    abstentionReasons: countBy(abstentions.map((r) => r.reasonCodes.split(',')[0] ?? 'unknown')).map(([reason, count]) => ({ reason, count })),
    missingDataRate: totalDecisions > 0 ? missingData / totalDecisions : 0,
    championRiskAgreement: {
      agree: comparisons.filter((c) => c.agreementState === 'agree').length,
      risk_reduced: comparisons.filter((c) => c.agreementState === 'risk_reduced').length,
      risk_rejected: comparisons.filter((c) => c.agreementState === 'risk_rejected').length,
      risk_abstained: comparisons.filter((c) => c.agreementState === 'risk_abstained').length,
      unresolved: comparisons.filter((c) => c.agreementState === 'unresolved').length,
    },
    systemIntegrityFailureCount: integrityFailures,
    kellyStatus: 'disabled',
  };
  void breaches;
}

function countBy(xs: readonly string[]): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const x of xs) map.set(x, (map.get(x) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}
