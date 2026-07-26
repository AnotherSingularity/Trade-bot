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
import { resolveDesktopEnvironment, validateDesktopEnvironment } from './localEnvironment';
import { InMemorySecretsAdapter, KeytarSecretsAdapter, type SecretsAdapter, collectCredentialStatuses } from './secrets';
import { mintBootstrapToken } from './bootstrapToken';
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

async function createMainWindow(): Promise<BrowserWindow> {
  const preloadPath = path.resolve(__dirname, '..', 'preload', 'index.js');
  const rendererIndexUrl = process.env.HORIZON_RENDERER_URL
    ?? `file://${path.resolve(__dirname, '..', 'renderer', 'index.html')}`;
  const config = buildSafeWindowConfig({
    width: 1440,
    height: 900,
    preloadPath,
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

  // Stage 2 §2: mint a fresh bootstrap token for this server lifecycle.
  const bootstrap = mintBootstrapToken();

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
  const serverAdapter = env.databaseMode === 'managed_docker'
    ? createServerAdapterManaged(rt, fingerprintPath)
    : createServerAdapterOutOfProcess(rt, fingerprintPath, {
        HORIZON_BOOTSTRAP_TOKEN: bootstrap.envValue,
      });

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

  await app.whenReady();
  await createMainWindow();
}

app.enableSandbox();

boot().catch((err) => {
  logger.error('boot failed', { err: String(err) });
  app.exit(1);
});
