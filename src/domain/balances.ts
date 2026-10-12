import type { Account, AppData, Operation } from './types';
import type { Tiyn } from './money';
import type { ISODate } from './dates';

/** Влияние операции на баланс конкретного счёта. */
export function operationEffect(op: Operation, accountId: string): Tiyn {
  switch (op.type) {
    case 'income':
      return op.accountId === accountId ? op.amount : 0;
    case 'expense':
      return op.accountId === accountId ? -op.amount : 0;
    case 'transfer': {
      let e = 0;
      if (op.accountId === accountId) e -= op.amount;
      if (op.toAccountId === accountId) e += op.amount;
      return e;
    }
    case 'adjustment':
      return op.accountId === accountId ? op.amount : 0;
  }
}

/** Баланс = начальный баланс + история операций (до даты включительно, если указана). */
export function accountBalance(account: Account, operations: Operation[], upTo?: ISODate): Tiyn {
  let bal = account.initialBalance;
  for (const op of operations) {
    if (upTo && op.date.slice(0, 10) > upTo) continue;
    bal += operationEffect(op, account.id);
  }
  return bal;
}

export function balancesMap(data: Pick<AppData, 'accounts' | 'operations'>, upTo?: ISODate): Map<string, Tiyn> {
  const map = new Map<string, Tiyn>();
  for (const a of data.accounts) map.set(a.id, a.initialBalance);
  for (const op of data.operations) {
    if (upTo && op.date.slice(0, 10) > upTo) continue;
    if (op.type === 'transfer') {
      if (map.has(op.accountId)) map.set(op.accountId, map.get(op.accountId)! - op.amount);
      if (op.toAccountId && map.has(op.toAccountId)) map.set(op.toAccountId, map.get(op.toAccountId)! + op.amount);
    } else if (map.has(op.accountId)) {
      const delta = op.type === 'expense' ? -op.amount : op.amount;
      map.set(op.accountId, map.get(op.accountId)! + delta);
    }
  }
  return map;
}

/** Счета в базовой валюте (KZT) — только они входят в общие суммы. */
export function isBaseCurrency(a: Account, base = 'KZT'): boolean {
  return a.currency === base;
}

/** Общий баланс счетов: активные счета в ₸ (без «других активов»). */
export function totalAccountsBalance(data: Pick<AppData, 'accounts' | 'operations'>, upTo?: ISODate): Tiyn {
  const map = balancesMap(data, upTo);
  let s = 0;
  for (const a of data.accounts) {
    if (!isBaseCurrency(a) || a.type === 'asset') continue;
    if (!a.isActive && (map.get(a.id) ?? 0) === 0) continue;
    s += map.get(a.id) ?? 0;
  }
  return s;
}

/** Все активы в ₸: счета + другие активы. */
export function totalAssets(data: Pick<AppData, 'accounts' | 'operations'>, upTo?: ISODate): Tiyn {
  const map = balancesMap(data, upTo);
  let s = 0;
  for (const a of data.accounts) if (isBaseCurrency(a)) s += map.get(a.id) ?? 0;
  return s;
}

/** Операция участвует в доходах/расходах (переводы и корректировки — нет). */
export function isIncomeOrExpense(op: Operation): op is Operation & { type: 'income' | 'expense' } {
  return op.type === 'income' || op.type === 'expense';
}

export function inRange(op: Operation, from: ISODate, to: ISODate): boolean {
  const d = op.date.slice(0, 10);
  return d >= from && d <= to;
}

export function incomeExpense(ops: Operation[], from: ISODate, to: ISODate, accounts?: Account[]) {
  const baseIds = accounts ? new Set(accounts.filter((a) => isBaseCurrency(a)).map((a) => a.id)) : null;
  let income = 0;
  let expense = 0;
  for (const op of ops) {
    if (!inRange(op, from, to)) continue;
    if (baseIds && !baseIds.has(op.accountId)) continue;
    if (op.type === 'income') income += op.amount;
    else if (op.type === 'expense') expense += op.amount;
  }
  return { income, expense, net: income - expense };
}
