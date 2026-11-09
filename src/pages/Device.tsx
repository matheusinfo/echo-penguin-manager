// "Alarme & Tela": the touch UI's alarms (/data/penguin/alarms.json), waking up (sunrise, volume
// ramp), the screen and the night clock, the speaker, the weather, the voice and the sleep diary.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlarmClock, Bell, BellOff, ChevronDown, ChevronUp, Info, Monitor, Moon, Play, Plus, RefreshCw, Save, Sun, SunDim, Trash2,
  TriangleAlert, Undo2, Volume2, Power,
} from 'lucide-react';
import { echo, run, runSections } from '../api';
import { useApp, usePoll } from '../hooks';
import { Badge, Button, Card, Empty, ErrorBox, Grid, Loading, NeedsConnection, Page, RefreshButton, Switch } from '../components/ui';
import {
  BACKLIGHT_SYS, DEFAULTS_FILE, SETTINGS_FILE, META_BY_KEY, parseConf, parseEffective, setCommand, validateSetting,
} from './settings/lib';
import { FEATURES_CMD, NEEDS_V030, PIPER_VOICES_CMD, parseFeatures, parsePiperVoices, releaseVersion } from './features';
import { VOICES_CMD, WEATHER_READ_CMD, parseVoices, parseWeather } from './weather';
import { ActFn, DevState, SetLive, calibrateDark } from './device/common';
import { WakeCard, wakeSupported } from './device/WakeCard';
import { NightCard } from './device/NightCard';
import { WeatherCard, weatherSupported } from './device/WeatherCard';
import { VoiceCard, voiceSupported } from './device/VoiceCard';
import { SleepCard, sleepSupported } from './device/SleepCard';
import { usePenguinActions } from './settings/actions';
import {
  ALARMS_FILE, ALARMS_READ_CMD, Alarm, MAX_ALARMS, MUSIC_DIR, OLD_ALARM_FILE, REPEATS, alarmsJson, alarmsKey,
  fmtUntil, isTrack, minutesUntil, newAlarm, nextAlarm, pad2 as pad, parseAlarms, parseAlarmsSection, soundLabel, sortAlarms,
  validAlarm,
} from './alarms';
import './Device.css';

const WD_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
/** The ambient light sensor's reading (echo-penguin's penguin-ui reads the same file). */
const ALS_FILE = '/sys/bus/platform/drivers/als_ps/als';

// --- Device state (DevState: ./device/common).

/** What does not change while the page is open (the image's defaults, the panel's range...): read once. */
interface DevStatic { defaults: Record<string, string>; blMax: number; voices: string[]; version: string | null }

async function loadDevice(cache: { current: DevStatic | null }): Promise<DevState> {
  const s = await runSections({
    alarms: ALARMS_READ_CMD,
    music: `ls -1 ${MUSIC_DIR} 2>/dev/null; true`,
    bl: `cat ${BACKLIGHT_SYS}/brightness`,
    light: `cat ${ALS_FILE} 2>/dev/null; true`,
    vol: 'penguin-sound volume',
    eff: 'penguin settings',
    conf: `cat ${SETTINGS_FILE} 2>/dev/null; true`,
    ui: 'pidof penguin-ui; true',
    printk: 'cat /proc/sys/kernel/printk',
    now: "date '+%Y %m %d %H %M %S %s %Z'",
    feat: FEATURES_CMD,
    weather: WEATHER_READ_CMD,
    piper: PIPER_VOICES_CMD,
    ...(cache.current ? {} : {
      blmax: `cat ${BACKLIGHT_SYS}/max_brightness`, defs: `cat ${DEFAULTS_FILE}`, voices: VOICES_CMD,
      rel: 'head -n 1 /etc/techo5-release 2>/dev/null; true',
    }),
  });
  const int = (v: string | undefined) => (v != null && /^\s*\d+\s*$/.test(v) ? Number(v) : null);
  if (!cache.current) {
    const defaults = parseConf(s.defs ?? '');
    const st = { defaults, blMax: int(s.blmax) ?? 255, voices: parseVoices(s.voices), version: releaseVersion(s.rel) };
    if (Object.keys(defaults).length) cache.current = st; // else: read again next time
    return buildDevState(s, st, int);
  }
  return buildDevState(s, cache.current, int);
}

function buildDevState(s: Record<string, string>, st: DevStatic, int: (v: string | undefined) => number | null): DevState {
  const n = (s.now ?? '').trim().split(/\s+/);
  let clockOffset: number | null = null;
  let epochOffset: number | null = null;
  let tzOffsetMin: number | null = null;
  if (n.length >= 6 && n.slice(0, 6).every((x) => /^\d+$/.test(x))) {
    const [Y, M, D, h, mi, se] = n.map(Number);
    const wall = Date.UTC(Y, M - 1, D, h, mi, se);
    clockOffset = wall - Date.now();
    if (/^\d+$/.test(n[6] ?? '')) {
      const epochMs = Number(n[6]) * 1000;
      epochOffset = epochMs - Date.now();
      tzOffsetMin = Math.round((wall - epochMs) / 60000);
    }
  }
  const lightRaw = (s.light ?? '').trim();
  const light = /^0x[0-9a-f]+$/i.test(lightRaw) ? parseInt(lightRaw, 16) : int(lightRaw);
  return {
    alarms: parseAlarmsSection(s.alarms ?? ''),
    music: (s.music ?? '').split('\n').map((x) => x.trim()).filter(isTrack)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })),
    bl: int(s.bl),
    blMax: st.blMax,
    light,
    vol: int(s.vol),
    volErr: int(s.vol) == null ? (s.vol ?? '').trim() || 'sem resposta' : null,
    effective: parseEffective(s.eff ?? ''),
    defaults: st.defaults,
    overrides: parseConf(s.conf ?? ''),
    uiPid: (s.ui ?? '').trim(),
    printk: int((s.printk ?? '').trim().split(/\s+/)[0]),
    clockOffset,
    epochOffset,
    tzOffsetMin,
    tz: (/^\d+$/.test(n[6] ?? '') ? n[7] : n[6]) ?? '', // %s comes before %Z
    features: parseFeatures(s.feat),
    version: st.version,
    weather: parseWeather(s.weather),
    voices: st.voices,
    piperVoices: parsePiperVoices(s.piper),
  };
}

const RESTART_UI = `old=$(pidof penguin-ui); killall penguin-ui 2>/dev/null; i=0
while [ $i -lt 15 ]; do n=$(pidof penguin-ui); if [ -n "$n" ] && [ "$n" != "$old" ]; then echo "$n"; exit 0; fi; sleep 1; i=$((i+1)); done
echo 'a interface (penguin-ui) não voltou em 15 s' >&2; exit 1`;

export default function DevicePage() {
  const { connected } = useApp();
  return (
    <Page title="Alarme & Tela" subtitle="Os alarmes, o despertar, a tela, o som, o clima, a voz e o sono do Echo (os mesmos da interface de toque)">
      <NeedsConnection connected={connected}><DeviceBody /></NeedsConnection>
    </Page>
  );
}

function DeviceBody() {
  const { confirm, toast, navigate } = useApp();
  const staticRef = useRef<DevStatic | null>(null);
  const { data, error, loading, refresh, lastUpdated } = usePoll(() => loadDevice(staticRef), 30000);
  const { busy, act, rebootEcho } = usePenguinActions(refresh);

  if (!data) return error ? <ErrorBox error={error} onRetry={refresh} /> : <Loading />;

  /** A setting penguin-ui (or penguin-sound, penguin-weather) picks up by itself within seconds. */
  const setLive: SetLive = async (key, value, okMsg, also = {}) => {
    const v = String(value);
    const meta = META_BY_KEY[key];
    const bad = meta ? validateSetting(meta, v, { ...data.effective, ...also, [key]: v }) : 'configuração desconhecida';
    if (bad) { toast(`${key}: ${bad}`, 'error'); return false; }
    const ok = await act(key, () => run(setCommand(key, v, data.defaults[key])), okMsg);
    refresh();
    return ok;
  };
  // An older echo-penguin has none of v0.3.0's features: one note instead of five cards saying so.
  const v030 = wakeSupported(data) || 'NIGHT_CLOCK' in data.defaults || weatherSupported(data) || voiceSupported(data) || sleepSupported(data);

  return (
    <>
      <div className="row between">
        <span className="muted small">
          {data.uiPid ? <>Interface de toque rodando (pid {data.uiPid}).</> : <span style={{ color: 'var(--warn)' }}>A interface de toque (penguin-ui) não está rodando.</span>}
          {data.tz && <> Horário do Echo: {data.tz}.</>}
        </span>
        <RefreshButton onClick={refresh} loading={loading} lastUpdated={lastUpdated} />
      </div>
      {error && <ErrorBox error={error} onRetry={refresh} />}
      <AlarmsCard data={data} refresh={refresh} />
      {v030 && (
        <Grid cols={2}>
          <WakeCard data={data} busy={busy} setLive={setLive} />
          <NightCard data={data} busy={busy} setLive={setLive} />
        </Grid>
      )}
      <Grid cols={2}>
        <ScreenCard data={data} refresh={refresh} busy={busy} act={act} confirm={confirm} toast={toast} setLive={setLive}
          onReboot={() => rebootEcho('Para aplicar as configurações de tela que só valem no boot.')}
          onGoMaint={() => navigate('settings', { tab: 'maint' })} />
        <SoundCard data={data} refresh={refresh} busy={busy} act={act} />
      </Grid>
      {v030 ? (
        <>
          <Grid cols={2}>
            <WeatherCard data={data} refresh={refresh} />
            <VoiceCard data={data} busy={busy} setLive={setLive} />
          </Grid>
          <SleepCard data={data} busy={busy} setLive={setLive} />
        </>
      ) : (
        <div className="dv-note">
          <Info size={15} />
          <div>
            Nascer do sol, volume gradual, relógio noturno, clima, voz e diário de sono: {NEEDS_V030}
            {data.version ? <> (este Echo roda {data.version})</> : null}. Atualize o sistema do Echo para tê-los aqui e na tela.
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------
// Alarms

function AlarmsCard({ data, refresh }: { data: DevState; refresh: () => void }) {
  const { confirm, toast } = useApp();
  const dev = data.alarms;
  const legacy = dev.format === 1;
  // An older penguin-ui always has its one alarm (07:00, off, when the file does not exist yet).
  const deviceAlarms = useMemo(() => (legacy && dev.alarms.length === 0 ? [{ ...newAlarm(), on: false }] : dev.alarms), [dev, legacy]);
  const [base, setBase] = useState<Alarm[] | null>(null);
  const [draft, setDraft] = useState<Alarm[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [, setTick] = useState(0);

  // First load, and adopting changes made on the Echo while nothing is being edited here.
  useEffect(() => {
    if (!base || !draft) {
      setBase(deviceAlarms);
      setDraft(deviceAlarms);
      return;
    }
    if (alarmsKey(deviceAlarms) !== alarmsKey(base) && alarmsKey(draft) === alarmsKey(base)) {
      setBase(deviceAlarms);
      setDraft(deviceAlarms);
      toast('Os alarmes foram alterados no Echo; valores atualizados', 'info');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceAlarms]);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);

  if (!base || !draft) return null;

  const dirty = alarmsKey(draft) !== alarmsKey(base);
  const conflict = dirty && alarmsKey(deviceAlarms) !== alarmsKey(base);
  const now = data.clockOffset != null ? new Date(Date.now() + data.clockOffset) : null;
  const next = now ? nextAlarm(draft, now) : null;
  const screenUiOff = (data.effective.SCREEN_UI ?? '1') !== '1';
  const limit = legacy ? 1 : MAX_ALARMS;
  const update = (i: number, p: Partial<Alarm>) => setDraft(draft.map((a, j) => (j === i ? { ...a, ...p } : a)));
  const remove = (i: number) => setDraft(draft.filter((_, j) => j !== i));
  const add = () => setDraft([...draft, newAlarm()]);
  const fmtAlarm = (a: Alarm) => `${pad(a.h)}:${pad(a.m)} ${REPEATS.find((r) => r.id === a.repeat)?.long}, ${a.on ? 'ligado' : 'desligado'}, som: ${soundLabel(a.sound)}`;
  const fmtList = (l: Alarm[]) => (l.length ? l.map((a) => `• ${fmtAlarm(a)}`).join('\n') : '(nenhum)');

  const save = async () => {
    for (const a of draft) {
      const err = validAlarm(a);
      if (err) return toast(`${pad(a.h)}:${pad(a.m)}: ${err}`, 'error');
    }
    const list = sortAlarms(draft);
    const file = legacy ? OLD_ALARM_FILE : ALARMS_FILE;
    const content = alarmsJson(list, dev.format);
    // Validate what is about to be written.
    if (alarmsKey(parseAlarms(content, !legacy).alarms) !== alarmsKey(legacy ? list.slice(0, 1) : list)) {
      return toast('Falha ao gerar o JSON dos alarmes', 'error');
    }

    let current: Alarm[] = deviceAlarms;
    try {
      const r = await echo.exec(ALARMS_READ_CMD);
      current = parseAlarmsSection(r.stdout).alarms;
      if (legacy && current.length === 0) current = [{ ...newAlarm(), on: false }];
    } catch { /* keep what the last poll saw */ }
    const changedThere = alarmsKey(current) !== alarmsKey(base) && alarmsKey(current) !== alarmsKey(list);

    // A newer penguin-ui reloads the file by itself: no restart, so ask only when it overwrites a
    // change made on the Echo. An older one only reads it at start: it is restarted, so always ask.
    if (changedThere || legacy) {
      const ok = await confirm({
        title: legacy ? 'Salvar alarme' : 'Salvar alarmes',
        message:
          (changedThere ? `⚠ Os alarmes foram alterados no Echo desde que você abriu esta página. Agora:\n${fmtList(current)}\n\nSalvar substitui essa mudança.\n\n` : '') +
          `Novos alarmes:\n${fmtList(list)}\n\n` +
          (legacy
            ? `O arquivo ${file} é gravado e a interface da tela (penguin-ui) é reiniciada para carregá-lo — esta versão do echo-penguin só o lê ao iniciar. O cronômetro e o timer da tela são zerados, e um alarme ou timer tocando para.`
            : `O arquivo ${file} é gravado; a tela recarrega os alarmes sozinha.`),
        confirmLabel: legacy ? 'Salvar e reiniciar a interface' : 'Salvar',
        danger: changedThere,
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await run('mkdir -p /data/penguin');
      await echo.writeFile(file, content);
      const written = (await run(`cat ${file}`)).trim();
      const back = parseAlarms(written, !legacy).alarms;
      if (alarmsKey(back) !== alarmsKey(legacy ? list.slice(0, 1) : list)) throw new Error('O arquivo gravado não confere; tente de novo');
      if (legacy) await run(RESTART_UI, { timeout: 30000 });
      setBase(back);
      setDraft(back);
      const n = now ? nextAlarm(back, now) : null;
      toast(n ? `Alarmes salvos: o próximo toca em ${fmtUntil(n.mins)}` : back.length ? 'Alarmes salvos (todos desligados)' : 'Alarmes salvos (nenhum)', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
      refresh();
    }
  };

  const restartUi = async () => {
    if (!(await confirm({
      title: 'Reiniciar a interface da tela',
      message: 'Encerra o penguin-ui; o init o inicia de novo em seguida e ele relê o alarme.\n\nO cronômetro e o timer da tela são zerados, e um alarme ou timer tocando para.',
      confirmLabel: 'Reiniciar interface',
    }))) return;
    setSaving(true);
    try {
      await run(RESTART_UI, { timeout: 30000 });
      toast('Interface reiniciada', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
      refresh();
    }
  };

  const reload = () => {
    setBase(deviceAlarms);
    setDraft(deviceAlarms);
  };

  return (
    <Card title="Alarmes" icon={<AlarmClock size={16} />}
      actions={<>
        {dirty && <Badge tone="warn">não salvo</Badge>}
        <span className="muted small">{draft.length} de {limit}</span>
        {legacy && <Button size="s" variant="ghost" icon={<RefreshCw size={13} />} busy={saving && !dirty} onClick={restartUi} title="killall penguin-ui (o init reinicia)">Reiniciar interface</Button>}
      </>}>
      <div className="col gap-m">
        {conflict && (
          <div className="dv-note warn">
            <TriangleAlert size={15} />
            <div className="grow">Os alarmes mudaram no Echo enquanto você editava.</div>
            <Button size="s" onClick={reload}>Usar os do Echo</Button>
          </div>
        )}
        {screenUiOff && (
          <div className="dv-note warn"><TriangleAlert size={15} /><div>SCREEN_UI=0: a interface de toque não roda, então os alarmes <b>não tocam</b>. Ligue “Interface de toque” abaixo e reinicie o Echo.</div></div>
        )}
        {legacy && (
          <div className="dv-note info"><Info size={15} /><div>Este Echo roda uma versão do echo-penguin anterior à v0.2.9, que tem <b>um alarme só</b> e o lê ao iniciar a interface. Atualize o sistema do Echo para ter até {MAX_ALARMS} alarmes.</div></div>
        )}
        {dev.problem && <div className="dv-note"><Info size={15} /><div>{dev.file}: {dev.problem}.</div></div>}

        {draft.length === 0 ? (
          <Empty>Nenhum alarme. Adicione um abaixo.</Empty>
        ) : (
          <div className="dv-alarms">
            {draft.map((a, i) => (
              <AlarmRow key={i} alarm={a} music={data.music} now={now} isNext={next?.index === i}
                onChange={(p) => update(i, p)} onRemove={legacy ? undefined : () => remove(i)} />
            ))}
          </div>
        )}

        <div className="row between wrap gap-s">
          <Button icon={<Plus size={14} />} disabled={draft.length >= limit} onClick={add}
            title={draft.length >= limit ? `No máximo ${limit} (o que cabe na tela do Echo)` : undefined}>Adicionar alarme</Button>
          <div className="row gap-s">
            {dirty && <Button icon={<Undo2 size={14} />} onClick={() => setDraft(base)}>Desfazer</Button>}
            <Button variant="primary" icon={<Save size={14} />} busy={saving} disabled={!dirty} onClick={save}>Salvar</Button>
          </div>
        </div>

        <div className="dv-next-line">
          {next ? (
            <><Bell size={16} style={{ verticalAlign: -3 }} /> Próximo: <b>{WD_SHORT[next.at.getUTCDay()]}, {pad(next.at.getUTCDate())}/{pad(next.at.getUTCMonth() + 1)} às {pad(draft[next.index].h)}:{pad(draft[next.index].m)}</b> <span className="muted">(em {fmtUntil(next.mins)}, hora do Echo)</span></>
          ) : (
            <span className="muted"><BellOff size={15} style={{ verticalAlign: -3 }} /> {draft.some((a) => a.on) ? 'Hora do Echo desconhecida' : 'Nenhum alarme vai tocar'}</span>
          )}
        </div>
        <div className="muted small">
          {legacy
            ? <>No Echo: <code className="mono">{dev.raw ?? '(sem arquivo)'}</code>.</>
            : <>Gravados em <code className="mono">{ALARMS_FILE}</code>; a tela os recarrega sozinha. Músicas: arquivos .mp3 (ou .wav em 48 kHz, 16 bits, estéreo; outros WAV viram bipe) em <code className="mono">{MUSIC_DIR}</code>.</>}
          {' '}Cada alarme toca por até 10 min; os botões de volume ou um toque na tela param o alarme.
        </div>
      </div>
    </Card>
  );
}

function AlarmRow({ alarm: a, music, now, isNext, onChange, onRemove }: {
  alarm: Alarm; music: string[]; now: Date | null; isNext: boolean;
  onChange: (p: Partial<Alarm>) => void; onRemove?: () => void;
}) {
  const missing = a.sound !== 'beep' && !music.includes(a.sound);
  return (
    <div className={`dv-arow ${a.on ? '' : 'off'} ${isNext ? 'next' : ''}`}>
      <div className="dv-clock compact">
        <TimeUnit label="hora" value={a.h} max={23} onChange={(h) => onChange({ h })} compact />
        <span className="dv-colon">:</span>
        <TimeUnit label="min" value={a.m} max={59} onChange={(m) => onChange({ m })} bigStep={10} compact />
      </div>
      <div className="col gap-s dv-arow-main">
        <div className="row gap-m wrap">
          <Switch checked={a.on} onChange={(on) => onChange({ on })} label={a.on ? <b>Ligado</b> : 'Desligado'} />
          <div className="dv-seg">
            {REPEATS.map((r) => (
              <button key={r.id} className={a.repeat === r.id ? 'active' : ''} onClick={() => onChange({ repeat: r.id })}>{r.label}</button>
            ))}
          </div>
        </div>
        <div className="row gap-s wrap">
          <select className="input dv-sound" value={a.sound} onChange={(e) => onChange({ sound: e.target.value })} aria-label="som do alarme">
            <option value="beep">Bipe (embutido)</option>
            {music.map((t) => <option key={t} value={t}>{soundLabel(t)}</option>)}
            {missing && <option value={a.sound}>{soundLabel(a.sound)} (arquivo não encontrado: toca o bipe)</option>}
          </select>
          <span className="muted small">
            {a.on && now ? <>toca em {fmtUntil(minutesUntil(a, now))}{a.repeat === 'once' && ', depois se desliga'}</> : a.on ? '' : 'não vai tocar'}
          </span>
        </div>
      </div>
      {onRemove && <Button size="s" variant="ghost" icon={<Trash2 size={14} />} onClick={onRemove} title="Remover este alarme (vale ao salvar)" />}
    </div>
  );
}

function TimeUnit({ label, value, max, onChange, bigStep, compact }: { label: string; value: number; max: number; onChange: (v: number) => void; bigStep?: number; compact?: boolean }) {
  const [text, setText] = useState(pad(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(pad(value)); }, [value]);
  const wrap = (v: number) => ((v % (max + 1)) + (max + 1)) % (max + 1);
  const commit = () => {
    const n = Number(text);
    if (/^\d{1,2}$/.test(text) && n >= 0 && n <= max) onChange(n);
    setText(pad(/^\d{1,2}$/.test(text) && n <= max ? n : value));
  };
  return (
    <div className={`dv-unit ${compact ? 'compact' : ''}`}>
      <button onClick={() => onChange(wrap(value + 1))} title="+1"><ChevronUp size={compact ? 14 : 18} /></button>
      <input className="dv-digits" value={text} inputMode="numeric" maxLength={2} aria-label={label}
        onFocus={(e) => { focused.current = true; e.target.select(); }}
        onBlur={() => { focused.current = false; commit(); }}
        onChange={(e) => {
          const t = e.target.value.replace(/\D/g, '').slice(0, 2);
          setText(t);
          const n = Number(t);
          if (t.length === 2 && n <= max) onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') { e.preventDefault(); onChange(wrap(value + (e.shiftKey && bigStep ? bigStep : 1))); }
          if (e.key === 'ArrowDown') { e.preventDefault(); onChange(wrap(value - (e.shiftKey && bigStep ? bigStep : 1))); }
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }} />
      <button onClick={() => onChange(wrap(value - 1))} title="−1"><ChevronDown size={compact ? 14 : 18} /></button>
      {!compact && <span className="dv-unit-label">{label}{bigStep ? ' (shift ±10)' : ''}</span>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Screen

function ScreenCard({ data, refresh, busy, act, confirm, toast, setLive, onReboot, onGoMaint }: {
  data: DevState; refresh: () => void; busy: string | null; act: ActFn;
  confirm: ReturnType<typeof useApp>['confirm']; toast: ReturnType<typeof useApp>['toast'];
  setLive: SetLive; onReboot: () => void; onGoMaint: () => void;
}) {
  const [bl, setBl] = useState<number | null>(null);
  const [prevBl, setPrevBl] = useState<number | null>(null);
  const [needBoot, setNeedBoot] = useState(false);
  const live = data.bl ?? 0;
  const shown = bl ?? live;
  const eff = data.effective;
  const saved = Number(eff.BACKLIGHT ?? '90');
  const max = data.blMax || 255;
  // echo-penguin v0.2.9+: automatic brightness, and a screen turned off from here wakes on a tap.
  const autoSupported = 'AUTO_BRIGHTNESS' in data.defaults;
  const auto = autoSupported && eff.AUTO_BRIGHTNESS === '1' && saved > 0;

  const writeBl = async (n: number) => {
    const v = Math.max(0, Math.min(max, Math.round(n)));
    if (!Number.isInteger(v)) return false;
    // Unblank the framebuffer too (BACKLIGHT=0 at boot blanks it, see p_backlight).
    const cmd = v > 0
      ? `echo 0 > /sys/class/graphics/fb0/blank 2>/dev/null; echo ${v} > ${BACKLIGHT_SYS}/brightness`
      : `echo 0 > ${BACKLIGHT_SYS}/brightness`;
    return act('bl', () => run(cmd)).then((ok) => { setBl(null); refresh(); return ok; });
  };

  const commitSlider = () => { if (bl != null && bl !== live) writeBl(bl); };

  const saveDefault = async () => {
    const v = shown;
    const bad = validateSetting(META_BY_KEY.BACKLIGHT, String(v));
    if (bad) return toast(`BACKLIGHT: ${bad}`, 'error');
    if (v === 0 && !(await confirm({
      title: 'Brilho 0 como padrão',
      message: 'Com BACKLIGHT=0 a tela fica desligada (e apagada) a cada boot. Para religá-la será preciso usar este app (ou o console USB): na própria tela não há como, ela estará escura.',
      confirmLabel: 'Salvar mesmo assim', danger: true,
    }))) return;
    await act('bldef', () => run(setCommand('BACKLIGHT', String(v), data.defaults.BACKLIGHT)), `Brilho padrão (BACKLIGHT) = ${v}`);
    refresh();
  };

  const screenOff = async () => {
    setPrevBl(live);
    await writeBl(0);
  };
  const screenOn = async () => {
    const target = prevBl && prevBl > 0 ? prevBl : saved > 0 ? saved : 90;
    await writeBl(target);
  };

  const setScreen = async (key: 'SCREEN_UI' | 'SCREEN_MIRROR' | 'SCREEN_LOGLEVEL', value: string) => {
    if (key === 'SCREEN_UI' && value === '0' && !(await confirm({
      title: 'Desligar a interface de toque',
      message: 'Com SCREEN_UI=0 a tela passa a mostrar só o console de logs: sem relógio, sem botões, sem brilho automático e os ALARMES NÃO TOCAM.\n\nVale depois de reiniciar o Echo.',
      confirmLabel: 'Desligar interface', danger: true,
    }))) return;
    const ok = await act(key, () => run(setCommand(key, value, data.defaults[key])),
      `${key}=${value} salvo — ${key === 'SCREEN_MIRROR' ? 'vale para as próximas sessões SSH/USB' : 'vale depois de reiniciar o Echo'}`);
    if (ok && key !== 'SCREEN_MIRROR') setNeedBoot(true);
    refresh();
  };

  const loglevelLive = data.printk;
  const custom = (k: string) => k in data.overrides && <Badge tone="info">personalizado</Badge>;

  return (
    <Card title="Tela" icon={<Monitor size={16} />}>
      <div className="col gap-m">
        {autoSupported && (
          <div className="dv-opt">
            <div>
              <div className="dv-opt-title">Brilho automático <span className="mono muted small">AUTO_BRIGHTNESS</span>{custom('AUTO_BRIGHTNESS')}</div>
              <div className="dv-opt-desc">A tela segue a luz do ambiente pelo sensor de luz: escurece quando a luz do quarto apaga e volta a clarear com ela.</div>
            </div>
            <Switch checked={auto} disabled={busy === 'AUTO_BRIGHTNESS' || saved === 0} onChange={(v) =>
              setLive('AUTO_BRIGHTNESS', v ? 1 : 0, v ? 'Brilho automático ligado (a tela aplica em alguns segundos)' : 'Brilho automático desligado')} />
          </div>
        )}

        {auto ? (
          <AutoBrightness data={data} busy={busy} setLive={setLive} />
        ) : (
          <div className="col gap-s">
            <div className="row between">
              <span className="field-label">Brilho {data.bl === 0 && <Badge tone="warn">tela desligada</Badge>}</span>
              <span className="muted small">padrão no boot (BACKLIGHT): {saved}{custom('BACKLIGHT')}</span>
            </div>
            <div className="dv-slider">
              <Moon size={16} className="muted" />
              <input type="range" min={0} max={max} value={shown}
                onChange={(e) => setBl(Number(e.target.value))}
                onPointerUp={commitSlider} onKeyUp={commitSlider} />
              <Sun size={18} className="muted" />
              <span className="dv-val">{shown}<span className="muted small"> / {max}</span></span>
            </div>
            <span className="field-hint">Aplicado na hora ao soltar o controle. A interface da tela usa no mínimo 10 em seus botões.</span>
            <div className="row gap-s wrap">
              <Button size="s" icon={<Save size={13} />} busy={busy === 'bldef'} disabled={shown === saved} onClick={saveDefault}>Salvar como padrão</Button>
            </div>
          </div>
        )}

        <div className="col gap-s">
          <div className="row gap-s wrap">
            {live > 0
              ? <Button size="s" icon={<Power size={13} />} busy={busy === 'bl'} onClick={screenOff}>Desligar tela</Button>
              : <Button size="s" variant="primary" icon={<Power size={13} />} busy={busy === 'bl'} onClick={screenOn}>Ligar tela</Button>}
            {auto && <span className="muted small">Agora: {live} / {max}</span>}
          </div>
          {live === 0 && (autoSupported
            ? <div className="dv-note"><Info size={15} /><div>A tela está desligada. Um toque nela a religa, e um alarme tocando também.</div></div>
            : <div className="dv-note"><Info size={15} /><div>Com a tela desligada por aqui, um toque nela não a religa (a interface não sabe que está escura) e pode acionar um botão invisível. O alarme não religa a tela neste caso — use “Ligar tela”.</div></div>)}
        </div>

        <div>
          <div className="dv-opt">
            <div>
              <div className="dv-opt-title">Interface de toque <span className="mono muted small">SCREEN_UI</span>{custom('SCREEN_UI')}<Badge tone="warn">após reiniciar</Badge></div>
              <div className="dv-opt-desc">{META_BY_KEY.SCREEN_UI.desc}</div>
            </div>
            <Switch checked={(eff.SCREEN_UI ?? '1') === '1'} disabled={busy === 'SCREEN_UI'} onChange={(v) => setScreen('SCREEN_UI', v ? '1' : '0')} />
          </div>
          <div className="dv-opt">
            <div>
              <div className="dv-opt-title">Espelhar sessões na tela <span className="mono muted small">SCREEN_MIRROR</span>{custom('SCREEN_MIRROR')}<Badge tone="muted">novas sessões</Badge></div>
              <div className="dv-opt-desc">{META_BY_KEY.SCREEN_MIRROR.desc}</div>
            </div>
            <Switch checked={(eff.SCREEN_MIRROR ?? '1') === '1'} disabled={busy === 'SCREEN_MIRROR'} onChange={(v) => setScreen('SCREEN_MIRROR', v ? '1' : '0')} />
          </div>
          <div className="dv-opt">
            <div>
              <div className="dv-opt-title">
                Mensagens do kernel na tela <span className="mono muted small">SCREEN_LOGLEVEL</span>{custom('SCREEN_LOGLEVEL')}<Badge tone="warn">após reiniciar</Badge>
                {loglevelLive != null && String(loglevelLive) !== (eff.SCREEN_LOGLEVEL ?? '4') && <Badge tone="info" title="/proc/sys/kernel/printk">agora: {loglevelLive}</Badge>}
              </div>
              <div className="dv-opt-desc">{META_BY_KEY.SCREEN_LOGLEVEL.desc}</div>
            </div>
            <select className="input" value={eff.SCREEN_LOGLEVEL ?? '4'} disabled={busy === 'SCREEN_LOGLEVEL'} onChange={(e) => setScreen('SCREEN_LOGLEVEL', e.target.value)}>
              {(META_BY_KEY.SCREEN_LOGLEVEL.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {needBoot && (
          <div className="dv-note info">
            <Info size={15} />
            <div className="grow">Salvo. SCREEN_UI e SCREEN_LOGLEVEL só são aplicados no boot.</div>
            <Button size="s" variant="danger" busy={busy === 'reboot'} onClick={onReboot}>Reiniciar o Echo</Button>
            <Button size="s" variant="ghost" onClick={onGoMaint}>Manutenção</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** The two levels automatic brightness moves between, and the sensor's thresholds, set from here. */
function AutoBrightness({ data, busy, setLive }: { data: DevState; busy: string | null; setLive: SetLive }) {
  const eff = data.effective;
  const num = (k: string, d: number) => (/^\d+$/.test(eff[k] ?? '') ? Number(eff[k]) : d);
  const hi = num('BACKLIGHT', 90);
  const lo = Math.min(hi, num('BACKLIGHT_DARK', 10));
  const dark = num('LIGHT_DARK', 3);
  const bright = num('LIGHT_BRIGHT', 80);
  const [hiDraft, setHi] = useState<number | null>(null);
  const [loDraft, setLo] = useState<number | null>(null);
  const light = data.light;
  const custom = (k: string) => k in data.overrides && <Badge tone="info">personalizado</Badge>;

  const commitHi = () => {
    if (hiDraft == null || hiDraft === hi) return setHi(null);
    setLive('BACKLIGHT', hiDraft, `Brilho no ambiente claro: ${hiDraft}`).then(() => setHi(null));
  };
  const commitLo = () => {
    if (loDraft == null || loDraft === lo) return setLo(null);
    setLive('BACKLIGHT_DARK', loDraft, `Brilho no ambiente escuro: ${loDraft}`).then(() => setLo(null));
  };

  // Calibration from the reading now: "this is dark" (shared with the night clock and the sleep diary) / "this is a lit room".
  const thisIsDark = () => calibrateDark(data, setLive);
  const thisIsLit = () => {
    if (light == null) return;
    const v = Math.max(dark + 1, light);
    return setLive('LIGHT_BRIGHT', Math.min(4095, v), `Claro: leituras a partir de ${v}`);
  };

  return (
    <div className="col gap-m">
      <div className="col gap-s">
        <div className="row between">
          <span className="field-label">Ambiente claro {custom('BACKLIGHT')}</span>
          <span className="muted small mono">BACKLIGHT</span>
        </div>
        <div className="dv-slider">
          <SunDim size={16} className="muted" />
          <input type="range" min={10} max={255} value={hiDraft ?? hi} disabled={busy === 'BACKLIGHT'}
            onChange={(e) => setHi(Number(e.target.value))} onPointerUp={commitHi} onKeyUp={commitHi} />
          <Sun size={18} className="muted" />
          <span className="dv-val">{hiDraft ?? hi}<span className="muted small"> / 255</span></span>
        </div>
      </div>
      <div className="col gap-s">
        <div className="row between">
          <span className="field-label">Ambiente escuro {custom('BACKLIGHT_DARK')}</span>
          <span className="muted small mono">BACKLIGHT_DARK</span>
        </div>
        <div className="dv-slider">
          <Moon size={16} className="muted" />
          <input type="range" min={1} max={Math.max(1, hi)} value={Math.min(loDraft ?? lo, hi)} disabled={busy === 'BACKLIGHT_DARK'}
            onChange={(e) => setLo(Number(e.target.value))} onPointerUp={commitLo} onKeyUp={commitLo} />
          <SunDim size={18} className="muted" />
          <span className="dv-val">{loDraft ?? lo}<span className="muted small"> / 255</span></span>
        </div>
        <span className="field-hint">Salvos ao soltar; a tela aplica em alguns segundos, com uma transição suave.</span>
      </div>
      <div className="dv-note">
        <Info size={15} />
        <div className="grow col gap-s">
          <div>
            Luz ambiente agora: <b>{light ?? 'sem sensor'}</b>{light != null && <span className="muted"> (0–4095)</span>}.
            Escuro até <b>{dark}</b> <span className="mono muted small">LIGHT_DARK</span>, claro a partir de <b>{bright}</b> <span className="mono muted small">LIGHT_BRIGHT</span>; entre os dois, o brilho é intermediário.
          </div>
          <div className="row gap-s wrap">
            <Button size="s" icon={<Moon size={13} />} disabled={light == null} busy={busy === 'LIGHT_DARK'} onClick={thisIsDark}
              title="Com a luz do quarto apagada: as leituras até um pouco acima desta contam como escuro">Está escuro agora</Button>
            <Button size="s" icon={<Sun size={13} />} disabled={light == null} busy={busy === 'LIGHT_BRIGHT'} onClick={thisIsLit}
              title="Com o quarto aceso: esta leitura e as maiores contam como claro">Está claro agora</Button>
          </div>
          <span className="field-hint">Use “Está escuro agora” com a luz do quarto apagada se a tela continuar forte; a leitura é atualizada a cada 30 s (ou em Atualizar).</span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Sound

function SoundCard({ data, refresh, busy, act }: { data: DevState; refresh: () => void; busy: string | null; act: ActFn }) {
  const [vol, setVol] = useState<number | null>(null);
  const [hz, setHz] = useState('880');
  const [ms, setMs] = useState('200');
  const [count, setCount] = useState('1');
  const live = data.vol;
  const shown = vol ?? live ?? 0;
  const saved = data.effective.VOLUME ?? '50';

  const commit = () => {
    if (vol == null || vol === live) return;
    const v = Math.max(0, Math.min(100, Math.round(vol)));
    if (!Number.isInteger(v)) return;
    // Live on the amplifier, then kept for the next boot (what the screen's buttons do too).
    act('vol', () => run(`penguin-sound volume ${v} && ${setCommand('VOLUME', String(v), undefined)}`), `Volume ${v}% (salvo como VOLUME)`)
      .then(() => { setVol(null); refresh(); });
  };

  const beepErr = (() => {
    const H = Number(hz), M = Number(ms), C = Number(count);
    if (!/^\d+$/.test(hz) || H < 50 || H > 12000) return 'frequência: 50–12000 Hz';
    if (!/^\d+$/.test(ms) || M < 20 || M > 5000) return 'duração: 20–5000 ms';
    if (!/^\d+$/.test(count) || C < 1 || C > 10) return 'repetições: 1–10';
    return null;
  })();

  const beep = (custom: boolean) => {
    if (custom && beepErr) return;
    const args = custom ? ` ${Number(hz)} ${Number(ms)} ${Number(count)}` : '';
    const timeout = custom ? Number(count) * (Number(ms) + 500) + 15000 : 15000;
    return act(custom ? 'beep2' : 'beep', () => run(`penguin-sound beep${args}`, { timeout }));
  };

  return (
    <Card title="Som" icon={<Volume2 size={16} />}>
      <div className="col gap-m">
        <div className="col gap-s">
          <div className="row between">
            <span className="field-label">Volume</span>
            <span className="muted small">no boot (VOLUME): {saved}%</span>
          </div>
          {live == null ? (
            <ErrorBox error={`Não foi possível ler o volume: ${data.volErr}`} />
          ) : (
            <div className="dv-slider">
              <Volume2 size={16} className="muted" />
              <input type="range" min={0} max={100} step={1} value={shown}
                onChange={(e) => setVol(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} />
              <span className="dv-val">{shown}%</span>
            </div>
          )}
          <span className="field-hint">Aplicado ao soltar (penguin-sound volume) e salvo para o próximo boot (penguin set VOLUME). Os botões de volume do Echo também o alteram.</span>
        </div>
        <div className="row gap-s">
          <Button variant="primary" icon={<Play size={14} />} busy={busy === 'beep'} onClick={() => beep(false)}>Testar som</Button>
          <span className="muted small">bipe de 880 Hz, 200 ms</span>
        </div>
        <div className="col gap-s">
          <span className="field-label">Bipe personalizado</span>
          <div className="dv-beep">
            <label className="field"><span className="field-hint">Hz</span><input className="input" inputMode="numeric" value={hz} onChange={(e) => setHz(e.target.value)} /></label>
            <label className="field"><span className="field-hint">ms</span><input className="input" inputMode="numeric" value={ms} onChange={(e) => setMs(e.target.value)} /></label>
            <label className="field"><span className="field-hint">vezes</span><input className="input" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} /></label>
            <Button icon={<Play size={14} />} busy={busy === 'beep2'} disabled={!!beepErr} onClick={() => beep(true)}>Tocar</Button>
          </div>
          {beepErr && <span className="st-err" style={{ color: 'var(--bad)', fontSize: 12 }}>{beepErr}</span>}
          <span className="field-hint">Sempre via penguin-sound (tem o contorno que evita o kernel panic do driver de áudio). Se algo já estiver tocando, o bipe é ignorado.</span>
        </div>
      </div>
    </Card>
  );
}
