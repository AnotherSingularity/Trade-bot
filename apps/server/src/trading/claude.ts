import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODEL, type ClaudeSignal, type TradingMode } from '@horizon/shared';
import { ENV } from '../env';
import type { TokenSignals } from './modes';

/**
 * Anthropic Claude signal evaluation.
 *
 * Claude acts as a final confirmation layer: given the technical signals that
 * already passed the mode's threshold, it returns a confidence score (0..1) and
 * a short human-readable rationale that is stored alongside each trade.
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

export async function evaluateSignal(
  mode: TradingMode,
  signals: TokenSignals,
): Promise<ClaudeSignal> {
  const msg = await getClient().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(mode, signals) }],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return parseSignal(text);
}

/** Tolerant JSON extraction so a stray prose wrapper doesn't break parsing. */
export function parseSignal(text: string): ClaudeSignal {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return { confidence: 0, shouldEnter: false, reason: 'Unparseable model response' };
  }
  try {
    const parsed = JSON.parse(match[0]) as Partial<ClaudeSignal>;
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)));
    return {
      confidence,
      shouldEnter: Boolean(parsed.shouldEnter),
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'No reason provided',
    };
  } catch {
    return { confidence: 0, shouldEnter: false, reason: 'Invalid JSON in model response' };
  }
}

export async function testConnection(): Promise<{ connected: boolean; message: string }> {
  if (!ENV.anthropicConfigured) {
    return { connected: false, message: 'Anthropic API key not configured' };
  }
  try {
    await getClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { connected: true, message: `Connected — model ${CLAUDE_MODEL}` };
  } catch (err) {
    return { connected: false, message: err instanceof Error ? err.message : 'Unknown error' };
  }
}
