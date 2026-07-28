/**
 * Stage 2 §2 — Bootstrap token generator (desktop side).
 * Stage 3C-CI-FIX9 §1 — bootstrap-token AUTHORITY.
 *
 * The desktop supervisor either MINTS a fresh 256-bit token per
 * server-process lifecycle (production, desktop-owned server) OR
 * IMPORTS the harness's token from the environment in strict
 * unpackaged native-test mode.
 *
 * Production path (mint):
 *   - `mintBootstrapToken()` returns a fresh 32-byte hex token.
 *   - Passed to the spawned server via `HORIZON_BOOTSTRAP_TOKEN`.
 *   - Sent to every bootstrap-scoped HTTP call via the
 *     `X-Horizon-Bootstrap-Token` header.
 *   - Never persisted, never logged, never crosses to renderer.
 *
 * External native-test path (import):
 *   - The native harness spawns the server itself and passes its
 *     token to Electron via `HORIZON_BOOTSTRAP_TOKEN`.
 *   - Electron main IMPORTS that token via `importBootstrapToken()`.
 *   - The imported token wraps in the same `BootstrapTokenHandle`
 *     interface as a minted one; downstream callers cannot tell them
 *     apart.
 *   - Permitted ONLY when app.isPackaged=false AND NODE_ENV=test AND
 *     HORIZON_NATIVE_DIAGNOSTICS=true AND HORIZON_SERVER_EXTERNAL=true.
 *   - The token value never appears in error messages, logs, or
 *     diagnostic evidence.
 */

import { randomBytes } from 'node:crypto';

export interface BootstrapTokenHandle {
  readonly headerValue: string;
  readonly envValue: string;
  readonly source: BootstrapTokenSource;
  destroy(): void;
}

export type BootstrapTokenSource = 'minted_desktop_owned' | 'imported_external_test';

function wrapToken(hex: string, buf: Buffer | null, source: BootstrapTokenSource): BootstrapTokenHandle {
  let alive = true;
  return {
    get headerValue(): string {
      if (!alive) throw new Error('bootstrap token has been destroyed');
      return hex;
    },
    get envValue(): string {
      if (!alive) throw new Error('bootstrap token has been destroyed');
      return hex;
    },
    get source(): BootstrapTokenSource { return source; },
    destroy(): void {
      alive = false;
      if (buf) buf.fill(0);
    },
  };
}

export function mintBootstrapToken(): BootstrapTokenHandle {
  const buf = randomBytes(32);
  const hex = buf.toString('hex');
  return wrapToken(hex, buf, 'minted_desktop_owned');
}

export interface ExternalBootstrapImportInput {
  isPackaged: boolean;
  nodeEnv: string | undefined;
  nativeDiagnostics: string | undefined;
  serverExternal: string | undefined;
  envBootstrapToken: string | undefined;
}

// Stage 3C-CI-FIX9 §1.3/§1.4: strict external-native-test policy.
// Every rule fails closed — a released installer that somehow
// received these env vars would still refuse to import.
export function isExternalNativeTestMode(input: ExternalBootstrapImportInput): boolean {
  if (input.isPackaged) return false;
  if (input.nodeEnv !== 'test') return false;
  if (input.nativeDiagnostics !== 'true') return false;
  if (input.serverExternal !== 'true') return false;
  return true;
}

// 64-hex-char validation — exactly 256 bits. Any other shape is
// rejected. Whitespace / prefixes / suffixes are NOT tolerated.
const BOOTSTRAP_TOKEN_HEX_RE = /^[a-f0-9]{64}$/i;

export function importBootstrapToken(input: ExternalBootstrapImportInput): BootstrapTokenHandle {
  if (input.isPackaged) throw new Error('external_server_mode_forbidden_packaged');
  if (input.nodeEnv !== 'test') throw new Error('external_server_mode_requires_test_policy');
  if (input.nativeDiagnostics !== 'true') throw new Error('external_server_mode_requires_test_policy');
  if (input.serverExternal !== 'true') throw new Error('external_server_mode_requires_test_policy');
  const raw = input.envBootstrapToken;
  if (!raw || raw.length === 0) throw new Error('external_bootstrap_token_missing');
  if (!BOOTSTRAP_TOKEN_HEX_RE.test(raw)) throw new Error('external_bootstrap_token_invalid');
  return wrapToken(raw, null, 'imported_external_test');
}

// Convenience gateway used by main. Returns the correct handle for
// the current policy. Fails closed on any inconsistent state.
export function resolveBootstrapTokenAuthority(input: ExternalBootstrapImportInput): BootstrapTokenHandle {
  if (isExternalNativeTestMode(input)) return importBootstrapToken(input);
  return mintBootstrapToken();
}
