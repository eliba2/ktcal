import type { DateTime } from 'luxon';

/**
 * Helpers for a series' `recurrence` lines (RFC 5545: "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10",
 * plus EXDATE / RDATE lines), used to split a series in two for "this and following".
 */

const isRule = (line: string) => /^(RRULE|EXRULE):/i.test(line);

function parts(line: string): [string, Map<string, string>] {
  const [name, value = ''] = line.split(':', 2) as [string, string?];
  return [name, new Map(value.split(';').filter(Boolean).map((p) => p.split('=', 2) as [string, string]))];
}

function join(name: string, params: Map<string, string>): string {
  return `${name}:${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`;
}

/** The COUNT of the series' rule, if it ends after a number of occurrences. */
export function ruleCount(lines: string[]): number | null {
  const rule = lines.find(isRule);
  const count = rule && parts(rule)[1].get('COUNT');
  return count ? Number(count) : null;
}

/**
 * End the series just before `occurrence`: rules get UNTIL (the day before, for all-day
 * series; one second before, in UTC, for timed ones) instead of any COUNT / UNTIL.
 */
export function endBefore(lines: string[], occurrence: DateTime, allDay: boolean): string[] {
  const until = allDay
    ? occurrence.minus({ days: 1 }).toFormat('yyyyMMdd')
    : occurrence.minus({ seconds: 1 }).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
  return lines.map((line) => {
    if (!isRule(line)) return line;
    const [name, params] = parts(line);
    params.delete('COUNT');
    params.set('UNTIL', until);
    return join(name, params);
  });
}

/** The rules for the second half of a split series, `skipped` occurrences in: a COUNT shrinks by that many. */
export function continueAfter(lines: string[], skipped: number): string[] {
  return lines.map((line) => {
    if (!isRule(line)) return line;
    const [name, params] = parts(line);
    const count = params.get('COUNT');
    if (count) params.set('COUNT', String(Number(count) - skipped));
    return join(name, params);
  });
}
