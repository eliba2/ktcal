import stringWidth from 'string-width';

/** Visual attributes of a cell. Colors are `#rrggbb` (truecolor). */
export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
}

interface Cell {
  /** Grapheme to print; '' marks the right half of a wide (2-column) grapheme. */
  ch: string;
  style: Style;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Display width of plain (non-ANSI) text. */
export function width(text: string): number {
  return stringWidth(text);
}

/** Cut plain text to at most `max` columns, ending with an ellipsis when it was cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (width(text) <= max) return text;
  let out = '';
  let used = 0;
  for (const g of graphemes(text)) {
    const w = width(g);
    if (used + w > max - 1) break;
    out += g;
    used += w;
  }
  return out + '…';
}

/** A fixed-size grid of styled cells, rendered to ANSI lines. */
export class Canvas {
  readonly width: number;
  readonly height: number;
  private cells: Cell[][];

  constructor(w: number, h: number) {
    this.width = Math.max(0, w);
    this.height = Math.max(0, h);
    this.cells = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ ch: ' ', style: {} })),
    );
  }

  /** Fill a rectangle with a character and style. */
  fill(x: number, y: number, w: number, h: number, ch: string, style: Style = {}): void {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) this.set(col, row, ch, style);
    }
  }

  /**
   * Write plain text at (x, y), clipped to `maxWidth` columns (and the canvas edge).
   * Returns the number of columns written.
   */
  text(x: number, y: number, text: string, style: Style = {}, maxWidth = Infinity): number {
    const limit = Math.min(maxWidth, this.width - x);
    let col = 0;
    for (const g of graphemes(text)) {
      const w = width(g);
      if (w === 0) continue;
      if (col + w > limit) break;
      this.set(x + col, y, g, style);
      if (w === 2) this.set(x + col + 1, y, '', style);
      col += w;
    }
    return col;
  }

  /** Merge extra attributes into the style of existing cells (keeps their characters). */
  restyle(x: number, y: number, w: number, h: number, patch: Style): void {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const cell = this.cells[row]?.[col];
        if (cell) cell.style = { ...cell.style, ...patch };
      }
    }
  }

  private set(x: number, y: number, ch: string, style: Style): void {
    const row = this.cells[y];
    if (!row || x < 0 || x >= this.width) return;
    // Overwriting half of a wide grapheme leaves the other half dangling: blank it.
    const prev = row[x];
    if (prev && prev.ch === '' && ch !== '' && row[x - 1]) row[x - 1] = { ch: ' ', style: row[x - 1]!.style };
    if (prev && prev.ch !== '' && width(prev.ch) === 2 && ch !== '' && row[x + 1]?.ch === '') {
      row[x + 1] = { ch: ' ', style: row[x + 1]!.style };
    }
    row[x] = { ch, style };
  }

  /** Render to one ANSI string per row, each exactly `width` columns wide. */
  lines(): string[] {
    return this.cells.map((row) => {
      let out = '';
      let current = '';
      for (const cell of row) {
        if (cell.ch === '') continue;
        const sgr = toSgr(cell.style);
        if (sgr !== current) {
          out += '\x1b[0m' + sgr;
          current = sgr;
        }
        out += cell.ch;
      }
      return out + (current ? '\x1b[0m' : '');
    });
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toSgr(s: Style): string {
  const codes: string[] = [];
  if (s.bold) codes.push('1');
  if (s.dim) codes.push('2');
  if (s.italic) codes.push('3');
  if (s.underline) codes.push('4');
  if (s.inverse) codes.push('7');
  if (s.strike) codes.push('9');
  if (s.fg) codes.push('38;2;' + hexToRgb(s.fg).join(';'));
  if (s.bg) codes.push('48;2;' + hexToRgb(s.bg).join(';'));
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}

/** Black or white, whichever reads better on `bg`. */
export function contrastFg(bg: string): string {
  const [r, g, b] = hexToRgb(bg);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1d1d1d' : '#ffffff';
}
