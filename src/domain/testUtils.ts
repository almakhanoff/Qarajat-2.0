import type { Account, AppData, Debt, Operation } from './types';
import { defaultCategories, defaultProfile } from './defaults';
import { emptyData } from './commands';
import { newId } from './ids';

export function makeData(): AppData {
  return emptyData({ ...defaultProfile(), migrationHandled: true }, defaultCategories());
}

export function account(p: Partial<Account> = {}): Account {
  return {
    id: newId(), name: 'Kaspi Gold ' + Math.random().toString(36).slice(2, 6), type: 'card', bankId: 'kaspi', initialBalance: 0,
    currency: 'KZT', createdAt: '2026-01-01', isActive: true, includeInSpending: true, note: '', ...p,
  };
}

export function catId(data: AppData, name: string): string {
  const c = data.categories.find((x) => x.name === name && !x.parentId);
  if (!c) throw new Error('no category ' + name);
  return c.id;
}

export function operation(p: Partial<Operation> & Pick<Operation, 'type' | 'amount' | 'accountId'>): Operation {
  return {
    id: newId(), date: '2026-10-01T10:00', toAccountId: null, categoryId: null, subcategoryId: null, title: '', description: '',
    tags: [], attachmentIds: [], isRecurring: false, link: null, createdAt: Date.now(), updatedAt: Date.now(), ...p,
  };
}

export function debt(p: Partial<Debt> = {}): Debt {
  return {
    id: newId(), name: 'Кредит', kind: 'loan', creditor: 'Halyk', principal: 1_200_000_00, balanceAtEntry: 1_200_000_00,
    entryDate: '2026-01-01', annualRate: 12, startDate: '2026-01-01', endDate: '2027-01-01', monthlyPayment: 0, paymentDay: 15,
    firstDueDate: '2026-01-15', scheduleType: 'annuity', accountId: null, attachmentIds: [], archived: false, note: '', createdAt: Date.now(), ...p,
  };
}
