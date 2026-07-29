/**
 * Stage 5C — Managed-Docker readiness evidence emitter tests.
 *
 * Pure — feeds hand-crafted OrchestrationResult objects to the
 * builder and asserts the shape + sanitization + totals.
 */
import { describe, expect, it } from 'vitest';
import type { OrchestrationResult } from '../../src/main/managedDockerOrchestrator';
import {
  buildManagedRuntimeReadinessReport,
  phasesEnteredInOrder,
  sanitizeDetail,
  serializeReadinessReport,
  type ManagedRuntimeEnvironmentStamp,
} from '../../src/main/managedDockerEvidence';

const ENV: ManagedRuntimeEnvironmentStamp = {
  runtimeMode: 'managed_docker',
  packaged: false,
  nodeEnv: 'test',
  desktopVersion: '3.0.0',
  installationIdHash: 'installhashabc',
  hostOs: 'linux',
  hostArch: 'x64',
};

function successResult(): OrchestrationResult {
  return {
    ok: true,
    phase: 'supervise_ready',
    failureCode: null,
    detail: null,
    provisionedContainers: ['mariadb', 'redis'],
    events: [
      { timestampMs: 0, phase: 'preflight', code: 'phase_start', detail: 'project=horizon' },
      { timestampMs: 400, phase: 'preflight', code: 'phase_ok', detail: 'all preflight checks passed' },
      { timestampMs: 500, phase: 'provision', code: 'phase_start', detail: 'containers=2' },
      { timestampMs: 2_000, phase: 'provision', code: 'phase_ok', detail: 'provisioned=mariadb,redis' },
      { timestampMs: 2_100, phase: 'readiness_wait', code: 'phase_start', detail: 'poll_ms=1000' },
      { timestampMs: 12_500, phase: 'readiness_wait', code: 'phase_ok', detail: 'all containers ready' },
    ],
  };
}

function failResult(): OrchestrationResult {
  return {
    ok: false,
    phase: 'provision',
    failureCode: 'container_not_labelled_owner_horizon',
    detail: 'mariadb: owner=<unset>',
    provisionedContainers: [],
    events: [
      { timestampMs: 0, phase: 'preflight', code: 'phase_start', detail: 'project=horizon' },
      { timestampMs: 300, phase: 'preflight', code: 'phase_ok', detail: 'ok' },
      { timestampMs: 400, phase: 'provision', code: 'phase_start', detail: 'containers=1' },
      { timestampMs: 1_500, phase: 'provision', code: 'phase_fail', detail: 'container_not_labelled_owner_horizon: mariadb: owner=<unset>' },
    ],
  };
}

describe('buildManagedRuntimeReadinessReport — success run', () => {
  const report = buildManagedRuntimeReadinessReport({
    project: 'horizon',
    composeFile: '/app/managed-docker-compose.yml',
    result: successResult(),
    environment: ENV,
    generatedAtIso: '2026-07-29T12:00:00Z',
  });

  it('sets tool + version + generatedAt from input', () => {
    expect(report.tool).toBe('managed-docker-evidence');
    expect(report.version).toBe('1.0');
    expect(report.generatedAt).toBe('2026-07-29T12:00:00Z');
  });

  it('preserves outcome + provisioned containers', () => {
    expect(report.outcome.ok).toBe(true);
    expect(report.outcome.finalPhase).toBe('supervise_ready');
    expect(report.outcome.provisionedContainers).toEqual(['mariadb', 'redis']);
  });

  it('rebases timeline to relative-ms starting at zero', () => {
    expect(report.timeline[0].relativeMs).toBe(0);
    expect(report.timeline.at(-1)?.relativeMs).toBe(12_500);
  });

  it('counts unique phases entered / completed / failed', () => {
    expect(report.totals.phasesEntered).toBe(3);
    expect(report.totals.phasesCompleted).toBe(3);
    expect(report.totals.phasesFailed).toBe(0);
  });

  it('measures totalDurationMs = last - first', () => {
    expect(report.totals.totalDurationMs).toBe(12_500);
  });
});

describe('buildManagedRuntimeReadinessReport — failure run', () => {
  const report = buildManagedRuntimeReadinessReport({
    project: 'horizon',
    composeFile: '/app/managed-docker-compose.yml',
    result: failResult(),
    environment: ENV,
    generatedAtIso: '2026-07-29T12:00:00Z',
  });

  it('reports ok=false with failure code + phase', () => {
    expect(report.outcome.ok).toBe(false);
    expect(report.outcome.finalPhase).toBe('provision');
    expect(report.outcome.failureCode).toBe('container_not_labelled_owner_horizon');
  });

  it('counts phases_failed >= 1', () => {
    expect(report.totals.phasesFailed).toBe(1);
  });
});

describe('sanitizeDetail — scrubs common secret shapes', () => {
  it('scrubs Bearer', () => {
    expect(sanitizeDetail('Authorization: Bearer abcd1234567890')).toContain('<REDACTED>');
    expect(sanitizeDetail('Authorization: Bearer abcd1234567890')).not.toContain('abcd1234567890');
  });

  it('scrubs authorization header full form', () => {
    expect(sanitizeDetail('authorization=Bearer xyz1234567890abcd')).toContain('authorization=<REDACTED>');
  });

  it('scrubs password + token', () => {
    expect(sanitizeDetail('password=hunter2 host=x')).toContain('password=<REDACTED>');
    expect(sanitizeDetail('token=abc12345 status=200')).toContain('token=<REDACTED>');
  });

  it('caps at 500 chars', () => {
    expect(sanitizeDetail('a'.repeat(600)).length).toBe(500);
  });

  it('leaves clean strings untouched', () => {
    expect(sanitizeDetail('provisioned=mariadb,redis')).toBe('provisioned=mariadb,redis');
  });
});

describe('phasesEnteredInOrder', () => {
  it('returns unique phase names in first-entered order', () => {
    const order = phasesEnteredInOrder(successResult());
    expect(order).toEqual(['preflight', 'provision', 'readiness_wait']);
  });

  it('handles empty event log', () => {
    expect(phasesEnteredInOrder({ events: [] })).toEqual([]);
  });
});

describe('serializeReadinessReport', () => {
  it('produces stable indented JSON', () => {
    const text = serializeReadinessReport(
      buildManagedRuntimeReadinessReport({
        project: 'horizon',
        composeFile: 'x.yml',
        result: successResult(),
        environment: ENV,
        generatedAtIso: '2026-07-29T12:00:00Z',
      }),
    );
    expect(text).toContain('"tool": "managed-docker-evidence"');
    // Parseable.
    const parsed = JSON.parse(text);
    expect(parsed.outcome.provisionedContainers).toEqual(['mariadb', 'redis']);
  });
});
