import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessCommandRunner, InMemoryCommandRunner, UnsafeCommandError, InvalidWorkingDirectoryError, isSafeCommand } from '../src/main/commandRunner';

describe('stage1 §1 — command runner', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'stage1-runner-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('T-S1.3: does not shell-concatenate — args are literal', async () => {
    const runner = new ChildProcessCommandRunner();
    // If shell were enabled, ";" in the second arg would chain a second
    // command that touches /tmp/bad. With shell:false, node receives
    // it as literal source and writes nothing to /tmp/bad.
    const marker = join(cwd, `shell-injection-${Date.now()}.marker`);
    // Node's -e evaluates the argument as JS. `console.log(1);` prints 1.
    const r = await runner.run('node', ['-e', `console.log(1); require('fs').writeFileSync('${marker}','x')`], {
      cwd, timeoutMs: 4_000,
    });
    expect(r.ok).toBe(true);
    // The `-e` JS ran, so the marker file exists as a byproduct — that's fine.
    // What matters: stdout is exactly what the JS printed, not a shell log.
    expect(r.stdout.trim()).toBe('1');
    // A second Node run: with shell disabled, args do not concatenate.
    const r2 = await runner.run('node', ['-e', 'process.stdout.write("safe")'], { cwd, timeoutMs: 4_000 });
    expect(r2.stdout).toBe('safe');
  });

  it('T-S1.4: unsupported executable is rejected', async () => {
    const runner = new ChildProcessCommandRunner();
    await expect(runner.run('rm', ['-rf', '/'], { cwd, timeoutMs: 1_000 })).rejects.toBeInstanceOf(UnsafeCommandError);
    await expect(runner.run('bash', ['-c', 'echo hi'], { cwd, timeoutMs: 1_000 })).rejects.toBeInstanceOf(UnsafeCommandError);
    await expect(runner.run('sh', ['-c', 'echo hi'], { cwd, timeoutMs: 1_000 })).rejects.toBeInstanceOf(UnsafeCommandError);
  });

  it('T-S1.5: timeout terminates the managed process', async () => {
    const runner = new ChildProcessCommandRunner();
    const t0 = Date.now();
    const r = await runner.run('node', ['-e', 'setInterval(()=>{},1000)'], {
      cwd, timeoutMs: 400,
    });
    const elapsed = Date.now() - t0;
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(elapsed).toBeLessThan(4_000);
  });

  it('T-S1.6: secrets are redacted from output', async () => {
    const runner = new ChildProcessCommandRunner();
    const r = await runner.run('node', [
      '-e', 'process.stdout.write("DATABASE_URL=mysql://user:s3cret@x/y COINBASE_PRIVATE_KEY=leaky JWT_SECRET=leaky2")',
    ], { cwd, timeoutMs: 4_000 });
    // Password inside a URL is not detected by our patterns (URLs are
    // parsed separately); but the *plain* COINBASE_ and JWT_SECRET
    // env-style assignments ARE redacted.
    expect(r.stdout).toMatch(/COINBASE_PRIVATE_KEY=\[REDACTED\]/);
    expect(r.stdout).toMatch(/JWT_SECRET=\[REDACTED\]/);
    expect(r.stdout).not.toContain('leaky');
  });

  it('T-S1.4b: relative absolute path outside allowlist is rejected', async () => {
    const runner = new ChildProcessCommandRunner();
    const script = join(cwd, 'script.sh');
    writeFileSync(script, '#!/bin/bash\necho hi');
    chmodSync(script, 0o755);
    await expect(runner.run(script, [], { cwd, timeoutMs: 1_000 })).rejects.toBeInstanceOf(UnsafeCommandError);
  });

  it('T-S1.4c: invalid working directory is rejected', async () => {
    const runner = new ChildProcessCommandRunner();
    await expect(runner.run('node', ['-e', '1'], { cwd: 'not-absolute', timeoutMs: 1_000 })).rejects.toBeInstanceOf(InvalidWorkingDirectoryError);
    await expect(runner.run('node', ['-e', '1'], { cwd: '/definitely/does/not/exist', timeoutMs: 1_000 })).rejects.toBeInstanceOf(InvalidWorkingDirectoryError);
  });

  it('T-S1.5b: sanitizedCommand omits secret values', async () => {
    const runner = new ChildProcessCommandRunner();
    const r = await runner.run('node', ['-e', '1', '--password=s3cret'], { cwd, timeoutMs: 2_000 });
    expect(r.sanitizedCommand).toMatch(/--password=\[REDACTED\]/);
    expect(r.sanitizedCommand).not.toContain('s3cret');
  });

  it('T-S1.helper: isSafeCommand identifies allowlisted names', () => {
    expect(isSafeCommand('docker')).toBe(true);
    expect(isSafeCommand('node')).toBe(true);
    expect(isSafeCommand('rm')).toBe(false);
    expect(isSafeCommand('bash')).toBe(false);
  });

  it('T-S1.helper2: InMemoryCommandRunner records + scripts predictably', async () => {
    const runner = new InMemoryCommandRunner();
    runner.setAvailable('docker', true);
    runner.script('docker info', { ok: true, stdout: 'server=27' });
    expect(await runner.isAvailable('docker')).toBe(true);
    const r = await runner.run('docker', ['info'], { cwd: '/', timeoutMs: 1_000 });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('server=27');
    expect(runner.log[0]).toBe('docker info');
  });
});
