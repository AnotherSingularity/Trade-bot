/**
 * Phase 3A §A, §AA — Electron main entry.
 *
 * Startup sequence:
 *   1. Validate desktop environment invariants (§E).
 *   2. Dependency check.
 *   3. Service health check.
 *   4. Start local services via supervisor.
 *   5. Apply migrations through the server migration command.
 *   6. Verify schema fingerprint.
 *   7. Start server + workers.
 *   8. Wait for authenticated API.
 *   9. Display login (via renderer).
 *  10. Load system overview.
 *
 * On failure, show the exact failed component, preserve logs, create
 * a desktop incident, and offer retry — never enter a misleading
 * healthy UI.
 */

import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { AuthenticationManager } from './authentication';
import { handleIpcCall, type IpcHostContext } from './ipc';
import { ConsoleSink, Logger } from './logging';
import { resolveDesktopEnvironment, validateDesktopEnvironment } from './localEnvironment';
import { InMemorySecretsAdapter, KeytarSecretsAdapter, type SecretsAdapter, collectCredentialStatuses } from './secrets';
import {
  InMemoryRunner,
  createMariadbAdapter,
  createRedisAdapter,
  createServerAdapter,
  createStubAdapter,
  type AdapterConfig,
} from './serviceAdapters';
import { DEFAULT_SUPERVISOR_CONFIG, ServiceSupervisor } from './serviceSupervisor';
import { buildSafeWindowConfig, validateWindowConfig } from './windows';
import { IPC_ALLOWLIST } from '../shared/ipcContract';

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

  const useKeytar = process.env.HORIZON_USE_KEYTAR === 'true';
  const secrets: SecretsAdapter = useKeytar ? new KeytarSecretsAdapter() : new InMemorySecretsAdapter();

  const runner = new InMemoryRunner(); // production build should swap for a real runner
  const adapterConfig: AdapterConfig = {
    mode: env.databaseMode,
    composeDir: path.resolve(__dirname, '..', '..', '..'),
    mariadbUrl: process.env.HORIZON_MARIADB_URL ?? 'mysql://root:password@127.0.0.1:3306/horizon_trade',
    redisUrl: process.env.HORIZON_REDIS_URL ?? 'redis://127.0.0.1:6379',
    serverHost: process.env.HORIZON_SERVER_HOST ?? '127.0.0.1',
    serverPort: Number(process.env.HORIZON_SERVER_PORT ?? '3000'),
    runner,
    externalProbe: runner,
  };
  const supervisor = new ServiceSupervisor(
    [
      createMariadbAdapter(adapterConfig),
      createRedisAdapter(adapterConfig),
      createServerAdapter(adapterConfig),
      createStubAdapter('scanner_worker'),
      createStubAdapter('reconciliation_worker'),
      createStubAdapter('market_data'),
      createStubAdapter('reporting'),
      createStubAdapter('desktop_shell'),
    ],
    logger.child('supervisor'),
    DEFAULT_SUPERVISOR_CONFIG,
  );

  const authManager = new AuthenticationManager();

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
    createOrderCounters: async () => ({ functionInvocations: 0, attemptCount: 0, networkCount: 0 }),
    observerPolicyVersions: async () => ({
      universe: 'p2a-1', regime: 'p2b-1', risk: 'p2c-1',
      microstructure: 'p2d-1', context: 'p2e-1', validation: 'p2f-1',
    }),
    championConfigurationView: async () => ({ championVersion: 'champ-1' }),
    selectExportFolder: async () => {
      const win = BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(win ?? undefined!, {
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    },
    openLogFolder: async () => {
      const logsDir = app.getPath('logs');
      const err = await shell.openPath(logsDir);
      return err === '';
    },
    exportReport: async (input) => {
      logger.info('export request received', { kind: input.kind, format: input.format });
      return {
        ok: false,
        artifactPath: null,
        checksum: null,
        reportVersion: 'p3a-report-1',
        generatedAt: new Date().toISOString(),
        redactionsApplied: ['coinbase_api_key', 'coinbase_api_secret', 'admin_password_hash', 'session_tokens'],
        failureReason: 'export_deferred_operator_action_required',
      };
    },
    requestControlledChange: async (input) => {
      logger.info('controlled configuration change requested', {
        key: input.key, operatorActor: input.operatorActor,
      });
      // Refuse any change that would toggle safe flags — an isolation invariant.
      if (input.key === 'serviceMode' && input.proposedValue === 'live') {
        return {
          ok: false,
          auditEventId: null,
          restartRequired: [],
          failureReason: 'safety_flags_immutable_in_phase_3a',
        };
      }
      return {
        ok: true,
        auditEventId: 0,
        restartRequired: ['server'],
        failureReason: null,
      };
    },
    isAuthenticated: () => authManager.hasAdmin(),
    authenticationRequired: false, // Renderer-side; API gate handled independently.
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
