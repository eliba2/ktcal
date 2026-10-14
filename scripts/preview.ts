// Print a view with demo data, ANSI stripped: tsx scripts/preview.ts <month|week|day> [width] [height]
import { DateTime } from 'luxon';
import { visibleDays, type View } from '../src/dates.js';
import { DemoSource } from '../src/demo.js';
import { renderMonth } from '../src/views/month.js';
import { renderTimeGrid } from '../src/views/timegrid.js';
import stringWidth from 'string-width';

const [view = 'month', w = '140', h = '36'] = process.argv.slice(2);
const today = DateTime.fromISO('2026-10-14');
const cursor = today;
const days = visibleDays(view as View, cursor, 1);
const props = {
  events: new DemoSource(today).eventsFor(days), cursor, selectedKey: null, now: today.set({ hour: 12, minute: 5 }),
  width: Number(w), height: Number(h), weekStart: 1 as const, dayStart: 8, dayEnd: 19,
};
const lines = view === 'month' ? renderMonth(props) : renderTimeGrid(days, props);
const bad = lines.filter((l) => stringWidth(l) !== Number(w)).length;
console.log(lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n'));
console.log(`-- ${lines.length} lines, ${bad} with wrong width`);
