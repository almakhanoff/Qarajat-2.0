import type { AccountType, Category, DebtKind, Profile, ScheduleType } from './types';
import { newId } from './ids';

export const KZ_BANKS = [
  { id: 'kaspi', name: 'Kaspi Bank', color: '#e4002b' },
  { id: 'halyk', name: 'Halyk Bank', color: '#00693e' },
  { id: 'forte', name: 'ForteBank', color: '#a4135d' },
  { id: 'jusan', name: 'Jusan Bank', color: '#f37021' },
  { id: 'freedom', name: 'Freedom Bank', color: '#4fb14f' },
  { id: 'bcc', name: 'Bank CenterCredit', color: '#f5a800' },
  { id: 'bereke', name: 'Bereke Bank', color: '#00a651' },
  { id: 'homecredit', name: 'Home Credit Bank', color: '#e30613' },
  { id: 'altyn', name: 'Altyn Bank', color: '#b78e2f' },
  { id: 'rbk', name: 'RBK Bank', color: '#1a3c8c' },
  { id: 'nurbank', name: 'Nurbank', color: '#00448c' },
  { id: 'eurasian', name: 'Eurasian Bank', color: '#d81e05' },
  { id: 'vtb', name: 'Банк ВТБ (Казахстан)', color: '#0033a0' },
  { id: 'citi', name: 'Citibank Kazakhstan', color: '#0a5c9c' },
  { id: 'bock', name: 'Bank of China Kazakhstan', color: '#8b0000' },
  { id: 'alhilal', name: 'Al Hilal Bank', color: '#0b6b3a' },
  { id: 'shinhan', name: 'Shinhan Bank Kazakhstan', color: '#0046ff' },
  { id: 'otbasy', name: 'Отбасы банк', color: '#00a0e3' },
  { id: 'kzi', name: 'KZI Bank', color: '#2c5aa0' },
  { id: 'other', name: 'Другой банк', color: '#7a8796' },
] as const;

export function bankById(id: string | null | undefined) {
  return KZ_BANKS.find((b) => b.id === id) ?? null;
}

export const ACCOUNT_TYPES: Record<AccountType, string> = {
  card: 'Банковская карта',
  current: 'Текущий счёт',
  cash: 'Наличные',
  savings: 'Сберегательный счёт',
  asset: 'Другой актив',
};

export const DEBT_KINDS: Record<DebtKind, string> = {
  mortgage: 'Ипотека',
  loan: 'Кредит',
  installment: 'Рассрочка',
  private: 'Частный долг',
};

export const SCHEDULE_TYPES: Record<ScheduleType, string> = {
  annuity: 'Аннуитетный',
  differentiated: 'Дифференцированный',
  none: 'Без графика',
};

export const CURRENCIES = ['KZT', 'USD', 'EUR', 'RUB'] as const;

export const CATEGORY_COLORS = [
  '#29C58D', '#4C8DF6', '#F2B84B', '#E5646E', '#9B7BEA', '#3CC5D6', '#F08A4B', '#7FCB5B', '#E07BC4', '#A0AAB7',
];

export const DEBT_CATEGORY_NAME = 'Кредиты и долги';

type Seed = [name: string, essential: boolean, subs?: string[]];

const INCOME: Seed[] = [
  ['Зарплата', false], ['Премия', false], ['Подработка', false], ['Бизнес', false],
  ['Проценты и инвестиции', false], ['Подарки', false], ['Возвраты', false], ['Продажа вещей', false], ['Другое', false],
];

const EXPENSE: Seed[] = [
  ['Продукты', true, ['Супермаркет', 'Рынок']],
  ['Жильё', true, ['Аренда', 'Ремонт']],
  ['Коммунальные услуги', true, ['Электричество', 'Вода', 'Газ', 'Отопление']],
  ['Транспорт', true, ['Такси', 'Топливо', 'Общественный транспорт', 'Обслуживание авто']],
  ['Связь и интернет', true],
  ['Здоровье', true, ['Аптека', 'Врачи']],
  ['Образование', true],
  [DEBT_CATEGORY_NAME, true],
  ['Кафе и рестораны', false, ['Доставка еды', 'Кофе']],
  ['Одежда и обувь', false],
  ['Развлечения', false],
  ['Покупки', false, ['Электроника', 'Дом']],
  ['Подписки', false],
  ['Семья и дети', false],
  ['Путешествия', false],
  ['Подарки', false],
  ['Красота и уход', false],
  ['Другое', false],
];

export function defaultCategories(): Category[] {
  const out: Category[] = [];
  const build = (seeds: Seed[], kind: 'income' | 'expense') => {
    seeds.forEach(([name, essential, subs], i) => {
      const id = newId();
      const color = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
      out.push({ id, name, kind, parentId: null, color, monthlyLimit: null, essential, archived: false, order: i });
      subs?.forEach((sub, j) =>
        out.push({ id: newId(), name: sub, kind, parentId: id, color, monthlyLimit: null, essential, archived: false, order: j }),
      );
    });
  };
  build(INCOME, 'income');
  build(EXPENSE, 'expense');
  return out;
}

export function defaultProfile(): Profile {
  return {
    firstName: '',
    lastName: '',
    displayName: '',
    birthDate: null,
    avatarId: null,
    currency: 'KZT',
    salaryDay: null,
    expectedSalary: null,
    monthlySpendingLimit: null,
    reserveAmount: 0,
    reminderDays: 3,
    migrationHandled: false,
  };
}

export const OPERATION_TYPES = {
  income: 'Доход',
  expense: 'Расход',
  transfer: 'Перевод',
  adjustment: 'Корректировка',
} as const;
