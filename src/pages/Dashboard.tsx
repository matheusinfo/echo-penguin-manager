// "Visão geral": at-a-glance health summary of the Echo.
// One runSections() call per tick; cheap sections every tick, slow-changing ones (slot, alarm,
// weather, logs, crash records, release) every ~30 s, the sleep diary every ~5 min, all of
// them on manual refresh.
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlarmClock, AlarmClockOff, BedDouble, ChevronRight, Clock, CloudSun, Container, Cpu, Gauge, HardDrive, Info, Layers,
  MemoryStick, ScrollText, Server, ShieldAlert, ShieldCheck, ShieldX, Thermometer, Wifi,
} from 'lucide-react';
import { echo, fmtBytes, fmtDuration, runSections, shq } from '../api';
import { useApp, usePoll } from '../hooks';
import {
  Badge, Button, Card, Dot, Empty, ErrorBox, Grid, KV, Loading, Meter, NeedsConnection, Page, Pre, RefreshButton,
  Sparkline, Stat, toneFor,
} from '../components/ui';
import { Alarm, AlarmsOnDevice, ALARMS_READ_CMD, nextAlarm, parseAlarmsSection } from './alarms';
import { Night, deviceTime, fmtSleep, hhmm, parseNights, sleepNightsCmd } from './sleep';
import { WEATHER_CREDIT, WEATHER_READ_CMD, WEATHER_STALE_S, WeatherCache, parseWeather, weatherLine } from './weather';
import './Dashboard.css';

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

// ---------------------------------------------------------------- types

interface Settings { zone: number; warn: number; crit: number; watchdog: string; ssh: string; docker: string }
interface Mem { total: number | null; avail: number | null; free: number | null; swapTotal: number | null; swapFree: number | null }
interface Disk { mount: string; total: number | null; used: number | null; avail: number | null; pct: number | null }
interface Wifi { ip: string | null; connected: boolean; ssid: string | null; signal: number | null; freq: number | null; bitrate: string | null }
interface Ctr { name: string; state: string; status: string; image: string; health: 'healthy' | 'unhealthy' | 'starting' | null }
interface SlotInfo { name: string; state: string; release: string }

interface Slow {
  release: string | null;
  kernel: string | null;
  slot: string | null;
  active: string | null;
  booted: string | null;
  slots: SlotInfo[];
  alarms: AlarmsOnDevice | null;
  /** echo-penguin v0.3.0+: the weather penguin-weather last fetched. */
  weather: WeatherCache | null;
  logLines: string[];
  crashCount: number | null;
  crashLatest: number | null; // epoch seconds
}

interface Snapshot {
  at: number;
  devEpoch: number | null;
  tzOffsetMin: number | null;
  uptime: number | null;
  load: [number, number, number] | null;
  procs: string | null;
  cpuPct: number | null;
  cpusOnline: string | null;
  mem: Mem;
  settings: Settings;
  temp: number | null;
  services: { name: string; running: boolean | null }[];
  dockerMode: string | null;
  containers: Ctr[] | null;
  dockerError: string | null;
  disks: Disk[];
  wifi: Wifi;
  slow: Slow | null;
  /** The newest night of the sleep diary (echo-penguin v0.3.0+); null when none, undefined before the first read. */
  lastNight: Night | null | undefined;
}

interface HistPoint { t: number; cpu: number | null; temp: number | null; mem: number | null }

interface Reason { tone: 'warn' | 'bad'; text: string }

// ---------------------------------------------------------------- constants

const SERVICES = ['techo5', 'dockerd', 'containerd', 'dropbear', 'wpa_supplicant', 'ntpd', 'watchdog'];
const SERVICE_DESC: Record<string, string> = {
  techo5: 'supervisor',
  dockerd: 'Docker',
  containerd: 'runtime de contêineres',
  dropbear: 'servidor SSH',
  wpa_supplicant: 'Wi-Fi',
  ntpd: 'relógio (NTP)',
  watchdog: 'watchdog de hardware',
};
const HISTORY_MAX = 120;
const HISTORY_KEY = 'dashboard-history';
const DEFAULT_SETTINGS: Settings = { zone: 12, warn: 75, crit: 85, watchdog: '1', ssh: 'on', docker: 'auto' };
const LOG_FILTER = 'warn|erro|fail|temp|restart|stopping|pausing|resuming|not running|did not|bad|rollback|panic|oom|killed';
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const REPEAT_LABEL: Record<string, string> = { daily: 'todo dia', weekdays: 'seg a sex', weekends: 'sáb e dom', once: 'uma vez' };
const LOAD_TOOLTIP =
  'Média de carga (1, 5 e 15 min). No Echo ela fica perto de 4 mesmo ocioso: quatro threads do kernel do ' +
  'fabricante (GCPU, display_esd_check, display_idle_detect, dynamic_boost) ficam em espera ininterrupta e o ' +
  'Linux as conta na carga. Não indica problema — veja o uso de CPU.';

// ---------------------------------------------------------------- shell sections

const FAST: Record<string, string> = {
  now: 'date "+%s %z"; cat /proc/uptime; cat /proc/loadavg; head -n 1 /proc/stat; cat /sys/devices/system/cpu/online',
  mem: "grep -E '^(MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
  cfg:
    '. /etc/penguin/defaults.conf 2>/dev/null; [ -r /data/penguin/settings.conf ] && . /data/penguin/settings.conf; ' +
    // TEMP_ZONE goes into a path below: only digits (anything else falls back to the default zone).
    'case "$TEMP_ZONE" in ""|*[!0-9]*) TEMP_ZONE=12;; esac; ' +
    'echo "TEMP_ZONE=$TEMP_ZONE"; echo "TEMP_WARN=$TEMP_WARN"; echo "TEMP_CRIT=$TEMP_CRIT"; ' +
    'echo "WATCHDOG=$WATCHDOG"; echo "SSH=$SSH"; echo "DOCKER=$DOCKER"; ' +
    'echo "RAW=$(cat /sys/class/thermal/thermal_zone$TEMP_ZONE/temp 2>/dev/null)"',
  svc: `for p in ${SERVICES.join(' ')}; do if pidof $p >/dev/null; then echo "$p 1"; else echo "$p 0"; fi; done`,
  docker:
    'm=$(cat /run/penguin/docker 2>/dev/null); echo "MODE=${m:-?}"; ' +
    `if [ "$m" = docker ]; then timeout 10 docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}'; fi`,
  disk: 'df -P /data /store',
  net:
    "echo \"IP=$(ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \\([0-9.\\/]*\\).*/\\1/p' | head -n 1)\"; " +
    'iw dev wlan0 link 2>/dev/null',
};

const SLOW: Record<string, string> = {
  info: 'cat /etc/techo5-release 2>/dev/null | head -n 1; uname -r; cat /run/techo5/slot 2>/dev/null || echo',
  slot: 'slotctl status 2>/dev/null',
  // The alarm file has no trailing newline: the command echoes one so the next section marker starts its own line.
  alarms: ALARMS_READ_CMD,
  weather: WEATHER_READ_CMD,
  sup: `tail -n 500 /data/penguin/logs/supervisor.log 2>/dev/null | grep -iE ${shq(LOG_FILTER)} | tail -n 8`,
  crash:
    'd=/data/techo5-linux/crash; ls "$d" 2>/dev/null | wc -l; ' +
    'f=$(ls -t "$d" 2>/dev/null | head -n 1); [ -n "$f" ] && stat -c %Y "$d/$f" 2>/dev/null; true',
};

/** penguin-sleep is a Python program: its section runs every few minutes only. Nothing on older images. */
const SLEEP: Record<string, string> = {
  sleep: `[ -x /usr/local/sbin/penguin-sleep ] && ${sleepNightsCmd(2)} 2>/dev/null; true`,
};
const SLEEP_EVERY_MS = 5 * 60000;

// ---------------------------------------------------------------- parsers

const num = (s: string | undefined | null): number | null => {
  if (s == null) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
};

function parseKV(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// The MT8163 hot-plugs cores, and the aggregate idle/iowait counters jump when a core goes on or
// offline, so idle/total is useless here. Busy time (user+nice+system+irq+softirq+steal) is
// monotonic: compare it with wall time (uptime) × online cores × USER_HZ (100).
function parseCpuLine(line: string | undefined): { busy: number } | null {
  if (!line || !line.startsWith('cpu ')) return null;
  const f = line.trim().split(/\s+/).slice(1, 9).map((x) => parseInt(x, 10) || 0);
  if (f.length < 4) return null;
  const busy = f[0] + f[1] + f[2] + (f[5] ?? 0) + (f[6] ?? 0) + (f[7] ?? 0);
  return { busy };
}

/** "0-1,3" → 3 */
function countCpuList(list: string | undefined): number | null {
  if (!list || !list.trim()) return null;
  let n = 0;
  for (const part of list.trim().split(',')) {
    const [a, b] = part.split('-').map((x) => parseInt(x, 10));
    if (isNaN(a)) return null;
    n += isNaN(b) ? 1 : b - a + 1;
  }
  return n;
}

function parseMem(text: string | undefined): Mem {
  const kv: Record<string, number> = {};
  for (const line of (text ?? '').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kv[m[1]] = parseInt(m[2], 10) * 1024;
  }
  return {
    total: kv.MemTotal ?? null,
    avail: kv.MemAvailable ?? null,
    free: kv.MemFree ?? null,
    swapTotal: kv.SwapTotal ?? null,
    swapFree: kv.SwapFree ?? null,
  };
}

function parseDisks(text: string | undefined): Disk[] {
  const out: Disk[] = [];
  for (const line of (text ?? '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const kb = (s: string) => { const n = parseInt(s, 10); return isNaN(n) ? null : n * 1024; };
    out.push({ mount: f[5], total: kb(f[1]), used: kb(f[2]), avail: kb(f[3]), pct: num(f[4].replace('%', '')) });
  }
  return out;
}

function parseWifi(text: string | undefined): Wifi {
  const t = text ?? '';
  const ip = (t.match(/^IP=(.*)$/m)?.[1] ?? '').trim() || null;
  const connected = /^Connected to/m.test(t);
  return {
    ip,
    connected,
    ssid: t.match(/SSID:\s*(.+)$/m)?.[1]?.trim() ?? null,
    signal: num(t.match(/signal:\s*(-?\d+)/)?.[1]),
    freq: num(t.match(/freq:\s*([\d.]+)/)?.[1]),
    bitrate: t.match(/tx bitrate:\s*([\d.]+\s*\S+)/)?.[1] ?? null,
  };
}

function parseContainers(text: string | undefined): { mode: string | null; list: Ctr[] | null; error: string | null } {
  const lines = (text ?? '').split('\n');
  const mode = lines[0]?.startsWith('MODE=') ? lines[0].slice(5).trim() : null;
  if (mode !== 'docker') return { mode, list: null, error: null };
  const list: Ctr[] = [];
  const junk: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = line.split('|');
    if (f.length < 4) { junk.push(line.trim()); continue; }
    const status = f[2];
    const health = /\(unhealthy\)/.test(status) ? 'unhealthy' : /\(healthy\)/.test(status) ? 'healthy' : /health: starting/.test(status) ? 'starting' : null;
    list.push({ name: f[0], state: f[1].toLowerCase(), status, image: f.slice(3).join('|'), health });
  }
  return { mode, list: junk.length && !list.length ? null : list, error: junk.length ? junk.join(' ') : null };
}

function parseSlow(s: Record<string, string>): Slow {
  const info = (s.info ?? '').split('\n');
  const slots: SlotInfo[] = [];
  let active: string | null = null;
  let booted: string | null = null;
  for (const line of (s.slot ?? '').split('\n')) {
    let m = line.match(/^\s*slot\s+(\w+):\s*(.*?)\s*(?:—|--|-)\s*(.*)$/);
    if (!m) m = line.match(/^\s*slot\s+(\w+):\s*(\S+(?:\s+\d+)?)\s*()$/);
    if (m) { slots.push({ name: m[1], state: m[2].trim(), release: m[3].trim() }); continue; }
    const a = line.match(/^\s*active:\s*(\S+)/);
    if (a) active = a[1];
    const b = line.match(/^\s*booted:\s*(\S+)/);
    if (b) booted = b[1];
  }

  const alarms = s.alarms != null ? parseAlarmsSection(s.alarms) : null;

  const crashLines = (s.crash ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  return {
    release: info[0]?.trim() || null,
    kernel: info[1]?.trim() || null,
    slot: info[2]?.trim() || null,
    active,
    booted,
    slots,
    alarms,
    weather: parseWeather(s.weather),
    logLines: (s.sup ?? '').split('\n').filter((l) => l.trim()),
    crashCount: num(crashLines[0]),
    crashLatest: num(crashLines[1]),
  };
}

// ---------------------------------------------------------------- health

function computeHealth(d: Snapshot): { level: 'ok' | 'warn' | 'bad'; reasons: Reason[] } {
  const r: Reason[] = [];
  const { settings: st } = d;

  if (d.temp != null) {
    if (d.temp >= st.crit) r.push({ tone: 'bad', text: `Temperatura da CPU ${d.temp.toFixed(0)} °C ≥ crítico (${st.crit} °C): o supervisor pausa os contêineres` });
    else if (d.temp >= st.warn) r.push({ tone: 'warn', text: `Temperatura da CPU ${d.temp.toFixed(0)} °C ≥ alerta (${st.warn} °C)` });
  }

  const { avail, total, swapTotal, swapFree } = d.mem;
  if (avail != null) {
    const pct = total ? (avail / total) * 100 : null;
    if (avail < 80 * 1024 * 1024 || (pct != null && pct < 8)) r.push({ tone: 'bad', text: `Memória disponível muito baixa: ${fmtBytes(avail)}` });
    else if (avail < 160 * 1024 * 1024 || (pct != null && pct < 15)) r.push({ tone: 'warn', text: `Memória disponível baixa: ${fmtBytes(avail)}` });
  }
  if (swapTotal && swapFree != null) {
    const used = ((swapTotal - swapFree) / swapTotal) * 100;
    if (used >= 80) r.push({ tone: 'warn', text: `Swap (zram) ${used.toFixed(0)}% em uso` });
  }

  for (const dk of d.disks) {
    if (dk.pct == null) continue;
    if (dk.pct >= 95) r.push({ tone: 'bad', text: `Disco ${dk.mount} quase cheio (${dk.pct}%)` });
    else if (dk.pct > 85) r.push({ tone: 'warn', text: `Disco ${dk.mount} com ${dk.pct}% de uso` });
  }

  const dockerOn = d.dockerMode === 'docker';
  for (const s of d.services) {
    if (s.running !== false) continue;
    if ((s.name === 'dockerd' || s.name === 'containerd') && !dockerOn) continue;
    if (s.name === 'watchdog' && st.watchdog !== '1') continue;
    if (s.name === 'dropbear' && st.ssh === 'off') continue;
    const tone: Reason['tone'] = s.name === 'techo5' || s.name === 'dockerd' || s.name === 'containerd' ? 'bad' : 'warn';
    r.push({ tone, text: `Serviço ${s.name} (${SERVICE_DESC[s.name] ?? ''}) não está rodando` });
  }

  if (d.dockerError) r.push({ tone: 'warn', text: `Docker não respondeu: ${d.dockerError.slice(0, 120)}` });
  for (const c of d.containers ?? []) {
    if (c.health === 'unhealthy') r.push({ tone: 'bad', text: `Contêiner ${c.name} está unhealthy` });
    else if (c.state === 'restarting') r.push({ tone: 'warn', text: `Contêiner ${c.name} reiniciando em loop` });
    else if (c.state === 'dead') r.push({ tone: 'bad', text: `Contêiner ${c.name} morto (dead)` });
    else if (c.state === 'exited') r.push({ tone: 'warn', text: `Contêiner ${c.name} parado: ${c.status}` });
    else if (c.state === 'paused') r.push({ tone: 'warn', text: `Contêiner ${c.name} pausado` });
  }

  const sl = d.slow;
  if (sl) {
    const booted = sl.booted ?? sl.slot;
    for (const s of sl.slots) {
      const st0 = s.state.toLowerCase();
      if (st0 === 'good') continue;
      if (s.name === booted) {
        if (st0.startsWith('trial')) r.push({ tone: 'warn', text: `Slot ${s.name} em teste (${s.state}): ainda não confirmado` });
        else r.push({ tone: 'bad', text: `Slot ativo ${s.name} está "${s.state}"` });
      } else {
        r.push({ tone: 'warn', text: `Slot ${s.name} está "${s.state}"` });
      }
    }
    if (sl.active && sl.booted && sl.active !== sl.booted) {
      r.push({ tone: 'warn', text: `Slot iniciado (${sl.booted}) difere do ativo (${sl.active}): possível rollback` });
    }
  }

  const level = r.some((x) => x.tone === 'bad') ? 'bad' : r.length ? 'warn' : 'ok';
  r.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'bad' ? -1 : 1));
  return { level, reasons: r };
}

// ---------------------------------------------------------------- alarm

/** Next ring of any alarm in the device's local time. Returns label + minutes from now. */
function nextRing(alarms: Alarm[], devEpoch: number | null, tzOffsetMin: number | null): { alarm: Alarm; label: string; inMin: number } | null {
  const epochMs = (devEpoch ?? Date.now() / 1000) * 1000;
  const off = tzOffsetMin ?? -new Date().getTimezoneOffset();
  // A Date whose UTC fields read as the device's wall clock.
  const now = new Date(epochMs + off * 60000);
  const n = nextAlarm(alarms, now);
  if (!n) return null;
  const a = alarms[n.index];
  const days = Math.round((Date.UTC(n.at.getUTCFullYear(), n.at.getUTCMonth(), n.at.getUTCDate()) -
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86400000);
  const day = days === 0 ? 'hoje' : days === 1 ? 'amanhã' : WEEKDAYS[n.at.getUTCDay()];
  return { alarm: a, label: `${day} às ${pad2(a.h)}:${pad2(a.m)}`, inMin: n.mins };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- component

export default function DashboardPage() {
  const { connected, config, navigate } = useApp();
  const refreshSec = Math.max(2, config?.refreshSeconds ?? 5);
  const slowEvery = Math.max(1, Math.round(30 / refreshSec));

  const tick = useRef(0);
  const forceSlow = useRef(false);
  const slowRef = useRef<Slow | null>(null);
  const sleepRef = useRef<{ at: number; night: Night | null } | null>(null);
  const prevCpu = useRef<{ busy: number; up: number } | null>(null);

  const loader = useCallback(async (): Promise<Snapshot> => {
    const forced = forceSlow.current;
    const wantSlow = forced || !slowRef.current || tick.current % slowEvery === 0;
    const wantSleep = wantSlow && (forced || !sleepRef.current || Date.now() - sleepRef.current.at > SLEEP_EVERY_MS);
    forceSlow.current = false;
    tick.current++;
    const s = await runSections({ ...FAST, ...(wantSlow ? SLOW : {}), ...(wantSleep ? SLEEP : {}) }, { timeout: 25000 });

    const nowLines = (s.now ?? '').split('\n');
    const [epochS, tz] = (nowLines[0] ?? '').trim().split(/\s+/);
    let tzOffsetMin: number | null = null;
    const tzm = tz?.match(/^([+-])(\d{2})(\d{2})$/);
    if (tzm) tzOffsetMin = (tzm[1] === '-' ? -1 : 1) * (parseInt(tzm[2], 10) * 60 + parseInt(tzm[3], 10));
    const loadF = (nowLines[2] ?? '').trim().split(/\s+/);
    const load = loadF.length >= 3 && loadF.slice(0, 3).every((x) => !isNaN(parseFloat(x)))
      ? [parseFloat(loadF[0]), parseFloat(loadF[1]), parseFloat(loadF[2])] as [number, number, number]
      : null;

    const cpu = parseCpuLine(nowLines[3]);
    let cpuPct: number | null = null;
    const upNow = parseFloat((nowLines[1] ?? '').trim().split(/\s+/)[0]);
    const nOnline = countCpuList(nowLines[4]) ?? 1;
    if (cpu && prevCpu.current && !isNaN(upNow)) {
      const dBusy = cpu.busy - prevCpu.current.busy;
      const dWall = (upNow - prevCpu.current.up) * 100 * nOnline;
      if (dWall > 0 && dBusy >= 0) cpuPct = Math.max(0, Math.min(100, (dBusy / dWall) * 100));
    }
    if (cpu && !isNaN(upNow)) prevCpu.current = { busy: cpu.busy, up: upNow };

    const cfg = parseKV(s.cfg);
    const settings: Settings = {
      zone: num(cfg.TEMP_ZONE) ?? DEFAULT_SETTINGS.zone,
      warn: num(cfg.TEMP_WARN) ?? DEFAULT_SETTINGS.warn,
      crit: num(cfg.TEMP_CRIT) ?? DEFAULT_SETTINGS.crit,
      watchdog: cfg.WATCHDOG ?? DEFAULT_SETTINGS.watchdog,
      ssh: cfg.SSH || DEFAULT_SETTINGS.ssh,
      docker: cfg.DOCKER || DEFAULT_SETTINGS.docker,
    };
    const raw = num(cfg.RAW);
    const temp = raw == null ? null : raw > 1000 ? raw / 1000 : raw;

    const svcMap = new Map<string, boolean>();
    for (const line of (s.svc ?? '').split('\n')) {
      const [n, v] = line.trim().split(/\s+/);
      if (n && (v === '0' || v === '1')) svcMap.set(n, v === '1');
    }

    const dk = parseContainers(s.docker);
    if (wantSlow) slowRef.current = parseSlow(s);
    if (wantSleep) {
      let night: Night | null = null;
      try {
        if ((s.sleep ?? '').trim()) night = parseNights(s.sleep).nights[0] ?? null;
      } catch { /* not the expected JSON: show nothing */ }
      sleepRef.current = { at: Date.now(), night };
    }

    return {
      at: Date.now(),
      devEpoch: num(epochS),
      tzOffsetMin,
      uptime: num((nowLines[1] ?? '').split(/\s+/)[0]),
      load,
      procs: loadF[3] ?? null,
      cpuPct,
      cpusOnline: nowLines[4]?.trim() || null,
      mem: parseMem(s.mem),
      settings,
      temp,
      services: SERVICES.map((name) => ({ name, running: svcMap.has(name) ? svcMap.get(name)! : null })),
      dockerMode: dk.mode,
      containers: dk.list,
      dockerError: dk.error,
      disks: parseDisks(s.disk),
      wifi: parseWifi(s.net),
      slow: slowRef.current,
      lastNight: sleepRef.current?.night,
    };
  }, [slowEvery]);

  const { data, error, loading, refresh, lastUpdated } = usePoll(loader, refreshSec * 1000, [slowEvery]);

  const manualRefresh = useCallback(() => {
    forceSlow.current = true;
    refresh();
  }, [refresh]);

  // Reset the CPU baseline when the connection drops (counters would span the gap).
  useEffect(() => {
    if (!connected) prevCpu.current = null;
  }, [connected]);

  // ------------------------------------------------ history (sparklines), persisted lightly
  const [history, setHistory] = useState<HistPoint[]>([]);
  const histLoaded = useRef(false);
  const histSince = useRef(0);
  useEffect(() => {
    echo.store.get<HistPoint[]>(HISTORY_KEY, []).then((h) => {
      if (histLoaded.current) return;
      histLoaded.current = true;
      const cutoff = Date.now() - 60 * 60 * 1000;
      const fresh = Array.isArray(h) ? h.filter((p) => p && typeof p.t === 'number' && p.t >= cutoff) : [];
      setHistory((cur) => [...fresh, ...cur].slice(-HISTORY_MAX));
    }).catch(() => { histLoaded.current = true; });
  }, []);

  useEffect(() => {
    if (!data) return;
    const memPct = data.mem.total && data.mem.avail != null ? ((data.mem.total - data.mem.avail) / data.mem.total) * 100 : null;
    const pt: HistPoint = { t: data.at, cpu: data.cpuPct, temp: data.temp, mem: memPct };
    setHistory((h) => [...h, pt].slice(-HISTORY_MAX));
  }, [data]);

  // Persist every 6th sample (not every tick) so a restart keeps recent sparklines.
  useEffect(() => {
    if (!history.length || ++histSince.current < 6) return;
    histSince.current = 0;
    echo.store.set(HISTORY_KEY, history).catch(() => {});
  }, [history]);

  // ------------------------------------------------ health + notifications on transitions
  const health = useMemo(() => (data ? computeHealth(data) : null), [data]);

  const prev = useRef<{ level: string; ctr: Map<string, string>; hot: boolean } | null>(null);
  useEffect(() => {
    if (!data || !health) return;
    const ctr = new Map((data.containers ?? []).map((c) => [c.name, c.state]));
    const hot = data.temp != null && data.temp >= data.settings.crit;
    const p = prev.current;
    prev.current = { level: health.level, ctr, hot };
    if (!p || !config?.notifications) return;

    if (health.level === 'bad' && p.level !== 'bad') {
      const top = health.reasons.filter((r) => r.tone === 'bad').map((r) => r.text);
      echo.app.notify('Echo: estado crítico', top.slice(0, 3).join('\n') || 'Verifique a visão geral').catch(() => {});
    } else if (health.level === 'ok' && p.level === 'bad') {
      echo.app.notify('Echo: recuperado', 'Todos os indicadores voltaram ao normal').catch(() => {});
    }
    if (hot && !p.hot && data.temp != null) {
      echo.app.notify('Echo: temperatura crítica', `CPU a ${data.temp.toFixed(0)} °C (limite ${data.settings.crit} °C). Contêineres serão pausados.`).catch(() => {});
    }
    const stopped: string[] = [];
    for (const [name, state] of ctr) {
      const before = p.ctr.get(name);
      if (before === 'running' && (state === 'exited' || state === 'dead' || state === 'restarting')) stopped.push(name);
    }
    if (stopped.length) {
      echo.app.notify('Echo: contêiner parou', `${stopped.join(', ')} saiu do estado "running"`).catch(() => {});
    }
  }, [data, health, config?.notifications]);

  // ------------------------------------------------ render
  return (
    <Page
      title="Visão geral"
      subtitle={data?.slow?.release ?? 'Saúde do Echo Show 5 em tempo real'}
      actions={connected && <RefreshButton onClick={manualRefresh} loading={loading} lastUpdated={lastUpdated} />}
    >
      <NeedsConnection connected={connected}>
        {error && <ErrorBox error={error} onRetry={manualRefresh} />}
        {!data && !error && <Loading label="Lendo o estado do Echo…" />}
        {data && health && (
          <DashboardBody data={data} health={health} history={history} lastUpdated={lastUpdated} navigate={navigate} refreshSec={refreshSec} />
        )}
      </NeedsConnection>
    </Page>
  );
}

// ---------------------------------------------------------------- body

function DashboardBody({ data, health, history, lastUpdated, navigate, refreshSec }: {
  data: Snapshot;
  health: { level: 'ok' | 'warn' | 'bad'; reasons: Reason[] };
  history: HistPoint[];
  lastUpdated: number | null;
  navigate: ReturnType<typeof useApp>['navigate'];
  refreshSec: number;
}) {
  const st = data.settings;
  const mem = data.mem;
  const memUsed = mem.total != null && mem.avail != null ? mem.total - mem.avail : null;
  const memPct = mem.total && memUsed != null ? (memUsed / mem.total) * 100 : null;
  const swapUsed = mem.swapTotal != null && mem.swapFree != null ? mem.swapTotal - mem.swapFree : null;
  const swapPct = mem.swapTotal && swapUsed != null ? (swapUsed / mem.swapTotal) * 100 : null;
  const tempTone: Tone = data.temp == null ? 'muted' : data.temp >= st.crit ? 'bad' : data.temp >= st.warn ? 'warn' : 'ok';

  const cpuSeries = history.map((h) => h.cpu).filter((v): v is number => v != null);
  const tempSeries = history.map((h) => h.temp).filter((v): v is number => v != null);
  const memSeries = history.map((h) => h.mem).filter((v): v is number => v != null);
  const span = history.length > 1 ? (history[history.length - 1].t - history[0].t) / 1000 : 0;

  const bannerTone: Tone = health.level;
  const BannerIcon = health.level === 'ok' ? ShieldCheck : health.level === 'warn' ? ShieldAlert : ShieldX;
  const bannerTitle = health.level === 'ok' ? 'Tudo certo' : health.level === 'warn' ? 'Atenção' : 'Crítico';
  const bannerSub = health.level === 'ok'
    ? 'Temperatura, memória, discos, serviços, contêineres e slots dentro do esperado.'
    : `${health.reasons.length} ${health.reasons.length === 1 ? 'ponto precisa' : 'pontos precisam'} de atenção`;

  const slow = data.slow;
  const bootedSlot = slow?.booted ?? slow?.slot ?? null;
  const bootedState = slow?.slots.find((s) => s.name === bootedSlot)?.state ?? null;

  return (
    <>
      {/* Health banner */}
      <div className={`dash-banner tone-${bannerTone}`}>
        <div className="dash-banner-icon"><BannerIcon size={26} /></div>
        <div className="grow">
          <div className="dash-banner-title">
            {bannerTitle}
            <Badge tone={bannerTone}>{health.level === 'ok' ? 'OK' : health.level === 'warn' ? 'Atenção' : 'Crítico'}</Badge>
          </div>
          <div className="dash-banner-sub">{bannerSub}</div>
          {health.reasons.length > 0 && (
            <ul className="dash-reasons">
              {health.reasons.map((r, i) => <li key={i}><Dot tone={r.tone} />{r.text}</li>)}
            </ul>
          )}
        </div>
        <div className="dash-banner-meta">
          <span>no ar há <strong>{fmtDuration(data.uptime)}</strong></span>
          <span>slot <strong>{bootedSlot ?? '—'}</strong>{bootedState ? ` · ${bootedState}` : ''}</span>
          <span>{lastUpdated ? `atualizado às ${new Date(lastUpdated).toLocaleTimeString('pt-BR')}` : '—'} · a cada {refreshSec}s</span>
        </div>
      </div>

      {/* Stat tiles */}
      <Grid min={210}>
        <Tile>
          <Stat
            label="Temperatura CPU"
            icon={<Thermometer size={13} />}
            value={data.temp != null ? `${data.temp.toFixed(1)} °C` : '—'}
            tone={tempTone}
            sub={`alerta ${st.warn} °C · crítico ${st.crit} °C`}
          />
          <Sparkline data={tempSeries} min={Math.max(0, Math.min(30, ...tempSeries) - 5)} max={Math.max(st.crit, ...tempSeries)} tone={tempTone === 'muted' ? 'info' : tempTone} />
          <SparkFoot span={span} />
        </Tile>
        <Tile>
          <Stat
            label="Uso de CPU"
            icon={<Cpu size={13} />}
            value={data.cpuPct != null ? `${data.cpuPct.toFixed(0)}%` : '—'}
            tone={toneFor(data.cpuPct, 75, 95) === 'muted' ? undefined : toneFor(data.cpuPct, 75, 95)}
            sub={<>núcleos online: <span className="mono">{countCpuList(data.cpusOnline ?? undefined) ?? '—'} de 4</span>{data.cpusOnline ? <span className="muted"> ({data.cpusOnline})</span> : null}</>}
          />
          <Sparkline data={cpuSeries} max={100} tone="info" />
          <SparkFoot span={span} />
        </Tile>
        <Tile>
          <Stat
            label="Memória"
            icon={<MemoryStick size={13} />}
            value={memPct != null ? `${memPct.toFixed(0)}%` : '—'}
            tone={toneFor(memPct, 80, 92) === 'muted' ? undefined : toneFor(memPct, 80, 92)}
            sub={`${fmtBytes(memUsed)} usados · ${fmtBytes(mem.avail)} disponíveis`}
          />
          <Sparkline data={memSeries} max={100} tone="ok" />
          <SparkFoot span={span} />
        </Tile>
        <Tile>
          <Stat
            label="Carga média"
            icon={<Gauge size={13} />}
            value={<span className="row gap-s" title={LOAD_TOOLTIP}>{data.load ? data.load[0].toFixed(2) : '—'}<span className="dash-help"><Info size={14} /></span></span>}
            sub={<span title={LOAD_TOOLTIP}>{data.load ? `5 min ${data.load[1].toFixed(2)} · 15 min ${data.load[2].toFixed(2)}` : '—'}<br /><span className="muted">~4 é normal no Echo (threads do kernel)</span></span>}
          />
        </Tile>
        <Tile>
          <Stat label="Tempo ligado" icon={<Clock size={13} />} value={fmtDuration(data.uptime)}
            sub={data.uptime != null ? `desde ${new Date(Date.now() - data.uptime * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : '—'} />
        </Tile>
        <Tile>
          <Stat
            label="Wi-Fi"
            icon={<Wifi size={13} />}
            value={<span className="mono" style={{ fontSize: 20 }}>{data.wifi.ip ?? '—'}</span>}
            tone={data.wifi.connected ? undefined : 'bad'}
            sub={data.wifi.connected
              ? <span className="row gap-s wrap">
                  <Badge tone={signalTone(data.wifi.signal)}>{data.wifi.signal != null ? `${data.wifi.signal} dBm` : '—'}</Badge>
                  <span className="ellipsis">{data.wifi.ssid ?? '—'}</span>
                </span>
              : 'desconectado'}
          />
        </Tile>
      </Grid>

      {/* Resources / system / services */}
      <Grid min={320}>
        <Card title="Recursos" icon={<HardDrive size={15} />}>
          <div className="dash-meters">
            <Meter label="Memória (RAM)" value={memPct} warn={80} bad={92}
              right={`${fmtBytes(memUsed)} / ${fmtBytes(mem.total)}`} />
            <Meter label="Swap (zram)" value={swapPct} warn={50} bad={80}
              right={mem.swapTotal ? `${fmtBytes(swapUsed)} / ${fmtBytes(mem.swapTotal)}` : 'sem swap'} />
            {data.disks.length === 0 && <span className="muted small">Discos: —</span>}
            {data.disks.map((d) => (
              <Meter key={d.mount} label={<><span className="mono">{d.mount}</span> <span className="muted small">{d.mount === '/data' ? 'dados' : d.mount === '/store' ? 'slots do sistema' : ''}</span></>}
                value={d.pct} warn={85} bad={95}
                right={`${fmtBytes(d.used)} / ${fmtBytes(d.total)} · ${d.pct ?? '—'}%`} />
            ))}
          </div>
        </Card>

        <Card title="Sistema" icon={<Server size={15} />}
          actions={<Button size="s" variant="ghost" onClick={() => navigate('system')} icon={<ChevronRight size={14} />}>Detalhes</Button>}>
          <KV items={[
            ['Release', <span className="small">{shortRelease(slow?.release)}</span>],
            ['Kernel', <span className="mono">{slow?.kernel ?? '—'}</span>],
            ['Docker', data.dockerMode === 'docker'
              ? <Badge tone="ok">kernel docker</Badge>
              : data.dockerMode === 'off' ? <Badge tone="muted">kernel seguro · sem contêineres</Badge> : <span className="muted">{data.dockerMode ?? '—'}</span>],
            ['Slots', slow && slow.slots.length
              ? <span className="row gap-s wrap">{slow.slots.map((s) => (
                  <Badge key={s.name} tone={slotTone(s.state)} title={s.release}>
                    {s.name}{s.name === bootedSlot ? ' ●' : ''}: {s.state}
                  </Badge>
                ))}</span>
              : (slow?.slot ? <span className="mono">{slow.slot}</span> : '—')],
            ['Wi-Fi', data.wifi.connected
              ? <span className="small">{data.wifi.ssid ?? '—'} · {data.wifi.freq ? `${(data.wifi.freq / 1000).toFixed(1)} GHz` : '—'} · {data.wifi.bitrate ?? '—'}</span>
              : <span className="muted">desconectado</span>],
            ['Processos', <span className="mono small">{data.procs ?? '—'}</span>],
          ]} />
        </Card>

        <Card title="Serviços" icon={<Activity size={15} />}>
          <div className="dash-list">
            {data.services.map((s) => {
              const optional =
                ((s.name === 'dockerd' || s.name === 'containerd') && data.dockerMode !== 'docker') ||
                (s.name === 'watchdog' && st.watchdog !== '1');
              const tone: Tone = s.running == null ? 'muted' : s.running ? 'ok' : optional ? 'muted' : 'bad';
              return (
                <div key={s.name} className="dash-list-row">
                  <Dot tone={tone} />
                  <span className="mono">{s.name}</span>
                  <span className="muted small grow ellipsis">{SERVICE_DESC[s.name]}</span>
                  <Badge tone={tone}>{s.running == null ? '—' : s.running ? 'rodando' : optional ? 'desativado' : 'parado'}</Badge>
                </div>
              );
            })}
          </div>
        </Card>
      </Grid>

      {/* Containers / alarm */}
      <Grid min={320}>
        <ContainersCard data={data} navigate={navigate} />
        <AlarmCard data={data} navigate={navigate} />
        <ProblemsCard data={data} navigate={navigate} />
      </Grid>
    </>
  );
}

// ---------------------------------------------------------------- cards

function ContainersCard({ data, navigate }: { data: Snapshot; navigate: ReturnType<typeof useApp>['navigate'] }) {
  const list = data.containers;
  const go = (name?: string) => navigate('docker', name ? { container: name } : {});
  const header = <Button size="s" variant="ghost" onClick={() => go()} icon={<ChevronRight size={14} />}>Docker</Button>;

  if (data.dockerMode !== 'docker') {
    return (
      <Card title="Contêineres" icon={<Container size={15} />} actions={header}>
        <Empty>{data.dockerMode === 'off' ? 'Docker desligado (kernel seguro ou DOCKER=off)' : 'Estado do Docker desconhecido'}</Empty>
      </Card>
    );
  }

  const counts = { running: 0, stopped: 0, unhealthy: 0, restarting: 0, paused: 0 };
  for (const c of list ?? []) {
    if (c.state === 'running') counts.running++;
    else if (c.state === 'restarting') counts.restarting++;
    else if (c.state === 'paused') counts.paused++;
    else counts.stopped++;
    if (c.health === 'unhealthy') counts.unhealthy++;
  }
  const rank = (c: Ctr) => (c.health === 'unhealthy' || c.state === 'dead' ? 0 : c.state === 'restarting' ? 1 : c.state === 'exited' ? 2 : c.state === 'paused' ? 3 : 4);
  const sorted = [...(list ?? [])].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const shown = sorted.slice(0, 8);

  return (
    <Card title="Contêineres" icon={<Container size={15} />} actions={header}>
      {data.dockerError && <div style={{ marginBottom: 10 }}><ErrorBox error={data.dockerError} /></div>}
      <div className="dash-counts">
        <Badge tone="ok">{counts.running} rodando</Badge>
        <Badge tone={counts.stopped ? 'warn' : 'muted'}>{counts.stopped} parados</Badge>
        <Badge tone={counts.unhealthy ? 'bad' : 'muted'}>{counts.unhealthy} unhealthy</Badge>
        {counts.restarting > 0 && <Badge tone="warn">{counts.restarting} reiniciando</Badge>}
        {counts.paused > 0 && <Badge tone="warn">{counts.paused} pausados</Badge>}
      </div>
      {list && list.length === 0 && <Empty>Nenhum contêiner</Empty>}
      <div className="dash-list">
        {shown.map((c) => (
          <div key={c.name} className="dash-list-row clickable" onClick={() => go(c.name)} title={`${c.image}\n${c.status}`}>
            <Dot tone={ctrTone(c)} />
            <span className="grow ellipsis">{c.name}</span>
            <span className="muted small nowrap">{shortStatus(c.status)}</span>
          </div>
        ))}
        {sorted.length > shown.length && (
          <div className="dash-list-row clickable muted small" onClick={() => go()}>+ {sorted.length - shown.length} outros…</div>
        )}
      </div>
    </Card>
  );
}

function AlarmCard({ data, navigate }: { data: Snapshot; navigate: ReturnType<typeof useApp>['navigate'] }) {
  const slow = data.slow;
  const list = slow?.alarms?.alarms ?? [];
  const on = list.filter((a) => a.on).length;
  const next = nextRing(list, data.devEpoch, data.tzOffsetMin);
  const shown = next?.alarm ?? list[0] ?? null;
  return (
    <Card title={list.length > 1 ? 'Alarmes' : 'Alarme'} icon={on ? <AlarmClock size={15} /> : <AlarmClockOff size={15} />}
      actions={<Button size="s" variant="ghost" onClick={() => navigate('device')} icon={<ChevronRight size={14} />}>Alarme & Tela</Button>}>
      {!slow && <Loading />}
      {slow?.alarms?.problem && <ErrorBox error={`${slow.alarms.file}: ${slow.alarms.problem}`} />}
      {slow && !shown && <Empty>Nenhum alarme configurado</Empty>}
      {shown && (
        <div className="col gap-s">
          <div className="row gap-m">
            <span className={`dash-alarm-time ${shown.on ? '' : 'off'}`}>{pad2(shown.h)}:{pad2(shown.m)}</span>
            <div className="col gap-s">
              <Badge tone={shown.on ? 'ok' : 'muted'}>{shown.on ? 'ligado' : 'desligado'}</Badge>
              <span className="muted small">{REPEAT_LABEL[shown.repeat] ?? shown.repeat}</span>
            </div>
          </div>
          <div className="small">
            {next
              ? <>Próximo toque: <strong>{next.label}</strong> <span className="muted">(em {fmtDuration(next.inMin * 60)})</span></>
              : <span className="muted">{list.length > 1 ? 'Todos os alarmes estão desligados' : 'O alarme não vai tocar'}</span>}
          </div>
          {list.length > 1 && <div className="muted small">{on} de {list.length} alarmes ligados</div>}
          <div className="muted small">Horário do Echo{data.tzOffsetMin != null ? ` (UTC${fmtOffset(data.tzOffsetMin)})` : ''}</div>
        </div>
      )}
      {slow && <MorningLines data={data} />}
    </Card>
  );
}

/** echo-penguin v0.3.0+: the weather and last night, one line each (only what exists). */
function MorningLines({ data }: { data: Snapshot }) {
  const slow = data.slow;
  const nowS = data.devEpoch ?? Date.now() / 1000;
  const w = slow?.weather ?? null;
  const fresh = w && w.now && w.fetched != null && nowS - w.fetched <= WEATHER_STALE_S ? weatherLine(w, nowS) : '';
  const night = data.lastNight ?? null;
  if (!w && !night) return null;
  const at = (epoch: number) => hhmm(deviceTime(epoch, data.tzOffsetMin));
  return (
    <div className="dash-morning">
      {w && (
        <div className="row gap-s" title={w.error ? `Última atualização falhou: ${w.error}` : undefined}>
          <CloudSun size={14} className="muted" />
          {fresh
            ? <span className="ellipsis">{fresh}{w.place && <span className="muted"> · {w.place.split(',')[0]}</span>}<span className="muted"> · {WEATHER_CREDIT}</span></span>
            : <span className="muted">{w.fetched == null ? 'Clima: sem dados' : 'Clima desatualizado'}{w.error ? ' (a atualização falhou)' : ''}</span>}
        </div>
      )}
      {night && (
        <div className="row gap-s">
          <BedDouble size={14} className="muted" />
          <span>
            Última noite: <strong>{fmtSleep(night.minutes)}</strong>{' '}
            <span className="muted">({at(night.bed)} → {at(night.wake)})</span>
          </span>
        </div>
      )}
    </div>
  );
}

function ProblemsCard({ data, navigate }: { data: Snapshot; navigate: ReturnType<typeof useApp>['navigate'] }) {
  const slow = data.slow;
  const crashDate = slow?.crashLatest && slow.crashLatest > 1577836800 // ignore pre-2020 (clock not set yet)
    ? new Date(slow.crashLatest * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : null;
  return (
    <Card title="Problemas recentes" icon={<ScrollText size={15} />}
      actions={<Button size="s" variant="ghost" onClick={() => navigate('logs')} icon={<ChevronRight size={14} />}>Logs</Button>}>
      {!slow && <Loading />}
      {slow && (
        <div className="col gap-s">
          <div className="row gap-s wrap small">
            <Layers size={14} className="muted" />
            <span>Registros de crash:</span>
            <Badge tone={slow.crashCount ? 'warn' : 'ok'}>{slow.crashCount ?? '—'}</Badge>
            {crashDate && <span className="muted">último em {crashDate}</span>}
          </div>
          <div className="muted small">Supervisor — avisos, temperatura e reinícios:</div>
          {slow.logLines.length === 0
            ? <Empty>Nada relevante no log do supervisor</Empty>
            : (
              <Pre className="dash-log" autoScroll>
                {slow.logLines.map((l, i) => (
                  <div key={i} className={`log-line ${logClass(l)}`}>{l}</div>
                ))}
              </Pre>
            )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- small helpers

function Tile({ children }: { children: ReactNode }) {
  return <section className="card dash-tile">{children}</section>;
}

function SparkFoot({ span }: { span: number }) {
  return <div className="dash-tile-foot"><span>{span > 0 ? `últimos ${fmtDuration(span)}` : 'coletando…'}</span><span>agora</span></div>;
}

function signalTone(dbm: number | null): Tone {
  if (dbm == null) return 'muted';
  return dbm >= -60 ? 'ok' : dbm >= -75 ? 'warn' : 'bad';
}

function slotTone(state: string): Tone {
  const s = state.toLowerCase();
  return s === 'good' ? 'ok' : s.startsWith('trial') ? 'warn' : s === 'bad' ? 'bad' : 'muted';
}

function ctrTone(c: Ctr): Tone {
  if (c.health === 'unhealthy' || c.state === 'dead') return 'bad';
  if (c.state === 'running') return c.health === 'starting' ? 'info' : 'ok';
  if (c.state === 'restarting' || c.state === 'exited' || c.state === 'paused') return 'warn';
  return 'muted';
}

function shortStatus(s: string): string {
  return s
    .replace(/^Up\b/, 'ativo')
    .replace(/^Exited \((\d+)\)/, 'saiu ($1)')
    .replace(/\bago\b/, 'atrás')
    .replace(/\(healthy\)/, '· healthy')
    .replace(/\(unhealthy\)/, '· unhealthy')
    .replace(/About an? /i, '~1 ')
    .replace(/\bhours?\b/, 'h')
    .replace(/\bminutes?\b/, 'min')
    .replace(/\bseconds?\b/, 's')
    .replace(/\bdays?\b/, 'd')
    .replace(/\bweeks?\b/, 'sem')
    .replace(/\bmonths?\b/, 'meses');
}

function shortRelease(r: string | null | undefined): string {
  if (!r) return '—';
  const m = r.match(/v[\d.]+/);
  return m ? `${m[0]}${r.includes('built') ? ` · ${r.replace(/^.*built\s+/, '').replace(/,.*$/, '')}` : ''}` : r;
}

function logClass(l: string): string {
  if (/err|fail|did not|not running|bad|panic|oom|killed|pausing/i.test(l)) return 'err';
  if (/warn|temp|restart|stopping|rollback/i.test(l)) return 'warn';
  return '';
}

function fmtOffset(min: number): string {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `${sign}${Math.floor(a / 60)}${a % 60 ? ':' + pad2(a % 60) : ''}`;
}
