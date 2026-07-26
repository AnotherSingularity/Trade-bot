import { describe, expect, it } from 'vitest';
import { PRIMARY_NAVIGATION, navGroupsInOrder } from '../src/shared/navigation';

describe('phase3a §H — primary navigation contract', () => {
  it('T58: PRIMARY_NAVIGATION covers all 19 required screens', () => {
    expect(PRIMARY_NAVIGATION).toHaveLength(19);
    const keys = new Set(PRIMARY_NAVIGATION.map((n) => n.key));
    for (const required of [
      'overview', 'shadow_portfolio', 'positions', 'decision_journal',
      'research_universe', 'fingerprints', 'regimes', 'portfolio_risk',
      'microstructure', 'context', 'validation_lab', 'costs_attribution',
      'protection', 'reconciliation', 'incidents', 'reports',
      'configuration', 'system', 'safety',
    ]) {
      expect(keys.has(required)).toBe(true);
    }
  });

  it('T59: nav groups are ordered operations → research → ops → safety', () => {
    expect(navGroupsInOrder()).toEqual(['operations', 'research', 'ops', 'safety']);
  });

  it('T60: safety screen does not require authentication (visible even when logged out)', () => {
    const safety = PRIMARY_NAVIGATION.find((n) => n.key === 'safety')!;
    expect(safety.requiresAuth).toBe(false);
    for (const n of PRIMARY_NAVIGATION) {
      if (n.key !== 'safety') expect(n.requiresAuth).toBe(true);
    }
  });
});
