import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fullReset, coinbaseMock } from './setup/coinbase-mock';

vi.mock('../src/trading/coinbase', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/trading/coinbase')>();
  return { ...original, ...coinbaseMock };
});

import { db } from '../src/db';
import { orderIntents } from '../src/db/schema';
import { reconcileOnStartup } from '../src/trading/reconciler';
import { getBotConfig, insertOrderIntent } from '../src/db/queries';
import { eq } from 'drizzle-orm';

beforeEach(async () => {
  await fullReset();
});

describe('reconciler', () => {
  it('resolves a dry-run intent that has recorded fills → filled', async () => {
    const id = await insertOrderIntent({
      clientOrderId: 'hzn-dry-1',
      productId: 'AAVE-USD',
      token: 'AAVE',
      side: 'BUY',
      orderType: 'market_ioc',
      quoteSize: '10',
      mode: 'macro',
      purpose: 'entry',
      state: 'submitted',
      dryRun: true,
    });
    // Insert a fill row so reconciler sees it.
    await db.execute(
      `INSERT INTO fills
       (exchangeFillId, orderIntentId, exchangeOrderId, token, side, filledSize, fillPrice, fee, feeCurrency, tradeTime)
       VALUES ('fill-1', ${id}, 'DRY', 'AAVE', 'BUY', 0.1, 100, 0.06, 'USD', NOW())`,
    );
    const report = await reconcileOnStartup();
    expect(report.intentsRecovered).toBe(1);
    const cfg = await getBotConfig();
    expect(cfg.reconciliationStatus).toBe('ok');
    const [refreshed] = await db.select().from(orderIntents).where(eq(orderIntents.id, id));
    expect(refreshed.state).toBe('filled');
  });

  it('marks a dry-run intent without fills as failed / not_submitted', async () => {
    const id = await insertOrderIntent({
      clientOrderId: 'hzn-dry-orphan',
      productId: 'AAVE-USD',
      token: 'AAVE',
      side: 'BUY',
      orderType: 'market_ioc',
      quoteSize: '10',
      mode: 'macro',
      purpose: 'entry',
      state: 'submitted',
      dryRun: true,
    });
    const report = await reconcileOnStartup();
    expect(report.intentsReconciled).toBe(1);
    const [refreshed] = await db.select().from(orderIntents).where(eq(orderIntents.id, id));
    expect(refreshed.state).toBe('failed');
    expect(refreshed.failureClass).toBe('definitely_not_submitted');
  });

  it('no non-terminal intents → reconciliation succeeds immediately', async () => {
    const report = await reconcileOnStartup();
    expect(report.intentsReconciled).toBe(0);
    const cfg = await getBotConfig();
    expect(cfg.reconciliationStatus).toBe('ok');
  });
});
