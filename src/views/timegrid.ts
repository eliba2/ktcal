import type { DateTime } from 'luxon';
import { Canvas, contrastFg, truncate, width as textWidth, type Style } from '../canvas.js';
import { eventsOnDay, placeInLanes } from '../events.js';
import { split, theme, type ViewProps } from './common.js';

const GUTTER = 6; // "09:00 "
const MAX_ALLDAY_ROWS = 3;
/** Candidate minutes-per-row, finest first; the first one that fits the screen wins. */
const SCALES = [5, 10, 15, 20, 30, 60, 90, 120, 180, 240];

/**
 * Week / day view: one column per day, a time gutter on the left, all-day events in
 * a strip on top, and timed events as blocks laid out side by side when they overlap.
 */
export function renderTimeGrid(days: DateTime[], p: ViewProps): string[] {
  const canvas = new Canvas(p.width, p.height);
  const n = days.length;
  const colWidths = split(p.width - GUTTER - (n - 1), n);
  const colX = colWidths.map((_, i) => GUTTER + colWidths.slice(0, i).reduce((a, b) => a + b, 0) + i);
  const perDay = days.map((day) => eventsOnDay(p.events, day));

  // Header: day names.
  days.forEach((day, i) => {
    const w = colWidths[i]!;
    const label = truncate(n === 1 || w >= 10 ? day.toFormat('ccc d') : day.toFormat('d'), w);
    const isToday = day.hasSame(p.now, 'day');
    canvas.text(colX[i]! + Math.floor((w - textWidth(label)) / 2), 0, label, {
      bold: true,
      fg: isToday ? theme.today : undefined,
    });
    if (n > 1 && day.hasSame(p.cursor, 'day')) canvas.restyle(colX[i]!, 0, w, 1, { inverse: true });
  });

  // All-day strip.
  const allDay = perDay.map((list) => list.filter((e) => e.allDay));
  const allDayRows = Math.min(MAX_ALLDAY_ROWS, Math.max(0, ...allDay.map((l) => l.length)));
  allDay.forEach((list, i) => {
    const shown = list.length > allDayRows ? list.slice(0, allDayRows - 1) : list;
    shown.forEach((e, row) => {
      const selected = isSelected(e.key, days[i]!, p);
      const style: Style = e.declined
        ? { fg: e.color, strike: true, dim: true }
        : { bg: e.color, fg: contrastFg(e.color), inverse: selected, bold: selected };
      canvas.fill(colX[i]!, 1 + row, colWidths[i]!, 1, ' ', style);
      canvas.text(colX[i]! + 1, 1 + row, truncate(e.title, colWidths[i]! - 1), style);
    });
    if (shown.length < list.length) {
      canvas.text(colX[i]! + 1, 1 + shown.length, `+${list.length - shown.length} more`, { dim: true });
    }
  });
  if (allDayRows > 0) canvas.fill(0, 1 + allDayRows, p.width, 1, '─', { dim: true });

  // Time scale.
  const gridTop = 1 + allDayRows + (allDayRows > 0 ? 1 : 0);
  const rows = p.height - gridTop;
  if (rows <= 0) return canvas.lines();
  const [firstHour, endHour] = hourRange(perDay.flat(), days, p.dayStart, p.dayEnd);
  const span = (endHour - firstHour) * 60;
  const scale = SCALES.find((m) => Math.ceil(span / m) <= rows) ?? SCALES[SCALES.length - 1]!;
  // Fill the whole screen with spare rows: later hours first (up to midnight), then earlier ones.
  const spareHours = Math.floor((rows * scale - span) / 60);
  const startHour = Math.max(0, firstHour - Math.max(0, spareHours - (24 - endHour)));
  const gridMinutes = Math.min(rows * scale, (24 - startHour) * 60);
  const usedRows = Math.ceil(gridMinutes / scale);
  const rowOf = (minutes: number) => Math.floor((minutes - startHour * 60) / scale);

  for (let r = 0; r < usedRows; r++) {
    const minute = startHour * 60 + r * scale;
    const onHour = minute % 60 === 0;
    if (onHour || scale > 60 || r === 0) canvas.text(0, gridTop + r, hhmm(minute), { dim: true });
    if (onHour) days.forEach((_, i) => canvas.fill(colX[i]!, gridTop + r, colWidths[i]!, 1, '┄', { dim: true }));
  }

  // Current-time line (drawn first so event blocks cover it).
  const todayCol = days.findIndex((d) => d.hasSame(p.now, 'day'));
  const nowRow = rowOf(p.now.hour * 60 + p.now.minute);
  if (todayCol !== -1 && nowRow >= 0 && nowRow < usedRows) {
    canvas.fill(colX[todayCol]!, gridTop + nowRow, colWidths[todayCol]!, 1, '─', { fg: theme.nowLine });
    canvas.text(0, gridTop + nowRow, p.now.toFormat('HH:mm'), { fg: theme.nowLine, bold: true });
  }

  // Timed events.
  days.forEach((day, i) => {
    const dayStart = day.startOf('day');
    for (const { event: e, lane, lanes } of placeInLanes(perDay[i]!)) {
      const from = Math.max(0, e.start.diff(dayStart, 'minutes').minutes);
      const to = Math.min(24 * 60, e.end.diff(dayStart, 'minutes').minutes);
      // Events entirely above / below the visible hours collapse to one marked row at that edge.
      const above = Math.ceil((to - startHour * 60) / scale) <= 0;
      const below = rowOf(from) >= usedRows;
      const top = below ? usedRows - 1 : Math.max(0, rowOf(from));
      const bottom = above ? 1 : below ? usedRows : Math.min(usedRows, Math.max(top + 1, Math.ceil((to - startHour * 60) / scale)));
      const marker = above ? '↑' : below ? '↓' : '';

      const w = colWidths[i]!;
      const left = Math.floor((lane * w) / lanes);
      const right = Math.floor(((lane + 1) * w) / lanes);
      const laneWidth = right - left - (lane < lanes - 1 && right - left > 3 ? 1 : 0);
      const x = colX[i]! + left;
      const selected = isSelected(e.key, day, p);
      const base: Style = e.declined
        ? { fg: e.color, dim: true, strike: true }
        : { bg: e.color, fg: contrastFg(e.color) };
      const style: Style = selected ? { ...base, inverse: true, bold: true, dim: false } : base;

      const height = bottom - top;
      canvas.fill(x, gridTop + top, laneWidth, height, ' ', style);
      const time = `${e.start.toFormat('HH:mm')}–${e.end.toFormat('HH:mm')}`;
      const lines =
        height === 1
          ? [`${marker}${e.start.toFormat('HH:mm')} ${e.title}`]
          : [e.title, time, ...(e.location ? [e.location] : [])];
      lines.slice(0, height).forEach((text, k) => {
        canvas.text(x + 1, gridTop + top + k, truncate(text, laneWidth - 1), {
          ...style,
          // No bold on dimmed (declined) titles: Ink closes bold with SGR 22, which also ends
          // the dim, so the rest of the row would lose its dimming.
          bold: (k === 0 && !style.dim) || style.bold,
        });
      });
    }
  });

  // Column separators.
  for (let i = 0; i < n - 1; i++) canvas.fill(colX[i]! + colWidths[i]!, 0, 1, p.height, '│', { dim: true });
  return canvas.lines();
}

function isSelected(key: string, day: DateTime, p: ViewProps): boolean {
  return key === p.selectedKey && day.hasSame(p.cursor, 'day');
}

/** Hours to show: the configured working day, widened to fit every timed event. */
function hourRange(
  events: { allDay: boolean; start: DateTime; end: DateTime }[],
  days: DateTime[],
  dayStart: number,
  dayEnd: number,
): [number, number] {
  let start = dayStart;
  let end = dayEnd;
  for (const e of events) {
    if (e.allDay) continue;
    for (const day of days) {
      const d0 = day.startOf('day');
      const from = e.start.diff(d0, 'minutes').minutes;
      const to = e.end.diff(d0, 'minutes').minutes;
      if (to <= 0 || from >= 24 * 60) continue;
      // Only a start / end inside this day widens the range: the tail of an overnight
      // event shouldn't stretch the whole grid to midnight.
      if (from >= 0) {
        start = Math.min(start, Math.floor(from / 60));
        // A late start that runs past midnight still gets its first hour on screen.
        end = Math.max(end, to <= 24 * 60 ? Math.ceil(to / 60) : Math.min(24, Math.floor(from / 60) + 1));
      }
    }
  }
  return [start, Math.max(end, start + 1)];
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
