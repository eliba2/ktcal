import { DateTime } from 'luxon';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { Canvas, truncate } from '../src/canvas.js';
import { monthGrid, periodBounds, startOfWeek, visibleDays } from '../src/dates.js';
import { DemoSource } from '../src/demo.js';
import { eventsOnDay, fromGoogle, placeInLanes, type CalEvent } from '../src/events.js';
import { htmlToText } from '../src/text.js';
import { renderMonth } from '../src/views/month.js';
import { renderTimeGrid } from '../src/views/timegrid.js';

const day = DateTime.fromISO('2026-10-14'); // a Wednesday

function timed(title: string, from: string, to: string): CalEvent {
  return {
    key: title, calendarId: 'c', id: title, title, color: '#4285f4', declined: false, allDay: false, mine: true, recurring: false,
    start: DateTime.fromISO(`2026-10-14T${from}`), end: DateTime.fromISO(`2026-10-14T${to}`),
  };
}

describe('dates', () => {
  it('starts weeks on the configured weekday', () => {
    expect(startOfWeek(day, 1).toISODate()).toBe('2026-10-12');
    expect(startOfWeek(day, 7).toISODate()).toBe('2026-10-11');
  });
  it('month grid is whole weeks covering the month', () => {
    const grid = monthGrid(day, 1);
    expect(grid.length % 7).toBe(0);
    expect(grid[0]!.toISODate()).toBe('2026-09-28');
    expect(grid.at(-1)!.toISODate()).toBe('2026-11-01');
  });
  it('period bounds', () => {
    expect(periodBounds('week', day, 1).map((d) => d.toISODate())).toEqual(['2026-10-12', '2026-10-18']);
    expect(periodBounds('month', day, 1).map((d) => d.toISODate())).toEqual(['2026-10-01', '2026-10-31']);
  });
});

describe('events', () => {
  it('converts all-day and timed Google events, skipping cancelled ones', () => {
    const allDay = fromGoogle({ id: 'a', summary: 'Off', start: { date: '2026-10-14' }, end: { date: '2026-10-15' } }, 'c', '#000000')!;
    expect(allDay.allDay).toBe(true);
    expect(eventsOnDay([allDay], day)).toHaveLength(1);
    expect(eventsOnDay([allDay], day.plus({ days: 1 }))).toHaveLength(0); // end date is exclusive
    expect(fromGoogle({ id: 'x', status: 'cancelled', start: { date: '2026-10-14' }, end: { date: '2026-10-15' } }, 'c', '#000000')).toBeNull();
    const declined = fromGoogle(
      { id: 't', start: { dateTime: '2026-10-14T09:00:00Z' }, end: { dateTime: '2026-10-14T10:00:00Z' }, attendees: [{ email: 'me@x', self: true, responseStatus: 'declined' }] },
      'c', '#000000',
    )!;
    expect(declined.declined).toBe(true);
    expect(declined.title).toBe('(no title)');
  });

  it('knows whether you own an event or were invited to it', () => {
    const at = { start: { dateTime: '2026-10-14T09:00:00Z' }, end: { dateTime: '2026-10-14T10:00:00Z' } };
    const solo = fromGoogle({ id: 's', ...at, organizer: { email: 'me@x', self: true } }, 'c', '#000000')!;
    expect([solo.mine, solo.response, solo.recurring]).toEqual([true, undefined, false]);
    const hosting = fromGoogle(
      { id: 'h', ...at, organizer: { self: true }, attendees: [{ email: 'me@x', self: true, responseStatus: 'accepted' }, { email: 'b@x' }] },
      'c', '#000000',
    )!;
    expect([hosting.mine, hosting.response]).toEqual([true, 'accepted']);
    const invited = fromGoogle(
      { id: 'i_20261014', ...at, recurringEventId: 'i', organizer: { email: 'boss@x' }, attendees: [{ email: 'me@x', self: true, responseStatus: 'needsAction' }] },
      'c', '#000000',
    )!;
    expect([invited.mine, invited.response, invited.recurring, invited.id]).toEqual([false, 'needsAction', true, 'i_20261014']);
  });

  it('puts overlapping events side by side and lets later ones reuse free lanes', () => {
    const placed = placeInLanes([
      timed('a', '09:00', '10:00'),
      timed('b', '09:30', '10:30'),
      timed('c', '10:00', '11:00'), // a has ended: reuses lane 0
      timed('d', '12:00', '13:00'), // separate cluster
    ]);
    const by = Object.fromEntries(placed.map((p) => [p.event.title, [p.lane, p.lanes]]));
    expect(by).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
  });
});

describe('canvas', () => {
  it('truncates by display width, including wide characters', () => {
    expect(truncate('hello world', 6)).toBe('hello…');
    expect(stringWidth(truncate('会议会议会议', 5))).toBeLessThanOrEqual(5);
  });
  it('renders every line at exactly the canvas width', () => {
    const c = new Canvas(10, 2);
    c.text(0, 0, 'ab🎉cdefghijk', { bold: true });
    c.text(8, 1, '🎉🎉'); // second emoji doesn't fit
    for (const line of c.lines()) expect(stringWidth(line)).toBe(10);
  });
});

describe('views', () => {
  const source = new DemoSource(day);
  for (const view of ['month', 'week', 'day'] as const) {
    for (const [width, height] of [[200, 60], [120, 30], [60, 15], [30, 8]] as const) {
      it(`${view} ${width}x${height} fills the area exactly`, () => {
        const days = visibleDays(view, day, 1);
        const props = {
          events: source.eventsFor(days), cursor: day, selectedKey: null, now: day.set({ hour: 11 }),
          width, height, weekStart: 1 as const, dayStart: 8, dayEnd: 19,
        };
        const lines = view === 'month' ? renderMonth(props) : renderTimeGrid(days, props);
        expect(lines).toHaveLength(height);
        for (const line of lines) expect(stringWidth(line)).toBe(width);
      });
    }
  }
});

describe('htmlToText', () => {
  it('flattens Google description HTML', () => {
    expect(htmlToText('<p>Agenda:</p><ul><li>One &amp; two</li></ul>Line<br>break')).toBe('Agenda:\n• One & two\nLine\nbreak');
  });
});
