import { Canvas, contrastFg, truncate } from '../canvas.js';
import { monthGrid } from '../dates.js';
import { eventsOnDay } from '../events.js';
import { split, theme, type ViewProps } from './common.js';

/** Month view: whole weeks of the cursor's month, each day listing its events. */
export function renderMonth(p: ViewProps): string[] {
  const canvas = new Canvas(p.width, p.height);
  const days = monthGrid(p.cursor, p.weekStart);
  const weeks = days.length / 7;
  const colWidths = split(p.width - 6, 7);
  const rowHeights = split(p.height - 1, weeks);
  const colX = colWidths.map((_, i) => colWidths.slice(0, i).reduce((a, b) => a + b, 0) + i);

  // Weekday names.
  days.slice(0, 7).forEach((day, col) => {
    const name = truncate(colWidths[col]! >= 9 ? day.toFormat('cccc') : day.toFormat('ccc'), colWidths[col]!);
    canvas.text(colX[col]! + Math.floor((colWidths[col]! - name.length) / 2), 0, name, { bold: true });
  });

  let y = 1;
  for (let week = 0; week < weeks; week++) {
    const h = rowHeights[week]!;
    for (let col = 0; col < 7; col++) {
      const day = days[week * 7 + col]!;
      const x = colX[col]!;
      const w = colWidths[col]!;
      const inMonth = day.month === p.cursor.month;
      const isCursor = day.hasSame(p.cursor, 'day');
      const isToday = day.hasSame(p.now, 'day');

      // Day-number line doubles as the row separator: ── 14 ─────
      canvas.fill(x, y, w, 1, '─', { dim: true });
      const label = ` ${day.day === 1 ? day.toFormat('LLL d') : day.day} `;
      canvas.text(x + 1, y, label, {
        bold: isToday || isCursor,
        dim: !inMonth && !isToday,
        fg: isToday ? theme.today : undefined,
      });
      if (isCursor) canvas.restyle(x, y, w, 1, { inverse: true, dim: false });

      const list = eventsOnDay(p.events, day);
      const slots = h - 1;
      const shown = list.length > slots ? list.slice(0, Math.max(0, slots - 1)) : list;
      shown.forEach((e, i) => {
        const row = y + 1 + i;
        if (e.allDay) {
          const style = e.declined
            ? { fg: e.color, strike: true, dim: true }
            : { bg: e.color, fg: contrastFg(e.color) };
          canvas.fill(x, row, w, 1, ' ', style);
          canvas.text(x + 1, row, truncate(e.title, w - 1), style);
        } else {
          canvas.text(x, row, '●', { fg: e.color, dim: e.declined });
          const time = e.start < day ? '…' : e.start.toFormat('HH:mm');
          canvas.text(x + 2, row, truncate(`${time} ${e.title}`, w - 2), {
            dim: e.declined || !inMonth,
            strike: e.declined,
          });
        }
      });
      if (shown.length < list.length) {
        canvas.text(x + 2, y + 1 + shown.length, `+${list.length - shown.length} more`, { dim: true });
      }
      if (col < 6) canvas.fill(x + w, y, 1, h, '│', { dim: true });
    }
    y += h;
  }
  return canvas.lines();
}
