/** Plain text from an event description, which Google stores as (light) HTML. */
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

export function wrap(line: string, w: number): string[] {
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
