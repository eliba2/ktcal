// Render the app with demo data to PNG (via SVG + rsvg-convert) for the README:
//   tsx scripts/screenshot.tsx [outDir=docs] [columns=120] [rows=34]
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'ink';
import React from 'react';
import { App } from '../src/app.js';
import { graphemes, width as textWidth } from '../src/canvas.js';
import { demoCalendars, DemoSource } from '../src/demo.js';
import type { View } from '../src/dates.js';

const [outDir = 'docs', cols = '120', rows = '34'] = process.argv.slice(2);
const columns = Number(cols);
const height = Number(rows);

// The app sizes itself from stdout; renderToString has no terminal.
Object.assign(process.stdout, { columns, rows: height });

const settings = { calendars: demoCalendars, weekStart: 1 as const, dayStart: 8, dayEnd: 19, refreshMinutes: 0 };
const BG = '#1e1e2e';
const FG = '#cdd6f4';
const CELL_W = 8.4;
const CELL_H = 18;
const PAD = 16;
const FONT = "'JetBrains Mono', 'IBM Plex Mono', Menlo, monospace";
/** The 16 basic colours chalk uses for named colours (Ink's color="red" etc.). */
const BASIC = ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'];
const BRIGHT = ['#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'];

mkdirSync(outDir, { recursive: true });
for (const view of ['month', 'week'] as View[]) {
  const ansi = renderToString(
    <App store={new DemoSource()} settings={settings} calendars={demoCalendars} subscribe={() => {}} initialView={view} />,
    { columns },
  );
  const svgPath = join(outDir, `${view}.svg`);
  writeFileSync(svgPath, toSvg(ansi.split('\n').slice(0, height - 1)));
  try {
    execFileSync('rsvg-convert', ['-z', '2', '-o', join(outDir, `${view}.png`), svgPath]);
    rmSync(svgPath); // the PNG renders the same everywhere; the SVG depends on the viewer's fonts
  } catch {
    console.warn('rsvg-convert not found; wrote SVG only');
  }
  console.log(`wrote ${join(outDir, view)}.*`);
}

interface Pen {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

/** Minimal SGR interpreter: enough for what Ink and the Canvas emit. */
function toSvg(lines: string[]): string {
  const w = Math.round(columns * CELL_W + PAD * 2);
  const h = Math.round(lines.length * CELL_H + PAD * 2);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="100%" height="100%" rx="10" fill="${BG}"/>`,
    `<g font-family="${FONT}" font-size="14" xml:space="preserve">`,
  ];
  lines.forEach((line, row) => {
    let pen: Pen = {};
    let col = 0;
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (sgr) {
        pen = apply(pen, sgr[1]!);
        continue;
      }
      if (!part) continue;
      let fg = pen.fg ?? FG;
      let bg = pen.bg;
      if (pen.inverse) [fg, bg] = [bg ?? BG, fg];
      const x = PAD + col * CELL_W;
      const y = PAD + row * CELL_H;
      const cells = textWidth(part);
      if (bg) out.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${(cells * CELL_W + 0.5).toFixed(1)}" height="${CELL_H}" fill="${bg}"/>`);
      // One <text> per grapheme pins each to its cell, whatever the font's advance width.
      let c = col;
      for (const g of graphemes(part)) {
        // rsvg-convert can't draw colour emoji; leave their cells blank rather than show tofu.
        if (g.trim() && !/\p{Extended_Pictographic}/u.test(g)) {
          const attrs = [
            `x="${(PAD + c * CELL_W).toFixed(1)}"`,
            `y="${y + 13}"`,
            `fill="${fg}"`,
            pen.bold ? 'font-weight="bold"' : '',
            pen.dim ? 'fill-opacity="0.55"' : '',
            pen.strike ? 'text-decoration="line-through"' : '',
          ];
          out.push(`<text ${attrs.filter(Boolean).join(' ')}>${escape(g)}</text>`);
        }
        c += textWidth(g);
      }
      col += cells;
    }
  });
  out.push('</g></svg>');
  return out.join('\n');
}

function apply(pen: Pen, params: string): Pen {
  const p = params === '' ? [0] : params.split(';').map(Number);
  const next = { ...pen };
  for (let i = 0; i < p.length; i++) {
    const n = p[i]!;
    if (n === 0) Object.keys(next).forEach((k) => delete next[k as keyof Pen]);
    else if (n === 1) next.bold = true;
    else if (n === 2) next.dim = true;
    else if (n === 22) next.bold = next.dim = false;
    else if (n === 7) next.inverse = true;
    else if (n === 27) next.inverse = false;
    else if (n === 9) next.strike = true;
    else if (n === 29) next.strike = false;
    else if (n === 39) delete next.fg;
    else if (n === 49) delete next.bg;
    else if ((n === 38 || n === 48) && p[i + 1] === 2) {
      const hex = '#' + p.slice(i + 2, i + 5).map((v) => v.toString(16).padStart(2, '0')).join('');
      next[n === 38 ? 'fg' : 'bg'] = hex;
      i += 4;
    } else if (n >= 30 && n <= 37) next.fg = BASIC[n - 30];
    else if (n >= 90 && n <= 97) next.fg = BRIGHT[n - 90];
    else if (n >= 40 && n <= 47) next.bg = BASIC[n - 40];
    else if (n >= 100 && n <= 107) next.bg = BRIGHT[n - 100];
  }
  return next;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
