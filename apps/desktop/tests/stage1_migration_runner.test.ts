import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/main/migrationRunner';
import { InMemoryCommandRunner } from '../src/main/commandRunner';

describe('stage1 §7 — migration runner', () => {
  it('T-S1.19: migration command actually executes (invokes the runner)', async () => {
    const runner = new InMemoryCommandRunner();
    runner.script('npx drizzle-kit migrate --config /r/apps/server/drizzle.config.ts', { ok: true, stdout: 'migrated 0' });
    const mr = new MigrationRunner(runner);
    const r = await mr.apply({
      spec: { command: 'npx', args: ['drizzle-kit', 'migrate', '--config', '/r/apps/server/drizzle.config.ts'], cwd: '/r/apps/server' },
    });
    expect(r.ok).toBe(true);
    expect(runner.log[0]).toBe('npx drizzle-kit migrate --config /r/apps/server/drizzle.config.ts');
  });

  it('T-S1.20: nonzero exit blocks startup', async () => {
    const runner = new InMemoryCommandRunner();
    runner.script('npx drizzle-kit migrate --config x', { ok: false, exitCode: 2, stderr: 'boom' });
    const mr = new MigrationRunner(runner);
    const r = await mr.apply({ spec: { command: 'npx', args: ['drizzle-kit', 'migrate', '--config', 'x'], cwd: '/r' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('nonzero_exit');
  });

  it('T-S1.20b: timeout is reported', async () => {
    const runner = new InMemoryCommandRunner();
    runner.script('npx x', { ok: false, exitCode: null, stderr: '', timedOut: true });
    const mr = new MigrationRunner(runner);
    const r = await mr.apply({ spec: { command: 'npx', args: ['x'], cwd: '/r' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
  });
});
