/**
 * Stage 1 §A, §12, §13 — Electron main entry with real runtime wiring.
 *
 * Startup sequence:
 *   1. Validate desktop environment invariants (§E).
 *   2. Resolve runtime assets (dev/packaged); fail closed if missing.
 *   3. Instantiate the production CommandRunner via the ADAPTER
 *      FACTORY — production forbids InMemoryRunner + stubs.
 *   4. Build service adapters (mariadb, redis, server, reconciliation)
 *      using real Docker / MariaDB / Redis probes.
 *   5. Start supervisor → dependency check → start → migrate →
 *      synchronize (fingerprint) → healthy.
 *   6. Wait for authenticated server /health.
 *   7. Register IPC handlers with authoritative status source.
 *   8. Open the main window.
 *
 * Failure at any step preserves logs, records a desktop incident, and
 * refuses to display a false-healthy UI.
 */

import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { handleIpcCall, type IpcHostContext } from './ipc';
import { ConsoleSink, Logger } from './logging';
import { resolveDesktopEnvironment, resolveSandboxPolicy, validateDesktopEnvironment } from './localEnvironment';
import { resolveDesktopRuntimeLayout, sanitizePreloadPath } from './runtimeLayout';
import { resolveRendererUrl } from './rendererUrlPolicy';
import { resolveExternalServerMode } from './externalServerPolicy';
import { InMemorySecretsAdapter, KeytarSecretsAdapter, type SecretsAdapter, collectCredentialStatuses } from './secrets';
import { resolveBootstrapTokenAuthority } from './bootstrapToken';
import { createAuthTokenStorage } from './secureStorage';
import { AuthenticatedApiClient } from './authenticatedApiClient';
import { DesktopAuthManager } from './desktopAuthManager';
import {
  createAdapterRuntime,
  createDesktopShellAdapter,
  createMariadbAdapterExternal,
  createMariadbAdapterManaged,
  createNotImplementedAdapter,
  createReconciliationAdapter,
  createRedisAdapterExternal,
  createRedisAdapterManaged,
  createServerAdapterExternal,
  createServerAdapterManaged,
  createServerAdapterOutOfProcess,
} from './serviceAdapters';
import { assertProductionRunner, createServiceAdapters, type Environment } from './serviceAdapterFactory';
import { DEFAULT_SUPERVISOR_CONFIG, ServiceSupervisor } from './serviceSupervisor';
import { buildSafeWindowConfig, validateWindowConfig } from './windows';
import { IPC_ALLOWLIST } from '../shared/ipcContract';
import { inferDevProjectRoot, resolveRuntimeAssets } from './runtimeAssets';
import { DesktopStatusSource } from './desktopStatusSource';
import { DesktopIncidentSink } from './incidents';

const logger = new Logger(new ConsoleSink(), 'main');

// Stage 3C-ENV — hardened sandbox policy. The single call to
// resolveSandboxPolicy is the ONLY gate that can weaken Chromium
// sandboxing. Packaged installers structurally cannot enter the
// disable branch (Rule 1 in localEnvironment.ts). The runtime log
// records the decision + reason so review can prove the boundary
// held from CI artefacts.
// Stage 3C-CI-FIX4 §A5: hardened native-diagnostics gate.
// Packaged installers structurally cannot enable the preload/renderer
// HORIZON_NATIVE_* markers — we strip the env var here BEFORE any
// preload/renderer sees it. Non-canonical values are also rejected
// so a typo cannot activate diagnostics.
if (app.isPackaged) {
  delete process.env.HORIZON_NATIVE_DIAGNOSTICS;
} else if (
  process.env.HORIZON_NATIVE_DIAGNOSTICS !== undefined
  && process.env.HORIZON_NATIVE_DIAGNOSTICS !== 'true'
) {
  delete process.env.HORIZON_NATIVE_DIAGNOSTICS;
}

const sandboxDecision = resolveSandboxPolicy({
  isPackaged: app.isPackaged,
  nodeEnv: process.env.NODE_ENV,
  envOptIn: process.env.HORIZON_ELECTRON_NO_SANDBOX,
  isDevelopmentFake: process.env.HORIZON_DEVELOPMENT_FAKE === 'true',
});
logger.info('sandbox_policy_resolved', {
  disableSandbox: sandboxDecision.disableSandbox,
  reason: sandboxDecision.reason,
  isPackaged: app.isPackaged,
});
if (sandboxDecision.disableSandbox) {
  for (const s of sandboxDecision.appliedSwitches) app.commandLine.appendSwitch(s);
}

async function createMainWindow(): Promise<BrowserWindow> {
  // Stage 3C-CI-FIX8 §2: canonical runtime layout resolver.
  // FIX7's resolver trusted `app.getAppPath()` and, in the native
  // explicit-main-file launch, that returned `/` — producing
  // `preload_entry_missing:/dist/preload/preload/index.cjs`. This
  // resolver accepts `HORIZON_DESKTOP_ROOT` as the trusted override,
  // falls back to inferring from the bundled main directory, then to
  // `app.getAppPath()` — each candidate validated before use.
  const layout = resolveDesktopRuntimeLayout({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    mainDir: __dirname,
    desktopRootOverride: process.env.HORIZON_DESKTOP_ROOT,
  });
  logger.info('desktop_runtime_layout_resolved', {
    layout: layout.layout,
    applicationRoot: sanitizePreloadPath(layout.applicationRoot),
    main: sanitizePreloadPath(layout.mainEntry),
    preload: sanitizePreloadPath(layout.preloadEntry),
    renderer: sanitizePreloadPath(layout.rendererEntry),
  });

  // Stage 3C-CI-RESET Part 2 Checkpoint E.6 — the ONLY sanctioned way
  // to decide what URL Electron feeds to `win.loadURL(...)`. Packaged
  // builds structurally cannot honour a HORIZON_RENDERER_URL override —
  // a stray env var in a released installer must never cause the
  // privileged preload to load an arbitrary remote origin. Rejection
  // aborts window creation BEFORE any BrowserWindow exists.
  const rendererDecision = resolveRendererUrl({
    isPackaged: app.isPackaged,
    layoutRendererUrl: layout.rendererUrl,
    overrideEnv: process.env.HORIZON_RENDERER_URL,
  });
  if (!rendererDecision.allowed) {
    logger.error('renderer_url_policy_rejected', {
      reason: rendererDecision.reason,
      detail: rendererDecision.detail,
      isPackaged: app.isPackaged,
    });
    throw new Error(`renderer_url_policy_rejected:${rendererDecision.reason}`);
  }
  logger.info('renderer_url_policy_resolved', {
    source: rendererDecision.source,
    isPackaged: app.isPackaged,
  });
  const rendererIndexUrl = rendererDecision.url;
  const config = buildSafeWindowConfig({
    width: 1440,
    height: 900,
    preloadPath: layout.preloadEntry,
    rendererIndexUrl,
    title: 'Horizon Trade',
  });
  const violations = validateWindowConfig(config);
  if (violations.length > 0) throw new Error(`unsafe window config: ${violations.join(', ')}`);
  const win = new BrowserWindow(config);
  await win.loadURL(rendererIndexUrl);
  win.show();
  return win;
}

// Stage 3C-CI-FIX8 §4: fixed test-only diagnostic IPC channel.
// Registered BEFORE `createMainWindow` (called from boot()) so a
// preload marker sent immediately at bridge exposure can never race
// the listener. Structurally disabled in packaged mode; only accepts
// the frozen marker enum; never exposed via `window.horizon`.
const NATIVE_DIAGNOSTIC_MARKERS = new Set([
  'HORIZON_NATIVE_PRELOAD_MODULE_ENTERED',
  'HORIZON_NATIVE_PRELOAD_BRIDGE_EXPOSING',
  'HORIZON_NATIVE_PRELOAD_BRIDGE_EXPOSED',
  'HORIZON_NATIVE_PRELOAD_INITIALIZED',
  'HORIZON_NATIVE_PRELOAD_FAILED',
]);

function nativeDiagnosticsEnabledForMain(): boolean {
  if (app.isPackaged) return false;
  if (process.env.NODE_ENV !== 'test') return false;
  if (process.env.HORIZON_NATIVE_DIAGNOSTICS !== 'true') return false;
  return true;
}

function registerNativeDiagnosticChannel(): void {
  if (!nativeDiagnosticsEnabledForMain()) return;
  const fs = require('node:fs') as typeof import('node:fs');
  ipcMain.on('horizon.nativeDiagnostic', (_evt, raw) => {
    if (!nativeDiagnosticsEnabledForMain()) return;
    if (!raw || typeof raw !== 'object') return;
    const marker = String((raw as { marker?: unknown }).marker ?? '');
    if (!NATIVE_DIAGNOSTIC_MARKERS.has(marker)) return;
    const detailRaw = String((raw as { detail?: unknown }).detail ?? '').slice(0, 500);
    // Strip anything that could carry a secret before persistence.
    const detail = detailRaw
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <REDACTED>')
      .replace(/[A-Fa-f0-9]{32,}/g, '<HEX_REDACTED>');
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      marker,
      detail: detail || null,
      pid: process.pid,
    }) + '\n';
    // Sink path comes from the harness via HORIZON_NATIVE_PRELOAD_LOG_PATH
    // — set immediately before spawning Electron. Packaged builds do not
    // set this env, and would fail the `nativeDiagnosticsEnabledForMain`
    // gate anyway.
    const preloadLogPath = process.env.HORIZON_NATIVE_PRELOAD_LOG_PATH;
    try {
      if (preloadLogPath) {
        fs.mkdirSync(path.dirname(preloadLogPath), { recursive: true });
        fs.appendFileSync(preloadLogPath, line);
      }
    } catch { /* best-effort */ }
    logger.info('native_preload_marker', { marker });
  });
}

async function boot(): Promise<void> {
  const env = resolveDesktopEnvironment();
  const validation = validateDesktopEnvironment(env);
  if (!validation.ok) {
    logger.error('desktop environment invariants violated', { violations: validation.violations });
    dialog.showErrorBox(
      'Horizon Trade cannot start',
      `Environment invariants violated:\n\n${validation.violations.join('\n')}\n\nLive order submission is disabled by design.`,
    );
    app.exit(1);
    return;
  }

  // Stage 1 §13: environment MUST be explicit. NODE_ENV drives it.
  const environment: Environment = (process.env.HORIZON_ENVIRONMENT as Environment | undefined)
    ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  const isPackaged = app.isPackaged;

  // Stage 1 §1: no InMemoryRunner in production; factory enforces it.
  const handles = createServiceAdapters({
    environment,
    serviceMode: env.databaseMode,
    isPackagedBuild: isPackaged,
    developmentFake: process.env.HORIZON_DEVELOPMENT_FAKE === 'true' && !isPackaged,
  });
  if (environment === 'production') assertProductionRunner(handles.runner);

  // Stage 1 §2: resolve runtime assets explicitly.
  const projectRoot = process.env.HORIZON_PROJECT_ROOT
    ?? (isPackaged ? undefined : inferDevProjectRoot(__dirname));
  const assets = resolveRuntimeAssets({
    mode: isPackaged ? 'packaged' : 'development',
    projectRoot,
    packagedResources: isPackaged ? process.resourcesPath : undefined,
    userDataDirectory: app.getPath('userData'),
    logDirectory: app.getPath('logs'),
    reportDirectory: process.env.HORIZON_REPORT_DIR ?? path.join(app.getPath('userData'), 'reports'),
    composeFileName: process.env.HORIZON_COMPOSE_FILE ?? 'docker-compose.prod.yml',
    composeProject: process.env.HORIZON_COMPOSE_PROJECT ?? 'horizon-trade',
  });

  // Stage 3C-CI-FIX9 §1: unified bootstrap-token authority.
  //   - Production / desktop-owned server: mint a fresh 256-bit token
  //     (as always). The desktop is the sole authority.
  //   - Strict unpackaged native-test mode (packaged=false + NODE_ENV=test
  //     + HORIZON_NATIVE_DIAGNOSTICS=true + HORIZON_SERVER_EXTERNAL=true):
  //     IMPORT the token the harness already gave the external server.
  //     This is the ONLY environment in which the desktop accepts an
  //     env-supplied bootstrap token.
  //   - Any other config combination falls through to `mintBootstrapToken`
  //     with no way to reach the import branch.
  const bootstrap = resolveBootstrapTokenAuthority({
    isPackaged: app.isPackaged,
    nodeEnv: process.env.NODE_ENV,
    nativeDiagnostics: process.env.HORIZON_NATIVE_DIAGNOSTICS,
    serverExternal: process.env.HORIZON_SERVER_EXTERNAL,
    envBootstrapToken: process.env.HORIZON_BOOTSTRAP_TOKEN,
  });
  // Non-sensitive diagnostic field — proves via the log which branch
  // was taken. Never logs the token value itself.
  logger.info('bootstrap_token_authority_resolved', { source: bootstrap.source });

  const useKeytar = process.env.HORIZON_USE_KEYTAR === 'true' || isPackaged;
  const secrets: SecretsAdapter = useKeytar ? new KeytarSecretsAdapter() : new InMemorySecretsAdapter();

  // Reader used by the token storage — reads the OS credential value
  // for the given (scope, key) pair; returns null if absent. Kept
  // separate so the SecretsAdapter API doesn't need to leak values.
  const readSecretValue = useKeytar
    ? async (scope: string, key: string): Promise<string | null> => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const kt = await import('keytar').then((m) => m.default ?? m);
        return await (kt as { getPassword: (s: string, a: string) => Promise<string | null> })
          .getPassword('horizon-trade-desktop', `${scope}::${key}`);
      }
    : (() => {
        const memory = new Map<string, string>();
        // In-memory token reader shares state with InMemorySecretsAdapter
        // by intercepting writes.
        const originalStore = secrets.storeCredential.bind(secrets);
        const originalDelete = secrets.deleteCredential.bind(secrets);
        secrets.storeCredential = async (s, k, v) => {
          memory.set(`${s}::${k}`, v);
          return originalStore(s, k, v);
        };
        secrets.deleteCredential = async (s, k) => {
          memory.delete(`${s}::${k}`);
          return originalDelete(s, k);
        };
        return async (scope: string, key: string): Promise<string | null> => memory.get(`${scope}::${key}`) ?? null;
      })();

  const rt = createAdapterRuntime({
    runner: handles.runner,
    serviceMode: env.databaseMode,
    assets,
    mariadbUrl: process.env.HORIZON_MARIADB_URL ?? 'mysql://root:password@127.0.0.1:3306/horizon_trade',
    redisUrl: process.env.HORIZON_REDIS_URL ?? 'redis://127.0.0.1:6379',
    // Stage 1-FIX §4: use the dependency-aware readiness endpoint.
    // The desktop's ServerProcessManager treats `ready=false` as
    // not-ready even though HTTP is 200.
    serverHealthUrl: process.env.HORIZON_SERVER_HEALTH_URL ?? 'http://127.0.0.1:3000/api/system/readiness',
    redisNamespace: 'horizon:*',
  });

  const fingerprintPath = path.join(
    projectRoot ?? process.resourcesPath,
    'apps/server/drizzle/fingerprints/0021_mariadb_fingerprint.json',
  );

  const mariadbAdapter = env.databaseMode === 'managed_docker' ? createMariadbAdapterManaged(rt) : createMariadbAdapterExternal(rt);
  const redisAdapter = env.redisMode === 'managed_docker' ? createRedisAdapterManaged(rt) : createRedisAdapterExternal(rt);
  // Stage 2 §2: pass the bootstrap token to the out-of-process server
  // via its env. (managed_docker: token must be supplied through compose
  // env — deferred to managed_docker_runtime_verification.)
  // Stage 3C-CI-RESET Part 2 Checkpoint E.6 — test-only external-server
  // opt-in decided by a pure policy. The policy structurally rejects the
  // override in packaged mode and any non-canonical env value, so the
  // supervisor can never be silently disabled by a typo or a stray env
  // var in a released installer. Any 'rejected' verdict aborts startup
  // before the supervisor is constructed.
  const externalServerDecision = resolveExternalServerMode({
    isPackaged,
    serverExternalEnv: process.env.HORIZON_SERVER_EXTERNAL,
  });
  if (externalServerDecision.mode === 'rejected') {
    logger.error('external_server_policy_rejected', {
      reason: externalServerDecision.reason,
      detail: externalServerDecision.detail,
      isPackaged,
    });
    throw new Error(`external_server_policy_rejected:${externalServerDecision.reason}`);
  }
  logger.info('external_server_policy_resolved', {
    mode: externalServerDecision.mode,
    reason: externalServerDecision.reason,
    isPackaged,
  });
  const serverExternallyManaged = externalServerDecision.mode === 'external';
  const serverAdapter = serverExternallyManaged
    ? createServerAdapterExternal(rt, fingerprintPath)
    : (env.databaseMode === 'managed_docker'
      ? createServerAdapterManaged(rt, fingerprintPath)
      : createServerAdapterOutOfProcess(rt, fingerprintPath, {
          HORIZON_BOOTSTRAP_TOKEN: bootstrap.envValue,
        }));

  const supervisor = new ServiceSupervisor(
    [
      createDesktopShellAdapter(),
      mariadbAdapter,
      redisAdapter,
      serverAdapter,
      createReconciliationAdapter(rt),
      // Stage 1 §10: scanner readiness is a derived state, not a service.
      createNotImplementedAdapter('scanner_worker', 'runtime_readiness_is_derived_see_scannerReadiness'),
      createNotImplementedAdapter('market_data', 'live_market_data_requires_phase3c'),
      createNotImplementedAdapter('reporting', 'stage4_reports_pending'),
    ],
    logger.child('supervisor'),
    DEFAULT_SUPERVISOR_CONFIG,
  );

  const incidents = new DesktopIncidentSink();

  // Stage 2 §10: authenticated API client + auth manager.
  const serverBaseUrl = new URL('/', rt.input.serverHealthUrl).toString().replace(/\/$/, '');
  const tokenStorage = createAuthTokenStorage({
    adapter: secrets,
    reader: readSecretValue,
    packagedRequiresKeytar: isPackaged,
    isKeytar: useKeytar,
  });

  // eslint-disable-next-line prefer-const
  let authManager!: DesktopAuthManager;
  const apiClient = new AuthenticatedApiClient({
    serverBaseUrl,
    getBootstrapToken: () => bootstrap.headerValue,
    getAccessToken: () => authManager?.currentAccessToken() ?? null,
    onRefreshNeeded: async () => authManager.refreshCallback(),
  });
  authManager = new DesktopAuthManager({
    api: apiClient,
    tokenStorage,
    clientVersion: 'stage2-desktop',
  });
  // Fire-and-forget initialization; failures are captured in the
  // sanitized state and surfaced to the renderer via getState.
  void authManager.initialize().catch((err) => {
    logger.error('auth initialize failed', { err: String(err) });
  });

  const statusSource = new DesktopStatusSource({
    serverHealthUrl: rt.input.serverHealthUrl,
    serverCountersUrl: new URL('/api/desktop/create-order-counters', rt.input.serverHealthUrl).toString(),
    serverPolicyVersionsUrl: new URL('/api/desktop/observer-policy-versions', rt.input.serverHealthUrl).toString(),
    serverChampionUrl: new URL('/api/desktop/champion-configuration', rt.input.serverHealthUrl).toString(),
    fingerprintVersion: process.env.HORIZON_SCHEMA_VERSION ?? '0021',
    getBootstrapToken: () => bootstrap.headerValue,
    getAccessToken: () => authManager.currentAccessToken(),
  });

  const ctx: IpcHostContext = {
    logger: logger.child('ipc'),
    supervisor,
    environment: env,
    credentialStatus: async () =>
      collectCredentialStatuses(secrets, [
        { scope: 'coinbase', key: 'apiKey' },
        { scope: 'coinbase', key: 'apiSecret' },
        { scope: 'session', key: 'admin' },
      ]),
    createOrderCounters: async () => {
      // Stage 1 §12: authoritative source; unknown → zeros with known=false.
      const snap = await statusSource.sample();
      const c = snap.createOrderCounters;
      return { functionInvocations: c.functionInvocations ?? 0, attemptCount: c.attemptCount ?? 0, networkCount: c.networkCount ?? 0 };
    },
    observerPolicyVersions: async () => {
      const snap = await statusSource.sample();
      return snap.observerPolicyVersions ?? {};
    },
    championConfigurationView: async () => {
      const snap = await statusSource.sample();
      return snap.championConfiguration ?? { championVersion: 'unknown' };
    },
    selectExportFolder: async () => {
      const win = BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(win ?? undefined!, {
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    },
    openLogFolder: async () => {
      const err = await shell.openPath(assets.logDirectory);
      return err === '';
    },
    exportReport: async (input) => {
      logger.info('export request received', { kind: input.kind, format: input.format });
      return {
        ok: false,
        artifactPath: null,
        checksum: null,
        reportVersion: 'stage1-report-pending',
        generatedAt: new Date().toISOString(),
        redactionsApplied: ['coinbase_api_key', 'coinbase_api_secret', 'admin_password_hash', 'session_tokens'],
        failureReason: 'stage4_report_generation_not_implemented',
      };
    },
    requestControlledChange: async (input) => {
      logger.info('controlled configuration change requested', {
        key: input.key, operatorActor: input.operatorActor,
      });
      if (input.key === 'serviceMode' && input.proposedValue === 'live') {
        incidents.record({ severity: 'warn', source: 'ipc', code: 'safety_flag_change_refused', message: 'attempt to change safety flag refused' });
        return { ok: false, auditEventId: null, restartRequired: [], failureReason: 'safety_flags_immutable' };
      }
      return { ok: true, auditEventId: 0, restartRequired: ['server'], failureReason: null };
    },
    authManager,
    // Stage 2 §17: authentication is required by default. The env
    // override may DISABLE it only in explicit development/test runs.
    authenticationRequired: process.env.HORIZON_AUTH_REQUIRED === 'false' && !isPackaged ? false : true,
  };

  for (const entry of IPC_ALLOWLIST) {
    ipcMain.handle(entry.channel, async (_event, payload) => handleIpcCall(ctx, entry.channel, payload));
  }
  logger.info('ipc handlers registered', { count: IPC_ALLOWLIST.length });

  // Stage 3C-CI-FIX8 §4: register the test-only diagnostic listener
  // BEFORE any BrowserWindow is created so the preload's very first
  // marker (module-entered) is never lost to a listener race. The
  // registration is a no-op unless strict test diagnostics are on.
  registerNativeDiagnosticChannel();

  await app.whenReady();
  await createMainWindow();
}

app.enableSandbox();

boot().catch((err) => {
  logger.error('boot failed', { err: String(err) });
  app.exit(1);
});
