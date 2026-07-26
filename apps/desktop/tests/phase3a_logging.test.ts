import { describe, expect, it } from 'vitest';
import { Logger, MemorySink, redact } from '../src/main/logging';

describe('phase3a — main-process logging + redaction', () => {
  it('T54: redact strips password, token, apiKey and coinbase* fields at any depth', () => {
    const raw = {
      user: 'alice',
      password: 'p@ssw0rd',
      nested: { apiKey: 'sk_1234', innocuous: 'ok', coinbaseKey: 'cbk', coinbaseSecret: 'cbs' },
      session: { sessionToken: 't', accessToken: 'a', refreshToken: 'r' },
      authorization: 'Bearer abc',
      cookie: 'sid=xyz',
    };
    const out = redact(raw)!;
    expect(out.password).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.cookie).toBe('[REDACTED]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe('[REDACTED]');
    expect(nested.coinbaseKey).toBe('[REDACTED]');
    expect(nested.coinbaseSecret).toBe('[REDACTED]');
    expect(nested.innocuous).toBe('ok');
    const session = out.session as Record<string, unknown>;
    expect(session.sessionToken).toBe('[REDACTED]');
    expect(session.accessToken).toBe('[REDACTED]');
    expect(session.refreshToken).toBe('[REDACTED]');
  });

  it('T55: logger writes redacted entries to the sink', () => {
    const sink = new MemorySink();
    const log = new Logger(sink, 'test');
    log.info('login ok', { actor: 'alice', password: 'nope', session: { sessionToken: 'abc' } });
    expect(sink.entries).toHaveLength(1);
    const entry = sink.entries[0];
    expect(entry.level).toBe('info');
    expect(entry.scope).toBe('test');
    const data = entry.data as Record<string, unknown>;
    expect(data.password).toBe('[REDACTED]');
    const s = data.session as Record<string, unknown>;
    expect(s.sessionToken).toBe('[REDACTED]');
  });

  it('T56: logger.child appends scope segment', () => {
    const sink = new MemorySink();
    const log = new Logger(sink, 'main').child('ipc');
    log.warn('problem');
    expect(sink.entries[0].scope).toBe('main:ipc');
  });

  it('T57: no full JSON serialization of a raw credential ever appears in a log entry', () => {
    const sink = new MemorySink();
    const log = new Logger(sink, 'main');
    log.info('exchange configured', {
      coinbaseKey: 'CBXKEY-REAL-1234',
      coinbaseSecret: 'CBXSEC-REAL-1234',
    });
    const serialized = JSON.stringify(sink.entries[0]);
    expect(serialized).not.toContain('CBXKEY-REAL-1234');
    expect(serialized).not.toContain('CBXSEC-REAL-1234');
  });
});
