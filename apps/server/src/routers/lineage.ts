import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  cashLedger,
  executionCostForecasts,
  fills,
  orderIntents,
  positions,
  quantitativeDecisions,
  reconciliationActions,
  roundTrips,
  signalCandidates,
} from '../db/schema';
import { getDecisionChainAggregate } from '../db/lineage';
import { protectedProcedure, router } from '../lib/trpc';

/**
 * Phase 1.1 Gate 2 §K — the authenticated audit route.
 *
 * Given a `decisionChainId`, returns the entire causal chain in one payload:
 * scan run, chain, observation, eligibility, setup, routing, candidate,
 * forecast, quantitative decision, order intents, fills, position, ledger
 * events, reconciliation actions, round trip, outcome labels, and lineage
 * events. Also reports a `completeness` verdict.
 *
 * This is an audit/debug endpoint — NOT a customer-facing screen — hence
 * `protectedProcedure` (JWT-authenticated) but no rate limiting beyond
 * the middleware defaults.
 */

export const lineageRouter = router({
  getDecisionChain: protectedProcedure
    .input(z.object({ decisionChainId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const base = await getDecisionChainAggregate(input.decisionChainId);
      if (!base) {
        return { found: false as const, decisionChainId: input.decisionChainId };
      }

      // Related transactional rows.
      const [
        candidateRows,
        forecastRows,
        decisionRows,
        intentRows,
        posRows,
        rtRows,
      ] = await Promise.all([
        db
          .select()
          .from(signalCandidates)
          .where(eq(signalCandidates.decisionChainId, input.decisionChainId)),
        db
          .select()
          .from(executionCostForecasts)
          .where(eq(executionCostForecasts.decisionChainId, input.decisionChainId)),
        db
          .select()
          .from(quantitativeDecisions)
          .where(eq(quantitativeDecisions.decisionChainId, input.decisionChainId)),
        db
          .select()
          .from(orderIntents)
          .where(eq(orderIntents.decisionChainId, input.decisionChainId)),
        db
          .select()
          .from(positions)
          .where(eq(positions.entryDecisionChainId, input.decisionChainId)),
        db
          .select()
          .from(roundTrips)
          .where(
            and(
              // A round trip may be tied to either the entry or the final-exit
              // chain — either yields the same row when we're looking at the
              // entry chain.
              eq(roundTrips.entryDecisionChainId, input.decisionChainId),
            ),
          ),
      ]);

      // Fills via orderIntents.
      const intentIds = intentRows.map((r) => r.id);
      const fillRows = intentIds.length
        ? await db
            .select()
            .from(fills)
            .where(
              intentIds.length === 1
                ? eq(fills.orderIntentId, intentIds[0])
                : or(...intentIds.map((id) => eq(fills.orderIntentId, id))),
            )
        : [];

      // Ledger events tied directly to this chain OR indirectly via intents.
      const ledgerRows = await db
        .select()
        .from(cashLedger)
        .where(eq(cashLedger.decisionChainId, input.decisionChainId));

      // Reconciliation actions tied to this chain.
      const reconRows = await db
        .select()
        .from(reconciliationActions)
        .where(eq(reconciliationActions.decisionChainId, input.decisionChainId));

      // Completeness verdict — see PHASE1_gate2.md.
      const completeness = computeCompleteness(base);

      return {
        found: true as const,
        decisionChainId: input.decisionChainId,
        completeness,
        scanRun: base.scan,
        chain: base.chain,
        observation: base.observation,
        eligibility: base.eligibility,
        setupEvaluation: base.setup,
        routingDecision: base.routing,
        signalCandidate: candidateRows[0] ?? null,
        costForecast: forecastRows[0] ?? null,
        quantitativeDecision: decisionRows[0] ?? null,
        orderIntents: intentRows,
        fills: fillRows,
        position: posRows[0] ?? null,
        cashLedger: ledgerRows,
        reconciliationActions: reconRows,
        roundTrip: rtRows[0] ?? null,
        outcomeLabels: base.outcomes,
        lineageEvents: base.events,
      };
    }),
});

// Lightweight OR helper (drizzle-orm's `or` needs at least one arg).
function or(...conds: unknown[]) {
  // Re-export inline to avoid an import cycle with the schema.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { or: drizzleOr } = require('drizzle-orm');
  return drizzleOr(...conds);
}

function computeCompleteness(base: NonNullable<Awaited<ReturnType<typeof getDecisionChainAggregate>>>) {
  const chain = base.chain;
  const missing: string[] = [];
  if (!base.scan) missing.push('scan_run');
  // A chain that never had an observation attached (data failure at token load)
  // is INTENTIONALLY partial — we record that state on the chain.
  if (!base.observation && chain.currentStatus !== 'failed') missing.push('market_observation');
  if (!base.eligibility) missing.push('eligibility_decision');
  return {
    completeness: chain.lineageCompleteness,
    missing,
    legacyStatus: chain.legacyStatus,
  };
}
