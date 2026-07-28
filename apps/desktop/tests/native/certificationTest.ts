/**
 * Stage 3C-CI-RESET Part 2 Checkpoint C.4 — vitest wrapper that
 * records every native certification test into the execution ledger.
 *
 * Usage:
 *
 *   certificationTest(ledger, requirement, async () => {
 *     // body — same expect() assertions as before
 *   });
 *
 * Behavior:
 *   1. On entry, the ledger transitions the requirement from
 *      `registered` → `started`. If the requirement is not registered
 *      (typo, missing manifest entry), the wrapper throws immediately;
 *      the ledger surfaces this as `unknown_requirement`.
 *   2. If the body resolves, the ledger records `pass` with the wall
 *      time; the vitest it() itself passes.
 *   3. If the body throws, the ledger records `fail` with the
 *      sanitized failure code, then the original error is rethrown
 *      so vitest still surfaces the test failure.
 *   4. The ledger and vitest are kept in sync: a passing wrapper
 *      always leaves the requirement in `passed`; a failing wrapper
 *      always leaves it in `failed`. There is no code path that lets
 *      the ledger claim a pass when the it() rejected.
 *
 * The wrapper is thin on purpose — the ledger owns the invariants;
 * this file only translates vitest's success/failure contract into
 * ledger transitions.
 */

import { it } from 'vitest';
import type { NativeExecutionLedger } from './nativeExecutionLedger';
import type { NativeCertificationRequirement } from './nativeCertificationManifest';

export type CertificationBody = () => void | Promise<void>;

/**
 * Register a vitest test whose pass/fail transition is mirrored
 * into the execution ledger. The ledger MUST have already called
 * `registerManifest()` — the wrapper does not auto-register.
 */
export function certificationTest(
  ledger: NativeExecutionLedger | undefined,
  requirement: NativeCertificationRequirement,
  body: CertificationBody,
  opts: { timeoutMs?: number } = {},
): void {
  const displayName = `[${requirement.id}] ${requirement.title}`;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  it(displayName, async () => {
    if (!ledger) {
      // Servicing an environment where the ledger is intentionally
      // absent (e.g. renderer-side tooling reusing this wrapper)
      // should still allow the body to run — the wrapper is a
      // no-op ledger-wise. This branch is a defensive fallback and
      // is not the expected shape at CI time.
      await body();
      return;
    }
    const start = Date.now();
    ledger.start(requirement.id);
    try {
      await body();
      const elapsedMs = Date.now() - start;
      ledger.pass(requirement.id, elapsedMs);
    } catch (e) {
      const elapsedMs = Date.now() - start;
      const msg = e instanceof Error ? e.message : String(e);
      ledger.fail(requirement.id, msg, elapsedMs);
      throw e;
    }
  }, timeoutMs);
}

/**
 * Convenience: register a vitest it() from a raw requirement ID
 * lookup rather than an already-resolved requirement object. Throws
 * synchronously if the ID is not in the manifest.
 */
export function certificationTestById(
  ledger: NativeExecutionLedger | undefined,
  manifest: readonly NativeCertificationRequirement[],
  requirementId: string,
  body: CertificationBody,
  opts?: { timeoutMs?: number },
): void {
  const r = manifest.find((x) => x.id === requirementId);
  if (!r) throw new Error(`certificationTest: unknown requirement id '${requirementId}'`);
  certificationTest(ledger, r, body, opts);
}
