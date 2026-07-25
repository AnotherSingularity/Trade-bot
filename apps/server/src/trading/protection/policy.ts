import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  protectionCapabilities,
  protectionPolicyVersions,
  protectionValidationRuns,
  type ProtectionCapabilityRow,
  type ProtectionPolicyVersionRow,
  type ProtectionValidationRunRow,
} from '../../db/schema';

/**
 * Phase 1.1 Gate 3C — protection policy + capability helpers.
 *
 * All writes flow through this module so the immutability + validation-
 * evidence rules are enforced in code:
 *
 *   - protection_policy_versions: `activate*` transitions only. Rows are
 *     inserted `draft`; supersession creates a NEW version pointing back
 *     via `supersedesPolicyId`. There is no `update*` helper.
 *   - protection_capabilities: append-only. A change of `capabilityState`
 *     requires inserting a new capability row (bound to a new evidence
 *     run). The UNIQUE identity index prevents two rows per
 *     (policy, product, side, orderType, tif, protectionType).
 *   - protection_validation_runs: append-only.
 *
 * A capability row's `capabilityState` cannot exceed the strength that
 * its underlying validation type is capable of establishing:
 *
 *   documentation_review  → documented_unverified (max)
 *   preview_fixture       → preview_supported (max) OR preview_rejected
 *   shadow_fixture        → shadow_validated (max)
 *   sandbox               → sandbox_validated (max)
 *   live_canary           → live_canary_validated (max)
 *
 * `evaluateProtectionCapability` (see ./capabilityGate.ts) is the ONLY
 * consumer of `capabilityState`. Do not compare states inline elsewhere.
 */

export type CapabilityState = ProtectionCapabilityRow['capabilityState'];
export type ValidationType = ProtectionValidationRunRow['validationType'];
export type ProtectionType = ProtectionCapabilityRow['protectionType'];

/** The maximum capability state that a given validation type can produce. */
const VALIDATION_CAP: Record<ValidationType, CapabilityState> = {
  documentation_review: 'documented_unverified',
  preview_fixture: 'preview_supported',
  shadow_fixture: 'shadow_validated',
  sandbox: 'sandbox_validated',
  live_canary: 'live_canary_validated',
};

/** Total ordering used to compare states; higher is stronger. */
const STATE_RANK: Record<CapabilityState, number> = {
  unknown: 0,
  documented_unverified: 1,
  preview_rejected: 1,
  preview_supported: 2,
  shadow_validated: 3,
  sandbox_validated: 4,
  live_canary_validated: 5,
  unsupported: 0,
  temporarily_degraded: 0,
};

export function capabilityStateRank(s: CapabilityState): number {
  return STATE_RANK[s] ?? 0;
}

export interface CreatePolicyVersionInput {
  version: string;
  description?: string | null;
  supersedesPolicyId?: number | null;
}

export async function createPolicyVersion(
  input: CreatePolicyVersionInput,
): Promise<ProtectionPolicyVersionRow> {
  const [{ insertId }] = (await db.insert(protectionPolicyVersions).values({
    version: input.version,
    status: 'draft',
    description: input.description ?? null,
    supersedesPolicyId: input.supersedesPolicyId ?? null,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(protectionPolicyVersions)
    .where(eq(protectionPolicyVersions.id, insertId))
    .limit(1);
  return row!;
}

export async function activatePolicyVersion(policyVersionId: number): Promise<void> {
  await db
    .update(protectionPolicyVersions)
    .set({ status: 'active', activatedAt: new Date() })
    .where(eq(protectionPolicyVersions.id, policyVersionId));
}

export interface RecordValidationRunInput {
  policyVersionId: number;
  capabilityId?: number | null;
  productId: string;
  configurationHash: string;
  validationType: ValidationType;
  startedAt: Date;
  completedAt?: Date | null;
  result: ProtectionValidationRunRow['result'];
  previewRequest?: unknown;
  previewResponseSanitized?: unknown;
  failureCode?: string | null;
  failureReason?: string | null;
}

/** Insert a validation-run row. Sanitizes preview payloads to strings. */
export async function recordValidationRun(
  input: RecordValidationRunInput,
): Promise<ProtectionValidationRunRow> {
  const [{ insertId }] = (await db.insert(protectionValidationRuns).values({
    policyVersionId: input.policyVersionId,
    capabilityId: input.capabilityId ?? null,
    productId: input.productId,
    configurationHash: input.configurationHash,
    validationType: input.validationType,
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? null,
    result: input.result,
    previewRequest: sanitizeString(input.previewRequest),
    previewResponseSanitized: sanitizeString(input.previewResponseSanitized),
    failureCode: input.failureCode ?? null,
    failureReason: input.failureReason ?? null,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(protectionValidationRuns)
    .where(eq(protectionValidationRuns.id, insertId))
    .limit(1);
  return row!;
}

export interface CapabilityIdentity {
  policyVersionId: number;
  productId: string;
  side: 'BUY' | 'SELL';
  entryOrderType: string;
  timeInForce: string;
  protectionType: ProtectionType;
}

export interface RecordCapabilityInput extends CapabilityIdentity {
  requestedState: CapabilityState;
  source: string;
  validationRunId?: number | null;
  validationType: ValidationType;
  evidencePayload?: unknown;
  expiresAt?: Date | null;
  limitations?: string | null;
}

/**
 * Insert a capability row bound to a validation run. Enforces:
 *   - `requestedState` cannot exceed the cap allowed by `validationType`
 *   - `preview_rejected` requires validationType `preview_fixture`
 *   - evidenceHash is derived from the sanitized payload
 */
export async function recordCapability(
  input: RecordCapabilityInput,
): Promise<ProtectionCapabilityRow> {
  const cap = VALIDATION_CAP[input.validationType];
  if (input.requestedState === 'preview_rejected') {
    if (input.validationType !== 'preview_fixture') {
      throw new Error(
        `preview_rejected requires validationType=preview_fixture (got ${input.validationType})`,
      );
    }
  } else if (
    input.requestedState !== 'unsupported' &&
    input.requestedState !== 'temporarily_degraded' &&
    input.requestedState !== 'unknown'
  ) {
    if (STATE_RANK[input.requestedState] > STATE_RANK[cap]) {
      throw new Error(
        `${input.validationType} cannot establish state ${input.requestedState} (max ${cap})`,
      );
    }
  }
  const payload = sanitizeString(input.evidencePayload);
  const evidenceHash = payload
    ? createHash('sha256').update(payload).digest('hex')
    : null;
  const [{ insertId }] = (await db.insert(protectionCapabilities).values({
    policyVersionId: input.policyVersionId,
    productId: input.productId,
    side: input.side,
    entryOrderType: input.entryOrderType,
    timeInForce: input.timeInForce,
    protectionType: input.protectionType,
    capabilityState: input.requestedState,
    source: input.source,
    validatedAt: new Date(),
    expiresAt: input.expiresAt ?? null,
    evidenceHash,
    limitations: input.limitations ?? null,
  })) as unknown as { insertId: number }[];
  const [row] = await db
    .select()
    .from(protectionCapabilities)
    .where(eq(protectionCapabilities.id, insertId))
    .limit(1);
  return row!;
}

/** Fetch the most recent capability row for a given identity, or null. */
export async function currentCapability(
  identity: CapabilityIdentity,
): Promise<ProtectionCapabilityRow | null> {
  const rows = await db
    .select()
    .from(protectionCapabilities)
    .where(
      and(
        eq(protectionCapabilities.policyVersionId, identity.policyVersionId),
        eq(protectionCapabilities.productId, identity.productId),
        eq(protectionCapabilities.side, identity.side),
        eq(protectionCapabilities.entryOrderType, identity.entryOrderType),
        eq(protectionCapabilities.timeInForce, identity.timeInForce),
        eq(protectionCapabilities.protectionType, identity.protectionType),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Redact preview responses of any Coinbase auth headers or opaque tokens. */
function sanitizeString(value: unknown): string | null {
  if (value == null) return null;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return raw
    .replace(/"(cb-access-[^"]+)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/"(authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/"(passphrase|api_key|apiKey|secret)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"');
}
