const { startDb, stopDb, clearDb, createUser, queryOne } = require('./helpers');
const walletService = require('../src/services/wallet.service');

beforeAll(startDb);
afterAll(stopDb);
afterEach(clearDb);

describe('walletService.applyChange', () => {
  test('credit adds credits and writes a ledger entry', async () => {
    const { user } = await createUser();
    const r = await walletService.applyChange(user.id, 250, 'ad_reward', 'tx-1');
    expect(r.balance).toBe(250);
    expect(r.duplicate).toBe(false);
    const entry = await queryOne("SELECT * FROM ledger_entries WHERE ref_id = 'tx-1'");
    expect(Number(entry.amount)).toBe(250);
    expect(Number(entry.balance_after)).toBe(250);
  });

  test('debit removes credits', async () => {
    const { user } = await createUser({ credits: 5000 });
    const r = await walletService.applyChange(user.id, -2250, 'call_charge', 'CA1');
    expect(r.balance).toBe(2750);
    const w = await walletService.getWallet(user.id);
    expect(Number(w.lifetime_spent)).toBe(2250);
  });

  test('insufficient balance is rejected and nothing is written', async () => {
    const { user } = await createUser({ credits: 100 });
    await expect(walletService.applyChange(user.id, -101, 'call_charge', 'CA2')).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    expect((await walletService.getWallet(user.id)).credits).toBe(100);
    expect(await queryOne("SELECT 1 FROM ledger_entries WHERE ref_id = 'CA2'")).toBeNull();
  });

  test('duplicate refId is idempotent (never credited twice)', async () => {
    const { user } = await createUser();
    await walletService.applyChange(user.id, 80000, 'purchase', 'order:1');
    const again = await walletService.applyChange(user.id, 80000, 'purchase', 'order:1');
    expect(again.duplicate).toBe(true);
    expect(again.balance).toBe(80000);
    expect((await queryOne("SELECT COUNT(*)::int AS n FROM ledger_entries WHERE type = 'purchase' AND ref_id = 'order:1'")).n).toBe(1);
  });

  test('concurrent duplicates still apply once', async () => {
    const { user } = await createUser();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => walletService.applyChange(user.id, 250, 'ad_reward', 'tx-race')),
    );
    expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThan(0);
    expect((await walletService.getWallet(user.id)).credits).toBe(250);
  });

  test('partial reversal stops at 0 and flags the user', async () => {
    const { user } = await createUser({ credits: 3000 });
    const r = await walletService.applyChange(user.id, -80000, 'payment_reversal', 'order:9', { partial: true });
    expect(r.balance).toBe(0);
    expect(r.shortfall).toBe(77000);
    expect((await queryOne('SELECT negative_usage FROM users WHERE id = $1', [user.id])).negative_usage).toBe(true);
  });

  test('zero / non-integer amounts are refused', async () => {
    const { user } = await createUser();
    await expect(walletService.applyChange(user.id, 0, 'ad_reward', 'x')).rejects.toMatchObject({ code: 'BAD_AMOUNT' });
    await expect(walletService.applyChange(user.id, 1.5, 'ad_reward', 'y')).rejects.toMatchObject({ code: 'BAD_AMOUNT' });
  });

  test('reconciliation finds no mismatch after normal use', async () => {
    const { user } = await createUser({ credits: 2000 });
    await walletService.applyChange(user.id, -1017, 'call_charge', 'CA3');
    expect(await walletService.reconcileAll()).toEqual([]);
  });
});
