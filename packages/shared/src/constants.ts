/**
 * Horizon Trade — hardcoded strategy constants.
 *
 * These values are intentionally NOT user-editable. The strategy is fixed and
 * versioned; any change must be made here, bumped in STRATEGY_VERSION, and
 * documented in CHANGELOG.md.
 */

export const STRATEGY_VERSION = '2.0.0';

export const TOKEN_UNIVERSE = [
  // DeFi / Financial
  'AAVE', 'COMP', 'SUSHI', 'UNI', 'CRV', 'MKR', 'LDO', 'SYRUP', 'PENDLE', 'ONDO',
  // AI
  'TAO', 'OCEAN', 'NMR', 'RNDR', 'FET', 'AGIX', 'GRT', 'VIRTUAL',
  // L2 / Ecosystem
  'ARB', 'OP', 'NEAR', 'ALGO', 'XLM', 'TRX', 'LINK', 'INJ',
  // Micro / Sub-dollar
  'B3', 'AERO', 'CFG', 'OM', 'POL', 'S',
] as const;

export type Token = (typeof TOKEN_UNIVERSE)[number];

export const TOKEN_COUNT = TOKEN_UNIVERSE.length;

export const TRADING_MODES = ['reversion', 'breakout', 'macro'] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

export interface ModeConfig {
  allocationPct: number;
  takeProfitPct: number;
  stopLossPct: number;
  claudeThreshold: number;
  signalsRequired: number;
  signalsTotal: number;
  earlyExitPct?: number;
  minIntradayGainPct?: number;
  volumeMultiplier?: number;
  rsiMin?: number;
  rsiMax?: number;
}

export const STRATEGY = {
  MIN_VOLUME_24HR: 500_000,
  MAX_OPEN_POSITIONS: 3,
  CONSECUTIVE_LOSS_LIMIT: 3,
  CIRCUIT_BREAKER_HOURS: 2,
  SESSION_EXCLUSION_MINUTES: 30,

  MODES: {
    reversion: {
      allocationPct: 5,
      takeProfitPct: 3,
      stopLossPct: 2,
      earlyExitPct: 1.5,
      claudeThreshold: 0.72,
      signalsRequired: 4,
      signalsTotal: 5,
    },
    breakout: {
      allocationPct: 8,
      takeProfitPct: 15,
      stopLossPct: 6,
      claudeThreshold: 0.65,
      signalsRequired: 4,
      signalsTotal: 4,
      minIntradayGainPct: 30,
      volumeMultiplier: 2.5,
      rsiMin: 55,
      rsiMax: 65,
    },
    macro: {
      allocationPct: 10,
      takeProfitPct: 8,
      stopLossPct: 3,
      claudeThreshold: 0.72,
      signalsRequired: 3,
      signalsTotal: 4,
    },
  } satisfies Record<TradingMode, ModeConfig>,

  // Token win rate thresholds
  WIN_RATE_PRIORITY: 60, // above this: priority evaluation
  WIN_RATE_REDUCE: 40, // below this: allocation cut to 2.5%
  WIN_RATE_REDUCED_PCT: 2.5,

  // Market windows (EST)
  MARKET_WINDOWS: {
    PRIME: [
      { start: '08:00', end: '12:00' },
      { start: '14:00', end: '17:00' },
    ],
    ACTIVE: [{ start: '20:00', end: '23:00' }],
  },

  // Session open exclusions (EST)
  SESSION_OPENS: ['08:00', '20:00'],

  // Scan cadence
  SCAN_INTERVAL_MS: 5 * 60 * 1000,
} as const;

export type MarketWindow = 'PRIME' | 'ACTIVE' | 'CLOSED';

/** Quote currency used for all trading pairs. */
export const QUOTE_CURRENCY = 'USD';

/** Claude model used for signal evaluation. */
export const CLAUDE_MODEL = 'claude-sonnet-4-6';
