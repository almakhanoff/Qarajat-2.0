import type { Goal, GoalContribution } from './types';
import type { Tiyn } from './money';
import { addMonths, diffDays, diffMonths, today, type ISODate } from './dates';

export function goalSaved(goal: Goal, contributions: GoalContribution[]): Tiyn {
  let s = 0;
  for (const c of contributions) if (c.goalId === goal.id) s += c.amount;
  return Math.max(0, s);
}

export interface GoalForecast {
  saved: Tiyn;
  remaining: Tiyn;
  progress: number;
  /** Среднее пополнение в месяц за последние 3 месяца */
  avgMonthly: Tiyn;
  forecastDate: ISODate | null;
  /** Нужно откладывать в месяц, чтобы успеть к дате */
  requiredMonthly: Tiyn | null;
  onTrack: boolean | null;
  reached: boolean;
}

export function goalForecast(goal: Goal, contributions: GoalContribution[], now: ISODate = today()): GoalForecast {
  const own = contributions.filter((c) => c.goalId === goal.id);
  const saved = goalSaved(goal, own);
  const remaining = Math.max(0, goal.target - saved);
  const progress = goal.target > 0 ? Math.min(100, (saved / goal.target) * 100) : 0;
  const reached = remaining === 0 && goal.target > 0;

  const windowStart = addMonths(now, -3);
  const recent = own.filter((c) => c.date > windowStart && c.date <= now);
  const firstDate = own.length ? own.reduce((m, c) => (c.date < m ? c.date : m), own[0].date) : null;
  let avgMonthly = 0;
  if (recent.length && firstDate) {
    const spanStart = firstDate > windowStart ? firstDate : windowStart;
    const months = Math.max(1, diffDays(spanStart, now) / 30.4375);
    avgMonthly = Math.round(recent.reduce((s, c) => s + c.amount, 0) / Math.min(3, months));
  }

  let forecastDate: ISODate | null = null;
  if (reached) forecastDate = now;
  else if (avgMonthly > 0) forecastDate = addMonths(now, Math.ceil(remaining / avgMonthly));

  let requiredMonthly: Tiyn | null = null;
  let onTrack: boolean | null = null;
  if (goal.targetDate && !reached) {
    const monthsLeft = Math.max(1, diffMonths(now, goal.targetDate));
    requiredMonthly = goal.targetDate <= now ? remaining : Math.ceil(remaining / monthsLeft);
    onTrack = forecastDate ? forecastDate <= goal.targetDate : false;
  }
  return { saved, remaining, progress, avgMonthly, forecastDate, requiredMonthly, onTrack, reached };
}

/**
 * Сумма, зарезервированная под цели на конкретном счёте.
 * Накопления — это часть денег на счёте, а не дополнительные деньги: в капитал не добавляются.
 */
export function reservedOnAccount(accountId: string, goals: Goal[], contributions: GoalContribution[]): Tiyn {
  let s = 0;
  for (const g of goals) if (!g.archived && g.accountId === accountId) s += goalSaved(g, contributions);
  return s;
}
