import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { STRATEGY, type BotStatus } from '@horizon/shared';
import { ENV } from '../env';
import { countOpenPositions, getBotConfig } from '../db/queries';
import { getMarketWindow } from '../trading/marketWindow';

/**
 * Shared business logic used by BOTH the tRPC routers and the REST compatibility
 * layer, so the two API surfaces never drift.
 */

/** Verifies the admin password and returns a signed JWT, or null if invalid. */
export async function authenticate(password: string): Promise<string | null> {
  if (!ENV.adminPasswordHash) {
    throw new Error('ADMIN_PASSWORD_HASH is not configured on the server');
  }
  const ok = await bcrypt.compare(password, ENV.adminPasswordHash);
  if (!ok) return null;
  return jwt.sign({ sub: 'admin' }, ENV.jwtSecret, {
    expiresIn: ENV.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

/** Builds the live BotStatus DTO from config + open-position counts. */
export async function getBotStatusDTO(): Promise<BotStatus> {
  const cfg = await getBotConfig();
  const openPositions = await countOpenPositions();
  const cbActive = Boolean(cfg.circuitBreakerUntil && cfg.circuitBreakerUntil > new Date());
  return {
    isRunning: cfg.isRunning,
    isPaused: cfg.isPaused,
    consecutiveLosses: cfg.consecutiveLosses,
    circuitBreakerUntil: cfg.circuitBreakerUntil ? cfg.circuitBreakerUntil.toISOString() : null,
    circuitBreakerActive: cbActive,
    openPositions,
    maxPositions: STRATEGY.MAX_OPEN_POSITIONS,
    marketWindow: getMarketWindow(),
    updatedAt: cfg.updatedAt.toISOString(),
  };
}
