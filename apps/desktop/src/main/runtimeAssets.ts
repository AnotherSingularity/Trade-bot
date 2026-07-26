/**
 * Stage 1 §2 — Runtime-asset resolver.
 *
 * The installed or dev desktop app must know where its assets are.
 * No path is guessed from the terminal cwd; every path is explicit.
 * Missing assets fail startup so the operator sees the exact
 * misconfiguration rather than a stub-happy fake.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type RuntimeMode = 'development' | 'packaged' | 'test';

export interface CommandSpec {
  command: string;
  args: readonly string[];
  cwd: string;
}

export interface RuntimeAssets {
  mode: RuntimeMode;
  serverEntry: string;
  serverCwd: string;
  composeFile: string;
  composeProject: string;
  projectRoot?: string;
  migrationCommand: CommandSpec;
  fingerprintCommand: CommandSpec;
  workingDirectory: string;
  dataDirectory: string;
  logDirectory: string;
  reportDirectory: string;
}

export interface RuntimeAssetsInput {
  mode: RuntimeMode;
  projectRoot?: string;
  packagedResources?: string;
  userDataDirectory: string;
  logDirectory: string;
  reportDirectory: string;
  composeFileName?: string;
  composeProject?: string;
}

export class RuntimeAssetError extends Error {
  constructor(reason: string, missing: readonly string[]) {
    super(`runtime_assets_error: ${reason}: missing=[${missing.join(', ')}]`);
  }
}

const REQUIRED_PROJECT_FILES: readonly string[] = [
  'apps/server/package.json',
  'apps/server/drizzle.config.ts',
  'apps/server/drizzle/migrations/meta/_journal.json',
];

const REQUIRED_PACKAGED_FILES: readonly string[] = [
  'server/package.json',
  'server/drizzle/migrations/meta/_journal.json',
];

export function resolveRuntimeAssets(input: RuntimeAssetsInput): RuntimeAssets {
  if (input.mode === 'development' || input.mode === 'test') {
    return resolveDevelopment(input);
  }
  return resolvePackaged(input);
}

function resolveDevelopment(input: RuntimeAssetsInput): RuntimeAssets {
  if (!input.projectRoot || !isAbsolute(input.projectRoot)) {
    throw new RuntimeAssetError('dev_projectRoot_required', ['projectRoot']);
  }
  const root = input.projectRoot;
  const missing: string[] = [];
  for (const f of REQUIRED_PROJECT_FILES) {
    if (!existsSync(join(root, f))) missing.push(f);
  }
  if (missing.length > 0) throw new RuntimeAssetError('dev_missing_required', missing);

  const composeFileName = input.composeFileName ?? 'docker-compose.prod.yml';
  const composeFile = join(root, composeFileName);
  if (!existsSync(composeFile)) throw new RuntimeAssetError('compose_file_missing', [composeFileName]);

  const serverCwd = join(root, 'apps/server');
  const serverEntry = join(serverCwd, 'src/index.ts'); // dev: tsx runs .ts directly

  ensureDir(input.userDataDirectory, 'userDataDirectory');
  ensureDir(input.logDirectory, 'logDirectory');
  ensureDir(input.reportDirectory, 'reportDirectory');

  return {
    mode: input.mode,
    serverEntry,
    serverCwd,
    composeFile,
    composeProject: input.composeProject ?? 'horizon-trade',
    projectRoot: root,
    migrationCommand: {
      command: 'npx',
      args: ['drizzle-kit', 'migrate', '--config', join(serverCwd, 'drizzle.config.ts')],
      cwd: serverCwd,
    },
    fingerprintCommand: {
      command: 'npx',
      args: ['drizzle-kit', 'generate', '--config', join(serverCwd, 'drizzle.config.ts')],
      cwd: serverCwd,
    },
    workingDirectory: root,
    dataDirectory: input.userDataDirectory,
    logDirectory: input.logDirectory,
    reportDirectory: input.reportDirectory,
  };
}

function resolvePackaged(input: RuntimeAssetsInput): RuntimeAssets {
  if (!input.packagedResources || !isAbsolute(input.packagedResources)) {
    throw new RuntimeAssetError('packaged_resources_required', ['packagedResources']);
  }
  const resources = input.packagedResources;
  const missing: string[] = [];
  for (const f of REQUIRED_PACKAGED_FILES) {
    if (!existsSync(join(resources, f))) missing.push(f);
  }
  if (missing.length > 0) throw new RuntimeAssetError('packaged_missing_required', missing);

  const composeFileName = input.composeFileName ?? 'docker-compose.prod.yml';
  const composeFile = join(resources, composeFileName);
  if (!existsSync(composeFile)) throw new RuntimeAssetError('compose_file_missing', [composeFileName]);

  const serverCwd = join(resources, 'server');
  const serverEntry = join(serverCwd, 'dist/index.js');

  ensureDir(input.userDataDirectory, 'userDataDirectory');
  ensureDir(input.logDirectory, 'logDirectory');
  ensureDir(input.reportDirectory, 'reportDirectory');

  return {
    mode: input.mode,
    serverEntry,
    serverCwd,
    composeFile,
    composeProject: input.composeProject ?? 'horizon-trade',
    migrationCommand: {
      command: 'node',
      args: [join(serverCwd, 'dist/scripts/migrate.js')],
      cwd: serverCwd,
    },
    fingerprintCommand: {
      command: 'node',
      args: [join(serverCwd, 'dist/scripts/fingerprint.js')],
      cwd: serverCwd,
    },
    workingDirectory: resources,
    dataDirectory: input.userDataDirectory,
    logDirectory: input.logDirectory,
    reportDirectory: input.reportDirectory,
  };
}

function ensureDir(path: string, label: string): void {
  if (!isAbsolute(path)) throw new RuntimeAssetError('path_not_absolute', [label]);
  try {
    const st = statSync(path);
    if (!st.isDirectory()) throw new Error('not_a_directory');
  } catch {
    throw new RuntimeAssetError('directory_missing_or_unreadable', [label]);
  }
}

export function sanitizedAssetSummary(assets: RuntimeAssets): Record<string, string> {
  // Never expose absolute paths that could reveal secret file names,
  // but the operator-facing diagnostic report is fine as-is because
  // these are all just directory / file locations, not credentials.
  return {
    mode: assets.mode,
    serverEntry: assets.serverEntry,
    composeFile: assets.composeFile,
    composeProject: assets.composeProject,
    workingDirectory: assets.workingDirectory,
    dataDirectory: assets.dataDirectory,
    logDirectory: assets.logDirectory,
    reportDirectory: assets.reportDirectory,
  };
}

// Helper used by dev boot and by the vitest harness.
export function inferDevProjectRoot(startAt: string): string {
  let cur = resolve(startAt);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, 'apps/server/drizzle.config.ts'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new RuntimeAssetError('cannot_infer_project_root', [startAt]);
}
