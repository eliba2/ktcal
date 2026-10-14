import { spawn } from 'node:child_process';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { truncate } from './canvas.js';
import type { CalendarRef, Settings } from './config.js';
import { periodBounds, shiftPeriod, title, visibleDays, type View } from './dates.js';
import { eventsOnDay, type CalEvent } from './events.js';
import type { EventSource } from './store.js';
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
  /** View to return to with C-o after Enter zoomed into a day (one level only). */
  const [returnView, setReturnView] = useState<View | null>(null);

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

  const moveCursor = (to: DateTime) => {
    setCursor(to.startOf('day'));
    setSelectedKey(null);
  };

  useInput((input, key) => {
    // Overlays swallow everything except their own keys.
    if (overlay) {
      if (key.escape || input === 'q' || key.return || (overlay === 'help' && input === '?')) setOverlay(null);
      else if (overlay === 'detail' && input === 'o' && selected?.htmlLink) openUrl(selected.htmlLink);
      else if (overlay === 'detail' && input === 'O' && selected?.meetLink) openUrl(selected.meetLink);
      return;
    }

    // vim-style count prefix: 3l, 2], …
    if (/^[0-9]$/.test(input) && !(input === '0' && count === '')) {
      setCount(count + input);
      return;
    }
    const n = Math.max(1, parseInt(count || '1', 10));
    setCount('');

    if (pendingG) {
      setPendingG(false);
      if (input === 'g') moveCursor(periodBounds(view, cursor, settings.weekStart)[0]);
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
    } else if (key.ctrl && input === 'u') moveCursor(shiftPeriod(view, cursor, -n));
    else if (key.ctrl && input === 'd') moveCursor(shiftPeriod(view, cursor, n));
    else if (key.ctrl) return;
    else if (input === 'q') exit();
    else if (input === 'h' || key.leftArrow) moveCursor(cursor.minus({ days: n }));
    else if (input === 'l' || key.rightArrow) moveCursor(cursor.plus({ days: n }));
    else if (input === 'j' || key.downArrow) {
      if (view === 'month') moveCursor(cursor.plus({ weeks: n }));
      else step(n);
    } else if (input === 'k' || key.upArrow) {
      if (view === 'month') moveCursor(cursor.minus({ weeks: n }));
      else step(-n);
    } else if (input === '[' || key.pageUp) moveCursor(shiftPeriod(view, cursor, -n));
    else if (input === ']' || key.pageDown) moveCursor(shiftPeriod(view, cursor, n));
    else if (input === 'g') setPendingG(true);
    else if (input === 'G') moveCursor(periodBounds(view, cursor, settings.weekStart)[1]);
    else if (input === '0' || input === '^') moveCursor(visibleWeekStart(cursor, settings));
    else if (input === '$') moveCursor(visibleWeekStart(cursor, settings).plus({ days: 6 }));
    else if (input === 't') moveCursor(DateTime.local());
    else if (input === 'm') switchView('month');
    else if (input === 'w') switchView('week');
    else if (input === 'd') switchView('day');
    else if (key.tab) switchView(VIEWS[(VIEWS.indexOf(view) + (key.shift ? -1 : 1) + VIEWS.length) % VIEWS.length]!);
    else if (input === 'r') store.refresh(days);
    else if (input === '?') setOverlay('help');
    else if (input === 'o' && selected?.htmlLink) openUrl(selected.htmlLink);
    else if (input === 'O' && selected?.meetLink) openUrl(selected.meetLink);
    else if (key.escape) setSelectedKey(null);
    else if (key.return) {
      if (selected) setOverlay('detail');
      else if (view !== 'day') {
        setReturnView(view);
        setView('day');
      }
    }
  });

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
  if (overlay === 'help') body = <Help height={bodyHeight} />;
  else if (overlay === 'detail' && selected) body = <Detail event={selected} calendars={calendars} height={bodyHeight} width={width} />;
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
      <StatusBar
        width={width}
        loading={store.loading}
        error={store.error}
        pending={count + (pendingG ? 'g' : '')}
        info={selected ? `${selected.title} · ${timeRange(selected)}` : `${dayEvents.length} event(s) on ${cursor.toFormat('ccc d LLL')}`}
      />
    </Box>
  );
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

function StatusBar(p: { width: number; loading: boolean; error: string | null; pending: string; info: string }) {
  const right = `${p.pending ? p.pending + '  ' : ''}? help  q quit `;
  const left = p.error ? ` ✗ ${p.error}` : p.loading ? ' ⟳ loading…' : ` ${p.info}`;
  return (
    <Box width={p.width} justifyContent="space-between">
      <Text color={p.error ? 'red' : undefined} dimColor={!p.error}>
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

function Detail({ event: e, calendars, height, width }: { event: CalEvent; calendars: CalendarRef[]; height: number; width: number }) {
  const calendar = calendars.find((c) => c.id === e.calendarId)?.name ?? e.calendarId;
  const going = e.attendees?.filter((a) => a.response === 'accepted').length ?? 0;
  const rows: [string, string | undefined][] = [
    ['When', timeRange(e, true)],
    ['Calendar', calendar],
    ['Where', e.location],
    ['Meeting', e.meetLink],
    ['Organizer', e.organizer],
    ['Guests', e.attendees?.length ? `${e.attendees.length} (${going} accepted)` : undefined],
    ['You', e.declined ? 'declined' : undefined],
  ];
  const fixed = rows.filter(([, v]) => v).length + 5;
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
      {description.length > 0 && <Text> </Text>}
      {description.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      <Box flexGrow={1} />
      <Text dimColor>o open in Google Calendar · O join meeting · Esc close</Text>
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
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wrap(line: string, w: number): string[] {
  if (w <= 0) return [];
  if (line.length <= w) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > w) {
    const cut = rest.lastIndexOf(' ', w);
    const at = cut > w / 2 ? cut : w;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  return [...out, rest];
}

function openUrl(url: string): void {
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();
}
