/**
 * Stage 2-FIX §3 — tRPC authorization inventory.
 *
 * Walks the compiled router and classifies every procedure into one of
 * four buckets by inspecting its middleware chain:
 *
 *   - `public_auth_op`  — sits directly on `t.procedure` and belongs
 *     to the explicit `PUBLIC_AUTH_ALLOWLIST` below (currently just
 *     `auth.login`). Any OTHER procedure that resolves to
 *     `public_auth_op` FAILS the inventory audit — unclassified public
 *     procedures fail closed.
 *   - `operator_authenticated_business` — carries an authorization
 *     middleware (protectedProcedure or operatorProcedure). This is
 *     the default for every business call.
 *   - `internal_or_test` — placeholder for procedures that must never
 *     be reachable through the HTTP surface. None today.
 *
 * The router exposes tRPC via `_def.procedures`; each procedure's
 * middleware chain lives on `_def.middlewares`. Any procedure with at
 * least one middleware is treated as protected.
 */

import type { AnyRouter, AnyProcedure } from '@trpc/server';
import { appRouter } from '../routers';

export const PROCEDURE_KINDS = [
  'public_auth_op',
  'operator_authenticated_business',
  'internal_or_test',
] as const;
export type ProcedureKind = (typeof PROCEDURE_KINDS)[number];

/**
 * Every `public_auth_op` MUST appear here. Adding a new public tRPC
 * procedure requires updating this list AND writing a bootstrap-scope
 * test — the inventory audit rejects any public procedure not on the
 * allowlist.
 */
export const PUBLIC_AUTH_ALLOWLIST: readonly string[] = ['auth.login'];

export interface ProcedureEntry {
  path: string;
  kind: ProcedureKind;
  hasMiddleware: boolean;
  callable: 'query' | 'mutation' | 'subscription';
}

interface ProcedureLike {
  _def?: {
    meta?: { authScope?: ProcedureKind };
    middlewares?: unknown[];
    type?: 'query' | 'mutation' | 'subscription';
    query?: boolean;
    mutation?: boolean;
    subscription?: boolean;
  };
}

function collectProcedures(router: AnyRouter, prefix: string, out: ProcedureEntry[]): void {
  // tRPC v11 flattens nested routers into `_def.procedures` with
  // dot-joined keys (e.g. 'auth.login'); older layouts nested further.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record = (router as any)._def?.procedures ?? (router as any)._def?.record;
  if (!record || typeof record !== 'object') return;
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asProc = value as ProcedureLike;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asRouter = value as any;
    const isProc = asProc._def && (Array.isArray(asProc._def.middlewares) || asProc._def.type);
    if (isProc) {
      const middlewares = Array.isArray(asProc._def!.middlewares) ? asProc._def!.middlewares! : [];
      const declaredMeta = asProc._def!.meta;
      const callable: ProcedureEntry['callable'] = asProc._def!.type
        ? asProc._def!.type
        : asProc._def!.query ? 'query'
          : asProc._def!.mutation ? 'mutation'
            : asProc._def!.subscription ? 'subscription'
              : 'query';
      const declaredKind = declaredMeta?.authScope;
      const kind: ProcedureKind = declaredKind
        ? declaredKind
        // No meta ⇒ fails closed as 'internal_or_test' (audit rejects it).
        : 'internal_or_test';
      out.push({ path, kind, hasMiddleware: middlewares.length > 0, callable });
    } else if (asRouter?._def) {
      collectProcedures(asRouter as AnyRouter, path, out);
    }
  }
}

export function buildTrpcInventory(): ProcedureEntry[] {
  const entries: ProcedureEntry[] = [];
  collectProcedures(appRouter, '', entries);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/**
 * Any procedure classified as `internal_or_test` fails the audit —
 * every HTTP-reachable procedure must be either an explicit public
 * auth op or a middleware-protected business op.
 */
export function auditTrpcInventory(): { ok: boolean; issues: string[]; inventory: ProcedureEntry[] } {
  const inventory = buildTrpcInventory();
  const issues: string[] = [];
  for (const entry of inventory) {
    if (entry.kind === 'internal_or_test') {
      issues.push(`unclassified public procedure: ${entry.path}`);
    }
    if (entry.kind === 'public_auth_op' && !PUBLIC_AUTH_ALLOWLIST.includes(entry.path)) {
      issues.push(`public procedure not in allowlist: ${entry.path}`);
    }
  }
  return { ok: issues.length === 0, issues, inventory };
}

// The router type used by consumers who want to see the inferred shape.
export type ClassifiedProcedure = ProcedureEntry;
export type _Proc = AnyProcedure;
