import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeAssetError, inferDevProjectRoot, resolveRuntimeAssets } from '../src/main/runtimeAssets';

describe('stage1 §2 — runtime asset resolver', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'stage1-assets-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function makeDevTree(): { root: string; userData: string; logs: string; reports: string } {
    mkdirSync(join(root, 'apps/server/drizzle/migrations/meta'), { recursive: true });
    writeFileSync(join(root, 'apps/server/package.json'), '{}');
    writeFileSync(join(root, 'apps/server/drizzle.config.ts'), 'export default {};');
    writeFileSync(join(root, 'apps/server/drizzle/migrations/meta/_journal.json'), '{"entries":[]}');
    writeFileSync(join(root, 'docker-compose.prod.yml'), 'services:\n  db:\n    image: mysql:8.0.40\n');
    const userData = join(root, 'user_data'); mkdirSync(userData);
    const logs = join(root, 'logs'); mkdirSync(logs);
    const reports = join(root, 'reports'); mkdirSync(reports);
    return { root, userData, logs, reports };
  }

  it('T-S1.7: resolves in development mode', () => {
    const { root: r, userData, logs, reports } = makeDevTree();
    const assets = resolveRuntimeAssets({
      mode: 'development', projectRoot: r,
      userDataDirectory: userData, logDirectory: logs, reportDirectory: reports,
    });
    expect(assets.mode).toBe('development');
    expect(assets.composeFile).toContain('docker-compose.prod.yml');
    expect(assets.serverEntry).toContain('apps/server/src/index.ts');
  });

  it('T-S1.8: resolves in packaged mode', () => {
    mkdirSync(join(root, 'server/drizzle/migrations/meta'), { recursive: true });
    writeFileSync(join(root, 'server/package.json'), '{}');
    writeFileSync(join(root, 'server/drizzle/migrations/meta/_journal.json'), '{"entries":[]}');
    writeFileSync(join(root, 'docker-compose.prod.yml'), 'services:\n  db: {}\n');
    const userData = join(root, 'user_data'); mkdirSync(userData);
    const logs = join(root, 'logs'); mkdirSync(logs);
    const reports = join(root, 'reports'); mkdirSync(reports);
    const assets = resolveRuntimeAssets({
      mode: 'packaged', packagedResources: root,
      userDataDirectory: userData, logDirectory: logs, reportDirectory: reports,
    });
    expect(assets.mode).toBe('packaged');
    expect(assets.serverEntry).toContain('server/dist/index.js');
  });

  it('T-S1.9: missing server asset blocks startup', () => {
    const userData = join(root, 'user_data'); mkdirSync(userData);
    const logs = join(root, 'logs'); mkdirSync(logs);
    const reports = join(root, 'reports'); mkdirSync(reports);
    expect(() => resolveRuntimeAssets({
      mode: 'development', projectRoot: root,
      userDataDirectory: userData, logDirectory: logs, reportDirectory: reports,
    })).toThrow(RuntimeAssetError);
  });

  it('T-S1.10: missing compose file blocks startup', () => {
    mkdirSync(join(root, 'apps/server/drizzle/migrations/meta'), { recursive: true });
    writeFileSync(join(root, 'apps/server/package.json'), '{}');
    writeFileSync(join(root, 'apps/server/drizzle.config.ts'), '');
    writeFileSync(join(root, 'apps/server/drizzle/migrations/meta/_journal.json'), '{}');
    const userData = join(root, 'user_data'); mkdirSync(userData);
    const logs = join(root, 'logs'); mkdirSync(logs);
    const reports = join(root, 'reports'); mkdirSync(reports);
    expect(() => resolveRuntimeAssets({
      mode: 'development', projectRoot: root,
      userDataDirectory: userData, logDirectory: logs, reportDirectory: reports,
      composeFileName: 'docker-compose.prod.yml',
    })).toThrow(/compose_file_missing/);
  });

  it('T-S1.11: inferDevProjectRoot walks up to find drizzle.config.ts', () => {
    const nested = join(root, 'apps/server/src/main');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'apps/server/drizzle.config.ts'), '');
    expect(inferDevProjectRoot(nested)).toBe(root);
  });
});
