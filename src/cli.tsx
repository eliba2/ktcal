#!/usr/bin/env node
import { copyFile, chmod, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as clack from '@clack/prompts';
import { render } from 'ink';
import { App } from './app.js';
import { getAuthorizedClient, NotSetUpError, SCOPE, signIn, signOut } from './auth.js';
import { configDir, loadSettings, paths, readJson, saveSettings, type CalendarRef } from './config.js';
import { listCalendars, name, toRef } from './google.js';
import { demoCalendars, DemoSource } from './demo.js';
import { describe, EventStore, type EventSource } from './store.js';

const USAGE = `ktcal — Google Calendar in the terminal (read-only)

Usage:
  ktcal                      open the calendar (month view)
  ktcal setup [client.json]  connect Google: install the OAuth client, sign in, pick calendars
  ktcal calendars            pick which calendars to show
  ktcal logout               revoke the token and delete it
  ktcal demo                 open with made-up events (no Google needed)

Config lives in ${configDir}`;

async function main(argv: string[]): Promise<void> {
  const [command, arg] = argv;
  switch (command) {
    case undefined:
      return run();
    case 'demo':
      return run(true);
    case 'setup':
      return setup(arg);
    case 'calendars':
      return pickCalendars();
    case 'logout':
      console.log((await signOut()) ? 'Signed out; token revoked and deleted.' : 'Not signed in.');
      return;
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

async function run(demo = false): Promise<void> {
  if (!process.stdout.isTTY) throw new Error('ktcal needs an interactive terminal');
  const settings = await loadSettings();
  let listener = () => {};
  let store: EventSource;
  let calendars: CalendarRef[];
  if (demo) {
    store = new DemoSource();
    calendars = demoCalendars;
  } else {
    const client = await getAuthorizedClient();
    calendars = settings.calendars.length
      ? settings.calendars
      : (await listCalendars(client)).filter((c) => c.selected && !c.hidden).map(toRef);
    store = new EventStore(client, calendars, () => listener());
  }

  // Full-screen: alternate buffer, restored however we exit.
  const restore = () => process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.stdout.write('\x1b[?1049h\x1b[H');
  process.on('exit', restore);
  const app = render(
    <App store={store} settings={settings} calendars={calendars} subscribe={(l) => (listener = l)} />,
    { exitOnCtrlC: true, patchConsole: true },
  );
  await app.waitUntilExit();
  restore();
}

async function setup(clientPath?: string): Promise<void> {
  clack.intro('ktcal setup');

  const source = clientPath ?? (await newestDownloadedClient());
  if (source) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await copyFile(source, paths.client);
    await chmod(paths.client, 0o600);
    clack.log.success(`OAuth client installed to ${paths.client}`);
    clack.log.warn(`You can now delete the original: rm '${source}'`);
  } else if (!(await readJson(paths.client))) {
    clack.log.error(
      'No OAuth client found. Download the Desktop-app client JSON from Google Cloud Console ' +
        '(Credentials → OAuth client → Download JSON), then run: ktcal setup <path-to-json>',
    );
    process.exitCode = 1;
    return;
  }

  clack.log.info(`Requesting read-only access (${SCOPE})`);
  await signIn((msg) => clack.log.message(msg));
  clack.log.success('Signed in');
  await pickCalendars(true);
}

async function pickCalendars(embedded = false): Promise<void> {
  if (!embedded) clack.intro('ktcal calendars');
  const client = await getAuthorizedClient();
  const settings = await loadSettings();
  const all = await listCalendars(client);
  const current = new Set(settings.calendars.map((c) => c.id));
  const chosen = await clack.multiselect({
    message: 'Calendars to show (space toggles, enter confirms)',
    options: all.map((c) => ({ value: c.id, label: name(c), hint: c.primary ? 'primary' : undefined })),
    initialValues: all.filter((c) => (current.size ? current.has(c.id) : c.selected && !c.hidden)).map((c) => c.id),
    required: true,
  });
  if (clack.isCancel(chosen)) {
    clack.cancel('Calendars unchanged');
    return;
  }
  const calendars: CalendarRef[] = all.filter((c) => chosen.includes(c.id)).map(toRef);
  await saveSettings({ ...settings, calendars });
  clack.outro(`Showing ${calendars.length} calendar(s). Run \`ktcal\` to open.`);
}

/** The most recent client_secret_*.json in ~/Downloads, which is where Google Cloud saves it. */
async function newestDownloadedClient(): Promise<string | null> {
  const dir = join(homedir(), 'Downloads');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => /^client_secret_.*\.json$/.test(f));
  } catch {
    return null;
  }
  const withTimes = await Promise.all(files.map(async (f) => ({ f, t: (await stat(join(dir, f))).mtimeMs })));
  const newest = withTimes.sort((a, b) => b.t - a.t)[0];
  return newest ? join(dir, newest.f) : null;
}

main(process.argv.slice(2)).catch((err) => {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h\x1b[?1049l');
  if (err instanceof NotSetUpError) console.error(`${err.message}. Run: ktcal setup`);
  else console.error(`ktcal: ${describe(err)}`);
  process.exit(1);
});
