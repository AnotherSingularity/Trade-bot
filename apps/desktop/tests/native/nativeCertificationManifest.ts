/**
 * Stage 3C-CI-RESET Part 2 Checkpoint C.1 — native certification manifest.
 *
 * Single authoritative source of what the native Electron integration
 * suite is required to certify. Every entry has:
 *
 *   - a STABLE ID (e.g. `T0`, `NAV:overview`, `CLEANUP:electron_close`);
 *   - a human-readable title (audit-visible);
 *   - one of the 12 certification categories the plan requires;
 *   - an optional screen key (only for the per-screen entries);
 *   - `required: true` — nothing in the manifest is optional. A run
 *     that fails to register + reach any entry cannot complete.
 *
 * The 19 screen keys are re-used from `NINETEEN_SCREEN_MANIFEST` in
 * deterministicSeed.ts — NOT re-declared here, so a screen added or
 * renamed there propagates automatically and cannot silently drift
 * out of certification. The Checkpoint B `verify:test-topology`
 * verifier also enforces the single-source rule at the test-file
 * level; this module extends the same discipline to the requirement
 * level.
 *
 * `computeManifestHash(manifest)` returns a deterministic SHA-256
 * over a canonical serialization of the requirement list. The hash
 * is written into every execution ledger + evidence bundle so a
 * consumer can prove the manifest they enforced against was the one
 * the harness ran.
 */

import { createHash } from 'node:crypto';
import { NINETEEN_SCREEN_MANIFEST } from './deterministicSeed';

// ---------------------------------------------------------------------------
// Categories + IDs
// ---------------------------------------------------------------------------

export const NATIVE_CERTIFICATION_CATEGORIES = [
  'startup',
  'screen_navigation',
  'screen_signature',
  'screen_manifest',
  'domain',
  'session',
  'degradation',
  'security',
  'lifecycle',
  'safety',
  'evidence',
  'cleanup',
] as const;
export type NativeCertificationCategory = typeof NATIVE_CERTIFICATION_CATEGORIES[number];

/** The 19 native-suite screen keys. Sourced from NINETEEN_SCREEN_MANIFEST. */
export type NativeScreenKey = typeof NINETEEN_SCREEN_MANIFEST[number]['screenKey'];

export const NATIVE_SCREEN_KEYS: readonly NativeScreenKey[] =
  NINETEEN_SCREEN_MANIFEST.map((s) => s.screenKey as NativeScreenKey);

// ---------------------------------------------------------------------------
// Requirement type
// ---------------------------------------------------------------------------

export interface NativeCertificationRequirement {
  readonly id: string;
  readonly title: string;
  readonly category: NativeCertificationCategory;
  readonly screenKey?: NativeScreenKey;
  readonly required: true;
}

// ---------------------------------------------------------------------------
// Manifest construction
// ---------------------------------------------------------------------------

const STARTUP_ENTRIES: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'T0', title: 'preconditions — external services + built desktop present' },
  { id: 'T1', title: 'real Electron process launches' },
  { id: 'T2', title: 'real Electron main entry loaded (dist/main/index.cjs)' },
  { id: 'T3', title: 'real preload initializes — window.horizon exposed' },
  { id: 'T4', title: 'real renderer loads — HashRouter is active' },
  { id: 'T5', title: 'HORIZON_ENVIRONMENT=development + HORIZON_DEVELOPMENT_FAKE=false' },
  { id: 'T6', title: 'no stub adapters — createServerAdapterExternal is a probe-only real adapter' },
  { id: 'T7', title: 'actual server child process running with a real pid' },
  { id: 'T8', title: 'actual MariaDB — SELECT 1 returns 1 against the scratch DB' },
  { id: 'T9', title: 'actual Redis — PING returns PONG' },
  { id: 'T10', title: 'unique scratch DB name (hzn_scratch_native_...)' },
  { id: 'T11', title: 'unique Redis namespace (native_<runId>)' },
  { id: 'T12', title: 'bootstrap channel — /api/system/readiness accepts the bootstrap token' },
  { id: 'T13', title: 'operator setup succeeded (ensureLocalOperator idempotent)' },
  { id: 'T14', title: 'authenticated state established during beforeAll is visible' },
  { id: 'T15', title: 'renderer state exposes SanitizedAuthState only' },
  { id: 'T16', title: 'Overview renders authoritative readiness signals' },
];

const DOMAIN_ENTRIES: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'T20', title: 'no screen renders a fabricated placeholder (source .v0-stub absent)' },
  { id: 'T21', title: 'Positions — empty seed renders empty banner, never fabricates positions' },
  { id: 'T22', title: 'Positions — dust surface is present and honestly labeled' },
  { id: 'T23', title: 'Protection — unknown protection labelled unknown' },
  { id: 'T24', title: 'Decision Journal — champion vs observer sections structurally present' },
  { id: 'T25', title: 'Decision Journal — evidence-time separation is a schema-level guarantee' },
  { id: 'T26', title: 'Research Universe — champion + observer as distinct arrays' },
  { id: 'T27', title: 'Fingerprints — LOW / UNCLASSIFIED qualifiers preserved when present' },
  { id: 'T28', title: 'Regimes — latent state + semantic regime rendered as distinct columns' },
  { id: 'T29', title: 'Portfolio Risk — multiplier never exceeds 1 (structurally clamped)' },
  { id: 'T30', title: 'Context — multiplier ≤ 1 preserved' },
  { id: 'T31', title: 'Portfolio Risk — Kelly disabled banner visible' },
  { id: 'T32', title: 'Validation Lab — Model promotion disabled banner visible' },
  { id: 'T33', title: 'Microstructure — queue not known + L2 provider inactive banners' },
  { id: 'T34', title: 'Costs — screen renders without exposing gross-without-net evidence' },
  { id: 'T35', title: 'Reports — generation NOT YET IMPLEMENTED banner visible' },
];

const SESSION_ENTRIES: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'T36', title: 'lock — business data cleared; unauthenticated phase entered' },
  { id: 'T37', title: 'session revoke — clears business data' },
  { id: 'T38', title: 're-login restores authenticated data' },
];

const DEGRADATION_ENTRIES: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'T39-41', title: 'at least one screen renders one of stale / degraded / unavailable' },
  { id: 'T42', title: 'SIGSTOP the server → next authenticated read renders api_failure' },
  { id: 'T43', title: 'contract_mismatch code path exists in shipped renderer bundle' },
];

const SECURITY_ENTRIES: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'T44', title: 'renderer sandbox — no process, no require, no fs' },
  { id: 'T45', title: 'renderer cannot invoke arbitrary IPC channels (unknown key rejected)' },
];

const LIFECYCLE_ENTRIES: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'T46', title: 'graceful close — window.close() dispatches; app remains alive' },
  { id: 'T47', title: 'server child process still healthy after mid-suite exercise' },
  { id: 'T48', title: 'relaunch prep — bootstrap token + operator remain valid across a fresh IPC round-trip' },
  { id: 'T49', title: 'reconciliation gate on restart — /api/reconciliation/status responds' },
];

const SAFETY_ENTRIES: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'T50-52', title: 'Create Order counters — functionInvocations / attemptCount / networkCount all zero' },
  { id: 'T53', title: 'safe flags unchanged (DRY_RUN=true, ORDER_SUBMISSION_ENABLED=false)' },
  { id: 'T54', title: 'no Coinbase credentials referenced in the harness process env' },
  { id: 'T55', title: 'no production providers activated (HORIZON_PROVIDER_MODE unset / fixture)' },
  // Stage 4F — every enqueue path preserves the safety invariants.
  { id: 'T60', title: 'Stage 4 report enqueue preserves DRY_RUN + ORDER_SUBMISSION_ENABLED + createOrder counters' },
];

// Stage 4F — report-lifecycle certification. Each ID exercises one
// concrete run through renderer → preload → main → tRPC → worker →
// artifact → verification, and asserts against the DOM data-*
// attributes the Stage 4E UI emits (never against visible text).
const REPORT_ENTRIES: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'T56', title: 'Reports screen renders all 13 REPORT_KINDS + Generate buttons (data-report-kind attrs present)' },
  { id: 'T57', title: 'safety_status JSON enqueue → materialised artifact exists on disk with matching size + checksum' },
  { id: 'T58', title: 'reports.verify recomputes SHA256 and confirms the artifact (data-verification-state=ok)' },
  { id: 'T59', title: 'targetFolder=`..`-escaping is rejected by dual (main + server) path validation' },
];

const EVIDENCE_ENTRIES: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'T-coverage', title: 'all 19 screens exercised at least once' },
  { id: 'T-manifest-completeness', title: 'every one of 19 screens has an executed manifest assertion' },
  { id: 'T-evidence', title: 'preliminary evidence bundle can be derived from ledger + runtime results' },
  { id: 'T-summary', title: 'ledger-derived counts + startup trace echoed for the report' },
];

/**
 * Mandatory cleanup ledger IDs. Each one is a discrete teardown step
 * whose success MUST be recorded by the harness before the run may
 * complete. Cleanup entries are the only category permitted to have
 * a `fail` transition without a preceding assertion body — teardown
 * failures are recorded post-hoc from the TeardownResult record.
 */
export const CLEANUP_REQUIREMENT_IDS = [
  'CLEANUP:electron_close',
  'CLEANUP:server_stop',
  'CLEANUP:redis_cleanup',
  'CLEANUP:database_drop',
  'CLEANUP:process_leak_check',
] as const;
export type CleanupRequirementId = typeof CLEANUP_REQUIREMENT_IDS[number];

const CLEANUP_ENTRIES: ReadonlyArray<{ id: CleanupRequirementId; title: string }> = [
  { id: 'CLEANUP:electron_close', title: 'Electron app.close() completed' },
  { id: 'CLEANUP:server_stop', title: 'Server child process stopped' },
  { id: 'CLEANUP:redis_cleanup', title: 'Redis namespace cleared' },
  { id: 'CLEANUP:database_drop', title: 'Scratch database dropped' },
  { id: 'CLEANUP:process_leak_check', title: 'No child processes survived teardown' },
];

function buildManifest(): readonly NativeCertificationRequirement[] {
  const out: NativeCertificationRequirement[] = [];
  for (const e of STARTUP_ENTRIES) out.push({ id: e.id, title: e.title, category: 'startup', required: true });
  // 19 NAV + 19 SIG + 19 MANIFEST — one triple per screen, ordered
  // per NINETEEN_SCREEN_MANIFEST so the manifest hash is stable
  // across insertion-order-preserving JS engines.
  for (const s of NINETEEN_SCREEN_MANIFEST) {
    const key = s.screenKey as NativeScreenKey;
    out.push({ id: `NAV:${key}`, title: `${key} navigates + leaves loading + shows LIVE ORDER SUBMISSION DISABLED`, category: 'screen_navigation', screenKey: key, required: true });
    out.push({ id: `SIG:${key}`, title: `${key} carries screen-specific signature`, category: 'screen_signature', screenKey: key, required: true });
    out.push({ id: `MANIFEST:${key}`, title: `${key} expected data-state=${s.expectedState}; ${s.expectedSignatures.length} signature(s)`, category: 'screen_manifest', screenKey: key, required: true });
  }
  for (const e of DOMAIN_ENTRIES) out.push({ id: e.id, title: e.title, category: 'domain', required: true });
  for (const e of SESSION_ENTRIES) out.push({ id: e.id, title: e.title, category: 'session', required: true });
  for (const e of DEGRADATION_ENTRIES) out.push({ id: e.id, title: e.title, category: 'degradation', required: true });
  for (const e of SECURITY_ENTRIES) out.push({ id: e.id, title: e.title, category: 'security', required: true });
  for (const e of LIFECYCLE_ENTRIES) out.push({ id: e.id, title: e.title, category: 'lifecycle', required: true });
  for (const e of SAFETY_ENTRIES) out.push({ id: e.id, title: e.title, category: 'safety', required: true });
  // Stage 4F — report lifecycle enters as its own subset under
  // `lifecycle` category so an auditor can compute the T56-T59 subset
  // via a single category filter.
  for (const e of REPORT_ENTRIES) out.push({ id: e.id, title: e.title, category: 'lifecycle', required: true });
  for (const e of EVIDENCE_ENTRIES) out.push({ id: e.id, title: e.title, category: 'evidence', required: true });
  for (const e of CLEANUP_ENTRIES) out.push({ id: e.id, title: e.title, category: 'cleanup', required: true });
  return Object.freeze(out);
}

export const NATIVE_CERTIFICATION_MANIFEST: readonly NativeCertificationRequirement[] = buildManifest();

// ---------------------------------------------------------------------------
// Hash + lookup
// ---------------------------------------------------------------------------

/**
 * Deterministic sha256 over a canonical projection of the manifest.
 * Only the fields that are semantically part of the certification
 * contract are hashed — {id, title, category, screenKey, required}.
 * Insertion order is preserved. Timestamps are NEVER hashed.
 */
export function computeManifestHash(manifest: readonly NativeCertificationRequirement[]): string {
  const canonical = manifest.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    screenKey: r.screenKey ?? null,
    required: r.required,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function requirementsByCategory(manifest: readonly NativeCertificationRequirement[]): Record<NativeCertificationCategory, number> {
  const out = {} as Record<NativeCertificationCategory, number>;
  for (const c of NATIVE_CERTIFICATION_CATEGORIES) out[c] = 0;
  for (const r of manifest) out[r.category]++;
  return out;
}

export function screenRequirementIds(screenKey: NativeScreenKey): { nav: string; sig: string; manifest: string } {
  return {
    nav: `NAV:${screenKey}`,
    sig: `SIG:${screenKey}`,
    manifest: `MANIFEST:${screenKey}`,
  };
}
