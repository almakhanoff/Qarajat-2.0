/** Даты хранятся как локальные ISO-строки: дата "YYYY-MM-DD", дата-время "YYYY-MM-DDTHH:mm". */
export type ISODate = string;
export type ISODateTime = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = parseDate(s);
  return toISODate(d) === s;
}

export function isISODateTime(s: unknown): s is ISODateTime {
  if (typeof s !== 'string' || !DATETIME_RE.test(s)) return false;
  const [date, time] = s.split('T');
  const [h, m] = time.split(':').map(Number);
  return isISODate(date) && h < 24 && m < 60;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function toISODate(d: Date): ISODate {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function toISODateTime(d: Date): ISODateTime {
  return `${toISODate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function parseDate(s: ISODate | ISODateTime): Date {
  const [datePart, timePart] = s.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  if (timePart) {
    const [hh, mm] = timePart.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm);
  }
  return new Date(y, m - 1, d);
}

export function dateOf(s: ISODate | ISODateTime): ISODate {
  return s.slice(0, 10);
}

export function today(now: Date = new Date()): ISODate {
  return toISODate(now);
}

export function nowDateTime(now: Date = new Date()): ISODateTime {
  return toISODateTime(now);
}

export function addDays(date: ISODate, n: number): ISODate {
  const d = parseDate(date);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/** Добавляет месяцы, «прилипая» к нужному дню (31 → последний день короткого месяца). */
export function addMonths(date: ISODate, n: number, day?: number): ISODate {
  const d = parseDate(date);
  const targetDay = day ?? d.getDate();
  const total = d.getFullYear() * 12 + d.getMonth() + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  return toISODate(new Date(y, m, Math.min(targetDay, daysInMonth(y, m))));
}

export function diffDays(from: ISODate, to: ISODate): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
}

export function diffMonths(from: ISODate, to: ISODate): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

/** Ключ месяца "YYYY-MM" */
export type MonthKey = string;

export function monthKey(date: ISODate | ISODateTime): MonthKey {
  return date.slice(0, 7);
}

export function monthRange(key: MonthKey): { from: ISODate; to: ISODate } {
  const [y, m] = key.split('-').map(Number);
  return { from: `${key}-01`, to: `${key}-${pad2(daysInMonth(y, m - 1))}` };
}

export function shiftMonth(key: MonthKey, n: number): MonthKey {
  return monthKey(addMonths(`${key}-01`, n));
}

export function dateOnDay(key: MonthKey, day: number): ISODate {
  const [y, m] = key.split('-').map(Number);
  return `${key}-${pad2(Math.min(day, daysInMonth(y, m - 1)))}`;
}

export const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const MONTHS_GEN_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_SHORT_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export const WEEKDAYS_SHORT_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function formatMonth(key: MonthKey): string {
  const [y, m] = key.split('-').map(Number);
  const name = MONTHS_RU[m - 1];
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
}

export function formatDate(date: ISODate | ISODateTime, opts: { year?: boolean; time?: boolean } = {}): string {
  const d = parseDate(date);
  let s = `${d.getDate()} ${MONTHS_GEN_RU[d.getMonth()]}`;
  if (opts.year !== false && (opts.year || d.getFullYear() !== new Date().getFullYear())) s += ` ${d.getFullYear()}`;
  if (opts.time && date.includes('T')) s += `, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return s;
}

/** Понедельник недели, в которую входит дата */
export function startOfWeek(date: ISODate): ISODate {
  const d = parseDate(date);
  const idx = (d.getDay() + 6) % 7;
  return addDays(date, -idx);
}

/** Ближайшая дата с указанным днём месяца, не раньше from (включительно). */
export function nextDayOfMonth(from: ISODate, day: number): ISODate {
  const key = monthKey(from);
  const candidate = dateOnDay(key, day);
  if (candidate >= from) return candidate;
  return dateOnDay(shiftMonth(key, 1), day);
}
