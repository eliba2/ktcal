import { DateTime } from 'luxon';

export interface CalEvent {
  /** Unique across calendars: `<calendarId>|<eventId>`. */
  key: string;
  calendarId: string;
  /** Google's event id (for a recurring event, this occurrence's id). */
  id: string;
  title: string;
  start: DateTime;
  /** Exclusive end. For all-day events this is midnight after the last day. */
  end: DateTime;
  allDay: boolean;
  color: string;
  declined: boolean;
  /** Your own RSVP when you're on the guest list; undefined otherwise. */
  response?: Response;
  /** You organise it (or it has no guest list), so you may delete it. */
  mine: boolean;
  /** An occurrence of a recurring series. */
  recurring: boolean;
  /** For an occurrence: the series' own event id. */
  seriesId?: string;
  /** Version tag: an update sends it back so a concurrent change fails instead of being overwritten. */
  etag?: string;
  location?: string;
  description?: string;
  meetLink?: string;
  htmlLink?: string;
  organizer?: string;
  /** `resource` marks rooms and equipment. */
  attendees?: { email: string; name?: string; response?: string; self?: boolean; resource?: boolean }[];
}

export type Response = 'accepted' | 'declined' | 'tentative' | 'needsAction';

/** An event as the form edits it. */
export interface Draft {
  calendarId: string;
  title: string;
  allDay: boolean;
  start: DateTime;
  /** Exclusive, like CalEvent.end. */
  end: DateTime;
  location: string;
  /** Plain text. */
  description: string;
  /** Guests' emails (not you, not rooms). */
  guests: string[];
}

/** Which occurrences of a recurring event a change applies to. */
export type Scope = 'this' | 'following' | 'all';

/** The subset of a Google Calendar API event resource that ktcal reads. */
export interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurringEventId?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; self?: boolean; resource?: boolean }[];
  /** RRULE / EXRULE / RDATE / EXDATE lines; only on a series' own event. */
  recurrence?: string[];
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

/** Convert an API event into a CalEvent in the local zone; null for cancelled/invalid ones. */
export function fromGoogle(item: GoogleEvent, calendarId: string, color: string): CalEvent | null {
  if (item.status === 'cancelled' || !item.start || !item.end) return null;
  const allDay = Boolean(item.start.date);
  const start = allDay
    ? DateTime.fromISO(item.start.date!)
    : DateTime.fromISO(item.start.dateTime ?? '').toLocal();
  const end = allDay ? DateTime.fromISO(item.end.date!) : DateTime.fromISO(item.end.dateTime ?? '').toLocal();
  if (!start.isValid || !end.isValid) return null;

  const self = item.attendees?.find((a) => a.self);
  const video = item.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
  return {
    key: `${calendarId}|${item.id}`,
    calendarId,
    id: item.id,
    title: item.summary?.trim() || '(no title)',
    start,
    end: end <= start ? start.plus({ minutes: allDay ? 24 * 60 : 0 }) : end,
    allDay,
    color,
    declined: self?.responseStatus === 'declined',
    response: self?.responseStatus as Response | undefined,
    mine: Boolean(item.organizer?.self) || !self,
    recurring: Boolean(item.recurringEventId),
    seriesId: item.recurringEventId,
    etag: item.etag,
    location: item.location,
    description: item.description,
    meetLink: item.hangoutLink ?? video,
    htmlLink: item.htmlLink,
    organizer: item.organizer?.displayName ?? item.organizer?.email,
    attendees: item.attendees
      ?.filter((a) => a.email)
      .map((a) => ({ email: a.email!, name: a.displayName, response: a.responseStatus, self: a.self, resource: a.resource })),
  };
}

/** Events touching `day`, all-day first, then by start time, then by title. */
export function eventsOnDay(events: CalEvent[], day: DateTime): CalEvent[] {
  const from = day.startOf('day');
  const to = from.plus({ days: 1 });
  return events
    .filter((e) => e.start < to && e.end > from)
    .sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) ||
        a.start.toMillis() - b.start.toMillis() ||
        a.title.localeCompare(b.title),
    );
}

export interface Placed {
  event: CalEvent;
  /** Zero-based column within its overlap cluster. */
  lane: number;
  /** Number of columns the cluster needs. */
  lanes: number;
}

/**
 * Side-by-side layout for timed events of one day: overlapping events get separate
 * lanes, and every event in an overlap cluster shares that cluster's lane count.
 */
export function placeInLanes(events: CalEvent[]): Placed[] {
  const sorted = events
    .filter((e) => !e.allDay)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis() || b.end.toMillis() - a.end.toMillis());

  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const closeCluster = () => {
    for (const p of cluster) p.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };

  for (const event of sorted) {
    const start = event.start.toMillis();
    if (start >= clusterEnd) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = event.end.toMillis();
    const p = { event, lane, lanes: 0 };
    cluster.push(p);
    placed.push(p);
    clusterEnd = Math.max(clusterEnd, event.end.toMillis());
  }
  closeCluster();
  return placed;
}

/** Merge per-period event lists, dropping duplicates of events that span periods. */
export function dedupe(lists: CalEvent[][]): CalEvent[] {
  const seen = new Map<string, CalEvent>();
  for (const list of lists) for (const e of list) seen.set(`${e.key}|${e.start.toMillis()}`, e);
  return [...seen.values()];
}
