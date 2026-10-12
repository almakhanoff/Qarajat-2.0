import type { AppData, Operation, RecurringRule } from './types';
import { addDays, addMonths, parseDate, toISODate, type ISODate } from './dates';

/** Даты наступления регулярного платежа в диапазоне [from, to]. */
export function occurrences(rule: RecurringRule, from: ISODate, to: ISODate, limit = 400): ISODate[] {
  const out: ISODate[] = [];
  const day = parseDate(rule.startDate).getDate();
  for (let k = 0; k < 5000 && out.length < limit; k++) {
    let d: ISODate;
    if (rule.frequency === 'weekly') d = addDays(rule.startDate, 7 * k);
    else if (rule.frequency === 'monthly') d = addMonths(rule.startDate, k, day);
    else d = addMonths(rule.startDate, 12 * k, day);
    if (d > to) break;
    if (rule.endDate && d > rule.endDate) break;
    if (d >= from) out.push(d);
  }
  return out;
}

export function occurrenceOperation(ops: Operation[], ruleId: string, date: ISODate): Operation | undefined {
  return ops.find((o) => o.link?.kind === 'recurring' && o.link.recurringId === ruleId && o.link.occurrenceDate === date);
}

export type OccurrenceStatus = 'paid' | 'skipped' | 'planned' | 'overdue';

export interface Occurrence {
  rule: RecurringRule;
  date: ISODate;
  status: OccurrenceStatus;
  operationId: string | null;
}

export function ruleOccurrences(data: Pick<AppData, 'recurring' | 'operations'>, from: ISODate, to: ISODate, now: ISODate): Occurrence[] {
  const out: Occurrence[] = [];
  for (const rule of data.recurring) {
    // Платежи до создания правила не считаются просроченными
    const createdDate = toISODate(new Date(rule.createdAt));
    for (const date of occurrences(rule, from, to)) {
      const op = occurrenceOperation(data.operations, rule.id, date);
      let status: OccurrenceStatus;
      if (op) status = 'paid';
      else if (date < now && date < createdDate) continue;
      else if (rule.skippedDates.includes(date)) status = 'skipped';
      else if (!rule.active) continue;
      else status = date < now ? 'overdue' : 'planned';
      out.push({ rule, date, status, operationId: op?.id ?? null });
    }
  }
  return out;
}
