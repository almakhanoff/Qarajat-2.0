import type { Account, AccountType, AppData, Attachment, CalendarEvent, Category, Change, Debt, DebtKind, DebtPayment, Goal, GoalContribution, Operation, RecurringRule } from '../domain/types';
import { tengeToTiyn } from '../domain/money';
import { isISODate, today } from '../domain/dates';
import { newId } from '../domain/ids';
import { CATEGORY_COLORS } from '../domain/defaults';

export const V1_KEY = 'qarajat_v9';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const money = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) ? tengeToTiyn(Math.abs(n)) : 0;
};
const date = (v: unknown): string | null => {
  const s = str(v, 30).slice(0, 10);
  return isISODate(s) ? s : null;
};

export interface MigrationResult {
  changes: Change[];
  summary: { accounts: number; operations: number; plannedEvents: number; debts: number; goals: number; recurring: number; avatar: boolean };
  warnings: string[];
}

export function readV1(storage: Storage = localStorage): unknown | null {
  try {
    const raw = storage.getItem(V1_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isObj(parsed) && Array.isArray(parsed.accounts) ? parsed : null;
  } catch {
    return null;
  }
}

function dataUrlToBlob(url: string): Blob | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m) return null;
  const bin = atob(m[2]);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: m[1] });
}

/** Преобразует данные Qarajat 1.0 в изменения для базы 2.0. Исходные данные v1 не изменяются. */
export function migrateV1(raw: unknown, data: AppData, now: string = today()): MigrationResult {
  if (!isObj(raw)) throw new Error('Данные Qarajat 1.0 не распознаны');
  const changes: Change[] = [];
  const warnings: string[] = [];
  const categories = [...data.categories];
  const catByName = (name: string, kind: 'income' | 'expense'): string | null => {
    const n = name.trim();
    if (!n) return null;
    const found = categories.find((c) => c.kind === kind && c.name.toLowerCase() === n.toLowerCase());
    if (found) return found.parentId ?? found.id;
    const cat: Category = { id: newId(), name: n.slice(0, 60), kind, parentId: null, color: CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length], monthlyLimit: null, essential: false, archived: false, order: categories.length };
    categories.push(cat);
    changes.push({ op: 'put', store: 'categories', value: cat });
    return cat.id;
  };
  const fallbackCat = (kind: 'income' | 'expense') => catByName('Другое', kind);

  // Счета
  const accMap = new Map<string, string>();
  const accounts: Account[] = [];
  for (const a of arr(raw.accounts)) {
    const kind = str(a.kind);
    const v1type = str(a.type);
    if (v1type === 'credit' || v1type === 'installment') {
      warnings.push(`Счёт «${str(a.name)}» был кредитным — перенесён как «Другой актив», проверьте его.`);
    }
    const type: AccountType = kind === 'savings' || v1type === 'deposit' ? 'savings' : kind === 'investment' ? 'asset' : v1type === 'current' ? (str(a.bankId) === 'other' ? 'cash' : 'current') : v1type === 'card' ? 'card' : 'asset';
    const acc: Account = {
      id: newId(), name: str(a.name, 60) || 'Счёт', type, bankId: str(a.bankId, 30) || null, initialBalance: typeof a.initial === 'number' && a.initial < 0 ? -money(a.initial) : money(a.initial),
      currency: str(a.currency, 5) || 'KZT', createdAt: '2000-01-01', isActive: str(a.status) !== 'archived', includeInSpending: kind === 'available' || kind === '', note: 'Перенесено из Qarajat 1.0',
    };
    accMap.set(str(a.id), acc.id);
    accounts.push(acc);
    changes.push({ op: 'put', store: 'accounts', value: acc });
  }
  const firstAcc = accounts[0]?.id ?? null;
  const acc = (id: unknown) => accMap.get(str(id)) ?? null;

  // Операции
  let opCount = 0;
  let planned = 0;
  let earliest = now;
  for (const o of arr(raw.operations)) {
    const status = str(o.status) || 'done';
    if (status === 'cancel') continue;
    const d = date(o.date);
    const accountId = acc(o.accountId);
    const amount = money(o.amount);
    if (!d || !accountId || amount <= 0) {
      warnings.push(`Пропущена некорректная операция от ${str(o.date) || '—'} на сумму ${str(String(o.amount ?? ''))}`);
      continue;
    }
    const v1type = str(o.type);
    const type = v1type === 'adjust' ? 'adjustment' : v1type === 'income' || v1type === 'transfer' || v1type === 'expense' ? v1type : null;
    if (!type) continue;
    const comment = str(o.comment, 500);
    const catName = str(o.category, 60);
    if (status === 'plan' || d > now) {
      if (type === 'income' || type === 'expense') {
        const ev: CalendarEvent = { id: newId(), title: catName || comment || 'Плановая операция', date: d, type, amount, accountId, categoryId: catByName(catName, type) ?? fallbackCat(type), essential: false, note: comment, status: 'planned', operationId: null, createdAt: Date.now() };
        changes.push({ op: 'put', store: 'events', value: ev });
        planned++;
      }
      continue;
    }
    const toAccountId = type === 'transfer' ? acc(o.toAccountId) : null;
    if (type === 'transfer' && (!toAccountId || toAccountId === accountId)) {
      warnings.push(`Пропущен перевод от ${d}: счёт получателя не найден`);
      continue;
    }
    let signed = amount;
    if (type === 'adjustment' && typeof o.amount === 'number' && o.amount < 0) signed = -amount;
    if (type === 'adjustment' && (str(o.direction) === 'minus' || str(o.sign) === '-')) signed = -amount;
    const op: Operation = {
      id: newId(), type, amount: signed, date: `${d}T12:00`, accountId, toAccountId,
      categoryId: type === 'income' || type === 'expense' ? (catByName(catName, type) ?? fallbackCat(type)) : null, subcategoryId: null,
      title: catName && type !== 'transfer' ? '' : comment.slice(0, 80), description: comment, tags: [], attachmentIds: [], isRecurring: false, link: null, createdAt: Date.now(), updatedAt: Date.now(),
    };
    if (d < earliest) earliest = d;
    changes.push({ op: 'put', store: 'operations', value: op });
    opCount++;
  }
  for (const a of accounts) a.createdAt = earliest;

  // Долги: остаток v1 становится остатком на дату миграции; прошлые платежи уже есть как операции.
  let debtCount = 0;
  const kindMap: Record<string, DebtKind> = { Ипотека: 'mortgage', Кредит: 'loan', Рассрочка: 'installment' };
  for (const d of arr(raw.debts)) {
    if (str(d.status) === 'closed') continue;
    const balance = money(d.balance);
    if (balance <= 0) continue;
    const payDay = Math.min(31, Math.max(1, Math.trunc(Number(d.payDay) || 1)));
    const end = date(d.endDate);
    const rate = Math.min(100, Math.max(0, Number(d.rate) || 0));
    const debt: Debt = {
      id: newId(), name: str(d.name, 80) || 'Долг', kind: kindMap[str(d.type)] ?? 'private', creditor: '', principal: Math.max(money(d.initial), balance), balanceAtEntry: balance, entryDate: now,
      annualRate: rate, startDate: date(d.startDate) ?? now, endDate: end && end > now ? end : null, monthlyPayment: money(d.minPayment), paymentDay: payDay,
      firstDueDate: nextDue(now, payDay), scheduleType: rate > 0 ? 'annuity' : 'none', accountId: acc(d.accountId), attachmentIds: [], archived: false, note: 'Перенесено из Qarajat 1.0', createdAt: Date.now(),
    };
    changes.push({ op: 'put', store: 'debts', value: debt });
    for (const p of arr(d.payments)) {
      const pd = date(p.date);
      if (!pd) continue;
      const payment: DebtPayment = { id: newId(), debtId: debt.id, date: pd, amount: money(p.amount), principalPart: money(p.body), interestPart: money(p.interest), kind: 'regular', earlyMode: null, scheduledFor: null, operationId: null, affectsBalance: false, prevMonthlyPayment: null, note: 'История из Qarajat 1.0', createdAt: Date.now() };
      changes.push({ op: 'put', store: 'debtPayments', value: payment });
    }
    debtCount++;
  }

  // Цели
  let goalCount = 0;
  for (const g of arr(raw.goals)) {
    const target = money(g.target);
    if (target <= 0) continue;
    const goal: Goal = { id: newId(), name: (str(g.name, 80) || 'Цель'), description: '', target, targetDate: date(g.date), photoId: null, accountId: acc(g.accountId), archived: false, createdAt: Date.now() };
    changes.push({ op: 'put', store: 'goals', value: goal });
    const saved = money(g.saved);
    if (saved > 0) {
      const c: GoalContribution = { id: newId(), goalId: goal.id, date: now, amount: saved, note: 'Перенесено из Qarajat 1.0', operationId: null, createdAt: Date.now() };
      changes.push({ op: 'put', store: 'goalContributions', value: c });
    }
    goalCount++;
  }

  // Регулярные платежи
  let recCount = 0;
  for (const r of arr(raw.recurring)) {
    const amount = money(r.amount);
    const type = str(r.type) === 'income' ? 'income' : 'expense';
    if (amount <= 0) continue;
    const interval = str(r.interval);
    const rule: RecurringRule = {
      id: newId(), title: str(r.name, 80) || 'Регулярный платёж', type, amount, accountId: acc(r.accountId) ?? firstAcc, categoryId: catByName(str(r.category, 60), type) ?? fallbackCat(type),
      frequency: interval === 'weekly' ? 'weekly' : interval === 'yearly' ? 'yearly' : 'monthly', startDate: date(r.nextDate) ?? now, endDate: null, essential: type === 'expense',
      active: str(r.status) !== 'paused' && str(r.status) !== 'inactive', skippedDates: [], createdAt: Date.now(),
    };
    changes.push({ op: 'put', store: 'recurring', value: rule });
    recCount++;
  }

  // Профиль
  const p = isObj(raw.profile) ? raw.profile : {};
  const s = isObj(raw.settings) ? raw.settings : {};
  const profile = { ...data.profile, migrationHandled: true };
  const name = str(p.name, 60);
  if (name && name !== 'Пользователь') profile.displayName = name;
  const bd = date(p.birthDate);
  if (bd) profile.birthDate = bd;
  const sd = Number(s.salaryDay);
  if (Number.isInteger(sd) && sd >= 1 && sd <= 31) profile.salaryDay = sd;
  if (money(s.expectedIncome) > 0) profile.expectedSalary = money(s.expectedIncome);
  if (money(s.minReserve) > 0) profile.reserveAmount = money(s.minReserve);
  let avatar = false;
  if (typeof p.avatar === 'string') {
    const blob = dataUrlToBlob(p.avatar);
    if (blob) {
      const att: Attachment = { id: newId(), name: 'avatar', type: blob.type, size: blob.size, blob, createdAt: Date.now() };
      changes.push({ op: 'putAttachment', value: att });
      profile.avatarId = att.id;
      avatar = true;
    }
  }
  changes.push({ op: 'profile', value: profile });

  return { changes, warnings, summary: { accounts: accounts.length, operations: opCount, plannedEvents: planned, debts: debtCount, goals: goalCount, recurring: recCount, avatar } };
}

function nextDue(from: string, day: number): string {
  const [y, m] = from.split('-').map(Number);
  const make = (yy: number, mm: number) => {
    const last = new Date(yy, mm, 0).getDate();
    return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
  };
  const cur = make(y, m);
  if (cur > from) return cur;
  return m === 12 ? make(y + 1, 1) : make(y, m + 1);
}
