import { DateTime } from 'luxon';

export type View = 'month' | 'week' | 'day';

/** Luxon weekday numbers: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export function startOfWeek(day: DateTime, weekStart: Weekday): DateTime {
  return day.startOf('day').minus({ days: (day.weekday - weekStart + 7) % 7 });
}

/** The days shown by the month grid: whole weeks covering the month. */
export function monthGrid(day: DateTime, weekStart: Weekday): DateTime[] {
  const first = startOfWeek(day.startOf('month'), weekStart);
  const last = day.endOf('month');
  const days: DateTime[] = [];
  for (let d = first; d <= last || days.length % 7 !== 0; d = d.plus({ days: 1 })) days.push(d);
  return days;
}

export function weekDays(day: DateTime, weekStart: Weekday): DateTime[] {
  const first = startOfWeek(day, weekStart);
  return Array.from({ length: 7 }, (_, i) => first.plus({ days: i }));
}

/** Days visible in a view; the range to fetch is [first, last + 1 day). */
export function visibleDays(view: View, cursor: DateTime, weekStart: Weekday): DateTime[] {
  if (view === 'month') return monthGrid(cursor, weekStart);
  if (view === 'week') return weekDays(cursor, weekStart);
  return [cursor.startOf('day')];
}

/** Move the cursor by whole periods of the view (month / week / day). */
export function shiftPeriod(view: View, cursor: DateTime, count: number): DateTime {
  if (view === 'month') return cursor.plus({ months: count });
  if (view === 'week') return cursor.plus({ weeks: count });
  return cursor.plus({ days: count });
}

/** First and last day of the period the cursor is in. */
export function periodBounds(view: View, cursor: DateTime, weekStart: Weekday): [DateTime, DateTime] {
  if (view === 'month') return [cursor.startOf('month').startOf('day'), cursor.endOf('month').startOf('day')];
  if (view === 'week') {
    const first = startOfWeek(cursor, weekStart);
    return [first, first.plus({ days: 6 })];
  }
  return [cursor.startOf('day'), cursor.startOf('day')];
}

export function title(view: View, cursor: DateTime, weekStart: Weekday): string {
  if (view === 'month') return cursor.toFormat('LLLL yyyy');
  if (view === 'week') {
    const [first, last] = periodBounds('week', cursor, weekStart);
    const range =
      first.month === last.month
        ? `${first.toFormat('LLL d')} – ${last.toFormat('d, yyyy')}`
        : first.year === last.year
          ? `${first.toFormat('LLL d')} – ${last.toFormat('LLL d, yyyy')}`
          : `${first.toFormat('LLL d, yyyy')} – ${last.toFormat('LLL d, yyyy')}`;
    return `Week ${cursor.weekNumber} · ${range}`;
  }
  return cursor.toFormat('cccc, LLLL d, yyyy');
}
