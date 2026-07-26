/**
 * Stage 2 §2 — Bootstrap token generator (desktop side).
 *
 * The desktop supervisor mints one 256-bit token per server-process
 * lifecycle. It's passed to the spawned server via env var
 * `HORIZON_BOOTSTRAP_TOKEN` and to every bootstrap-scoped HTTP call
 * via the `X-Horizon-Bootstrap-Token` header. The plaintext lives
 * only in the main process — never in renderer state, on-disk, in
 * logs, or in IPC responses.
 */

import { randomBytes } from 'node:crypto';

export interface BootstrapTokenHandle {
  readonly headerValue: string;
  readonly envValue: string;
  destroy(): void;
}

export function mintBootstrapToken(): BootstrapTokenHandle {
  const buf = randomBytes(32);
  const hex = buf.toString('hex');
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
    destroy(): void {
      alive = false;
      buf.fill(0);
    },
  };
}
