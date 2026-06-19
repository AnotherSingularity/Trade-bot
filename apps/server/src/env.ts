import { z } from 'zod';

/**
 * Typed, validated environment configuration.
 *
 * Trading credentials (Coinbase / Anthropic) are optional so the server can
 * boot in dry-run / demo mode without live keys — the relevant integrations
 * report a clear "not configured" error when called instead of crashing boot.
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
});

function loadEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
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
    coinbaseConfigured: Boolean(e.COINBASE_KEY_NAME && e.COINBASE_PRIVATE_KEY),
    anthropicConfigured: Boolean(e.ANTHROPIC_API_KEY),
  };
}

export const ENV = loadEnv();
export type Env = typeof ENV;
