import 'dotenv/config';
import { z } from 'zod';

/**
 * Typed, validated environment configuration.
 *
 * Live-capable services (DRY_RUN=false) are subject to stricter validation:
 * secrets must be non-default, non-weak, and all live-required config must be
 * present. The server refuses to boot otherwise.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_EXPIRES_IN: z.string().default('30d'),
  ADMIN_PASSWORD_HASH: z.string().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  COINBASE_KEY_NAME: z.string().optional(),
  COINBASE_PRIVATE_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),

  // When true the executor logs orders instead of sending them to Coinbase.
  DRY_RUN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Live-safety: an explicit acknowledgement that operator understands this
  // deployment currently uses polling_fallback protection (no exchange-native
  // brackets). Required to start with DRY_RUN=false. Prevents accidental live
  // launch without conscious risk acceptance.
  LIVE_SAFETY_ACK_POLLING_FALLBACK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Comma-separated allowlist of origins for CORS. Falls back to '*' only in
  // development.
  CORS_ORIGINS: z.string().optional(),

  // Optional cap on login attempts per IP per minute.
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().default(10),

  // TEST-ONLY: when true AND NODE_ENV=test, the executor calls the mocked
  // Coinbase createOrder even under DRY_RUN so we can exercise unknown/reject/
  // partial-fill paths. HARD REJECTED in any other NODE_ENV so it can never
  // accidentally reach production.
  TEST_FORCE_LIVE_PATH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Phase 1 §Q double-lock killswitch. Enforced INSIDE the Coinbase client
  // (`createOrder` throws before any HTTP submit) so a bug elsewhere cannot
  // reach the exchange. Defaults `false`. Live boot (DRY_RUN=false) requires
  // this to be explicitly `true` as a separate acknowledgement.
  ORDER_SUBMISSION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Phase 1.1 Gate 3D — explicit shadow-execution mode. STANDARD_DRY_RUN
  // preserves the pre-integration baseline for A/B comparison; SHADOW_LIVE
  // routes every scan through the certified authorization pipeline (Gate
  // 3B economics + Gate 3C protection). Neither mode may reach Coinbase.
  SIMULATION_MODE: z
    .enum(['STANDARD_DRY_RUN', 'SHADOW_LIVE'])
    .default('STANDARD_DRY_RUN'),

  // Stage 2 §2 — bootstrap channel token. Hex-encoded, ≥256 bits. The
  // desktop supervisor generates one per server-process lifecycle and
  // passes it via env; production boot rejects any request to bootstrap
  // endpoints without it (loopback binding alone is insufficient).
  HORIZON_BOOTSTRAP_TOKEN: z.string().optional(),
});

const KNOWN_WEAK_SECRETS = new Set([
  'change-me-to-a-long-random-string',
  'test-secret',
  'test-secret-please-change-1234',
  'secret',
  'password',
]);

function loadEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;

  // Live-mode hardening.
  if (!e.DRY_RUN) {
    const errs: string[] = [];
    if (!e.COINBASE_KEY_NAME || !e.COINBASE_PRIVATE_KEY) {
      errs.push('DRY_RUN=false requires COINBASE_KEY_NAME and COINBASE_PRIVATE_KEY');
    }
    if (!e.ADMIN_PASSWORD_HASH) {
      errs.push('DRY_RUN=false requires ADMIN_PASSWORD_HASH');
    }
    if (KNOWN_WEAK_SECRETS.has(e.JWT_SECRET) || e.JWT_SECRET.length < 32) {
      errs.push('DRY_RUN=false requires a strong JWT_SECRET (≥32 chars, not a default)');
    }
    if (!e.LIVE_SAFETY_ACK_POLLING_FALLBACK) {
      errs.push(
        'DRY_RUN=false requires LIVE_SAFETY_ACK_POLLING_FALLBACK=true (operator ' +
          'acknowledgement that exchange-native protective orders are not confirmed; ' +
          'positions are protected by application polling only)',
      );
    }
    if (!e.ORDER_SUBMISSION_ENABLED) {
      errs.push(
        'DRY_RUN=false requires ORDER_SUBMISSION_ENABLED=true (Phase 1 §Q double-lock: ' +
          'the Coinbase client refuses to POST /orders otherwise)',
      );
    }
    if (errs.length > 0) {
      throw new Error(`Live-mode boot rejected:\n  - ${errs.join('\n  - ')}`);
    }
  }

  const coinbaseConfigured = Boolean(e.COINBASE_KEY_NAME && e.COINBASE_PRIVATE_KEY);
  const anthropicConfigured = Boolean(e.ANTHROPIC_API_KEY);

  const corsOrigins = e.CORS_ORIGINS
    ? e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : e.NODE_ENV === 'production'
      ? []
      : ['*'];

  const testForceLivePath = e.TEST_FORCE_LIVE_PATH;
  if (testForceLivePath && e.NODE_ENV !== 'test') {
    throw new Error('TEST_FORCE_LIVE_PATH may only be enabled when NODE_ENV=test');
  }

  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    isTest: e.NODE_ENV === 'test',
    port: e.PORT,
    jwtSecret: e.JWT_SECRET,
    jwtExpiresIn: e.JWT_EXPIRES_IN,
    adminPasswordHash: e.ADMIN_PASSWORD_HASH,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    coinbaseKeyName: e.COINBASE_KEY_NAME,
    coinbasePrivateKey: e.COINBASE_PRIVATE_KEY,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    dryRun: e.DRY_RUN,
    testForceLivePath,
    liveSafetyAckPollingFallback: e.LIVE_SAFETY_ACK_POLLING_FALLBACK,
    orderSubmissionEnabled: e.ORDER_SUBMISSION_ENABLED,
    corsOrigins,
    loginRateLimitPerMinute: e.LOGIN_RATE_LIMIT_PER_MINUTE,
    coinbaseConfigured,
    anthropicConfigured,
    simulationMode: e.SIMULATION_MODE,
    bootstrapToken: e.HORIZON_BOOTSTRAP_TOKEN,
  };
}

export const ENV = loadEnv();
export type Env = typeof ENV;

/**
 * TEST-ONLY: temporarily overrides ENV fields for a single test. Only usable
 * when NODE_ENV=test. Returns a restore function.
 */
export function _testOverride(patch: Partial<Env>): () => void {
  if (ENV.nodeEnv !== 'test') {
    throw new Error('_testOverride only allowed under NODE_ENV=test');
  }
  const original: Partial<Env> = {};
  for (const key of Object.keys(patch) as (keyof Env)[]) {
    original[key] = ENV[key] as never;
    (ENV as unknown as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
  }
  return () => {
    for (const key of Object.keys(original) as (keyof Env)[]) {
      (ENV as unknown as Record<string, unknown>)[key] = original[key] as never;
    }
  };
}
