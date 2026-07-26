import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseComposeServiceNames } from '../src/main/dockerProbe';

// Stage 1-FIX §A/§E — compose contract restored to MariaDB.

const composePath = join(__dirname, '..', '..', '..', 'docker-compose.prod.yml');
const composeRaw = readFileSync(composePath, 'utf8');

describe('stage1-fix — compose contract', () => {
  it('FIX-CC1: canonical service names remain db, redis, server', () => {
    const services = parseComposeServiceNames(composeRaw);
    expect(services.sort()).toContain('db');
    expect(services).toContain('redis');
    expect(services).toContain('server');
  });

  it('FIX-CC2: db is MariaDB (not MySQL)', () => {
    expect(composeRaw).toMatch(/image:\s*mariadb:/);
    expect(composeRaw).not.toMatch(/image:\s*mysql:/);
  });

  it('FIX-CC3: image versions are pinned (no floating :latest or bare tag)', () => {
    expect(composeRaw).toMatch(/mariadb:10\.\d/);
    expect(composeRaw).toMatch(/redis:7\.\d-alpine/);
    expect(composeRaw).not.toMatch(/:latest/);
  });

  it('FIX-CC4: server has a real healthcheck', () => {
    expect(composeRaw).toMatch(/server:[\s\S]*?healthcheck:[\s\S]*?wget.*\/health/);
  });

  it('FIX-CC5: db has a mariadb-admin ping healthcheck', () => {
    expect(composeRaw).toMatch(/mariadb-admin/);
  });

  it('FIX-CC6: redis has appendonly enabled', () => {
    expect(composeRaw).toMatch(/appendonly/);
  });

  it('FIX-CC7: server binds to 127.0.0.1 only', () => {
    expect(composeRaw).toMatch(/127\.0\.0\.1:3000:3000/);
  });

  it('FIX-CC8: volumes are named mariadb_data + redis_data', () => {
    expect(composeRaw).toMatch(/mariadb_data:/);
    expect(composeRaw).toMatch(/redis_data:/);
    expect(composeRaw).not.toMatch(/mysql_data:/);
  });
});
