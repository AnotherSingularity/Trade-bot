/**
 * Stage 1 §3, §4 — Real Docker probing.
 *
 * Distinct failure states so the operator can act on the exact issue:
 *   - docker_not_installed
 *   - docker_daemon_unavailable
 *   - compose_unavailable
 *   - compose_file_missing
 *   - service_definition_missing
 *   - container_start_failed
 *   - container_unhealthy
 *
 * Also parses the selected compose file to extract the real service
 * names, so the service-name contract can be enforced against the
 * adapter's requested names.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { CommandRunner } from './commandRunner';

export type DockerFailureReason =
  | 'docker_not_installed'
  | 'docker_daemon_unavailable'
  | 'compose_unavailable'
  | 'compose_file_missing'
  | 'service_definition_missing'
  | 'container_start_failed'
  | 'container_unhealthy';

export interface DockerCheckResult {
  ok: boolean;
  reason?: DockerFailureReason;
  detail?: string;
}

export interface DockerProbe {
  checkDocker(): Promise<DockerCheckResult>;
  checkDaemon(): Promise<DockerCheckResult>;
  checkCompose(): Promise<DockerCheckResult>;
  checkComposeFile(composeFile: string): Promise<DockerCheckResult>;
  listComposeServices(composeFile: string): readonly string[];
  containerHealth(project: string, service: string): Promise<DockerCheckResult>;
}

export class RealDockerProbe implements DockerProbe {
  constructor(private readonly runner: CommandRunner) {}

  async checkDocker(): Promise<DockerCheckResult> {
    const available = await this.runner.isAvailable('docker');
    if (!available) return { ok: false, reason: 'docker_not_installed', detail: 'docker executable not in PATH' };
    return { ok: true };
  }

  async checkDaemon(): Promise<DockerCheckResult> {
    const r = await this.runner.run('docker', ['info', '--format', '{{.ServerVersion}}'], {
      cwd: process.cwd(), timeoutMs: 6_000, maxBufferBytes: 4_096,
    });
    if (!r.ok) return { ok: false, reason: 'docker_daemon_unavailable', detail: r.stderr.slice(0, 200) || 'daemon unreachable' };
    return { ok: true, detail: `server=${r.stdout.trim()}` };
  }

  async checkCompose(): Promise<DockerCheckResult> {
    const r = await this.runner.run('docker', ['compose', 'version', '--short'], {
      cwd: process.cwd(), timeoutMs: 4_000, maxBufferBytes: 4_096,
    });
    if (!r.ok) return { ok: false, reason: 'compose_unavailable', detail: 'docker compose subcommand not available' };
    return { ok: true, detail: `compose=${r.stdout.trim()}` };
  }

  async checkComposeFile(composeFile: string): Promise<DockerCheckResult> {
    if (!existsSync(composeFile)) {
      return { ok: false, reason: 'compose_file_missing', detail: composeFile };
    }
    try {
      const services = this.listComposeServices(composeFile);
      if (services.length === 0) return { ok: false, reason: 'service_definition_missing', detail: 'no services parsed' };
      return { ok: true, detail: `services=${services.join(',')}` };
    } catch (e) {
      return { ok: false, reason: 'compose_file_missing', detail: `parse_error: ${String(e).slice(0, 200)}` };
    }
  }

  listComposeServices(composeFile: string): readonly string[] {
    const raw = readFileSync(composeFile, 'utf8');
    return parseComposeServiceNames(raw);
  }

  async containerHealth(project: string, service: string): Promise<DockerCheckResult> {
    const r = await this.runner.run('docker', [
      'compose', '-p', project, 'ps', '--format', 'json', service,
    ], { cwd: process.cwd(), timeoutMs: 6_000, maxBufferBytes: 65_536 });
    if (!r.ok) return { ok: false, reason: 'container_start_failed', detail: r.stderr.slice(0, 200) };
    if (!r.stdout.trim()) return { ok: false, reason: 'container_start_failed', detail: 'container_not_found' };
    // Look for `"Health":"healthy"` or `"State":"running"` in the JSON output.
    if (/"Health"\s*:\s*"healthy"/.test(r.stdout)) return { ok: true, detail: 'healthy' };
    if (/"State"\s*:\s*"running"/.test(r.stdout)) return { ok: true, detail: 'running_no_healthcheck' };
    return { ok: false, reason: 'container_unhealthy', detail: r.stdout.slice(0, 200) };
  }
}

/**
 * Minimal YAML `services:` parser sufficient for our compose files.
 * Extracts the immediate child keys of the top-level `services:`
 * mapping. Handles inline comments and blank lines.
 */
export function parseComposeServiceNames(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  let inServices = false;
  let servicesIndent = -1;
  const services: string[] = [];
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const stripped = line.replace(/#.*$/, '').trimEnd();
    if (!stripped) continue;
    const indent = stripped.match(/^\s*/)?.[0].length ?? 0;
    if (!inServices && /^\s*services\s*:\s*$/.test(stripped)) {
      inServices = true;
      servicesIndent = indent;
      continue;
    }
    if (inServices) {
      if (indent <= servicesIndent && !stripped.startsWith(' ')) {
        // Left the services block.
        inServices = false;
        continue;
      }
      // Direct child of services: exactly two-space indent (or 4) more than servicesIndent,
      // ends with `:` and no further nested key on the same line.
      if (indent === servicesIndent + 2 && /^[\s]*[a-zA-Z0-9_-]+\s*:\s*$/.test(stripped)) {
        const name = stripped.trim().replace(/:\s*$/, '');
        services.push(name);
      }
    }
  }
  return services;
}
