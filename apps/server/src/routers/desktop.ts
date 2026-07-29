/**
 * Stage 3 §1 — canonical desktop.* tRPC namespace.
 *
 * Every procedure declares `authScope: 'operator_authenticated_business'`
 * via `operatorProcedure`, so:
 *   - Anonymous callers → UNAUTHORIZED.
 *   - Bootstrap tokens → cannot mint operator identity, so also rejected.
 *   - Legacy JWTs (mobile) → rejected (operatorProcedure requires kind === 'operator').
 * The Stage 2-FIX inventory audit continues to fail closed for any
 * unclassified procedure.
 */

import {
  DecisionDetailInputSchema,
  DecisionListInputSchema,
  ExportEnqueueInputSchema,
  ExportListInputSchema,
  ExportStatusInputSchema,
  ExportVerifyInputSchema,
  FingerprintListInputSchema,
  IncidentAcknowledgeInputSchema,
  IncidentListInputSchema,
  PaginationInputSchema,
  PositionDetailInputSchema,
  PositionListInputSchema,
  ReconciliationListInputSchema,
  UniverseListInputSchema,
  ValidationExperimentListInputSchema,
  type ExportEnqueueOutput,
  type ExportListItem,
  type ExportStatusOutput,
  type ExportVerifyOutput,
} from '@horizon/shared';
import { TRPCError } from '@trpc/server';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { desktopExportArtifacts, desktopExportJobs } from '../db/schema';
import { enqueueAndRunExport, verifyArtifact } from '../reports/worker';
import { operatorProcedure, router } from '../lib/trpc';
import { getOverview } from '../desktop/queries/overview';
import { getPortfolio } from '../desktop/queries/portfolio';
import { getPositionDetail, listPositions } from '../desktop/queries/positions';
import { getDecisionDetail, listDecisions } from '../desktop/queries/decisions';
import {
  acknowledgeIncident,
  getConfiguration,
  getContext,
  getCosts,
  getMicrostructure,
  getProtection,
  getRegimes,
  getReports,
  getRisk,
  getSafety,
  getSystem,
  getValidation,
  listFingerprints,
  listIncidents,
  listReconciliation,
  listUniverse,
} from '../desktop/queries/domains';

const EmptyInputSchema = z.object({}).strict();

export const desktopRouter = router({
  overview: router({
    get: operatorProcedure.input(EmptyInputSchema.optional()).query(() => getOverview()),
  }),
  portfolio: router({
    get: operatorProcedure.input(EmptyInputSchema.optional()).query(() => getPortfolio()),
  }),
  positions: router({
    list: operatorProcedure
      .input(PositionListInputSchema.optional())
      .query(({ input }) => listPositions(input)),
    get: operatorProcedure
      .input(PositionDetailInputSchema)
      .query(({ input }) => getPositionDetail(input)),
  }),
  decisions: router({
    list: operatorProcedure
      .input(DecisionListInputSchema.optional())
      .query(({ input }) => listDecisions(input)),
    get: operatorProcedure
      .input(DecisionDetailInputSchema)
      .query(({ input }) => getDecisionDetail(input)),
  }),
  universe: router({
    list: operatorProcedure
      .input(UniverseListInputSchema.optional())
      .query(({ input }) => listUniverse(input)),
  }),
  fingerprints: router({
    list: operatorProcedure
      .input(FingerprintListInputSchema.optional())
      .query(({ input }) => listFingerprints(input)),
  }),
  regimes: router({
    get: operatorProcedure.input(EmptyInputSchema.optional()).query(() => getRegimes()),
  }),
  risk: router({
    get: operatorProcedure.input(EmptyInputSchema.optional()).query(() => getRisk()),
  }),
  microstructure: router({
    get: operatorProcedure.input(EmptyInputSchema.optional()).query(() => getMicrostructure()),
  }),
  context: router({
    get: operatorProcedure.input(EmptyInputSchema.optional()).query(() => getContext()),
  }),
  validation: router({
    get: operatorProcedure
      .input(ValidationExperimentListInputSchema.optional())
      .query(({ input }) => getValidation(input)),
  }),
  costs: router({
    get: operatorProcedure.input(EmptyInputSchema.optional()).query(() => getCosts()),
  }),
  protection: router({
    get: operatorProcedure.input(EmptyInputSchema.optional()).query(() => getProtection()),
  }),
  reconciliation: router({
    list: operatorProcedure
      .input(ReconciliationListInputSchema.optional())
      .query(({ input }) => listReconciliation(input)),
  }),
  incidents: router({
    list: operatorProcedure
      .input(IncidentListInputSchema.optional())
      .query(({ input }) => listIncidents(input)),
    acknowledge: operatorProcedure
      .input(IncidentAcknowledgeInputSchema)
      .mutation(({ input, ctx }) => {
        // Actor username from the resolved operator identity — never
        // renderer-supplied.
        const actor = ctx.auth?.kind === 'operator' ? ctx.auth.account.usernameNormalized : null;
        return acknowledgeIncident(input, actor);
      }),
  }),
  reports: router({
    get: operatorProcedure.input(PaginationInputSchema.optional()).query(() => getReports()),
    /**
     * Stage 4D — synchronous enqueue. The worker runs the generator
     * + serialiser + write inside this call, so the response carries
     * the materialised artifact identity (contentDigest, checksum,
     * artifactPath) OR a typed failure. Two concurrent calls with
     * the same idempotency-key input collapse to `idempotent_hit`
     * via the DB UNIQUE constraint on desktopExportJobs.idempotencyKey
     * (Stage 4 correction: "must be enforced by a database
     * uniqueness constraint, not application-only check-then-insert
     * logic").
     */
    enqueue: operatorProcedure
      .input(ExportEnqueueInputSchema)
      .mutation(async ({ input, ctx }): Promise<ExportEnqueueOutput> => {
        if (ctx.auth?.kind !== 'operator') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Operator session required' });
        }
        const installationId = ctx.auth.session.installationId;
        if (typeof installationId !== 'number') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'installation_required' });
        }
        const actor = ctx.auth.account.usernameNormalized;
        return enqueueAndRunExport(db, {
          installationId,
          reportKind: input.reportKind,
          format: input.format,
          targetFolder: input.targetFolder,
          referenceId: input.referenceId ?? null,
          requestedBy: actor,
          requestOptions: input.requestOptions ?? {},
        });
      }),
    /**
     * Fetch a single job's terminal state + artifact metadata.
     */
    status: operatorProcedure
      .input(ExportStatusInputSchema)
      .query(async ({ input, ctx }): Promise<ExportStatusOutput> => {
        if (ctx.auth?.kind !== 'operator') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Operator session required' });
        }
        const installationId = ctx.auth.session.installationId;
        if (typeof installationId !== 'number') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'installation_required' });
        }
        const rows = await db.select().from(desktopExportJobs)
          .where(and(eq(desktopExportJobs.id, input.jobId), eq(desktopExportJobs.installationId, installationId)))
          .limit(1);
        const job = rows[0];
        if (!job) throw new TRPCError({ code: 'NOT_FOUND', message: 'job_not_found' });
        const artRows = await db.select().from(desktopExportArtifacts)
          .where(eq(desktopExportArtifacts.exportJobId, input.jobId)).limit(1);
        const art = artRows[0];
        return {
          jobId: Number(job.id),
          reportKind: job.reportKind,
          format: job.format,
          status: job.status,
          requestedAt: (job.requestedAt instanceof Date ? job.requestedAt.toISOString() : String(job.requestedAt)),
          completedAt: job.completedAt ? (job.completedAt instanceof Date ? job.completedAt.toISOString() : String(job.completedAt)) : null,
          failureReason: job.failureReason ?? null,
          reportSpecVersion: job.reportSpecVersion ?? null,
          idempotencyKey: job.idempotencyKey ?? null,
          artifact: art ? {
            artifactPath: art.artifactPath,
            checksumSha256: art.checksumSha256,
            contentDigest: art.contentDigest ?? null,
            sizeBytes: Number(art.sizeBytes),
            reportVersion: art.reportVersion,
            generatedAt: (art.generatedAt instanceof Date ? art.generatedAt.toISOString() : String(art.generatedAt)),
          } : null,
        };
      }),
    /**
     * Paginated recent-jobs listing for the installation. Cursor-less
     * — Stage 4 keeps this bounded (limit ≤ 200) and DESC by id.
     */
    list: operatorProcedure
      .input(ExportListInputSchema.optional())
      .query(async ({ input, ctx }): Promise<{ items: ExportListItem[] }> => {
        if (ctx.auth?.kind !== 'operator') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Operator session required' });
        }
        const installationId = ctx.auth.session.installationId;
        if (typeof installationId !== 'number') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'installation_required' });
        }
        const limit = input?.limit ?? 50;
        const rows = input?.reportKind
          ? await db.select().from(desktopExportJobs)
              .where(and(
                eq(desktopExportJobs.installationId, installationId),
                eq(desktopExportJobs.reportKind, input.reportKind),
              ))
              .orderBy(desc(desktopExportJobs.id)).limit(limit)
          : await db.select().from(desktopExportJobs)
              .where(eq(desktopExportJobs.installationId, installationId))
              .orderBy(desc(desktopExportJobs.id)).limit(limit);
        // Fetch artifact rows in a single follow-up. Small N (≤200).
        const ids = rows.map((r) => Number(r.id));
        const artRows = ids.length === 0 ? [] : await db.select().from(desktopExportArtifacts)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .where((desktopExportArtifacts.exportJobId as any).in(ids));
        const artByJob = new Map<number, typeof artRows[number]>();
        for (const a of artRows) artByJob.set(Number(a.exportJobId), a);
        const items: ExportListItem[] = rows.map((r) => {
          const a = artByJob.get(Number(r.id));
          return {
            jobId: Number(r.id),
            reportKind: r.reportKind,
            format: r.format,
            status: r.status,
            requestedAt: (r.requestedAt instanceof Date ? r.requestedAt.toISOString() : String(r.requestedAt)),
            completedAt: r.completedAt ? (r.completedAt instanceof Date ? r.completedAt.toISOString() : String(r.completedAt)) : null,
            contentDigest: a?.contentDigest ?? null,
            checksumSha256: a?.checksumSha256 ?? null,
          };
        });
        return { items };
      }),
    /**
     * Re-hash the file bytes vs desktop_export_artifacts.checksumSha256.
     * Returns a typed shape so a caller distinguishes "file gone" from
     * "checksum drift" from "row missing".
     */
    verify: operatorProcedure
      .input(ExportVerifyInputSchema)
      .query(async ({ input, ctx }): Promise<ExportVerifyOutput> => {
        if (ctx.auth?.kind !== 'operator') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Operator session required' });
        }
        const installationId = ctx.auth.session.installationId;
        if (typeof installationId !== 'number') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'installation_required' });
        }
        const rows = await db.select().from(desktopExportJobs)
          .where(and(eq(desktopExportJobs.id, input.jobId), eq(desktopExportJobs.installationId, installationId)))
          .limit(1);
        if (!rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'job_not_found' });
        const outcome = await verifyArtifact(db, input.jobId);
        if (outcome.ok) {
          return {
            ok: true, reason: null, detail: null,
            checksumSha256: outcome.checksumSha256, contentDigest: outcome.contentDigest,
            sizeBytes: outcome.sizeBytes, artifactPath: outcome.artifactPath,
          };
        }
        return {
          ok: false, reason: outcome.reason, detail: outcome.detail ?? null,
          checksumSha256: null, contentDigest: null, sizeBytes: null, artifactPath: null,
        };
      }),
  }),
  configuration: router({
    get: operatorProcedure.input(EmptyInputSchema.optional()).query(() => getConfiguration()),
  }),
  system: router({
    get: operatorProcedure.input(EmptyInputSchema.optional()).query(() => getSystem()),
  }),
  safety: router({
    get: operatorProcedure.input(EmptyInputSchema.optional()).query(() => getSafety()),
  }),
});

export type DesktopRouter = typeof desktopRouter;
