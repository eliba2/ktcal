import type { CalEvent } from './events.js';

/** Labels for links 1–9 in the details view; later links get none. */
export const BADGES = ['❶', '❷', '❸', '❹', '❺', '❻', '❼', '❽', '❾'];

/**
 * An event's links, in the order people want them: the video meeting, then URLs in the
 * location, then in the description (from both its href attributes and its plain text).
 * Without duplicates; the "open in Google Calendar" link is left out (that's `o`).
 */
export function eventLinks(e: CalEvent): string[] {
  const found = [e.meetLink, ...urls(e.location ?? ''), ...urls(e.description ?? '')].filter(Boolean) as string[];
  const seen = new Set<string>();
  return found.filter((url) => {
    const key = url.replace(/\/$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function urls(text: string): string[] {
  const unescaped = text.replace(/&amp;/g, '&');
  const hrefs = [...unescaped.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
  const plain = unescaped.replace(/<[^>]+>/g, ' ').match(/https?:\/\/[^\s<>"'`]+/g) ?? [];
  // A sentence's closing punctuation isn't part of the URL; neither is an unmatched ")".
  const tidy = (url: string) => url.replace(/[.,;:!?]+$/, '').replace(/\)$/, (p) => (url.includes('(') ? p : ''));
  return [...hrefs, ...plain].filter((u) => /^https?:\/\//i.test(u)).map(tidy);
}

/**
 * Text the terminal shows as a clickable link to `url` (OSC 8; kitty and most modern
 * terminals). Terminated with BEL, not ESC \: Ink's layout mis-measures the latter and
 * drops the rest of the line.
 */
export function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** A URL as shown: no scheme, no "www.". */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}
