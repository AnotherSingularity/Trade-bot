import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { AuthResponse } from '@horizon/shared';
import { authenticate } from '../lib/services';
import { publicProcedure, protectedProcedure, router } from '../lib/trpc';

/**
 * Single-user auth. The admin password hash lives in ADMIN_PASSWORD_HASH; we
 * verify against it with bcrypt and issue a JWT on success.
 */
export const authRouter = router({
  login: publicProcedure
    .input(z.object({ password: z.string().min(1) }))
    .mutation(async ({ input }): Promise<AuthResponse> => {
      let token: string | null;
      try {
        token = await authenticate(input.password);
      } catch (err) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: err instanceof Error ? err.message : 'Auth not configured',
        });
      }
      if (!token) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid password' });
      }
      return { token, expiresIn: 0 };
    }),

  me: protectedProcedure.query(({ ctx }) => {
    return { sub: ctx.user.sub };
  }),
});
