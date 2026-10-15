import type { OAuth2Client } from 'google-auth-library';
import { DateTime } from 'luxon';
import type { CalendarRef } from './config.js';
import { fromGoogle, type CalEvent, type Draft, type GoogleEvent, type Response, type Scope } from './events.js';
import { continueAfter, endBefore, ruleCount } from './recurrence.js';

const API = 'https://www.googleapis.com/calendar/v3';

export interface GoogleCalendar {
  id: string;
  summary: string;
  summaryOverride?: string;
  backgroundColor?: string;
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
  accessRole?: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
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
  return { id: c.id, name: name(c), color: c.backgroundColor ?? '#4285f4', writable: c.accessRole === 'owner' || c.accessRole === 'writer' };
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

const eventsUrl = (calendarId: string) => `${API}/calendars/${encodeURIComponent(calendarId)}/events`;

/**
 * Create an event from a sentence ("Lunch with Dana 1pm") on your primary calendar,
 * using Google's own parser (the same one as Calendar's quick add box).
 */
export async function quickAdd(client: OAuth2Client, text: string): Promise<GoogleEvent> {
  const res = await client.request<GoogleEvent>({
    url: `${eventsUrl('primary')}/quickAdd`,
    method: 'POST',
    params: { text },
  });
  return res.data;
}

type When = { date: string | null; dateTime: string | null; timeZone?: string | null };
type Attendee = NonNullable<GoogleEvent['attendees']>[number];
type Raw = GoogleEvent & Record<string, unknown>;

const CONFLICT = 'The event was changed elsewhere meanwhile: refresh (r) and try again';

/** Start / end in API form. All-day ends stay exclusive; null clears the other kind in a PATCH. */
function when(d: Pick<Draft, 'allDay' | 'start' | 'end'>, timeZone?: string): { start: When; end: When } {
  const one = (t: DateTime): When =>
    d.allDay
      ? { date: t.toISODate(), dateTime: null, timeZone: null }
      : { date: null, dateTime: t.toISO({ suppressMilliseconds: true }), ...(timeZone ? { timeZone } : {}) };
  return { start: one(d.start), end: one(d.end) };
}

/**
 * The attendee list with exactly `guests` as the people invited: existing entries keep
 * their fields (RSVPs, optional, …); you and rooms are always kept; new emails are added.
 */
export function withGuests(attendees: Attendee[], guests: string[]): Attendee[] {
  const wanted = new Set(guests.map((g) => g.toLowerCase()));
  const kept = attendees.filter((a) => a.self || a.resource || wanted.has(a.email?.toLowerCase() ?? ''));
  const have = new Set(kept.map((a) => a.email?.toLowerCase()));
  return [...kept, ...guests.filter((g) => !have.has(g.toLowerCase())).map((email) => ({ email }))];
}

/** Title / location / notes / guests changes as API fields. */
function fields(changes: Partial<Draft>, attendees: Attendee[] = []): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (changes.title !== undefined) data.summary = changes.title;
  if (changes.location !== undefined) data.location = changes.location;
  if (changes.description !== undefined) data.description = changes.description;
  if (changes.guests !== undefined) data.attendees = withGuests(attendees, changes.guests);
  return data;
}

const timesChanged = (c: Partial<Draft>) => Boolean(c.start || c.end || c.allDay !== undefined);

async function getEvent(client: OAuth2Client, calendarId: string, id: string): Promise<Raw> {
  return (await client.request<Raw>({ url: `${eventsUrl(calendarId)}/${encodeURIComponent(id)}` })).data;
}

async function patch(client: OAuth2Client, calendarId: string, id: string, etag: string | undefined, data: object, notify: boolean) {
  await client.request({
    url: `${eventsUrl(calendarId)}/${encodeURIComponent(id)}`,
    method: 'PATCH',
    headers: etag ? { 'If-Match': etag } : {},
    params: { sendUpdates: notify ? 'all' : 'none' },
    data,
  });
}

/** Create an event (guests get invitations); returns it as Google stored it. */
export async function createEvent(client: OAuth2Client, d: Draft): Promise<GoogleEvent> {
  const res = await client.request<GoogleEvent>({
    url: eventsUrl(d.calendarId),
    method: 'POST',
    params: { sendUpdates: d.guests.length ? 'all' : 'none' },
    data: {
      summary: d.title,
      location: d.location || undefined,
      description: d.description || undefined,
      attendees: d.guests.length ? d.guests.map((email) => ({ email })) : undefined,
      ...when(d),
    },
  });
  return res.data;
}

/**
 * Change some fields of an event. For an occurrence of a recurring event, `scope` picks
 * this occurrence, this and the following ones (the series is split in two), or all.
 * Writes carry the etag of what they're based on, so an edit made elsewhere meanwhile
 * fails (412) rather than being silently overwritten. Guests are emailed if `notify`.
 */
export async function updateEvent(
  client: OAuth2Client,
  e: CalEvent,
  changes: Partial<Draft>,
  notify: boolean,
  scope: Scope = 'this',
): Promise<void> {
  if (scope === 'this' || !e.seriesId) {
    let attendees: Attendee[] = [];
    if (changes.guests !== undefined) {
      const current = await getEvent(client, e.calendarId, e.id);
      if (e.etag && current.etag !== e.etag) throw new Error(CONFLICT);
      attendees = current.attendees ?? [];
    }
    const data = { ...fields(changes, attendees), ...(timesChanged(changes) ? when(draftTimes(e, changes)) : {}) };
    return patch(client, e.calendarId, e.id, e.etag, data, notify);
  }

  if (changes.start && !changes.start.hasSame(e.start, 'day')) {
    throw new Error('Moving a series to another day isn\'t supported yet: change only this occurrence, or just the time');
  }
  const series = await getEvent(client, e.calendarId, e.seriesId);
  const first = fromGoogle(series, e.calendarId, '');
  if (!first) throw new Error('Could not read the recurring series');
  const timeZone = series.start?.timeZone ?? DateTime.local().zoneName;
  const times = draftTimes(e, changes);

  if (scope === 'all' || first.start.equals(e.start)) {
    const data = fields(changes, series.attendees);
    if (timesChanged(changes)) {
      // Same time of day (in the series' zone), on the series' first day.
      const local = times.start.setZone(timeZone);
      const start = times.allDay ? first.start.startOf('day') : first.start.setZone(timeZone).set({ hour: local.hour, minute: local.minute });
      Object.assign(data, when({ allDay: times.allDay, start, end: start.plus(times.end.diff(times.start)) }, timeZone));
    }
    return patch(client, e.calendarId, series.id, series.etag, data, notify);
  }

  // This and following: a new series from this occurrence on, then end the old one before it.
  const lines = series.recurrence ?? [];
  const count = ruleCount(lines);
  const skipped = count === null ? 0 : await countBefore(client, e);
  if (count !== null && count - skipped <= 0) throw new Error('No occurrences left from this one on');
  const copy = Object.fromEntries(Object.entries(series).filter(([k]) => SERIES_FIELDS.includes(k)));
  const attendees = (series.attendees ?? []).map((a) => (a.self ? a : { ...a, responseStatus: undefined }));
  await client.request({
    url: eventsUrl(e.calendarId),
    method: 'POST',
    params: { sendUpdates: notify ? 'all' : 'none' },
    data: {
      ...copy,
      attendees: attendees.length ? attendees : undefined,
      ...fields(changes, attendees),
      ...when(times, timeZone),
      recurrence: continueAfter(lines, skipped),
    },
  });
  await patch(client, e.calendarId, series.id, series.etag, { recurrence: endBefore(lines, e.start, first.allDay) }, notify);
}

/** What a "following" split copies from the old series to the new one. */
const SERIES_FIELDS = [
  'summary', 'description', 'location', 'colorId', 'transparency', 'visibility', 'reminders',
  'guestsCanInviteOthers', 'guestsCanModify', 'guestsCanSeeOtherGuests',
];

/** The occurrence's times with the changes applied. */
function draftTimes(e: CalEvent, c: Partial<Draft>): Pick<Draft, 'allDay' | 'start' | 'end'> {
  return { allDay: c.allDay ?? e.allDay, start: c.start ?? e.start, end: c.end ?? e.end };
}

/** How many occurrences of `e`'s series (cancelled ones included, as COUNT does) come before it. */
async function countBefore(client: OAuth2Client, e: CalEvent): Promise<number> {
  let n = 0;
  let pageToken: string | undefined;
  do {
    const res = await client.request<{ items?: GoogleEvent[]; nextPageToken?: string }>({
      url: `${eventsUrl(e.calendarId)}/${encodeURIComponent(e.seriesId!)}/instances`,
      params: { timeMax: e.start.toISO(), showDeleted: true, maxResults: 2500, pageToken },
    });
    n += (res.data.items ?? []).filter((i) => {
      const start = i.start?.dateTime ?? i.start?.date;
      return start && DateTime.fromISO(start) < e.start;
    }).length;
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return n;
}

/**
 * Delete an event. For an occurrence of a recurring event, `scope` picks this occurrence,
 * this and the following ones (the series is ended before it), or the whole series.
 * Guests are emailed if `notify`.
 */
export async function deleteEvent(client: OAuth2Client, e: CalEvent, notify: boolean, scope: Scope = 'this'): Promise<void> {
  const remove = (id: string) =>
    client.request({
      url: `${eventsUrl(e.calendarId)}/${encodeURIComponent(id)}`,
      method: 'DELETE',
      params: { sendUpdates: notify ? 'all' : 'none' },
    });
  if (scope === 'this' || !e.seriesId) return void (await remove(e.id));
  if (scope === 'all') return void (await remove(e.seriesId));
  const series = await getEvent(client, e.calendarId, e.seriesId);
  const first = fromGoogle(series, e.calendarId, '');
  if (!first || first.start.equals(e.start)) return void (await remove(series.id));
  await patch(client, e.calendarId, series.id, series.etag, { recurrence: endBefore(series.recurrence ?? [], e.start, first.allDay) }, notify);
}

/**
 * Set your RSVP on an invitation. PATCH replaces the whole attendees array, so read
 * the current list first (with its etag, so a concurrent change fails instead of
 * being overwritten) and change only your own entry.
 */
export async function respond(client: OAuth2Client, e: CalEvent, response: Response): Promise<void> {
  const url = `${eventsUrl(e.calendarId)}/${encodeURIComponent(e.id)}`;
  const current = await client.request<GoogleEvent & { etag?: string }>({ url });
  const attendees = current.data.attendees ?? [];
  if (!attendees.some((a) => a.self)) throw new Error('You are not on the guest list of this event');
  await client.request({
    url,
    method: 'PATCH',
    headers: current.data.etag ? { 'If-Match': current.data.etag } : {},
    data: { attendees: attendees.map((a) => (a.self ? { ...a, responseStatus: response } : a)) },
  });
}
