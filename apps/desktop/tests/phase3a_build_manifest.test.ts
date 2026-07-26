import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateBuildManifest } from '../build/generate-build-manifest';

describe('phase3a §Z — build manifest generator', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'horizon-desktop-build-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('T61: manifest records safe-flag posture with DRY_RUN=true and ORDER_SUBMISSION_ENABLED=false', () => {
    writeFileSync(join(dir, 'main.js'), 'console.log("main")');
    const m = generateBuildManifest(dir, { name: '@horizon/desktop', version: '3.0.0' });
    expect(m.safeFlags.DRY_RUN).toBe(true);
    expect(m.safeFlags.ORDER_SUBMISSION_ENABLED).toBe(false);
    expect(m.packageName).toBe('@horizon/desktop');
    expect(m.packageVersion).toBe('3.0.0');
    expect(m.fileCount).toBe(1);
    expect(m.bundleChecksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('T62: identical source → identical bundleChecksum', () => {
    writeFileSync(join(dir, 'a.js'), 'a');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'b.js'), 'b');
    const m1 = generateBuildManifest(dir, { name: '@horizon/desktop', version: '3.0.0' });
    const m2 = generateBuildManifest(dir, { name: '@horizon/desktop', version: '3.0.0' });
    expect(m1.bundleChecksum).toBe(m2.bundleChecksum);
  });

  it('T63: modified content changes bundleChecksum', () => {
    writeFileSync(join(dir, 'a.js'), 'a');
    const m1 = generateBuildManifest(dir, { name: '@horizon/desktop', version: '3.0.0' });
    writeFileSync(join(dir, 'a.js'), 'a-mutated');
    const m2 = generateBuildManifest(dir, { name: '@horizon/desktop', version: '3.0.0' });
    expect(m1.bundleChecksum).not.toBe(m2.bundleChecksum);
  });
});
