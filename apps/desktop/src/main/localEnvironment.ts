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
