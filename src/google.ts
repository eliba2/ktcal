import type { OAuth2Client } from 'google-auth-library';
import type { DateTime } from 'luxon';
import type { CalendarRef } from './config.js';
import { fromGoogle, type CalEvent, type GoogleEvent } from './events.js';

const API = 'https://www.googleapis.com/calendar/v3';

export interface GoogleCalendar {
  id: string;
  summary: string;
  summaryOverride?: string;
  backgroundColor?: string;
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
}

export async function listCalendars(client: OAuth2Client): Promise<GoogleCalendar[]> {
  const items: GoogleCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.request<{ items?: GoogleCalendar[]; nextPageToken?: string }>({
      url: `${API}/users/me/calendarList`,
      params: { maxResults: 250, pageToken },
    });
    items.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items.sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false) || name(a).localeCompare(name(b)));
}

export function name(c: GoogleCalendar): string {
  return c.summaryOverride ?? c.summary;
}

export function toRef(c: GoogleCalendar): CalendarRef {
  return { id: c.id, name: name(c), color: c.backgroundColor ?? '#4285f4' };
}

/** Events of one calendar overlapping [from, to), recurring events expanded. */
export async function listEvents(client: OAuth2Client, cal: CalendarRef, from: DateTime, to: DateTime): Promise<CalEvent[]> {
  const events: CalEvent[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.request<{ items?: GoogleEvent[]; nextPageToken?: string }>({
      url: `${API}/calendars/${encodeURIComponent(cal.id)}/events`,
      params: {
        timeMin: from.toISO(),
        timeMax: to.toISO(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 2500,
        pageToken,
      },
    });
    for (const item of res.data.items ?? []) {
      const event = fromGoogle(item, cal.id, cal.color);
      if (event) events.push(event);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return events;
}
