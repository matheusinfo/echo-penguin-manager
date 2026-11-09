// The sleep diary (penguin-sleep) and the Echo's wall clock, shared by the "Alarme & Tela" page and
// the dashboard. echo-penguin v0.3.0+.
import { pad2 } from './alarms';

/** A Date whose UTC fields read as the Echo's wall clock at `epochS` (tzOffsetMin: its UTC offset). */
export function deviceTime(epochS: number, tzOffsetMin: number | null): Date {
  const off = tzOffsetMin ?? -new Date(epochS * 1000).getTimezoneOffset();
  return new Date(epochS * 1000 + off * 60000);
}

export const hhmm = (d: Date) => `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;

// --- Sleep diary.

export const SLEEP_LOG_FILE = '/data/penguin/sleep-log.jsonl';

export function sleepNightsCmd(days: number): string {
  const n = Math.max(1, Math.min(90, Math.trunc(days)));
  return `penguin-sleep nights --json --days ${n}`;
}

export interface Night {
  /** YYYY-MM-DD, the local date of the wake. */
  date: string;
  /** Epoch seconds: lights off. */
  bed: number;
  /** Epoch seconds: wake. */
  wake: number;
  minutes: number;
  alarm: boolean;
}

export interface Nights {
  nights: Night[];
  /** Average of the last 7 nights, minutes. */
  average: number | null;
  count: number;
}

/** `penguin-sleep nights --json`. Throws when the output is not that. */
export function parseNights(text: string): Nights {
  const j = JSON.parse(text.trim());
  if (!j || typeof j !== 'object' || !Array.isArray(j.nights)) throw new Error('penguin-sleep: resposta inesperada');
  const nights: Night[] = [];
  for (const x of j.nights as unknown[]) {
    if (!x || typeof x !== 'object') continue;
    const n = x as Record<string, unknown>;
    const bed = Number(n.bed), wake = Number(n.wake);
    if (typeof n.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(n.date) || !Number.isFinite(bed) || !Number.isFinite(wake) || wake < bed) continue;
    const minutes = Number(n.minutes);
    nights.push({
      date: n.date,
      bed,
      wake,
      minutes: Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : Math.round((wake - bed) / 60),
      alarm: n.alarm === true,
    });
  }
  const avg = Number(j.average_minutes);
  return {
    nights,
    average: j.average_minutes != null && Number.isFinite(avg) ? Math.round(avg) : null,
    count: Number.isFinite(Number(j.count)) ? Number(j.count) : nights.length,
  };
}

/** 432 → "7 h 12". */
export function fmtSleep(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)} h ${pad2(m % 60)}`;
}

/**
 * How penguin-ui reads the light sensor for the diary and the night clock: dark at or below
 * LIGHT_DARK, lit above max(LIGHT_DARK × 2, LIGHT_DARK + 3); in between it keeps the last state.
 */
export function roomState(light: number | null, lightDark: number): { state: 'dark' | 'lit' | 'between' | null; litAbove: number } {
  const litAbove = Math.max(lightDark * 2, lightDark + 3);
  if (light == null) return { state: null, litAbove };
  return { state: light <= lightDark ? 'dark' : light > litAbove ? 'lit' : 'between', litAbove };
}
