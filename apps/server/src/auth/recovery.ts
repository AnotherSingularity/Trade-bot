/**
 * Stage 2 §19 — Recovery policy.
 *
 * There is no self-service reset over HTTP. Recovery is a CLI operation
 * performed by the local operator, invoked with direct database access
 * and recorded in `operator_recovery_records`. The account status
 * transitions to `recovery_required` when recovery is requested, and
 * back to `active` once the new password is set.
 *
 * No universal backdoor exists — every recovery is scoped to a single
 * accountId and requires a fresh password meeting the same policy as
 * setup and change-password.
 */

import { db } from '../db';
import { operatorRecoveryRecords } from '../db/schema';
import * as accounts from './accounts';
import { revokeAllForAccount } from './sessions';

export type RecoveryMethod = 'cli_password_reset' | 'cli_lockout_clear';

export interface RequestRecoveryInput {
  accountId: number;
  method: RecoveryMethod;
  operatorNote?: string;
}

export async function requestRecovery(input: RequestRecoveryInput): Promise<number> {
  const account = await accounts.findById(input.accountId);
  if (!account) throw new Error(`recovery requested for unknown accountId=${input.accountId}`);
  await accounts.setStatus(input.accountId, 'recovery_required');
  const [{ insertId }] = (await db.insert(operatorRecoveryRecords).values({
    accountId: input.accountId,
    method: input.method,
    operatorNote: input.operatorNote?.slice(0, 500) ?? null,
  })) as unknown as { insertId: number }[];
  return Number(insertId);
}

export interface PerformRecoveryInput {
  recoveryId: number;
  accountId: number;
  newPassword: string;
}

export type PerformRecoveryResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'password_policy_violation'; detail?: string };

export async function performRecovery(input: PerformRecoveryInput): Promise<PerformRecoveryResult> {
  const reset = await accounts.forcePasswordReset(input.accountId, input.newPassword);
  if (!reset.ok) return reset;
  await revokeAllForAccount(input.accountId, 'recovery_performed');
  const now = new Date();
  await db.execute(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await import('drizzle-orm')).sql`
      UPDATE operator_recovery_records SET performedAt = ${now}
      WHERE id = ${input.recoveryId} AND accountId = ${input.accountId}
    `,
  );
  return { ok: true };
}
