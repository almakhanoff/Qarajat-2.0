import type { Debt, DebtPayment } from './types';
import type { Tiyn } from './money';
import { addMonths, diffMonths, today, type ISODate } from './dates';

export function monthlyRate(annualRate: number): number {
  return annualRate / 100 / 12;
}

/** Аннуитетный платёж: P = B·r / (1 − (1+r)^−n). При r = 0 — B / n. Округление вверх до тиына. */
export function annuityPayment(balance: Tiyn, annualRate: number, months: number): Tiyn {
  if (balance <= 0) return 0;
  if (months <= 0) return balance;
  const r = monthlyRate(annualRate);
  if (r === 0) return Math.ceil(balance / months);
  const p = (balance * r) / (1 - Math.pow(1 + r, -months));
  return Math.ceil(p);
}

/** Проценты за один месяц на остаток. */
export function monthInterest(balance: Tiyn, annualRate: number): Tiyn {
  return Math.round(balance * monthlyRate(annualRate));
}

/** Текущий остаток = остаток при внесении − погашенное тело (только платежи после внесения). */
export function debtBalance(debt: Debt, payments: DebtPayment[]): Tiyn {
  let bal = debt.balanceAtEntry;
  for (const p of payments) if (p.debtId === debt.id && p.affectsBalance) bal -= p.principalPart;
  return Math.max(0, bal);
}

/** Остаток перед датой (для расчёта процентов нового платежа). */
export function debtBalanceBefore(debt: Debt, payments: DebtPayment[], date: ISODate, excludeId?: string): Tiyn {
  let bal = debt.balanceAtEntry;
  for (const p of payments) {
    if (p.debtId !== debt.id || !p.affectsBalance || p.id === excludeId) continue;
    if (p.date <= date) bal -= p.principalPart;
  }
  return Math.max(0, bal);
}

export function debtPayments(debt: Debt, payments: DebtPayment[]): DebtPayment[] {
  return payments
    .filter((p) => p.debtId === debt.id)
    .sort((a, b) => (a.date === b.date ? a.createdAt - b.createdAt : a.date.localeCompare(b.date)));
}

/** Разбивка платежа на проценты и тело. Досрочный платёж целиком идёт в тело долга. */
export function splitPayment(
  debt: Debt,
  balanceBefore: Tiyn,
  amount: Tiyn,
  kind: 'regular' | 'early',
): { principalPart: Tiyn; interestPart: Tiyn } {
  if (kind === 'early') {
    return { principalPart: Math.min(amount, balanceBefore), interestPart: 0 };
  }
  const interest = Math.min(monthInterest(balanceBefore, debt.annualRate), amount);
  return { principalPart: Math.min(amount - interest, balanceBefore), interestPart: interest };
}

/** Плановая дата k-го платежа (k = 0 — первый платёж в Qarajat). */
export function dueDate(debt: Debt, k: number): ISODate {
  return addMonths(debt.firstDueDate, k, debt.paymentDay);
}

/** Множество дат по графику, уже закрытых регулярными платежами. */
export function paidDueDates(debt: Debt, payments: DebtPayment[]): Set<ISODate> {
  const s = new Set<ISODate>();
  for (const p of payments) if (p.debtId === debt.id && p.kind === 'regular' && p.scheduledFor) s.add(p.scheduledFor);
  return s;
}

/** Ближайший неоплаченный плановый платёж (может быть в прошлом — просрочка). */
export function nextUnpaidDue(debt: Debt, payments: DebtPayment[]): ISODate | null {
  if (debtBalance(debt, payments) <= 0 || debt.archived) return null;
  if (debt.scheduleType === 'none' && debt.monthlyPayment <= 0) return null;
  const paid = paidDueDates(debt, payments);
  for (let k = 0; k < 1200; k++) {
    const d = dueDate(debt, k);
    if (!paid.has(d)) return d;
  }
  return null;
}

/** Просроченные плановые даты (до сегодняшнего дня, без регулярного платежа). */
export function overdueDues(debt: Debt, payments: DebtPayment[], now: ISODate = today()): ISODate[] {
  if (debtBalance(debt, payments) <= 0 || debt.archived) return [];
  if (debt.scheduleType === 'none' && debt.monthlyPayment <= 0) return [];
  const paid = paidDueDates(debt, payments);
  const out: ISODate[] = [];
  for (let k = 0; k < 1200; k++) {
    const d = dueDate(debt, k);
    if (d >= now) break;
    if (!paid.has(d)) out.push(d);
  }
  return out;
}

export interface ScheduleItem {
  date: ISODate;
  payment: Tiyn;
  principal: Tiyn;
  interest: Tiyn;
  balanceAfter: Tiyn;
}

export interface Schedule {
  items: ScheduleItem[];
  /** Платёж не покрывает проценты — долг никогда не будет погашен */
  neverRepaid: boolean;
  totalInterest: Tiyn;
  totalPayment: Tiyn;
  closingDate: ISODate | null;
}

/** Сколько плановых платежей осталось до даты окончания (включая платёж from). */
export function remainingMonths(debt: Debt, from: ISODate): number {
  if (!debt.endDate) return 0;
  return Math.max(1, diffMonths(from, debt.endDate) + 1);
}

/** Прогноз графика оставшихся платежей от текущего остатка. */
export function buildSchedule(debt: Debt, payments: DebtPayment[], maxItems = 600): Schedule {
  const items: ScheduleItem[] = [];
  let balance = debtBalance(debt, payments);
  const start = nextUnpaidDue(debt, payments);
  const empty: Schedule = { items, neverRepaid: false, totalInterest: 0, totalPayment: 0, closingDate: null };
  if (balance <= 0 || !start) return empty;

  const paid = paidDueDates(debt, payments);
  const dates: ISODate[] = [];
  for (let k = 0; dates.length < maxItems && k < maxItems * 2; k++) {
    const d = dueDate(debt, k);
    if (d >= start && !paid.has(d)) dates.push(d);
  }

  const n0 = debt.endDate ? remainingMonths(debt, start) : 0;
  const r = monthlyRate(debt.annualRate);
  let neverRepaid = false;

  for (let i = 0; i < dates.length && balance > 0; i++) {
    const interest = monthInterest(balance, debt.annualRate);
    let payment: Tiyn;
    if (debt.scheduleType === 'differentiated') {
      const left = Math.max(1, n0 - i);
      payment = Math.ceil(balance / left) + interest;
    } else if (debt.scheduleType === 'annuity') {
      payment = debt.monthlyPayment > 0 ? debt.monthlyPayment : annuityPayment(balance, debt.annualRate, Math.max(1, n0 - i));
    } else {
      payment = debt.monthlyPayment;
    }
    if (payment <= interest && r > 0) {
      neverRepaid = true;
      break;
    }
    if (payment <= 0) {
      neverRepaid = true;
      break;
    }
    const principal = Math.min(payment - interest, balance);
    const actualPayment = principal + interest;
    balance -= principal;
    items.push({ date: dates[i], payment: actualPayment, principal, interest, balanceAfter: balance });
  }
  if (balance > 0 && !neverRepaid) neverRepaid = true;
  const totalInterest = items.reduce((s, x) => s + x.interest, 0);
  const totalPayment = items.reduce((s, x) => s + x.payment, 0);
  return {
    items,
    neverRepaid,
    totalInterest,
    totalPayment,
    closingDate: !neverRepaid && items.length ? items[items.length - 1].date : null,
  };
}

/** Плановая сумма ближайшего платежа. */
export function plannedPaymentAmount(debt: Debt, payments: DebtPayment[]): Tiyn {
  const s = buildSchedule(debt, payments, 1);
  return s.items[0]?.payment ?? Math.min(debt.monthlyPayment, debtBalance(debt, payments));
}

export interface DebtSummary {
  balance: Tiyn;
  paidTotal: Tiyn;
  paidPrincipal: Tiyn;
  paidInterest: Tiyn;
  futureInterest: Tiyn;
  /** Переплата = уплаченные + прогнозные проценты */
  overpayment: Tiyn;
  closingDate: ISODate | null;
  neverRepaid: boolean;
  nextDue: ISODate | null;
  nextAmount: Tiyn;
  overdue: ISODate[];
  progress: number;
}

export function debtSummary(debt: Debt, payments: DebtPayment[], now: ISODate = today()): DebtSummary {
  const own = payments.filter((p) => p.debtId === debt.id);
  const balance = debtBalance(debt, own);
  const schedule = buildSchedule(debt, own);
  const paidPrincipal = own.reduce((s, p) => s + p.principalPart, 0);
  const paidInterest = own.reduce((s, p) => s + p.interestPart, 0);
  const base = Math.max(debt.principal, debt.balanceAtEntry);
  return {
    balance,
    paidTotal: paidPrincipal + paidInterest,
    paidPrincipal,
    paidInterest,
    futureInterest: schedule.totalInterest,
    overpayment: paidInterest + schedule.totalInterest,
    closingDate: balance <= 0 ? null : schedule.closingDate,
    neverRepaid: balance > 0 && schedule.neverRepaid,
    nextDue: nextUnpaidDue(debt, own),
    nextAmount: schedule.items[0]?.payment ?? 0,
    overdue: overdueDues(debt, own, now),
    progress: base > 0 ? Math.min(100, Math.max(0, ((base - balance) / base) * 100)) : 100,
  };
}

/** Новый ежемесячный платёж после досрочного погашения с уменьшением платежа. */
export function recalcPaymentAfterEarly(debt: Debt, newBalance: Tiyn, nextDue: ISODate): Tiyn {
  if (newBalance <= 0) return 0;
  if (debt.scheduleType !== 'annuity' || !debt.endDate) return debt.monthlyPayment;
  return annuityPayment(newBalance, debt.annualRate, remainingMonths(debt, nextDue));
}
