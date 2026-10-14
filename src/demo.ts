import { DateTime } from 'luxon';
import type { CalendarRef } from './config.js';
import type { CalEvent } from './events.js';
import type { EventSource } from './store.js';

export const demoCalendars: CalendarRef[] = [
  { id: 'work', name: 'Work', color: '#4285f4' },
  { id: 'personal', name: 'Personal', color: '#33b679' },
  { id: 'oncall', name: 'On-call', color: '#f6bf26' },
];

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
      return { key: `${c.id}|demo${n++}`, calendarId: c.id, title, start, end, allDay: false, color: c.color, declined: false, ...extra };
    };
    const allDay = (cal: number, title: string, from: number, days: number) =>
      ev(cal, title, today.plus({ days: from }), today.plus({ days: from + days }), { allDay: true });

    this.events = [];
    for (let d = -35; d <= 35; d++) {
      const day = today.plus({ days: d });
      if (day.weekday >= 6) continue;
      this.events.push(ev(0, 'Daily standup', at(d, 9, 30), at(d, 9, 45), { meetLink: 'https://meet.google.com/abc-defg-hij' }));
      if (d % 3 === 0) this.events.push(ev(0, 'Disputes sync — resolution failures', at(d, 11), at(d, 12), { location: 'Room 3' }));
      if (d % 4 === 1) this.events.push(ev(1, 'Gym', at(d, 18), at(d, 19, 30)));
      if (d % 5 === 2) this.events.push(ev(0, '1:1', at(d, 14), at(d, 14, 30)));
    }
    this.events.push(
      ev(0, 'Billing review', at(0, 11, 30), at(0, 12, 30), {
        description: '<p>Agenda:</p><ul><li>Eneba credit</li><li>Tax invoices</li></ul>',
        organizer: 'Finance',
        attendees: [
          { email: 'a@example.com', response: 'accepted' },
          { email: 'b@example.com', response: 'needsAction' },
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
}
