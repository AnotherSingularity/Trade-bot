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
  FingerprintListInputSchema,
  IncidentAcknowledgeInputSchema,
  IncidentListInputSchema,
  PaginationInputSchema,
  PositionDetailInputSchema,
  PositionListInputSchema,
  ReconciliationListInputSchema,
  UniverseListInputSchema,
  ValidationExperimentListInputSchema,
} from '@horizon/shared';
import { z } from 'zod';
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
} from '../desktop/queries/stubs';

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
      .mutation(({ input }) => acknowledgeIncident(input)),
  }),
  reports: router({
    get: operatorProcedure.input(PaginationInputSchema.optional()).query(() => getReports()),
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
