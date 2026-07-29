/**
 * Stage 5A §3 — typed managed-runtime decision contract.
 *
 * Single pure function that resolves the (packaged, envOptIns) input
 * tuple into an authoritative `RuntimeModeDecision`. Every runtime
 * gate (BrowserWindow creation, bootstrap-token acceptance, external
 * server bypass, no-sandbox opt-in, DevTools) reads THIS decision —
 * never the underlying env vars directly. That way an invalid
 * combination fails once, deterministically, before any surface is
 * opened.
 *
 * Three legal modes:
 *
 *   external_test_server       — dev/CI: server + MariaDB + Redis
 *                                run outside the app; app is a UI
 *                                shell. Only legal when packaged=false.
 *   managed_docker             — dev machine + a real Docker daemon;
 *                                app owns MariaDB + Redis + server;
 *                                bootstrap authority is local.
 *   packaged_managed_docker    — packaged production build; ownership
 *                                identical to managed_docker, but the
 *                                policy structurally refuses every
 *                                dev-only relaxation (no external
 *                                server, no arbitrary renderer URL,
 *                                no no-sandbox fallback, no dev
 *                                bootstrap authority).
 *
 * `CI=true` is DELIBERATELY ignored by the policy. It's advisory
 * only — the mode is determined by `packaged` (i.e.
 * `Electron.app.isPackaged`) plus the explicit `HORIZON_SERVER_MODE`
 * env, not by the CI flag. That prevents a stray CI env var on a
 * production runner from unlocking dev-only code paths.
 */

export type RuntimeMode =
  | 'external_test_server'
  | 'managed_docker'
  | 'packaged_managed_docker';

export interface RuntimeModeDecision {
  readonly mode: RuntimeMode;
  readonly packaged: boolean;
  readonly ownsMariaDb: boolean;
  readonly ownsRedis: boolean;
  readonly ownsServer: boolean;
  readonly ownsContainers: boolean;
  readonly allowsExternalServer: boolean;
  readonly allowsArbitraryRendererUrl: boolean;
  readonly allowsNoSandboxOptIn: boolean;
  readonly allowsDevelopmentBootstrap: boolean;
  readonly requiresDockerDaemon: boolean;
  readonly certifiable: boolean;
  readonly reason: string;
}

/** Input to the pure resolver. Every field is caller-supplied. */
export interface ResolveRuntimeModeInput {
  /** `Electron.app.isPackaged`. Only trusted signal for production. */
  readonly packaged: boolean;
  /** `process.env.HORIZON_SERVER_MODE`. */
  readonly serverModeEnv: string | undefined;
  /** `process.env.HORIZON_SERVER_EXTERNAL` — legacy opt-in. */
  readonly serverExternalEnv: string | undefined;
  /** `process.env.HORIZON_DEVELOPMENT_FAKE` — dev-only pin. */
  readonly developmentFakeEnv: string | undefined;
  /** `process.env.NODE_ENV`. Advisory ONLY inside the policy. */
  readonly nodeEnv: string | undefined;
}

/**
 * Structured rejection — the resolver returns this when the input
 * combination has no legal interpretation. Callers MUST refuse to
 * open BrowserWindow when they see this shape.
 */
export interface RuntimeModeRejection {
  readonly ok: false;
  readonly reason: string;
  readonly failureCode:
    | 'packaged_forbids_external_test_server'
    | 'packaged_forbids_development_fake'
    | 'invalid_server_mode_value'
    | 'conflicting_server_mode_flags';
}

export type RuntimeModeResult =
  | { readonly ok: true; readonly decision: RuntimeModeDecision }
  | RuntimeModeRejection;

/** Case-insensitive `true` matcher — we accept only `'true'`. */
function isTrue(v: string | undefined): boolean {
  if (v === undefined) return false;
  return v.trim().toLowerCase() === 'true';
}

/**
 * Legal `HORIZON_SERVER_MODE` values. The env var is optional; when
 * absent we derive the mode from `packaged`. When present with an
 * unrecognized value the resolver rejects with `invalid_server_mode_value`.
 */
const LEGAL_SERVER_MODES: ReadonlySet<string> = new Set(['external_test_server', 'managed_docker']);

export function resolveRuntimeMode(input: ResolveRuntimeModeInput): RuntimeModeResult {
  // 1. Packaged production has ONE legal mode: packaged_managed_docker.
  //    A stray `HORIZON_SERVER_EXTERNAL=true` or `HORIZON_SERVER_MODE=
  //    external_test_server` on a packaged build is a hard rejection.
  if (input.packaged) {
    if (isTrue(input.serverExternalEnv)) {
      return {
        ok: false,
        reason: 'packaged build refuses HORIZON_SERVER_EXTERNAL=true — external test-server mode is dev-only',
        failureCode: 'packaged_forbids_external_test_server',
      };
    }
    if (input.serverModeEnv !== undefined && input.serverModeEnv.trim() !== '' && input.serverModeEnv.trim().toLowerCase() !== 'managed_docker') {
      return {
        ok: false,
        reason: `packaged build refuses HORIZON_SERVER_MODE=${input.serverModeEnv} — only managed_docker is legal in production`,
        failureCode: 'packaged_forbids_external_test_server',
      };
    }
    if (isTrue(input.developmentFakeEnv)) {
      return {
        ok: false,
        reason: 'packaged build refuses HORIZON_DEVELOPMENT_FAKE=true',
        failureCode: 'packaged_forbids_development_fake',
      };
    }
    return {
      ok: true,
      decision: {
        mode: 'packaged_managed_docker',
        packaged: true,
        ownsMariaDb: true,
        ownsRedis: true,
        ownsServer: true,
        ownsContainers: true,
        allowsExternalServer: false,
        allowsArbitraryRendererUrl: false,
        allowsNoSandboxOptIn: false,
        allowsDevelopmentBootstrap: false,
        requiresDockerDaemon: true,
        certifiable: true,
        reason: 'packaged production build — managed_docker enforced',
      },
    };
  }

  // 2. Unpackaged (dev / CI). Reconcile the two overlapping env vars.
  const modeVal = input.serverModeEnv?.trim().toLowerCase();
  const externalVal = isTrue(input.serverExternalEnv);

  if (modeVal !== undefined && modeVal !== '' && !LEGAL_SERVER_MODES.has(modeVal)) {
    return {
      ok: false,
      reason: `unrecognized HORIZON_SERVER_MODE=${input.serverModeEnv}`,
      failureCode: 'invalid_server_mode_value',
    };
  }

  // Conflict: HORIZON_SERVER_MODE=managed_docker but
  // HORIZON_SERVER_EXTERNAL=true. Refuse — a dev must resolve which
  // one they meant.
  if (modeVal === 'managed_docker' && externalVal) {
    return {
      ok: false,
      reason: 'HORIZON_SERVER_MODE=managed_docker conflicts with HORIZON_SERVER_EXTERNAL=true',
      failureCode: 'conflicting_server_mode_flags',
    };
  }

  // Explicit external — the dev/native-CI path.
  if (modeVal === 'external_test_server' || externalVal) {
    return {
      ok: true,
      decision: {
        mode: 'external_test_server',
        packaged: false,
        ownsMariaDb: false,
        ownsRedis: false,
        ownsServer: false,
        ownsContainers: false,
        allowsExternalServer: true,
        allowsArbitraryRendererUrl: true,
        allowsNoSandboxOptIn: true,
        allowsDevelopmentBootstrap: true,
        requiresDockerDaemon: false,
        // Dev/CI is intentionally NOT certifiable — the runtime
        // makes assertions the packaged build never can.
        certifiable: false,
        reason: 'unpackaged: external server / MariaDB / Redis provided out-of-app',
      },
    };
  }

  // Default unpackaged path: dev machine with a real Docker daemon
  // running the managed services. Only reachable when neither env
  // opt-in was set.
  return {
    ok: true,
    decision: {
      mode: 'managed_docker',
      packaged: false,
      ownsMariaDb: true,
      ownsRedis: true,
      ownsServer: true,
      ownsContainers: true,
      allowsExternalServer: false,
      allowsArbitraryRendererUrl: true,
      allowsNoSandboxOptIn: true,
      // Dev bootstrap is only reachable in an unpackaged, non-CI dev
      // machine that opted-in via NODE_ENV=development.
      allowsDevelopmentBootstrap: (input.nodeEnv ?? '').trim().toLowerCase() === 'development',
      requiresDockerDaemon: true,
      certifiable: false,
      reason: 'unpackaged: local Docker manages MariaDB + Redis + server',
    },
  };
}
