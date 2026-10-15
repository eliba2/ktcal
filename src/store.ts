import type { OAuth2Client } from 'google-auth-library';
import { DateTime } from 'luxon';
import type { CalendarRef } from './config.js';
import { dedupe, fromGoogle, type CalEvent, type Draft, type Response, type Scope } from './events.js';
import { createEvent, deleteEvent, listEvents, quickAdd, respond, updateEvent } from './google.js';

/** What the UI needs from an event source (the Google-backed store, or demo data). */
export interface EventSource {
  readonly loading: boolean;
  readonly error: string | null;
  eventsFor(days: DateTime[]): CalEvent[];
  prefetch(around: DateTime): void;
  refresh(days: DateTime[]): void;
  /** Write access; null when the token is read-only. */
  readonly editor: Editor | null;
}

/** Changes to the calendar. Callers refresh the visible days once a call resolves. */
export interface Editor {
  /** Create an event from a sentence, on `day` unless the sentence names a date. Returns what was created. */
  quickAdd(text: string, day: DateTime): Promise<{ title: string; start: DateTime } | null>;
  create(draft: Draft): Promise<void>;
  /** Apply the changed fields; guests are emailed if `notifyGuests`. `scope` matters for recurring events. */
  update(event: CalEvent, changes: Partial<Draft>, notifyGuests: boolean, scope: Scope): Promise<void>;
  remove(event: CalEvent, notifyGuests: boolean, scope: Scope): Promise<void>;
  respond(event: CalEvent, response: Response): Promise<void>;
}

/**
 * Caches events per calendar month ("2026-10"). Views ask for the months they cover;
 * missing ones are fetched in the background and `onChange` fires when they land.
 */
export class EventStore implements EventSource {
  private months = new Map<string, CalEvent[]>();
  private inFlight = new Map<string, Promise<void>>();
  /** Months whose last fetch failed, with when; retried after RETRY_MS rather than every render. */
  private failed = new Map<string, number>();
  /** Bumped by refresh() so responses from before it are dropped. */
  private generation = 0;
  error: string | null = null;
  readonly editor: Editor | null;

  constructor(
    private client: OAuth2Client,
    private calendars: CalendarRef[],
    private onChange: () => void,
    editable = false,
  ) {
    this.editor = editable ? googleEditor(client) : null;
  }

  get loading(): boolean {
    return this.inFlight.size > 0;
  }

  /** Events overlapping the given days; fetches months not loaded yet. */
  eventsFor(days: DateTime[]): CalEvent[] {
    const keys = monthKeys(days);
    keys.forEach((key) => this.ensure(key));
    return dedupe(keys.map((key) => this.months.get(key) ?? []));
  }

  /** Warm the cache for neighbouring months so paging feels instant. */
  prefetch(around: DateTime): void {
    for (const offset of [-1, 1]) this.ensure(around.plus({ months: offset }).toFormat('yyyy-MM'));
  }

  /** Re-download `days`' months; the rest of the cache is dropped and refilled lazily. */
  refresh(days: DateTime[]): void {
    this.generation++;
    const keep = new Map<string, CalEvent[]>();
    // Keep showing current data for the visible months until fresh data replaces it.
    for (const key of monthKeys(days)) {
      const cached = this.months.get(key);
      if (cached) keep.set(key, cached);
    }
    this.months = keep;
    this.inFlight.clear();
    this.failed.clear();
    for (const key of monthKeys(days)) this.fetch(key);
    this.onChange();
  }

  private ensure(key: string): void {
    if (this.months.has(key) || this.inFlight.has(key)) return;
    if (Date.now() - (this.failed.get(key) ?? 0) < RETRY_MS) return;
    this.fetch(key);
  }

  private fetch(key: string): void {
    const generation = this.generation;
    const [year, month] = key.split('-').map(Number) as [number, number];
    let promise: Promise<void> | undefined = undefined;
    promise = (async () => {
      const from = DateTime.local(year, month, 1);
      const to = from.plus({ months: 1 });
      try {
        const lists = await Promise.all(this.calendars.map((cal) => listEvents(this.client, cal, from, to)));
        if (generation !== this.generation) return;
        this.months.set(key, lists.flat());
        this.failed.delete(key);
        this.error = null;
      } catch (err) {
        if (generation !== this.generation) return;
        this.failed.set(key, Date.now());
        this.error = describe(err);
      } finally {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
        this.onChange();
      }
    })();
    this.inFlight.set(key, promise);
  }
}

const RETRY_MS = 30_000;

function googleEditor(client: OAuth2Client): Editor {
  return {
    async quickAdd(text, day) {
      // Google parses dates relative to today; name the selected day so "Lunch 1pm"
      // lands where the cursor is.
      const onDay = day.hasSame(DateTime.local(), 'day') ? text : `${text} on ${day.toFormat('d LLLL yyyy')}`;
      const created = fromGoogle(await quickAdd(client, onDay), 'primary', '');
      return created && { title: created.title, start: created.start };
    },
    create: async (draft) => void (await createEvent(client, draft)),
    update: (event, changes, notifyGuests, scope) => updateEvent(client, event, changes, notifyGuests, scope),
    remove: (event, notifyGuests, scope) => deleteEvent(client, event, notifyGuests, scope),
    respond: (event, response) => respond(client, event, response),
  };
}

function monthKeys(days: DateTime[]): string[] {
  return [...new Set(days.map((d) => d.toFormat('yyyy-MM')))];
}

export function describe(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { error?: { message?: string } } }; message?: string };
  const status = e.response?.status;
  const message = e.response?.data?.error?.message ?? e.message ?? String(err);
  if (status === 401 || /invalid_grant/.test(message)) return 'Google sign-in expired — run `ktcal setup`';
  if (status === 412) return 'The event was changed elsewhere meanwhile: refresh (r) and try again';
  return status ? `Google API ${status}: ${message}` : message;
}
