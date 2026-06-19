import { STRATEGY, type MarketWindow } from '@horizon/shared';

/**
 * Market window detection in US Eastern time (EST/EDT aware).
 *
 * The strategy defines PRIME and ACTIVE trading windows plus session-open
 * exclusion zones. All comparisons are done on the wall-clock time in the
 * America/New_York timezone regardless of server timezone.
 */

/** Returns the current {hour, minute} in America/New_York. */
export function getEasternTime(now: Date = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function inWindow(nowMin: number, windows: readonly { start: string; end: string }[]): boolean {
  return windows.some((w) => nowMin >= toMinutes(w.start) && nowMin < toMinutes(w.end));
}

export function getMarketWindow(now: Date = new Date()): MarketWindow {
  const { hour, minute } = getEasternTime(now);
  const nowMin = hour * 60 + minute;
  if (inWindow(nowMin, STRATEGY.MARKET_WINDOWS.PRIME)) return 'PRIME';
  if (inWindow(nowMin, STRATEGY.MARKET_WINDOWS.ACTIVE)) return 'ACTIVE';
  return 'CLOSED';
}

/**
 * True when the current time is within SESSION_EXCLUSION_MINUTES after a session
 * open — a volatile period the strategy deliberately sits out.
 */
export function isInSessionExclusion(now: Date = new Date()): boolean {
  const { hour, minute } = getEasternTime(now);
  const nowMin = hour * 60 + minute;
  return STRATEGY.SESSION_OPENS.some((open) => {
    const openMin = toMinutes(open);
    return nowMin >= openMin && nowMin < openMin + STRATEGY.SESSION_EXCLUSION_MINUTES;
  });
}

/** The bot only trades during PRIME or ACTIVE windows, outside exclusion zones. */
export function isTradeableNow(now: Date = new Date()): boolean {
  return getMarketWindow(now) !== 'CLOSED' && !isInSessionExclusion(now);
}
