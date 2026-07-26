import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HealthBar } from '../../src/renderer/components/HealthBar';
import { PRIMARY_NAVIGATION, navGroupsInOrder } from '../../src/shared/navigation';

describe('phase3a §H,§I — persistent chrome', () => {
  it('T70: HealthBar always renders DRY_RUN and LIVE ORDER SUBMISSION DISABLED badges', () => {
    const html = renderToStaticMarkup(<HealthBar />);
    expect(html).toContain('DRY_RUN = TRUE');
    expect(html).toContain('LIVE ORDER SUBMISSION DISABLED');
    expect(html).toContain('CreateOrder invocations=');
  });

  it('T71: Sidebar navigation contract covers all four groups', () => {
    const groups = navGroupsInOrder();
    for (const g of groups) {
      const items = PRIMARY_NAVIGATION.filter((n) => n.group === g);
      expect(items.length, `group ${g} has no items`).toBeGreaterThan(0);
    }
    expect(groups).toEqual(['operations', 'research', 'ops', 'safety']);
  });

  it('T72: Sidebar navigation routes are unique and correctly namespaced', () => {
    const routes = PRIMARY_NAVIGATION.map((n) => n.route);
    const unique = new Set(routes);
    expect(unique.size).toBe(routes.length);
    expect(routes).toContain('/overview');
    expect(routes).toContain('/safety');
    expect(routes).toContain('/system');
    for (const n of PRIMARY_NAVIGATION.filter((n) => n.group === 'research')) {
      expect(n.route.startsWith('/research/')).toBe(true);
    }
    for (const n of PRIMARY_NAVIGATION.filter((n) => n.group === 'ops')) {
      // Configuration falls under 'ops' group but is namespaced /system/configuration.
      expect(n.route.startsWith('/ops/') || n.route.startsWith('/system/')).toBe(true);
    }
  });
});
