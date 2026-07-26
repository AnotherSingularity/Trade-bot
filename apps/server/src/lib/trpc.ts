import { initTRPC, TRPCError } from '@trpc/server';
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { verifyToken, type AuthPayload } from '../middleware/auth';
import { verifyAccessToken } from '../auth/sessions';
import { findById as findAccountById } from '../auth/accounts';
import type { LocalOperatorAccountRow, OperatorAuthSessionRow } from '../db/schema';

/**
 * tRPC initialization: context, base router, and public/protected procedures.
 *
 * Stage 2-FIX §3 — authorization context is created SERVER-SIDE from the
 * Authorization header only. Nothing a client puts in a procedure input,
 * query parameter, or custom header can mint an identity:
 *
 *   - An opaque operator access token (no '.' separator) is verified
 *     against `operator_auth_sessions` (hash lookup + expiry + revocation
 *     + account status).
 *   - A legacy JWT (contains '.') is verified against JWT_SECRET. This is
 *     the pre-Stage-2 mobile path — password-authenticated, never
 *     anonymous.
 *   - The desktop bootstrap token is NOT accepted here in any form: it is
 *     hex (no dots) so it takes the operator-session path, its hash never
 *     matches a session row, and the context stays unauthenticated.
 *
 * Every failure path yields `auth: null` — there is no anonymous
 * fallback identity.
 */

export type AuthContext =
  | { kind: 'operator'; account: LocalOperatorAccountRow; session: OperatorAuthSessionRow }
  | { kind: 'legacy_jwt'; payload: AuthPayload };

export interface Context {
  auth: AuthContext | null;
  /** Back-compat identity view for routers that only need a subject label. */
  user: AuthPayload | null;
}

export async function createContext({ req }: CreateExpressContextOptions): Promise<Context> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
  if (!token) return { auth: null, user: null };

  if (!token.includes('.')) {
    // Opaque operator-session token path.
    const result = await verifyAccessToken(token);
    if (!result.ok) return { auth: null, user: null };
    const account = await findAccountById(result.row.accountId);
    if (!account || account.status !== 'active') return { auth: null, user: null };
    return {
      auth: { kind: 'operator', account, session: result.row },
      user: { sub: `operator:${account.usernameNormalized}` },
    };
  }

  // Legacy JWT path (mobile).
  const payload = verifyToken(token);
  if (!payload) return { auth: null, user: null };
  return { auth: { kind: 'legacy_jwt', payload }, user: payload };
}

/**
 * Meta shape used by the tRPC inventory (Stage 2-FIX §3). Every
 * procedure factory sets one — the inventory audit rejects any
 * procedure that leaves `authScope` unset (fails closed).
 */
export interface ProcedureMeta {
  authScope: 'public_auth_op' | 'operator_authenticated_business' | 'internal_or_test';
}

const t = initTRPC.context<Context>().meta<ProcedureMeta>().create();

export const router = t.router;

/**
 * Public procedures are RESERVED for authentication operations (login).
 * The stage2fix tRPC inventory test fails if any procedure outside the
 * explicit public allowlist is built on this — unclassified procedures
 * fail closed at verification time.
 */
export const publicProcedure = t.procedure.meta({ authScope: 'public_auth_op' });

/** Procedure that requires an authenticated identity (operator session or legacy JWT). */
export const protectedProcedure = t.procedure
  .meta({ authScope: 'operator_authenticated_business' })
  .use(({ ctx, next }) => {
    if (!ctx.auth || !ctx.user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }
    return next({ ctx: { auth: ctx.auth, user: ctx.user } });
  });

/** Procedure that requires a Stage 2 operator session specifically (no legacy JWT). */
export const operatorProcedure = t.procedure
  .meta({ authScope: 'operator_authenticated_business' })
  .use(({ ctx, next }) => {
    if (!ctx.auth || ctx.auth.kind !== 'operator') {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Operator session required' });
    }
    return next({ ctx: { auth: ctx.auth, user: ctx.user! } });
  });
