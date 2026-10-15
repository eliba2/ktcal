import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Box, Text, useInput, useStdout } from 'ink';
import { DateTime } from 'luxon';
import { useMemo, useState } from 'react';
import { truncate } from './canvas.js';
import type { CalendarRef } from './config.js';
import type { CalEvent, Draft, Scope } from './events.js';
import { editField, field, FieldView, type FieldState } from './field.js';
import { DATE_FORMAT, formatDuration, parseDate, parseTime } from './parse.js';
import { htmlToText } from './text.js';

type TextId = 'title' | 'date' | 'start' | 'end' | 'lastDay' | 'location' | 'guests';
type FieldId = TextId | 'calendar' | 'allDay' | 'notes';

export interface Values {
  text: Record<TextId, FieldState>;
  calendar: number;
  allDay: boolean;
  notes: string;
  /** Minutes from start to end time; kept when the start moves, set by editing the end. */
  duration: number;
}

interface Props {
  /** The event being edited; null for a new one. */
  event: CalEvent | null;
  /** The day a new event goes on. */
  day: DateTime;
  /** Calendars a new event can go in (the event's own calendar when editing). */
  calendars: CalendarRef[];
  width: number;
  height: number;
  /** Persist; on success the caller closes the form, a rejection is shown in the form. */
  onSave: (draft: Draft, changes: Partial<Draft>, scope: Scope) => Promise<void>;
  onClose: () => void;
}

const LABEL = 11;

/** New-event / edit-event form: Tab / ↑↓ move between fields, Ctrl-s saves, Esc cancels. */
export function EventForm(p: Props) {
  const { write } = useStdout();
  const initial = useMemo(() => initialValues(p.event, p.day, p.calendars), [p.event, p.day, p.calendars]);
  const [values, setValues] = useState(initial);
  const [focus, setFocus] = useState<FieldId>('title');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** Saving a recurring event: which occurrences? (the pending save) */
  const [askScope, setAskScope] = useState<{ draft: Draft; changes: Partial<Draft> } | null>(null);

  const fields: FieldId[] = [
    'title',
    'calendar',
    'date',
    'allDay',
    ...(values.allDay ? (['lastDay'] as const) : (['start', 'end'] as const)),
    'location',
    'guests',
    'notes',
  ];
  const result = toDraft(values, p.calendars, p.event);
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  // People who'd get an email: everyone invited after the save, plus anyone removed.
  const before = p.event ? guestsOf(p.event) : [];
  const after = 'draft' in result ? result.draft.guests : before;
  const emailed = new Set([...before, ...after].map((g) => g.toLowerCase())).size;

  const move = (delta: number) => {
    const i = fields.indexOf(focus);
    setFocus(fields[Math.min(fields.length - 1, Math.max(0, i + delta))]!);
  };

  const setText = (id: TextId, next: FieldState) =>
    setValues((v) => {
      const text = { ...v.text, [id]: next };
      // Moving the start keeps the duration; changing the end changes it.
      const start = minutesOf(text.start.value);
      const end = minutesOf(text.end.value);
      if (id === 'start' && start !== null) text.end = field(hhmm((start + v.duration) % 1440));
      if (id === 'end' && start !== null && end !== null && end !== start) {
        return { ...v, text, duration: (end - start + 1440) % 1440 };
      }
      return { ...v, text };
    });

  const save = () => {
    if ('error' in result) {
      setError(result.error);
      return;
    }
    const changes = p.event ? diff(p.event, result.draft) : result.draft;
    if (p.event && Object.keys(changes).length === 0) {
      p.onClose();
      return;
    }
    if (p.event?.recurring) setAskScope({ draft: result.draft, changes });
    else commit(result.draft, changes, 'this');
  };

  const commit = (draft: Draft, changes: Partial<Draft>, scope: Scope) => {
    if (scope !== 'this' && p.event && changes.start && !changes.start.hasSame(p.event.start, 'day')) {
      setError("Moving a series to another day isn't supported yet: save (t)his occurrence only, or change just the time");
      return;
    }
    setSaving(true);
    setError(null);
    p.onSave(draft, changes, scope).catch((err: unknown) => {
      setSaving(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  useInput(
    (input, key) => {
      if (confirmDiscard) {
        setConfirmDiscard(false);
        if (input === 'y') p.onClose();
        return;
      }
      if (askScope) {
        setAskScope(null);
        const scope = SCOPE_KEYS[input];
        if (scope) commit(askScope.draft, askScope.changes, scope);
        return;
      }
      setError(null);
      if (key.escape) {
        if (dirty) setConfirmDiscard(true);
        else p.onClose();
      } else if (key.ctrl && input === 's') save();
      else if (key.tab) move(key.shift ? -1 : 1);
      else if (key.downArrow) move(1);
      else if (key.upArrow) move(-1);
      else if (focus === 'notes') {
        if (key.return) {
          const notes = editInEditor(values.notes, write);
          if (notes !== null) setValues((v) => ({ ...v, notes }));
        }
      } else if (focus === 'calendar') {
        const step = key.leftArrow || input === 'h' ? -1 : key.rightArrow || input === 'l' || input === ' ' ? 1 : 0;
        if (key.return) move(1);
        else if (step && !p.event && p.calendars.length > 1) {
          setValues((v) => ({ ...v, calendar: (v.calendar + step + p.calendars.length) % p.calendars.length }));
        }
      } else if (focus === 'allDay') {
        if (key.return) move(1);
        else if (input === ' ' || input === 'h' || input === 'l' || key.leftArrow || key.rightArrow) {
          setValues((v) => ({ ...v, allDay: !v.allDay }));
        }
      } else if (key.return) move(1);
      else {
        const next = editField(values.text[focus], input, key);
        if (next) setText(focus, next);
      }
    },
    { isActive: !saving },
  );

  const inner = p.width - 4;
  const valueWidth = Math.max(10, inner - LABEL);
  const row = (id: FieldId, label: string, value: React.ReactNode) => (
    <Box key={id}>
      <Text bold={focus === id} color={focus === id ? 'cyan' : undefined} dimColor={focus !== id}>
        {(focus === id ? '› ' : '  ') + label.padEnd(LABEL - 2)}
      </Text>
      {value}
    </Box>
  );
  const text = (id: TextId, placeholder?: string) => (
    <FieldView state={values.text[id]} focused={focus === id} width={valueWidth} placeholder={placeholder} />
  );
  const calendar = p.calendars[values.calendar];
  const notesLines = values.notes ? values.notes.split('\n') : [];

  let footer: React.ReactNode;
  if (confirmDiscard) footer = <Text color="yellow" bold>Discard your changes? (y/n)</Text>;
  else if (askScope) {
    footer = (
      <Text color="yellow" bold>
        {truncate('Save for: (t)his occurrence · (f)ollowing ones too · (a)ll occurrences · Esc back', inner)}
      </Text>
    );
  }
  else if (saving) footer = <Text color="yellow">⟳ saving…</Text>;
  else if (error) footer = <Text color="red">{truncate(`✗ ${error}`, inner)}</Text>;
  else footer = <Text dimColor>{truncate('Tab/↑↓ move · Ctrl-s save · Esc cancel', inner)}</Text>;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={calendar?.color} paddingX={1} height={p.height}>
      <Text bold>{p.event ? `Edit "${truncate(p.event.title, inner - 7)}"` : 'New event'}</Text>
      <Text> </Text>
      {row('title', 'Title', text('title', '(no title)'))}
      {row(
        'calendar',
        'Calendar',
        <Text>
          <Text color={calendar?.color}>● </Text>
          {calendar?.name ?? '?'}
          <Text dimColor>{p.event ? '' : p.calendars.length > 1 ? '  ←/→' : ''}</Text>
        </Text>,
      )}
      {row('date', values.allDay ? 'First day' : 'Date', text('date', 'e.g. tomorrow, fri, 20 oct, 20/10'))}
      {row(
        'allDay',
        'All day',
        <Text>
          {values.allDay ? '[x]' : '[ ]'}
          <Text dimColor>{focus === 'allDay' ? '  space toggles' : ''}</Text>
        </Text>,
      )}
      {values.allDay
        ? row('lastDay', 'Last day', text('lastDay'))
        : [row('start', 'Starts', text('start', 'e.g. 13:30, 1:30pm')), row('end', 'Ends', text('end'))]}
      {row('location', 'Where', text('location'))}
      {row('guests', 'Guests', text('guests', 'emails, comma separated'))}
      {row(
        'notes',
        'Notes',
        <Text dimColor={!notesLines.length}>
          {notesLines.length ? truncate(notesLines[0]!, valueWidth - 12) : '(none)'}
          <Text dimColor>
            {notesLines.length > 1 ? ` +${notesLines.length - 1} lines` : ''}
            {focus === 'notes' ? '  Enter edits in $EDITOR' : ''}
          </Text>
        </Text>,
      )}
      <Text> </Text>
      {'error' in result ? (
        <Text color="red">{truncate(`  ${result.error}`, inner)}</Text>
      ) : (
        <Text color="green">{truncate(`  ${describeWhen(result.draft)}`, inner)}</Text>
      )}
      {p.event?.recurring && <Text dimColor>  A recurring event: saving asks which occurrences to change</Text>}
      {emailed > 0 && <Text dimColor>{`  Saving emails ${emailed} guest${emailed > 1 ? 's' : ''}`}</Text>}
      <Box flexGrow={1} />
      {footer}
    </Box>
  );
}

function initialValues(event: CalEvent | null, day: DateTime, calendars: CalendarRef[]): Values {
  if (event) {
    const lastDay = event.end.minus({ days: 1 });
    return {
      text: {
        title: field(event.title === '(no title)' ? '' : event.title),
        date: field(event.start.toFormat(DATE_FORMAT)),
        start: field(event.start.toFormat('HH:mm')),
        end: field(event.end.toFormat('HH:mm')),
        lastDay: field((event.allDay ? lastDay : event.start).toFormat(DATE_FORMAT)),
        location: field(event.location ?? ''),
        guests: field(guestsOf(event).join(', ')),
      },
      calendar: Math.max(0, calendars.findIndex((c) => c.id === event.calendarId)),
      allDay: event.allDay,
      notes: htmlToText(event.description ?? ''),
      duration: event.allDay ? 60 : (event.end.hour * 60 + event.end.minute - (event.start.hour * 60 + event.start.minute) + 1440) % 1440 || 1440,
    };
  }
  // New: the next full hour when adding today, otherwise 9:00; one hour long.
  const now = DateTime.local();
  const hour = day.hasSame(now, 'day') ? Math.min(23, now.hour + 1) : 9;
  return {
    text: {
      title: field(''),
      date: field(day.toFormat(DATE_FORMAT)),
      start: field(hhmm(hour * 60)),
      end: field(hhmm(((hour + 1) % 24) * 60)),
      lastDay: field(day.toFormat(DATE_FORMAT)),
      location: field(''),
      guests: field(''),
    },
    calendar: 0,
    allDay: false,
    notes: '',
    duration: 60,
  };
}

/** The form's values as an event, or what's wrong with them. */
export function toDraft(
  v: Values,
  calendars: CalendarRef[],
  original: CalEvent | null,
  today = DateTime.local(),
): { draft: Draft } | { error: string } {
  const calendar = calendars[v.calendar];
  if (!calendar) return { error: 'No calendar you can add events to' };
  const day = parseDate(v.text.date.value, today);
  if (!day) return { error: `Can't read the date "${v.text.date.value}"` };
  const guests = v.text.guests.value.split(/[\s,;]+/).filter(Boolean);
  const bad = guests.find((g) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(g));
  if (bad) return { error: `Not an email address: "${bad}"` };
  const base = {
    calendarId: calendar.id,
    title: v.text.title.value.trim(),
    location: v.text.location.value.trim(),
    description: v.notes,
    guests: [...new Map(guests.map((g) => [g.toLowerCase(), g])).values()],
  };
  if (v.allDay) {
    const last = parseDate(v.text.lastDay.value, today);
    if (!last) return { error: `Can't read the last day "${v.text.lastDay.value}"` };
    if (last < day) return { error: 'The last day is before the first day' };
    return { draft: { ...base, allDay: true, start: day, end: last.plus({ days: 1 }) } };
  }
  const start = parseTime(v.text.start.value);
  if (!start) return { error: `Can't read the start time "${v.text.start.value}"` };
  const end = parseTime(v.text.end.value);
  if (!end) return { error: `Can't read the end time "${v.text.end.value}"` };
  const from = day.set(start);
  // A timed event that spanned days keeps that span; otherwise an end before the start means next day.
  const span = original && !original.allDay ? original.end.startOf('day').diff(original.start.startOf('day'), 'days').days : 0;
  let to = day.plus({ days: span }).set(end);
  if (to <= from) to = to.plus({ days: 1 });
  return { draft: { ...base, allDay: false, start: from, end: to } };
}

/** The fields of `draft` that differ from `e`. */
function diff(e: CalEvent, draft: Draft): Partial<Draft> {
  const changes: Partial<Draft> = {};
  if (draft.title !== (e.title === '(no title)' ? '' : e.title)) changes.title = draft.title;
  if (draft.location !== (e.location ?? '')) changes.location = draft.location;
  if (draft.description !== htmlToText(e.description ?? '')) changes.description = draft.description;
  const sorted = (list: string[]) => list.map((g) => g.toLowerCase()).sort().join(',');
  if (sorted(draft.guests) !== sorted(guestsOf(e))) changes.guests = draft.guests;
  if (draft.allDay !== e.allDay || !draft.start.equals(e.start) || !draft.end.equals(e.end)) {
    Object.assign(changes, { allDay: draft.allDay, start: draft.start, end: draft.end });
  }
  return changes;
}

/** "Thu 15 Oct 2026, 09:00 – 10:00 (1h)", "Thu 15 – Sat 17 Oct 2026, all day (3d)", … */
export function describeWhen(d: Pick<Draft, 'allDay' | 'start' | 'end'>): string {
  const minutes = d.end.diff(d.start, 'minutes').minutes;
  if (d.allDay) {
    const last = d.end.minus({ days: 1 });
    const range = last.hasSame(d.start, 'day')
      ? d.start.toFormat(DATE_FORMAT)
      : `${d.start.toFormat('ccc d LLL')} – ${last.toFormat(DATE_FORMAT)}`;
    return `${range}, all day (${formatDuration(minutes)})`;
  }
  return d.end.hasSame(d.start, 'day')
    ? `${d.start.toFormat(DATE_FORMAT)}, ${d.start.toFormat('HH:mm')} – ${d.end.toFormat('HH:mm')} (${formatDuration(minutes)})`
    : `${d.start.toFormat('ccc d LLL, HH:mm')} → ${d.end.toFormat('ccc d LLL, HH:mm')} (${formatDuration(minutes)})`;
}

/**
 * Edit `text` in $VISUAL / $EDITOR (falling back to nvim, then vi) on the real terminal.
 * The editor takes over the screen, so afterwards re-enter the alternate screen and have
 * Ink repaint its whole frame (Ink's write() clears and restores its output). Null if
 * the editor failed.
 */
function editInEditor(text: string, write: (data: string) => void): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'ktcal-'));
  const file = join(dir, 'notes.md');
  try {
    writeFileSync(file, text ? text + '\n' : '', { mode: 0o600 });
    const res = spawnSync('/bin/sh', ['-c', '${VISUAL:-${EDITOR:-$(command -v nvim || echo vi)}} "$1"', 'sh', file], {
      stdio: 'inherit',
    });
    return res.status === 0 ? readFileSync(file, 'utf8').replace(/\s+$/, '') : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
  }
}

const SCOPE_KEYS: Record<string, Scope> = { t: 'this', f: 'following', a: 'all' };

/** Emails of the people invited to `e`: not you, not rooms. */
function guestsOf(e: CalEvent): string[] {
  return (e.attendees ?? []).filter((a) => !a.self && !a.resource).map((a) => a.email);
}

function minutesOf(text: string): number | null {
  const t = parseTime(text);
  return t && t.hour * 60 + t.minute;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
