import { describe, expect, it } from 'vitest';
import { MariadbProbe, supportsVersion } from '../src/main/mariadbProbe';

describe('stage1 §5 — MariaDB probe', () => {
  it('T-S1.14a: supportsVersion accepts MySQL 8+', () => {
    expect(supportsVersion('8.0.40').ok).toBe(true);
    expect(supportsVersion('5.7.44').ok).toBe(false);
  });
  it('T-S1.14b: supportsVersion accepts MariaDB 10+', () => {
    expect(supportsVersion('10.11.6-MariaDB').ok).toBe(true);
    expect(supportsVersion('9.5.0-MariaDB').ok).toBe(false);
  });

  it('T-S1.14: real DB probe against local MariaDB succeeds', async () => {
    const probe = new MariadbProbe();
    const r = await probe.probe({
      connection: { host: '127.0.0.1', port: 3306, user: 'root', password: 'password', database: 'horizon_trade_test' },
      expectedDatabase: 'horizon_trade_test',
      timeoutMs: 3_000,
    });
    expect(r.ok).toBe(true);
    expect(r.serverVersion).toMatch(/^\d+\./);
    expect(r.currentDatabase).toBe('horizon_trade_test');
  });

  it('T-S1.14d: unreachable host returns unreachable', async () => {
    const probe = new MariadbProbe();
    const r = await probe.probe({
      connection: { host: '127.0.0.1', port: 39999, user: 'root', password: '', database: 'horizon_trade_test' },
      expectedDatabase: 'horizon_trade_test',
      timeoutMs: 500,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unreachable');
  });

  it('T-S1.14e: wrong database returns database_missing', async () => {
    const probe = new MariadbProbe();
    const r = await probe.probe({
      connection: { host: '127.0.0.1', port: 3306, user: 'root', password: 'password', database: 'horizon_trade_test' },
      expectedDatabase: 'nonexistent_db',
      timeoutMs: 3_000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('database_missing');
  });
});
