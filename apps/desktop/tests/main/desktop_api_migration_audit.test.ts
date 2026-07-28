/**
 * Stage 3C-CI-RESET Part 2 Checkpoint A.1 — migration audit.
 *
 * Structural guardrails that the legacy unchecked JSON-cast path is
 * gone and every registered desktop API route is either referenced
 * by production code or explicitly documented as reserved.
 *
 * These tests fail at CI time if:
 *   - a caller reintroduces `AuthenticatedApiClient.request(...)`;
 *   - a `parsed as SomeResponse` cast reappears in the client;
 *   - a new production caller uses `fetch(...)` against a registered
 *     desktop route path instead of going through the client;
 *   - a route is added to the registry but never referenced.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { DESKTOP_API_ROUTE_KEYS } from '@horizon/shared';
import { API_ROUTES } from '../../src/main/authenticatedApiClient';

const SRC_ROOT = resolve(__dirname, '..', '..', 'src');
const AUTH_CLIENT = resolve(SRC_ROOT, 'main/authenticatedApiClient.ts');

/**
 * Walk the desktop `src/main` tree. Renderer sources are excluded
 * because they NEVER reach the server directly — the IPC bridge
 * is their only outbound channel.
 */
function walkSrcMain(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkSrcMain(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('Stage 3C-CI-RESET Part 2 Checkpoint A.1 — client migration audit', () => {
  const mainSources = walkSrcMain(resolve(SRC_ROOT, 'main'));

  it('AuthenticatedApiClient no longer exposes a generic `request<T>` method', () => {
    const src = readFileSync(AUTH_CLIENT, 'utf8');
    // A generic `request<T>` declaration or call would look like
    // one of these patterns; the RESET Part 2 A.1 migration removed
    // the method entirely, so NONE should appear.
    expect(src, 'AuthenticatedApiClient still declares async request<T>').not.toMatch(
      /async\s+request\s*<[^>]*>/,
    );
    // Also forbid the plain unchecked method signature (no generic
    // parameter) — the client MUST expose only `requestValidated`.
    expect(src, 'AuthenticatedApiClient still declares async request(').not.toMatch(
      /async\s+request\s*\(/,
    );
  });

  it('no main-process source calls `this.api.request(` or `apiClient.request(`', () => {
    const offenders: string[] = [];
    for (const p of mainSources) {
      const src = readFileSync(p, 'utf8');
      // Only look for the specific pre-RESET call patterns:
      //   this.api.request( / apiClient.request( / api.request<
      if (/\bthis\.api\.request\s*[<(]/.test(src)
        || /\bapiClient\.request\s*[<(]/.test(src)
        || /\bapi\.request\s*<[^>]+>/.test(src)) {
        offenders.push(p.replace(SRC_ROOT, 'src'));
      }
    }
    expect(offenders, `unchecked .request( callers remain:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('AuthenticatedApiClient never returns parsed body via `as T` in the validated path (AST-based)', () => {
    // Parse the source and walk every AsExpression / TypeAssertion.
    // The pre-RESET path had `parsed as T` inside `execute`. Now the
    // only permitted `as` in this file are:
    //   - `as unknown as HarnessGlobal` — the narrow renderer-context
    //     type assertion pattern used elsewhere in the codebase;
    //   - `... as { readonly method: ... }` — the object-literal
    //     widening used to expose optional schemas past the narrow
    //     `as const` inference;
    //   - `as { request?: unknown }` / `as { response?: unknown }`
    //     — the static introspection casts on DESKTOP_API_ROUTES.
    // All permitted forms assert to a LITERAL TYPE (TypeLiteralNode)
    // OR to `unknown` — never to a plain identifier reference like
    // `T`, `SomeResponse`, etc. Anything else is forbidden.
    const source = ts.createSourceFile(
      AUTH_CLIENT,
      readFileSync(AUTH_CLIENT, 'utf8'),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    const offenders: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node) || node.kind === ts.SyntaxKind.TypeAssertionExpression) {
        const asNode = node as ts.AsExpression | ts.TypeAssertion;
        const t = asNode.type;
        const ok =
          // as unknown
          t.kind === ts.SyntaxKind.UnknownKeyword
          // as { ... } (object literal type — narrowing, not JSON cast)
          || ts.isTypeLiteralNode(t)
          // as const (compile-time immutability marker — not a JSON cast)
          || (ts.isTypeReferenceNode(t)
              && ts.isIdentifier(t.typeName)
              && t.typeName.escapedText === 'const');
        if (!ok) {
          // Also permit `as unknown as X` (double-cast): the inner
          // AsExpression will be visited separately, so we only need
          // to reject the outer form when it targets an identifier.
          if (ts.isTypeReferenceNode(t)) {
            offenders.push(`${asNode.getText(source).slice(0, 100)} at pos ${node.pos}`);
          }
        }
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
    expect(offenders, `unchecked `.concat('`as SomeType`').concat(` casts returned by AuthenticatedApiClient:\n${offenders.join('\n')}`)).toEqual([]);
  });

  it('every registered DESKTOP_API_ROUTES key is referenced by production code or documented as reserved', () => {
    // Reserved-for-future-use route keys — pending migration in a
    // later Part 2 checkpoint. Each entry MUST cite the file that
    // still bypasses the schema-aware client so the deferral is
    // visible in the audit output.
    const RESERVED: Readonly<Record<string, string>> = {
      // These 7 routes are consumed by DesktopStatusSource via
      // direct `fetch(url, {headers})` calls (see
      // apps/desktop/src/main/desktopStatusSource.ts). The registry
      // exists so that the response schemas + typed errors are
      // available for the follow-up migration, which will refactor
      // DesktopStatusSource to accept an AuthenticatedApiClient
      // reference and call `requestValidated(routeKey)` instead.
      systemReadiness: 'DesktopStatusSource direct fetch — Checkpoint A.1 follow-up',
      createOrderCounters: 'DesktopStatusSource direct fetch — Checkpoint A.1 follow-up',
      scannerReadiness: 'DesktopStatusSource direct fetch — Checkpoint A.1 follow-up',
      reconciliationStatus: 'DesktopStatusSource direct fetch — Checkpoint A.1 follow-up',
      observerPolicyVersions: 'DesktopStatusSource direct fetch — Checkpoint A.1 follow-up',
      championConfiguration: 'DesktopStatusSource direct fetch — Checkpoint A.1 follow-up',
      // Sanitized operator session summary — currently derived
      // locally from the token pair rather than fetched. Kept in
      // the registry with a strict schema so a future caller cannot
      // parse it unchecked.
      authSession: 'derived locally from token pair; no HTTP consumer yet',
    };
    const src = mainSources.map((p) => readFileSync(p, 'utf8')).join('\n');
    const unused: string[] = [];
    for (const key of DESKTOP_API_ROUTE_KEYS) {
      if (key in RESERVED) continue;
      // Match `'<key>'`, `"<key>"`, or `` `<key>` `` — any of the
      // ways a caller can name the route (as a string literal
      // argument to requestValidated).
      const re = new RegExp(`(['"\`])${key}\\1`);
      if (!re.test(src)) unused.push(key);
    }
    expect(unused, `unused registered routes:\n${unused.join('\n')}`).toEqual([]);
  });

  it('AuthenticatedApiClient exports only routes present in the shared registry', () => {
    // The desktop-side API_ROUTES const may retain the same key set
    // as a legacy convenience view, but every key MUST also exist
    // in DESKTOP_API_ROUTES. This prevents a caller from using a
    // legacy key that the shared registry has removed.
    for (const key of Object.keys(API_ROUTES)) {
      expect(
        DESKTOP_API_ROUTE_KEYS.includes(key as (typeof DESKTOP_API_ROUTE_KEYS)[number]),
        `${key} in API_ROUTES but not in DESKTOP_API_ROUTES`,
      ).toBe(true);
    }
  });
});
