import type { DateTime } from 'luxon';
import type { CalEvent } from '../events.js';
import type { Weekday } from '../dates.js';

/** Everything a view needs to draw itself into a width × height area. */
export interface ViewProps {
  events: CalEvent[];
  cursor: DateTime;
  /** Key of the selected event on the cursor day, if any. */
  selectedKey: string | null;
  now: DateTime;
  width: number;
  height: number;
  weekStart: Weekday;
  /** Working hours always shown by the week / day grid (events can extend it). */
  dayStart: number;
  dayEnd: number;
}

export const theme = {
  today: '#ff6b6b',
  nowLine: '#ff5f5f',
  grid: { dim: true } as const,
};

/** Split `total` columns into `parts` widths that differ by at most one. */
export function split(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}
