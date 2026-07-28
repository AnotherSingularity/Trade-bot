/**
 * Stage 3C-CI-RESET Part 2 Checkpoint E.6 — pure external-server
 * mode policy.
 *
 * `resolveExternalServerMode(input)` is the ONLY sanctioned way to
 * decide whether the desktop should attach to an already-running
 * server process (external mode) instead of spawning + supervising
 * its own. It enforces the same fail-closed rules that were
 * previously inlined at multiple sites:
 *
 *   1. Packaged builds NEVER accept an external server. A released
 *      installer must always own the server it talks to; a stray env
 *      var in a customer install must be structurally incapable of
 *      redirecting the authenticated API client at a foreign process.
 *
 *   2. Unpackaged builds accept the external-server escape hatch
 *      ONLY when the canonical value `true` is present. Non-canonical
 *      values ('1', 'yes', 'TRUE', ...) are rejected with a specific
 *      tag so a typo cannot silently disable server supervision.
 *
 *   3. Absent (undefined / empty) env → default supervised mode.
 *
 * Every rejection returns a stable `reason` tag so log-mining and
 * unit tests can pin the exact failure mode.
 */

export interface ExternalServerPolicyInput {
  readonly isPackaged: boolean;
  readonly serverExternalEnv: string | undefined;
}

export type ExternalServerPolicyDecision =
  | { readonly mode: 'supervised'; readonly reason: ExternalServerAcceptReason }
  | { readonly mode: 'external'; readonly reason: 'external_accepted_unpackaged_canonical' }
  | { readonly mode: 'rejected'; readonly reason: ExternalServerRejectReason; readonly detail: string };

export type ExternalServerAcceptReason =
  | 'supervised_no_env_override'
  | 'supervised_env_empty';

export type ExternalServerRejectReason =
  | 'external_rejected_packaged'
  | 'external_rejected_non_canonical_value';

/**
 * Pure. Returns the effective server mode or a rejection.
 *
 * Callers must interpret `mode: 'rejected'` as a hard startup abort.
 * Even in the `mode: 'supervised'` case with an env value present,
 * this function will never silently ignore an override — the sole
 * accept path for external mode requires the canonical string `'true'`.
 */
export function resolveExternalServerMode(input: ExternalServerPolicyInput): ExternalServerPolicyDecision {
  const env = input.serverExternalEnv;
  // 1. No env → supervised (default hardened path).
  if (env === undefined) {
    return { mode: 'supervised', reason: 'supervised_no_env_override' };
  }
  if (env === '') {
    return { mode: 'supervised', reason: 'supervised_env_empty' };
  }
  // 2. Non-canonical value → hard reject. A '1' or 'yes' typo must
  //    never be interpreted as an authoritative external-server opt-in.
  if (env !== 'true') {
    return {
      mode: 'rejected',
      reason: 'external_rejected_non_canonical_value',
      detail: env.slice(0, 32),
    };
  }
  // 3. Canonical 'true' + packaged → hard reject. Packaged installers
  //    structurally cannot accept a foreign server, regardless of env.
  if (input.isPackaged) {
    return {
      mode: 'rejected',
      reason: 'external_rejected_packaged',
      detail: 'HORIZON_SERVER_EXTERNAL cannot influence a packaged build',
    };
  }
  // 4. Canonical 'true' + unpackaged → external accepted.
  return { mode: 'external', reason: 'external_accepted_unpackaged_canonical' };
}
