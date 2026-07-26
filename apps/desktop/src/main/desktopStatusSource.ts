/**
 * Stage 1 §12 — Authoritative desktop status source.
 *
 * Replaces the Phase 3A hardcoded values. Every value comes from a
 * live source. A missing source yields `unknown`, never `0`.
 */

import type { CreateOrderCountersEnvelope } from '../shared/ipcContract';

export interface DesktopStatusSourceInput {
  serverHealthUrl: string;
  serverCountersUrl?: string;         // e.g. `${server}/api/desktop/counters`
  serverPolicyVersionsUrl?: string;   // e.g. `${server}/api/desktop/observer-versions`
  serverChampionUrl?: string;         // e.g. `${server}/api/desktop/champion`
  fingerprintVersion?: string;        // computed by SchemaFingerprintVerifier
}

export interface AuthoritativeCounters {
  known: boolean;
  functionInvocations: number | null;
  attemptCount: number | null;
  networkCount: number | null;
  source: string;
}

export interface AuthoritativeStatusSnapshot {
  createOrderCounters: AuthoritativeCounters;
  schemaVersion: string | 'unknown';
  observerPolicyVersions: Record<string, string> | null;
  championConfiguration: Record<string, unknown> | null;
  lastSampledAt: Date;
}

export class DesktopStatusSource {
  constructor(private readonly input: DesktopStatusSourceInput) {}

  async sample(): Promise<AuthoritativeStatusSnapshot> {
    const [counters, policyVersions, champion] = await Promise.all([
      this.fetchCounters(),
      this.fetchJson(this.input.serverPolicyVersionsUrl),
      this.fetchJson(this.input.serverChampionUrl),
    ]);
    return {
      createOrderCounters: counters,
      schemaVersion: this.input.fingerprintVersion ?? 'unknown',
      observerPolicyVersions: (policyVersions as Record<string, string>) ?? null,
      championConfiguration: (champion as Record<string, unknown>) ?? null,
      lastSampledAt: new Date(),
    };
  }

  private async fetchCounters(): Promise<AuthoritativeCounters> {
    const url = this.input.serverCountersUrl;
    if (!url) return { known: false, functionInvocations: null, attemptCount: null, networkCount: null, source: 'not_configured' };
    try {
      const data = await this.fetchJson(url);
      if (!data || typeof data !== 'object') {
        return { known: false, functionInvocations: null, attemptCount: null, networkCount: null, source: 'invalid_response' };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      const f = Number(d.functionInvocations);
      const a = Number(d.attemptCount);
      const n = Number(d.networkCount);
      if (!Number.isFinite(f) || !Number.isFinite(a) || !Number.isFinite(n) || f < 0 || a < 0 || n < 0) {
        return { known: false, functionInvocations: null, attemptCount: null, networkCount: null, source: 'invalid_values' };
      }
      return { known: true, functionInvocations: f, attemptCount: a, networkCount: n, source: url };
    } catch (e) {
      return { known: false, functionInvocations: null, attemptCount: null, networkCount: null, source: `error: ${String(e).slice(0, 80)}` };
    }
  }

  private async fetchJson(url: string | undefined): Promise<unknown | null> {
    if (!url) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}

// Wrap AuthoritativeCounters in the IPC envelope. `known=false` means
// the desktop could not confirm the values; the renderer renders
// "unknown" and readiness is BLOCKED (see scannerReadiness).
export function toCountersEnvelope(a: AuthoritativeCounters): CreateOrderCountersEnvelope {
  return {
    known: a.known,
    source: a.source,
    values: {
      functionInvocations: a.functionInvocations ?? 0,
      attemptCount: a.attemptCount ?? 0,
      networkCount: a.networkCount ?? 0,
    },
  };
}
