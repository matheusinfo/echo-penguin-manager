// "Alarme & Tela": the touch UI's alarm (/data/penguin/alarm.json), the screen and the speaker.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlarmClock, Bell, BellOff, ChevronDown, ChevronUp, Info, Monitor, Moon, Play, RefreshCw, Save, Sun, TriangleAlert, Undo2, Volume2, Power,
} from 'lucide-react';
import { echo, run, runSections } from '../api';
import { useApp, usePoll } from '../hooks';
import { Badge, Button, Card, ErrorBox, Grid, Loading, NeedsConnection, Page, RefreshButton, Switch } from '../components/ui';
import {
  ALARM_FILE, BACKLIGHT_SYS, DEFAULTS_FILE, SETTINGS_FILE, META_BY_KEY, parseConf, parseEffective, setCommand, validateSetting,
} from './settings/lib';
import { usePenguinActions } from './settings/actions';
import './Device.css';

// --- Alarm model (mirrors penguin-ui's Clocks).

type Repeat = 'daily' | 'weekdays' | 'weekends' | 'once';
/** sound: 'beep' or a file name in /data/penguin/music, chosen on the screen (kept as is here). */
interface Alarm { on: boolean; h: number; m: number; repeat: Repeat; sound: string }
const REPEATS: { id: Repeat; label: string; long: string }[] = [
  { id: 'daily', label: 'Todo dia', long: 'todo dia' },
  { id: 'weekdays', label: 'Seg–sex', long: 'de segunda a sexta' },
  { id: 'weekends', label: 'Sáb e dom', long: 'sábado e domingo' },
  { id: 'once', label: 'Uma vez', long: 'uma vez (desliga depois de tocar)' },
];
const DEFAULT_ALARM: Alarm = { on: false, h: 7, m: 0, repeat: 'daily', sound: 'beep' };

/** What penguin-ui accepts as the alarm's sound (else it uses the beep). */
const validSound = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 255 && !v.includes('/') && !/[\x00-\x1f\x7f]/.test(v);
const WD_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function parseAlarm(raw: string | null): { alarm: Alarm; problem: string | null } {
  if (raw == null || raw.trim() === '') return { alarm: { ...DEFAULT_ALARM }, problem: raw == null ? 'arquivo ainda não existe (a tela usa 07:00, desligado)' : 'arquivo vazio' };
  try {
    const parsed: unknown = JSON.parse(raw);
    const j = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    const a = { ...DEFAULT_ALARM, ...j } as Alarm;
    let problem: string | null = parsed === j ? null : 'JSON não é um objeto (a tela usa os padrões)';
    if (!validSound(a.sound)) a.sound = 'beep';
    if (!REPEATS.some((r) => r.id === a.repeat)) { a.repeat = 'daily'; problem = `repeat "${j.repeat}" desconhecido (a tela usa "daily")`; }
    if (!Number.isInteger(a.h) || a.h < 0 || a.h > 23 || !Number.isInteger(a.m) || a.m < 0 || a.m > 59 || typeof a.on !== 'boolean') {
      problem = 'valores fora do formato esperado';
      a.h = Math.min(23, Math.max(0, Math.floor(Number(a.h)) || 0));
      a.m = Math.min(59, Math.max(0, Math.floor(Number(a.m)) || 0));
      a.on = !!a.on;
    }
    // Only the known fields: anything else in the file is not carried into the draft.
    return { alarm: { on: a.on, h: a.h, m: a.m, repeat: a.repeat, sound: a.sound }, problem };
  } catch {
    return { alarm: { ...DEFAULT_ALARM }, problem: 'JSON inválido (a tela usa os padrões)' };
  }
}

const soundLabel = (v: string) => (v === 'beep' ? 'bipe' : v);
const akey = (a: Alarm) => `${a.on}|${a.h}|${a.m}|${a.repeat}|${a.sound}`;
const pad = (n: number) => String(n).padStart(2, '0');

/** Same formatting as Python's json.dump, which penguin-ui uses. */
function alarmJson(a: Alarm): string {
  return `{"on": ${a.on ? 'true' : 'false'}, "h": ${a.h}, "m": ${a.m}, "repeat": ${JSON.stringify(a.repeat)}, "sound": ${JSON.stringify(a.sound)}}`;
}

function validAlarm(a: Alarm): string | null {
  if (typeof a.on !== 'boolean') return 'on inválido';
  if (!Number.isInteger(a.h) || a.h < 0 || a.h > 23) return 'hora deve ser 0–23';
  if (!Number.isInteger(a.m) || a.m < 0 || a.m > 59) return 'minuto deve ser 0–59';
  if (!REPEATS.some((r) => r.id === a.repeat)) return 'repetição inválida';
  if (!validSound(a.sound)) return 'som do alarme inválido';
  return null;
}

/**
 * Next ring, from the device's wall clock (a Date whose UTC fields are the Echo's local time).
 * Same rule as penguin-ui's until_alarm(): the current minute counts as "tomorrow".
 */
function nextRing(a: Alarm, now: Date): { mins: number; at: Date } {
  const today = now.getUTCHours() * 60 + now.getUTCMinutes();
  let mins = a.h * 60 + a.m - today;
  if (mins <= 0) mins += 1440;
  const ringsOn = (sundayBased: number) => {
    const py = (sundayBased + 6) % 7; // Python: Monday = 0
    return a.repeat === 'weekdays' ? py < 5 : a.repeat === 'weekends' ? py >= 5 : true;
  };
  for (let i = 0; i < 8 && !ringsOn((now.getUTCDay() + Math.floor((today + mins) / 1440)) % 7); i++) mins += 1440;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { mins, at: new Date(start + (today + mins) * 60000) };
}

function fmtUntil(mins: number): string {
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return (d ? `${d} d ` : '') + `${h} h ${pad(m)} min`;
}

// --- Device state.

interface DevState {
  alarmRaw: string | null;
  bl: number | null;
  blMax: number;
  vol: number | null;
  volErr: string | null;
  effective: Record<string, string>;
  defaults: Record<string, string>;
  overrides: Record<string, string>;
  uiPid: string;
  printk: number | null;
  /** device wall clock minus our clock, ms (device local time encoded as UTC). */
  clockOffset: number | null;
  tz: string;
}

const NOFILE = '@@NOFILE@@';

/** What does not change while the page is open (the image's defaults, the panel's range): read once. */
interface DevStatic { defaults: Record<string, string>; blMax: number }

async function loadDevice(cache: { current: DevStatic | null }): Promise<DevState> {
  const s = await runSections({
    alarm: `cat ${ALARM_FILE} 2>/dev/null || echo '${NOFILE}'`,
    bl: `cat ${BACKLIGHT_SYS}/brightness`,
    vol: 'penguin-sound volume',
    eff: 'penguin settings',
    conf: `cat ${SETTINGS_FILE} 2>/dev/null; true`,
    ui: 'pidof penguin-ui; true',
    printk: 'cat /proc/sys/kernel/printk',
    now: "date '+%Y %m %d %H %M %S %Z'",
    ...(cache.current ? {} : { blmax: `cat ${BACKLIGHT_SYS}/max_brightness`, defs: `cat ${DEFAULTS_FILE}` }),
  });
  const int = (v: string | undefined) => (v != null && /^\s*\d+\s*$/.test(v) ? Number(v) : null);
  if (!cache.current) {
    const defaults = parseConf(s.defs ?? '');
    const st = { defaults, blMax: int(s.blmax) ?? 255 };
    if (Object.keys(defaults).length) cache.current = st; // else: read again next time
    return buildDevState(s, st, int);
  }
  return buildDevState(s, cache.current, int);
}

function buildDevState(s: Record<string, string>, st: DevStatic, int: (v: string | undefined) => number | null): DevState {
  const n = (s.now ?? '').trim().split(/\s+/);
  let clockOffset: number | null = null;
  if (n.length >= 6 && n.slice(0, 6).every((x) => /^\d+$/.test(x))) {
    const [Y, M, D, h, mi, se] = n.map(Number);
    clockOffset = Date.UTC(Y, M - 1, D, h, mi, se) - Date.now();
  }
  const alarmRaw = s.alarm == null || s.alarm.trim() === NOFILE ? null : s.alarm;
  return {
    alarmRaw,
    bl: int(s.bl),
    blMax: st.blMax,
    vol: int(s.vol),
    volErr: int(s.vol) == null ? (s.vol ?? '').trim() || 'sem resposta' : null,
    effective: parseEffective(s.eff ?? ''),
    defaults: st.defaults,
    overrides: parseConf(s.conf ?? ''),
    uiPid: (s.ui ?? '').trim(),
    printk: int((s.printk ?? '').trim().split(/\s+/)[0]),
    clockOffset,
    tz: n[6] ?? '',
  };
}

const RESTART_UI = `old=$(pidof penguin-ui); killall penguin-ui 2>/dev/null; i=0
while [ $i -lt 15 ]; do n=$(pidof penguin-ui); if [ -n "$n" ] && [ "$n" != "$old" ]; then echo "$n"; exit 0; fi; sleep 1; i=$((i+1)); done
echo 'a interface (penguin-ui) não voltou em 15 s' >&2; exit 1`;

export default function DevicePage() {
  const { connected } = useApp();
  return (
    <Page title="Alarme & Tela" subtitle="O alarme, o brilho e o som do Echo (os mesmos da interface de toque)">
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
      <AlarmCard data={data} refresh={refresh} />
      <Grid cols={2}>
        <ScreenCard data={data} refresh={refresh} busy={busy} act={act} confirm={confirm} toast={toast}
          onReboot={() => rebootEcho('Para aplicar as configurações de tela que só valem no boot.')}
          onGoMaint={() => navigate('settings', { tab: 'maint' })} />
        <SoundCard data={data} refresh={refresh} busy={busy} act={act} />
      </Grid>
    </>
  );
}

type ActFn = (key: string, fn: () => Promise<unknown>, okMsg?: string) => Promise<boolean>;

// ------------------------------------------------------------------------------------------------
// Alarm

function AlarmCard({ data, refresh }: { data: DevState; refresh: () => void }) {
  const { confirm, toast } = useApp();
  const [base, setBase] = useState<{ raw: string | null; alarm: Alarm } | null>(null);
  const [draft, setDraft] = useState<Alarm | null>(null);
  const [saving, setSaving] = useState(false);
  const [, setTick] = useState(0);

  const device = useMemo(() => parseAlarm(data.alarmRaw), [data.alarmRaw]);

  // First load, and adopting changes made on the Echo while nothing is being edited here.
  useEffect(() => {
    if (!base || !draft) {
      setBase({ raw: data.alarmRaw, alarm: device.alarm });
      setDraft(device.alarm);
      return;
    }
    if (akey(device.alarm) !== akey(base.alarm) && akey(draft) === akey(base.alarm)) {
      setBase({ raw: data.alarmRaw, alarm: device.alarm });
      setDraft(device.alarm);
      toast('O alarme foi alterado no Echo; valores atualizados', 'info');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);

  if (!base || !draft) return null;

  const dirty = akey(draft) !== akey(base.alarm);
  const conflict = dirty && akey(device.alarm) !== akey(base.alarm);
  const now = data.clockOffset != null ? new Date(Date.now() + data.clockOffset) : null;
  const next = now ? nextRing(draft, now) : null;
  const screenUiOff = (data.effective.SCREEN_UI ?? '1') !== '1';
  const set = (p: Partial<Alarm>) => setDraft({ ...draft, ...p });
  const fmtAlarm = (a: Alarm) => `${pad(a.h)}:${pad(a.m)}, ${REPEATS.find((r) => r.id === a.repeat)?.long}, ${a.on ? 'ligado' : 'desligado'}, som: ${soundLabel(a.sound)}`;

  const save = async () => {
    const err = validAlarm(draft);
    if (err) return toast(err, 'error');
    const content = alarmJson(draft);
    // Validate what is about to be written.
    const back = JSON.parse(content) as Alarm;
    if (akey(back) !== akey(draft)) return toast('Falha ao gerar o JSON do alarme', 'error');

    let current: string | null = null;
    try {
      const r = await echo.exec(`cat ${ALARM_FILE} 2>/dev/null || echo '${NOFILE}'`);
      current = r.stdout.trim() === NOFILE ? null : r.stdout;
    } catch { /* keep null */ }
    const curAlarm = parseAlarm(current).alarm;
    const changedThere = akey(curAlarm) !== akey(base.alarm) && akey(curAlarm) !== akey(draft);

    const ok = await confirm({
      title: 'Salvar alarme',
      message:
        (changedThere ? `⚠ O alarme foi alterado no Echo desde que você abriu esta página (agora: ${fmtAlarm(curAlarm)}). Salvar substitui essa mudança.\n\n` : '') +
        `Novo alarme: ${fmtAlarm(draft)}.\n\n` +
        `O arquivo ${ALARM_FILE} é gravado e a interface da tela (penguin-ui) é reiniciada para carregar o novo alarme — ela só o lê ao iniciar.\n\n` +
        'Ao reiniciar a interface: o cronômetro e o timer da tela são zerados, e um alarme ou timer que esteja tocando para. A tela volta à tela inicial em 1–2 s.',
      confirmLabel: 'Salvar e reiniciar a interface',
      danger: changedThere,
    });
    if (!ok) return;
    setSaving(true);
    try {
      await run('mkdir -p /data/penguin');
      await echo.writeFile(ALARM_FILE, content);
      const written = (await run(`cat ${ALARM_FILE}`)).trim();
      if (akey(parseAlarm(written).alarm) !== akey(draft)) throw new Error('O arquivo gravado não confere; tente de novo');
      await run(RESTART_UI, { timeout: 30000 });
      setBase({ raw: written, alarm: draft });
      toast(draft.on && next ? `Alarme salvo: toca em ${fmtUntil(next.mins)}` : 'Alarme salvo', 'ok');
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
    setBase({ raw: data.alarmRaw, alarm: device.alarm });
    setDraft(device.alarm);
  };

  return (
    <Card title="Alarme" icon={<AlarmClock size={16} />}
      actions={<>
        {dirty && <Badge tone="warn">não salvo</Badge>}
        <Button size="s" variant="ghost" icon={<RefreshCw size={13} />} busy={saving && !dirty} onClick={restartUi} title="killall penguin-ui (o init reinicia)">Reiniciar interface</Button>
      </>}>
      <div className="col gap-m">
        {conflict && (
          <div className="dv-note warn">
            <TriangleAlert size={15} />
            <div className="grow">O alarme mudou no Echo enquanto você editava (agora: {fmtAlarm(device.alarm)}).</div>
            <Button size="s" onClick={reload}>Usar o do Echo</Button>
          </div>
        )}
        {screenUiOff && (
          <div className="dv-note warn"><TriangleAlert size={15} /><div>SCREEN_UI=0: a interface de toque não roda, então o alarme <b>não toca</b>. Ligue “Interface de toque” abaixo e reinicie o Echo.</div></div>
        )}
        {device.problem && <div className="dv-note"><Info size={15} /><div>{ALARM_FILE}: {device.problem}.</div></div>}

        <div className="dv-alarm">
          <div className={`dv-clock ${draft.on ? '' : 'off'}`}>
            <TimeUnit label="hora" value={draft.h} max={23} onChange={(h) => set({ h })} />
            <span className="dv-colon">:</span>
            <TimeUnit label="min" value={draft.m} max={59} onChange={(m) => set({ m })} bigStep={10} />
          </div>
          <div className="col gap-m">
            <div className="row gap-m wrap">
              <Switch checked={draft.on} onChange={(on) => set({ on })} label={draft.on ? <b>Alarme ligado</b> : 'Alarme desligado'} />
            </div>
            <div className="dv-seg">
              {REPEATS.map((r) => (
                <button key={r.id} className={draft.repeat === r.id ? 'active' : ''} onClick={() => set({ repeat: r.id })}>{r.label}</button>
              ))}
            </div>
            {draft.on && next ? (
              <div>
                <div className="dv-next"><Bell size={18} style={{ verticalAlign: -3 }} /> Toca em {fmtUntil(next.mins)}</div>
                <div className="muted small">
                  {WD_SHORT[next.at.getUTCDay()]}, {pad(next.at.getUTCDate())}/{pad(next.at.getUTCMonth() + 1)} às {pad(draft.h)}:{pad(draft.m)} (hora do Echo)
                  {draft.repeat === 'once' && ' · depois de tocar ele se desliga'}
                </div>
              </div>
            ) : (
              <div className="dv-next off"><BellOff size={16} style={{ verticalAlign: -3 }} /> {draft.on ? 'Hora do Echo desconhecida' : 'Não vai tocar'}</div>
            )}
            <div className="row gap-s">
              <Button variant="primary" icon={<Save size={14} />} busy={saving} disabled={!dirty} onClick={save}>Salvar</Button>
              {dirty && <Button icon={<Undo2 size={14} />} onClick={() => setDraft(base.alarm)}>Desfazer</Button>}
            </div>
          </div>
        </div>
        <div className="muted small">
          Som: <b>{soundLabel(draft.sound)}</b> (escolhido na tela do Echo; mantido ao salvar daqui).
        </div>
        <div className="muted small">
          No Echo: <code className="mono">{data.alarmRaw?.trim() ?? '(sem arquivo)'}</code> — toca por até 10 min; os botões de volume ou um toque param o alarme.
        </div>
      </div>
    </Card>
  );
}

function TimeUnit({ label, value, max, onChange, bigStep }: { label: string; value: number; max: number; onChange: (v: number) => void; bigStep?: number }) {
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
    <div className="dv-unit">
      <button onClick={() => onChange(wrap(value + 1))} title="+1"><ChevronUp size={18} /></button>
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
      <button onClick={() => onChange(wrap(value - 1))} title="−1"><ChevronDown size={18} /></button>
      <span className="dv-unit-label">{label}{bigStep ? ' (shift ±10)' : ''}</span>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Screen

function ScreenCard({ data, refresh, busy, act, confirm, toast, onReboot, onGoMaint }: {
  data: DevState; refresh: () => void; busy: string | null; act: ActFn;
  confirm: ReturnType<typeof useApp>['confirm']; toast: ReturnType<typeof useApp>['toast'];
  onReboot: () => void; onGoMaint: () => void;
}) {
  const [bl, setBl] = useState<number | null>(null);
  const [prevBl, setPrevBl] = useState<number | null>(null);
  const [needBoot, setNeedBoot] = useState(false);
  const live = data.bl ?? 0;
  const shown = bl ?? live;
  const saved = Number(data.effective.BACKLIGHT ?? '90');
  const max = data.blMax || 255;

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
      message: 'Com SCREEN_UI=0 a tela passa a mostrar só o console de logs: sem relógio, sem botões e o ALARME NÃO TOCA.\n\nVale depois de reiniciar o Echo.',
      confirmLabel: 'Desligar interface', danger: true,
    }))) return;
    const ok = await act(key, () => run(setCommand(key, value, data.defaults[key])),
      `${key}=${value} salvo — ${key === 'SCREEN_MIRROR' ? 'vale para as próximas sessões SSH/USB' : 'vale depois de reiniciar o Echo'}`);
    if (ok && key !== 'SCREEN_MIRROR') setNeedBoot(true);
    refresh();
  };

  const eff = data.effective;
  const loglevelLive = data.printk;
  const custom = (k: string) => k in data.overrides && <Badge tone="info">personalizado</Badge>;

  return (
    <Card title="Tela" icon={<Monitor size={16} />}>
      <div className="col gap-m">
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
            {live > 0
              ? <Button size="s" icon={<Power size={13} />} busy={busy === 'bl'} onClick={screenOff}>Desligar tela</Button>
              : <Button size="s" variant="primary" icon={<Power size={13} />} busy={busy === 'bl'} onClick={screenOn}>Ligar tela</Button>}
          </div>
          {live === 0 && (
            <div className="dv-note"><Info size={15} /><div>Com a tela desligada por aqui, um toque nela não a religa (a interface não sabe que está escura) e pode acionar um botão invisível. O alarme não religa a tela neste caso — use “Ligar tela”.</div></div>
          )}
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
