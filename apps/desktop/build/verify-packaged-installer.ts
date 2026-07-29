#!/usr/bin/env tsx
/**
 * Stage 5D §CI — Windows installer smoke verifier.
 *
 * Runs AFTER `electron-builder --win` in CI. Verifies the produced
 * NSIS installer + `win-unpacked` layout and publishes the
 * `windows-installer-checksum.txt` artifact that the human operator
 * smoke checklist requires.
 *
 * This is the ONLY way `windows_installer_ci_smoke_verified` can be
 * claimed. It does NOT claim `windows_human_operator_smoke_verified`
 * — that requires a real workstation install + evidence per
 * `docs/operator/windows_smoke_checklist.md`.
 *
 * Safety posture:
 *   - Refuses to publish a checksum if the installer file cannot be
 *     located or is smaller than an obviously-not-empty size.
 *   - Scans the unpacked layout for forbidden literals (bearer
 *     tokens, private keys, environment credential markers,
 *     coinbase secret sentinels). If any hit, exits non-zero.
 *   - Emits `windows-installer-manifest.json` with byte-identical
 *     replay data: file size, checksum, top-level layout, packaged
 *     app.asar presence.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RELEASE = resolve(ROOT, 'release');
const UNPACKED = resolve(RELEASE, 'win-unpacked');

interface DesktopPackage {
  name: string;
  version: string;
  build: { appId: string; productName: string };
}

interface InstallerManifest {
  tool: 'verify-packaged-installer.ts';
  version: '1.0';
  runStartedAt: string;
  buildCommit: string | null;
  installer: {
    fileName: string;
    sizeBytes: number;
    sha256: string;
  };
  unpacked: {
    rootExists: boolean;
    expectedFiles: Array<{ path: string; present: boolean; sizeBytes: number | null }>;
    topLevelEntries: string[];
    hasAppAsar: boolean;
  };
  packageMetadata: {
    productName: string;
    appId: string;
    version: string;
  };
  forbiddenPatternScan: {
    patternsChecked: string[];
    filesScanned: number;
    hits: Array<{ file: string; pattern: string }>;
  };
}

function fail(code: string, detail: string): never {
  process.stderr.write(`verify_packaged_installer_failed ${code}: ${detail}\n`);
  process.exit(1);
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function findInstaller(): string {
  if (!existsSync(RELEASE)) fail('release_dir_missing', RELEASE);
  const candidates = readdirSync(RELEASE).filter((n) => n.toLowerCase().endsWith('.exe'));
  if (candidates.length === 0) fail('installer_not_found', `no .exe in ${RELEASE}`);
  const setupCandidates = candidates.filter((n) => n.toLowerCase().includes('setup') || n.toLowerCase().includes('horizon'));
  const pick = setupCandidates[0] ?? candidates[0];
  return join(RELEASE, pick);
}

function computeSha256(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Recursively enumerate files under a directory, capping traversal
 * at a sensible limit to avoid CI OOM on runaway packaging bugs.
 */
function walk(root: string, limit: number): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < limit) {
    const cur = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

/**
 * Which file extensions we actually text-scan. Skipping binaries
 * (icons, DLLs, PDBs, the packaged app.asar which is opaque) keeps
 * the scan focused on human-readable payload where a real leak would
 * show up: dropped .env files, source-mapped bundles, config JSONs.
 */
const SCAN_EXTS = new Set(['.json', '.js', '.cjs', '.mjs', '.map', '.env', '.yml', '.yaml', '.txt', '.html', '.md']);

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'bearer_token', regex: /Bearer\s+[A-Za-z0-9_.-]{20,}/ },
  { label: 'authorization_header', regex: /authorization\s*[:=]\s*Bearer/i },
  { label: 'coinbase_key', regex: /COINBASE[_-]?API[_-]?KEY\s*=/i },
  { label: 'coinbase_secret', regex: /COINBASE[_-]?API[_-]?SECRET\s*=/i },
  { label: 'bootstrap_token_literal', regex: /BOOTSTRAP_TOKEN\s*=\s*['"][A-Za-z0-9]/ },
  { label: 'private_key_pem', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'jwt_secret_literal', regex: /JWT_SECRET\s*=\s*['"][A-Za-z0-9]/ },
  { label: 'password_literal', regex: /password\s*=\s*['"][^'"\s<>]{6,}/i },
];

function scanUnpacked(): { patternsChecked: string[]; filesScanned: number; hits: Array<{ file: string; pattern: string }> } {
  const patternsChecked = FORBIDDEN_PATTERNS.map((p) => p.label);
  if (!existsSync(UNPACKED)) return { patternsChecked, filesScanned: 0, hits: [] };
  const files = walk(UNPACKED, 20_000);
  let scanned = 0;
  const hits: Array<{ file: string; pattern: string }> = [];
  for (const file of files) {
    if (!SCAN_EXTS.has(extname(file).toLowerCase())) continue;
    let text: string;
    try {
      const stat = statSync(file);
      if (stat.size > 8 * 1024 * 1024) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    scanned++;
    for (const p of FORBIDDEN_PATTERNS) {
      if (p.regex.test(text)) hits.push({ file: relative(UNPACKED, file), pattern: p.label });
    }
  }
  return { patternsChecked, filesScanned: scanned, hits };
}

function main(): void {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as DesktopPackage;
  if (pkg.name !== '@horizon/desktop') fail('unexpected_package_name', pkg.name);

  const installerPath = findInstaller();
  const st = statSync(installerPath);
  if (st.size < 20 * 1024 * 1024) fail('installer_too_small', `${st.size} bytes at ${installerPath}`);
  const sha256 = computeSha256(installerPath);

  const rootExists = existsSync(UNPACKED);
  const expected = [
    'Horizon Trade.exe',
    'resources/app.asar',
    'resources/elevate.exe',
  ];
  const expectedFiles = expected.map((rel) => {
    const p = join(UNPACKED, rel);
    if (!existsSync(p)) return { path: rel, present: false, sizeBytes: null };
    return { path: rel, present: true, sizeBytes: statSync(p).size };
  });
  const topLevelEntries = rootExists ? readdirSync(UNPACKED).sort() : [];
  const hasAppAsar = existsSync(join(UNPACKED, 'resources/app.asar'));

  if (!rootExists) fail('unpacked_missing', UNPACKED);
  if (!hasAppAsar) fail('app_asar_missing', 'resources/app.asar');
  const missingMain = expectedFiles.find((e) => e.path === 'Horizon Trade.exe' && !e.present);
  if (missingMain) fail('electron_exe_missing', 'Horizon Trade.exe');

  const scan = scanUnpacked();
  if (scan.hits.length > 0) {
    process.stderr.write('forbidden_pattern_hits:\n');
    for (const h of scan.hits) process.stderr.write(`  ${h.file}: ${h.pattern}\n`);
    fail('forbidden_pattern_hit', `${scan.hits.length} hits across ${scan.filesScanned} files`);
  }

  const manifest: InstallerManifest = {
    tool: 'verify-packaged-installer.ts',
    version: '1.0',
    runStartedAt: new Date().toISOString(),
    buildCommit: process.env.HORIZON_BUILD_COMMIT ?? null,
    installer: {
      fileName: relative(RELEASE, installerPath),
      sizeBytes: st.size,
      sha256,
    },
    unpacked: {
      rootExists,
      expectedFiles,
      topLevelEntries,
      hasAppAsar,
    },
    packageMetadata: {
      productName: pkg.build.productName,
      appId: pkg.build.appId,
      version: pkg.version,
    },
    forbiddenPatternScan: scan,
  };

  writeFileSync(join(RELEASE, 'windows-installer-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(join(RELEASE, 'windows-installer-checksum.txt'), `SHA256=${sha256}\nSIZE=${st.size}\nNAME=${manifest.installer.fileName}\n`, 'utf8');

  log(`installer_verified name=${manifest.installer.fileName} size=${st.size} sha256=${sha256}`);
  log(`unpacked_verified entries=${topLevelEntries.length} app_asar_size=${expectedFiles.find((e) => e.path === 'resources/app.asar')?.sizeBytes ?? 0}`);
  log(`forbidden_pattern_scan files=${scan.filesScanned} hits=${scan.hits.length}`);
}

main();
