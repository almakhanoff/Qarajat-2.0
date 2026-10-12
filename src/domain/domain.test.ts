import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from './money';
import { addMonths, nextDayOfMonth } from './dates';
import { accountBalance, balancesMap, incomeExpense } from './balances';
import { annuityPayment, buildSchedule, debtBalance, debtSummary, nextUnpaidDue } from './debts';
import {
  addDebtPayment, addGoalContribution, applyChanges, confirmEvent, confirmOccurrence, deleteAccount, deleteDebtPayment,
  deleteOperation, saveAccount, saveDebt, saveEvent, saveGoal, saveOperation, saveRecurring, ValidationError,
} from './commands';
import { goalForecast, goalSaved } from './goals';
import { safeToSpend } from './safeToSpend';
import { runAudit } from './audit';
import { calendarItems } from './calendar';
import { account, catId, debt, makeData, operation } from './testUtils';
import type { AppData, Change } from './types';
import { newId } from './ids';

const apply = (d: AppData, ch: Change[]) => applyChanges(d, ch);

describe('money', () => {
  it('parses user input into tiyn without float errors', () => {
    expect(parseMoney('12 500,50')).toBe(1_250_050);
    expect(parseMoney('12500.5')).toBe(1_250_050);
    expect(parseMoney('1 000 000')).toBe(100_000_000);
    expect(parseMoney('1.000.000')).toBe(100_000_000);
    expect(parseMoney('12,500')).toBe(1_250_000);
    expect(parseMoney('1.234,56')).toBe(123_456);
    expect(parseMoney('0,1')).toBe(10);
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('1,234')).toBe(123_400);
    expect(parseMoney('1,2345')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });
  it('sums 0.1 + 0.2 exactly', () => {
    expect(parseMoney('0,1')! + parseMoney('0,2')!).toBe(parseMoney('0,3'));
  });
  it('formats', () => {
    expect(formatMoney(1_250_050)).toBe('12 500,50 ₸');
    expect(formatMoney(-500_000)).toBe('−5 000 ₸');
    expect(formatMoney(500_000, { sign: true })).toBe('+5 000 ₸');
  });
});

describe('dates', () => {
  it('clamps month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 1, 31)).toBe('2026-02-28');
    expect(addMonths('2026-02-28', 1, 31)).toBe('2026-03-31');
    expect(nextDayOfMonth('2026-10-16', 15)).toBe('2026-11-15');
    expect(nextDayOfMonth('2026-10-15', 15)).toBe('2026-10-15');
  });
});

describe('accounts and operations', () => {
  it('balance = initial + history; transfers do not create income/expense', () => {
    let d = makeData();
    const a = account({ initialBalance: 100_000_00 });
    const b = account({ initialBalance: 0, type: 'savings' });
    d = apply(d, saveAccount(d, a));
    d = apply(d, saveAccount(d, b));
    d = apply(d, saveOperation(d, operation({ type: 'income', amount: 50_000_00, accountId: a.id, categoryId: catId(d, 'Зарплата') }), '2026-10-12'));
    d = apply(d, saveOperation(d, operation({ type: 'expense', amount: 12_345_67, accountId: a.id, categoryId: catId(d, 'Продукты') }), '2026-10-12'));
    d = apply(d, saveOperation(d, operation({ type: 'transfer', amount: 30_000_00, accountId: a.id, toAccountId: b.id }), '2026-10-12'));
    d = apply(d, saveOperation(d, operation({ type: 'adjustment', amount: -1_000_00, accountId: b.id }), '2026-10-12'));
    const m = balancesMap(d);
    expect(m.get(a.id)).toBe(100_000_00 + 50_000_00 - 12_345_67 - 30_000_00);
    expect(m.get(b.id)).toBe(29_000_00);
    expect(accountBalance(a, d.operations)).toBe(m.get(a.id));
    const ie = incomeExpense(d.operations, '2026-10-01', '2026-10-31');
    expect(ie).toEqual({ income: 50_000_00, expense: 12_345_67, net: 50_000_00 - 12_345_67 });
  });

  it('editing an operation recalculates balance', () => {
    let d = makeData();
    const a = account({ initialBalance: 10_000_00 });
    d = apply(d, saveAccount(d, a));
    const op = operation({ type: 'expense', amount: 1_000_00, accountId: a.id, categoryId: catId(d, 'Продукты') });
    d = apply(d, saveOperation(d, op, '2026-10-12'));
    d = apply(d, saveOperation(d, { ...op, amount: 2_500_00 }, '2026-10-12'));
    expect(d.operations).toHaveLength(1);
    expect(balancesMap(d).get(a.id)).toBe(7_500_00);
  });

  it('validates operations', () => {
    const d0 = makeData();
    const a = account();
    const d = apply(d0, saveAccount(d0, a));
    expect(() => saveOperation(d, operation({ type: 'expense', amount: -5, accountId: a.id, categoryId: catId(d, 'Продукты') }), '2026-10-12')).toThrow(ValidationError);
    expect(() => saveOperation(d, operation({ type: 'expense', amount: 5, accountId: a.id }), '2026-10-12')).toThrow('категорию');
    expect(() => saveOperation(d, operation({ type: 'transfer', amount: 5, accountId: a.id, toAccountId: a.id }), '2026-10-12')).toThrow('тот же');
    expect(() => saveOperation(d, operation({ type: 'expense', amount: 5, accountId: a.id, categoryId: catId(d, 'Продукты'), date: '2026-12-01T10:00' }), '2026-10-12')).toThrow('будущем');
    expect(() => saveOperation(d, operation({ type: 'income', amount: 5, accountId: a.id, categoryId: catId(d, 'Продукты') }), '2026-10-12')).toThrow('не соответствует');
  });

  it('does not delete an account with operations', () => {
    let d = makeData();
    const a = account();
    d = apply(d, saveAccount(d, a));
    d = apply(d, saveOperation(d, operation({ type: 'income', amount: 1, accountId: a.id, categoryId: catId(d, 'Зарплата') }), '2026-10-12'));
    expect(() => deleteAccount(d, a.id)).toThrow('операции');
  });
});

describe('debts', () => {
  it('annuity payment formula', () => {
    // 1 200 000 ₸, 12% годовых, 12 мес → 106 618,55 ₸ (округление вверх до тиына)
    expect(annuityPayment(1_200_000_00, 12, 12)).toBe(10_661_855);
    expect(annuityPayment(1_200_000_00, 0, 12)).toBe(100_000_00);
  });

  it('annuity schedule repays debt by end date', () => {
    const dt = debt({ monthlyPayment: annuityPayment(1_200_000_00, 12, 12), endDate: '2026-12-15' });
    const s = buildSchedule(dt, []);
    expect(s.items).toHaveLength(12);
    expect(s.items.at(-1)!.balanceAfter).toBe(0);
    expect(s.closingDate).toBe('2026-12-15');
    expect(s.totalInterest).toBeGreaterThan(79_000_00);
    expect(s.totalInterest).toBeLessThan(80_000_00);
  });

  it('differentiated schedule has decreasing payments', () => {
    const dt = debt({ scheduleType: 'differentiated', endDate: '2026-12-15' });
    const s = buildSchedule(dt, []);
    expect(s.items).toHaveLength(12);
    expect(s.items[0].principal).toBe(100_000_00);
    expect(s.items[0].interest).toBe(12_000_00);
    expect(s.items[1].payment).toBeLessThan(s.items[0].payment);
    expect(s.items.at(-1)!.balanceAfter).toBe(0);
  });

  it('flags a payment that never covers interest', () => {
    const dt = debt({ monthlyPayment: 10_000_00, endDate: null });
    expect(buildSchedule(dt, []).neverRepaid).toBe(true);
  });

  it('regular payment: interest + principal, creates exactly one expense, no double confirmation', () => {
    let d = makeData();
    const a = account({ initialBalance: 500_000_00 });
    d = apply(d, saveAccount(d, a));
    const dt = debt({ monthlyPayment: annuityPayment(1_200_000_00, 12, 12), accountId: a.id, endDate: '2026-12-15' });
    d = apply(d, saveDebt(d, dt));
    d = apply(d, addDebtPayment(d, { debtId: dt.id, date: '2026-01-15', amount: dt.monthlyPayment, kind: 'regular', accountId: a.id }, '2026-10-12'));
    const p = d.debtPayments[0];
    expect(p.interestPart).toBe(12_000_00);
    expect(p.principalPart).toBe(dt.monthlyPayment - 12_000_00);
    expect(p.scheduledFor).toBe('2026-01-15');
    expect(d.operations).toHaveLength(1);
    expect(balancesMap(d).get(a.id)).toBe(500_000_00 - dt.monthlyPayment);
    expect(debtBalance(dt, d.debtPayments)).toBe(1_200_000_00 - p.principalPart);
    expect(nextUnpaidDue(dt, d.debtPayments)).toBe('2026-02-15');
    expect(() => addDebtPayment(d, { debtId: dt.id, date: '2026-01-16', amount: 1, kind: 'regular', accountId: a.id, scheduledFor: '2026-01-15' }, '2026-10-12')).toThrow('уже подтверждён');
  });

  it('early repayment reduce_term shortens schedule; reduce_payment lowers payment; deleting restores', () => {
    let d = makeData();
    const a = account({ initialBalance: 2_000_000_00 });
    d = apply(d, saveAccount(d, a));
    const pay = annuityPayment(1_200_000_00, 12, 12);
    const dt = debt({ monthlyPayment: pay, endDate: '2026-12-15' });
    d = apply(d, saveDebt(d, dt));
    const before = debtSummary(dt, d.debtPayments, '2026-01-01');

    const d1 = apply(d, addDebtPayment(d, { debtId: dt.id, date: '2026-01-05', amount: 600_000_00, kind: 'early', earlyMode: 'reduce_term', accountId: a.id }, '2026-10-12'));
    const s1 = debtSummary(d1.debts[0], d1.debtPayments, '2026-01-01');
    expect(s1.balance).toBe(600_000_00);
    expect(s1.closingDate! < before.closingDate!).toBe(true);
    expect(s1.overpayment).toBeLessThan(before.overpayment);
    expect(d1.debts[0].monthlyPayment).toBe(pay);

    const d2 = apply(d, addDebtPayment(d, { debtId: dt.id, date: '2026-01-05', amount: 600_000_00, kind: 'early', earlyMode: 'reduce_payment', accountId: a.id }, '2026-10-12'));
    expect(d2.debts[0].monthlyPayment).toBe(annuityPayment(600_000_00, 12, 12));
    expect(debtSummary(d2.debts[0], d2.debtPayments, '2026-01-01').closingDate).toBe('2026-12-15');
    const opId = d2.debtPayments[0].operationId!;
    const d3 = apply(d2, deleteOperation(d2, opId));
    expect(d3.debtPayments).toHaveLength(0);
    expect(d3.debts[0].monthlyPayment).toBe(pay);
    expect(debtBalance(d3.debts[0], d3.debtPayments)).toBe(1_200_000_00);
  });

  it('rejects payment above balance and deleting payment removes its operation', () => {
    let d = makeData();
    const a = account({ initialBalance: 0 });
    d = apply(d, saveAccount(d, a));
    const dt = debt({ balanceAtEntry: 100_000_00, principal: 100_000_00, annualRate: 0, scheduleType: 'none', monthlyPayment: 10_000_00, endDate: null });
    d = apply(d, saveDebt(d, dt));
    expect(() => addDebtPayment(d, { debtId: dt.id, date: '2026-01-05', amount: 100_000_01, kind: 'early', earlyMode: 'reduce_term', accountId: a.id }, '2026-10-12')).toThrow('превышает');
    d = apply(d, addDebtPayment(d, { debtId: dt.id, date: '2026-01-15', amount: 10_000_00, kind: 'regular', accountId: a.id }, '2026-10-12'));
    expect(d.operations).toHaveLength(1);
    d = apply(d, deleteDebtPayment(d, d.debtPayments[0].id));
    expect(d.operations).toHaveLength(0);
  });

  it('planned debt payments do not reduce balance until confirmed', () => {
    let d = makeData();
    const a = account({ initialBalance: 300_000_00 });
    d = apply(d, saveAccount(d, a));
    const dt = debt({ monthlyPayment: 50_000_00, accountId: a.id, firstDueDate: '2026-10-15', endDate: null, annualRate: 0, scheduleType: 'none' });
    d = apply(d, saveDebt(d, dt));
    const items = calendarItems(d, '2026-10-01', '2026-10-31', '2026-10-12').filter((i) => i.kind === 'debt');
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('planned');
    expect(balancesMap(d).get(a.id)).toBe(300_000_00);
  });
});

describe('goals', () => {
  it('contributions transfer money but do not change capital; withdrawal capped', () => {
    let d = makeData();
    const card = account({ initialBalance: 500_000_00 });
    const sav = account({ initialBalance: 100_000_00, type: 'savings', includeInSpending: false });
    d = apply(d, saveAccount(d, card));
    d = apply(d, saveAccount(d, sav));
    const goal = { id: newId(), name: 'Машина', description: '', target: 1_000_000_00, targetDate: '2027-10-01', photoId: null, accountId: sav.id, archived: false, createdAt: Date.now() };
    d = apply(d, saveGoal(d, goal, 100_000_00, '2026-10-12'));
    const totalBefore = [...balancesMap(d).values()].reduce((s, v) => s + v, 0);
    d = apply(d, addGoalContribution(d, { goalId: goal.id, amount: 200_000_00, direction: 'deposit', date: '2026-10-12', note: '', otherAccountId: card.id }, '2026-10-12'));
    expect(goalSaved(goal, d.goalContributions)).toBe(300_000_00);
    expect([...balancesMap(d).values()].reduce((s, v) => s + v, 0)).toBe(totalBefore);
    expect(balancesMap(d).get(sav.id)).toBe(300_000_00);
    expect(() => addGoalContribution(d, { goalId: goal.id, amount: 300_000_01, direction: 'withdraw', date: '2026-10-12', note: '', otherAccountId: null }, '2026-10-12')).toThrow('больше накопленного');
    const f = goalForecast(goal, d.goalContributions, '2026-10-12');
    expect(f.progress).toBeCloseTo(30);
    expect(f.requiredMonthly).toBe(Math.ceil(700_000_00 / 12));
  });
});

describe('recurring & events', () => {
  it('confirming an occurrence twice is rejected; event confirmation creates operation once', () => {
    let d = makeData();
    const a = account({ initialBalance: 100_000_00 });
    d = apply(d, saveAccount(d, a));
    const rule = { id: newId(), title: 'Аренда', type: 'expense' as const, amount: 50_000_00, accountId: a.id, categoryId: catId(d, 'Жильё'), frequency: 'monthly' as const, startDate: '2026-10-10', endDate: null, essential: true, active: true, skippedDates: [], createdAt: new Date('2026-10-01').getTime() };
    d = apply(d, saveRecurring(d, rule));
    d = apply(d, confirmOccurrence(d, rule.id, '2026-10-10', { amount: 50_000_00, accountId: a.id, date: '2026-10-10' }, '2026-10-12'));
    expect(() => confirmOccurrence(d, rule.id, '2026-10-10', { amount: 50_000_00, accountId: a.id, date: '2026-10-10' }, '2026-10-12')).toThrow('уже подтверждён');
    expect(balancesMap(d).get(a.id)).toBe(50_000_00);

    const ev = { id: newId(), title: 'Страховка', date: '2026-10-12', type: 'expense' as const, amount: 5_000_00, accountId: a.id, categoryId: catId(d, 'Транспорт'), essential: true, note: '', status: 'planned' as const, operationId: null, createdAt: Date.now() };
    d = apply(d, saveEvent(d, ev));
    d = apply(d, confirmEvent(d, ev.id, { amount: 5_000_00, accountId: a.id, date: '2026-10-12' }, '2026-10-12'));
    expect(() => confirmEvent(d, ev.id, { amount: 5_000_00, accountId: a.id, date: '2026-10-12' }, '2026-10-12')).toThrow('уже подтверждено');
    expect(balancesMap(d).get(a.id)).toBe(45_000_00);
    const opId = d.events[0].operationId!;
    d = apply(d, deleteOperation(d, opId));
    expect(d.events[0].status).toBe('planned');
  });
});

describe('safe to spend', () => {
  it('subtracts obligations before salary, goal reserves and reserve; does not add future salary', () => {
    let d = makeData();
    d = { ...d, profile: { ...d.profile, salaryDay: 25, expectedSalary: 400_000_00, reserveAmount: 20_000_00 } };
    const a = account({ initialBalance: 200_000_00 });
    d = apply(d, saveAccount(d, a));
    const dt = debt({ monthlyPayment: 50_000_00, firstDueDate: '2026-10-15', paymentDay: 15, endDate: null, annualRate: 0, scheduleType: 'none' });
    d = apply(d, saveDebt(d, dt));
    const goal = { id: newId(), name: 'Подушка', description: '', target: 100_000_00, targetDate: null, photoId: null, accountId: a.id, archived: false, createdAt: Date.now() };
    d = apply(d, saveGoal(d, goal, 30_000_00, '2026-10-12'));
    const r = safeToSpend(d, '2026-10-12');
    expect(r.periodEnd).toBe('2026-10-25');
    expect(r.daysLeft).toBe(13);
    expect(r.obligations).toBe(50_000_00);
    expect(r.canSpend).toBe(200_000_00 - 30_000_00 - 20_000_00 - 50_000_00);
    expect(r.dailyLimit).toBe(Math.floor(100_000_00 / 13));
    expect(r.forecastAfterSalary).toBe(200_000_00 - 50_000_00 + 400_000_00);
    expect(r.available).toBe(200_000_00);
  });
  it('reports deficit instead of showing negative as free money', () => {
    let d = makeData();
    const a = account({ initialBalance: 10_000_00 });
    d = apply(d, saveAccount(d, a));
    d = apply(d, saveDebt(d, debt({ monthlyPayment: 50_000_00, firstDueDate: '2026-10-15', endDate: null, annualRate: 0, scheduleType: 'none' })));
    const r = safeToSpend(d, '2026-10-12');
    expect(r.deficit).toBe(true);
    expect(r.dailyLimit).toBe(0);
  });
});

describe('audit', () => {
  it('computes category shares, month comparison and over-limit', () => {
    let d = makeData();
    const a = account({ initialBalance: 1_000_000_00 });
    d = apply(d, saveAccount(d, a));
    const food = catId(d, 'Продукты');
    const cafe = catId(d, 'Кафе и рестораны');
    d = { ...d, categories: d.categories.map((c) => (c.id === cafe ? { ...c, monthlyLimit: 20_000_00 } : c)) };
    const add = (amount: number, categoryId: string, date: string, type: 'expense' | 'income' = 'expense') => {
      d = apply(d, saveOperation(d, operation({ type, amount, accountId: a.id, categoryId, date }), '2026-10-12'));
    };
    add(300_000_00, catId(d, 'Зарплата'), '2026-10-05T10:00', 'income');
    add(60_000_00, food, '2026-10-03T10:00');
    add(40_000_00, cafe, '2026-10-04T10:00');
    add(50_000_00, food, '2026-09-03T10:00');
    add(10_000_00, cafe, '2026-09-04T10:00');
    const r = runAudit(d, '2026-10');
    expect(r.expense).toBe(100_000_00);
    expect(r.top?.name).toBe('Продукты');
    expect(r.top?.share).toBeCloseTo(60);
    expect(r.expenseChangePct).toBeCloseTo(((100 - 60) / 60) * 100);
    expect(r.overLimit.map((c) => c.name)).toEqual(['Кафе и рестораны']);
    expect(r.savings[0].name).toBe('Кафе и рестораны');
    expect(r.daily[2].amount).toBe(60_000_00);
    expect(r.essential).toBe(60_000_00);
  });
  it('reports no data honestly', () => {
    const r = runAudit(makeData(), '2026-10');
    expect(r.hasData).toBe(false);
    expect(r.insights).toHaveLength(0);
  });
});
