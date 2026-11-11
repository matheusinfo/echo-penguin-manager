// Weather (penguin-weather, Open-Meteo) and speech (penguin-sound say, espeak-ng), shared by the
// "Alarme & Tela" page and the dashboard. echo-penguin v0.3.0+.
import { echo, shq } from '../api';
import { pad2 } from './alarms';
import { setCommand, unsafeValue } from './settings/lib';
import { validPiperVoice } from './features';

export const WEATHER_CACHE = '/run/penguin/weather.json';
export const WEATHER_READ_CMD = `cat ${WEATHER_CACHE} 2>/dev/null; true`;
/** penguin-weather's line goes blank when the data is older than this. */
export const WEATHER_STALE_S = 3 * 3600;
/** Open-Meteo's data is CC BY 4.0: shown wherever the weather is. */
export const WEATHER_CREDIT = 'Dados: Open-Meteo.com';
export const WEATHER_CREDIT_URL = 'https://open-meteo.com/';
/** Like penguin-weather: an hour with this chance of rain makes rain "likely"; below RAIN_MENTION it is not mentioned. */
const RAIN_LIKELY = 50;
const RAIN_MENTION = 20;

export interface WeatherCache {
  /** Epoch seconds of the last good fetch. */
  fetched: number | null;
  place: string;
  lat: number | null;
  lon: number | null;
  now: { temp: number | null; code: number | null; text: string } | null;
  today: { max: number | null; min: number | null; rainProb: number | null; rainFrom: string | null } | null;
  /** The last update's error (the data above is the last good one, or null when there never was any). */
  error: string | null;
  /** The place's date of the data ("YYYY-MM-DD"), its UTC offset (s) and today's chance of rain hour by hour. */
  date: string | null;
  utcOffset: number | null;
  rainHours: (number | null)[] | null;
}

export type WeatherToday = NonNullable<WeatherCache['today']> & { rainNow: boolean };

const fnum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fstr = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '');

/** The cache file's text; null when there is none or it is not JSON. */
export function parseWeather(raw: string | null | undefined): WeatherCache | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  let j: Record<string, unknown>;
  try {
    const p = JSON.parse(t);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    j = p as Record<string, unknown>;
  } catch {
    return null;
  }
  const now = j.now && typeof j.now === 'object' ? j.now as Record<string, unknown> : null;
  const today = j.today && typeof j.today === 'object' ? j.today as Record<string, unknown> : null;
  return {
    fetched: fnum(j.fetched),
    place: fstr(j.place, 120),
    lat: fnum(j.lat),
    lon: fnum(j.lon),
    now: now ? { temp: fnum(now.temp), code: fnum(now.code), text: fstr(now.text, 60) } : null,
    today: today ? {
      max: fnum(today.max),
      min: fnum(today.min),
      rainProb: fnum(today.rain_prob),
      rainFrom: typeof today.rain_from === 'string' && /^\d{1,2}:\d{2}$/.test(today.rain_from) ? today.rain_from : null,
    } : null,
    error: j.error == null ? null : fstr(j.error, 300) || 'erro',
    date: typeof j.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : null,
    utcOffset: fnum(j.utc_offset),
    rainHours: Array.isArray(j.rain_hours) && j.rain_hours.length === 24 ? j.rain_hours.map(fnum) : null,
  };
}

/**
 * The cache's "today" as the Echo's screen shows it (penguin-weather's recent()): only while it is
 * still the place's day, with the rain recounted from the place's current hour.
 */
export function currentToday(w: WeatherCache, nowS: number): WeatherToday | null {
  if (!w.today) return null;
  const here = new Date((nowS + (w.utcOffset ?? 0)) * 1000); // UTC fields: the place's clock
  if (w.date && w.date !== here.toISOString().slice(0, 10)) return null;
  const hour = here.getUTCHours();
  let { rainProb, rainFrom } = w.today;
  if (w.rainHours) {
    const rest = w.rainHours.map((p, h) => [h, p] as const).filter(([h, p]) => h >= hour && p != null) as [number, number][];
    rainProb = rest.reduce((m, [, p]) => Math.max(m, p), 0);
    const likely = rest.find(([, p]) => p >= RAIN_LIKELY);
    rainFrom = likely ? `${pad2(likely[0])}:00` : null;
  }
  return { ...w.today, rainProb, rainFrom, rainNow: rainFrom != null && rainFrom <= `${pad2(hour)}:00` };
}

/** WMO weather codes (what Open-Meteo returns) in Portuguese. */
const WMO_PT: Record<number, string> = {
  0: 'céu limpo', 1: 'predominantemente limpo', 2: 'parcialmente nublado', 3: 'nublado',
  45: 'neblina', 48: 'neblina com geada',
  51: 'garoa fraca', 53: 'garoa', 55: 'garoa forte', 56: 'garoa congelante', 57: 'garoa congelante forte',
  61: 'chuva fraca', 63: 'chuva', 65: 'chuva forte', 66: 'chuva congelante', 67: 'chuva congelante forte',
  71: 'neve fraca', 73: 'neve', 75: 'neve forte', 77: 'grãos de neve',
  80: 'pancadas de chuva fracas', 81: 'pancadas de chuva', 82: 'pancadas de chuva fortes',
  85: 'pancadas de neve', 86: 'pancadas de neve fortes',
  95: 'trovoada', 96: 'trovoada com granizo', 99: 'trovoada com granizo forte',
};

export function weatherText(now: WeatherCache['now']): string {
  if (!now) return '';
  return (now.code != null ? WMO_PT[now.code] : undefined) ?? now.text;
}

const deg = (n: number | null) => (n == null ? '—' : `${Math.round(n)}°`);

/** One line in Portuguese: "18 °C, parcialmente nublado · 15°/24° · chuva provável a partir das 15:00 (60%)". */
export function weatherLine(w: WeatherCache, nowS: number): string {
  const parts: string[] = [];
  if (w.now) parts.push([w.now.temp != null ? `${Math.round(w.now.temp)} °C` : '', weatherText(w.now)].filter(Boolean).join(', '));
  const t = currentToday(w, nowS);
  if (t && (t.min != null || t.max != null)) parts.push(`${deg(t.min)}/${deg(t.max)}`);
  const rain = rainText(t);
  if (rain) parts.push(rain);
  return parts.filter(Boolean).join(' · ');
}

/** The rain part, by penguin-weather's rules (likely now / likely from an hour / a chance of 20 % or more). */
export function rainText(t: WeatherToday | null): string {
  if (!t) return '';
  const pct = t.rainProb != null ? ` (${Math.round(t.rainProb)}%)` : '';
  if (t.rainNow) return `chuva provável agora${pct}`;
  if (t.rainFrom) return `chuva provável a partir das ${t.rainFrom}${pct}`;
  if (t.rainProb != null && t.rainProb >= RAIN_MENTION) return `chuva ${Math.round(t.rainProb)}%`;
  return '';
}

// --- Location (Open-Meteo's geocoding, asked by the Echo).

/** A place `penguin-weather find` returned. label: "name, region, country", what `set` writes too. */
export interface Place { label: string; lat: number; lon: number }

/** Why a city search text cannot be used, or null. */
export function cityQueryError(q: string): string | null {
  const t = q.trim();
  if (t.length < 2) return 'digite ao menos 2 letras';
  if (t.length > 80) return 'nome longo demais';
  if (/[\x00-\x1f\x7f]/.test(t)) return 'caracteres inválidos';
  if (t.startsWith('-')) return 'o nome não pode começar com "-"';
  return null;
}

/** The label kept in WEATHER_PLACE, without the characters a setting cannot hold (settings.conf is sourced inside double quotes). */
export function placeLabel(p: Place): string {
  return p.label.replace(/["$`\\]/g, '').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 80);
}

/** Decimal degrees as written to WEATHER_LAT / WEATHER_LON: 4 decimals (about 10 m), like penguin-weather. */
export const coord = (n: number) => n.toFixed(4);

/** `penguin-weather find` lines: "LAT LON NAME, REGION, COUNTRY". */
export function parseFindOutput(text: string): Place[] {
  const out: Place[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(.+)$/);
    if (!m) continue;
    const lat = Number(m[1]), lon = Number(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    out.push({ label: m[3].trim(), lat, lon });
  }
  return out;
}

/**
 * City search, done by the Echo (`penguin-weather find`, which asks Open-Meteo): Echo Manager itself
 * talks only to the Echo. Text after a comma narrows the matches ("Campinas, São Paulo", "Paris, FR").
 */
export async function findPlaces(query: string): Promise<Place[]> {
  const err = cityQueryError(query);
  if (err) throw new Error(err);
  const r = await echo.exec(`penguin-weather find ${shq(query.trim())}`, { timeout: 45000 });
  const msg = (r.stderr || r.stdout).trim().replace(/^penguin-weather:\s*/, '');
  if (r.code !== 0) {
    if (/^no place called/i.test(msg)) return [];
    throw new Error(`Busca de cidade: ${msg || `penguin-weather saiu com código ${r.code}`}`);
  }
  return parseFindOutput(r.stdout);
}

/** penguin set for the three location settings (all empty: no weather). */
export function locationCommand(p: Place | null, defaults: Record<string, string>): string {
  const lat = p ? coord(p.lat) : '';
  const lon = p ? coord(p.lon) : '';
  const label = p ? placeLabel(p) : '';
  if (unsafeValue(label)) throw new Error('nome do local inválido');
  return [
    setCommand('WEATHER_LAT', lat, defaults.WEATHER_LAT),
    setCommand('WEATHER_LON', lon, defaults.WEATHER_LON),
    setCommand('WEATHER_PLACE', label, defaults.WEATHER_PLACE),
  ].map((c) => `{ ${c}; }`).join(' && '); // grouped: removeCommand has its own ||
}

/** `penguin-weather update`: 0 ok, 1 error (on stderr), 2 no location configured. */
export async function updateWeather(): Promise<{ ok: boolean; noLocation: boolean; message: string }> {
  const r = await echo.exec('penguin-weather update', { timeout: 40000 });
  const msg = (r.stderr || r.stdout).trim();
  if (r.code === 0) return { ok: true, noLocation: false, message: msg };
  if (r.code === 2) return { ok: false, noLocation: true, message: msg || 'nenhum local configurado' };
  return { ok: false, noLocation: false, message: msg || `penguin-weather saiu com código ${r.code}` };
}

// --- Speech.

/** Voices offered when the Echo cannot list them, with their names in Portuguese. */
export const VOICE_LABELS: Record<string, string> = {
  en: 'Inglês', 'en-us': 'Inglês (EUA)', 'en-gb': 'Inglês (Reino Unido)',
  'pt-br': 'Português (Brasil)', pt: 'Português (Portugal)', 'pt-pt': 'Português (Portugal)',
  es: 'Espanhol', 'es-419': 'Espanhol (América Latina)', fr: 'Francês', 'fr-fr': 'Francês',
  de: 'Alemão', it: 'Italiano', nl: 'Holandês', pl: 'Polonês', ru: 'Russo', ja: 'Japonês', cmn: 'Chinês (mandarim)',
};
export const COMMON_VOICES = ['pt-br', 'pt', 'en', 'en-us', 'en-gb', 'es', 'es-419', 'fr', 'de', 'it'];

/** espeak-ng's languages, one per line (the Echo's own list). */
export const VOICES_CMD = "command -v espeak-ng >/dev/null 2>&1 && espeak-ng --voices 2>/dev/null | awk 'NR > 1 {print $2}'; true";

/** A voice name SPEAK_VOICE can hold (espeak-ng language, optionally +variant). */
export const validVoice = (v: string) => /^[a-z0-9+-]{1,32}$/.test(v);

export function parseVoices(text: string | undefined): string[] {
  const set = new Set((text ?? '').split('\n').map((x) => x.trim().toLowerCase()).filter(validVoice));
  return Array.from(set).sort();
}

export const voiceLabel = (v: string) => (VOICE_LABELS[v] ? `${VOICE_LABELS[v]} — ${v}` : v);

/** penguin-weather speech talks Portuguese for pt* voices, English for the others. */
export const speaksPortuguese = (voice: string) => voice.startsWith('pt');

/** Text for `penguin-sound say`: one line, printable, short. */
export function sayTextError(t: string): string | null {
  const s = t.trim();
  if (!s) return 'digite um texto';
  if (s.length > 300) return 'no máximo 300 caracteres';
  if (/[\x00-\x1f\x7f]/.test(s)) return 'uma linha só, sem caracteres de controle';
  if (s.startsWith('-')) return 'o texto não pode começar com "-"';
  return null;
}

// echo-penguin v0.3.1+ has two engines: espeak (instant) and Piper (natural, ~40 s to render here).
// `-e` is passed only to units that have Piper: older penguin-sound does not know the option.
export type SpeakEngine = 'espeak' | 'piper';

const engineOpt = (engine?: SpeakEngine, piperVoice?: string): string => {
  if (!engine) return '';
  if (engine === 'espeak') return '-e espeak ';
  if (!piperVoice || !validPiperVoice(piperVoice)) throw new Error('voz do Piper inválida');
  return `-e piper -v ${shq(piperVoice)} `;
};

/** Says the greeting penguin-ui says after an alarm, printing its text first. */
export function sayGreetingCmd(engine?: SpeakEngine, piperVoice?: string): string {
  return 't=$(penguin-weather speech) || exit 1; [ -n "$t" ] || t=$(date +%H:%M); printf "%s\\n" "$t"; ' +
    `penguin-sound say ${engineOpt(engine, piperVoice)}"$t" >/dev/null`;
}

/** After v0.3.1: says what a tap on the home clock says (Piper clips rendered ahead, instant), printing
 *  its text first. Exit 4 from `say --ready`: the clips are not rendered yet. */
export function sayClockCmd(): string {
  return 't=$(penguin-weather speech --clips) || exit 1; [ -n "$t" ] || exit 1; printf "%s\\n" "$t" | tr "\\n" " "; echo; ' +
    'penguin-sound say --ready "$t" >/dev/null; rc=$?; ' +
    '[ $rc = 4 ] && { echo "a voz ainda está sendo preparada no Echo: tente de novo em alguns minutos" >&2; exit 4; }; exit $rc';
}

export const sayCmd = (text: string, engine?: SpeakEngine) => `penguin-sound say ${engineOpt(engine)}${shq(text.trim())}`;
