# ktcal

Google Calendar in the terminal (built for kitty, works in any truecolor terminal).
Read-only: month / week / day views with vim-style keys.

![Month view](docs/month.png)
![Week view](docs/week.png)

## Install

```sh
pnpm install
pnpm build
pnpm add -g "link:$PWD"   # puts `ktcal` on your PATH (pnpm 11; needs `pnpm setup` once)
```

Try it without Google: `ktcal demo` (or `pnpm dev demo`).

## Connect Google (one time)

1. In Google Cloud Console (a project under your Workspace org):
   - enable the **Google Calendar API**;
   - OAuth consent screen: audience **Internal**, add the scope
     `https://www.googleapis.com/auth/calendar.readonly`;
   - Credentials → Create OAuth client → **Desktop app** → Download JSON.
2. Run `ktcal setup` — it picks up the newest `~/Downloads/client_secret_*.json`
   (or pass a path: `ktcal setup ./client.json`), opens the browser for sign-in,
   then lets you choose which calendars to show.
3. Delete the downloaded JSON; ktcal keeps its own copy.

`ktcal calendars` re-picks calendars; `ktcal logout` revokes the token at Google and deletes it.

### What's stored where

Everything lives in `~/.config/ktcal/` (dir `0700`, files `0600`):

| File | Contents |
|---|---|
| `client.json` | the OAuth client (not very secret for Desktop apps, but kept private) |
| `token.json` | access + **refresh token** — a credential: anyone with it can read your calendars until revoked |
| `config.json` | chosen calendars and display settings |

ktcal only ever requests `calendar.readonly`, so a leaked token cannot create, change or delete
anything. Revoke it any time with `ktcal logout`, or at myaccount.google.com → Security →
Third-party connections. Nothing else is written to disk; events are cached in memory only.

## Keys

| Key | Action |
|---|---|
| `h` / `l` | previous / next day |
| `j` / `k` | month: next / previous week · week & day: next / previous event |
| `Ctrl-h` / `Ctrl-l`, `[` / `]` | previous / next month, week or day |
| `gg` / `G` | first / last day of the period |
| `0` / `$` | start / end of the week |
| `t` | today |
| `m` / `w` / `d` | month / week / day view |
| `Tab` / `Shift-Tab` | cycle views (month → week → day) forward / back |
| `Enter` | event details (or zoom into the day) |
| `Ctrl-o` | back to the view `Enter` zoomed in from (one level) |
| `o` / `O` | open event in Google Calendar / join its video meeting |
| `r` | refresh |
| `Esc` | clear selection / close |
| `q` | close / quit |
| `?` | help |

Motions take a count: `3l`, `2]`, …

## Settings

`~/.config/ktcal/config.json` (created by `ktcal setup`):

```json
{
  "weekStart": 1,        // 1 = Monday … 7 = Sunday
  "dayStart": 8,         // hours always shown in week/day view (events can widen it)
  "dayEnd": 19,
  "refreshMinutes": 5,   // background refresh; 0 = off
  "calendars": [ … ]
}
```

## Development

```sh
pnpm dev            # run from source (tsx)
pnpm dev demo       # …with demo data
pnpm test           # vitest
pnpm typecheck
npx tsx scripts/preview.ts week 140 34   # print a view with demo data, no TTY needed
pnpm screenshots                         # regenerate docs/*.png from demo data (needs rsvg-convert)
```

Layout: `src/views/` render to plain ANSI line arrays through a small cell `Canvas`
(`src/canvas.ts`), so they're pure and tested; `src/app.tsx` is the Ink shell (keys, overlays,
status bar); `src/store.ts` caches events per month and fetches in the background.
