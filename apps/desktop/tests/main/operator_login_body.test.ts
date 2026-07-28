/**
 * Stage 3C-CI-FIX10A §3 — operator-login body serialization regression.
 *
 * FIX10's native run failed with HTTP 400 `invalid_body` before
 * credential verification because DesktopAuthManager sent
 * `installationId: null`. The server login Zod schema declares
 * `installationId: z.union([z.number(), z.string()]).optional()` —
 * `.optional()` accepts `undefined` but NOT `null`, and
 * `JSON.stringify` preserves `null` (only `undefined` is dropped).
 *
 * These tests pin the pure helper's contract so a future refactor
 * cannot silently reintroduce a null-on-the-wire regression:
 *
 *   §3.1  null installationId is omitted from the request object.
 *   §3.2  undefined installationId is omitted.
 *   §3.3  numeric installationId is preserved.
 *   §3.4  valid string installationId is accepted (server-boundary parity).
 *   §3.5  clientVersion is preserved when non-empty (also empty→omitted).
 *   §3.6  serialized JSON contains no property with null installation ID.
 *   §3.7  the generated body passes the server login schema.
 *   §3.8  an explicit null installationId FAILS the server schema
 *         (regression guard on the pre-FIX10A wire shape).
 *   §3.9  username and password are unchanged through the desktop boundary.
 *   §3.10 no password appears in helper diagnostics / source-level
 *         search (no logging path constructs the password).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as ts from 'typescript';
import { buildOperatorLoginBody } from '../../src/main/operatorLoginBody';

// Byte-identical copy of the server's login body schema from
// apps/server/src/routes/auth.ts (loginBody). Duplicated here — not
// imported — so the desktop portable suite has no cross-workspace
// import and this test is portable. A drift between the two schemas
// is the exact class of defect this suite is designed to detect;
// keep them byte-identical.
const SERVER_LOGIN_BODY_SCHEMA = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  installationId: z.union([z.number().int(), z.string().max(64)]).optional(),
  clientVersion: z.string().max(64).optional(),
});

const USER = 'nativeoperator';
const PASS = 'Native-3C-passphrase-!';

describe('Stage 3C-CI-FIX10A §3.1 — null installationId is omitted', () => {
  it('does not carry an installationId key', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS, installationId: null });
    expect(Object.prototype.hasOwnProperty.call(body, 'installationId')).toBe(false);
    expect('installationId' in body).toBe(false);
  });
});

describe('Stage 3C-CI-FIX10A §3.2 — undefined installationId is omitted', () => {
  it('does not carry an installationId key (undefined input)', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS, installationId: undefined });
    expect(Object.prototype.hasOwnProperty.call(body, 'installationId')).toBe(false);
  });

  it('does not carry an installationId key (missing input)', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS });
    expect(Object.prototype.hasOwnProperty.call(body, 'installationId')).toBe(false);
  });
});

describe('Stage 3C-CI-FIX10A §3.3 — numeric installationId is preserved', () => {
  it('carries the exact numeric value', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS, installationId: 42 });
    expect(body.installationId).toBe(42);
    expect(typeof body.installationId).toBe('number');
  });

  it('preserves 0 as a valid numeric value (not treated as absent)', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS, installationId: 0 });
    expect(body.installationId).toBe(0);
  });
});

describe('Stage 3C-CI-FIX10A §3.4 — valid string installationId is accepted at the server boundary', () => {
  it('preserves a non-empty string', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS, installationId: 'installation-reference' });
    expect(body.installationId).toBe('installation-reference');
  });

  it('empty string is treated as absent (would otherwise slip past the server as a zero-length id)', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS, installationId: '' });
    expect('installationId' in body).toBe(false);
  });

  it('server login schema accepts the string installationId shape', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS, installationId: 'installation-reference' });
    const parsed = SERVER_LOGIN_BODY_SCHEMA.safeParse(body);
    expect(parsed.success).toBe(true);
  });
});

describe('Stage 3C-CI-FIX10A §3.5 — clientVersion handling', () => {
  it('preserves a non-empty clientVersion', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS, clientVersion: '3.0.0' });
    expect(body.clientVersion).toBe('3.0.0');
  });

  it('omits an empty clientVersion', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS, clientVersion: '' });
    expect('clientVersion' in body).toBe(false);
  });

  it('omits an undefined clientVersion', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS });
    expect('clientVersion' in body).toBe(false);
  });
});

describe('Stage 3C-CI-FIX10A §3.6 — serialized JSON never carries installationId:null', () => {
  it('minimal body serializes to just username + password', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS });
    const json = JSON.stringify(body);
    expect(json).not.toContain('installationId');
    expect(json).not.toContain('null');
    expect(json).toBe(JSON.stringify({ username: USER, password: PASS }));
  });

  it('null input never leaks into serialized JSON', () => {
    const body = buildOperatorLoginBody({ username: USER, password: PASS, installationId: null, clientVersion: '' });
    const json = JSON.stringify(body);
    // The critical regression byte-sequence — must NEVER appear.
    expect(json).not.toContain('"installationId":null');
    expect(json).not.toContain('installationId');
    expect(json).not.toContain('clientVersion');
  });

  it('full body preserves both optional fields in fixed order', () => {
    const body = buildOperatorLoginBody({
      username: USER, password: PASS, installationId: 42, clientVersion: '3.0.0',
    });
    const json = JSON.stringify(body);
    // Field-order invariant so a serialization audit can grep bytes.
    expect(json).toBe(JSON.stringify({
      username: USER, password: PASS, installationId: 42, clientVersion: '3.0.0',
    }));
  });
});

describe('Stage 3C-CI-FIX10A §3.7 — helper output passes the server login schema', () => {
  const cases: ReadonlyArray<{ name: string; input: Parameters<typeof buildOperatorLoginBody>[0] }> = [
    { name: 'minimal (u+p only)', input: { username: USER, password: PASS } },
    { name: 'null installationId', input: { username: USER, password: PASS, installationId: null } },
    { name: 'undefined installationId', input: { username: USER, password: PASS, installationId: undefined } },
    { name: 'numeric installationId', input: { username: USER, password: PASS, installationId: 42 } },
    { name: 'string installationId', input: { username: USER, password: PASS, installationId: 'installation-reference' } },
    { name: 'clientVersion only', input: { username: USER, password: PASS, clientVersion: '3.0.0' } },
    { name: 'all fields', input: { username: USER, password: PASS, installationId: 42, clientVersion: '3.0.0' } },
    { name: 'empty strings absent', input: { username: USER, password: PASS, installationId: '', clientVersion: '' } },
  ];
  for (const c of cases) {
    it(`accepts ${c.name}`, () => {
      const body = buildOperatorLoginBody(c.input);
      const parsed = SERVER_LOGIN_BODY_SCHEMA.safeParse(body);
      expect(parsed.success, JSON.stringify({ input: c.input, body, err: parsed.success ? null : parsed.error.issues })).toBe(true);
    });
  }
});

describe('Stage 3C-CI-FIX10A §3.8 — explicit installationId:null fails the server schema', () => {
  it('directly injecting installationId:null (bypassing the helper) is rejected', () => {
    // This proves the schema strictness the FIX10A body avoids
    // triggering. Do NOT weaken the server schema to accept null —
    // the fix is on the desktop side.
    const badBody = { username: USER, password: PASS, installationId: null };
    const parsed = SERVER_LOGIN_BODY_SCHEMA.safeParse(badBody);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('installationId');
    }
  });
});

describe('Stage 3C-CI-FIX10A §3.9 — username and password pass through unchanged', () => {
  const cases: ReadonlyArray<{ user: string; pass: string }> = [
    { user: 'nativeoperator', pass: 'Native-3C-passphrase-!' },
    { user: 'MixedCaseUser', pass: 'A different Passphrase 123 !@#' },
    { user: 'unicode-α-β', pass: 'unicode passphrase with 空白' },
    { user: 'trailing-space ', pass: ' leading-space' },
  ];
  for (const c of cases) {
    it(`preserves username=${JSON.stringify(c.user)}`, () => {
      const body = buildOperatorLoginBody({ username: c.user, password: c.pass });
      expect(body.username).toBe(c.user);
      expect(body.password).toBe(c.pass);
    });
  }
});

describe('Stage 3C-CI-FIX10A §3.10 — helper source contains no password logging or diagnostic (AST-based)', () => {
  // Parse once. The helper must be a pure function — every I/O sink
  // (console.*, logger.*, process.stdout/stderr) is banned STRUCTURALLY;
  // if any survives an AST walk of CallExpressions, that's a real
  // exposure risk. Also: no CallExpression argument may reference the
  // `password` identifier (the input field name) or a `token` identifier.
  const src = readFileSync(resolve(__dirname, '..', '..', 'src/main/operatorLoginBody.ts'), 'utf8');
  const sourceFile = ts.createSourceFile(
    'operatorLoginBody.ts',
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  function walk(node: ts.Node, out: ts.Node[] = []): ts.Node[] {
    out.push(node);
    node.forEachChild((c) => walk(c, out));
    return out;
  }
  const nodes = walk(sourceFile);

  it('no CallExpression targets console.* / logger.* / process.stdout|stderr', () => {
    const offenders: string[] = [];
    for (const node of nodes) {
      if (!ts.isCallExpression(node)) continue;
      const text = node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 120);
      // Any call chain whose leftmost identifier is console / logger,
      // or whose expression text starts with process.stdout / process.stderr.
      let root: ts.Node = node.expression;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      if (ts.isIdentifier(root)) {
        const name = String(root.escapedText);
        if (name === 'console' || name === 'logger') offenders.push(text);
      }
      if (/^process\.(stdout|stderr)\b/.test(node.expression.getText(sourceFile))) {
        offenders.push(text);
      }
    }
    expect(offenders, `unexpected I/O-sink calls in operatorLoginBody.ts:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no CallExpression argument references the `password` or `token` identifier', () => {
    const offenders: string[] = [];
    for (const node of nodes) {
      if (!ts.isCallExpression(node)) continue;
      for (const arg of node.arguments) {
        // Walk arg subtree looking for identifiers named password/token.
        const argNodes = walk(arg);
        for (const inner of argNodes) {
          if (ts.isIdentifier(inner)) {
            const name = String(inner.escapedText);
            if (name === 'password' || name === 'token') {
              offenders.push(`${node.getText(sourceFile).slice(0, 120)}`);
              break;
            }
          }
        }
      }
    }
    expect(offenders, `password/token flowed into a call:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the module has no imports that would enable I/O side effects', () => {
    const imports = nodes.filter(ts.isImportDeclaration);
    // The helper is pure. Post-FIX10A it has ZERO imports.
    expect(imports.length).toBe(0);
  });
});
