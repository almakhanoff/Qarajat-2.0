/** Все суммы хранятся в тиынах (1 ₸ = 100 тиын) как целые числа. */
export type Tiyn = number;

export const TIYN_PER_TENGE = 100;

export function isValidTiyn(v: unknown): v is Tiyn {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/**
 * Разбирает пользовательский ввод ("12 500,50", "12500.5", "1 000") в тиыны.
 * Возвращает null при некорректном вводе. Не использует float-арифметику для дробной части.
 */
export function parseMoney(raw: string): Tiyn | null {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/[\s\u00A0\u202F₸]/g, '');
  if (!s) return null;
  let negative = false;
  if (s.startsWith('-') || s.startsWith('−')) {
    negative = true;
    s = s.slice(1);
  }
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart = s;
  let fracPart = '';
  if (lastDot !== -1 && lastComma !== -1) {
    // Оба разделителя: последний — десятичный, остальные — разделители тысяч
    const sep = Math.max(lastDot, lastComma);
    intPart = s.slice(0, sep).replace(/[.,]/g, '');
    fracPart = s.slice(sep + 1);
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sepChar = lastDot !== -1 ? '.' : ',';
    const parts = s.split(sepChar);
    if (parts.length > 2 || parts[1].length === 3) {
      // "1.000.000" или "12,500" — разделители тысяч (у тенге не бывает 3 знаков после запятой)
      intPart = parts.join('');
    } else {
      intPart = parts[0];
      fracPart = parts[1];
    }
  }
  if (!/^\d+$/.test(intPart || '0') || !/^\d*$/.test(fracPart)) return null;
  if (fracPart.length > 2) return null;
  const tenge = intPart === '' ? 0 : Number(intPart);
  const tiyn = Number((fracPart + '00').slice(0, 2));
  const total = tenge * TIYN_PER_TENGE + tiyn;
  if (!Number.isSafeInteger(total)) return null;
  return negative ? -total : total;
}

export function tengeToTiyn(tenge: number): Tiyn {
  return Math.round(tenge * TIYN_PER_TENGE);
}

const groupFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

export const CURRENCY_SYMBOLS: Record<string, string> = { KZT: '₸', USD: '$', EUR: '€', RUB: '₽' };

/** Форматирует тиыны: 1250050 → "12 500,50 ₸"; дробная часть скрывается, если она нулевая. */
export function formatMoney(v: Tiyn, opts: { currency?: string; sign?: boolean; compact?: boolean } = {}): string {
  const sym = CURRENCY_SYMBOLS[opts.currency ?? 'KZT'] ?? opts.currency ?? '₸';
  const negative = v < 0;
  const abs = Math.abs(v);
  const tenge = Math.trunc(abs / TIYN_PER_TENGE);
  const tiyn = abs % TIYN_PER_TENGE;
  let body: string;
  if (opts.compact && tenge >= 1_000_000) {
    body = (tenge / 1_000_000).toFixed(1).replace('.', ',') + ' млн';
  } else if (opts.compact && tenge >= 10_000) {
    body = Math.round(tenge / 1000) + ' тыс';
  } else {
    body = groupFmt.format(tenge).replace(/\u00A0/g, ' ');
    if (tiyn !== 0) body += ',' + String(tiyn).padStart(2, '0');
  }
  const prefix = negative ? '−' : opts.sign && v > 0 ? '+' : '';
  return `${prefix}${body} ${sym}`;
}

/** Значение для поля ввода: 1250050 → "12500,50" */
export function toInputValue(v: Tiyn | null | undefined): string {
  if (v == null) return '';
  const negative = v < 0;
  const abs = Math.abs(v);
  const tenge = Math.trunc(abs / TIYN_PER_TENGE);
  const tiyn = abs % TIYN_PER_TENGE;
  return (negative ? '-' : '') + String(tenge) + (tiyn ? ',' + String(tiyn).padStart(2, '0') : '');
}

export function sum(values: Tiyn[]): Tiyn {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/** Умножение суммы на дробный коэффициент с банковским округлением до тиына. */
export function mulRound(v: Tiyn, factor: number): Tiyn {
  return Math.round(v * factor);
}

/** Процент a от b (0..100+), безопасно при b = 0. */
export function percent(a: Tiyn, b: Tiyn): number {
  if (b === 0) return 0;
  return (a / b) * 100;
}
