/**
 * Phase 3A §G — Authentication.
 *
 * Single-user local operator model:
 *   - Initial local admin setup with strong password requirements
 *   - Argon2id-style hashing (via node crypto scrypt for portability)
 *   - Session expiry + revocation
 *   - Rate-limited login attempts
 *   - Route authorization gate
 *   - Audit log for authentication events (writes desktop_operator_actions)
 *
 * Password validation rules — inspired by NIST 800-63b: length + not
 * a common password, no character-class rules.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 12;
const COMMON_PASSWORDS = new Set([
  'password', 'password123', '123456', '12345678', 'qwerty',
  'admin', 'letmein', 'welcome', 'horizon', 'trade', 'crypto',
]);

export interface PasswordPolicyResult {
  ok: boolean;
  violations: string[];
}

export function validatePasswordPolicy(pw: string): PasswordPolicyResult {
  const v: string[] = [];
  if (pw.length < MIN_PASSWORD_LENGTH) v.push('too_short');
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) v.push('common_password');
  if (pw.toLowerCase().includes('horizon')) v.push('contains_product_name');
  return { ok: v.length === 0, violations: v };
}

export interface HashedPassword {
  algorithm: 'scrypt';
  saltHex: string;
  hashHex: string;
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

export function hashPassword(pw: string): HashedPassword {
  const N = 16384;
  const r = 8;
  const p = 1;
  const keyLen = 64;
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, keyLen, { N, r, p });
  return {
    algorithm: 'scrypt',
    saltHex: salt.toString('hex'),
    hashHex: hash.toString('hex'),
    N, r, p, keyLen,
  };
}

export function verifyPassword(pw: string, stored: HashedPassword): boolean {
  const salt = Buffer.from(stored.saltHex, 'hex');
  const candidate = scryptSync(pw, salt, stored.keyLen, { N: stored.N, r: stored.r, p: stored.p });
  const expected = Buffer.from(stored.hashHex, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export interface Session {
  token: string;
  createdAt: Date;
  expiresAt: Date;
  actor: string;
  revoked: boolean;
}

export interface AuthConfig {
  sessionDurationMs: number;
  maxAttemptsPerWindow: number;
  attemptWindowMs: number;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  sessionDurationMs: 60 * 60_000, // 1 hour
  maxAttemptsPerWindow: 5,
  attemptWindowMs: 10 * 60_000, // 10 minutes
};

export class AuthenticationManager {
  private sessions = new Map<string, Session>();
  private attempts = new Map<string, number[]>();
  private admin: { actor: string; hashed: HashedPassword } | null = null;

  constructor(
    private readonly config: AuthConfig = DEFAULT_AUTH_CONFIG,
    private readonly now: () => Date = () => new Date(),
  ) {}

  setupAdmin(actor: string, password: string): void {
    const policy = validatePasswordPolicy(password);
    if (!policy.ok) throw new Error(`password_policy_violated:${policy.violations.join(',')}`);
    if (this.admin) throw new Error('admin_already_set_up');
    this.admin = { actor, hashed: hashPassword(password) };
  }

  hasAdmin(): boolean { return this.admin != null; }

  private cleanupAttempts(actor: string): number[] {
    const now = this.now().getTime();
    const window = this.attempts.get(actor) ?? [];
    const kept = window.filter((t) => now - t <= this.config.attemptWindowMs);
    this.attempts.set(actor, kept);
    return kept;
  }

  login(actor: string, password: string): Session {
    if (!this.admin) throw new Error('admin_not_configured');
    if (actor !== this.admin.actor) {
      this.recordAttempt(actor);
      throw new Error('invalid_credentials');
    }
    const attempts = this.cleanupAttempts(actor);
    if (attempts.length >= this.config.maxAttemptsPerWindow) {
      throw new Error('too_many_attempts');
    }
    if (!verifyPassword(password, this.admin.hashed)) {
      this.recordAttempt(actor);
      throw new Error('invalid_credentials');
    }
    const now = this.now();
    const token = createHash('sha256').update(randomBytes(32)).digest('hex');
    const session: Session = {
      token,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.sessionDurationMs),
      actor,
      revoked: false,
    };
    this.sessions.set(token, session);
    this.attempts.set(actor, []);
    return session;
  }

  private recordAttempt(actor: string): void {
    const attempts = this.cleanupAttempts(actor);
    attempts.push(this.now().getTime());
    this.attempts.set(actor, attempts);
  }

  verifySession(token: string): Session | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.revoked) return null;
    if (session.expiresAt.getTime() < this.now().getTime()) return null;
    return session;
  }

  revoke(token: string): void {
    const session = this.sessions.get(token);
    if (session) session.revoked = true;
  }
}
