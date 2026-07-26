/**
 * Append-only audit trail for operator actions issued from the desktop.
 *
 * This module lives OUTSIDE `apps/server/src/desktop/queries/` on
 * purpose. The desktop query surface is contractually read-only (see
 * `stage3a-fix-readonly-boundaries.test.ts`). The single legitimate
 * operator-write path — recording an acknowledgement marker for an
 * incident — is isolated here so the query layer can be scanned for
 * mutations without whitelist exceptions.
 *
 * The insert is append-only. It does NOT modify the incident row itself
 * (an ack is a marker, not a resolution). Callers must have already
 * passed the operator middleware; the actor username is expected to
 * come from `ctx.auth`.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db';

export type RecordOperatorActionResult =
  | { ok: true }
  | { ok: false; reasonCode: string; detail?: string };

export async function recordIncidentAcknowledgementAudit(params: {
  actor: string | null;
  incidentId: string;
  operatorNote?: string | null;
}): Promise<RecordOperatorActionResult> {
  const actor = params.actor ?? 'operator';
  const note = params.operatorNote ?? null;
  try {
    await db.execute(sql`
      INSERT INTO desktop_operator_actions
        (actionKind, actor, subjectKind, subjectId, note, occurredAt)
      VALUES ('incident.acknowledge', ${actor}, 'incident', ${String(params.incidentId)}, ${note}, NOW(3))
    `);
    return { ok: true };
  } catch (err) {
    return { ok: false, reasonCode: 'ack_audit_insert_failed', detail: String(err).slice(0, 200) };
  }
}
