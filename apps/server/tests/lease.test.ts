import { describe, expect, it } from 'vitest';
import { acquireLease, withLease } from '../src/jobs/lease';

describe('lease', () => {
  it('the first holder acquires; a second holder is refused until release', async () => {
    const key = `test:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
    const first = await acquireLease(key, 5_000);
    expect(first).not.toBeNull();
    const second = await acquireLease(key, 5_000);
    expect(second).toBeNull();
    await first!.release();
    const third = await acquireLease(key, 5_000);
    expect(third).not.toBeNull();
    await third!.release();
  });

  it('withLease returns ran:false when the lease is held by another holder', async () => {
    const key = `test:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
    const holder = await acquireLease(key, 5_000);
    expect(holder).not.toBeNull();
    let ran = false;
    const result = await withLease(key, 5_000, async () => {
      ran = true;
      return 42;
    });
    expect(result.ran).toBe(false);
    expect(ran).toBe(false);
    await holder!.release();
  });

  it('release only succeeds for the true holder (CAS)', async () => {
    const key = `test:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
    const lease = await acquireLease(key, 5_000);
    expect(lease).not.toBeNull();
    const ok1 = await lease!.release();
    expect(ok1).toBe(true);
    // Second release call should return false — key no longer holds our token.
    const ok2 = await lease!.release();
    expect(ok2).toBe(false);
  });
});
