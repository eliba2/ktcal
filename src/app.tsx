import { spawn } from 'node:child_process';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { truncate } from './canvas.js';
import { BADGES, displayUrl, eventLinks, hyperlink } from './links.js';
import { htmlToText, wrap } from './text.js';
import type { CalendarRef, Settings } from './config.js';
import { periodBounds, shiftPeriod, title, visibleDays, type View } from './dates.js';
import { eventsOnDay, type CalEvent, type Draft, type Response, type Scope } from './events.js';
import { editField, field, FieldView, type FieldState } from './field.js';
import { describeWhen, EventForm } from './form.js';
import { describe, type EventSource } from './store.js';
import type { ViewProps } from './views/common.js';
import { renderMonth } from './views/month.js';
import { renderTimeGrid } from './views/timegrid.js';

interface Props {
  store: EventSource;
  /** Lets the store trigger re-renders when fetched data arrives. */
  subscribe: (listener: () => void) => void;
  settings: Settings;
  calendars: CalendarRef[];
  initialView?: View;
}

type Overlay = 'help' | 'detail' | null;

/** The bottom line, vim-style: quick-add text entry, or a y/n question. */
type Prompt =
  | { kind: 'add'; text: FieldState }
  | { kind: 'confirm'; question: string; onYes: () => void }
  | { kind: 'scope'; question: string; onPick: (scope: Scope) => void };

const SCOPE_KEYS: Record<string, Scope> = { t: 'this', f: 'following', a: 'all' };
const SCOPE_DONE: Record<Scope, string> = { this: '', following: 'this and following ', all: 'all of ' };

/** The new / edit event form; `event` is null for a new one. */
type Form = { event: CalEvent | null };

/** Shown in the status bar until the next key press. */
type Message = { text: string; error?: boolean };

const RSVP: Record<string, { response: Response; done: string }> = {
  Y: { response: 'accepted', done: 'Accepted' },
  N: { response: 'declined', done: 'Declined' },
  M: { response: 'tentative', done: 'Maybe' },
};

/** Tab order, as shown in the header. */
const VIEWS: readonly View[] = ['month', 'week', 'day'];

export function App({ store, subscribe, settings, calendars, initialView = 'month' }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [size, setSize] = useState({ columns: stdout.columns, rows: stdout.rows });
  const [now, setNow] = useState(DateTime.local());
  const [view, setView] = useState<View>(initialView);
  const [cursor, setCursor] = useState(DateTime.local().startOf('day'));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [count, setCount] = useState('');
  const [pendingG, setPendingG] = useState(false);
  /** First `d` of `dd` (delete) seen. */
  const [pendingD, setPendingD] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  /** View to return to with C-o after Enter zoomed into a day (one level only). */
  const [returnView, setReturnView] = useState<View | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => subscribe(rerender), [subscribe]);
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on('resize', onResize);
    return () => void stdout.off('resize', onResize);
  }, [stdout]);
  useEffect(() => {
    const timer = setInterval(() => setNow(DateTime.local()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const days = useMemo(() => visibleDays(view, cursor, settings.weekStart), [view, cursor, settings.weekStart]);
  useEffect(() => {
    if (!settings.refreshMinutes) return;
    const timer = setInterval(() => store.refresh(days), settings.refreshMinutes * 60_000);
    return () => clearInterval(timer);
  }, [store, days, settings.refreshMinutes]);
  useEffect(() => store.prefetch(cursor), [store, cursor]);

  const events = store.eventsFor(days);
  const dayEvents = eventsOnDay(events, cursor);
  const selected = dayEvents.find((e) => e.key === selectedKey) ?? null;

  /** Move to a day; a function form builds on the latest cursor, so fast key presses don't use a stale one. */
  const moveCursor = (to: DateTime | ((from: DateTime) => DateTime)) => {
    setCursor((from) => (typeof to === 'function' ? to(from) : to).startOf('day'));
    setSelectedKey(null);
  };

  /** Run a change against Google, report the outcome, then reload what's on screen. */
  const save = (what: string, change: () => Promise<string>) => {
    setSaving(true);
    change()
      .then(
        (done) => setMessage({ text: done }),
        (err) => setMessage({ text: `${what} failed: ${describe(err)}`, error: true }),
      )
      .finally(() => {
        setSaving(false);
        store.refresh(days);
      });
  };

  const editingOff = () => setMessage({ text: 'Editing is off: run `ktcal setup --edit` to allow changes', error: true });

  /** The selected event, or null after saying how to select one. */
  const needSelection = (): CalEvent | null => {
    if (selected) return selected;
    const how = view === 'month' ? 'open the day (Enter), then pick one with j/k' : 'pick one with j/k';
    setMessage({ text: `Select an event first: ${how}`, error: true });
    return null;
  };

  /** Why `e` can't be changed by you, or null if it can. */
  const readOnlyReason = (e: CalEvent, action: string): string | null => {
    if (calendars.find((c) => c.id === e.calendarId)?.writable === false) return `This calendar is read-only: can't ${action} its events`;
    if (!e.mine) return action === 'delete' ? "You're a guest on this event: decline it with N instead" : "You're a guest on this event: only the organizer can change it";
    return null;
  };

  /** a / n / e / Y / N / M. Returns false for other keys. */
  const editKey = (input: string): boolean => {
    if (input !== 'a' && input !== 'n' && input !== 'e' && !RSVP[input]) return false;
    const editor = store.editor;
    if (!editor) editingOff();
    else if (input === 'a') setPrompt({ kind: 'add', text: field('') });
    else if (input === 'n') setForm({ event: null });
    else {
      const e = needSelection();
      if (!e) return true;
      if (input === 'e') {
        const reason = readOnlyReason(e, 'edit');
        if (reason) setMessage({ text: reason, error: true });
        else setForm({ event: e });
        return true;
      }
      const rsvp = RSVP[input]!;
      if (!e.response) {
        setMessage({ text: "Not an invitation: you're not on its guest list", error: true });
        return true;
      }
      save('Reply', async () => {
        await editor.respond(e, rsvp.response);
        return `${rsvp.done} "${e.title}"`;
      });
    }
    return true;
  };

  /** dd: delete the selected event after a y/n. */
  const requestDelete = () => {
    const editor = store.editor;
    if (!editor) return editingOff();
    const e = needSelection();
    if (!e) return;
    const reason = readOnlyReason(e, 'delete');
    if (reason) {
      setMessage({ text: reason, error: true });
      return;
    }
    const guests = guestCount(e);
    const emails = guests ? ` and email ${guests} guest${guests > 1 ? 's' : ''}` : '';
    const remove = (scope: Scope) => {
      setOverlay(null);
      setSelectedKey(null);
      save('Delete', async () => {
        await editor.remove(e, guests > 0, scope);
        return `Deleted ${SCOPE_DONE[scope]}"${e.title}"`;
      });
    };
    if (e.recurring) {
      setPrompt({
        kind: 'scope',
        question: `Delete "${e.title}"${emails}: (t)his occurrence · (f)ollowing ones too · (a)ll occurrences · Esc cancels`,
        onPick: remove,
      });
    } else {
      setPrompt({ kind: 'confirm', question: `Delete "${e.title}"${emails}? (y/n)`, onYes: () => remove('this') });
    }
  };

  /** Save the form; a rejection stays in the form, success closes it. */
  const saveForm = async (event: CalEvent | null, draft: Draft, changes: Partial<Draft>, scope: Scope) => {
    const editor = store.editor!;
    if (event) await editor.update(event, changes, guestCount(event) > 0 || draft.guests.length > 0, scope);
    else await editor.create(draft);
    setForm(null);
    setOverlay(null);
    moveCursor(draft.start);
    setMessage({ text: `${event ? 'Saved' : 'Added'} "${draft.title || '(no title)'}", ${describeWhen(draft)}` });
    store.refresh(visibleDays(view, draft.start, settings.weekStart));
  };

  const addEvent = (text: string) => {
    setPrompt(null);
    const editor = store.editor;
    if (!text.trim() || !editor) return;
    save('Add', async () => {
      const created = await editor.quickAdd(text.trim(), cursor);
      if (!created) return 'Added';
      moveCursor(created.start);
      return `Added "${created.title}" on ${created.start.toFormat('ccc d LLL, HH:mm')}`;
    });
  };

  // While the bottom-line prompt is open it owns the keyboard.
  useInput(
    (input, key) => {
      if (prompt?.kind === 'confirm') {
        setPrompt(null);
        if (input === 'y') prompt.onYes();
      } else if (prompt?.kind === 'scope') {
        setPrompt(null);
        const scope = SCOPE_KEYS[input];
        if (scope) prompt.onPick(scope);
      } else if (prompt?.kind === 'add') {
        if (key.escape) setPrompt(null);
        else if (key.return) addEvent(prompt.text.value);
        else {
          const text = editField(prompt.text, input, key);
          if (text) setPrompt({ kind: 'add', text });
        }
      }
    },
    { isActive: prompt !== null && form === null },
  );

  useInput((chunk, key) => {
    setMessage(null);
    // Keys pressed faster than a render (a held-down key) reach us as one chunk, e.g.
    // "lll": take a run of one key as that key with a count.
    const repeat = /^(.)\1+$/u.test(chunk) ? chunk.length : 1;
    const input = repeat > 1 ? chunk[0]! : chunk;
    // dd deletes; a lone d (day view) leaves the selection in place for the second d.
    const wasPendingD = pendingD;
    setPendingD(false);
    if (input === 'd' && (wasPendingD || repeat > 1) && (selected || overlay === 'detail')) {
      requestDelete();
      return;
    }
    // Overlays swallow everything except their own keys.
    if (overlay) {
      if (overlay === 'detail' && input === 'd') return setPendingD(true);
      if (overlay === 'detail' && editKey(input)) return;
      if (key.escape || input === 'q' || key.return || (overlay === 'help' && input === '?')) setOverlay(null);
      else if (overlay === 'detail' && input === 'o' && selected?.htmlLink) openUrl(selected.htmlLink);
      else if (overlay === 'detail' && input === 'O' && selected?.meetLink) openUrl(selected.meetLink);
      else if (overlay === 'detail' && selected && /^[1-9]$/.test(input)) {
        const url = eventLinks(selected)[Number(input) - 1];
        if (url) openUrl(url);
      }
      return;
    }

    // vim-style count prefix: 3l, 2], …
    if (/^[0-9]$/.test(input) && !(input === '0' && count === '')) {
      setCount(count + chunk);
      return;
    }
    const n = Math.max(1, parseInt(count || '1', 10)) * repeat;
    setCount('');

    if (pendingG) {
      setPendingG(false);
      if (input === 'g') moveCursor((c) => periodBounds(view, c, settings.weekStart)[0]);
      return;
    }

    const step = (delta: number) => {
      if (dayEvents.length === 0) return;
      const index = dayEvents.findIndex((e) => e.key === selectedKey);
      const next = index === -1 ? (delta > 0 ? 0 : dayEvents.length - 1) : index + delta;
      setSelectedKey(dayEvents[Math.min(dayEvents.length - 1, Math.max(0, next))]!.key);
    };

    // An explicit view switch drops the C-o return point.
    const switchView = (to: View) => {
      setView(to);
      setReturnView(null);
    };

    // Ctrl chords first: Ink reports C-d / C-u / C-o as input 'd' / 'u' / 'o' with key.ctrl.
    if (key.ctrl && input === 'o') {
      if (returnView) {
        setView(returnView);
        setReturnView(null);
      }
    } else if (key.ctrl && input === 'u') moveCursor((c) => shiftPeriod(view, c, -n));
    else if (key.ctrl && input === 'd') moveCursor((c) => shiftPeriod(view, c, n));
    else if (key.ctrl) return;
    else if (input === 'q') exit();
    else if (input === 'h' || key.leftArrow) moveCursor((c) => c.minus({ days: n }));
    else if (input === 'l' || key.rightArrow) moveCursor((c) => c.plus({ days: n }));
    else if (input === 'j' || key.downArrow) {
      if (view === 'month') moveCursor((c) => c.plus({ weeks: n }));
      else step(n);
    } else if (input === 'k' || key.upArrow) {
      if (view === 'month') moveCursor((c) => c.minus({ weeks: n }));
      else step(-n);
    } else if (input === '[' || key.pageUp) moveCursor((c) => shiftPeriod(view, c, -n));
    else if (input === ']' || key.pageDown) moveCursor((c) => shiftPeriod(view, c, n));
    else if (input === 'g') {
      if (repeat > 1) moveCursor((c) => periodBounds(view, c, settings.weekStart)[0]);
      else setPendingG(true);
    }
    else if (input === 'G') moveCursor((c) => periodBounds(view, c, settings.weekStart)[1]);
    else if (input === '0' || input === '^') moveCursor((c) => visibleWeekStart(c, settings));
    else if (input === '$') moveCursor((c) => visibleWeekStart(c, settings).plus({ days: 6 }));
    else if (input === 't') moveCursor(DateTime.local());
    else if (input === 'm') switchView('month');
    else if (input === 'w') switchView('week');
    else if (input === 'd') {
      switchView('day');
      if (selected) setPendingD(true);
    }
    else if (key.tab) switchView(VIEWS[(VIEWS.indexOf(view) + (key.shift ? -1 : 1) + VIEWS.length) % VIEWS.length]!);
    else if (input === 'r') store.refresh(days);
    else if (input === '?') setOverlay('help');
    else if (input === 'o' && selected?.htmlLink) openUrl(selected.htmlLink);
    else if (input === 'O' && selected?.meetLink) openUrl(selected.meetLink);
    else if (editKey(input)) return;
    else if (key.escape) setSelectedKey(null);
    else if (key.return) {
      if (selected) setOverlay('detail');
      else if (view !== 'day') {
        setReturnView(view);
        setView('day');
      }
    }
  }, { isActive: prompt === null && form === null });

  // Ink scrolls the terminal if output reaches the last row, so leave it empty.
  const width = size.columns;
  const bodyHeight = Math.max(1, size.rows - 3);
  const viewProps: ViewProps = {
    events,
    cursor,
    selectedKey,
    now,
    width,
    height: bodyHeight,
    weekStart: settings.weekStart,
    dayStart: settings.dayStart,
    dayEnd: settings.dayEnd,
  };

  let body: React.ReactNode;
  if (form) {
    const own = form.event && (calendars.find((c) => c.id === form.event!.calendarId) ?? { id: form.event.calendarId, name: form.event.calendarId, color: form.event.color });
    body = (
      <EventForm
        event={form.event}
        day={cursor}
        calendars={own ? [own] : calendars.filter((c) => c.writable)}
        width={width}
        height={bodyHeight}
        onSave={(draft, changes, scope) => saveForm(form.event, draft, changes, scope)}
        onClose={() => setForm(null)}
      />
    );
  } else if (overlay === 'help') body = <Help height={bodyHeight} />;
  else if (overlay === 'detail' && selected)
    body = <Detail event={selected} calendars={calendars} height={bodyHeight} width={width} editable={store.editor !== null} />;
  else {
    const lines = view === 'month' ? renderMonth(viewProps) : renderTimeGrid(days, viewProps);
    body = <Text>{lines.join('\n')}</Text>;
  }

  return (
    <Box flexDirection="column" width={width}>
      <Header view={view} heading={title(view, cursor, settings.weekStart)} width={width} />
      <Box height={bodyHeight} flexDirection="column">
        {body}
      </Box>
      {prompt?.kind === 'add' ? (
        <Box width={width}>
          <Text bold>{` Add on ${cursor.toFormat('ccc d LLL')}: `}</Text>
          <FieldView
            state={prompt.text}
            focused
            width={width - 22}
            placeholder="Lunch with Dana 1pm (Enter adds, Esc cancels)"
          />
        </Box>
      ) : prompt ? (
        <Text bold color="yellow">
          {truncate(` ${prompt.question}`, width - 1)}
        </Text>
      ) : (
        <StatusBar
          width={width}
          loading={store.loading}
          saving={saving}
          error={store.error}
          message={message}
          pending={count + (pendingG ? 'g' : '') + (pendingD ? 'd' : '')}
          info={selected ? `${selected.title} · ${timeRange(selected)}` : `${dayEvents.length} event(s) on ${cursor.toFormat('ccc d LLL')}`}
        />
      )}
    </Box>
  );
}

function guestCount(e: CalEvent): number {
  return e.attendees?.filter((a) => !a.self).length ?? 0;
}

function visibleWeekStart(cursor: DateTime, settings: Settings): DateTime {
  return periodBounds('week', cursor, settings.weekStart)[0];
}

function Header({ view, heading, width }: { view: View; heading: string; width: number }) {
  const tabs = VIEWS.map((v) => (
    <Text key={v} inverse={v === view} bold={v === view} dimColor={v !== view}>
      {` ${v[0]!.toUpperCase()}${v.slice(1)} `}
    </Text>
  ));
  return (
    <Box width={width} justifyContent="space-between">
      <Text bold> {heading}</Text>
      <Box>{tabs}</Box>
    </Box>
  );
}

function StatusBar(p: {
  width: number;
  loading: boolean;
  saving: boolean;
  error: string | null;
  message: Message | null;
  pending: string;
  info: string;
}) {
  const right = `${p.pending ? p.pending + '  ' : ''}? help  q quit `;
  const error = p.message?.error ? p.message.text : p.error;
  const left = p.saving
    ? ' ⟳ saving…'
    : error
      ? ` ✗ ${error}`
      : p.message
        ? ` ✓ ${p.message.text}`
        : p.loading
          ? ' ⟳ loading…'
          : ` ${p.info}`;
  return (
    <Box width={p.width} justifyContent="space-between">
      <Text color={error ? 'red' : p.message ? 'green' : undefined} dimColor={!error && !p.message}>
        {truncate(left, Math.max(0, p.width - right.length - 1))}
      </Text>
      <Text dimColor>{right}</Text>
    </Box>
  );
}

const HELP: [string, string][] = [
  ['h / l', 'previous / next day'],
  ['j / k', 'month: next / previous week · week/day: next / previous event'],
  ['C-u / C-d  [ ]', 'previous / next month, week or day'],
  ['gg / G', 'first / last day of the period'],
  ['0 / $', 'start / end of the week'],
  ['t', 'today'],
  ['m / w / d', 'month / week / day view'],
  ['Tab / S-Tab', 'cycle views forward / back'],
  ['Enter', 'event details (or open the day)'],
  ['C-o', 'back to the view Enter came from'],
  ['o / O', 'open event in Google Calendar / join the meeting'],
  ['1–9', 'details view: open the numbered link'],
  ['a', 'quick add on the selected day ("Lunch 1pm")'],
  ['n / e', 'new event on the selected day / edit the selected one'],
  ['dd', 'delete the selected event (asks first)'],
  ['Y / N / M', 'accept / decline / maybe an invitation'],
  ['r', 'refresh from Google'],
  ['Esc', 'clear selection / close'],
  ['q', 'close / quit'],
  ['<count>', 'prefix a motion, e.g. 3l, 2]'],
];

function Help({ height }: { height: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} height={Math.min(height, HELP.length + 4)}>
      <Text bold>Keys</Text>
      {HELP.map(([keys, what]) => (
        <Text key={keys}>
          <Text color="cyan">{keys.padEnd(15)}</Text>
          {what}
        </Text>
      ))}
    </Box>
  );
}

const RESPONSE_LABEL: Record<Response, string> = {
  accepted: 'going',
  declined: 'declined',
  tentative: 'maybe',
  needsAction: 'not answered yet',
};

function Detail(p: { event: CalEvent; calendars: CalendarRef[]; height: number; width: number; editable: boolean }) {
  const { event: e, calendars, height, width } = p;
  const calendar = calendars.find((c) => c.id === e.calendarId)?.name ?? e.calendarId;
  const going = e.attendees?.filter((a) => a.response === 'accepted').length ?? 0;
  const rows: [string, string | undefined][] = [
    ['When', timeRange(e, true)],
    ['Calendar', calendar],
    ['Where', e.location],
    ['Organizer', e.organizer],
    ['Guests', e.attendees?.length ? `${e.attendees.length} (${going} accepted)` : undefined],
    ['You', e.response ? RESPONSE_LABEL[e.response] : undefined],
  ];
  const links = eventLinks(e);
  const fixed = rows.filter(([, v]) => v).length + links.length + 5;
  const description = htmlToText(e.description ?? '')
    .split('\n')
    .flatMap((line) => wrap(line, width - 6))
    .slice(0, Math.max(0, height - fixed));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={e.color} paddingX={1} height={height}>
      <Text bold color={e.color}>
        {e.title}
      </Text>
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <Text key={k}>
            <Text dimColor>{k.padEnd(10)}</Text>
            {truncate(v!, width - 16)}
          </Text>
        ))}
      {/* Numbered for the 1–9 keys, and clickable (OSC 8) in terminals that support it. */}
      {links.map((url, i) => (
        <Text key={url}>
          <Text dimColor>{(i === 0 ? 'Links' : '').padEnd(10)}</Text>
          <Text color="cyan">{hyperlink(url, BADGES[i] ?? ' ')}</Text>
          {' ' + hyperlink(url, truncate(displayUrl(url), width - 18))}
        </Text>
      ))}
      {description.length > 0 && <Text> </Text>}
      {description.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      <Box flexGrow={1} />
      <Text dimColor>
        {truncate(
          [
            links.length > 1 ? `1–${Math.min(9, links.length)} open link` : links.length ? '1 open link' : '',
            'o Google Calendar',
            e.meetLink ? 'O join' : '',
            p.editable && e.response ? 'Y/N/M reply' : '',
            p.editable && e.mine ? 'e edit · dd delete' : '',
            'Esc close',
          ]
            .filter(Boolean)
            .join(' · '),
          width - 4,
        )}
      </Text>
    </Box>
  );
}

function timeRange(e: CalEvent, long = false): string {
  if (e.allDay) {
    const last = e.end.minus({ days: 1 });
    return last.hasSame(e.start, 'day')
      ? `${e.start.toFormat(long ? 'cccc d LLL' : 'ccc d LLL')}, all day`
      : `${e.start.toFormat('ccc d LLL')} – ${last.toFormat('ccc d LLL')}, all day`;
  }
  const sameDay = e.end.minus({ milliseconds: 1 }).hasSame(e.start, 'day');
  const start = e.start.toFormat(long ? 'cccc d LLL, HH:mm' : 'HH:mm');
  const end = sameDay ? e.end.toFormat('HH:mm') : e.end.toFormat('ccc d LLL, HH:mm');
  const minutes = e.end.diff(e.start, 'minutes').minutes;
  const duration = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  return `${start} – ${end}${long ? ` (${duration})` : ''}`;
}

/** Google event descriptions are HTML-ish; flatten to plain text. */
function openUrl(url: string): void {
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();
}
