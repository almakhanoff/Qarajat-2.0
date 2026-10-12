import type { AppData } from './types';
import type { Tiyn } from './money';
import { addDays, addMonths, diffDays, monthKey, monthRange, nextDayOfMonth, type ISODate } from './dates';
import { balancesMap, incomeExpense, isBaseCurrency } from './balances';
import { reservedOnAccount } from './goals';
import { pendingInflows, pendingOutflows, type CalendarItem } from './calendar';

export interface SafeToSpendLine {
  label: string;
  amount: Tiyn;
  hint?: string;
}

export interface SafeToSpendResult {
  /** Можно потратить до зарплаты */
  canSpend: Tiyn;
  daysLeft: number;
  dailyLimit: Tiyn;
  /** Дата следующей зарплаты (или конец месяца, если день зарплаты не указан) */
  periodEnd: ISODate;
  salaryKnown: boolean;
  available: Tiyn;
  reservedGoals: Tiyn;
  reserve: Tiyn;
  obligations: Tiyn;
  obligationItems: CalendarItem[];
  limitRemaining: Tiyn | null;
  limitApplied: boolean;
  /** Прогноз: остаток после всех обязательств + ожидаемая зарплата и плановые поступления */
  forecastAfterSalary: Tiyn;
  expectedIncome: Tiyn;
  deficit: boolean;
  noAccounts: boolean;
  lines: SafeToSpendLine[];
}

export function safeToSpend(data: AppData, now: ISODate): SafeToSpendResult {
  const { profile } = data;
  const salaryKnown = profile.salaryDay != null && profile.salaryDay >= 1 && profile.salaryDay <= 31;
  // Следующая зарплата — строго после сегодняшнего дня
  const periodEnd = salaryKnown ? nextDayOfMonth(addDays(now, 1), profile.salaryDay!) : monthRange(monthKey(now)).to;
  const daysLeft = Math.max(1, diffDays(now, periodEnd) + (salaryKnown ? 0 : 1));
  const lastDay = salaryKnown ? addDays(periodEnd, -1) : periodEnd;

  const balances = balancesMap(data);
  const spendAccounts = data.accounts.filter((a) => a.isActive && a.includeInSpending && isBaseCurrency(a) && a.type !== 'asset');
  let available = 0;
  let reservedGoals = 0;
  for (const a of spendAccounts) {
    const bal = balances.get(a.id) ?? 0;
    available += bal;
    reservedGoals += Math.min(Math.max(0, bal), reservedOnAccount(a.id, data.goals, data.goalContributions));
  }
  const reserve = Math.max(0, profile.reserveAmount || 0);

  const obligationItems = pendingOutflows(data, now, lastDay, now, addMonths(now, -12));
  const obligations = obligationItems.reduce((s, i) => s + (i.amount ?? 0), 0);

  let canSpend = available - reservedGoals - reserve - obligations;
  let limitRemaining: Tiyn | null = null;
  let limitApplied = false;
  if (profile.monthlySpendingLimit != null && profile.monthlySpendingLimit > 0) {
    const { from, to } = monthRange(monthKey(now));
    const spent = incomeExpense(data.operations, from, to, data.accounts).expense;
    limitRemaining = profile.monthlySpendingLimit - spent;
    if (limitRemaining < canSpend) {
      canSpend = limitRemaining;
      limitApplied = true;
    }
  }

  const inflows = pendingInflows(data, addDays(now, 1), periodEnd, now);
  let expectedIncome = inflows.reduce((s, i) => s + (i.amount ?? 0), 0);
  if (salaryKnown && profile.expectedSalary && !inflows.some((i) => i.date === periodEnd)) expectedIncome += profile.expectedSalary;

  const lines: SafeToSpendLine[] = [
    { label: 'Доступно на выбранных счетах', amount: available, hint: `${spendAccounts.length} сч.` },
    { label: 'Зарезервировано под цели', amount: -reservedGoals },
    { label: 'Неприкосновенный резерв', amount: -reserve },
    { label: 'Обязательные платежи до зарплаты', amount: -obligations, hint: `${obligationItems.length} шт.` },
  ];
  if (limitApplied && limitRemaining != null) lines.push({ label: 'Ограничено остатком месячного лимита', amount: limitRemaining });

  return {
    canSpend,
    daysLeft,
    dailyLimit: canSpend > 0 ? Math.floor(canSpend / daysLeft) : 0,
    periodEnd,
    salaryKnown,
    available,
    reservedGoals,
    reserve,
    obligations,
    obligationItems,
    limitRemaining,
    limitApplied,
    forecastAfterSalary: available - obligations + expectedIncome,
    expectedIncome,
    deficit: canSpend < 0,
    noAccounts: spendAccounts.length === 0,
    lines,
  };
}
