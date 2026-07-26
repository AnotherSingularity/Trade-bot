import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db';
import {
  adapterSelections,
  soakDailyReports,
  soakIncidents,
  soakPreflightRuns,
  soakRuns,
} from '../src/db/schema';
import { ensureInitialFund, updateBotConfig } from '../src/db/queries';
import { installFetchBarrier, resetHttpCounters } from '../src/lib/fetchBarrier';
import { selectProviders, lastAdapterSelection } from '../src/market_data/providerFactory';
import {
  MINIMUM_PREFLIGHT_SECONDS,
  recordPreflight,
} from '../src/soak/preflight';
import { SOAK_REQUIRED_DURATION_MS, startSoak, loadSoakRun, failSoak, resetRequired } from '../src/soak/soakRunner';
import {
  classifyIncident,
  countInvalidatingIncidents,
  recordIncident,
} from '../src/soak/incidents';
import { certifySoak } from '../src/soak/certification';
import { MockWebSocketProvider } from '../src/market_data/streams';
import { InMemoryRestClient } from '../src/market_data/bootstrap';
import { resetDatabase } from './setup/db';

/**
 * Phase 1.2-OPS — tests for the operational soak scaffolding.
 * The tests do NOT execute a real seven-day soak; instead they prove
 * that the module refuses to mint a `phase1_2_pass` verdict unless
 * seven real calendar days have elapsed against production providers
 * with zero soak-invalidating incidents.
 */

beforeEach(async () => {
  await resetDatabase();
  await ensureInitialFund(true, 10_000);
  await updateBotConfig({ reconciliationStatus: 'ok' });
  installFetchBarrier();
  resetHttpCounters();
});

// ═══════════════════════════════════════════════════════════════════════════
// Provider factory
// ═══════════════════════════════════════════════════════════════════════════
describe('Provider factory', () => {
  it('soak intent binds production providers by default', async () => {
    const s = await selectProviders({ intent: 'soak' });
    expect(s.isProduction).toBe(true);
    expect(s.soakEligible).toBe(true);
    expect(s.refusedReason).toBeNull();
    expect(s.webSocketProviderName).toBe('CoinbaseAdvancedTradeStreamProvider');
    expect(s.restClientName).toBe('CoinbasePublicRestClient');
  });

  it('test intent with mock override binds mocks + refuses soak eligibility', async () => {
    const s = await selectProviders({
      intent: 'test',
      testOverride: {
        webSocket: new MockWebSocketProvider(),
        rest: new InMemoryRestClient(new Map(), new Map()),
      },
    });
    expect(s.isProduction).toBe(false);
    expect(s.soakEligible).toBe(false);
  });

  it('audit row records the concrete provider names + isProduction', async () => {
    await selectProviders({ intent: 'soak' });
    const row = await lastAdapterSelection();
    expect(row).not.toBeNull();
    expect(row!.webSocketProvider).toBe('CoinbaseAdvancedTradeStreamProvider');
    expect(row!.restClient).toBe('CoinbasePublicRestClient');
    expect(row!.isProduction).toBe(true);
  });

  it('mock provider inside a soak intent is refused by the runner', async () => {
    const preflight = await recordPreflight({
      startedAt: new Date(Date.now() - (MINIMUM_PREFLIGHT_SECONDS + 60) * 1000),
      completedAt: new Date(),
      connectionHealthy: true,
      heartbeatsContinuous: true,
      productsBootstrapped: 32,
      productsFailed: 0,
      candleHistoryOrdered: true,
      scannerReadsLiveState: true,
      scheduledManualSameSource: true,
      feeTierRetrievalOk: true,
      previewSucceededOrFailedClosed: true,
      productMetadataFresh: true,
      dataGapsPersisted: true,
      reconnectWorks: true,
      restartRestoresState: true,
    });
    expect(preflight.passed).toBe(true);
    const providers = await selectProviders({
      intent: 'test',
      testOverride: {
        webSocket: new MockWebSocketProvider(),
        rest: new InMemoryRestClient(new Map(), new Map()),
      },
    });
    const start = await startSoak({
      soakRunId: 'soak-mock-refused',
      commitHash: 'deadbeef' + '0'.repeat(32),
      deploymentId: 'dep-mock',
      startedAt: new Date(),
      productUniverse: ['AAVE-USD'],
      schemaFingerprint: 'fp-1',
      safeFlagsSnapshot: { DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'SHADOW_LIVE' },
      preflight: preflight.row,
      providers,
    });
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.reason).toBe('mock_provider_active');
    // Incident row proves the refusal was recorded for audit.
    const incidents = await db.select().from(soakIncidents).where(eq(soakIncidents.incidentKind, 'mock_provider_active'));
    expect(incidents.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Preflight harness
// ═══════════════════════════════════════════════════════════════════════════
describe('Preflight harness', () => {
  it('fails a preflight shorter than the required minimum', async () => {
    const r = await recordPreflight({
      startedAt: new Date(Date.now() - 60_000), // 1 minute
      completedAt: new Date(),
      connectionHealthy: true, heartbeatsContinuous: true,
      productsBootstrapped: 32, productsFailed: 0,
      candleHistoryOrdered: true, scannerReadsLiveState: true,
      scheduledManualSameSource: true, feeTierRetrievalOk: true,
      previewSucceededOrFailedClosed: true, productMetadataFresh: true,
      dataGapsPersisted: true, reconnectWorks: true, restartRestoresState: true,
    });
    expect(r.passed).toBe(false);
    expect(r.failureReasons.some((x) => x.startsWith('preflight_too_short'))).toBe(true);
  });

  it('fails a preflight if any required check is false', async () => {
    const r = await recordPreflight({
      startedAt: new Date(Date.now() - (MINIMUM_PREFLIGHT_SECONDS + 60) * 1000),
      completedAt: new Date(),
      connectionHealthy: false, // ← fails
      heartbeatsContinuous: true,
      productsBootstrapped: 32, productsFailed: 0,
      candleHistoryOrdered: true, scannerReadsLiveState: true,
      scheduledManualSameSource: true, feeTierRetrievalOk: true,
      previewSucceededOrFailedClosed: true, productMetadataFresh: true,
      dataGapsPersisted: true, reconnectWorks: true, restartRestoresState: true,
    });
    expect(r.passed).toBe(false);
    expect(r.failureReasons).toContain('connection_not_healthy');
  });

  it('passes when every check is true and counters are zero', async () => {
    const r = await recordPreflight({
      startedAt: new Date(Date.now() - (MINIMUM_PREFLIGHT_SECONDS + 60) * 1000),
      completedAt: new Date(),
      connectionHealthy: true, heartbeatsContinuous: true,
      productsBootstrapped: 32, productsFailed: 0,
      candleHistoryOrdered: true, scannerReadsLiveState: true,
      scheduledManualSameSource: true, feeTierRetrievalOk: true,
      previewSucceededOrFailedClosed: true, productMetadataFresh: true,
      dataGapsPersisted: true, reconnectWorks: true, restartRestoresState: true,
    });
    expect(r.passed).toBe(true);
    expect(r.failureReasons.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Soak-run lifecycle
// ═══════════════════════════════════════════════════════════════════════════
describe('Soak-run lifecycle', () => {
  async function passingPreflight(): Promise<typeof soakPreflightRuns.$inferSelect> {
    const r = await recordPreflight({
      startedAt: new Date(Date.now() - (MINIMUM_PREFLIGHT_SECONDS + 60) * 1000),
      completedAt: new Date(),
      connectionHealthy: true, heartbeatsContinuous: true,
      productsBootstrapped: 32, productsFailed: 0,
      candleHistoryOrdered: true, scannerReadsLiveState: true,
      scheduledManualSameSource: true, feeTierRetrievalOk: true,
      previewSucceededOrFailedClosed: true, productMetadataFresh: true,
      dataGapsPersisted: true, reconnectWorks: true, restartRestoresState: true,
    });
    return r.row;
  }

  it('startSoak requires safe flags to be set correctly', async () => {
    const preflight = await passingPreflight();
    const providers = await selectProviders({ intent: 'soak' });
    const r = await startSoak({
      soakRunId: 'soak-safe-fail',
      commitHash: '0'.repeat(40),
      deploymentId: 'dep-1',
      startedAt: new Date(),
      productUniverse: ['AAVE-USD'],
      schemaFingerprint: 'fp-1',
      safeFlagsSnapshot: { DRY_RUN: false, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'SHADOW_LIVE' },
      preflight,
      providers,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('safe_flags_incorrect');
  });

  it('startSoak transitions preflight → running atomically', async () => {
    const preflight = await passingPreflight();
    const providers = await selectProviders({ intent: 'soak' });
    const r = await startSoak({
      soakRunId: 'soak-ok-1',
      commitHash: '0'.repeat(40),
      deploymentId: 'dep-1',
      startedAt: new Date(),
      productUniverse: ['AAVE-USD'],
      schemaFingerprint: 'fp-1',
      safeFlagsSnapshot: { DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'SHADOW_LIVE' },
      preflight,
      providers,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.status).toBe('running');
      expect(r.row.verdict).toBe('pending');
      const persisted = await loadSoakRun('soak-ok-1');
      expect(persisted!.status).toBe('running');
    }
  });

  it('failSoak sets status=failed + verdict=soak_failed', async () => {
    const preflight = await passingPreflight();
    const providers = await selectProviders({ intent: 'soak' });
    await startSoak({
      soakRunId: 'soak-fail-1',
      commitHash: '0'.repeat(40),
      deploymentId: 'dep-1',
      startedAt: new Date(),
      productUniverse: ['AAVE-USD'],
      schemaFingerprint: 'fp-1',
      safeFlagsSnapshot: { DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'SHADOW_LIVE' },
      preflight,
      providers,
    });
    await failSoak('soak-fail-1', 'test-forced-failure');
    const row = await loadSoakRun('soak-fail-1');
    expect(row!.status).toBe('failed');
    expect(row!.verdict).toBe('soak_failed');
  });

  it('resetRequired records an undocumented_deployment incident', async () => {
    const preflight = await passingPreflight();
    const providers = await selectProviders({ intent: 'soak' });
    await startSoak({
      soakRunId: 'soak-reset-1',
      commitHash: '0'.repeat(40),
      deploymentId: 'dep-1',
      startedAt: new Date(),
      productUniverse: ['AAVE-USD'],
      schemaFingerprint: 'fp-1',
      safeFlagsSnapshot: { DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'SHADOW_LIVE' },
      preflight,
      providers,
    });
    await resetRequired('soak-reset-1', 'deploy without documentation');
    const row = await loadSoakRun('soak-reset-1');
    expect(row!.status).toBe('reset_required');
    const incidents = await db
      .select()
      .from(soakIncidents)
      .where(and(eq(soakIncidents.soakRunId, 'soak-reset-1'), eq(soakIncidents.incidentKind, 'undocumented_deployment')));
    expect(incidents.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Incident classification
// ═══════════════════════════════════════════════════════════════════════════
describe('Incident classification', () => {
  it('classifies safe_flag_change as soak_invalidating', () => {
    expect(classifyIncident('safe_flag_change')).toBe('soak_invalidating');
  });
  it('classifies mock_provider_active as soak_invalidating', () => {
    expect(classifyIncident('mock_provider_active')).toBe('soak_invalidating');
  });
  it('classifies websocket_outage as product_degraded', () => {
    expect(classifyIncident('websocket_outage')).toBe('product_degraded');
  });
  it('classifies process_restart as informational', () => {
    expect(classifyIncident('process_restart')).toBe('informational');
  });
  it('countInvalidatingIncidents sums soak_invalidating rows for a run', async () => {
    await recordIncident({ soakRunId: 'cnt-1', incidentKind: 'safe_flag_change', detectedAt: new Date() });
    await recordIncident({ soakRunId: 'cnt-1', incidentKind: 'websocket_outage', detectedAt: new Date() });
    const c = await countInvalidatingIncidents('cnt-1');
    expect(c).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Final certification — the honest verdict enforcement
// ═══════════════════════════════════════════════════════════════════════════
describe('Certification verdict enforcement', () => {
  async function seedRun(id: string, startedAt: Date, safe = true): Promise<void> {
    await db.insert(soakRuns).values({
      soakRunId: id,
      commitHash: '0'.repeat(40),
      deploymentId: 'dep-cert',
      startedAt,
      requiredEndAt: new Date(startedAt.getTime() + SOAK_REQUIRED_DURATION_MS),
      strategyVersion: 'v', marketDataVersion: 'v', fillModelVersion: 'v',
      costModelVersion: 'v', protectionPolicyVersion: 'v',
      schemaFingerprint: 'fp-cert',
      safeFlagsSnapshot: JSON.stringify(safe ? { DRY_RUN: true, ORDER_SUBMISSION_ENABLED: false, SIMULATION_MODE: 'SHADOW_LIVE' } : {}),
      productUniverseHash: 'h', status: 'running', verdict: 'pending',
    });
  }

  it('refuses phase1_2_pass when < 7 calendar days elapsed', async () => {
    const started = new Date(Date.now() - 24 * 3600 * 1000);
    await seedRun('cert-short', started);
    const report = await certifySoak({
      soakRunId: 'cert-short',
      now: new Date(),
      counterOverride: {
        createOrderFunctionInvocations: 0,
        createOrderAttemptCount: 0,
        createOrderNetworkCount: 0,
      },
    });
    expect(report.verdict).toBe('soak_failed');
    expect(report.verdictReason).toMatch(/insufficient_calendar_days/);
  });

  it('refuses phase1_2_pass when any soak_invalidating incident exists', async () => {
    const started = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await seedRun('cert-invalidated', started);
    await recordIncident({
      soakRunId: 'cert-invalidated',
      incidentKind: 'safe_flag_change',
      detectedAt: new Date(),
    });
    const report = await certifySoak({
      soakRunId: 'cert-invalidated',
      now: new Date(),
      counterOverride: {
        createOrderFunctionInvocations: 0,
        createOrderAttemptCount: 0,
        createOrderNetworkCount: 0,
      },
    });
    expect(report.verdict).toBe('soak_failed');
    expect(report.verdictReason).toMatch(/invalidating_incidents/);
  });

  it('refuses phase1_2_pass when a mock provider was ever bound to the run', async () => {
    const started = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await seedRun('cert-mock', started);
    await db.insert(adapterSelections).values({
      soakRunId: 'cert-mock',
      boundAt: new Date(),
      webSocketProvider: 'MockWebSocketProvider',
      restClient: 'InMemoryRestClient',
      authClient: 'x', redisClient: 'x', dbDriver: 'x',
      isProduction: false,
    });
    const report = await certifySoak({
      soakRunId: 'cert-mock',
      now: new Date(),
      counterOverride: {
        createOrderFunctionInvocations: 0,
        createOrderAttemptCount: 0,
        createOrderNetworkCount: 0,
      },
    });
    expect(report.verdict).toBe('soak_failed');
    expect(report.verdictReason).toMatch(/mock_provider_bound/);
  });

  it('refuses phase1_2_pass when any Create Order counter is non-zero', async () => {
    const started = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await seedRun('cert-ord', started);
    const report = await certifySoak({
      soakRunId: 'cert-ord',
      now: new Date(),
      counterOverride: {
        createOrderFunctionInvocations: 0,
        createOrderAttemptCount: 1,
        createOrderNetworkCount: 0,
      },
    });
    expect(report.verdict).toBe('soak_failed');
    expect(report.verdictReason).toMatch(/createOrderAttemptCount/);
  });

  it('emits phase1_2_pass when every invariant holds', async () => {
    const started = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await seedRun('cert-pass', started);
    // Seed 8 daily reports covering the elapsed days.
    for (let d = 0; d < 8; d++) {
      const reportDate = new Date(started.getTime() + d * 24 * 3600 * 1000);
      await db.insert(soakDailyReports).values({
        soakRunId: 'cert-pass',
        reportDate,
        windowStart: reportDate,
        windowEnd: new Date(reportDate.getTime() + 24 * 3600 * 1000),
        uptimeSeconds: 86_400,
        reconciliationStatus: 'ok',
        protectionStatus: 'ok',
      });
    }
    const report = await certifySoak({
      soakRunId: 'cert-pass',
      now: new Date(),
      counterOverride: {
        createOrderFunctionInvocations: 0,
        createOrderAttemptCount: 0,
        createOrderNetworkCount: 0,
      },
    });
    expect(report.verdict).toBe('phase1_2_pass');
    expect(report.verdictReason).toBe('all_invariants_met');
    expect(report.calendarDays).toBeGreaterThanOrEqual(7);
    expect(report.weekendIncluded).toBe(true);
  });

  it('verdict enum in the DB does NOT contain ready_for_live_capital', async () => {
    const rows = (await db.execute(
      `SELECT COLUMN_TYPE FROM information_schema.columns
        WHERE table_schema=DATABASE() AND table_name='soak_runs' AND column_name='verdict'`,
    )) as unknown as [{ COLUMN_TYPE: string }[], unknown];
    const arr = Array.isArray(rows[0]) ? rows[0] : (rows as unknown as { COLUMN_TYPE: string }[]);
    expect(arr[0]!.COLUMN_TYPE).not.toMatch(/ready_for_live_capital/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration + snapshot integrity
// ═══════════════════════════════════════════════════════════════════════════
describe('P1.2-OPS migration integrity', () => {
  it('0013 snapshot + fingerprint on disk', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(existsSync(join(process.cwd(), 'drizzle', 'migrations', 'meta', '0013_snapshot.json'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'drizzle', 'fingerprints', '0013_mariadb_fingerprint.json'))).toBe(true);
  });

  it('all 5 P1.2-OPS tables exist', async () => {
    const rows = (await db.execute(
      `SELECT COUNT(*) AS c FROM information_schema.tables
        WHERE table_schema=DATABASE() AND table_name IN
        ('soak_runs','soak_daily_reports','soak_incidents','adapter_selections','soak_preflight_runs')`,
    )) as unknown as [{ c: number }[], unknown];
    const arr = Array.isArray(rows[0]) ? rows[0] : (rows as unknown as { c: number }[]);
    expect(Number(arr[0]?.c)).toBe(5);
  });
});
