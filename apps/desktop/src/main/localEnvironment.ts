/**
 * Phase 3A §E — Desktop environment policy.
 *
 * ONE main-process-controlled environment resolver. Renderer may
 * display sanitized safe-configuration values but may not set raw
 * environment variables.
 *
 * The desktop application MUST refuse to launch an operational
 * runtime when the invariants below are violated. There is no
 * "acknowledge and continue" bypass.
 */

export interface DesktopEnvironment {
  DRY_RUN: boolean;
  ORDER_SUBMISSION_ENABLED: boolean;
  SIMULATION_MODE: string;
  providerMode: 'fixture' | 'deferred_production' | 'external';
  databaseMode: 'managed_docker' | 'external_services';
  redisMode: 'managed_docker' | 'external_services';
  schemaVersion: string;
  buildCommit: string;
  desktopVersion: string;
}

export interface EnvironmentValidationResult {
  ok: boolean;
  environment: DesktopEnvironment;
  violations: string[];
}

const DEFAULTS = {
  DRY_RUN: true,
  ORDER_SUBMISSION_ENABLED: false,
  SIMULATION_MODE: 'shadow',
  providerMode: 'fixture' as const,
  databaseMode: 'managed_docker' as const,
  redisMode: 'managed_docker' as const,
  schemaVersion: '0019',
  buildCommit: 'unknown',
  desktopVersion: '3.0.0',
};

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null || raw === '') return defaultValue;
  const lowered = raw.toLowerCase();
  if (lowered === 'true' || lowered === '1' || lowered === 'yes') return true;
  if (lowered === 'false' || lowered === '0' || lowered === 'no') return false;
  return defaultValue;
}

function readMode<T extends string>(raw: string | undefined, allowed: readonly T[], defaultValue: T): T {
  if (!raw) return defaultValue;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : defaultValue;
}

export function resolveDesktopEnvironment(processEnv: NodeJS.ProcessEnv = process.env): DesktopEnvironment {
  return {
    DRY_RUN: parseBoolean(processEnv.DRY_RUN, DEFAULTS.DRY_RUN),
    ORDER_SUBMISSION_ENABLED: parseBoolean(processEnv.ORDER_SUBMISSION_ENABLED, DEFAULTS.ORDER_SUBMISSION_ENABLED),
    SIMULATION_MODE: processEnv.SIMULATION_MODE ?? DEFAULTS.SIMULATION_MODE,
    providerMode: readMode(processEnv.HORIZON_PROVIDER_MODE, ['fixture', 'deferred_production', 'external'], DEFAULTS.providerMode),
    databaseMode: readMode(processEnv.HORIZON_DATABASE_MODE, ['managed_docker', 'external_services'], DEFAULTS.databaseMode),
    redisMode: readMode(processEnv.HORIZON_REDIS_MODE, ['managed_docker', 'external_services'], DEFAULTS.redisMode),
    schemaVersion: processEnv.HORIZON_SCHEMA_VERSION ?? DEFAULTS.schemaVersion,
    buildCommit: processEnv.HORIZON_BUILD_COMMIT ?? DEFAULTS.buildCommit,
    desktopVersion: processEnv.HORIZON_DESKTOP_VERSION ?? DEFAULTS.desktopVersion,
  };
}

/**
 * Validate the desktop environment against Phase 3A invariants. The
 * desktop MUST refuse to launch an operational runtime when any
 * invariant is violated.
 */
export function validateDesktopEnvironment(env: DesktopEnvironment): EnvironmentValidationResult {
  const violations: string[] = [];
  if (env.DRY_RUN !== true) violations.push('DRY_RUN must be true');
  if (env.ORDER_SUBMISSION_ENABLED !== false) violations.push('ORDER_SUBMISSION_ENABLED must be false');
  if (env.providerMode === 'external') violations.push('production providers must remain inactive during Phase 3A');
  return {
    ok: violations.length === 0,
    environment: env,
    violations,
  };
}

/**
 * Stage 3C-ENV — hardened Electron sandbox policy.
 *
 * Chromium refuses to launch renderer child processes as root without
 * `--no-sandbox`. The Stage 3C native harness needs that switch inside
 * an Xvfb-only test environment. Production installers MUST NEVER
 * disable the sandbox — that would remove Chromium's process isolation
 * for real operator sessions.
 *
 * This resolver is the single source of truth. `apps/desktop/src/main/index.ts`
 * calls it at module load and applies `app.commandLine.appendSwitch(...)`
 * only when the returned decision says so. `apps/desktop/tests/main/sandbox_policy.test.ts`
 * covers every branch as a pure unit test — no Electron dependency.
 *
 * Rules (all must hold; belt-and-suspenders):
 *   1. `isPackaged === true` → sandbox stays ON. Always. No env var, no
 *      NODE_ENV value, no combination reaches inside a packaged
 *      installer.
 *   2. `envOptIn !== 'true'` (strict string match) → sandbox stays ON.
 *      Non-canonical values like '1' / 'yes' / 'YES' / 'TRUE' are
 *      REJECTED so a typo in an unrelated CI script cannot silently
 *      weaken the boundary.
 *   3. `nodeEnv !== 'test'` → sandbox stays ON. A dev-mode invocation
 *      with the opt-in flag but without NODE_ENV=test is refused.
 *   4. `isDevelopmentFake === true` → sandbox stays ON. Fake-runtime
 *      dev mode never justifies a sandbox disable.
 *   5. Only when 1..4 all pass does the resolver return
 *      `disableSandbox: true` with the frozen switch tuple.
 */
export type SandboxDecisionReason =
  | 'production_hardening'
  | 'test_only_xvfb_opt_in'
  | 'default_hardened';

export interface SandboxDecision {
  disableSandbox: boolean;
  reason: SandboxDecisionReason;
  appliedSwitches: readonly string[];
}

export const SANDBOX_DISABLE_SWITCHES: readonly string[] = Object.freeze([
  'no-sandbox',
  'disable-gpu-sandbox',
  'disable-dev-shm-usage',
]);

export interface SandboxPolicyInput {
  isPackaged: boolean;
  nodeEnv: string | undefined;
  envOptIn: string | undefined;
  isDevelopmentFake: boolean;
}

export function resolveSandboxPolicy(input: SandboxPolicyInput): SandboxDecision {
  // Rule 1 — packaged installers always keep the sandbox.
  if (input.isPackaged) {
    return { disableSandbox: false, reason: 'production_hardening', appliedSwitches: [] };
  }
  // Rules 2, 3, 4 — test opt-in requires ALL of:
  //   envOptIn === 'true' (strict match), NODE_ENV === 'test', !isDevelopmentFake.
  const strictOptIn = input.envOptIn === 'true';
  const isTestNode = input.nodeEnv === 'test';
  if (strictOptIn && isTestNode && !input.isDevelopmentFake) {
    return {
      disableSandbox: true,
      reason: 'test_only_xvfb_opt_in',
      appliedSwitches: SANDBOX_DISABLE_SWITCHES,
    };
  }
  return { disableSandbox: false, reason: 'default_hardened', appliedSwitches: [] };
}

/**
 * Sanitized snapshot suitable for the renderer via IPC. No secrets;
 * no raw environment.
 */
export interface SafeConfigurationSnapshot {
  DRY_RUN: true;
  ORDER_SUBMISSION_ENABLED: false;
  SIMULATION_MODE: string;
  providerMode: 'fixture' | 'deferred_production' | 'external';
  databaseMode: 'managed_docker' | 'external_services';
  redisMode: 'managed_docker' | 'external_services';
  schemaVersion: string;
  buildCommit: string;
  desktopVersion: string;
}

export function toSanitizedSnapshot(env: DesktopEnvironment): SafeConfigurationSnapshot {
  const validated = validateDesktopEnvironment(env);
  if (!validated.ok) {
    throw new Error(`sanitized snapshot refused — invariants violated: ${validated.violations.join(', ')}`);
  }
  return {
    DRY_RUN: true,
    ORDER_SUBMISSION_ENABLED: false,
    SIMULATION_MODE: env.SIMULATION_MODE,
    providerMode: env.providerMode,
    databaseMode: env.databaseMode,
    redisMode: env.redisMode,
    schemaVersion: env.schemaVersion,
    buildCommit: env.buildCommit,
    desktopVersion: env.desktopVersion,
  };
}
