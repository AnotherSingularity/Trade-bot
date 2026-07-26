#!/usr/bin/env node
/**
 * Phase 3B §H — Desktop security audit.
 *
 * Static verifier over apps/desktop/src for the Electron/renderer
 * boundary invariants. Reads windows.ts, ipcContract.ts, preload/index.ts,
 * secrets.ts, authentication.ts, logging.ts and asserts the required
 * settings + surface.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const REPORT_DIR = join(REPO_ROOT, 'phase3b_audit/reports');
mkdirSync(REPORT_DIR, { recursive: true });

const D = join(REPO_ROOT, 'apps/desktop/src');

function read(f) { return readFileSync(join(D, f), 'utf8'); }

const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
}

const windows = read('main/windows.ts');
check('windows.contextIsolation=true', /contextIsolation:\s*true/.test(windows));
check('windows.nodeIntegration=false', /nodeIntegration:\s*false/.test(windows));
check('windows.sandbox=true', /sandbox:\s*true/.test(windows));
check('windows.webSecurity=true', /webSecurity:\s*true/.test(windows));
check('windows.experimentalFeatures=false', /experimentalFeatures:\s*false/.test(windows));
check('windows.allowRunningInsecureContent=false', /allowRunningInsecureContent:\s*false/.test(windows));
check('windows.absolute preload enforced', /must be absolute/.test(windows));

const ipc = read('shared/ipcContract.ts');
check('ipc.allowlist declared', /IPC_ALLOWLIST/.test(ipc));
check('ipc.SafeFlags DRY_RUN literal true', /DRY_RUN:\s*z\.literal\(true\)/.test(ipc));
check('ipc.SafeFlags ORDER_SUBMISSION_ENABLED literal false', /ORDER_SUBMISSION_ENABLED:\s*z\.literal\(false\)/.test(ipc));
check('ipc.liveOrderSubmissionDisabled literal true', /liveOrderSubmissionDisabled:\s*z\.literal\(true\)/.test(ipc));
check('ipc.every channel enumerated', /IPC_CHANNELS\s*=\s*\{/.test(ipc));

const preload = read('preload/index.ts');
check('preload.contextBridge exposed', /contextBridge\.exposeInMainWorld/.test(preload));
check('preload.no arbitrary fetch', !/fetch\(/.test(preload));
check('preload.no fs import', !/from ['"]node:fs['"]/.test(preload));

const ipcHandler = read('main/ipc.ts');
check('ipc.handler validates request', /requestSchema\.safeParse/.test(ipcHandler));
check('ipc.handler validates response', /responseSchema\.safeParse/.test(ipcHandler));
check('ipc.handler rejects channel not in allowlist', /channel_not_allowlisted/.test(ipcHandler));

const secrets = read('main/secrets.ts');
check('secrets.credential status only exposed', /present_encrypted|CredentialStatusMap/.test(secrets));
check('secrets.CredentialStatus enum documented', /export type CredentialStatus/.test(secrets));
// The status map exposes only the enum. It must not have a getCredentialValue
// method, and no code path in the adapter interface returns the stored secret.
check('secrets.no raw credential in status map',
  !/getCredentialValue\b/.test(secrets) &&
  !/return\s+plaintext/.test(secrets) &&
  !/return\s+decrypted/.test(secrets));

const auth = read('main/authentication.ts');
check('auth.scrypt hash', /scrypt/.test(auth));
check('auth.timingSafeEqual', /timingSafeEqual/.test(auth));
check('auth.rate limit', /maxAttemptsPerWindow/.test(auth));
check('auth.session expiry', /sessionDurationMs/.test(auth));
check('auth.revoke', /revoke/.test(auth));

const logging = read('main/logging.ts');
check('logging.REDACT_KEYS present', /REDACT_KEYS/.test(logging));
check('logging.password redacted', /password/.test(logging));
check('logging.coinbase secrets redacted', /coinbaseSecret/.test(logging));
check('logging.access/refresh/session tokens redacted',
  /accessToken/.test(logging) && /refreshToken/.test(logging) && /sessionToken/.test(logging));

const env = read('main/localEnvironment.ts');
check('env.rejects DRY_RUN=false', /DRY_RUN must be true/.test(env));
check('env.rejects ORDER_SUBMISSION_ENABLED=true', /ORDER_SUBMISSION_ENABLED must be false/.test(env));
check('env.rejects external provider mode', /production providers must remain inactive/.test(env));

const supervisor = read('main/serviceSupervisor.ts');
check('supervisor.crash loop escalation', /crashLoopDetected/.test(supervisor));
check('supervisor.bounded restart attempts', /maxRestartAttempts/.test(supervisor));

const summary = {
  generatedAt: process.env.HORIZON_AUDIT_TIMESTAMP ?? '1970-01-01T00:00:00.000Z',
  scope: 'apps/desktop/src',
  totalChecks: checks.length,
  passed: checks.filter((c) => c.pass).length,
  failed: checks.filter((c) => !c.pass),
  checks,
};

writeFileSync(join(REPORT_DIR, 'desktop_security_audit.json'), JSON.stringify(summary, null, 2));
process.stdout.write(`desktop_security_audit.json written — ${summary.passed}/${summary.totalChecks} checks passed\n`);
if (summary.failed.length > 0) {
  process.stderr.write(`FAILED CHECKS:\n${JSON.stringify(summary.failed, null, 2)}\n`);
  process.exit(1);
}
