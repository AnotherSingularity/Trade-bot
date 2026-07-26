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
    const probe = new RedisProbe();
    const r = await probe.probe({ url: 'redis://127.0.0.1:6379', requiredNamespace: 'horizon:*', timeoutMs: 2_000 });
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
