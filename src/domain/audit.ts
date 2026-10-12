import type { AppData, Category, Operation } from './types';
import type { Tiyn } from './money';
import { formatMoney } from './money';
import { dateOf, daysInMonth, monthRange, shiftMonth, type MonthKey } from './dates';
import { isBaseCurrency } from './balances';
import { debtBalance, debtSummary } from './debts';

export interface CategoryStat {
  categoryId: string | null;
  name: string;
  color: string;
  amount: Tiyn;
  share: number;
  prevAmount: Tiyn;
  avgPrev3: Tiyn;
  essential: boolean;
  limit: Tiyn | null;
  overLimit: boolean;
}

export interface RecurringExpense {
  title: string;
  monthlyAmount: Tiyn;
  source: 'rule' | 'detected';
  months: number;
}

export interface Insight {
  level: 'good' | 'warn' | 'bad' | 'info';
  title: string;
  text: string;
}

export interface Saving {
  name: string;
  current: Tiyn;
  baseline: Tiyn;
  potential: Tiyn;
  reason: string;
}

export interface AuditResult {
  month: MonthKey;
  income: Tiyn;
  expense: Tiyn;
  prevExpense: Tiyn;
  prevIncome: Tiyn;
  expenseChangePct: number | null;
  byCategory: CategoryStat[];
  top: CategoryStat | null;
  daily: { day: number; amount: Tiyn }[];
  months: { key: MonthKey; income: Tiyn; expense: Tiyn }[];
  topExpenses: Operation[];
  essential: Tiyn;
  nonEssential: Tiyn;
  recurring: RecurringExpense[];
  obligations: Tiyn;
  obligationsShare: number | null;
  leftAfterObligations: Tiyn | null;
  overLimit: CategoryStat[];
  savings: Saving[];
  insights: Insight[];
  hasData: boolean;
  hasHistory: boolean;
}

function rootCategory(cat: Category | undefined, byId: Map<string, Category>): Category | undefined {
  let c = cat;
  let guard = 0;
  while (c && c.parentId && guard++ < 10) c = byId.get(c.parentId);
  return c;
}

function normalizeTitle(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function monthExpenses(ops: Operation[], key: MonthKey, baseIds: Set<string>): Operation[] {
  const { from, to } = monthRange(key);
  return ops.filter((o) => o.type === 'expense' && baseIds.has(o.accountId) && dateOf(o.date) >= from && dateOf(o.date) <= to);
}

function monthIncome(ops: Operation[], key: MonthKey, baseIds: Set<string>): Tiyn {
  const { from, to } = monthRange(key);
  return ops
    .filter((o) => o.type === 'income' && baseIds.has(o.accountId) && dateOf(o.date) >= from && dateOf(o.date) <= to)
    .reduce((s, o) => s + o.amount, 0);
}

function byRoot(ops: Operation[], byId: Map<string, Category>): Map<string | null, Tiyn> {
  const m = new Map<string | null, Tiyn>();
  for (const o of ops) {
    const root = rootCategory(o.categoryId ? byId.get(o.categoryId) : undefined, byId);
    const key = root?.id ?? null;
    m.set(key, (m.get(key) ?? 0) + o.amount);
  }
  return m;
}

export function runAudit(data: AppData, month: MonthKey): AuditResult {
  const baseIds = new Set(data.accounts.filter((a) => isBaseCurrency(a)).map((a) => a.id));
  const byId = new Map(data.categories.map((c) => [c.id, c]));
  const ops = data.operations;

  const cur = monthExpenses(ops, month, baseIds);
  const prevKey = shiftMonth(month, -1);
  const prev = monthExpenses(ops, prevKey, baseIds);
  const income = monthIncome(ops, month, baseIds);
  const prevIncome = monthIncome(ops, prevKey, baseIds);
  const expense = cur.reduce((s, o) => s + o.amount, 0);
  const prevExpense = prev.reduce((s, o) => s + o.amount, 0);

  const prev3Keys = [1, 2, 3].map((n) => shiftMonth(month, -n));
  const prev3Maps = prev3Keys.map((k) => byRoot(monthExpenses(ops, k, baseIds), byId));
  const monthsWithData = prev3Keys.filter((k) => monthExpenses(ops, k, baseIds).length > 0).length;

  const curMap = byRoot(cur, byId);
  const prevMap = byRoot(prev, byId);
  const byCategory: CategoryStat[] = [...curMap.entries()]
    .map(([id, amount]) => {
      const cat = id ? byId.get(id) : undefined;
      const prevSum = prev3Maps.reduce((s, m) => s + (m.get(id) ?? 0), 0);
      const limit = cat?.monthlyLimit ?? null;
      return {
        categoryId: id,
        name: cat?.name ?? 'Без категории',
        color: cat?.color ?? '#A0AAB7',
        amount,
        share: expense > 0 ? (amount / expense) * 100 : 0,
        prevAmount: prevMap.get(id) ?? 0,
        avgPrev3: monthsWithData > 0 ? Math.round(prevSum / monthsWithData) : 0,
        essential: cat?.essential ?? false,
        limit,
        overLimit: limit != null && limit > 0 && amount > limit,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  // Категории с лимитом без расходов тоже показываем в лимитах — но превышения нет
  const [y, m] = month.split('-').map(Number);
  const dim = daysInMonth(y, m - 1);
  const daily = Array.from({ length: dim }, (_, i) => ({ day: i + 1, amount: 0 }));
  for (const o of cur) daily[Number(dateOf(o.date).slice(8, 10)) - 1].amount += o.amount;

  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5)).map((key) => ({
    key,
    income: monthIncome(ops, key, baseIds),
    expense: monthExpenses(ops, key, baseIds).reduce((s, o) => s + o.amount, 0),
  }));

  const topExpenses = [...cur].sort((a, b) => b.amount - a.amount).slice(0, 5);
  const essential = byCategory.filter((c) => c.essential).reduce((s, c) => s + c.amount, 0);
  const nonEssential = expense - essential;

  // Повторяющиеся расходы: регулярные правила + совпадающие названия в ≥2 из последних 3 месяцев
  const recurring: RecurringExpense[] = [];
  const factor = { weekly: 52 / 12, monthly: 1, yearly: 1 / 12 } as const;
  for (const r of data.recurring) {
    if (r.type !== 'expense' || !r.active) continue;
    recurring.push({ title: r.title, monthlyAmount: Math.round(r.amount * factor[r.frequency]), source: 'rule', months: 0 });
  }
  const ruleTitles = new Set(recurring.map((r) => normalizeTitle(r.title)));
  const windowKeys = [month, shiftMonth(month, -1), shiftMonth(month, -2)];
  const seen = new Map<string, { title: string; months: Set<string>; total: Tiyn; count: number }>();
  for (const k of windowKeys) {
    for (const o of monthExpenses(ops, k, baseIds)) {
      if (o.link?.kind === 'recurring' || o.link?.kind === 'debt') continue;
      const t = normalizeTitle(o.title);
      if (!t || ruleTitles.has(t)) continue;
      const e = seen.get(t) ?? { title: o.title.trim(), months: new Set<string>(), total: 0, count: 0 };
      e.months.add(k);
      e.total += o.amount;
      e.count++;
      seen.set(t, e);
    }
  }
  for (const e of seen.values()) {
    if (e.months.size >= 2) recurring.push({ title: e.title, monthlyAmount: Math.round(e.total / e.months.size), source: 'detected', months: e.months.size });
  }
  recurring.sort((a, b) => b.monthlyAmount - a.monthlyAmount);

  // Обязательства в месяц: платежи по долгам + обязательные регулярные расходы
  let obligations = 0;
  for (const d of data.debts) {
    if (d.archived || debtBalance(d, data.debtPayments) <= 0) continue;
    const s = debtSummary(d, data.debtPayments);
    obligations += s.nextAmount || d.monthlyPayment;
  }
  for (const r of data.recurring) {
    if (r.type === 'expense' && r.active && r.essential) obligations += Math.round(r.amount * factor[r.frequency]);
  }
  const obligationsShare = income > 0 ? (obligations / income) * 100 : null;
  const leftAfterObligations = income > 0 ? income - obligations : null;

  const overLimit = byCategory.filter((c) => c.overLimit);

  const savings: Saving[] = [];
  if (monthsWithData > 0) {
    for (const c of byCategory) {
      if (c.essential || c.avgPrev3 <= 0) continue;
      if (c.amount > c.avgPrev3 * 1.2 && c.amount - c.avgPrev3 >= 100_00) {
        savings.push({
          name: c.name,
          current: c.amount,
          baseline: c.avgPrev3,
          potential: c.amount - c.avgPrev3,
          reason: `В этом месяце ${formatMoney(c.amount)} при среднем ${formatMoney(c.avgPrev3)} за прошлые месяцы`,
        });
      }
    }
  }
  for (const c of overLimit) {
    if (savings.some((s) => s.name === c.name)) continue;
    savings.push({
      name: c.name,
      current: c.amount,
      baseline: c.limit!,
      potential: c.amount - c.limit!,
      reason: `Превышен лимит ${formatMoney(c.limit!)} на ${formatMoney(c.amount - c.limit!)}`,
    });
  }
  savings.sort((a, b) => b.potential - a.potential);

  const insights: Insight[] = [];
  const hasData = cur.length > 0 || income > 0;
  const hasHistory = monthsWithData > 0;
  const top = byCategory[0] ?? null;
  const expenseChangePct = prevExpense > 0 ? ((expense - prevExpense) / prevExpense) * 100 : null;

  if (hasData) {
    if (top && expense > 0) {
      insights.push({
        level: top.share >= 40 ? 'warn' : 'info',
        title: 'Крупнейшая категория',
        text: `«${top.name}» — ${formatMoney(top.amount)}, это ${top.share.toFixed(0)}% всех расходов месяца.`,
      });
    }
    if (expenseChangePct != null) {
      const up = expenseChangePct > 0;
      insights.push({
        level: up && expenseChangePct > 15 ? 'warn' : up ? 'info' : 'good',
        title: 'Сравнение с прошлым месяцем',
        text: `Расходы ${up ? 'выросли' : 'снизились'} на ${Math.abs(expenseChangePct).toFixed(0)}% (${formatMoney(expense - prevExpense, { sign: true })}).`,
      });
    }
    if (income > 0) {
      const rate = ((income - expense) / income) * 100;
      insights.push({
        level: rate < 0 ? 'bad' : rate < 10 ? 'warn' : 'good',
        title: 'Баланс месяца',
        text:
          rate < 0
            ? `Расходы превышают доходы на ${formatMoney(expense - income)}.`
            : `Отложено или не потрачено ${rate.toFixed(0)}% дохода (${formatMoney(income - expense)}).`,
      });
    }
    if (obligationsShare != null && obligations > 0) {
      insights.push({
        level: obligationsShare > 50 ? 'bad' : obligationsShare > 30 ? 'warn' : 'good',
        title: 'Нагрузка обязательств',
        text: `Обязательные платежи — ${obligationsShare.toFixed(0)}% дохода. После них остаётся ${formatMoney(leftAfterObligations!)}.`,
      });
    }
    for (const c of overLimit) {
      insights.push({ level: 'bad', title: 'Превышен лимит', text: `«${c.name}»: ${formatMoney(c.amount)} при лимите ${formatMoney(c.limit!)}.` });
    }
    if (expense > 0 && nonEssential / expense > 0.5) {
      insights.push({
        level: 'warn',
        title: 'Необязательные расходы',
        text: `${((nonEssential / expense) * 100).toFixed(0)}% расходов — необязательные (${formatMoney(nonEssential)}).`,
      });
    }
  }

  return {
    month,
    income,
    expense,
    prevExpense,
    prevIncome,
    expenseChangePct,
    byCategory,
    top,
    daily,
    months,
    topExpenses,
    essential,
    nonEssential,
    recurring,
    obligations,
    obligationsShare,
    leftAfterObligations,
    overLimit,
    savings,
    insights,
    hasData,
    hasHistory,
  };
}

export function currentMonth(now: Date = new Date()): MonthKey {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
