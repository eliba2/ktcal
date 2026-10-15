import type { Key } from 'ink';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { CalEvent } from '../src/events.js';
import { editField, field } from '../src/field.js';
import { describeWhen, toDraft, type Values } from '../src/form.js';
import { withGuests } from '../src/google.js';
import { parseDate, parseTime } from '../src/parse.js';
import { continueAfter, endBefore, ruleCount } from '../src/recurrence.js';

const today = DateTime.fromISO('2026-10-15'); // a Thursday
const noKey = {} as Key;
const key = (k: Partial<Key>) => k as Key;

describe('parseDate', () => {
  it.each([
    ['today', '2026-10-15'],
    ['tomorrow', '2026-10-16'],
    ['+3', '2026-10-18'],
    ['-1', '2026-10-14'],
    ['+2w', '2026-10-29'],
    ['fri', '2026-10-16'],
    ['thursday', '2026-10-15'], // today counts as the next Thursday
    ['mon', '2026-10-19'],
    ['2026-12-01', '2026-12-01'],
    ['20 oct', '2026-10-20'],
    ['20 October 2027', '2027-10-20'],
    ['oct 20', '2026-10-20'],
    ['20/10', '2026-10-20'],
    ['3.11.2026', '2026-11-03'],
    ['Tue 20 Oct 2026', '2026-10-20'],
  ])('%s', (text, iso) => {
    expect(parseDate(text, today)?.toISODate()).toBe(iso);
  });

  it('rejects what it cannot read', () => {
    for (const text of ['', 'someday', '32/10', 'oct']) expect(parseDate(text, today)).toBeNull();
  });
});

describe('parseTime', () => {
  it.each([
    ['13:30', [13, 30]],
    ['1330', [13, 30]],
    ['930', [9, 30]],
    ['9', [9, 0]],
    ['1pm', [13, 0]],
    ['1:30 pm', [13, 30]],
    ['12am', [0, 0]],
    ['12pm', [12, 0]],
  ])('%s', (text, [hour, minute]) => {
    expect(parseTime(text)).toEqual({ hour, minute });
  });

  it('rejects impossible times', () => {
    for (const text of ['24:00', '9:60', '13pm', 'noon', '']) expect(parseTime(text)).toBeNull();
  });
});

describe('editField', () => {
  it('types, moves and deletes like readline', () => {
    let s = field('hello');
    s = editField(s, ' world', noKey)!;
    expect(s).toEqual({ value: 'hello world', cursor: 11 });
    s = editField(s, 'w', key({ ctrl: true }))!; // delete word
    expect(s.value).toBe('hello ');
    s = editField(s, 'a', key({ ctrl: true }))!; // start
    s = editField(s, '>', noKey)!;
    expect(s).toEqual({ value: '>hello ', cursor: 1 });
    s = editField(s, '', key({ delete: true }))!; // the Backspace key
    expect(s).toEqual({ value: 'hello ', cursor: 0 });
    s = editField(s, 'k', key({ ctrl: true }))!;
    expect(s.value).toBe('');
  });

  it('keeps pastes on one line and leaves Tab / Enter to the caller', () => {
    expect(editField(field(''), 'a\nb', noKey)!.value).toBe('a b');
    expect(editField(field('x'), '', key({ tab: true }))).toBeNull();
    expect(editField(field('x'), '\r', key({ return: true }))).toBeNull();
  });
});

describe('form → draft', () => {
  const calendars = [{ id: 'work', name: 'Work', color: '#4285f4', writable: true }];
  const values = (over: Partial<Record<keyof Values['text'], string>>, rest: Partial<Values> = {}): Values => ({
    text: {
      title: field(over.title ?? 'Planning'),
      date: field(over.date ?? 'Thu 15 Oct 2026'),
      start: field(over.start ?? '09:00'),
      end: field(over.end ?? '10:00'),
      lastDay: field(over.lastDay ?? 'Thu 15 Oct 2026'),
      location: field(over.location ?? ''),
      guests: field(over.guests ?? ''),
    },
    calendar: 0,
    allDay: false,
    notes: '',
    duration: 60,
    ...rest,
  });
  const draft = (v: Values, original: CalEvent | null = null) => {
    const r = toDraft(v, calendars, original, today);
    if ('error' in r) throw new Error(r.error);
    return r.draft;
  };

  it('builds timed events, rolling an earlier end time over to the next day', () => {
    expect(describeWhen(draft(values({ start: '1pm', end: '14:30' })))).toBe('Thu 15 Oct 2026, 13:00 – 14:30 (1h 30m)');
    expect(describeWhen(draft(values({ start: '22:00', end: '1:30' })))).toBe('Thu 15 Oct, 22:00 → Fri 16 Oct, 01:30 (3h 30m)');
  });

  it('builds all-day events with an exclusive end', () => {
    const d = draft(values({ date: 'fri', lastDay: '+3' }, { allDay: true }));
    expect([d.start.toISODate(), d.end.toISODate()]).toEqual(['2026-10-16', '2026-10-19']);
    expect(describeWhen(d)).toBe('Fri 16 Oct – Sun 18 Oct 2026, all day (3d)');
  });

  it('explains what is wrong', () => {
    const error = (v: Values) => (toDraft(v, calendars, null, today) as { error: string }).error;
    expect(error(values({ date: 'someday' }))).toMatch(/date/);
    expect(error(values({ end: '25:00' }))).toMatch(/end time/);
    expect(error(values({ date: '20 oct', lastDay: '18 oct' }, { allDay: true }))).toMatch(/before/);
    expect((toDraft(values({}), [], null, today) as { error: string }).error).toMatch(/calendar/);
    expect(error(values({ guests: 'a@x.com, bob' }))).toMatch(/"bob"/);
  });

  it('reads guests separated by commas or spaces, without duplicates', () => {
    expect(draft(values({ guests: 'a@x.com, b@y.org  A@x.com;c@z.io' })).guests).toEqual(['A@x.com', 'b@y.org', 'c@z.io']);
  });
});

describe('withGuests', () => {
  it('keeps you, rooms and existing guests (with their RSVPs), adds new ones, drops the rest', () => {
    const attendees = [
      { email: 'me@x.com', self: true, responseStatus: 'accepted' },
      { email: 'room-3@resource.calendar.google.com', resource: true },
      { email: 'dana@x.com', responseStatus: 'declined', displayName: 'Dana' },
      { email: 'old@x.com', responseStatus: 'accepted' },
    ];
    expect(withGuests(attendees, ['Dana@x.com', 'new@x.com'])).toEqual([
      attendees[0],
      attendees[1],
      attendees[2],
      { email: 'new@x.com' },
    ]);
  });
});

describe('recurrence', () => {
  const weekly = ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10', 'EXDATE;TZID=Asia/Jerusalem:20261019T093000'];
  const occurrence = DateTime.fromISO('2026-10-26T09:30:00', { zone: 'Asia/Jerusalem' });

  it('ends a series just before an occurrence (UTC; Israel is +2 again by 26 Oct)', () => {
    expect(endBefore(weekly, occurrence, false)).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026T072959Z',
      weekly[1],
    ]);
    expect(endBefore(['RRULE:FREQ=DAILY;UNTIL=20261231'], DateTime.fromISO('2026-11-02'), true)).toEqual([
      'RRULE:FREQ=DAILY;UNTIL=20261101',
    ]);
  });

  it('continues a counted series with what is left', () => {
    expect(ruleCount(weekly)).toBe(10);
    expect(ruleCount(['RRULE:FREQ=DAILY'])).toBeNull();
    expect(continueAfter(weekly, 3)).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=7', weekly[1]]);
    expect(continueAfter(['RRULE:FREQ=DAILY;UNTIL=20261231'], 3)).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261231']);
  });
});
