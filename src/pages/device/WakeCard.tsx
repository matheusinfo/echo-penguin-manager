// "Alarme & Tela" → Despertar: the sunrise before an alarm and the alarm's volume ramp.
// echo-penguin v0.3.0+.
import { Sunrise, Volume1, Volume2 } from 'lucide-react';
import { Card } from '../../components/ui';
import { pad2 } from '../alarms';
import { DevState, NeedsVersion, SetLive, SettingSlider, numSetting } from './common';

export function wakeSupported(data: DevState): boolean {
  return 'WAKE_LIGHT' in data.defaults;
}

const fmtSecs = (s: number) => (s === 0 ? 'desligado' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${pad2(s % 60)} s` : ''}`);

export function WakeCard({ data, busy, setLive }: { data: DevState; busy: string | null; setLive: SetLive }) {
  if (!wakeSupported(data)) {
    return (
      <Card title="Despertar" icon={<Sunrise size={16} />}>
        <NeedsVersion data={data} what="Nascer do sol e volume gradual" />
      </Card>
    );
  }
  const ramp = numSetting(data, 'WAKE_RAMP', 60);
  const volume = numSetting(data, 'VOLUME', 50);
  // WAKE_VOLUME_START is a percent of VOLUME: penguin-ui starts the ramp at round(VOLUME × it / 100).
  const startAt = (pct: number) => Math.round((volume * pct) / 100);
  return (
    <Card title="Despertar" icon={<Sunrise size={16} />}>
      <div className="col gap-m">
        <SettingSlider data={data} k="WAKE_LIGHT" label="Nascer do sol" min={0} max={60} fallback={10} busy={busy} setLive={setLive}
          fmt={(v) => (v === 0 ? 'desligado' : `${v} min antes`)}
          okMsg={(v) => (v === 0 ? 'Nascer do sol desligado' : `Nascer do sol ${v} min antes do alarme`)}
          hint="A tela clareia aos poucos, em cores quentes, do brilho do escuro (BACKLIGHT_DARK) até o normal (BACKLIGHT), até a hora do próximo alarme; mesmo com a tela desligada, se ninguém a tocou há 30 s." />
        <SettingSlider data={data} k="WAKE_RAMP" label="Volume gradual" min={0} max={600} step={5} fallback={60} busy={busy} setLive={setLive}
          fmt={fmtSecs}
          okMsg={(v) => (v === 0 ? 'Volume gradual desligado' : `O volume do alarme sobe em ${fmtSecs(v)}`)}
          hint="O alarme começa baixo e sobe até o volume (VOLUME) neste tempo. Depois do alarme o volume volta ao normal." />
        <SettingSlider data={data} k="WAKE_VOLUME_START" label={(v) => `Volume inicial: ${v} % do volume do alarme`} min={0} max={100} fallback={80} busy={busy} setLive={setLive}
          disabled={ramp === 0} icons={[<Volume1 key="a" size={16} className="muted" />, <Volume2 key="b" size={16} className="muted" />]}
          fmt={(v) => `${startAt(v)} de ${volume}`}
          okMsg={(v) => (v >= 100 ? 'O alarme toca direto no volume normal' : `O alarme começa em ${v} % do volume (${startAt(v)} de ${volume})`)}
          hint={(v) => (ramp === 0
            ? 'Só vale com o volume gradual ligado.'
            : v >= 100
              ? <>Em 100 % o alarme já começa no volume do alarme ({volume}): sem subida.</>
              : <>Começa em <b>{startAt(v)}</b> de {volume} (VOLUME) e sobe até {volume}; cerca de {Math.round((volume - startAt(v)) * 1.58)} dB mais baixo no início.</>)} />
      </div>
    </Card>
  );
}
