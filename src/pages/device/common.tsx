// Shared by the "Alarme & Tela" page (Device.tsx) and its cards in this folder: the device state the
// page polls, and small building blocks for settings the touch UI picks up by itself.
import { ReactNode, useState } from 'react';
import { Info } from 'lucide-react';
import { Badge } from '../../components/ui';
import { AlarmsOnDevice } from '../alarms';
import { Features, NEEDS_V030 } from '../features';
import { WeatherCache } from '../weather';

export interface DevState {
  alarms: AlarmsOnDevice;
  /** Tracks in /data/penguin/music an alarm can play. */
  music: string[];
  bl: number | null;
  blMax: number;
  /** The light sensor's reading (0–4095), null without a sensor. */
  light: number | null;
  vol: number | null;
  volErr: string | null;
  effective: Record<string, string>;
  defaults: Record<string, string>;
  overrides: Record<string, string>;
  uiPid: string;
  printk: number | null;
  /** device wall clock minus our clock, ms (device local time encoded as UTC). */
  clockOffset: number | null;
  /** device epoch minus our epoch, ms (the two clocks' difference). */
  epochOffset: number | null;
  /** The Echo's UTC offset, minutes. */
  tzOffsetMin: number | null;
  tz: string;
  /** echo-penguin v0.3.0 features present on the unit. */
  features: Features;
  /** The image's version ("v0.2.9"), when known. */
  version: string | null;
  weather: WeatherCache | null;
  /** espeak-ng's voices on the unit (empty: unknown). */
  voices: string[];
  /** Piper's voices on the unit (names without .onnx; empty: none or no Piper). */
  piperVoices: string[];
}

/** Writes one setting penguin-ui re-reads within seconds; validates first, toasts, refreshes. */
export type SetLive = (key: string, value: number | string, okMsg: string, also?: Record<string, string>) => Promise<boolean>;
export type ActFn = (key: string, fn: () => Promise<unknown>, okMsg?: string) => Promise<boolean>;

/** An integer setting's current value (the default when unset or not a number). */
export function numSetting(data: DevState, key: string, fallback: number): number {
  const v = data.effective[key] ?? data.defaults[key];
  return /^\d+$/.test(v ?? '') ? Number(v) : fallback;
}

export function Custom({ data, k }: { data: DevState; k: string }) {
  return k in data.overrides ? <Badge tone="info">personalizado</Badge> : null;
}

/** The note a card shows when the Echo's echo-penguin does not have its feature yet. */
export function NeedsVersion({ what, data }: { what: ReactNode; data: DevState }) {
  return (
    <div className="dv-note">
      <Info size={15} />
      <div>{what}: {NEEDS_V030}{data.version ? <> (este Echo roda {data.version})</> : null}. Atualize o sistema do Echo.</div>
    </div>
  );
}

/** A slider for an integer setting, saved on release (like the brightness sliders). */
export function SettingSlider({ data, k, label, min, max, step = 1, fallback = min, fmt, okMsg, hint, busy, setLive, disabled, icons }: {
  data: DevState; k: string; min: number; max: number; step?: number;
  /** The value when the setting is unset or not a number (the image's default). */
  fallback?: number;
  /** Static, or computed from the value being dragged. */
  label: ReactNode | ((v: number) => ReactNode);
  fmt: (v: number) => ReactNode; okMsg: (v: number) => string; busy: string | null;
  /** Static, or computed from the value being dragged. */
  hint?: ReactNode | ((v: number) => ReactNode);
  setLive: SetLive; disabled?: boolean; icons?: [ReactNode, ReactNode];
}) {
  const cur = Math.min(max, Math.max(min, numSetting(data, k, fallback)));
  const [draft, setDraft] = useState<number | null>(null);
  const commit = () => {
    if (draft == null || draft === cur) return setDraft(null);
    setLive(k, draft, okMsg(draft)).then(() => setDraft(null));
  };
  const v = draft ?? cur;
  return (
    <div className="col gap-s">
      <div className="row between">
        <span className="field-label">{typeof label === 'function' ? label(v) : label} <Custom data={data} k={k} /></span>
        <span className="muted small mono">{k}</span>
      </div>
      <div className="dv-slider">
        {icons?.[0]}
        <input type="range" min={min} max={max} step={step} value={v} disabled={disabled || busy === k} aria-label={k}
          onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} />
        {icons?.[1]}
        <span className="dv-val">{fmt(v)}</span>
      </div>
      {hint != null && <span className="field-hint">{typeof hint === 'function' ? hint(v) : hint}</span>}
    </div>
  );
}

/** Segmented buttons for a select setting. */
export function SettingSeg({ data, k, options, busy, setLive, okMsg }: {
  data: DevState; k: string; options: { value: string; label: ReactNode; title?: string }[]; busy: string | null;
  setLive: SetLive; okMsg: (v: string) => string;
}) {
  const cur = data.effective[k] ?? data.defaults[k] ?? '';
  return (
    <div className="dv-seg">
      {options.map((o) => (
        <button key={o.value} className={cur === o.value ? 'active' : ''} disabled={busy === k} title={o.title}
          onClick={() => { if (o.value !== cur) setLive(k, o.value, okMsg(o.value)); }}>{o.label}</button>
      ))}
    </div>
  );
}

/**
 * "It is dark now": LIGHT_DARK a little above the sensor's reading, so its small swings in the dark
 * still count as dark (and LIGHT_BRIGHT moved up when it would not be above it any more).
 */
export async function calibrateDark(data: DevState, setLive: SetLive): Promise<void> {
  const light = data.light;
  if (light == null) return;
  const dark = numSetting(data, 'LIGHT_DARK', 3);
  const bright = numSetting(data, 'LIGHT_BRIGHT', 80);
  const v = Math.min(4000, light + Math.max(2, Math.round(light * 0.2)));
  let b = bright;
  if (v >= bright) {
    b = Math.min(4095, Math.max(v + 1, v * 4));
    if (!(await setLive('LIGHT_BRIGHT', b, `Claro: leituras a partir de ${b}`, { LIGHT_DARK: String(dark) }))) return;
  }
  await setLive('LIGHT_DARK', v, `Escuro: leituras até ${v}`, { LIGHT_BRIGHT: String(b) });
}

/** The Echo's clock now, as epoch ms. */
export const deviceNowMs = (data: DevState) => Date.now() + (data.epochOffset ?? 0);
