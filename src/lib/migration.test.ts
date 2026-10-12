import { describe, expect, it } from 'vitest';
import { migrateV1 } from './migration';
import { makeData } from '../domain/testUtils';
import { applyChanges } from '../domain/commands';
import { balancesMap, incomeExpense } from '../domain/balances';
import { debtBalance } from '../domain/debts';
import { goalSaved } from '../domain/goals';

const v1 = {
  profile: { name: 'Мухаммед', avatar: null, birthDate: '' },
  settings: { salaryDay: 5, expectedIncome: 450000, minReserve: 0 },
  accounts: [
    { id: 'a1', name: 'Kaspi Gold', kind: 'available', initial: 320000.5, bankId: 'kaspi', type: 'card', currency: 'KZT', status: 'active' },
    { id: 'a4', name: 'Накопительный', kind: 'savings', initial: 1500000, bankId: 'halyk', type: 'deposit', currency: 'KZT', status: 'active' },
  ],
  operations: [
    { id: 'o1', type: 'income', amount: 450000, date: '2026-09-28', accountId: 'a1', category: 'Зарплата', comment: '', status: 'done' },
    { id: 'o2', type: 'expense', amount: 0.1, date: '2026-09-29', accountId: 'a1', category: 'Кафе', comment: '', status: 'done' },
    { id: 'o3', type: 'expense', amount: 0.2, date: '2026-09-29', accountId: 'a1', category: 'Продукты', comment: '', status: 'done' },
    { id: 'o4', type: 'transfer', amount: 100000, date: '2026-09-30', accountId: 'a1', toAccountId: 'a4', comment: '', status: 'done' },
    { id: 'o5', type: 'expense', amount: 25000, date: '2026-10-20', accountId: 'a1', category: 'Подписки', comment: 'Плановая', status: 'plan' },
    { id: 'o6', type: 'expense', amount: 999, date: '2026-09-30', accountId: 'zzz', category: 'Продукты', status: 'done' },
  ],
  debts: [{ id: 'd1', name: 'Кредит Halyk', type: 'Кредит', initial: 2000000, balance: 1278000, rate: 18, minPayment: 62000, payDay: 15, accountId: 'a1', startDate: '2025-03-15', endDate: '2028-03-15', status: 'active', payments: [{ date: '2026-09-15', amount: 62000, body: 40000, interest: 22000 }] }],
  goals: [{ id: 'g1', name: 'Машина', target: 6000000, saved: 1500000, date: '2028-03-01', accountId: 'a4' }],
  recurring: [{ id: 'r1', name: 'Netflix', amount: 4500, type: 'expense', category: 'Подписки', accountId: 'a1', interval: 'monthly', nextDate: '2026-11-05', status: 'active' }],
};

describe('migration from Qarajat 1.0', () => {
  it('converts amounts to tiyn, keeps balances, plans stay planned, debts and goals are not double-counted', () => {
    const base = makeData();
    const res = migrateV1(v1, base, '2026-10-12');
    const d = applyChanges(base, res.changes);
    expect(res.summary).toMatchObject({ accounts: 2, operations: 4, plannedEvents: 1, debts: 1, goals: 1, recurring: 1 });
    expect(res.warnings.length).toBe(1);
    const kaspi = d.accounts.find((a) => a.name === 'Kaspi Gold')!;
    const sav = d.accounts.find((a) => a.type === 'savings')!;
    const m = balancesMap(d);
    expect(m.get(kaspi.id)).toBe(32_000_050 + 45_000_000 - 30 - 10_000_000);
    expect(m.get(sav.id)).toBe(160_000_000);
    expect(sav.includeInSpending).toBe(false);
    expect(incomeExpense(d.operations, '2026-09-01', '2026-09-30').expense).toBe(30);
    expect(d.events).toHaveLength(1);
    const debt = d.debts[0];
    expect(debtBalance(debt, d.debtPayments)).toBe(127_800_000);
    expect(debt.firstDueDate).toBe('2026-10-15');
    expect(goalSaved(d.goals[0], d.goalContributions)).toBe(150_000_000);
    expect(d.categories.some((c) => c.name === 'Кафе')).toBe(true);
    expect(d.profile.displayName).toBe('Мухаммед');
    expect(d.profile.migrationHandled).toBe(true);
  });
  it('rejects garbage', () => {
    expect(() => migrateV1('x', makeData())).toThrow();
  });
});
