import type { Tiyn } from './money';
import type { ISODate, ISODateTime } from './dates';

export type ID = string;

export type AccountType = 'card' | 'current' | 'cash' | 'savings' | 'asset';

export interface Account {
  id: ID;
  name: string;
  type: AccountType;
  bankId: string | null;
  initialBalance: Tiyn;
  currency: string;
  createdAt: ISODate;
  isActive: boolean;
  /** Учитывать в расчёте «Можно потратить» */
  includeInSpending: boolean;
  note: string;
}

export type OperationType = 'income' | 'expense' | 'transfer' | 'adjustment';

export type OperationLink =
  | { kind: 'debt'; debtId: ID; paymentId: ID }
  | { kind: 'recurring'; recurringId: ID; occurrenceDate: ISODate }
  | { kind: 'event'; eventId: ID }
  | { kind: 'goal'; goalId: ID; contributionId: ID };

export interface Operation {
  id: ID;
  type: OperationType;
  /** > 0 для доходов/расходов/переводов; для корректировки — знаковая разница (≠ 0) */
  amount: Tiyn;
  date: ISODateTime;
  accountId: ID;
  toAccountId: ID | null;
  categoryId: ID | null;
  subcategoryId: ID | null;
  title: string;
  description: string;
  tags: string[];
  attachmentIds: ID[];
  isRecurring: boolean;
  link: OperationLink | null;
  createdAt: number;
  updatedAt: number;
}

export type CategoryKind = 'income' | 'expense';

export interface Category {
  id: ID;
  name: string;
  kind: CategoryKind;
  parentId: ID | null;
  color: string;
  /** Лимит расходов в месяц (только для корневых категорий расходов) */
  monthlyLimit: Tiyn | null;
  /** Обязательный расход (жильё, коммунальные, кредиты…) */
  essential: boolean;
  archived: boolean;
  order: number;
}

export type DebtKind = 'mortgage' | 'loan' | 'installment' | 'private';
export type ScheduleType = 'annuity' | 'differentiated' | 'none';

export interface Debt {
  id: ID;
  name: string;
  kind: DebtKind;
  creditor: string;
  /** Первоначальная сумма */
  principal: Tiyn;
  /** Остаток на момент внесения долга в Qarajat */
  balanceAtEntry: Tiyn;
  entryDate: ISODate;
  /** Годовая ставка в процентах, например 18.5 */
  annualRate: number;
  startDate: ISODate;
  endDate: ISODate | null;
  monthlyPayment: Tiyn;
  paymentDay: number;
  /** Дата первого платежа, учитываемого в Qarajat */
  firstDueDate: ISODate;
  scheduleType: ScheduleType;
  accountId: ID | null;
  attachmentIds: ID[];
  archived: boolean;
  note: string;
  createdAt: number;
}

export type EarlyMode = 'reduce_term' | 'reduce_payment';

export interface DebtPayment {
  id: ID;
  debtId: ID;
  date: ISODate;
  amount: Tiyn;
  principalPart: Tiyn;
  interestPart: Tiyn;
  kind: 'regular' | 'early';
  earlyMode: EarlyMode | null;
  /** Какой плановый платёж (дата по графику) закрывает регулярный платёж */
  scheduledFor: ISODate | null;
  operationId: ID | null;
  /** false — исторический платёж (до внесения долга), уже учтён в balanceAtEntry */
  affectsBalance: boolean;
  /** Ежемесячный платёж до досрочного погашения с уменьшением платежа (для отката) */
  prevMonthlyPayment: Tiyn | null;
  note: string;
  createdAt: number;
}

export interface Goal {
  id: ID;
  name: string;
  description: string;
  target: Tiyn;
  targetDate: ISODate | null;
  photoId: ID | null;
  accountId: ID | null;
  archived: boolean;
  createdAt: number;
}

export interface GoalContribution {
  id: ID;
  goalId: ID;
  date: ISODate;
  /** > 0 — пополнение, < 0 — снятие */
  amount: Tiyn;
  note: string;
  operationId: ID | null;
  createdAt: number;
}

export type Frequency = 'weekly' | 'monthly' | 'yearly';

export interface RecurringRule {
  id: ID;
  title: string;
  type: 'income' | 'expense';
  amount: Tiyn;
  accountId: ID | null;
  categoryId: ID | null;
  frequency: Frequency;
  startDate: ISODate;
  endDate: ISODate | null;
  essential: boolean;
  active: boolean;
  skippedDates: ISODate[];
  createdAt: number;
}

export interface CalendarEvent {
  id: ID;
  title: string;
  date: ISODate;
  type: 'expense' | 'income' | 'reminder';
  amount: Tiyn | null;
  accountId: ID | null;
  categoryId: ID | null;
  essential: boolean;
  note: string;
  status: 'planned' | 'done' | 'cancelled';
  operationId: ID | null;
  createdAt: number;
}

export interface Profile {
  firstName: string;
  lastName: string;
  displayName: string;
  birthDate: ISODate | null;
  avatarId: ID | null;
  currency: string;
  salaryDay: number | null;
  expectedSalary: Tiyn | null;
  /** Общий лимит расходов в месяц для Safe-to-Spend */
  monthlySpendingLimit: Tiyn | null;
  /** Неприкосновенный резерв, который не входит в «Можно потратить» */
  reserveAmount: Tiyn;
  /** За сколько дней напоминать о платежах */
  reminderDays: number;
  migrationHandled: boolean;
}

export interface Attachment {
  id: ID;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  createdAt: number;
}

export interface AppData {
  accounts: Account[];
  operations: Operation[];
  categories: Category[];
  debts: Debt[];
  debtPayments: DebtPayment[];
  goals: Goal[];
  goalContributions: GoalContribution[];
  recurring: RecurringRule[];
  events: CalendarEvent[];
  profile: Profile;
}

export type CollectionName = Exclude<keyof AppData, 'profile'>;

export type Change =
  | { op: 'put'; store: CollectionName; value: { id: ID } }
  | { op: 'delete'; store: CollectionName; id: ID }
  | { op: 'profile'; value: Profile }
  | { op: 'putAttachment'; value: Attachment }
  | { op: 'deleteAttachment'; id: ID };

export const COLLECTIONS: CollectionName[] = [
  'accounts',
  'operations',
  'categories',
  'debts',
  'debtPayments',
  'goals',
  'goalContributions',
  'recurring',
  'events',
];
