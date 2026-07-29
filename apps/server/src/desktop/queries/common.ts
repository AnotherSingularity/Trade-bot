/**
 * Common helpers for Stage 3 desktop query services.
 *
 * Every query service returns a `DesktopDataEnvelope<T>` from the shared
 * contracts. DB failures produce `unavailable` envelopes — never a
 * fabricated-empty payload.
 */

import {
  DESKTOP_CONTRACT_VERSION,
  type DesktopDataEnvelope,
  type EnvelopeStatus,
  type IsoTimestamp,
} from '@horizon/shared';

/** Deterministic UTC now — server tests inject a clock. */
export function nowIso(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp;
}

export function toIsoNullable(value: Date | string | number | null | undefined): IsoTimestamp | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString() as IsoTimestamp;
}

/**
 * Normalise a Drizzle decimal string. Drizzle returns MySQL DECIMAL as a
 * string already; we still assert the shape so the contract cannot leak a
 * `NaN` or a scientific-notation representation.
 */
export function toDecimalStringNullable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;
  if (!/^-?(?:\d+\.?\d*|\d*\.\d+)$/.test(s)) return null;
  return s;
}

export function envelope<T>(
  status: EnvelopeStatus,
  data: T | null,
  extra?: Partial<DesktopDataEnvelope<T>>,
): DesktopDataEnvelope<T> {
  return {
    contractVersion: DESKTOP_CONTRACT_VERSION,
    status,
    data,
    generatedAt: nowIso(),
    ...extra,
  };
}

export function unavailable<T>(reasonCode: string, extra?: Partial<DesktopDataEnvelope<T>>): DesktopDataEnvelope<T> {
  return envelope<T>('unavailable', null, { reasonCode, ...extra });
}

export function healthy<T>(data: T, extra?: Partial<DesktopDataEnvelope<T>>): DesktopDataEnvelope<T> {
  return envelope<T>('healthy', data, extra);
}

export function empty<T>(data: T, reasonCode?: string, extra?: Partial<DesktopDataEnvelope<T>>): DesktopDataEnvelope<T> {
  return envelope<T>('empty', data, { reasonCode, ...extra });
}

export function degraded<T>(data: T | null, reasonCode: string, extra?: Partial<DesktopDataEnvelope<T>>): DesktopDataEnvelope<T> {
  return envelope<T>('degraded', data, { reasonCode, ...extra });
}

export function stale<T>(data: T | null, reasonCode: string, extra?: Partial<DesktopDataEnvelope<T>>): DesktopDataEnvelope<T> {
  return envelope<T>('stale', data, { reasonCode, ...extra });
}

/**
 * Encode a numeric-only cursor. Stage 3 uses id-based cursors for lists
 * (positions, decisions, incidents, reconciliation). The renderer treats
 * these as opaque strings.
 */
export function encodeCursor(row: Record<string, string | number>): string {
  const payload = JSON.stringify(row);
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Record<string, string | number> | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const clean: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' || typeof v === 'number') clean[k] = v;
      }
      return clean;
    }
    return null;
  } catch {
    return null;
  }
}

/** Bounded query timeout — kill long-running reads. */
export const QUERY_TIMEOUT_MS = 5_000;

export async function withTimeout<T>(fn: () => Promise<T>, ms = QUERY_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('query_timeout')), ms)),
  ]);
}
