/**
 * Stage 1 §5 — Real Redis probe.
 *
 * Verifies reachability, optional auth, INFO version, and access to
 * the required queue namespace. Uses ioredis with a lazy connect so
 * we control the timeout precisely.
 */

import Redis, { type RedisOptions } from 'ioredis';

export type RedisFailureReason =
  | 'unreachable'
  | 'auth_failed'
  | 'unsupported_version'
  | 'namespace_denied'
  | 'probe_threw';

export interface RedisProbeResult {
  ok: boolean;
  reason?: RedisFailureReason;
  detail?: string;
  version?: string;
  namespace?: string;
  persistencePolicy?: string;
}

export interface RedisProbeInput {
  url?: string;
  options?: RedisOptions;
  requiredNamespace?: string; // e.g. 'horizon:lease:*'
  timeoutMs?: number;
}

const MIN_MAJOR = 6;

export class RedisProbe {
  async probe(input: RedisProbeInput): Promise<RedisProbeResult> {
    const timeoutMs = input.timeoutMs ?? 4_000;
    const opts: RedisOptions = input.url
      ? { ...input.options, ...parseRedisUrl(input.url), lazyConnect: true, connectTimeout: timeoutMs }
      : { ...input.options, lazyConnect: true, connectTimeout: timeoutMs };
    const client = new Redis(opts);
    try {
      await withTimeout(client.connect(), timeoutMs, 'connect_timeout');
      // PING
      const ping = await withTimeout(client.ping(), timeoutMs, 'ping_timeout');
      if (ping !== 'PONG') return { ok: false, reason: 'unreachable', detail: `ping returned ${ping}` };
      // INFO
      const info = await withTimeout(client.info('server'), timeoutMs, 'info_timeout');
      const version = parseRedisVersion(info);
      const versionOk = supportsRedisVersion(version);
      if (!versionOk.ok) return { ok: false, reason: 'unsupported_version', detail: version, version };
      // persistence policy
      const persistence = await withTimeout(client.info('persistence'), timeoutMs, 'info_persistence_timeout');
      const policy = parseRedisPersistencePolicy(persistence);
      // namespace probe
      if (input.requiredNamespace) {
        try {
          await withTimeout(client.keys(input.requiredNamespace), timeoutMs, 'keys_timeout');
        } catch {
          return { ok: false, reason: 'namespace_denied', detail: input.requiredNamespace, version, persistencePolicy: policy };
        }
      }
      return { ok: true, version, namespace: input.requiredNamespace, persistencePolicy: policy };
    } catch (e) {
      const msg = String(e).slice(0, 200);
      if (/NOAUTH|WRONGPASS/i.test(msg)) return { ok: false, reason: 'auth_failed', detail: 'auth rejected' };
      if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|connect_timeout/i.test(msg)) {
        return { ok: false, reason: 'unreachable', detail: 'connection refused/timeout' };
      }
      return { ok: false, reason: 'probe_threw', detail: msg };
    } finally {
      try { await client.quit(); } catch { /* client already closed */ }
    }
  }
}

export function parseRedisUrl(url: string): RedisOptions {
  const u = new URL(url);
  const opts: RedisOptions = {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 6379,
  };
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.username && u.username !== 'default') opts.username = decodeURIComponent(u.username);
  if (u.pathname && u.pathname.length > 1) opts.db = Number(u.pathname.slice(1));
  return opts;
}

export function parseRedisVersion(info: string): string {
  const m = info.match(/redis_version:([^\r\n]+)/);
  return (m?.[1] ?? '').trim();
}

export function supportsRedisVersion(version: string): { ok: boolean } {
  const m = version.match(/^(\d+)\./);
  if (!m) return { ok: false };
  return { ok: Number(m[1]) >= MIN_MAJOR };
}

export function parseRedisPersistencePolicy(info: string): string {
  const aof = /aof_enabled:1/.test(info);
  const rdb = /rdb_last_save_time:\d+/.test(info);
  if (aof && rdb) return 'aof+rdb';
  if (aof) return 'aof';
  if (rdb) return 'rdb';
  return 'none';
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); },
           (e) => { clearTimeout(timer); reject(e); });
  });
}
