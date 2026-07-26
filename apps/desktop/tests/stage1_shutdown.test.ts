import { describe, expect, it } from 'vitest';
import { performGracefulShutdown, refuseDangerousShutdownArgs, ShutdownError } from '../src/main/shutdown';
import { InMemoryCommandRunner } from '../src/main/commandRunner';
import { ServerProcessManager } from '../src/main/serverProcess';
import { ConsoleSink, Logger } from '../src/main/logging';
import type { RuntimeAssets } from '../src/main/runtimeAssets';

const assets: RuntimeAssets = {
  mode: 'test',
  serverEntry: '/tmp/server.js',
  serverCwd: '/tmp',
  composeFile: '/tmp/compose.yml',
  composeProject: 'horizon-test',
  migrationCommand: { command: 'node', args: [], cwd: '/tmp' },
  fingerprintCommand: { command: 'node', args: [], cwd: '/tmp' },
  workingDirectory: '/tmp',
  dataDirectory: '/tmp',
  logDirectory: '/tmp',
  reportDirectory: '/tmp',
};

describe('stage1 §16 — graceful shutdown', () => {
  it('T-S1.34: graceful shutdown preserves database volumes (never down -v)', async () => {
    const runner = new InMemoryCommandRunner();
    const serverProcess = new ServerProcessManager(runner);
    const res = await performGracefulShutdown({
      runner, assets, serverProcess,
      serviceMode: 'managed_docker',
      serverIsDesktopOwned: false,
      stopContainers: true,
      logger: new Logger(new ConsoleSink(), 'test'),
    });
    // The runner log must contain `compose stop` but NEVER `down -v`.
    expect(runner.log.some((l) => /compose -p horizon-test -f \/tmp\/compose\.yml stop/.test(l))).toBe(true);
    expect(runner.log.some((l) => /down -v|--volumes/.test(l))).toBe(false);
    // Every step ran; the preserve_volumes step is recorded.
    expect(res.steps.map((s) => s.name)).toContain('preserve_volumes');
  });

  it('T-S1.35: shutdown never uses down -v (guard function)', () => {
    expect(() => refuseDangerousShutdownArgs(['compose', 'down', '-v'])).toThrow(ShutdownError);
    expect(() => refuseDangerousShutdownArgs(['compose', 'down', '--volumes'])).toThrow(ShutdownError);
    expect(() => refuseDangerousShutdownArgs(['compose', 'stop', 'db'])).not.toThrow();
    expect(() => refuseDangerousShutdownArgs(['compose', 'down'])).not.toThrow();
  });

  it('T-S1.34b: containers left running by policy when stopContainers=false', async () => {
    const runner = new InMemoryCommandRunner();
    const serverProcess = new ServerProcessManager(runner);
    const res = await performGracefulShutdown({
      runner, assets, serverProcess,
      serviceMode: 'managed_docker',
      serverIsDesktopOwned: false,
      stopContainers: false,
      logger: new Logger(new ConsoleSink(), 'test'),
    });
    expect(runner.log.some((l) => /compose.*stop/.test(l))).toBe(false);
    expect(res.steps.find((s) => s.name === 'compose_stop')?.detail).toContain('left running by policy');
  });
});
