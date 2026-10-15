import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Weekday } from './dates.js';

export const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ktcal');
export const paths = {
  /** The OAuth client (Desktop app) JSON downloaded from Google Cloud Console. */
  client: join(configDir, 'client.json'),
  /** Access + refresh token. A bearer credential: keep it 0600. */
  token: join(configDir, 'token.json'),
  settings: join(configDir, 'config.json'),
};

export interface CalendarRef {
  id: string;
  name: string;
  color: string;
  /** You can add events to it (owner / writer). Filled in at startup when editing is on. */
  writable?: boolean;
}

export interface Settings {
  /** Calendars to show. Empty means: whatever is checked in Google Calendar's own list. */
  calendars: CalendarRef[];
  weekStart: Weekday;
  dayStart: number;
  dayEnd: number;
  /** Background refresh interval in minutes; 0 disables it. */
  refreshMinutes: number;
}

const defaults: Settings = { calendars: [], weekStart: 1, dayStart: 8, dayEnd: 19, refreshMinutes: 5 };

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Write JSON readable by the owner only (secrets live in this directory). */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function loadSettings(): Promise<Settings> {
  return { ...defaults, ...((await readJson<Partial<Settings>>(paths.settings)) ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writePrivateJson(paths.settings, settings);
}
