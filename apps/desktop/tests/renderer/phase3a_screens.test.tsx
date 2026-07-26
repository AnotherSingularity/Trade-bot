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

  it('T65: Safety screen displays the immutable safe-flag posture', () => {
    const html = renderToStaticMarkup(<SafetyScreen />);
    expect(html).toContain('LIVE ORDER SUBMISSION DISABLED');
    expect(html).toContain('DRY_RUN');
    expect(html).toContain('ORDER_SUBMISSION_ENABLED');
    expect(html).toContain('Place, cancel or modify a live order');
    expect(html).toContain('Toggle DRY_RUN or ORDER_SUBMISSION_ENABLED');
  });

  it('T66: Reports screen never renders raw credential fields', () => {
    const html = renderToStaticMarkup(<ReportsScreen />);
    expect(html).not.toMatch(/coinbaseKey|coinbaseSecret|apiKey|apiSecret/i);
  });

  it('T67: System screen renders the local-only messaging', () => {
    const html = renderToStaticMarkup(<SystemScreen />);
    expect(html).toContain('local runtime');
  });

  it('T68: Configuration screen warns that safety flags are immutable in this console', () => {
    const html = renderToStaticMarkup(<ConfigurationScreen />);
    expect(html).toContain('cannot be changed from this console');
  });

  it('T69: Validation Lab screen states promotion is read-only in the operator console', () => {
    const html = renderToStaticMarkup(<ValidationLabScreen />);
    expect(html).toContain('read-only');
    expect(html).toContain('does not run promotions');
  });
});
