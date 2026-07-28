/**
 * Stage 3C-CI-RESET Part 2 Checkpoint D.1 §D.14/§D.16 — server-side
 * native diagnostics. Test-only. Mounted ONLY when
 * decideNativeInductionPolicy allows.
 *
 * Endpoints (all under /api/native-diagnostics, all require
 * bootstrap-token authorization):
 *
 *   GET /env-summary
 *     Returns a boolean map of allowlisted credential-variable
 *     names for the SERVER CHILD process. Values are booleans
 *     ONLY — no prefix, no hash, no length.
 *
 *   GET /provider-status
 *     Returns authority-tagged provider mode: market data +
 *     exchange + order-submission capability + production L2 +
 *     Coinbase production activation.
 *
 * Neither endpoint mutates any state. Both emit only sanitized
 * booleans/enums; no environment values leak.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { decideNativeInductionPolicy } from '@horizon/shared';
import { ENV } from '../env';
import { requireBootstrapAuthorization } from '../middleware/bootstrapAuth';

// ---------------------------------------------------------------------------
// Env-summary — Coinbase credential presence only, booleans only.
// ---------------------------------------------------------------------------

/** The allowlist. Adding a variable name here is a deliberate audit event. */
export const CREDENTIAL_VAR_ALLOWLIST = [
  'COINBASE_API_KEY',
  'COINBASE_API_SECRET',
  'COINBASE_API_PASSPHRASE',
  'COINBASE_PRIVATE_KEY',
  'COINBASE_ADVANCED_TRADE_KEY',
  'COINBASE_ADVANCED_TRADE_SECRET',
] as const;

export const EnvSummaryResponseSchema = z.object({
  contract: z.literal('stage3c-native-env-summary.v1'),
  processRole: z.literal('server_child'),
  pid: z.number().int().positive(),
  credentials: z.record(z.string(), z.boolean()),
}).strict();
export type EnvSummaryResponse = z.infer<typeof EnvSummaryResponseSchema>;

function buildServerEnvSummary(): EnvSummaryResponse {
  const credentials: Record<string, boolean> = {};
  for (const name of CREDENTIAL_VAR_ALLOWLIST) {
    // Presence only — never the value, prefix, hash, or length.
    credentials[name] = process.env[name] != null && process.env[name] !== '';
  }
  return {
    contract: 'stage3c-native-env-summary.v1',
    processRole: 'server_child',
    pid: process.pid,
    credentials,
  };
}

// ---------------------------------------------------------------------------
// Provider-status — authoritative source of provider selection.
// ---------------------------------------------------------------------------

export const ProviderStatusResponseSchema = z.object({
  contract: z.literal('stage3c-native-provider-status.v1'),
  authoritySource: z.string(),
  marketDataProvider: z.enum(['fixture', 'test', 'inactive', 'production']),
  exchangeProvider: z.enum(['disabled', 'fixture', 'inactive', 'production']),
  orderSubmissionCapable: z.boolean(),
  productionLevel2Active: z.boolean(),
  coinbaseProductionActive: z.boolean(),
}).strict();
export type ProviderStatusResponse = z.infer<typeof ProviderStatusResponseSchema>;

function buildProviderStatus(): ProviderStatusResponse {
  const providerMode = process.env.HORIZON_PROVIDER_MODE ?? 'fixture';
  const marketData: 'fixture' | 'test' | 'inactive' | 'production' =
    providerMode === 'external' ? 'production'
    : providerMode === 'test' ? 'test'
    : providerMode === 'inactive' ? 'inactive'
    : 'fixture';
  // The exchange provider is driven by ORDER_SUBMISSION_ENABLED + DRY_RUN.
  const dry = ENV.dryRun;
  const orderCapable = ENV.orderSubmissionEnabled && !dry;
  const exchange: 'disabled' | 'fixture' | 'inactive' | 'production' =
    !ENV.orderSubmissionEnabled ? 'disabled'
    : dry ? 'fixture'
    : orderCapable ? 'production'
    : 'inactive';
  return {
    contract: 'stage3c-native-provider-status.v1',
    // Every field is sourced from process ENV + config authority.
    // The `authoritySource` string tags the read site so the native
    // test can confirm the response came from a real runtime, not a
    // test literal.
    authoritySource: `server:env+ENV(pid=${process.pid})`,
    marketDataProvider: marketData,
    exchangeProvider: exchange,
    orderSubmissionCapable: orderCapable,
    productionLevel2Active: providerMode === 'external' && marketData === 'production',
    coinbaseProductionActive: providerMode === 'external',
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function policyGate(_req: Request, res: Response): boolean {
  const decision = decideNativeInductionPolicy({
    nodeEnv: process.env.NODE_ENV,
    nativeDiagnostics: process.env.HORIZON_NATIVE_DIAGNOSTICS,
    serverExternal: process.env.HORIZON_SERVER_EXTERNAL,
    isPackaged: false,
  });
  if (!decision.allowed) {
    res.status(403).json({ ok: false, error: decision.reason });
    return false;
  }
  return true;
}

export function nativeDiagnosticsRouter(): Router {
  const r = Router();
  r.use(requireBootstrapAuthorization);

  r.get('/env-summary', (req: Request, res: Response) => {
    if (!policyGate(req, res)) return;
    res.status(200).json(buildServerEnvSummary());
  });

  r.get('/provider-status', (req: Request, res: Response) => {
    if (!policyGate(req, res)) return;
    res.status(200).json(buildProviderStatus());
  });

  return r;
}

export function shouldMountNativeDiagnostics(): boolean {
  return decideNativeInductionPolicy({
    nodeEnv: ENV.nodeEnv,
    nativeDiagnostics: process.env.HORIZON_NATIVE_DIAGNOSTICS,
    serverExternal: process.env.HORIZON_SERVER_EXTERNAL,
    isPackaged: false,
  }).allowed;
}
