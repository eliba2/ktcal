import { Text, type Key } from 'ink';
import { graphemes, width as textWidth } from './canvas.js';

/** A one-line text field's state; `cursor` counts graphemes. */
export interface FieldState {
  value: string;
  cursor: number;
}

export const field = (value: string): FieldState => ({ value, cursor: graphemes(value).length });

/**
 * Apply a key press, readline-style: typing / pasting, Backspace, ←/→, Ctrl-a/e (start/end),
 * Ctrl-u/k (delete to start/end), Ctrl-w (delete word). Returns null for keys it doesn't
 * handle (Tab, Enter, Esc, ↑/↓, other Ctrl chords) so the caller can.
 */
export function editField(s: FieldState, input: string, key: Key): FieldState | null {
  const chars = graphemes(s.value);
  const at = (cursor: number, value = chars) => ({ value: value.join(''), cursor });
  if (key.tab || key.return || key.escape || key.upArrow || key.downArrow) return null;
  if (key.leftArrow) return at(Math.max(0, s.cursor - 1));
  if (key.rightArrow) return at(Math.min(chars.length, s.cursor + 1));
  if (key.home || (key.ctrl && input === 'a')) return at(0);
  if (key.end || (key.ctrl && input === 'e')) return at(chars.length);
  // Ink reports the Backspace key as `delete` (it sends DEL) and Ctrl-h as `backspace`.
  if (key.backspace || key.delete) {
    if (s.cursor === 0) return s;
    return at(s.cursor - 1, [...chars.slice(0, s.cursor - 1), ...chars.slice(s.cursor)]);
  }
  if (key.ctrl && input === 'u') return at(0, chars.slice(s.cursor));
  if (key.ctrl && input === 'k') return at(s.cursor, chars.slice(0, s.cursor));
  if (key.ctrl && input === 'w') {
    let from = s.cursor;
    while (from > 0 && chars[from - 1] === ' ') from--;
    while (from > 0 && chars[from - 1] !== ' ') from--;
    return at(from, [...chars.slice(0, from), ...chars.slice(s.cursor)]);
  }
  if (key.ctrl || key.meta || !input) return null;
  // A paste arrives as one chunk; a one-line field keeps it on one line.
  const typed = graphemes(input.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, ''));
  return at(s.cursor + typed.length, [...chars.slice(0, s.cursor), ...typed, ...chars.slice(s.cursor)]);
}

/** The field, scrolled so the cursor stays visible within `width` columns. */
export function FieldView(p: { state: FieldState; focused: boolean; width: number; placeholder?: string }) {
  const chars = graphemes(p.state.value);
  if (!p.focused) {
    return chars.length ? <Text>{fit(chars, 0, p.width)}</Text> : <Text dimColor>{p.placeholder ?? ''}</Text>;
  }
  if (!chars.length) {
    return (
      <Text>
        <Text inverse> </Text>
        <Text dimColor>{p.placeholder ?? ''}</Text>
      </Text>
    );
  }
  // Scroll: start far enough right that the cursor (one extra cell at the end) fits.
  let start = 0;
  while (start < p.state.cursor && textWidth(chars.slice(start, p.state.cursor + 1).join('')) > p.width - 1) start++;
  const before = chars.slice(start, p.state.cursor).join('');
  const under = chars[p.state.cursor] ?? ' ';
  const after = fit(chars, p.state.cursor + 1, p.width - 1 - textWidth(before));
  return (
    <Text>
      {before}
      <Text inverse>{under}</Text>
      {after}
    </Text>
  );
}

/** Graphemes from `from` that fit in `width` columns. */
function fit(chars: string[], from: number, width: number): string {
  let out = '';
  for (const g of chars.slice(from)) {
    if (textWidth(out + g) > width) break;
    out += g;
  }
  return out;
}
