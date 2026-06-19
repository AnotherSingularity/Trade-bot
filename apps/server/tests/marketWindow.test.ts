import { describe, it, expect } from 'vitest';
import {
  getMarketWindow,
  isInSessionExclusion,
  isTradeableNow,
} from '../src/trading/marketWindow';

/**
 * Build a Date that reads as a given Eastern wall-clock time. We pick a winter
 * date (EST = UTC-5) so the conversion is deterministic.
 */
function easternDate(hour: number, minute = 0): Date {
  // 2026-01-15 is in EST (UTC-5). EST hour = UTC hour - 5.
  const utcHour = (hour + 5) % 24;
  return new Date(Date.UTC(2026, 0, 15, utcHour, minute, 0));
}

describe('getMarketWindow', () => {
  it('detects PRIME morning window', () => {
    expect(getMarketWindow(easternDate(9, 0))).toBe('PRIME');
  });
  it('detects PRIME afternoon window', () => {
    expect(getMarketWindow(easternDate(15, 0))).toBe('PRIME');
  });
  it('detects ACTIVE evening window', () => {
    expect(getMarketWindow(easternDate(21, 0))).toBe('ACTIVE');
  });
  it('detects CLOSED in the dead zone', () => {
    expect(getMarketWindow(easternDate(3, 0))).toBe('CLOSED');
    expect(getMarketWindow(easternDate(13, 0))).toBe('CLOSED');
  });
});

describe('isInSessionExclusion', () => {
  it('excludes the first 30 minutes after a session open', () => {
    expect(isInSessionExclusion(easternDate(8, 10))).toBe(true);
    expect(isInSessionExclusion(easternDate(20, 5))).toBe(true);
  });
  it('does not exclude well after the open', () => {
    expect(isInSessionExclusion(easternDate(9, 0))).toBe(false);
  });
});

describe('isTradeableNow', () => {
  it('is false during session-open exclusion even within a window', () => {
    expect(isTradeableNow(easternDate(8, 10))).toBe(false);
  });
  it('is true during PRIME outside exclusion', () => {
    expect(isTradeableNow(easternDate(10, 0))).toBe(true);
  });
  it('is false when market is closed', () => {
    expect(isTradeableNow(easternDate(3, 0))).toBe(false);
  });
});
