/**
 * Stage 3C-CI-FIX10 §5 — canonical auth contract regression.
 *
 * FIX9's native run failed with `native_auth_login_rejected:unknown`
 * because the harness at nativeElectron.integration.test.ts:236 read
 * `resp.error` — a field that does not exist on AuthOperationResponse.
 * The canonical failure field is `reason` (see AuthOperationResponseSchema
 * in apps/desktop/src/shared/ipcContract.ts and desktopAuthManager.ts).
 *
 * These tests lock the FIX10 contract at three levels so a future
 * refactor cannot silently reintroduce the drift:
 *
 *   §5.1  The shared schema shape — {ok, state, reason} — is stable.
 *   §5.2  IPC_ALLOWLIST wires authLogin ↔ AuthOperationResponseSchema.
 *   §5.3  The native harness reads `resp.reason`, not `resp.error`,
 *         and includes the sanitized state phase in the classification.
 *   §5.4  The native harness's T2 assertion names the canonical
 *         `dist/main/index.cjs` entry, not the pre-FIX8 `.js` path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as ts from 'typescript';
import {
  AuthLoginRequestSchema, AuthOperationResponseSchema, IPC_ALLOWLIST,
  IPC_CHANNELS, OPERATOR_AUTH_PHASES, SanitizedAuthStateSchema,
} from '../../src/shared/ipcContract';

const NATIVE_TEST = resolve(__dirname, '..', 'native', 'nativeElectron.integration.test.ts');
const NATIVE_SEED = resolve(__dirname, '..', 'native', 'deterministicSeed.ts');

describe('Stage 3C-CI-FIX10 §5.1 — AuthOperationResponse canonical shape', () => {
  it('exposes exactly {ok, state, reason} (strict)', () => {
    const shape = AuthOperationResponseSchema.shape;
    // The three canonical fields. `error` is NOT present — the FIX9
    // regression came from an assumption that this field existed.
    expect(Object.keys(shape).sort()).toEqual(['ok', 'reason', 'state']);
    expect(shape.ok).toBeInstanceOf(z.ZodBoolean);
    expect(shape.reason).toBeInstanceOf(z.ZodNullable);
  });

  it('validates a canonical failure response with reason', () => {
    const parsed = AuthOperationResponseSchema.parse({
      ok: false,
      state: {
        phase: 'unauthenticated', username: null, passwordChangedAt: null,
        accessExpiresAt: null, absoluteExpiresAt: null, lastActivityAt: null,
        failureReason: 'password_mismatch',
      },
      reason: 'password_mismatch',
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('password_mismatch');
  });

  it('rejects a payload carrying a spurious `error` field (strict schema)', () => {
    expect(() => AuthOperationResponseSchema.parse({
      ok: false, state: {
        phase: 'unauthenticated', username: null, passwordChangedAt: null,
        accessExpiresAt: null, absoluteExpiresAt: null, lastActivityAt: null,
        failureReason: null,
      },
      reason: null, error: 'password_mismatch',
    })).toThrow();
  });

  it('SanitizedAuthState declares every OperatorAuthPhase', () => {
    for (const phase of OPERATOR_AUTH_PHASES) {
      const parsed = SanitizedAuthStateSchema.parse({
        phase, username: null, passwordChangedAt: null,
        accessExpiresAt: null, absoluteExpiresAt: null, lastActivityAt: null,
        failureReason: null,
      });
      expect(parsed.phase).toBe(phase);
    }
  });
});

describe('Stage 3C-CI-FIX10 §5.2 — IPC_ALLOWLIST auth wiring', () => {
  it('authLogin uses AuthLoginRequestSchema + AuthOperationResponseSchema', () => {
    const entry = IPC_ALLOWLIST.find((e) => e.channel === IPC_CHANNELS.authLogin);
    expect(entry).toBeDefined();
    expect(entry!.requestSchema).toBe(AuthLoginRequestSchema);
    expect(entry!.responseSchema).toBe(AuthOperationResponseSchema);
    // Bootstrap-safe: the login screen must be reachable pre-auth.
    expect(entry!.requiresAuthenticatedSession).toBe(false);
  });

  it('every auth channel returns AuthOperationResponseSchema (except authGetState)', () => {
    const authChannels: readonly string[] = [
      IPC_CHANNELS.authSetup, IPC_CHANNELS.authLogin, IPC_CHANNELS.authLogout,
      IPC_CHANNELS.authLock, IPC_CHANNELS.authRefresh,
      IPC_CHANNELS.authChangePassword, IPC_CHANNELS.authRevokeAll,
    ];
    for (const channel of authChannels) {
      const entry = IPC_ALLOWLIST.find((e) => e.channel === channel);
      expect(entry, `no allowlist entry for ${channel}`).toBeDefined();
      expect(entry!.responseSchema, `${channel} response schema drift`)
        .toBe(AuthOperationResponseSchema);
    }
    // authGetState is the exception — it returns SanitizedAuthState directly.
    const state = IPC_ALLOWLIST.find((e) => e.channel === IPC_CHANNELS.authGetState);
    expect(state!.responseSchema).toBe(SanitizedAuthStateSchema);
  });
});

// -----------------------------------------------------------------------
// Stage 3C-CI-FIX10A §5 — structural (AST-based) auth harness verifier.
//
// The pre-FIX10A tests located the end of `performAuthenticatedLogin`
// via `src.indexOf('\n}\n', fnStart)`. That formatting-dependent
// search returned -1 in the FIX10 CI run because the function ended
// with a differently-indented closing brace, so the body slice
// returned the ENTIRE remaining file and the `as any` assertion
// picked up matches in unrelated functions — a false positive
// FAILURE, not a real defect in performAuthenticatedLogin.
//
// FIX10A replaces the whole section with a TypeScript compiler API
// walk. The AST is authoritative: it finds the function declaration,
// walks ONLY that function's body, and detects `AsExpression` and
// (deprecated) `TypeAssertionExpression` nodes whose asserted type is
// `AnyKeyword`. Formatting is irrelevant.
// -----------------------------------------------------------------------

interface LoginFunctionParse {
  fn: ts.FunctionDeclaration;
  body: ts.Block;
  bodyText: string;
}

function parseNativeSource(): ts.SourceFile {
  return ts.createSourceFile(
    NATIVE_TEST,
    readFileSync(NATIVE_TEST, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

function findLoginFunction(source: ts.SourceFile): LoginFunctionParse {
  const found: ts.FunctionDeclaration[] = [];
  source.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.escapedText === 'performAuthenticatedLogin') {
      found.push(n);
    }
  });
  if (found.length !== 1) {
    throw new Error(`expected exactly one performAuthenticatedLogin declaration; found ${found.length}`);
  }
  const fn = found[0];
  if (!fn.body) throw new Error('performAuthenticatedLogin has no body');
  return { fn, body: fn.body, bodyText: fn.body.getFullText(source) };
}

function collectDescendants(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    out.push(n);
    n.forEachChild(walk);
  };
  root.forEachChild(walk);
  return out;
}

function isAnyKeywordType(node: ts.TypeNode): boolean {
  return node.kind === ts.SyntaxKind.AnyKeyword;
}

describe('Stage 3C-CI-FIX10A §5.3 — native harness classification (AST-based)', () => {
  // Parse once; every test reuses the same tree.
  const source = parseNativeSource();
  const login = findLoginFunction(source);

  it('exactly one performAuthenticatedLogin declaration exists', () => {
    const decls: ts.FunctionDeclaration[] = [];
    source.forEachChild((n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.escapedText === 'performAuthenticatedLogin') decls.push(n);
    });
    expect(decls.length).toBe(1);
  });

  it('the function body was successfully parsed as a Block', () => {
    expect(login.body.kind).toBe(ts.SyntaxKind.Block);
    expect(login.bodyText.length).toBeGreaterThan(0);
  });

  it('contains no `as any` (AsExpression / TypeAssertion → AnyKeyword) — pre-FIX10 defect regression guard', () => {
    const offenders: string[] = [];
    for (const node of collectDescendants(login.body)) {
      if (ts.isAsExpression(node) && isAnyKeywordType(node.type)) {
        offenders.push(`AsExpression at pos=${node.pos}: ${node.getText(source).slice(0, 80)}`);
      }
      // The deprecated `<any>x` prefix-cast form. `ts.isTypeAssertionExpression`
      // is not consistently exported across TS versions; check SyntaxKind
      // directly and narrow via the well-typed TypeAssertion interface.
      if (node.kind === ts.SyntaxKind.TypeAssertionExpression) {
        const ta = node as ts.TypeAssertion;
        if (isAnyKeywordType(ta.type)) {
          offenders.push(`TypeAssertion at pos=${node.pos}: ${node.getText(source).slice(0, 80)}`);
        }
      }
    }
    expect(offenders, `unexpected \`as any\` casts:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('reads the canonical failure field (resp.reason), not the pre-FIX10 defect (resp.error)', () => {
    // Walk PropertyAccessExpression nodes whose expression is `resp`.
    // Collect the accessed property names.
    const respPropertyNames = new Set<string>();
    for (const node of collectDescendants(login.body)) {
      if (ts.isPropertyAccessExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.escapedText === 'resp') {
          respPropertyNames.add(String(node.name.escapedText));
        }
      }
    }
    // Positive: resp.ok and resp.reason are the canonical reads.
    expect(respPropertyNames.has('reason')).toBe(true);
    expect(respPropertyNames.has('ok')).toBe(true);
    // Negative regression guard — the pre-FIX10 defect.
    expect(respPropertyNames.has('error')).toBe(false);
  });

  it('independently verifies the authenticated readback (reads state.phase and compares to "authenticated")', () => {
    const statePropertyNames = new Set<string>();
    for (const node of collectDescendants(login.body)) {
      if (ts.isPropertyAccessExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.escapedText === 'state') {
          statePropertyNames.add(String(node.name.escapedText));
        }
      }
    }
    expect(statePropertyNames.has('phase')).toBe(true);
    // At least one string literal must equal 'authenticated'.
    const stringLiterals: string[] = [];
    for (const node of collectDescendants(login.body)) {
      if (ts.isStringLiteral(node)) stringLiterals.push(node.text);
    }
    expect(stringLiterals).toContain('authenticated');
  });

  it('typed via NativeLoginProbeResult (uses the canonical typed contract)', () => {
    // The function body should reference the typed alias in at least
    // one type position or expression.
    const typeRefNames = new Set<string>();
    for (const node of collectDescendants(login.body)) {
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        typeRefNames.add(String(node.typeName.escapedText));
      }
    }
    expect(typeRefNames.has('NativeLoginProbeResult')).toBe(true);
  });

  it('rejection message surfaces the sanitized state phase (AST + template literal walk)', () => {
    // Collect template literal contents and verify at least one
    // contains the required attribution tokens.
    const templates: string[] = [];
    for (const node of collectDescendants(login.body)) {
      if (ts.isTemplateExpression(node)) templates.push(node.getText(source));
      if (ts.isNoSubstitutionTemplateLiteral(node)) templates.push(node.text);
    }
    const joined = templates.join('\n');
    expect(joined).toMatch(/native_auth_login_rejected:/);
    expect(joined).toMatch(/phase=/);
    expect(joined).toMatch(/state_failure_reason=/);
  });

  it('never logs passwords or tokens (AST walk of console.* + logger.* CallExpressions)', () => {
    // Find CallExpression nodes whose callee is console.<anything> or
    // logger.<anything>, then inspect their arguments for the password
    // variable name (`p` — bound in the destructured evaluate param).
    const suspicious: string[] = [];
    for (const node of collectDescendants(login.body)) {
      if (!ts.isCallExpression(node)) continue;
      const callee = node.expression;
      let calleeRoot: string | null = null;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        calleeRoot = String(callee.expression.escapedText);
      }
      if (calleeRoot === 'console' || calleeRoot === 'logger') {
        for (const arg of node.arguments) {
          const t = arg.getText(source);
          // The evaluate param names are u (username) and p (password).
          if (/\bp\b/.test(t) || /password/i.test(t) || /token/i.test(t)) {
            suspicious.push(`${callee.getText(source)}(${t.slice(0, 100)})`);
          }
        }
      }
    }
    expect(suspicious, `suspicious credential-logging calls:\n${suspicious.join('\n')}`).toEqual([]);
  });
});

describe('Stage 3C-CI-FIX10 §5.4 — T2 canonical entry name', () => {
  const src = readFileSync(NATIVE_TEST, 'utf8');

  it('T2 assertion names dist/main/index.cjs (canonical FIX8+ layout)', () => {
    // Stage 3C-CI-RESET Part 2 Checkpoint C: `it(...)` was replaced
    // by `certIt('T2', ...)`. The assertion is now on the certIt call.
    expect(src).toContain("certIt('T2', 'real Electron main entry loaded (dist/main/index.cjs)'");
  });

  it('T2 assertion does NOT reference the pre-FIX8 dist/main/index.js path', () => {
    expect(src).not.toContain('T2: real Electron main entry loaded (apps/desktop/dist/main/index.js)');
    expect(src).not.toContain("certIt('T2', 'real Electron main entry loaded (dist/main/index.js)'");
  });
});

describe('Stage 3C-CI-FIX10 §5.5 — Costs honest empty state (three-site reconciliation)', () => {
  const testSrc = readFileSync(NATIVE_TEST, 'utf8');
  const seedSrc = readFileSync(NATIVE_SEED, 'utf8');

  it('T-sig[costs_attribution] asserts empty state, not a fabricated attribution', () => {
    // Stage 3C-CI-RESET Part 2 Checkpoint C: `it(...)` was replaced by
    // `certIt('SIG:costs_attribution', ...)`. The assertion is on the
    // certIt call and its data-screen literal in the body.
    expect(testSrc).toContain("certIt('SIG:costs_attribution', 'renders honest empty state (no seeded attribution by design)'");
    expect(testSrc).toMatch(/data-screen="costs"[\s\S]*?data-state="empty"/);
  });

  it('seed does not attempt a dead forecast_vs_realized_attributions insert', () => {
    expect(seedSrc).not.toContain('INSERT INTO forecast_vs_realized_attributions');
  });

  it('RECOMMENDED_SEED_ROWS no longer lists Costs (avoids misleading gap warning)', () => {
    // The RECOMMENDED_SEED_ROWS array declaration contains one line
    // per screen. Costs is intentionally absent post-FIX10.
    const arrStart = seedSrc.indexOf('export const RECOMMENDED_SEED_ROWS');
    const arrEnd = seedSrc.indexOf(']);', arrStart);
    expect(arrStart).toBeGreaterThan(0);
    expect(arrEnd).toBeGreaterThan(arrStart);
    const block = seedSrc.slice(arrStart, arrEnd);
    expect(block).not.toMatch(/screen:\s*'Costs'/);
  });
});
