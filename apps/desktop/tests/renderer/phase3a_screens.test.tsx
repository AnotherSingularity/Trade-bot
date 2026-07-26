import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewScreen } from '../../src/renderer/screens/Overview';
import { SafetyScreen } from '../../src/renderer/screens/Safety';
import { ReportsScreen } from '../../src/renderer/screens/Reports';
import { SystemScreen } from '../../src/renderer/screens/System';
import { ConfigurationScreen } from '../../src/renderer/screens/Configuration';
import { ValidationLabScreen } from '../../src/renderer/screens/ValidationLab';

describe('phase3a §H,§I — safety-critical renderer output', () => {
  it('T64: Overview renders the LIVE ORDER SUBMISSION DISABLED banner', () => {
    const html = renderToStaticMarkup(<OverviewScreen />);
    expect(html).toContain('LIVE ORDER SUBMISSION DISABLED');
  });

  it('T65: Safety screen renders the LIVE ORDER SUBMISSION DISABLED banner', () => {
    const html = renderToStaticMarkup(<SafetyScreen />);
    expect(html).toContain('LIVE ORDER SUBMISSION DISABLED');
    // Stage 3B: Safety screen loads its data from the safety.get envelope;
    // in the loading state (initial render) the banner is present but the
    // KV grids are not yet populated. The prohibited-actions block was
    // superseded by data-driven cards (see stage3b_state_matrices.test.tsx).
  });

  it('T66: Reports screen never renders raw credential fields', () => {
    const html = renderToStaticMarkup(<ReportsScreen />);
    expect(html).not.toMatch(/coinbaseKey|coinbaseSecret|apiKey|apiSecret/i);
  });

  it('T67: System screen renders the LIVE ORDER SUBMISSION DISABLED banner', () => {
    const html = renderToStaticMarkup(<SystemScreen />);
    expect(html).toContain('LIVE ORDER SUBMISSION DISABLED');
  });

  it('T68: Configuration screen renders the LIVE ORDER SUBMISSION DISABLED banner', () => {
    const html = renderToStaticMarkup(<ConfigurationScreen />);
    expect(html).toContain('LIVE ORDER SUBMISSION DISABLED');
    // Stage 3B: safety-critical read-only assertion moved into the
    // configuration.get payload contract (safetyCriticalReadOnly = true);
    // covered by the domain-honesty test on the server side.
  });

  it('T69: Validation Lab screen displays the MODEL PROMOTION DISABLED and PROSPECTIVE EVIDENCE PENDING banners', () => {
    const html = renderToStaticMarkup(<ValidationLabScreen />);
    expect(html).toContain('MODEL PROMOTION DISABLED');
    expect(html).toContain('PROSPECTIVE EVIDENCE PENDING');
    expect(html).toContain('read-only observer view');
  });
});
