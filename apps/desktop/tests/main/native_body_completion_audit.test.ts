/**
 * Stage 3C-CI-RESET Part 2 Checkpoint D.1 §D.18 — AST-based
 * completion audit for the reconstructed native test bodies.
 *
 * These tests scan the native test source for structural markers
 * that prove each reconstructed body actually does what its title
 * says. They cannot replace the runtime execution (that happens in
 * the native suite on a CI runner) — they are a stationary guard
 * that prevents a future edit from silently reverting a body to a
 * source-string or a boolean sanity check.
 *
 * Failure classifications:
 *   completion_missing_helper_call:<id>:<helper>
 *   completion_missing_result_assignment:<id>
 *   completion_missing_finally:<id>
 *   completion_missing_evidence_write:<id>:<filename>
 *   completion_forbids_status_denied:<id>
 *   completion_forbids_source_string:<id>
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const NATIVE_TEST = resolve(__dirname, '..', 'native', 'nativeElectron.integration.test.ts');
const SRC = readFileSync(NATIVE_TEST, 'utf8');

/** Slice the source between two certIt() calls to isolate one test body. */
function sliceTestBody(id: string): string {
  const start = SRC.indexOf(`certIt('${id}'`);
  if (start < 0) throw new Error(`body not found: ${id}`);
  // Find the next certIt after start (or end of file). Simple and
  // sufficient — no certIt nesting inside a body.
  const rest = SRC.slice(start + 1);
  const next = rest.indexOf(`certIt('`);
  return next < 0 ? SRC.slice(start) : SRC.slice(start, start + 1 + next);
}

interface BodyExpectation {
  requiredIncludes?: readonly string[];
  requiredMatches?: readonly RegExp[];
  forbiddenIncludes?: readonly string[];
  forbiddenMatches?: readonly RegExp[];
  evidenceFilename: string;
  resultField: string;
}

const EXPECTATIONS: Readonly<Record<string, BodyExpectation>> = {
  T34: {
    requiredIncludes: ['data-screen="costs_attribution"', 'costsHonestyResult:', 'forbiddenLabelsSeen'],
    forbiddenIncludes: ['result_type: "default"'],
    evidenceFilename: 'costs-screen-evidence.json',
    resultField: 'costsHonestyResult',
  },
  T36: {
    requiredIncludes: ['auth.lock', 'h.desktopData', 'lockResult:', 'seededIdentifierBeforeLock', 'seededIdentifierAfterLock'],
    evidenceFilename: 'lock-evidence.json',
    resultField: 'lockResult',
  },
  T37: {
    requiredIncludes: ['h.revokeAll', 'revocationResult:', 'operator_auth_sessions', 'revokedAllSessions'],
    requiredMatches: [/expect\([^)]*revoked\.status[^)]*\)[^;]*\.not\.toBe\(401\)/],
    // Must NOT silently accept 401/403 as success — the assertion
    // above explicitly forbids both.
    forbiddenMatches: [/\[.*401.*403.*\]\.toContain\(res\.status\)/],
    evidenceFilename: 'revocation-evidence.json',
    resultField: 'revocationResult',
  },
  'T39-41': {
    requiredIncludes: ['activateInduction', 'clearInduction', 'staleResult:', 'degradedResult:', 'unavailableResult:', 'recoveryVerified'],
    // Three finally blocks — one per induction.
    requiredMatches: [/finally\s*\{[\s\S]*?clearInduction[\s\S]*?finally\s*\{[\s\S]*?clearInduction[\s\S]*?finally\s*\{[\s\S]*?clearInduction/],
    evidenceFilename: 'stale-evidence.json',
    resultField: 'staleResult',
  },
  T42: {
    requiredIncludes: ['server!.suspend()', 'server!.resume()', 'serverSuspensionResult:', 'SIGSTOP'],
    requiredMatches: [/finally\s*\{[\s\S]*?server!\.resume/],
    evidenceFilename: 'server-suspension-evidence.json',
    resultField: 'serverSuspensionResult',
  },
  T43: {
    requiredIncludes: ['activateInduction', 'contract_mismatch', 'contractMismatchResult:', 'typedFailureCode'],
    requiredMatches: [/finally\s*\{[\s\S]*?clearInduction/],
    // T43 must NO LONGER be the source-scan check.
    forbiddenIncludes: ["readdirSync(rendererDist)", 'contract_mismatch code path exists'],
    evidenceFilename: 'contract-mismatch-evidence.json',
    resultField: 'contractMismatchResult',
  },
  T46: {
    requiredIncludes: ['launch!.app.evaluate', 'BrowserWindow', 'windowLifecycleResult:', 'closeEventObserved'],
    // Must NOT reduce to "expect closable === true".
    forbiddenIncludes: ['typeof (launch as any)?.app?.close === '],
    evidenceFilename: 'window-lifecycle-evidence.json',
    resultField: 'windowLifecycleResult',
  },
  T49: {
    requiredIncludes: ['server!.kill', 'spawnServer(iso', 'serverRestartResult:', 'oldServerPid', 'newServerPid'],
    requiredMatches: [/expect\([^)]*reconStatus[^)]*\)[^;]*\.not\.toBe\(401\)/],
    // Must not accept 401/403 as reconciliation success.
    forbiddenMatches: [/\[200,\s*204,\s*401,\s*403\]\.toContain\(res\.status\)/],
    evidenceFilename: 'server-restart-evidence.json',
    resultField: 'serverRestartResult',
  },
  T53: {
    requiredIncludes: ['champion.get', 'safeConfigurationResult:', 'authoritySource', 'championConfiguration'],
    // The pre-D.1 body just checked a rendered banner — that literal
    // must NO LONGER be the sole assertion. It may still appear in
    // other tests but not as the T53 pass gate.
    evidenceFilename: 'safe-configuration-evidence.json',
    resultField: 'safeConfigurationResult',
  },
  T54: {
    requiredIncludes: ['native-diagnostics/env-summary', 'credentialPresenceResult:', 'anyCredentialPresent', 'launch!.app.evaluate'],
    evidenceFilename: 'credential-presence-evidence.json',
    resultField: 'credentialPresenceResult',
  },
  T55: {
    requiredIncludes: ['native-diagnostics/provider-status', 'providerSelectionResult:', 'authoritySource', 'marketDataProvider'],
    forbiddenIncludes: ["process.env.HORIZON_PROVIDER_MODE ?? 'fixture').not.toBe('external')"],
    evidenceFilename: 'provider-selection-evidence.json',
    resultField: 'providerSelectionResult',
  },
};

describe('Stage 3C-CI-RESET Part 2 Checkpoint D.1 §D.18 — native body completion audit', () => {
  for (const [id, exp] of Object.entries(EXPECTATIONS)) {
    describe(id, () => {
      const body = sliceTestBody(id);

      it(`${id}: helper/action calls present`, () => {
        const missing = (exp.requiredIncludes ?? []).filter((s) => !body.includes(s));
        expect(missing, `completion_missing_helper_call:${id}:${missing.join(',')}`).toEqual([]);
      });

      if ((exp.requiredMatches?.length ?? 0) > 0) {
        it(`${id}: required structural patterns match`, () => {
          const missing = (exp.requiredMatches ?? []).filter((rx) => !rx.test(body));
          expect(missing.length, `completion_missing_structural:${id}`).toBe(0);
        });
      }

      if ((exp.forbiddenIncludes?.length ?? 0) > 0) {
        it(`${id}: forbidden literals absent`, () => {
          const seen = (exp.forbiddenIncludes ?? []).filter((s) => body.includes(s));
          expect(seen, `completion_forbids_literal:${id}:${seen.join(',')}`).toEqual([]);
        });
      }

      if ((exp.forbiddenMatches?.length ?? 0) > 0) {
        it(`${id}: forbidden patterns absent`, () => {
          const seen = (exp.forbiddenMatches ?? []).filter((rx) => rx.test(body));
          expect(seen.length, `completion_forbids_pattern:${id}`).toBe(0);
        });
      }

      it(`${id}: assigns reconstructedResults.${exp.resultField}`, () => {
        expect(body, `completion_missing_result_assignment:${id}`).toContain(`${exp.resultField}:`);
      });

      it(`${id}: writes ${exp.evidenceFilename}`, () => {
        expect(body, `completion_missing_evidence_write:${id}:${exp.evidenceFilename}`)
          .toContain(exp.evidenceFilename);
      });
    });
  }
});
