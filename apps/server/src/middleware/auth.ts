import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ENV } from '../env';

export interface AuthPayload {
  sub: string;
  iat?: number;
  exp?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/** Verifies a Bearer JWT and attaches the payload to the request. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    req.user = jwt.verify(token, ENV.jwtSecret) as AuthPayload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/** Verifies a raw token string (used by the tRPC context). Returns null on failure. */
export function verifyToken(token: string | undefined): AuthPayload | null {
  if (!token) return null;
  try {
    return jwt.verify(token, ENV.jwtSecret) as AuthPayload;
  } catch {
    return null;
  }
}
