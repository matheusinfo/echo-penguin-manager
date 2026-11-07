// The touch UI's alarms, shared by the "Alarme & Tela" page and the dashboard. Mirrors penguin-ui's
// Clocks: echo-penguin v0.2.9+ keeps a list in /data/penguin/alarms.json and reloads it by itself when
// it changes; older versions keep one alarm in /data/penguin/alarm.json and read it only at start.

export const ALARMS_FILE = '/data/penguin/alarms.json';
export const OLD_ALARM_FILE = '/data/penguin/alarm.json';
export const MUSIC_DIR = '/data/penguin/music';
/** Same limit as penguin-ui's MAX_ALARMS (what fits on its screen). */
export const MAX_ALARMS = 8;

export type Repeat = 'daily' | 'weekdays' | 'weekends' | 'once';
/** sound: 'beep' or a file name in MUSIC_DIR. */
export interface Alarm { on: boolean; h: number; m: number; repeat: Repeat; sound: string }

export const REPEATS: { id: Repeat; label: string; long: string }[] = [
  { id: 'daily', label: 'Todo dia', long: 'todo dia' },
  { id: 'weekdays', label: 'Seg–sex', long: 'de segunda a sexta' },
  { id: 'weekends', label: 'Sáb e dom', long: 'sábado e domingo' },
  { id: 'once', label: 'Uma vez', long: 'uma vez (desliga depois de tocar)' },
];

export const newAlarm = (): Alarm => ({ on: true, h: 7, m: 0, repeat: 'daily', sound: 'beep' });

/** What penguin-ui accepts as an alarm's sound (else it uses the beep). */
export const validSound = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 255 && !v.includes('/') && !/[\x00-\x1f\x7f]/.test(v);

export const isTrack = (name: string) => /\.(mp3|wav)$/i.test(name) && !name.startsWith('.') && validSound(name);

/**
 * Shell section that tells which format the Echo's penguin-ui uses and prints the file it reads:
 * "FORMAT=1|2", "FILE=<path>", then the file (or @@none).
 */
export const ALARMS_READ_CMD =
  `if grep -q alarms.json /usr/local/bin/penguin-ui 2>/dev/null; then echo FORMAT=2; f=${ALARMS_FILE}; [ -r "$f" ] || f=${OLD_ALARM_FILE}; ` +
  `else echo FORMAT=1; f=${OLD_ALARM_FILE}; fi; echo "FILE=$f"; if [ -r "$f" ]; then cat "$f"; echo; else echo @@none; fi`;

export interface AlarmsOnDevice {
  /** 2: a list, reloaded live (v0.2.9+); 1: one alarm, read at start (older). */
  format: 1 | 2;
  /** The file the alarms came from. */
  file: string;
  /** The file's text, null when there is none. */
  raw: string | null;
  alarms: Alarm[];
  problem: string | null;
}

/** One alarm as penguin-ui's clean_alarm() reads it; null when it cannot be one. */
function cleanAlarm(x: unknown): Alarm | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const j = x as Record<string, unknown>;
  const h = Math.trunc(Number(j.h ?? 7)), m = Math.trunc(Number(j.m ?? 0));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return {
    on: j.on === true,
    h: ((h % 24) + 24) % 24,
    m: ((m % 60) + 60) % 60,
    repeat: REPEATS.some((r) => r.id === j.repeat) ? (j.repeat as Repeat) : 'daily',
    sound: validSound(j.sound) ? j.sound : 'beep',
  };
}

export function parseAlarmsSection(section: string): AlarmsOnDevice {
  const lines = section.split('\n');
  const format = lines[0]?.trim() === 'FORMAT=2' ? 2 : 1;
  const file = (lines[1] ?? '').replace(/^FILE=/, '').trim() || OLD_ALARM_FILE;
  const body = lines.slice(2).join('\n').trim();
  const raw = body === '@@none' || body === '' ? null : body;
  return { format, file, raw, ...parseAlarms(raw, file === ALARMS_FILE) };
}

/** The alarms in a file's text: {"alarms": [...]} (or a bare list), or the old single object. */
export function parseAlarms(raw: string | null, listFile: boolean): { alarms: Alarm[]; problem: string | null } {
  if (raw == null) return { alarms: [], problem: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { alarms: [], problem: 'JSON inválido (a tela mantém os alarmes que já tinha carregado)' };
  }
  let items: unknown[];
  if (listFile) {
    const list = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).alarms : parsed;
    items = Array.isArray(list) ? list : [];
  } else {
    items = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length ? [parsed] : [];
  }
  const alarms = items.map(cleanAlarm).filter((a): a is Alarm => a != null);
  const problem = alarms.length < items.length ? 'há entradas inválidas no arquivo (a tela as ignora)' : null;
  return { alarms: alarms.slice(0, MAX_ALARMS), problem };
}

const pyAlarm = (a: Alarm) =>
  `{"on": ${a.on ? 'true' : 'false'}, "h": ${a.h}, "m": ${a.m}, "repeat": ${JSON.stringify(a.repeat)}, "sound": ${JSON.stringify(a.sound)}}`;

/** The file's text in penguin-ui's own format (Python's json.dump). */
export function alarmsJson(alarms: Alarm[], format: 1 | 2): string {
  if (format === 1) return pyAlarm(alarms[0] ?? { ...newAlarm(), on: false });
  return `{"alarms": [${alarms.map(pyAlarm).join(', ')}]}`;
}

export function validAlarm(a: Alarm): string | null {
  if (typeof a.on !== 'boolean') return 'on inválido';
  if (!Number.isInteger(a.h) || a.h < 0 || a.h > 23) return 'hora deve ser 0–23';
  if (!Number.isInteger(a.m) || a.m < 0 || a.m > 59) return 'minuto deve ser 0–59';
  if (!REPEATS.some((r) => r.id === a.repeat)) return 'repetição inválida';
  if (!validSound(a.sound)) return 'som do alarme inválido';
  return null;
}

export const alarmKey = (a: Alarm) => `${a.on}|${a.h}|${a.m}|${a.repeat}|${a.sound}`;
export const alarmsKey = (l: Alarm[]) => l.map(alarmKey).join(';');
export const sortAlarms = (l: Alarm[]) => [...l].sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));
export const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Minutes until an alarm next rings, from the device's wall clock (a Date whose UTC fields are the
 * Echo's local time). Same rule as penguin-ui's until(): the current minute counts as gone.
 */
export function minutesUntil(a: Alarm, now: Date): number {
  const today = now.getUTCHours() * 60 + now.getUTCMinutes();
  let mins = a.h * 60 + a.m - today;
  if (mins <= 0) mins += 1440;
  const ringsOn = (sundayBased: number) => {
    const py = (sundayBased + 6) % 7; // Python: Monday = 0
    return a.repeat === 'weekdays' ? py < 5 : a.repeat === 'weekends' ? py >= 5 : true;
  };
  for (let i = 0; i < 8 && !ringsOn((now.getUTCDay() + Math.floor((today + mins) / 1440)) % 7); i++) mins += 1440;
  return mins;
}

/** The next alarm to ring (index in the list) and when, or null when all are off. */
export function nextAlarm(alarms: Alarm[], now: Date): { index: number; mins: number; at: Date } | null {
  let best: { index: number; mins: number } | null = null;
  alarms.forEach((a, index) => {
    if (!a.on) return;
    const mins = minutesUntil(a, now);
    if (!best || mins < best.mins) best = { index, mins };
  });
  if (!best) return null;
  const { index, mins } = best as { index: number; mins: number };
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const today = now.getUTCHours() * 60 + now.getUTCMinutes();
  return { index, mins, at: new Date(start + (today + mins) * 60000) };
}

export function fmtUntil(mins: number): string {
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return (d ? `${d} d ` : '') + `${h} h ${pad2(m)} min`;
}

export const soundLabel = (v: string) => (v === 'beep' ? 'bipe' : v.replace(/\.(mp3|wav)$/i, ''));
