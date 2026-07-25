import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import {
  reconciliationActions,
  reconciliationRuns,
  type ReconciliationRunRow,
} from '../db/schema';
import type { PaginationResultKind } from './pagination';

/**
 * Reconciliation observability (Phase 1.1.b §I).
 *
 * Two levels of record:
 *   • `reconciliation_runs` — one row per reconciler pass. Records trigger,
 *     leader, fenceGen, totals, and final status.
 *   • `reconciliation_actions` — one row per per-intent decision. Records
 *     the state transition, the fills before/after, the pagination
 *     verdict, and any machine-readable failure code.
 *
 * IMPORTANT — REDACTION RULES:
 *   Callers pass a `detail` free-text string. The reconciler MUST NOT put
 *   JWTs, API secrets, or raw signed request payloads into these fields.
 *   `redactForJournal(s)` is a defence-in-depth filter — it strips anything
 *   that looks like a JWT (base64 blob starting with eyJ) and any
 *   'Authorization:' header. Callers are expected to do their own redaction
 *   at the semantic layer; this catches accidents.
 */

export interface StartRunInput {
  triggerReason: string;
  ownerId: string;
  fenceGeneration: number | null;
}

export interface FinalizeRunInput {
  runId: string;
  intentsExamined: number;
  intentsResolved: number;
  intentsStillUnknown: number;
  fillsDiscovered: number;
  economicRecordsApplied: number;
  discrepancyCount: number;
  finalStatus: ReconciliationRunRow['finalStatus'];
  failureReasonCode?: string;
  detail?: string;
}

export interface RecordActionInput {
  runId: string;
  intentId?: number;
  clientOrderId?: string;
  action: string; // free-form kebab-case
  previousState?: string;
  newState?: string;
  fillsBefore?: number;
  fillsAfter?: number;
  paginationResult?: PaginationResultKind;
  failureReasonCode?: string;
  detail?: string;
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const AUTH_HEADER_RE = /Authorization:\s*Bearer\s+[^\s]+/gi;

/** Defence-in-depth redaction — never trust callers to filter sensitive strings. */
export function redactForJournal(s: string | undefined | null): string | null {
  if (s == null) return null;
  return s.replace(JWT_RE, '[jwt:redacted]').replace(AUTH_HEADER_RE, 'Authorization: [redacted]');
}

/** Start a new reconciliation run. Returns the runId. */
export async function startReconciliationRun(input: StartRunInput): Promise<string> {
  const runId = `rec-${randomUUID()}`;
  await db.insert(reconciliationRuns).values({
    runId,
    triggerReason: input.triggerReason,
    ownerId: input.ownerId,
    fenceGeneration: input.fenceGeneration,
    finalStatus: 'running',
  });
  return runId;
}

/** Update the run row with totals + final status. */
export async function finalizeReconciliationRun(input: FinalizeRunInput): Promise<void> {
  await db
    .update(reconciliationRuns)
    .set({
      completedAt: new Date(),
      intentsExamined: input.intentsExamined,
      intentsResolved: input.intentsResolved,
      intentsStillUnknown: input.intentsStillUnknown,
      fillsDiscovered: input.fillsDiscovered,
      economicRecordsApplied: input.economicRecordsApplied,
      discrepancyCount: input.discrepancyCount,
      finalStatus: input.finalStatus,
      failureReasonCode: input.failureReasonCode,
      detail: redactForJournal(input.detail),
    })
    .where(eq(reconciliationRuns.runId, input.runId));
}

/** Record one per-intent action within a run. */
export async function recordReconciliationAction(input: RecordActionInput): Promise<void> {
  await db.insert(reconciliationActions).values({
    runId: input.runId,
    intentId: input.intentId ?? null,
    clientOrderId: input.clientOrderId ?? null,
    action: input.action,
    previousState: input.previousState ?? null,
    newState: input.newState ?? null,
    fillsBefore: input.fillsBefore ?? null,
    fillsAfter: input.fillsAfter ?? null,
    paginationResult: input.paginationResult ?? null,
    failureReasonCode: input.failureReasonCode ?? null,
    detail: redactForJournal(input.detail),
  });
}

/** Diagnostic reader — most-recent runs first. */
export async function getRecentReconciliationRuns(limit = 20): Promise<ReconciliationRunRow[]> {
  return db
    .select()
    .from(reconciliationRuns)
    .orderBy(sqlDesc())
    .limit(limit);
}

/** Local helper — drizzle export shim without dragging desc into the caller. */
function sqlDesc() {
  // Import at call time to avoid a circular top-level import.
  const { desc } = require('drizzle-orm');
  return desc(reconciliationRuns.startedAt);
}
