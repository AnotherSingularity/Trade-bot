import { describe, expect, it } from 'vitest';
import { RedisProbe, parseRedisUrl, parseRedisVersion, parseRedisPersistencePolicy, supportsRedisVersion } from '../src/main/redisProbe';

describe('stage1 §5 — Redis probe', () => {
  it('T-S1.15a: parseRedisUrl extracts host/port', () => {
    const o = parseRedisUrl('redis://127.0.0.1:6379/0');
    expect(o.host).toBe('127.0.0.1');
    expect(o.port).toBe(6379);
    expect(o.db).toBe(0);
  });

  it('T-S1.15b: parseRedisVersion picks up redis_version', () => {
    expect(parseRedisVersion('# Server\r\nredis_version:7.4.1\r\nredis_git_sha:0\r\n')).toBe('7.4.1');
  });
  it('T-S1.15c: supportsRedisVersion accepts 6+', () => {
    expect(supportsRedisVersion('7.4.1').ok).toBe(true);
    expect(supportsRedisVersion('5.0.14').ok).toBe(false);
  });
  it('T-S1.15d: parseRedisPersistencePolicy classifies aof/rdb', () => {
    expect(parseRedisPersistencePolicy('aof_enabled:1\nrdb_last_save_time:12345')).toBe('aof+rdb');
    expect(parseRedisPersistencePolicy('aof_enabled:0\nrdb_last_save_time:12345')).toBe('rdb');
    expect(parseRedisPersistencePolicy('aof_enabled:1\n')).toBe('aof');
    expect(parseRedisPersistencePolicy('aof_enabled:0\n')).toBe('none');
  });

  it('T-S1.15: real Redis probe against localhost succeeds', async () => {
    // Stage 3C-CI-FIX4 §B4: this test is service-dependent and is
    // now in the mandatory external-services vitest config (not the
    // portable unit config). When HORIZON_REQUIRE_EXTERNAL_SERVICES=true,
    // an unreachable Redis MUST fail — no silent skip. Portable
    // Windows CI does not run this file (see vitest.config.ts
    // exclusion list).
    const probe = new RedisProbe();
    const r = await probe.probe({ url: 'redis://127.0.0.1:6379', requiredNamespace: 'horizon:*', timeoutMs: 2_000 });
    if (!r.ok && process.env.HORIZON_REQUIRE_EXTERNAL_SERVICES !== 'true') {
      // Legacy dev-only allowance for a locally-run test with no
      // services. The external-services suite sets the strict env
      // and forces failure.
      // eslint-disable-next-line no-console
      console.warn('[stage1 T-S1.15] Redis unreachable — dev-mode allowance; external suite enforces');
      return;
    }
    expect(r.ok).toBe(true);
    expect(r.version).toMatch(/^\d+\./);
  });

  it('T-S1.15e: unreachable Redis returns unreachable', async () => {
    const probe = new RedisProbe();
    // ioredis retries on connection errors; disable retries so the
    // probe returns quickly.
    const r = await probe.probe({
      url: 'redis://127.0.0.1:39998',
      timeoutMs: 500,
      options: { maxRetriesPerRequest: 0, retryStrategy: () => null },
    });
    expect(r.ok).toBe(false);
    expect(['unreachable', 'probe_threw']).toContain(r.reason);
  });
});
