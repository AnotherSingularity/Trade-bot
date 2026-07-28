/**
 * Stage 3C-CI-RESET Part 2 Checkpoint D.1 §D.3 — thin client the
 * native tests use to drive the server-side induction controller.
 *
 * Every operation goes through the bootstrap-token authority the
 * harness already owns; the induction router itself enforces the
 * strict policy gates (test-mode + diagnostics-on + external +
 * !packaged). Nonces are per-run — the caller stores the nonce it
 * used to activate so it can clear the same activation later.
 */

import { randomBytes } from 'node:crypto';
import type { NativeInductionMode, NativeInductionRouteKey, NativeInductionState } from '@horizon/shared';

export interface InductionClient {
  readonly baseUrl: string;
  readonly bootstrapToken: string;
}

export interface InductionActivation {
  readonly nonce: string;
  readonly mode: NativeInductionMode;
  readonly routeKey: NativeInductionRouteKey;
  readonly activatedAt: string;
  readonly expiresAt: string;
}

export interface InductionResponse<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly body: T | { error?: string };
}

function mintNonce(): string {
  return `induction_${randomBytes(12).toString('hex')}`;
}

async function post<T>(url: string, headers: Record<string, string>, body: unknown): Promise<InductionResponse<T>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text.length === 0 ? null : JSON.parse(text); }
  catch { parsed = { error: 'invalid_json', detail: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, body: parsed as T };
}

async function get<T>(url: string, headers: Record<string, string>): Promise<InductionResponse<T>> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text.length === 0 ? null : JSON.parse(text); }
  catch { parsed = { error: 'invalid_json', detail: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, body: parsed as T };
}

/**
 * Activate an induction. Returns the activation record on success;
 * throws with the sanitized error tag on any policy denial.
 */
export async function activateInduction(
  client: InductionClient,
  mode: Exclude<NativeInductionMode, 'none'>,
  routeKey: NativeInductionRouteKey,
  opts: { ttlMs?: number } = {},
): Promise<InductionActivation> {
  const nonce = mintNonce();
  const resp = await post<{ ok: true; state: NativeInductionState }>(
    `${client.baseUrl}/api/native-induction/activate`,
    { 'x-horizon-bootstrap-token': client.bootstrapToken },
    { mode, routeKey, nonce, ttlMs: opts.ttlMs ?? 30_000 },
  );
  if (!resp.ok || resp.status !== 202) {
    const errBody = resp.body as { error?: string; detail?: string };
    throw new Error(`native_induction_activate_failed:${resp.status}:${errBody.error ?? 'unknown'}`);
  }
  const state = (resp.body as { ok: true; state: NativeInductionState }).state;
  if (state.kind !== 'active') throw new Error('native_induction_activate_bad_state');
  return {
    nonce,
    mode: state.mode,
    routeKey: state.routeKey,
    activatedAt: state.activatedAt,
    expiresAt: state.expiresAt,
  };
}

/**
 * Clear an induction. Idempotent — a mismatch on nonce returns 403
 * (surfaced as a thrown error). Safe to call from a finally block.
 */
export async function clearInduction(client: InductionClient, activation: InductionActivation): Promise<void> {
  const resp = await post<{ ok: true; state: NativeInductionState }>(
    `${client.baseUrl}/api/native-induction/clear`,
    { 'x-horizon-bootstrap-token': client.bootstrapToken },
    { nonce: activation.nonce },
  );
  if (!resp.ok) {
    const errBody = resp.body as { error?: string };
    throw new Error(`native_induction_clear_failed:${resp.status}:${errBody.error ?? 'unknown'}`);
  }
}

export async function readInductionState(client: InductionClient): Promise<NativeInductionState> {
  const resp = await get<{ ok: true; state: NativeInductionState }>(
    `${client.baseUrl}/api/native-induction/state`,
    { 'x-horizon-bootstrap-token': client.bootstrapToken },
  );
  if (!resp.ok) throw new Error(`native_induction_state_failed:${resp.status}`);
  return (resp.body as { ok: true; state: NativeInductionState }).state;
}
