/**
 * Phase 3A §H — Primary navigation.
 *
 * Desktop-oriented sidebar. NOT copied from mobile navigation.
 */

export interface NavItem {
  key: string;
  label: string;
  route: string;
  group: 'operations' | 'research' | 'ops' | 'safety';
  requiresAuth: boolean;
}

export const PRIMARY_NAVIGATION: readonly NavItem[] = [
  { key: 'overview', label: 'Overview', route: '/overview', group: 'operations', requiresAuth: true },
  { key: 'shadow_portfolio', label: 'Shadow Portfolio', route: '/shadow-portfolio', group: 'operations', requiresAuth: true },
  { key: 'positions', label: 'Positions', route: '/positions', group: 'operations', requiresAuth: true },
  { key: 'decision_journal', label: 'Decision Journal', route: '/decision-journal', group: 'operations', requiresAuth: true },
  { key: 'research_universe', label: 'Research Universe', route: '/research/universe', group: 'research', requiresAuth: true },
  { key: 'fingerprints', label: 'Fingerprints', route: '/research/fingerprints', group: 'research', requiresAuth: true },
  { key: 'regimes', label: 'Regimes', route: '/research/regimes', group: 'research', requiresAuth: true },
  { key: 'portfolio_risk', label: 'Portfolio Risk', route: '/research/portfolio-risk', group: 'research', requiresAuth: true },
  { key: 'microstructure', label: 'Microstructure', route: '/research/microstructure', group: 'research', requiresAuth: true },
  { key: 'context', label: 'Context', route: '/research/context', group: 'research', requiresAuth: true },
  { key: 'validation_lab', label: 'Validation Lab', route: '/research/validation-lab', group: 'research', requiresAuth: true },
  { key: 'costs_attribution', label: 'Costs and Attribution', route: '/ops/costs-attribution', group: 'ops', requiresAuth: true },
  { key: 'protection', label: 'Protection', route: '/ops/protection', group: 'ops', requiresAuth: true },
  { key: 'reconciliation', label: 'Reconciliation', route: '/ops/reconciliation', group: 'ops', requiresAuth: true },
  { key: 'incidents', label: 'Incidents', route: '/ops/incidents', group: 'ops', requiresAuth: true },
  { key: 'reports', label: 'Reports', route: '/ops/reports', group: 'ops', requiresAuth: true },
  { key: 'configuration', label: 'Configuration', route: '/system/configuration', group: 'ops', requiresAuth: true },
  { key: 'system', label: 'System', route: '/system', group: 'safety', requiresAuth: true },
  { key: 'safety', label: 'Safety', route: '/safety', group: 'safety', requiresAuth: false },
];

export function navGroupsInOrder(): readonly ('operations' | 'research' | 'ops' | 'safety')[] {
  return ['operations', 'research', 'ops', 'safety'];
}
