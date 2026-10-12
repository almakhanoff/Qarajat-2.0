import type { AppData, ID } from './types';
import type { Tiyn } from './money';
import { dateOf, type ISODate } from './dates';
import { ruleOccurrences } from './recurring';
import { buildSchedule, debtBalance } from './debts';

export type CalendarItemKind = 'operation' | 'recurring' | 'debt' | 'event';
export type CalendarItemStatus = 'done' | 'planned' | 'overdue' | 'skipped';

export interface CalendarItem {
  id: string;
  date: ISODate;
  kind: CalendarItemKind;
  title: string;
  amount: Tiyn | null;
  direction: 'in' | 'out' | 'neutral';
  status: CalendarItemStatus;
  essential: boolean;
  operationId: ID | null;
  ruleId?: ID;
  debtId?: ID;
  eventId?: ID;
  accountId: ID | null;
}

/**
 * Все события календаря в диапазоне. Плановые элементы не влияют на балансы —
 * баланс меняется только после подтверждения (создания операции).
 */
export function calendarItems(data: AppData, from: ISODate, to: ISODate, now: ISODate): CalendarItem[] {
  const items: CalendarItem[] = [];
  const catName = new Map(data.categories.map((c) => [c.id, c.name]));

  for (const op of data.operations) {
    const d = dateOf(op.date);
    if (d < from || d > to) continue;
    items.push({
      id: `op-${op.id}`,
      date: d,
      kind: 'operation',
      title: op.title || (op.categoryId ? catName.get(op.categoryId) : null) || (op.type === 'transfer' ? 'Перевод' : op.type === 'adjustment' ? 'Корректировка' : 'Операция'),
      amount: op.type === 'adjustment' ? Math.abs(op.amount) : op.amount,
      direction: op.type === 'income' ? 'in' : op.type === 'expense' ? 'out' : op.type === 'adjustment' ? (op.amount > 0 ? 'in' : 'out') : 'neutral',
      status: 'done',
      essential: false,
      operationId: op.id,
      accountId: op.accountId,
    });
  }

  for (const occ of ruleOccurrences(data, from, to, now)) {
    if (occ.status === 'paid') continue; // уже отображена как операция
    items.push({
      id: `rec-${occ.rule.id}-${occ.date}`,
      date: occ.date,
      kind: 'recurring',
      title: occ.rule.title,
      amount: occ.rule.amount,
      direction: occ.rule.type === 'income' ? 'in' : 'out',
      status: occ.status === 'skipped' ? 'skipped' : occ.status,
      essential: occ.rule.essential,
      operationId: occ.operationId,
      ruleId: occ.rule.id,
      accountId: occ.rule.accountId,
    });
  }

  for (const debt of data.debts) {
    if (debt.archived || debtBalance(debt, data.debtPayments) <= 0) continue;
    const schedule = buildSchedule(debt, data.debtPayments, 400);
    for (const it of schedule.items) {
      if (it.date > to) break;
      if (it.date < from) continue;
      items.push({
        id: `debt-${debt.id}-${it.date}`,
        date: it.date,
        kind: 'debt',
        title: debt.name,
        amount: it.payment,
        direction: 'out',
        status: it.date < now ? 'overdue' : 'planned',
        essential: true,
        operationId: null,
        debtId: debt.id,
        accountId: debt.accountId,
      });
    }
  }

  for (const ev of data.events) {
    if (ev.date < from || ev.date > to) continue;
    if (ev.status === 'done' && ev.operationId && data.operations.some((o) => o.id === ev.operationId)) continue;
    items.push({
      id: `ev-${ev.id}`,
      date: ev.date,
      kind: 'event',
      title: ev.title,
      amount: ev.amount,
      direction: ev.type === 'income' ? 'in' : ev.type === 'expense' ? 'out' : 'neutral',
      status: ev.status === 'cancelled' ? 'skipped' : ev.status === 'done' ? 'done' : ev.date < now ? 'overdue' : 'planned',
      essential: ev.essential,
      operationId: ev.operationId,
      eventId: ev.id,
      accountId: ev.accountId,
    });
  }

  const order: Record<CalendarItemStatus, number> = { overdue: 0, planned: 1, done: 2, skipped: 3 };
  return items.sort((a, b) => a.date.localeCompare(b.date) || order[a.status] - order[b.status]);
}

/** Неоплаченные обязательства (расходы): плановые в [from, to] + все просроченные начиная с overdueFrom. */
export function pendingOutflows(data: AppData, from: ISODate, to: ISODate, now: ISODate, overdueFrom: ISODate): CalendarItem[] {
  return calendarItems(data, overdueFrom < from ? overdueFrom : from, to, now).filter(
    (i) =>
      i.direction === 'out' &&
      i.amount != null &&
      i.kind !== 'operation' &&
      ((i.status === 'planned' && i.date >= from) || i.status === 'overdue'),
  );
}

export function pendingInflows(data: AppData, from: ISODate, to: ISODate, now: ISODate): CalendarItem[] {
  return calendarItems(data, from, to, now).filter(
    (i) => i.direction === 'in' && i.amount != null && i.kind !== 'operation' && i.status === 'planned',
  );
}
