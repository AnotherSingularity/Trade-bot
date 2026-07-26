import type { RiskMeasurement } from './contract';
import { invalidMeasurement, validMeasurement } from './contract';
import type { LiquidityEvidenceInput, PortfolioRiskInput } from './inputs';

/**
 * Phase 2C §O — Liquidity-aware size cap.
 *
 * The cap can only REDUCE or REJECT size. It cannot infer executable
 * depth without Level 2 — the model advertises `isBookAware=false`
 * and the cap is described as an APPROXIMATE PARTICIPATION
 * CONSTRAINT, not proven market capacity.
 */

export const LIQUIDITY_MODEL_VERSION = 'p2c-liq-1';
export const LIQUIDITY_IS_BOOK_AWARE = false;
export const DEFAULT_MAX_PARTICIPATION = 0.005; // 0.5% of 24h quote volume

export interface LiquidityCapResult {
  maxAllowedQuoteSize: number;
  participation: number;
  reason: string;
}

export function measureLiquidityCap(
  input: PortfolioRiskInput,
  liq: LiquidityEvidenceInput = input.liquidityEvidence,
  maxParticipation: number = DEFAULT_MAX_PARTICIPATION,
): RiskMeasurement<LiquidityCapResult> {
  const meta = {
    measurementKey: 'liquidity.turnover_participation',
    unit: 'quote',
    observedAt: input.observedAt,
    dataAvailableAt: liq.dataAvailableAt,
    policyVersion: 'p2c-risk-1',
    modelVersion: LIQUIDITY_MODEL_VERSION,
    inputHash: `liq:${liq.productId}:${liq.quoteVolume24h}`,
  };
  if (!liq.hygieneEligible) {
    return invalidMeasurement<LiquidityCapResult>('unresolved_state', {
      ...meta,
      failureReason: 'product not hygiene-eligible',
    });
  }
  if (liq.quoteVolume24h == null) {
    return invalidMeasurement<LiquidityCapResult>('unsupported', {
      ...meta,
      failureReason: 'no 24h quote volume evidence',
    });
  }
  if (!Number.isFinite(liq.quoteVolume24h) || liq.quoteVolume24h < 0) {
    return invalidMeasurement<LiquidityCapResult>('invalid_input', {
      ...meta,
      failureReason: 'invalid 24h quote volume',
    });
  }
  const maxAllowed = maxParticipation * liq.quoteVolume24h;
  const proposedQuote = Number(input.proposedQuoteSize);
  const participation = liq.quoteVolume24h > 0 ? proposedQuote / liq.quoteVolume24h : Infinity;
  return validMeasurement<LiquidityCapResult>({
    ...meta,
    value: {
      maxAllowedQuoteSize: maxAllowed,
      participation,
      reason: participation > maxParticipation ? 'reduce_from_participation' : 'within_participation',
    },
    confidence: 1,
    sampleCount: 1,
    diagnostics: {
      isBookAware: LIQUIDITY_IS_BOOK_AWARE,
      approximateSpreadBps: liq.approximateSpreadBps,
      amihud: liq.amihudIlliquidity,
      zeroVolFreq: liq.zeroVolumeFrequency,
      gapFreq: liq.candleGapFrequency,
      minOrderNotional: liq.minOrderNotionalQuote,
    },
  });
}
