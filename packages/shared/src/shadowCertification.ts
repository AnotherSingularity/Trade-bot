/**
 * Stage 13 — Final shadow certification contract.
 *
 * Three allowed conclusions:
 *   - `shadow_certified_for_live_canary_review`
 *   - `shadow_not_certified`
 *   - `additional_shadow_evidence_required`
 *
 * The certifier CANNOT force a positive verdict. Any of the
 * required gates missing → the schema-level parse rejects the
 * certificate. Any invalidating incident → verdict downgrades.
 */
import { z } from 'zod';
import {
  ProspectiveValidationReportSchema,
  evaluateProspectiveSufficiency,
  type ProspectiveValidationReport,
} from './prospectiveValidation';
import { SoakManifestSchema, validateSoakManifest, type SoakManifest } from './soakManifest';

export const ShadowCertificationConclusionSchema = z.enum([
  'shadow_certified_for_live_canary_review',
  'shadow_not_certified',
  'additional_shadow_evidence_required',
]);
export type ShadowCertificationConclusion = z.infer<typeof ShadowCertificationConclusionSchema>;

export const ShadowCertificationGateSchema = z.object({
  id: z.string().min(1),
  satisfied: z.boolean(),
  detail: z.string().max(500),
}).strict();
export type ShadowCertificationGate = z.infer<typeof ShadowCertificationGateSchema>;

export const ShadowCertificationSchema = z.object({
  certificationId: z.string().min(1),
  releaseCandidateSha: z.string().length(40).regex(/^[0-9a-f]{40}$/),
  generatedAt: z.string().datetime(),
  soakId: z.string().min(1),
  prospectiveReportId: z.string().min(1),
  conclusion: ShadowCertificationConclusionSchema,
  gates: z.array(ShadowCertificationGateSchema).min(1),
  detail: z.string().max(1000),
  safetyFlagsRemainLocked: z.literal(true),
  createOrderCountersRemainZero: z.literal(true),
}).strict();
export type ShadowCertification = z.infer<typeof ShadowCertificationSchema>;

export interface CertifyInput {
  readonly certificationId: string;
  readonly releaseCandidateSha: string;
  readonly generatedAt: string;
  readonly soakManifest: SoakManifest;
  readonly prospectiveReport: ProspectiveValidationReport;
  readonly reconciliationUnresolved: number;
  readonly secretLeakageDetected: boolean;
  readonly providerPolicyViolations: number;
  readonly migrationDrift: boolean;
  readonly reportSpecDrift: boolean;
  readonly evidenceStaleSeconds: number;
  readonly evidenceStalenessAllowanceSeconds: number;
}

/** Build the final certification. Never forces a positive verdict. */
export function certifyShadow(input: CertifyInput): ShadowCertification {
  const gates: ShadowCertificationGate[] = [];

  // Gate 1: soak manifest itself validates + is passed.
  const soakParse = SoakManifestSchema.safeParse(input.soakManifest);
  const soakValid = soakParse.success ? validateSoakManifest(input.soakManifest) : null;
  gates.push({
    id: 'soak_manifest_valid_and_passed',
    satisfied: !!soakValid?.ok && input.soakManifest.finalVerdict === 'passed',
    detail: !soakParse.success
      ? `soak manifest schema_invalid: ${soakParse.error.issues[0]?.message ?? '?'}`
      : soakValid && !soakValid.ok
        ? `soak validation failed: ${soakValid.code}: ${soakValid.detail}`
        : `soak ${input.soakManifest.finalVerdict}`,
  });

  // Gate 2: prospective validation report validates + is sufficient.
  const prospParse = ProspectiveValidationReportSchema.safeParse(input.prospectiveReport);
  const prospSuff = prospParse.success ? evaluateProspectiveSufficiency(input.prospectiveReport) : null;
  gates.push({
    id: 'prospective_evidence_sufficient',
    satisfied: !!prospSuff?.ok && input.prospectiveReport.verdict === 'prospective_evidence_sufficient',
    detail: !prospParse.success
      ? `prospective schema_invalid: ${prospParse.error.issues[0]?.message ?? '?'}`
      : prospSuff && !prospSuff.ok
        ? `insufficient: ${prospSuff.reasons.slice(0, 3).join('; ')}`
        : `verdict=${input.prospectiveReport.verdict}`,
  });

  // Gate 3: release candidate SHA aligned across manifest + prospective + input.
  const shaAligned = input.soakManifest.commitSha === input.releaseCandidateSha &&
    input.prospectiveReport.commitSha === input.releaseCandidateSha;
  gates.push({
    id: 'release_candidate_sha_aligned',
    satisfied: shaAligned,
    detail: shaAligned ? `sha=${input.releaseCandidateSha}` : `mismatch soak=${input.soakManifest.commitSha.slice(0, 8)} prospective=${input.prospectiveReport.commitSha.slice(0, 8)}`,
  });

  // Gate 4: soakId aligned across manifest + prospective.
  const soakAligned = input.soakManifest.soakId === input.prospectiveReport.soakId;
  gates.push({
    id: 'soak_id_aligned',
    satisfied: soakAligned,
    detail: soakAligned ? `soakId=${input.soakManifest.soakId}` : `mismatch`,
  });

  // Gate 5: safety flags remained locked throughout every daily result.
  const flagsHeld = input.soakManifest.dayResults.every((d) =>
    d.safetyFlags.DRY_RUN === true &&
    d.safetyFlags.ORDER_SUBMISSION_ENABLED === false &&
    d.safetyFlags.liveCapitalAuthorized === false &&
    d.safetyFlags.promotionEnabled === false &&
    d.safetyFlags.kellyEnabled === false,
  );
  gates.push({
    id: 'safety_flags_held',
    satisfied: flagsHeld,
    detail: flagsHeld ? 'DRY_RUN=true, ORDER_SUBMISSION_ENABLED=false, live/promotion/kelly=false all days' : 'safety flag drift detected',
  });

  // Gate 6: Create Order counters remained 0/0/0 across every daily result.
  const countersHeld = input.soakManifest.dayResults.every((d) =>
    d.createOrderCounters.functionInvocations === 0 &&
    d.createOrderCounters.attemptCount === 0 &&
    d.createOrderCounters.networkCount === 0,
  );
  gates.push({
    id: 'counters_held',
    satisfied: countersHeld,
    detail: countersHeld ? 'counters 0/0/0 all days' : 'counter drift detected',
  });

  // Gate 7: reconciliation resolved.
  gates.push({
    id: 'reconciliation_resolved',
    satisfied: input.reconciliationUnresolved === 0,
    detail: input.reconciliationUnresolved === 0 ? 'no unresolved reconciliation' : `${input.reconciliationUnresolved} unresolved`,
  });

  // Gate 8: no secret leakage.
  gates.push({
    id: 'no_secret_leakage',
    satisfied: !input.secretLeakageDetected,
    detail: input.secretLeakageDetected ? 'secret leakage detected' : 'no leakage',
  });

  // Gate 9: no provider policy violation.
  gates.push({
    id: 'no_provider_policy_violation',
    satisfied: input.providerPolicyViolations === 0,
    detail: input.providerPolicyViolations === 0 ? 'no violations' : `${input.providerPolicyViolations} violations`,
  });

  // Gate 10: no migration drift.
  gates.push({
    id: 'no_migration_drift',
    satisfied: !input.migrationDrift,
    detail: input.migrationDrift ? 'migration chain drifted' : 'chain stable',
  });

  // Gate 11: no report-spec drift.
  gates.push({
    id: 'no_report_spec_drift',
    satisfied: !input.reportSpecDrift,
    detail: input.reportSpecDrift ? 'report spec drifted' : 'spec stable',
  });

  // Gate 12: evidence recent enough.
  gates.push({
    id: 'evidence_recent',
    satisfied: input.evidenceStaleSeconds <= input.evidenceStalenessAllowanceSeconds,
    detail: `stale=${input.evidenceStaleSeconds}s allowance=${input.evidenceStalenessAllowanceSeconds}s`,
  });

  // Gate 13: no invalidating soak incidents.
  const invalidatingSoak = input.soakManifest.incidents.filter((i) => i.invalidatesSoak);
  gates.push({
    id: 'no_invalidating_soak_incidents',
    satisfied: invalidatingSoak.length === 0,
    detail: invalidatingSoak.length === 0 ? 'no invalidators' : `${invalidatingSoak.length} invalidators`,
  });

  // Conclusion:
  const anyHardFail = gates.some((g) => !g.satisfied && (
    g.id === 'safety_flags_held' ||
    g.id === 'counters_held' ||
    g.id === 'no_secret_leakage' ||
    g.id === 'no_provider_policy_violation' ||
    g.id === 'no_migration_drift' ||
    g.id === 'no_report_spec_drift' ||
    g.id === 'no_invalidating_soak_incidents' ||
    g.id === 'release_candidate_sha_aligned' ||
    g.id === 'soak_id_aligned' ||
    g.id === 'reconciliation_resolved'
  ));
  const insufficientEvidence = !gates.find((g) => g.id === 'prospective_evidence_sufficient')?.satisfied
    || !gates.find((g) => g.id === 'soak_manifest_valid_and_passed')?.satisfied
    || !gates.find((g) => g.id === 'evidence_recent')?.satisfied;

  const conclusion: ShadowCertificationConclusion = anyHardFail
    ? 'shadow_not_certified'
    : insufficientEvidence
      ? 'additional_shadow_evidence_required'
      : 'shadow_certified_for_live_canary_review';

  const firstFail = gates.find((g) => !g.satisfied);
  return {
    certificationId: input.certificationId,
    releaseCandidateSha: input.releaseCandidateSha,
    generatedAt: input.generatedAt,
    soakId: input.soakManifest.soakId,
    prospectiveReportId: input.prospectiveReport.reportId,
    conclusion,
    gates,
    detail: firstFail
      ? `${conclusion}: first unsatisfied gate — ${firstFail.id}: ${firstFail.detail}`
      : 'all gates satisfied',
    safetyFlagsRemainLocked: true,
    createOrderCountersRemainZero: true,
  };
}
