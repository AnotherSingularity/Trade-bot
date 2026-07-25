import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { CLAUDE_MODEL, STRATEGY_VERSION, type ClaudeSignal, type TradingMode } from '@horizon/shared';
import { ENV } from '../env';
import type { TokenSignals } from './modes';

/**
 * Anthropic Claude signal evaluation — Phase 0 hardened parser.
 *
 * Changes vs. the original implementation:
 *   • Response schema validated with zod. `shouldEnter` must be a JSON boolean;
 *     the string "false" is REJECTED (previous Boolean() coerced it to true).
 *   • Confidence must be a finite number in [0..1].
 *   • Reason must be a bounded non-empty string.
 *   • Any schema violation, timeout, or malformed response fails CLOSED
 *     (`shouldEnter=false, confidence=0`) with a diagnostic reason.
 *   • JSON extraction uses a non-greedy regex so trailing prose doesn't
 *     accidentally swallow an unrelated brace pair.
 *   • Records the exact model id + strategy version alongside each decision.
 */

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!ENV.anthropicApiKey) throw new Error('Anthropic API key not configured');
  if (!client) client = new Anthropic({ apiKey: ENV.anthropicApiKey });
  return client;
}

const SYSTEM_PROMPT = `You are the risk-confirmation layer for an autonomous crypto trading bot.
You receive a candidate trade that has already passed a quantitative technical filter.
Your job is to assess whether the setup is genuinely high quality or a likely false signal.

Respond ONLY with a compact JSON object of the form:
{"confidence": <number 0..1>, "shouldEnter": <boolean>, "reason": "<one concise sentence>"}

Be conservative. Penalize overextended moves, weak volume confirmation, and conflicting indicators.
Confidence is your probability that this trade reaches its take-profit before its stop-loss.`;

function buildUserPrompt(mode: TradingMode, signals: TokenSignals): string {
  return [
    `Mode: ${mode}`,
    `Strategy version: ${STRATEGY_VERSION}`,
    `Token: ${signals.token}`,
    `Price: ${signals.price}`,
    `24h volume (USD): ${signals.volume24h}`,
    `24h change %: ${signals.changePct24h}`,
    `RSI(14): ${signals.rsi ?? 'n/a'}`,
    `MACD histogram: ${signals.macdHistogram ?? 'n/a'}`,
    `Bollinger position: ${signals.bollingerPosition ?? 'n/a'}`,
    `EMA trend: ${signals.emaTrend ?? 'n/a'}`,
    `Signals passed: ${signals.passedSignals}/${signals.totalSignals}`,
    `Token historical win rate: ${signals.winRate === null ? 'no history' : signals.winRate + '%'}`,
    '',
    'Should the bot enter this trade?',
  ].join('\n');
}

const CLAUDE_TIMEOUT_MS = 15_000;

export interface ClaudeDecision extends ClaudeSignal {
  model: string;
  strategyVersion: string;
}

export async function evaluateSignal(
  mode: TradingMode,
  signals: TokenSignals,
): Promise<ClaudeDecision> {
  try {
    const msg = await getClient().messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(mode, signals) }],
      },
      { timeout: CLAUDE_TIMEOUT_MS },
    );

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const parsed = parseSignal(text);
    return { ...parsed, model: CLAUDE_MODEL, strategyVersion: STRATEGY_VERSION };
  } catch (err) {
    // Fail closed on any transport/timeout/rate-limit issue.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      confidence: 0,
      shouldEnter: false,
      reason: `claude call failed: ${msg}`,
      model: CLAUDE_MODEL,
      strategyVersion: STRATEGY_VERSION,
    };
  }
}

// ---------------------------------------------------------------------------
// Strict schema — the critical correctness fix.
// ---------------------------------------------------------------------------

const SignalSchema = z.object({
  confidence: z
    .number()
    .finite()
    .min(0)
    .max(1),
  // MUST be a JSON boolean. The string "false" was previously coerced to true
  // by `Boolean(...)` — that bug is why this uses `z.boolean()` (strict) with
  // no coercion.
  shouldEnter: z.boolean(),
  reason: z.string().min(1).max(500),
});

/**
 * Extracts and validates the first plausible JSON object in `text`.
 * Fails closed on ANY problem.
 */
export function parseSignal(text: string): ClaudeSignal {
  // Non-greedy match so `{"a":1} extra {other:2}` returns the first object.
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) {
    return { confidence: 0, shouldEnter: false, reason: 'no json in response' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return { confidence: 0, shouldEnter: false, reason: 'invalid json' };
  }
  const parsed = SignalSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      confidence: 0,
      shouldEnter: false,
      reason: `schema violation: ${issue?.path.join('.') ?? '?'} ${issue?.message ?? ''}`,
    };
  }
  return parsed.data;
}

export async function testConnection(): Promise<{ connected: boolean; message: string }> {
  if (!ENV.anthropicConfigured) {
    return { connected: false, message: 'Anthropic API key not configured' };
  }
  try {
    await getClient().messages.create(
      { model: CLAUDE_MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] },
      { timeout: 5_000 },
    );
    return { connected: true, message: `Connected — model ${CLAUDE_MODEL}` };
  } catch (err) {
    return { connected: false, message: err instanceof Error ? err.message : 'Unknown error' };
  }
}
