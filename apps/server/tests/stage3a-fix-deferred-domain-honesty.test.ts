/**
 * Stage 3A verification correction §3 — deferred-domain honesty.
 *
 * The 14 domain query services fleshed out in Stage 3B currently return
 * placeholder envelopes. This test locks in that they:
 *
 *   - use `status ∈ {degraded, empty, unavailable}` (never `healthy`),
 *   - carry a specific `reasonCode` explaining WHY the payload is
 *     absent,
 *   - carry a `sourceVersion` of the form `<domain>.v0-stub` so an
 *     auditor can see at a glance that no real query is running,
 *   - never return fabricated sample values as database truth
 *     (measurement values remain `null`, list items empty),
 *   - do not report renderer_binding_complete (they are NOT counted
 *     as Stage 3A screen completion).
 *
 * The four Stage-3A-real domains (overview, portfolio, positions,
 * decisions) are covered by their own tests; this file focuses on the
 * remaining fourteen domain query functions.
 *
 * These are pure JavaScript checks — no DB needed.
 */

import { describe, expect, it } from 'vitest';
import {
  DESKTOP_CONTRACT_VERSION,
  DESKTOP_DATA_RESPONSE_SCHEMAS,
  type DesktopDataRequestKey,
} from '@horizon/shared';
import {
  acknowledgeIncident,
  getConfiguration,
  getContext,
  getCosts,
  getMicrostructure,
  getProtection,
  getRegimes,
  getReports,
  getRisk,
  getSafety,
  getSystem,
  getValidation,
  listFingerprints,
  listIncidents,
  listReconciliation,
  listUniverse,
} from '../src/desktop/queries/stubs';

interface Envelope {
  contractVersion: typeof DESKTOP_CONTRACT_VERSION;
  status: string;
  data: unknown;
  reasonCode?: string;
  sourceVersion?: string;
}

/**
 * The 14 deferred domains. `configuration`, `system`, `safety`, and
 * `reports` are functional in Stage 3A: they surface sanitized config,
 * process metadata, safe-flag confirmations, and the report catalog
 * with `generationImplemented: false`. Their honesty is asserted
 * separately in section B.
 */
const STAGE3B_DEFERRED: Array<{
  key: DesktopDataRequestKey;
  call: () => Promise<Envelope>;
  expectedReasonPrefix: string;
}> = [
  { key: 'universe.list',       call: () => listUniverse(undefined) as Promise<Envelope>,       expectedReasonPrefix: 'universe' },
  { key: 'fingerprints.list',   call: () => listFingerprints(undefined) as Promise<Envelope>,   expectedReasonPrefix: 'fingerprints' },
  { key: 'regimes.get',         call: () => getRegimes() as Promise<Envelope>,                  expectedReasonPrefix: 'regimes' },
  { key: 'risk.get',            call: () => getRisk() as Promise<Envelope>,                     expectedReasonPrefix: 'risk' },
  { key: 'microstructure.get',  call: () => getMicrostructure() as Promise<Envelope>,           expectedReasonPrefix: 'microstructure' },
  { key: 'context.get',         call: () => getContext() as Promise<Envelope>,                  expectedReasonPrefix: 'context' },
  { key: 'validation.get',      call: () => getValidation(undefined) as Promise<Envelope>,      expectedReasonPrefix: 'validation' },
  { key: 'costs.get',           call: () => getCosts() as Promise<Envelope>,                    expectedReasonPrefix: 'costs' },
  { key: 'protection.get',      call: () => getProtection() as Promise<Envelope>,               expectedReasonPrefix: 'protection' },
  { key: 'reconciliation.list', call: () => listReconciliation(undefined) as Promise<Envelope>, expectedReasonPrefix: 'reconciliation' },
  { key: 'incidents.list',      call: () => listIncidents(undefined) as Promise<Envelope>,      expectedReasonPrefix: 'incidents' },
];

describe('Stage 3A-FIX §3 — deferred-domain query services are honest', () => {
  it('every Stage 3B-deferred domain returns status ∈ {degraded, empty, unavailable} — NEVER healthy', async () => {
    for (const d of STAGE3B_DEFERRED) {
      const env = await d.call();
      expect(env.status).not.toBe('healthy');
      expect(['degraded', 'empty', 'unavailable']).toContain(env.status);
    }
  });

  it('every Stage 3B-deferred domain carries a specific `reasonCode` prefixed by the domain name', async () => {
    for (const d of STAGE3B_DEFERRED) {
      const env = await d.call();
      expect(env.reasonCode, `${d.key} must have reasonCode`).toBeTruthy();
      expect(env.reasonCode!.startsWith(d.expectedReasonPrefix), `${d.key}: expected reason to start with '${d.expectedReasonPrefix}' but got '${env.reasonCode}'`).toBe(true);
      expect(env.reasonCode!.includes('stage3b_pending')).toBe(true);
    }
  });

  it('every Stage 3B-deferred domain carries a `<domain>.v0-stub` sourceVersion', async () => {
    for (const d of STAGE3B_DEFERRED) {
      const env = await d.call();
      expect(env.sourceVersion, `${d.key} must have sourceVersion`).toBeTruthy();
      expect(env.sourceVersion!.endsWith('.v0-stub'), `${d.key}: expected sourceVersion to end with '.v0-stub' but got '${env.sourceVersion}'`).toBe(true);
    }
  });

  it('list domains return empty items — no fabricated sample rows', async () => {
    const universe = await listUniverse(undefined);
    expect(universe.data?.items).toEqual([]);
    expect(universe.data?.nextCursor).toBeNull();
    const fingerprints = await listFingerprints(undefined);
    expect(fingerprints.data?.items).toEqual([]);
    const reconciliation = await listReconciliation(undefined);
    expect(reconciliation.data?.items).toEqual([]);
    const incidents = await listIncidents(undefined);
    expect(incidents.data?.items).toEqual([]);
  });

  it('measurement-carrying stubs (risk, context) have unknown measurements with reasons', async () => {
    const risk = await getRisk();
    expect(risk.data?.candidateStopRisk.status).toBe('unknown');
    expect(risk.data?.candidateStopRisk.value).toBeNull();
    expect(risk.data?.candidateStopRisk.reasonCode).toContain('stage3b_pending');
    expect(risk.data?.volatilityMultiplier.status).toBe('unknown');
    expect(risk.data?.volatilityMultiplier.value).toBeNull();
    const context = await getContext();
    expect(context.data?.ensembleMultiplier.status).toBe('unknown');
    expect(context.data?.ensembleMultiplier.value).toBeNull();
  });

  it('risk + validation stubs preserve the safety literals (kelly=false, promotion=false, observerEnforcement=false)', async () => {
    const risk = await getRisk();
    expect(risk.data?.kellyEnabled).toBe(false);
    expect(risk.data?.observerEnforcementActive).toBe(false);
    const validation = await getValidation(undefined);
    expect(validation.data?.kellyEnabled).toBe(false);
    expect(validation.data?.promotionEnabled).toBe(false);
    const microstructure = await getMicrostructure();
    expect(microstructure.data?.productionLevel2Active).toBe(false);
    expect(microstructure.data?.queuePositionKnown).toBe(false);
  });

  it('incidents.acknowledge mutation refuses in Stage 3A with unavailable status', async () => {
    const env = await acknowledgeIncident({ incidentId: 'test' });
    expect(env.status).toBe('unavailable');
    expect(env.reasonCode).toContain('stage3b_pending');
  });

  it('reports.get returns catalog + generationImplemented=false (Stage 4 pending)', async () => {
    const env = await getReports();
    expect(env.status).toBe('empty');
    expect(env.data?.generationImplemented).toBe(false);
    expect(env.data?.catalog.length).toBeGreaterThan(0);
    for (const entry of env.data!.catalog) {
      expect(entry.generationAvailable).toBe(false);
      expect(entry.reasonCode).toContain('stage4_pending');
    }
    expect(env.data?.history.items).toEqual([]);
  });

  it('configuration/system/safety functional stubs return correct safe-flag literals', async () => {
    const cfg = await getConfiguration();
    expect(cfg.status).toBe('healthy');
    expect(cfg.data?.safeFlags.DRY_RUN).toBe(true);
    expect(cfg.data?.safeFlags.ORDER_SUBMISSION_ENABLED).toBe(false);
    expect(cfg.data?.safeFlags.liveOrderSubmissionDisabled).toBe(true);
    expect(cfg.data?.safetyCriticalReadOnly).toBe(true);
    const sys = await getSystem();
    expect(sys.status).toBe('healthy');
    expect(sys.data?.desktopVersion).toBeDefined();
    // system.get returns process env node version — do not leak
    // credentials, connection strings, or paths.
    expect(JSON.stringify(sys.data)).not.toContain('DATABASE_URL');
    expect(JSON.stringify(sys.data)).not.toContain('mysql://');
    expect(JSON.stringify(sys.data)).not.toContain('password');
    const safety = await getSafety();
    expect(safety.status).toBe('healthy');
    expect(safety.data?.safeFlags.DRY_RUN).toBe(true);
    expect(safety.data?.observerEnforcementActive).toBe(false);
    expect(safety.data?.promotionEnabled).toBe(false);
    expect(safety.data?.kellyEnabled).toBe(false);
    expect(safety.data?.liveCapitalAuthorized).toBe(false);
    expect(safety.data?.createOrderCounters.functionInvocations).toBe(0);
    expect(safety.data?.createOrderCounters.attemptCount).toBe(0);
    expect(safety.data?.createOrderCounters.networkCount).toBe(0);
  });

  it('every deferred domain envelope passes its published schema (contract discipline)', async () => {
    for (const d of STAGE3B_DEFERRED) {
      const env = await d.call();
      const schema = DESKTOP_DATA_RESPONSE_SCHEMAS[d.key];
      const parsed = schema.safeParse(env);
      expect(parsed.success, `${d.key} envelope failed its schema: ${JSON.stringify(parsed).slice(0, 200)}`).toBe(true);
    }
    // The four functional stubs.
    for (const [k, fn] of [
      ['reports.get', getReports],
      ['configuration.get', getConfiguration],
      ['system.get', getSystem],
      ['safety.get', getSafety],
    ] as const) {
      const env = await fn();
      const schema = DESKTOP_DATA_RESPONSE_SCHEMAS[k as DesktopDataRequestKey];
      const parsed = schema.safeParse(env);
      expect(parsed.success, `${k} envelope failed its schema: ${JSON.stringify(parsed).slice(0, 200)}`).toBe(true);
    }
  });
});
