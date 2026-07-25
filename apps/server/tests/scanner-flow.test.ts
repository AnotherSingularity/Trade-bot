import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Contract test: in the scanner's entry loop, the profitability gate MUST
 * execute BEFORE any Claude call. This is the audit's non-negotiable
 * property — "Claude may reject a mathematically valid trade but may not
 * rescue a mathematically invalid trade."
 *
 * We enforce this at the source level with a lightweight regex check on
 * scanner.ts. If someone refactors and accidentally moves `evaluateSignal`
 * ahead of `applyEvGate`, this test flags it — a full end-to-end integration
 * mock would be heavier and no more informative.
 */

describe('scanner flow — Claude cannot rescue a negative-EV trade', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const scannerSrc = readFileSync(resolve(here, '../src/trading/scanner.ts'), 'utf8');

  it('previewCandidate appears before evaluateSignal in the entry loop', () => {
    const previewIdx = scannerSrc.indexOf('previewCandidate(');
    const claudeIdx = scannerSrc.indexOf('evaluateSignal(');
    expect(previewIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(previewIdx).toBeLessThan(claudeIdx);
  });

  it('buildCostForecast appears before evaluateSignal', () => {
    const costIdx = scannerSrc.indexOf('buildCostForecast(');
    const claudeIdx = scannerSrc.indexOf('evaluateSignal(');
    expect(costIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(costIdx).toBeLessThan(claudeIdx);
  });

  it('applyEvGate appears before evaluateSignal', () => {
    const gateIdx = scannerSrc.indexOf('applyEvGate(');
    const claudeIdx = scannerSrc.indexOf('evaluateSignal(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(claudeIdx);
  });

  it('the entry loop bails on gate rejection before Claude ("continue" after gate)', () => {
    // Ensures the code short-circuits: `if (gate.decision !== 'accept') { ...
    // continue; }` — otherwise a negative-EV trade could reach Claude.
    expect(scannerSrc).toMatch(/gate\.decision\s*!==\s*'accept'[\s\S]{0,1200}continue/);
  });

  it('every candidate — accepted or rejected — writes a quantitative_decisions row', () => {
    // Both the preview-reject branch and the EV-gate branch must
    // insertQuantitativeDecision so the audit trail is complete.
    const matches = scannerSrc.match(/insertQuantitativeDecision/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
