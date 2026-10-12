import type {
  Account,
  AppData,
  CalendarEvent,
  Category,
  CollectionName,
  Change,
  Debt,
  DebtPayment,
  EarlyMode,
  Goal,
  GoalContribution,
  ID,
  Operation,
  Profile,
  RecurringRule,
} from './types';
import { COLLECTIONS } from './types';
import type { Tiyn } from './money';
import { formatMoney, isValidTiyn } from './money';
import { dateOf, isISODate, isISODateTime, nextDayOfMonth, today, type ISODate } from './dates';
import { newId } from './ids';
import { debtBalance, debtBalanceBefore, nextUnpaidDue, paidDueDates, recalcPaymentAfterEarly, splitPayment } from './debts';
import { goalSaved } from './goals';
import { occurrenceOperation, occurrences } from './recurring';
import { DEBT_CATEGORY_NAME } from './defaults';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function fail(msg: string): never {
  throw new ValidationError(msg);
}

const MAX_AMOUNT: Tiyn = 1_000_000_000_000_00; // 1 трлн ₸

function requirePositive(v: Tiyn, field = 'Сумма') {
  if (!isValidTiyn(v)) fail(`${field}: некорректное значение`);
  if (v <= 0) fail(`${field} должна быть больше нуля`);
  if (v > MAX_AMOUNT) fail(`${field} слишком большая`);
}

function requireNonNegative(v: Tiyn, field: string) {
  if (!isValidTiyn(v)) fail(`${field}: некорректное значение`);
  if (v < 0) fail(`${field} не может быть отрицательной`);
  if (v > MAX_AMOUNT) fail(`${field} слишком большая`);
}

function requireText(v: string, field: string, max = 120) {
  if (!v || !v.trim()) fail(`Заполните поле «${field}»`);
  if (v.length > max) fail(`«${field}»: не более ${max} символов`);
}

function optionalText(v: string, field: string, max = 2000) {
  if (v && v.length > max) fail(`«${field}»: не более ${max} символов`);
}

function requireDate(v: string | null, field: string) {
  if (!v || !isISODate(v)) fail(`«${field}»: укажите корректную дату`);
}

const put = <T extends { id: ID }>(store: CollectionName, value: T): Change => ({ op: 'put', store, value });
const del = (store: CollectionName, id: ID): Change => ({ op: 'delete', store, id });

/* ========================== Применение изменений ========================== */

export function applyChanges(data: AppData, changes: Change[]): AppData {
  const next: AppData = { ...data };
  const touched = new Set<string>();
  for (const ch of changes) {
    if (ch.op === 'profile') {
      next.profile = ch.value;
      continue;
    }
    if (ch.op === 'putAttachment' || ch.op === 'deleteAttachment') continue;
    if (!touched.has(ch.store)) {
      (next as unknown as Record<string, unknown[]>)[ch.store] = [...(data[ch.store] as unknown[])];
      touched.add(ch.store);
    }
    const arr = next[ch.store] as unknown as { id: ID }[];
    if (ch.op === 'put') {
      const idx = arr.findIndex((x) => x.id === ch.value.id);
      if (idx >= 0) arr[idx] = ch.value;
      else arr.push(ch.value);
    } else {
      const idx = arr.findIndex((x) => x.id === ch.id);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }
  return next;
}

export function emptyData(profile: Profile, categories: Category[] = []): AppData {
  const d = Object.fromEntries(COLLECTIONS.map((c) => [c, []])) as unknown as AppData;
  d.profile = profile;
  d.categories = categories;
  return d;
}

/* ================================ Счета ================================== */

export function saveAccount(data: AppData, acc: Account): Change[] {
  requireText(acc.name, 'Название', 60);
  if (!isValidTiyn(acc.initialBalance)) fail('Начальный баланс: некорректное значение');
  if (Math.abs(acc.initialBalance) > MAX_AMOUNT) fail('Начальный баланс слишком большой');
  requireDate(acc.createdAt, 'Дата создания');
  if (!acc.currency) fail('Укажите валюту');
  if (data.accounts.some((a) => a.id !== acc.id && a.name.trim().toLowerCase() === acc.name.trim().toLowerCase()))
    fail('Счёт с таким названием уже есть');
  return [put('accounts', { ...acc, name: acc.name.trim() })];
}

export function deleteAccount(data: AppData, id: ID): Change[] {
  const used = data.operations.filter((o) => o.accountId === id || o.toAccountId === id).length;
  if (used > 0) fail(`По счёту есть операции (${used}). Сделайте счёт неактивным или сначала удалите операции.`);
  const ch: Change[] = [del('accounts', id)];
  for (const g of data.goals) if (g.accountId === id) ch.push(put('goals', { ...g, accountId: null }));
  for (const d of data.debts) if (d.accountId === id) ch.push(put('debts', { ...d, accountId: null }));
  for (const r of data.recurring) if (r.accountId === id) ch.push(put('recurring', { ...r, accountId: null }));
  for (const e of data.events) if (e.accountId === id) ch.push(put('events', { ...e, accountId: null }));
  return ch;
}

/* ============================== Операции ================================= */

export function validateOperation(data: AppData, op: Operation, now: ISODate) {
  if (!['income', 'expense', 'transfer', 'adjustment'].includes(op.type)) fail('Неизвестный тип операции');
  if (op.type === 'adjustment') {
    if (!isValidTiyn(op.amount) || op.amount === 0) fail('Корректировка должна изменять баланс');
    if (Math.abs(op.amount) > MAX_AMOUNT) fail('Сумма слишком большая');
  } else requirePositive(op.amount);
  if (!isISODateTime(op.date)) fail('Укажите корректные дату и время');
  if (dateOf(op.date) > now) fail('Дата операции не может быть в будущем. Будущие платежи добавляйте в календарь.');
  if (!data.accounts.some((a) => a.id === op.accountId)) fail('Выберите счёт');
  if (op.type === 'transfer') {
    if (!op.toAccountId || !data.accounts.some((a) => a.id === op.toAccountId)) fail('Выберите счёт зачисления');
    if (op.toAccountId === op.accountId) fail('Нельзя перевести на тот же счёт');
    const from = data.accounts.find((a) => a.id === op.accountId)!;
    const to = data.accounts.find((a) => a.id === op.toAccountId)!;
    if (from.currency !== to.currency) fail('Перевод между счетами в разных валютах пока не поддерживается');
  }
  if (op.type === 'income' || op.type === 'expense') {
    const cat = data.categories.find((c) => c.id === op.categoryId);
    if (!cat) fail('Выберите категорию');
    if (cat.kind !== op.type) fail('Категория не соответствует типу операции');
    if (cat.parentId) fail('Выберите основную категорию');
    if (op.subcategoryId) {
      const sub = data.categories.find((c) => c.id === op.subcategoryId);
      if (!sub || sub.parentId !== cat.id) fail('Подкатегория не относится к выбранной категории');
    }
  }
  optionalText(op.title, 'Название', 120);
  optionalText(op.description, 'Описание', 2000);
  if (op.tags.length > 20) fail('Не более 20 тегов');
  if (op.tags.some((t) => t.length > 40)) fail('Тег: не более 40 символов');
  if (op.attachmentIds.length > 10) fail('Не более 10 вложений');
}

export function saveOperation(data: AppData, input: Operation, now: ISODate = today()): Change[] {
  const op: Operation = {
    ...input,
    title: input.title.trim(),
    description: input.description.trim(),
    tags: [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))],
    toAccountId: input.type === 'transfer' ? input.toAccountId : null,
    categoryId: input.type === 'income' || input.type === 'expense' ? input.categoryId : null,
    subcategoryId: input.type === 'income' || input.type === 'expense' ? input.subcategoryId : null,
    updatedAt: Date.now(),
  };
  validateOperation(data, op, now);
  const changes: Change[] = [put('operations', op)];
  const prev = data.operations.find((o) => o.id === op.id);
  const link = prev?.link ?? op.link;

  if (prev && link?.kind === 'debt') {
    if (op.type !== 'expense') fail('Платёж по долгу должен оставаться расходом. Удалите платёж в разделе «Долги».');
    const payment = data.debtPayments.find((p) => p.id === link.paymentId);
    const debt = payment && data.debts.find((d) => d.id === payment.debtId);
    if (payment && debt) {
      const before = debtBalanceBefore(debt, data.debtPayments, dateOf(op.date), payment.id);
      const maxAllowed = before + (payment.kind === 'regular' ? payment.interestPart : 0);
      if (op.amount > Math.max(maxAllowed, payment.amount)) fail(`Сумма превышает остаток долга (${formatMoney(before)})`);
      const split = splitPayment(debt, before, op.amount, payment.kind);
      changes.push(put('debtPayments', { ...payment, amount: op.amount, date: dateOf(op.date), ...split }));
    }
  }
  if (prev && link?.kind === 'goal') {
    const contrib = data.goalContributions.find((c) => c.id === link.contributionId);
    if (contrib) {
      if (op.type !== 'transfer') fail('Пополнение цели должно оставаться переводом. Удалите его в разделе «Цели».');
      const sign = contrib.amount < 0 ? -1 : 1;
      changes.push(put('goalContributions', { ...contrib, amount: sign * op.amount, date: dateOf(op.date) }));
    }
  }
  return changes;
}

export function deleteOperation(data: AppData, id: ID): Change[] {
  const op = data.operations.find((o) => o.id === id);
  if (!op) return [];
  const changes: Change[] = [del('operations', id)];
  for (const att of op.attachmentIds) changes.push({ op: 'deleteAttachment', id: att });
  if (op.link?.kind === 'debt') {
    const link = op.link;
    const payment = data.debtPayments.find((p) => p.id === link.paymentId);
    if (payment) changes.push(...removeDebtPaymentChanges(data, payment));
  }
  if (op.link?.kind === 'goal') changes.push(del('goalContributions', op.link.contributionId));
  if (op.link?.kind === 'event') {
    const link = op.link;
    const ev = data.events.find((e) => e.id === link.eventId);
    if (ev) changes.push(put('events', { ...ev, status: 'planned', operationId: null }));
  }
  return changes;
}

/* ============================== Категории ================================ */

export function saveCategory(data: AppData, cat: Category): Change[] {
  requireText(cat.name, 'Название', 40);
  if (cat.monthlyLimit != null) requireNonNegative(cat.monthlyLimit, 'Лимит');
  if (cat.parentId) {
    const parent = data.categories.find((c) => c.id === cat.parentId);
    if (!parent) fail('Родительская категория не найдена');
    if (parent.parentId) fail('Допускается только один уровень подкатегорий');
    if (parent.kind !== cat.kind) fail('Подкатегория должна быть того же типа');
  }
  const dup = data.categories.some(
    (c) => c.id !== cat.id && c.kind === cat.kind && c.parentId === cat.parentId && c.name.trim().toLowerCase() === cat.name.trim().toLowerCase(),
  );
  if (dup) fail('Категория с таким названием уже есть');
  const changes: Change[] = [put('categories', { ...cat, name: cat.name.trim() })];
  // Наследование признака «обязательный» подкатегориями
  if (!cat.parentId) {
    for (const sub of data.categories) if (sub.parentId === cat.id && sub.essential !== cat.essential) changes.push(put('categories', { ...sub, essential: cat.essential, color: cat.color }));
  }
  return changes;
}

export function deleteCategory(data: AppData, id: ID): Change[] {
  const ids = new Set([id, ...data.categories.filter((c) => c.parentId === id).map((c) => c.id)]);
  const used = data.operations.filter((o) => (o.categoryId && ids.has(o.categoryId)) || (o.subcategoryId && ids.has(o.subcategoryId))).length;
  if (used > 0) fail(`Категория используется в ${used} операциях. Скройте её (архив) вместо удаления.`);
  const changes: Change[] = [...ids].map((x) => del('categories', x));
  for (const r of data.recurring) if (r.categoryId && ids.has(r.categoryId)) changes.push(put('recurring', { ...r, categoryId: null }));
  for (const e of data.events) if (e.categoryId && ids.has(e.categoryId)) changes.push(put('events', { ...e, categoryId: null }));
  return changes;
}

export function debtCategoryId(data: AppData): ID | null {
  return (
    data.categories.find((c) => c.kind === 'expense' && !c.parentId && c.name === DEBT_CATEGORY_NAME)?.id ??
    data.categories.find((c) => c.kind === 'expense' && !c.parentId && c.essential)?.id ??
    data.categories.find((c) => c.kind === 'expense' && !c.parentId)?.id ??
    null
  );
}

/* ================================ Долги ================================== */

export function saveDebt(data: AppData, debt: Debt): Change[] {
  requireText(debt.name, 'Название', 80);
  optionalText(debt.creditor, 'Кредитор', 80);
  requirePositive(debt.principal, 'Первоначальная сумма');
  requireNonNegative(debt.balanceAtEntry, 'Текущий остаток');
  if (debt.balanceAtEntry > debt.principal * 3) fail('Текущий остаток подозрительно превышает первоначальную сумму');
  if (!(debt.annualRate >= 0 && debt.annualRate <= 200)) fail('Ставка должна быть от 0 до 200%');
  requireDate(debt.startDate, 'Дата начала');
  requireDate(debt.entryDate, 'Дата внесения');
  if (debt.endDate) {
    requireDate(debt.endDate, 'Дата завершения');
    if (debt.endDate <= debt.startDate) fail('Дата завершения должна быть позже даты начала');
  }
  requireNonNegative(debt.monthlyPayment, 'Ежемесячный платёж');
  if (!Number.isInteger(debt.paymentDay) || debt.paymentDay < 1 || debt.paymentDay > 31) fail('День платежа — от 1 до 31');
  requireDate(debt.firstDueDate, 'Дата первого платежа');
  if (debt.scheduleType === 'differentiated' && !debt.endDate) fail('Для дифференцированного графика укажите дату завершения');
  if (debt.scheduleType === 'annuity' && debt.monthlyPayment <= 0 && !debt.endDate)
    fail('Для аннуитетного графика укажите ежемесячный платёж или дату завершения');
  if (debt.accountId && !data.accounts.some((a) => a.id === debt.accountId)) fail('Счёт списания не найден');
  const prev = data.debts.find((d) => d.id === debt.id);
  if (prev && prev.balanceAtEntry !== debt.balanceAtEntry && data.debtPayments.some((p) => p.debtId === debt.id && p.affectsBalance)) {
    // Допустимо: пользователь исправляет исходный остаток. Итог пересчитается из истории.
  }
  return [put('debts', { ...debt, name: debt.name.trim(), creditor: debt.creditor.trim() })];
}

export function deleteDebt(data: AppData, id: ID): Change[] {
  const changes: Change[] = [del('debts', id)];
  const debt = data.debts.find((d) => d.id === id);
  for (const att of debt?.attachmentIds ?? []) changes.push({ op: 'deleteAttachment', id: att });
  for (const p of data.debtPayments.filter((x) => x.debtId === id)) {
    changes.push(del('debtPayments', p.id));
    // Деньги реально были потрачены — операции сохраняем, но отвязываем
    const op = p.operationId && data.operations.find((o) => o.id === p.operationId);
    if (op) changes.push(put('operations', { ...op, link: null, updatedAt: Date.now() }));
  }
  return changes;
}

export interface DebtPaymentInput {
  debtId: ID;
  date: ISODate;
  amount: Tiyn;
  kind: 'regular' | 'early';
  earlyMode?: EarlyMode;
  /** Счёт списания: если указан — создаётся операция-расход */
  accountId: ID | null;
  /** Для подтверждения конкретного планового платежа из календаря */
  scheduledFor?: ISODate;
  /** Ручная сумма процентов (как в выписке банка) */
  interestOverride?: Tiyn | null;
  note?: string;
  historical?: boolean;
}

export function addDebtPayment(data: AppData, input: DebtPaymentInput, now: ISODate = today()): Change[] {
  const debt = data.debts.find((d) => d.id === input.debtId);
  if (!debt) fail('Долг не найден');
  requirePositive(input.amount);
  requireDate(input.date, 'Дата');
  if (input.date > now) fail('Платёж нельзя провести будущей датой. Плановые платежи видны в календаре.');
  const historical = !!input.historical;
  const balanceBefore = historical ? debt.balanceAtEntry : debtBalanceBefore(debt, data.debtPayments, input.date);
  const currentBalance = debtBalance(debt, data.debtPayments);
  if (!historical && currentBalance <= 0) fail('Долг уже погашен');

  let scheduledFor: ISODate | null = null;
  if (input.kind === 'regular' && !historical) {
    scheduledFor = input.scheduledFor ?? nextUnpaidDue(debt, data.debtPayments);
    if (scheduledFor && paidDueDates(debt, data.debtPayments).has(scheduledFor))
      fail('Этот плановый платёж уже подтверждён. Повторное списание невозможно.');
  }

  let split = splitPayment(debt, balanceBefore, input.amount, input.kind);
  if (input.interestOverride != null) {
    requireNonNegative(input.interestOverride, 'Проценты');
    if (input.interestOverride > input.amount) fail('Проценты не могут превышать сумму платежа');
    split = { interestPart: input.interestOverride, principalPart: Math.min(input.amount - input.interestOverride, balanceBefore) };
  }
  if (!historical && split.principalPart + split.interestPart < input.amount) {
    fail(`Сумма превышает остаток долга. Максимум: ${formatMoney(balanceBefore + split.interestPart)}`);
  }
  if (input.kind === 'early' && input.earlyMode == null) fail('Выберите, что уменьшить: срок или платёж');

  const paymentId = newId();
  const changes: Change[] = [];
  let operationId: ID | null = null;
  if (input.accountId && !historical) {
    if (!data.accounts.some((a) => a.id === input.accountId)) fail('Счёт списания не найден');
    operationId = newId();
    const catId = debtCategoryId(data);
    const op: Operation = {
      id: operationId,
      type: 'expense',
      amount: input.amount,
      date: `${input.date}T12:00`,
      accountId: input.accountId,
      toAccountId: null,
      categoryId: catId,
      subcategoryId: null,
      title: `${input.kind === 'early' ? 'Досрочное погашение' : 'Платёж'}: ${debt.name}`,
      description: input.note ?? '',
      tags: [],
      attachmentIds: [],
      isRecurring: input.kind === 'regular',
      link: { kind: 'debt', debtId: debt.id, paymentId },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (catId) validateOperation(data, op, now);
    changes.push(put('operations', op));
  }

  const payment: DebtPayment = {
    id: paymentId,
    debtId: debt.id,
    date: input.date,
    amount: input.amount,
    principalPart: split.principalPart,
    interestPart: split.interestPart,
    kind: input.kind,
    earlyMode: input.kind === 'early' ? input.earlyMode ?? 'reduce_term' : null,
    scheduledFor,
    operationId,
    affectsBalance: !historical,
    prevMonthlyPayment: null,
    note: input.note ?? '',
    createdAt: Date.now(),
  };

  if (input.kind === 'early' && input.earlyMode === 'reduce_payment' && !historical) {
    const newBalance = currentBalance - split.principalPart;
    const nextDue = nextUnpaidDue(debt, data.debtPayments) ?? nextDayOfMonth(now, debt.paymentDay);
    const newPayment = recalcPaymentAfterEarly(debt, newBalance, nextDue);
    if (newPayment !== debt.monthlyPayment) {
      payment.prevMonthlyPayment = debt.monthlyPayment;
      changes.push(put('debts', { ...debt, monthlyPayment: newPayment }));
    }
  }
  changes.push(put('debtPayments', payment));
  return changes;
}

function removeDebtPaymentChanges(data: AppData, payment: DebtPayment): Change[] {
  const changes: Change[] = [del('debtPayments', payment.id)];
  if (payment.prevMonthlyPayment != null) {
    const debt = data.debts.find((d) => d.id === payment.debtId);
    if (debt) changes.push(put('debts', { ...debt, monthlyPayment: payment.prevMonthlyPayment }));
  }
  return changes;
}

export function deleteDebtPayment(data: AppData, paymentId: ID): Change[] {
  const payment = data.debtPayments.find((p) => p.id === paymentId);
  if (!payment) return [];
  const changes = removeDebtPaymentChanges(data, payment);
  if (payment.operationId) changes.push(del('operations', payment.operationId));
  return changes;
}

/* ================================ Цели =================================== */

export function saveGoal(data: AppData, goal: Goal, initialSaved: Tiyn = 0, now: ISODate = today()): Change[] {
  requireText(goal.name, 'Название', 80);
  optionalText(goal.description, 'Описание', 1000);
  requirePositive(goal.target, 'Целевая сумма');
  if (goal.targetDate) requireDate(goal.targetDate, 'Дата достижения');
  if (goal.accountId && !data.accounts.some((a) => a.id === goal.accountId)) fail('Счёт не найден');
  requireNonNegative(initialSaved, 'Уже накоплено');
  const changes: Change[] = [put('goals', { ...goal, name: goal.name.trim() })];
  const isNew = !data.goals.some((g) => g.id === goal.id);
  if (isNew && initialSaved > 0) {
    const c: GoalContribution = { id: newId(), goalId: goal.id, date: now, amount: initialSaved, note: 'Начальная сумма', operationId: null, createdAt: Date.now() };
    changes.push(put('goalContributions', c));
  }
  return changes;
}

export function deleteGoal(data: AppData, id: ID): Change[] {
  const goal = data.goals.find((g) => g.id === id);
  const changes: Change[] = [del('goals', id)];
  if (goal?.photoId) changes.push({ op: 'deleteAttachment', id: goal.photoId });
  for (const c of data.goalContributions.filter((x) => x.goalId === id)) {
    changes.push(del('goalContributions', c.id));
    const op = c.operationId && data.operations.find((o) => o.id === c.operationId);
    if (op) changes.push(put('operations', { ...op, link: null, updatedAt: Date.now() }));
  }
  return changes;
}

export interface ContributionInput {
  goalId: ID;
  amount: Tiyn;
  direction: 'deposit' | 'withdraw';
  date: ISODate;
  note: string;
  /** Для пополнения — счёт-источник, для снятия — счёт зачисления. Если задан и отличается от счёта цели, создаётся перевод. */
  otherAccountId: ID | null;
}

export function addGoalContribution(data: AppData, input: ContributionInput, now: ISODate = today()): Change[] {
  const goal = data.goals.find((g) => g.id === input.goalId);
  if (!goal) fail('Цель не найдена');
  requirePositive(input.amount);
  requireDate(input.date, 'Дата');
  if (input.date > now) fail('Дата не может быть в будущем');
  const saved = goalSaved(goal, data.goalContributions);
  if (input.direction === 'withdraw' && input.amount > saved) fail(`Нельзя снять больше накопленного (${formatMoney(saved)})`);
  const contribution: GoalContribution = {
    id: newId(),
    goalId: goal.id,
    date: input.date,
    amount: input.direction === 'deposit' ? input.amount : -input.amount,
    note: input.note.trim(),
    operationId: null,
    createdAt: Date.now(),
  };
  const changes: Change[] = [];
  if (input.otherAccountId && goal.accountId && input.otherAccountId !== goal.accountId) {
    const from = input.direction === 'deposit' ? input.otherAccountId : goal.accountId;
    const to = input.direction === 'deposit' ? goal.accountId : input.otherAccountId;
    const op: Operation = {
      id: newId(),
      type: 'transfer',
      amount: input.amount,
      date: `${input.date}T12:00`,
      accountId: from,
      toAccountId: to,
      categoryId: null,
      subcategoryId: null,
      title: `${input.direction === 'deposit' ? 'Пополнение цели' : 'Снятие с цели'}: ${goal.name}`,
      description: input.note.trim(),
      tags: [],
      attachmentIds: [],
      isRecurring: false,
      link: { kind: 'goal', goalId: goal.id, contributionId: contribution.id },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    validateOperation(data, op, now);
    contribution.operationId = op.id;
    changes.push(put('operations', op));
  }
  changes.push(put('goalContributions', contribution));
  return changes;
}

export function deleteGoalContribution(data: AppData, id: ID): Change[] {
  const c = data.goalContributions.find((x) => x.id === id);
  if (!c) return [];
  const goal = data.goals.find((g) => g.id === c.goalId);
  if (goal && c.amount > 0) {
    const savedAfter = goalSaved(goal, data.goalContributions) - c.amount;
    if (savedAfter < 0) fail('После удаления накопленная сумма станет отрицательной. Сначала удалите снятие.');
  }
  const changes: Change[] = [del('goalContributions', id)];
  if (c.operationId) changes.push(del('operations', c.operationId));
  return changes;
}

/* ======================== Регулярные платежи ============================= */

export function saveRecurring(data: AppData, rule: RecurringRule): Change[] {
  requireText(rule.title, 'Название', 80);
  requirePositive(rule.amount);
  requireDate(rule.startDate, 'Дата первого платежа');
  if (rule.endDate) {
    requireDate(rule.endDate, 'Дата окончания');
    if (rule.endDate < rule.startDate) fail('Дата окончания раньше даты начала');
  }
  if (rule.accountId && !data.accounts.some((a) => a.id === rule.accountId)) fail('Счёт не найден');
  if (rule.categoryId) {
    const cat = data.categories.find((c) => c.id === rule.categoryId);
    if (!cat || cat.kind !== rule.type) fail('Категория не соответствует типу');
  }
  return [put('recurring', { ...rule, title: rule.title.trim() })];
}

export function deleteRecurring(data: AppData, id: ID): Change[] {
  const changes: Change[] = [del('recurring', id)];
  for (const op of data.operations) {
    if (op.link?.kind === 'recurring' && op.link.recurringId === id) changes.push(put('operations', { ...op, link: null, updatedAt: Date.now() }));
  }
  return changes;
}

export interface ConfirmInput {
  amount: Tiyn;
  accountId: ID;
  date: ISODate;
}

export function confirmOccurrence(data: AppData, ruleId: ID, occurrenceDate: ISODate, input: ConfirmInput, now: ISODate = today()): Change[] {
  const rule = data.recurring.find((r) => r.id === ruleId);
  if (!rule) fail('Регулярный платёж не найден');
  if (!occurrences(rule, occurrenceDate, occurrenceDate).length) fail('На эту дату платёж не запланирован');
  if (occurrenceOperation(data.operations, ruleId, occurrenceDate)) fail('Этот платёж уже подтверждён. Повторное списание невозможно.');
  if (!rule.categoryId) fail('Укажите категорию в настройках регулярного платежа');
  const op: Operation = {
    id: newId(),
    type: rule.type,
    amount: input.amount,
    date: `${input.date}T12:00`,
    accountId: input.accountId,
    toAccountId: null,
    categoryId: rule.categoryId,
    subcategoryId: null,
    title: rule.title,
    description: '',
    tags: [],
    attachmentIds: [],
    isRecurring: true,
    link: { kind: 'recurring', recurringId: rule.id, occurrenceDate },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  validateOperation(data, op, now);
  const changes: Change[] = [put('operations', op)];
  if (rule.skippedDates.includes(occurrenceDate)) changes.push(put('recurring', { ...rule, skippedDates: rule.skippedDates.filter((d) => d !== occurrenceDate) }));
  return changes;
}

export function skipOccurrence(data: AppData, ruleId: ID, date: ISODate, skip: boolean): Change[] {
  const rule = data.recurring.find((r) => r.id === ruleId);
  if (!rule) fail('Регулярный платёж не найден');
  const set = new Set(rule.skippedDates);
  if (skip) set.add(date);
  else set.delete(date);
  return [put('recurring', { ...rule, skippedDates: [...set].sort() })];
}

/* =============================== События ================================= */

export function saveEvent(data: AppData, ev: CalendarEvent): Change[] {
  requireText(ev.title, 'Название', 80);
  requireDate(ev.date, 'Дата');
  if (ev.type !== 'reminder') {
    if (ev.amount == null) fail('Укажите сумму');
    requirePositive(ev.amount);
  }
  if (ev.accountId && !data.accounts.some((a) => a.id === ev.accountId)) fail('Счёт не найден');
  if (ev.categoryId) {
    const cat = data.categories.find((c) => c.id === ev.categoryId);
    if (!cat || (ev.type !== 'reminder' && cat.kind !== ev.type)) fail('Категория не соответствует типу');
  }
  optionalText(ev.note, 'Заметка', 1000);
  return [put('events', { ...ev, title: ev.title.trim() })];
}

export function deleteEvent(data: AppData, id: ID): Change[] {
  const changes: Change[] = [del('events', id)];
  for (const op of data.operations) {
    if (op.link?.kind === 'event' && op.link.eventId === id) changes.push(put('operations', { ...op, link: null, updatedAt: Date.now() }));
  }
  return changes;
}

export function confirmEvent(data: AppData, eventId: ID, input: ConfirmInput | null, now: ISODate = today()): Change[] {
  const ev = data.events.find((e) => e.id === eventId);
  if (!ev) fail('Событие не найдено');
  if (ev.status === 'done' && ev.operationId && data.operations.some((o) => o.id === ev.operationId))
    fail('Событие уже подтверждено. Повторное списание невозможно.');
  if (ev.type === 'reminder' || !input) return [put('events', { ...ev, status: 'done' })];
  if (!ev.categoryId) fail('Укажите категорию события');
  const op: Operation = {
    id: newId(),
    type: ev.type,
    amount: input.amount,
    date: `${input.date}T12:00`,
    accountId: input.accountId,
    toAccountId: null,
    categoryId: ev.categoryId,
    subcategoryId: null,
    title: ev.title,
    description: ev.note,
    tags: [],
    attachmentIds: [],
    isRecurring: false,
    link: { kind: 'event', eventId: ev.id },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  validateOperation(data, op, now);
  return [put('operations', op), put('events', { ...ev, status: 'done', operationId: op.id })];
}

/* =============================== Профиль ================================= */

export function saveProfile(profile: Profile): Change[] {
  optionalText(profile.firstName, 'Имя', 60);
  optionalText(profile.lastName, 'Фамилия', 60);
  optionalText(profile.displayName, 'Отображаемое имя', 60);
  if (profile.birthDate) {
    requireDate(profile.birthDate, 'Дата рождения');
    if (profile.birthDate > today()) fail('Дата рождения не может быть в будущем');
  }
  if (profile.salaryDay != null && (!Number.isInteger(profile.salaryDay) || profile.salaryDay < 1 || profile.salaryDay > 31))
    fail('День зарплаты — от 1 до 31');
  if (profile.expectedSalary != null) requireNonNegative(profile.expectedSalary, 'Ожидаемая зарплата');
  if (profile.monthlySpendingLimit != null) requireNonNegative(profile.monthlySpendingLimit, 'Лимит расходов');
  requireNonNegative(profile.reserveAmount, 'Резерв');
  return [{ op: 'profile', value: profile }];
}
