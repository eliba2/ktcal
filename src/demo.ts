import { DateTime } from 'luxon';
import type { CalendarRef } from './config.js';
import type { CalEvent, Scope } from './events.js';
import type { Editor, EventSource } from './store.js';

export const demoCalendars: CalendarRef[] = [
  { id: 'work', name: 'Work', color: '#4285f4', writable: true },
  { id: 'personal', name: 'Personal', color: '#33b679', writable: true },
  { id: 'oncall', name: 'On-call', color: '#f6bf26', writable: false },
];

/** Whether `e` is affected by a change to `target` with `scope`. */
function inScope(e: CalEvent, target: CalEvent, scope: Scope): boolean {
  if (e.key === target.key) return true;
  if (scope === 'this' || !target.seriesId || e.seriesId !== target.seriesId) return false;
  return scope === 'all' || e.start >= target.start;
}

/** Made-up events around today, for trying ktcal (and testing layouts) without Google. */
export class DemoSource implements EventSource {
  readonly loading = false;
  readonly error = null;
  private events: CalEvent[];

  constructor(today = DateTime.local().startOf('day')) {
    const at = (dayOffset: number, h: number, m = 0) => today.plus({ days: dayOffset, hours: h, minutes: m });
    let n = 0;
    const ev = (cal: number, title: string, start: DateTime, end: DateTime, extra: Partial<CalEvent> = {}): CalEvent => {
      const c = demoCalendars[cal]!;
      const id = `demo${n++}`;
      return { key: `${c.id}|${id}`, calendarId: c.id, id, title, start, end, allDay: false, color: c.color, declined: false, mine: true, recurring: false, ...extra };
    };
    const allDay = (cal: number, title: string, from: number, days: number) =>
      ev(cal, title, today.plus({ days: from }), today.plus({ days: from + days }), { allDay: true });

    this.events = [];
    for (let d = -35; d <= 35; d++) {
      const day = today.plus({ days: d });
      if (day.weekday >= 6) continue;
      this.events.push(
        ev(0, 'Daily standup', at(d, 9, 30), at(d, 9, 45), { meetLink: 'https://meet.google.com/abc-defg-hij', recurring: true, seriesId: 'standup' }),
      );
      if (d % 3 === 0) this.events.push(ev(0, 'Disputes sync — resolution failures', at(d, 11), at(d, 12), { location: 'Room 3' }));
      if (d % 4 === 1) this.events.push(ev(1, 'Gym', at(d, 18), at(d, 19, 30)));
      if (d % 5 === 2) this.events.push(ev(0, '1:1', at(d, 14), at(d, 14, 30)));
    }
    this.events.push(
      ev(0, 'Billing review', at(0, 11, 30), at(0, 12, 30), {
        description:
          '<p>Agenda:</p><ul><li>Eneba credit</li><li>Tax invoices</li></ul>' +
          '<p>Notes: <a href="https://docs.google.com/document/d/1AbCdEf/edit">billing doc</a>, ' +
          'dashboard at https://example.com/billing?month=10.</p>',
        meetLink: 'https://meet.google.com/xyz-abcd-efg',
        organizer: 'Finance',
        mine: false,
        response: 'needsAction',
        attendees: [
          { email: 'a@example.com', response: 'accepted' },
          { email: 'me@example.com', response: 'needsAction', self: true },
        ],
      }),
      ev(0, 'Overlapping: model-manager latency', at(0, 11, 45), at(0, 12, 15)),
      ev(1, 'Lunch', at(0, 13), at(0, 14)),
      ev(0, 'Declined meeting', at(0, 15), at(0, 16), { declined: true }),
      ev(1, 'Late flight ✈ to TLV', at(1, 22), at(2, 1, 30)),
      allDay(2, 'On-call week', -1, 7),
      allDay(1, 'Holiday 🎉', 3, 1),
    );
  }

  eventsFor(days: DateTime[]): CalEvent[] {
    const from = days[0]!.startOf('day');
    const to = days[days.length - 1]!.plus({ days: 1 }).startOf('day');
    return this.events.filter((e) => e.start < to && e.end > from);
  }

  prefetch(): void {}
  refresh(): void {}

  /** Edits change the in-memory list only. */
  readonly editor: Editor = {
    quickAdd: async (text, day) => {
      // Just enough of a parser to try it out: an optional "1pm" / "13:30" sets the start.
      const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
      let hour = m ? Number(m[1]) % 24 : 12;
      if (m?.[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      const start = day.startOf('day').set({ hour, minute: m?.[2] ? Number(m[2]) : 0 });
      const title = (m ? text.replace(m[0], '') : text).replace(/\s+/g, ' ').trim() || '(no title)';
      const id = `added${this.events.length}`;
      this.events.push({
        key: `${demoCalendars[0]!.id}|${id}`, calendarId: demoCalendars[0]!.id, id, title, start,
        end: start.plus({ hours: 1 }), allDay: false, color: demoCalendars[0]!.color, declined: false, mine: true, recurring: false,
      });
      return { title, start };
    },
    create: async (draft) => {
      const cal = demoCalendars.find((c) => c.id === draft.calendarId) ?? demoCalendars[0]!;
      const id = `added${this.events.length}`;
      const { calendarId, title, allDay, start, end, location, description, guests } = draft;
      this.events.push({
        key: `${cal.id}|${id}`, calendarId, id, title, allDay, start, end, location, description,
        attendees: guests.length ? [{ email: 'me@example.com', self: true }, ...guests.map((email) => ({ email }))] : undefined,
        color: cal.color, declined: false, mine: true, recurring: false,
      });
    },
    update: async (event, changes, _notify, scope) => {
      const { guests, start, end, ...rest } = changes;
      this.events = this.events.map((e) => {
        if (!inScope(e, event, scope)) return e;
        // Series edits keep each occurrence's day and move it to the new time.
        const shift = start ? start.diff(event.start) : null;
        return {
          ...e,
          ...rest,
          ...(shift ? { start: e.start.plus(shift), end: e.start.plus(shift).plus((end ?? event.end).diff(start!)) } : {}),
          ...(guests ? { attendees: guests.map((email) => ({ email })) } : {}),
        };
      });
    },
    remove: async (event, _notify, scope) => {
      this.events = this.events.filter((e) => !inScope(e, event, scope));
    },
    respond: async (event, response) => {
      this.events = this.events.map((e) => (e.key === event.key ? { ...e, response, declined: response === 'declined' } : e));
    },
  };
}
