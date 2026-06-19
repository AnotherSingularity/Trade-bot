import { initTRPC, TRPCError } from '@trpc/server';
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { verifyToken, type AuthPayload } from '../middleware/auth';

/**
 * tRPC initialization: context, base router, and public/protected procedures.
 */

export interface Context {
  user: AuthPayload | null;
}

export function createContext({ req }: CreateExpressContextOptions): Context {
  const token = req.headers.authorization?.replace('Bearer ', '');
  return { user: verifyToken(token) };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/** Procedure that requires a valid JWT. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  return next({ ctx: { user: ctx.user } });
});
