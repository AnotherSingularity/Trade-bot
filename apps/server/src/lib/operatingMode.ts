import { ENV } from '../env';

/**
 * Phase 1.1 Gate 3D-FIX §A — centralized operating-mode policy.
 *
 * One source of truth for `SIMULATION_MODE`. Every runtime entry point
 * — scheduled scanner, manual scanner, entry executor, exit executor,
 * position manager, startup reconciler, recurring reconciler, emergency
 * handling — MUST call `simulationMode()` here rather than reading
 * `process.env` directly. Ad-hoc string checks are prohibited by
 * lint/review — the tests in `phase1_gate3d_fix.test.ts` assert that
 * every SHADOW_LIVE-affected call site routes through this module.
 */

export type SimulationMode = 'STANDARD_DRY_RUN' | 'SHADOW_LIVE';

export function simulationMode(): SimulationMode {
  const m = ENV.simulationMode;
  if (m !== 'STANDARD_DRY_RUN' && m !== 'SHADOW_LIVE') {
    // Fail closed on unsupported/malformed values.
    throw new Error(`operatingMode: unsupported SIMULATION_MODE=${String(m)}`);
  }
  return m;
}

export function isShadowLive(): boolean {
  return simulationMode() === 'SHADOW_LIVE';
}

export function isStandardDryRun(): boolean {
  return simulationMode() === 'STANDARD_DRY_RUN';
}

/**
 * Assert that the current mode matches the caller's expectation. Used
 * as a source-level guard at every SHADOW_LIVE-only entry point.
 */
export function assertMode(expected: SimulationMode): void {
  const actual = simulationMode();
  if (actual !== expected) {
    throw new Error(`operatingMode: expected ${expected}, got ${actual}`);
  }
}
