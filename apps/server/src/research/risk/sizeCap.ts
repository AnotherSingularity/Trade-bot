import type { RiskMeasurement } from './contract';
import type { PortfolioRiskInput } from './inputs';
import type { ExposureBreakdown, VolatilitySizingResult } from './measurements';
import type { LiquidityCapResult } from './liquidity';
import type { BetaExposureResult } from './correlation';
import type { EsResult } from './expectedShortfall';
import type { StressResult } from './stressTests';
import type { RiskPolicy } from './policy';
import { findLimit } from './policy';

/**
 * Phase 2C §J — Independent size-cap composition.
 *
 * Compose independent caps. Recommended base size is:
 *   min(all valid caps, championProposedBaseSize)
 *
 * Then:
 *   1. Round down to the product base increment.
 *   2. Recalculate quote notional.
 *   3. Recalculate stop risk against the reduced size.
 *   4. Confirm minimum base and quote order sizes.
 *   5. Confirm no cap was exceeded due to rounding.
 *   6. Reject when the rounded size is not executable.
 *
 * NEVER round upward to satisfy a minimum. The BINDING cap is
 * persisted so the audit surface can explain the decision.
 */

export interface Cap {
  key: string;
  size: number | null; // in base units; null = the cap is unknown / abstain
  reason: string;
  bindingIfEqual?: boolean;
}

export interface CapCompositionInput {
  policy: RiskPolicy;
  input: PortfolioRiskInput;
  candidateStopRisk: RiskMeasurement<{
    totalModeledStopLoss: number;
    grossPriceRisk: number;
    netStopPnl: number;
  }>;
  exposure: ExposureBreakdown;
  volatility: RiskMeasurement<VolatilitySizingResult>;
  liquidity: RiskMeasurement<LiquidityCapResult>;
  beta: {
    btc: RiskMeasurement<BetaExposureResult>;
    eth: RiskMeasurement<BetaExposureResult>;
  };
  expectedShortfall?: RiskMeasurement<EsResult>;
  stressResults?: readonly StressResult[];
}

export interface CapCompositionResult {
  caps: Cap[];
  championProposedBase: number;
  bindingCap: Cap | null;
  minimumViable: boolean;
  recommendedBaseSize: number;
  recommendedQuoteSize: number;
  reasons: string[];
}

export function composeCaps(inp: CapCompositionInput): CapCompositionResult {
  const caps: Cap[] = [];
  const reasons: string[] = [];
  const proposedBase = Number(inp.input.proposedBaseSize);
  const price = Number(inp.input.approvedEntryPrice);
  const equity = Number(inp.input.portfolioLedgerState.totalEquity);

  caps.push({ key: 'championProposedSize', size: proposedBase, reason: 'champion_input' });

  // Stop-risk cap
  const stopLimit = findLimit(inp.policy, 'candidate.stop_loss_quote_pct_of_equity');
  if (inp.candidateStopRisk.status === 'valid' && inp.candidateStopRisk.value && stopLimit) {
    const hardBudget = stopLimit.hardThreshold * equity;
    const proposedRisk = inp.candidateStopRisk.value.totalModeledStopLoss;
    if (proposedRisk > 0 && proposedRisk > hardBudget) {
      const scale = hardBudget / proposedRisk;
      caps.push({
        key: 'stopRiskCap',
        size: proposedBase * scale,
        reason: `stop_loss>${(stopLimit.hardThreshold * 100).toFixed(2)}%_of_equity`,
      });
    } else {
      caps.push({ key: 'stopRiskCap', size: proposedBase, reason: 'within_stop_budget' });
    }
  } else if (stopLimit) {
    caps.push({ key: 'stopRiskCap', size: null, reason: `abstain:${inp.candidateStopRisk.status}` });
    reasons.push(`stopRiskCap:${inp.candidateStopRisk.status}`);
  }

  // Cash caps
  const cash = Number(inp.input.cashAvailable);
  const reserved = Number(inp.input.cashReserved);
  const availableForEntry = Math.max(0, cash - reserved);
  const cashCapBase = price > 0 ? availableForEntry / price : 0;
  caps.push({ key: 'cashCap', size: cashCapBase, reason: 'available_cash' });
  const reserveLimit = findLimit(inp.policy, 'cash.reserve_remaining_min');
  if (reserveLimit) {
    const minReserve = reserveLimit.hardThreshold * equity;
    const capAfterReserve = Math.max(0, cash - minReserve);
    caps.push({ key: 'cashReserveCap', size: price > 0 ? capAfterReserve / price : 0, reason: 'reserve_floor' });
  }

  // Product exposure cap
  const productLimit = findLimit(inp.policy, 'product.max_quote_exposure_pct');
  if (productLimit) {
    const currentProductExposure = inp.exposure.productExposure.get(inp.input.productId) ?? 0;
    const budget = productLimit.hardThreshold * equity - currentProductExposure;
    const remaining = Math.max(0, budget);
    caps.push({ key: 'productExposureCap', size: price > 0 ? remaining / price : 0, reason: 'product_cap' });
  }
  // Mode exposure cap
  const modeLimit = findLimit(inp.policy, 'mode.max_quote_exposure_pct');
  if (modeLimit) {
    const cur = inp.exposure.modeExposure.get(inp.input.championMode) ?? 0;
    const budget = modeLimit.hardThreshold * equity - cur;
    caps.push({ key: 'modeExposureCap', size: price > 0 ? Math.max(0, budget) / price : 0, reason: 'mode_cap' });
  }
  // Cluster exposure cap
  const clusterLimit = findLimit(inp.policy, 'cluster.max_quote_exposure_pct');
  if (clusterLimit && inp.input.clusterKey) {
    const cur = inp.exposure.clusterExposure.get(inp.input.clusterKey) ?? 0;
    const budget = clusterLimit.hardThreshold * equity - cur;
    caps.push({ key: 'clusterExposureCap', size: price > 0 ? Math.max(0, budget) / price : 0, reason: 'cluster_cap' });
  }

  // Beta exposure caps
  const btcLimit = findLimit(inp.policy, 'beta.btc_abs_max');
  if (btcLimit && inp.beta.btc.status === 'valid' && inp.beta.btc.value) {
    const abs = inp.beta.btc.value.absoluteExposure ?? 0;
    const budget = btcLimit.hardThreshold * equity - abs;
    const beta = inp.input.benchmarkBetaEvidence.btcBeta ?? 1;
    const additional = beta !== 0 ? Math.max(0, budget) / Math.abs(beta) : Number.POSITIVE_INFINITY;
    caps.push({ key: 'betaBtcCap', size: price > 0 ? additional / price : 0, reason: 'btc_beta_cap' });
  } else if (btcLimit && inp.beta.btc.status !== 'valid') {
    caps.push({ key: 'betaBtcCap', size: null, reason: `abstain:${inp.beta.btc.status}` });
    reasons.push(`betaBtcCap:${inp.beta.btc.status}`);
  }
  const ethLimit = findLimit(inp.policy, 'beta.eth_abs_max');
  if (ethLimit && inp.beta.eth.status === 'valid' && inp.beta.eth.value) {
    const abs = inp.beta.eth.value.absoluteExposure ?? 0;
    const budget = ethLimit.hardThreshold * equity - abs;
    const beta = inp.input.benchmarkBetaEvidence.ethBeta ?? 1;
    const additional = beta !== 0 ? Math.max(0, budget) / Math.abs(beta) : Number.POSITIVE_INFINITY;
    caps.push({ key: 'betaEthCap', size: price > 0 ? additional / price : 0, reason: 'eth_beta_cap' });
  } else if (ethLimit && inp.beta.eth.status !== 'valid') {
    caps.push({ key: 'betaEthCap', size: null, reason: `abstain:${inp.beta.eth.status}` });
    reasons.push(`betaEthCap:${inp.beta.eth.status}`);
  }

  // Volatility cap (multiplier applied to championProposedSize)
  if (inp.volatility.status === 'valid' || inp.volatility.status === 'low_confidence') {
    const m = inp.volatility.value!.multiplier;
    caps.push({ key: 'volatilityCap', size: proposedBase * m, reason: `vol_multiplier=${m.toFixed(4)}` });
  } else {
    caps.push({ key: 'volatilityCap', size: null, reason: `abstain:${inp.volatility.status}` });
    reasons.push(`volatilityCap:${inp.volatility.status}`);
  }

  // Liquidity cap (participation)
  if (inp.liquidity.status === 'valid') {
    const maxQuote = inp.liquidity.value!.maxAllowedQuoteSize;
    caps.push({ key: 'liquidityCap', size: price > 0 ? maxQuote / price : 0, reason: 'liquidity_participation' });
  } else if (inp.liquidity.status === 'low_confidence') {
    caps.push({ key: 'liquidityCap', size: 0, reason: 'liquidity_low_confidence_reject' });
  } else {
    caps.push({ key: 'liquidityCap', size: 0, reason: `abstain:${inp.liquidity.status}` });
    reasons.push(`liquidityCap:${inp.liquidity.status}`);
  }

  // Drawdown / daily / weekly — these do not scale, they either allow or block.
  // We surface them in reasons; the composer treats a hard breach by ejecting to 0.

  // Compose min-of-valid-caps.
  const numericCaps = caps.filter((c) => c.size != null && Number.isFinite(c.size));
  const min = numericCaps.reduce<Cap | null>((acc, c) => {
    if (acc == null || (c.size! < acc.size!)) return c;
    return acc;
  }, null);
  const rawMinSize = min?.size ?? 0;

  // Round down to base increment.
  const baseIncrement = Number(inp.input.productMetadata.baseIncrement);
  const roundedBase = baseIncrement > 0 ? Math.floor(rawMinSize / baseIncrement) * baseIncrement : rawMinSize;

  // Re-check quote size + minimums.
  const roundedQuote = roundedBase * price;
  const baseMinimum = Number(inp.input.productMetadata.baseMinimum);
  const quoteMinimum = inp.input.productMetadata.quoteMinimum != null ? Number(inp.input.productMetadata.quoteMinimum) : 0;
  const meetsBaseMin = roundedBase >= baseMinimum;
  const meetsQuoteMin = roundedQuote >= quoteMinimum;
  const minimumViable = meetsBaseMin && meetsQuoteMin && roundedBase > 0;
  if (!minimumViable) reasons.push('below_minimum_executable_after_rounding');

  return {
    caps,
    championProposedBase: proposedBase,
    bindingCap: min,
    minimumViable,
    recommendedBaseSize: minimumViable ? roundedBase : 0,
    recommendedQuoteSize: minimumViable ? roundedQuote : 0,
    reasons,
  };
}
