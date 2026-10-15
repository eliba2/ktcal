import { DateTime } from 'luxon';

/** How the form shows a date; parseDate reads it back. */
export const DATE_FORMAT = 'ccc d LLL yyyy';

/** Formats tried in order; day-first for numeric dates (14/10, 14.10.2026). */
const FORMATS = [
  'yyyy-MM-dd',
  DATE_FORMAT,
  'ccc d LLL',
  'd LLL yyyy',
  'd LLL',
  'd LLLL yyyy',
  'd LLLL',
  'LLL d yyyy',
  'LLL d',
  'LLLL d',
  'd/M/yyyy',
  'd/M/yy',
  'd/M',
  'd.M.yyyy',
  'd.M.yy',
  'd.M',
];

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * A day from loose text: "today", "tomorrow", "+3", "fri" (the next one, today
 * included), "2026-10-20", "20 oct", "20/10", "Tue 20 Oct 2026", … Dates without a
 * year use today's year. Null when it can't tell.
 */
export function parseDate(text: string, today = DateTime.local()): DateTime | null {
  const s = text.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  const base = today.startOf('day');
  if (!s) return null;
  if (s === 'today' || s === 'tod') return base;
  if (s === 'tomorrow' || s === 'tom') return base.plus({ days: 1 });
  if (s === 'yesterday') return base.minus({ days: 1 });
  const offset = /^([+-])\s*(\d+)\s*(d|w)?$/.exec(s);
  if (offset) {
    const n = Number(offset[2]) * (offset[1] === '-' ? -1 : 1);
    return base.plus(offset[3] === 'w' ? { weeks: n } : { days: n });
  }
  const weekday = WEEKDAYS.findIndex((d) => s.length >= 3 && d.startsWith(s.slice(0, 3)) && /^[a-z]+$/.test(s));
  if (weekday !== -1) return base.plus({ days: (weekday + 1 - base.weekday + 7) % 7 });
  for (const format of FORMATS) {
    const d = DateTime.fromFormat(s, format, { locale: 'en' });
    if (!d.isValid) continue;
    return format.includes('y') ? d : d.set({ year: base.year });
  }
  return null;
}

/** A time of day from "13:30", "1330", "9", "930", "1pm", "1:30 pm", "12am". */
export function parseTime(text: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)?$/.exec(text.trim().toLowerCase());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const half = m[3]?.[0];
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === 'p' ? 12 : 0);
  }
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** "1h 30m", "45m", "2d". */
export function formatDuration(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ');
}
