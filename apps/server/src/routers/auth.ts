import { TRPCError } from '@trpc/server';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { AuthResponse } from '@horizon/shared';
import { ENV } from '../env';
import { publicProcedure, protectedProcedure, router } from '../lib/trpc';

/**
 * Single-user auth. The admin password hash lives in ADMIN_PASSWORD_HASH; we
 * verify against it with bcrypt and issue a JWT on success.
 */
export const authRouter = router({
  login: publicProcedure
    .input(z.object({ password: z.string().min(1) }))
    .mutation(async ({ input }): Promise<AuthResponse> => {
      if (!ENV.adminPasswordHash) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'ADMIN_PASSWORD_HASH is not configured on the server',
        });
      }
      const ok = await bcrypt.compare(input.password, ENV.adminPasswordHash);
      if (!ok) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid password' });
      }
      const token = jwt.sign({ sub: 'admin' }, ENV.jwtSecret, {
        expiresIn: ENV.jwtExpiresIn as jwt.SignOptions['expiresIn'],
      });
      return { token, expiresIn: 0 };
    }),

  me: protectedProcedure.query(({ ctx }) => {
    return { sub: ctx.user.sub };
  }),
});
