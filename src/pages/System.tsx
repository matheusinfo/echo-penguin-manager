// "Sistema": read-only system information about the Echo (plus "Encerrar" for processes, behind a confirm).
import { ReactNode, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, Cable, Cpu, Database, Fan, Globe, HardDrive, Info, Layers, ListTree, MemoryStick, Monitor,
  Network, Package, Router, Server, Shield, Skull, Sun, Terminal, Thermometer, Usb, Wifi, XCircle,
} from 'lucide-react';
import { fmtBytes, fmtDuration, run, runSections } from '../api';
import { useAction, useApp, usePoll, useStored } from '../hooks';
import {
  Badge, Button, Card, Empty, ErrorBox, Grid, KV, Loading, Meter, NeedsConnection, Page, Pre, RefreshButton,
  SearchInput, Sparkline, Stat, Switch, Tabs, toneFor,
} from '../components/ui';
import './System.css';

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';
type TabId = 'overview' | 'cpu' | 'proc' | 'net' | 'pkg' | 'hw';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Visão do sistema' },
  { id: 'cpu', label: 'CPU & memória' },
  { id: 'proc', label: 'Processos' },
  { id: 'net', label: 'Rede' },
  { id: 'pkg', label: 'Pacotes' },
  { id: 'hw', label: 'Hardware/kernel' },
];

export default function SystemPage() {
  const { connected } = useApp();
  const [tab, setTab, ready] = useStored<TabId>('system.tab', 'overview');
  const current = TABS.some((t) => t.id === tab) ? tab : 'overview';
  if (!ready) return <Page title="Sistema"><Loading /></Page>;
  return (
    <Page title="Sistema" subtitle="Informações do sistema do Echo Show 5 (echo-penguin)">
      <Tabs tabs={TABS} value={current} onChange={setTab} />
      <NeedsConnection connected={connected}>
        {current === 'overview' && <OverviewTab />}
        {current === 'cpu' && <CpuMemTab />}
        {current === 'proc' && <ProcessesTab />}
        {current === 'net' && <NetworkTab />}
        {current === 'pkg' && <PackagesTab />}
        {current === 'hw' && <HardwareTab />}
      </NeedsConnection>
    </Page>
  );
}

/* ───────────────────────────── helpers ───────────────────────────── */

function useRefreshMs() {
  const { config } = useApp();
  const s = config?.refreshSeconds;
  return Math.max(2, s && s > 0 ? s : 5) * 1000;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lines(s: string | undefined | null): string[] {
  return (s ?? '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
}

function toNum(s: string | undefined | null): number | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function pctOf(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || !b) return null;
  return (a / b) * 100;
}

const fmtPct = (v: number | null | undefined, d = 0) => (v == null || isNaN(v) ? '—' : `${v.toFixed(d)}%`);

/** `grep -H . files…` output → path → value (first line of each file). */
function parseGrepH(text: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lines(text)) {
    const i = l.indexOf(':');
    if (i <= 0) continue;
    const k = l.slice(0, i);
    if (!m.has(k)) m.set(k, l.slice(i + 1).trim());
  }
  return m;
}

/** "0-1,3" → {0,1,3} */
function parseRange(s: string | undefined): Set<number> {
  const out = new Set<number>();
  for (const part of (s ?? '').trim().split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = +m[1];
    const b = m[2] != null ? +m[2] : a;
    for (let i = a; i <= b && i - a < 1024; i++) out.add(i);
  }
  return out;
}

function parseKeyEq(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines(text)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return out;
}

function fmtDate(epochSec: number | null | undefined): string {
  if (epochSec == null || !isFinite(epochSec)) return '—';
  return new Date(epochSec * 1000).toLocaleString('pt-BR');
}

function fmtRate(bps: number | null | undefined): string {
  if (bps == null || !isFinite(bps)) return '—';
  return `${fmtBytes(bps)}/s`;
}

function Toolbar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="sys-toolbar">
      <div className="left">{left}</div>
      <div className="row gap-s">{right}</div>
    </div>
  );
}

/** Tables render at most ROW_CAP rows until "mostrar todas" is clicked (the filter still covers all). */
const ROW_CAP = 250;

function MoreRows({ total, shown, onShowAll }: { total: number; shown: number; onShowAll: () => void }) {
  if (shown >= total) return null;
  return (
    <div className="row gap-s sys-note" style={{ padding: '8px 12px' }}>
      Mostrando {shown} de {total}.
      <Button size="s" variant="ghost" onClick={onShowAll}>Mostrar todas</Button>
    </div>
  );
}

type SortDir = 'asc' | 'desc';
interface SortState<K extends string> { key: K; dir: SortDir }

function SortTh<K extends string>({ k, sort, setSort, children, num, defaultDir = 'desc', title }: {
  k: K; sort: SortState<K>; setSort: (s: SortState<K>) => void; children: ReactNode; num?: boolean; defaultDir?: SortDir; title?: string;
}) {
  const active = sort.key === k;
  return (
    <th
      className={`sys-sort ${num ? 'num' : ''}`}
      title={title}
      onClick={() => setSort({ key: k, dir: active ? (sort.dir === 'asc' ? 'desc' : 'asc') : defaultDir })}
    >
      {children}
      {active && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
    </th>
  );
}

const COLLATOR = new Intl.Collator('pt-BR', { numeric: true });

function cmp(a: string | number | null | undefined, b: string | number | null | undefined): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return COLLATOR.compare(String(a), String(b));
}

/** Effective penguin settings (defaults + /data/penguin/settings.conf); loaded once. */
function usePenguinSettings() {
  return usePoll(async () => parseKeyEq(await run('penguin settings 2>/dev/null || cat /etc/penguin/defaults.conf')), null);
}

/* ───────────────────────────── 1. Visão do sistema ───────────────────────────── */

interface SlotInfo { name: string; state: string; tries: number | null; release: string }
interface SlotsStatus { store: string; active: string; booted: string; rescue: boolean; slots: SlotInfo[]; extra: string[]; errors: string[] }

function parseSlots(text: string | undefined): SlotsStatus {
  const r: SlotsStatus = { store: '', active: '', booted: '', rescue: false, slots: [], extra: [], errors: [] };
  for (const l of (text ?? '').split('\n')) {
    if (!l.trim()) continue;
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^store:\s*(.*)$/))) r.store = m[1].trim();
    else if ((m = l.match(/^active:\s*(.*)$/))) r.active = m[1].trim();
    else if ((m = l.match(/^booted:\s*(.*)$/))) r.booted = m[1].trim();
    else if (/^rescue:/.test(l)) r.rescue = true;
    else if ((m = l.match(/^slot\s+(\S+):\s*(.*)$/))) {
      const rest = m[2].trim();
      const sep = rest.search(/\s+[—–-]\s+/);
      const stateStr = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
      const release = sep >= 0 ? rest.slice(sep).replace(/^\s+[—–-]\s+/, '').trim() : '';
      const tm = stateStr.match(/^(\S+)(?:\s+(\d+))?/);
      r.slots.push({ name: m[1], state: tm ? tm[1] : stateStr, tries: tm && tm[2] != null ? +tm[2] : null, release: release === '-' ? '' : release });
    } else if (/^slotctl:/.test(l) || /not a store|not found|No such file/i.test(l)) r.errors.push(l.trim());
    else r.extra.push(l);
  }
  return r;
}

const SLOT_STATE: Record<string, [string, Tone]> = {
  good: ['bom', 'ok'],
  trial: ['em teste', 'warn'],
  bad: ['ruim', 'bad'],
  none: ['não instalado', 'muted'],
  empty: ['vazio', 'muted'],
};

interface DfRow { fs: string; size: number; used: number; avail: number; pct: number | null; mount: string }

function parseDf(text: string | undefined): DfRow[] {
  const out: DfRow[] = [];
  for (const l of lines(text).slice(1)) {
    const t = l.trim().split(/\s+/);
    if (t.length < 6) continue;
    const size = toNum(t[1]);
    const used = toNum(t[2]);
    const avail = toNum(t[3]);
    if (size == null || used == null || avail == null) continue;
    out.push({ fs: t[0], size: size * 1024, used: used * 1024, avail: avail * 1024, pct: toNum(t[4].replace('%', '')), mount: t.slice(5).join(' ') });
  }
  return out;
}

interface MountInfo { dev: string; type: string; opts: string[] }
function parseMounts(text: string | undefined): Map<string, MountInfo> {
  const m = new Map<string, MountInfo>();
  for (const l of lines(text)) {
    const t = l.split(/\s+/);
    if (t.length < 4) continue;
    m.set(t[1].replace(/\\040/g, ' '), { dev: t[0], type: t[2], opts: t[3].split(',') });
  }
  return m;
}

const MOUNT_LABEL: Record<string, string> = {
  '/': 'Sistema (slot ativo)',
  '/data': 'Dados persistentes',
  '/store': 'Store dos slots A/B',
  '/run': 'Runtime',
  '/tmp': 'Temporários',
  '/dev': 'Dispositivos',
  '/dev/shm': 'Memória compartilhada',
  '/var/log': 'Logs (RAM)',
  '/var/tmp': 'Temporários (var)',
  '/lib/modules': 'Módulos do kernel',
};

interface PartRow { major: number; minor: number; blocks: number; name: string }
function parsePartitions(text: string | undefined): PartRow[] {
  const out: PartRow[] = [];
  for (const l of lines(text)) {
    const t = l.trim().split(/\s+/);
    if (t.length < 4 || !/^\d+$/.test(t[0])) continue;
    out.push({ major: +t[0], minor: +t[1], blocks: +t[2], name: t[3] });
  }
  return out;
}

interface SwapRow { file: string; type: string; size: number; used: number; prio: string }
function parseSwaps(text: string | undefined): SwapRow[] {
  return lines(text).slice(1).map((l) => l.trim().split(/\s+/)).filter((t) => t.length >= 4)
    .map((t) => ({ file: t[0], type: t[1], size: (toNum(t[2]) ?? 0) * 1024, used: (toNum(t[3]) ?? 0) * 1024, prio: t[4] ?? '' }));
}

const KERNEL_VARIANT_CMD =
  'if [ -e /proc/self/ns/net ] && [ -e /proc/self/ns/pid ] && grep -qw cpuset /proc/cgroups 2>/dev/null; then echo docker; else echo safe; fi; cat /run/penguin/docker 2>/dev/null || echo "?"';

async function loadOverviewStatic() {
  const s = await runSections({
    host: 'hostname',
    rel: 'cat /etc/techo5-release 2>/dev/null',
    os: 'cat /etc/os-release 2>/dev/null',
    uname: 'uname -a',
    kr: 'uname -r',
    arch: 'uname -m; cat /etc/apk/arch 2>/dev/null',
    kvar: KERNEL_VARIANT_CMD,
    slots: 'STORE=/store slotctl status',
    parts: 'cat /proc/partitions',
    pnames: 'grep -H "^PARTNAME=" /sys/block/mmcblk0/mmcblk0p*/uevent 2>/dev/null',
    emmc: 'cat /sys/block/mmcblk0/device/name 2>/dev/null; cat /sys/block/mmcblk0/device/type 2>/dev/null',
    tz: 'cat /etc/timezone 2>/dev/null',
    bslot: 'cat /run/techo5/slot 2>/dev/null',
    // Boot time and the mount table do not change between polls: read with the static data.
    btime: 'grep "^btime" /proc/stat',
    mounts: 'cat /proc/mounts',
  }, { timeout: 20000 });
  const os = parseKeyEq(s.os);
  const [archK, archU] = lines(s.arch);
  const [kvar, dockerRun] = lines(s.kvar);
  const pnames = new Map<string, string>();
  for (const [path, v] of parseGrepH(s.pnames)) {
    const seg = path.split('/');
    pnames.set(seg[seg.length - 2] ?? '', v.replace(/^PARTNAME=/, ''));
  }
  const [emmcName, emmcType] = lines(s.emmc);
  return {
    host: (s.host ?? '').trim(),
    release: (s.rel ?? '').trim(),
    os,
    uname: (s.uname ?? '').trim(),
    kernelRelease: (s.kr ?? '').trim(),
    archKernel: archK ?? '',
    archUser: archU ?? '',
    kernelVariant: kvar ?? '?',
    dockerState: dockerRun ?? '?',
    slots: parseSlots(s.slots),
    slotsRaw: s.slots ?? '',
    parts: parsePartitions(s.parts),
    pnames,
    emmc: emmcName ? `${emmcName}${emmcType ? ` (${emmcType})` : ''}` : '',
    tz: (s.tz ?? '').trim(),
    bootedSlot: (s.bslot ?? '').trim(),
    btime: toNum((s.btime ?? '').trim().split(/\s+/)[1]),
    mounts: parseMounts(s.mounts),
  };
}

async function loadOverviewDynamic() {
  const t0 = Date.now();
  const s = await runSections({
    uptime: 'cat /proc/uptime',
    load: 'cat /proc/loadavg',
    date: 'date "+%s|%Y-%m-%d %H:%M:%S|%Z|%z"',
    df: 'df -P',
    zram: 'grep -H . /sys/block/zram0/disksize /sys/block/zram0/comp_algorithm /sys/block/zram0/mm_stat /sys/block/zram0/max_comp_streams 2>/dev/null',
    swaps: 'cat /proc/swaps',
  });
  const t1 = Date.now();
  const [dEpoch, dLocal, dZone, dOff] = (s.date ?? '').trim().split('|');
  const epoch = toNum(dEpoch);
  const zram = new Map<string, string>();
  for (const [p, v] of parseGrepH(s.zram)) zram.set(p.split('/').pop() ?? p, v);
  const load = (s.load ?? '').trim().split(/\s+/);
  return {
    uptime: toNum((s.uptime ?? '').trim().split(/\s+/)[0]),
    load: load.slice(0, 3).map((x) => toNum(x)),
    procs: load[3] ?? '',
    localTime: dLocal ?? '',
    zone: dZone ?? '',
    offset: dOff ?? '',
    drift: epoch != null ? epoch - Math.round((t0 + t1) / 2000) : null,
    df: parseDf(s.df),
    zram,
    swaps: parseSwaps(s.swaps),
  };
}

function OverviewTab() {
  const ms = useRefreshMs();
  const st = usePoll(loadOverviewStatic, null);
  const dy = usePoll(loadOverviewDynamic, ms);
  const S = st.data;
  const D = dy.data;

  const refreshAll = () => { st.refresh(); dy.refresh(); };

  const storage = useMemo(() => {
    if (!D) return { persist: [] as DfRow[], ram: [] as DfRow[] };
    const seen = new Set<string>();
    const rows = D.df.filter((r) => {
      if (r.fs === 'overlay' || r.fs === 'cgroup' || r.fs === 'shm' || r.mount.startsWith('/data/docker') || r.mount.startsWith('/sys')) return false;
      if (seen.has(r.mount)) return false;
      seen.add(r.mount);
      return true;
    });
    const order = ['/data', '/store', '/'];
    const rank = (m: string) => { const i = order.indexOf(m); return i < 0 ? 99 : i; };
    const persist = rows.filter((r) => r.fs.startsWith('/dev/')).sort((a, b) => rank(a.mount) - rank(b.mount));
    const ram = rows.filter((r) => !r.fs.startsWith('/dev/'));
    return { persist, ram };
  }, [D]);

  const mountsByDev = useMemo(() => {
    const m = new Map<string, string[]>();
    if (S) for (const [mp, info] of S.mounts) {
      if (!info.dev.startsWith('/dev/')) continue;
      if (mp.startsWith('/data/docker')) continue;
      const k = info.dev.replace('/dev/', '');
      m.set(k, [...(m.get(k) ?? []), mp]);
    }
    return m;
  }, [S]);

  if (!S && !D) {
    return (st.error || dy.error) ? <ErrorBox error={st.error || dy.error} onRetry={refreshAll} /> : <Loading />;
  }

  const kernelBadge = S ? (
    S.kernelVariant === 'docker'
      ? <Badge tone="info" title="kernel com namespaces/cgroups: roda contêineres">kernel docker</Badge>
      : <Badge tone="warn" title="kernel com driver Wi-Fi original, sem contêineres">kernel safe</Badge>
  ) : null;

  const rescueOrErr = S && (S.slots.rescue || S.slots.errors.length > 0);

  const swap = D?.swaps.find((x) => x.file.includes('zram')) ?? D?.swaps[0];
  const mm = (D?.zram.get('mm_stat') ?? '').trim().split(/\s+/).map((x) => toNum(x));
  const algo = (D?.zram.get('comp_algorithm') ?? '').match(/\[([^\]]+)\]/)?.[1] ?? D?.zram.get('comp_algorithm') ?? '';
  const zramSize = toNum(D?.zram.get('disksize'));
  const origData = mm[0] ?? null;
  const comprData = mm[1] ?? null;
  const memUsed = mm[2] ?? null;

  return (
    <>
      <Toolbar
        left={<span className="muted small">Dados estáticos carregados uma vez; uptime, armazenamento e swap atualizam a cada {ms / 1000}s.</span>}
        right={<RefreshButton onClick={refreshAll} loading={st.loading || dy.loading} lastUpdated={dy.lastUpdated} />}
      />
      <ErrorBox error={st.error || dy.error} onRetry={refreshAll} />

      <Grid min={210}>
        <Card><Stat label="Hostname" icon={<Server size={13} />} value={S?.host || '—'} sub={S?.release.split(' built')[0] || undefined} /></Card>
        <Card><Stat label="Uptime" icon={<Info size={13} />} value={fmtDuration(D?.uptime)} sub={S?.btime ? `desde ${fmtDate(S.btime)}` : undefined} /></Card>
        <Card>
          <Stat
            label="Carga (1/5/15 min)"
            icon={<Cpu size={13} />}
            value={D?.load[0] != null ? D.load[0]!.toFixed(2) : '—'}
            sub={D ? `${D.load.slice(1).map((x) => (x == null ? '—' : x.toFixed(2))).join(' · ')} · proc. ${D.procs}` : undefined}
          />
        </Card>
        <Card>
          <Stat label="Kernel" icon={<Layers size={13} />} value={<span className="row gap-s">{kernelBadge}</span>} sub={S?.kernelRelease} />
        </Card>
      </Grid>

      <Grid cols={2}>
        <Card title="Identificação" icon={<Info size={15} />}>
          {S ? (
            <KV items={[
              ['Hostname', S.host || '—'],
              ['Release', <span className="mono">{S.release || '—'}</span>],
              ['Alpine', S.os.PRETTY_NAME ? `${S.os.PRETTY_NAME} (${S.os.VERSION_ID ?? '?'})` : '—'],
              ['Kernel', <span className="mono small">{S.uname || '—'}</span>],
              ['Variante do kernel', (
                <span className="row gap-s wrap">
                  {kernelBadge}
                  <span className="muted small">Docker: {S.dockerState === 'docker' ? 'ativo' : S.dockerState === 'off' ? 'desligado' : S.dockerState}</span>
                </span>
              )],
              ['Arquitetura', <span className="row gap-s"><Badge tone="muted">kernel {S.archKernel || '?'}</Badge><Badge tone="muted">userland {S.archUser || '?'}</Badge></span>],
              ['Uptime', fmtDuration(D?.uptime)],
              ['Boot em', fmtDate(S.btime)],
              ['Hora local', D ? <span className="mono">{D.localTime} {D.zone} ({D.offset})</span> : '—'],
              ['Fuso horário', S.tz || '—'],
              ['Relógio vs. este PC', D?.drift == null ? '—' : (
                <Badge tone={Math.abs(D.drift) > 5 ? 'warn' : 'ok'}>
                  {Math.abs(D.drift) <= 1 ? 'sincronizado' : `${D.drift > 0 ? '+' : ''}${D.drift}s`}
                </Badge>
              )],
            ]} />
          ) : <Loading />}
        </Card>

        <Card title="Slots A/B do sistema" icon={<Layers size={15} />}>
          {S ? (
            <div className="sys-slots">
              {S.slots.slots.length === 0 && !rescueOrErr && <Pre>{S.slotsRaw || 'sem saída'}</Pre>}
              {S.slots.slots.map((sl) => {
                const [label, tone] = SLOT_STATE[sl.state] ?? [sl.state, 'muted' as Tone];
                const isActive = sl.name === S.slots.active;
                const isBooted = sl.name === (S.slots.booted || S.bootedSlot);
                return (
                  <div key={sl.name} className={`sys-slot ${isBooted ? 'active' : ''}`}>
                    <div className="sys-slot-letter">{sl.name}</div>
                    <div className="grow col gap-s" style={{ gap: 4 }}>
                      <div className="row gap-s wrap">
                        <Badge tone={tone}>{label}{sl.tries != null ? ` · ${sl.tries} tentativa(s)` : ''}</Badge>
                        {isBooted && <Badge tone="ok" title="o sistema em execução agora">em execução</Badge>}
                        {isActive && <Badge tone="info" title="o slot que inicia no próximo boot">ativo (próximo boot)</Badge>}
                      </div>
                      <div className="small muted mono ellipsis" title={sl.release}>{sl.release || '—'}</div>
                    </div>
                  </div>
                );
              })}
              <div className="row gap-s wrap small muted">
                <span>Store: <span className="mono">{S.slots.store || '—'}</span></span>
                {S.slots.store.includes('read-only') && <Badge tone="ok">somente leitura</Badge>}
                {S.slots.store.includes('writable') && <Badge tone="warn">gravável</Badge>}
              </div>
              {S.slots.rescue && <Badge tone="warn">próximo boot fica no initramfs (rescue)</Badge>}
              {S.slots.errors.map((e, i) => <div key={i} className="small" style={{ color: 'var(--bad)' }}>{e}</div>)}
              {S.slots.extra.length > 0 && <Pre>{S.slots.extra.join('\n')}</Pre>}
            </div>
          ) : <Loading />}
        </Card>
      </Grid>

      <Card title="Armazenamento" icon={<HardDrive size={15} />}>
        {D ? (
          <div className="col gap-m">
            <Grid min={260}>
              {storage.persist.map((r) => {
                const mi = S?.mounts.get(r.mount);
                const ro = mi?.opts.includes('ro');
                return (
                  <div key={r.mount} className="col gap-s">
                    <div className="row gap-s wrap">
                      <strong className="mono">{r.mount}</strong>
                      <span className="muted small">{MOUNT_LABEL[r.mount] ?? ''}</span>
                      {ro && <Badge tone="muted">ro</Badge>}
                    </div>
                    <Meter value={r.pct ?? pctOf(r.used, r.size)} label={<span className="small mono muted">{r.fs}{mi ? ` · ${mi.type}` : ''}</span>} right={`${fmtBytes(r.used)} / ${fmtBytes(r.size)} · livre ${fmtBytes(r.avail)}`} />
                  </div>
                );
              })}
            </Grid>
            {storage.ram.length > 0 && (
              <>
                <div className="muted small">tmpfs (memória RAM)</div>
                <Grid min={220}>
                  {storage.ram.map((r) => (
                    <Meter
                      key={r.mount}
                      value={r.pct ?? pctOf(r.used, r.size)}
                      label={<span><span className="mono">{r.mount}</span> <span className="muted small">{MOUNT_LABEL[r.mount] ?? ''}</span></span>}
                      right={`${fmtBytes(r.used)} / ${fmtBytes(r.size)}`}
                    />
                  ))}
                </Grid>
              </>
            )}
          </div>
        ) : <Loading />}
      </Card>

      <Grid cols={2}>
        <Card title="Partições do eMMC" icon={<Database size={15} />} actions={S?.emmc ? <span className="muted small mono">{S.emmc}</span> : undefined} pad={false}>
          {S ? (
            <div className="table-wrap sys-table-scroll short">
              <table className="table">
                <thead><tr><th>Dispositivo</th><th>Nome</th><th className="num">Tamanho</th><th>Montado em</th></tr></thead>
                <tbody>
                  {S.parts.filter((p) => p.name.startsWith('mmcblk')).map((p) => {
                    const mounted = mountsByDev.get(p.name) ?? [];
                    const pname = S.pnames.get(p.name);
                    const whole = p.name === 'mmcblk0';
                    const hwpart = /boot\d|rpmb/.test(p.name);
                    return (
                      <tr key={p.name} className={mounted.length ? 'sys-hl' : ''}>
                        <td className="mono">{p.name}</td>
                        <td>{whole ? <span className="muted">disco inteiro</span> : hwpart ? <span className="muted">partição de hardware</span> : pname ?? '—'}</td>
                        <td className="num">{fmtBytes(p.blocks * 1024)}</td>
                        <td className="mono small">{mounted.join(', ') || <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <Loading />}
        </Card>

        <Card title="zram / swap" icon={<MemoryStick size={15} />}>
          {D ? (
            D.zram.size === 0 && !swap ? <Empty>Sem zram nem swap</Empty> : (
              <div className="col gap-m">
                {swap && (
                  <Meter
                    value={pctOf(swap.used, swap.size)}
                    label={<span>Swap em uso <span className="muted small mono">{swap.file}</span></span>}
                    right={`${fmtBytes(swap.used)} / ${fmtBytes(swap.size)}`}
                    warn={50}
                    bad={80}
                  />
                )}
                <KV items={[
                  ['Tamanho do zram0', fmtBytes(zramSize)],
                  ['Algoritmo', algo ? <Badge tone="info">{algo}</Badge> : '—'],
                  ['Fluxos de compressão', D.zram.get('max_comp_streams') ?? '—'],
                  ['Dados armazenados', fmtBytes(origData)],
                  ['Comprimidos', fmtBytes(comprData)],
                  ['Taxa de compressão', origData && comprData ? `${(origData / comprData).toFixed(2)}×` : '—'],
                  ['Memória usada pelo zram', fmtBytes(memUsed)],
                  ['Prioridade do swap', swap?.prio || '—'],
                ]} />
              </div>
            )
          ) : <Loading />}
        </Card>
      </Grid>
    </>
  );
}

/* ───────────────────────────── 2. CPU & memória ───────────────────────────── */

interface CpuTimes { total: number; idle: number }
function parseProcStatCpu(text: string | undefined): Map<string, CpuTimes> {
  const m = new Map<string, CpuTimes>();
  for (const l of lines(text)) {
    const t = l.trim().split(/\s+/);
    if (!/^cpu\d*$/.test(t[0])) continue;
    const v = t.slice(1, 9).map((x) => toNum(x) ?? 0);
    const total = v.reduce((a, b) => a + b, 0);
    m.set(t[0], { total, idle: (v[3] ?? 0) + (v[4] ?? 0) });
  }
  return m;
}

function parseMeminfo(text: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines(text)) {
    const m = l.match(/^([^:]+):\s+(\d+)(?:\s*kB)?/);
    if (m) out[m[1]] = +m[2] * (/kB/.test(l) ? 1024 : 1);
  }
  return out;
}

interface CoreInfo { id: number; online: boolean; cur: number | null; max: number | null; hwMax: number | null; hwMin: number | null; gov: string; pct: number | null; hist: number[] }
interface ThermalZone { id: number; type: string; temp: number | null; mode: string }
interface CoolingDev { id: number; type: string; cur: number | null; max: number | null }

const CPU_SYS = '/sys/devices/system/cpu/cpu[0-9]*';
const HIST = 60;

function CpuMemTab() {
  const ms = useRefreshMs();
  const settings = usePenguinSettings();
  const cpuinfo = usePoll(() => run('cat /proc/cpuinfo'), null);
  const prev = useRef<Map<string, CpuTimes> | null>(null);
  const hist = useRef<{ total: number[]; mem: number[]; cores: Map<number, number[]> }>({ total: [], mem: [], cores: new Map() });

  const poll = usePoll(async () => {
    if (!prev.current) {
      prev.current = parseProcStatCpu(await run('grep "^cpu" /proc/stat'));
      await sleep(700);
    }
    const s = await runSections({
      online: 'cat /sys/devices/system/cpu/online; cat /sys/devices/system/cpu/present',
      cpusys: `grep -H . ${CPU_SYS}/online ${CPU_SYS}/cpufreq/scaling_cur_freq ${CPU_SYS}/cpufreq/scaling_max_freq ${CPU_SYS}/cpufreq/cpuinfo_max_freq ${CPU_SYS}/cpufreq/cpuinfo_min_freq ${CPU_SYS}/cpufreq/scaling_governor 2>/dev/null`,
      stat: 'grep "^cpu" /proc/stat',
      mem: 'cat /proc/meminfo',
      load: 'cat /proc/loadavg',
      tz: 'grep -H . /sys/class/thermal/thermal_zone*/type /sys/class/thermal/thermal_zone*/temp /sys/class/thermal/thermal_zone*/mode 2>/dev/null',
      cool: 'grep -H . /sys/class/thermal/cooling_device*/type /sys/class/thermal/cooling_device*/cur_state /sys/class/thermal/cooling_device*/max_state 2>/dev/null',
    });
    const [onlineStr, presentStr] = lines(s.online);
    const online = parseRange(onlineStr);
    const present = parseRange(presentStr);
    const sys = parseGrepH(s.cpusys);
    const stat = parseProcStatCpu(s.stat);
    const p = prev.current;
    const usage = (k: string): number | null => {
      const a = p?.get(k);
      const b = stat.get(k);
      if (!a || !b) return null;
      const dt = b.total - a.total;
      const di = b.idle - a.idle;
      if (dt <= 0 || di < 0) return null;
      return Math.max(0, Math.min(100, (1 - di / dt) * 100));
    };
    const ids = new Set<number>(present);
    for (const k of sys.keys()) {
      const m = k.match(/\/cpu(\d+)\//);
      if (m) ids.add(+m[1]);
    }
    const H = hist.current;
    const cores: CoreInfo[] = [...ids].sort((a, b) => a - b).map((id) => {
      const base = `/sys/devices/system/cpu/cpu${id}`;
      const onFile = sys.get(`${base}/online`);
      const isOn = online.size ? online.has(id) : onFile !== '0';
      const pct = isOn ? usage(`cpu${id}`) : null;
      const h = H.cores.get(id) ?? [];
      h.push(pct ?? 0);
      if (h.length > HIST) h.shift();
      H.cores.set(id, h);
      return {
        id, online: isOn, pct, hist: [...h],
        cur: toNum(sys.get(`${base}/cpufreq/scaling_cur_freq`)),
        max: toNum(sys.get(`${base}/cpufreq/scaling_max_freq`)),
        hwMax: toNum(sys.get(`${base}/cpufreq/cpuinfo_max_freq`)),
        hwMin: toNum(sys.get(`${base}/cpufreq/cpuinfo_min_freq`)),
        gov: sys.get(`${base}/cpufreq/scaling_governor`) ?? '',
      };
    });
    // The aggregate "cpu" line's idle counter jumps when the kernel hot-plugs cores, so the total is
    // the mean of the online cores that have a valid reading.
    const perCore = cores.map((c) => c.pct).filter((v): v is number => v != null);
    const total = perCore.length ? perCore.reduce((a, b) => a + b, 0) / perCore.length : null;
    prev.current = stat;
    const mem = parseMeminfo(s.mem);
    const memUsedPct = pctOf((mem.MemTotal ?? 0) - (mem.MemAvailable ?? mem.MemFree ?? 0), mem.MemTotal);
    if (total != null) { H.total.push(total); if (H.total.length > HIST) H.total.shift(); }
    if (memUsedPct != null) { H.mem.push(memUsedPct); if (H.mem.length > HIST) H.mem.shift(); }

    const tzMap = parseGrepH(s.tz);
    const zones = new Map<number, ThermalZone>();
    for (const [path, v] of tzMap) {
      const m = path.match(/thermal_zone(\d+)\/(\w+)$/);
      if (!m) continue;
      const id = +m[1];
      const z = zones.get(id) ?? { id, type: '', temp: null, mode: '' };
      if (m[2] === 'type') z.type = v;
      else if (m[2] === 'temp') { const n = toNum(v); z.temp = n == null ? null : Math.abs(n) >= 1000 ? n / 1000 : n; }
      else if (m[2] === 'mode') z.mode = v;
      zones.set(id, z);
    }
    const cools = new Map<number, CoolingDev>();
    for (const [path, v] of parseGrepH(s.cool)) {
      const m = path.match(/cooling_device(\d+)\/(\w+)$/);
      if (!m) continue;
      const id = +m[1];
      const c = cools.get(id) ?? { id, type: '', cur: null, max: null };
      if (m[2] === 'type') c.type = v;
      else if (m[2] === 'cur_state') c.cur = toNum(v);
      else if (m[2] === 'max_state') c.max = toNum(v);
      cools.set(id, c);
    }
    const load = (s.load ?? '').trim().split(/\s+/).slice(0, 3).map((x) => toNum(x));
    return {
      cores, total, totalHist: [...H.total], mem, memUsedPct, memHist: [...H.mem], load,
      zones: [...zones.values()].sort((a, b) => a.id - b.id),
      cooling: [...cools.values()].sort((a, b) => a.id - b.id),
    };
  }, ms);

  const cfg = settings.data ?? {};
  const tempZone = toNum(cfg.TEMP_ZONE) ?? 12;
  const tempWarn = toNum(cfg.TEMP_WARN) ?? 75;
  const tempCrit = toNum(cfg.TEMP_CRIT) ?? 85;

  const info = useMemo(() => {
    const txt = cpuinfo.data ?? '';
    const get = (k: string) => txt.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, 'mi'))?.[1]?.trim();
    const parts: Record<string, string> = { '0xd03': 'Cortex-A53', '0xd04': 'Cortex-A35', '0xd05': 'Cortex-A55', '0xd07': 'Cortex-A57', '0xd08': 'Cortex-A72', '0xc07': 'Cortex-A7' };
    const part = get('CPU part');
    return {
      model: get('model name') ?? get('Processor') ?? '',
      hardware: get('Hardware') ?? '',
      core: part ? `${parts[part.toLowerCase()] ?? 'desconhecido'} (${part})` : '',
      features: get('Features') ?? '',
      bogo: get('BogoMIPS') ?? '',
      arch: get('CPU architecture') ?? '',
      rev: get('CPU revision') ?? '',
    };
  }, [cpuinfo.data]);

  const D = poll.data;
  if (!D) return poll.error ? <ErrorBox error={poll.error} onRetry={poll.refresh} /> : <Loading />;

  const onlineCount = D.cores.filter((c) => c.online).length;
  const mainZone = D.zones.find((z) => z.id === tempZone);
  const mt = D.mem.MemTotal ?? 0;
  const free = D.mem.MemFree ?? 0;
  const buf = D.mem.Buffers ?? 0;
  const cache = (D.mem.Cached ?? 0);
  const slab = D.mem.Slab ?? 0;
  const apps = Math.max(0, mt - free - buf - cache - slab);
  const avail = D.mem.MemAvailable ?? free;
  const swapT = D.mem.SwapTotal ?? 0;
  const swapU = swapT - (D.mem.SwapFree ?? 0);
  const activeCooling = D.cooling.filter((c) => (c.cur ?? 0) > 0);
  const w = (v: number) => `${mt ? (v / mt) * 100 : 0}%`;

  return (
    <>
      <Toolbar
        left={<span className="muted small">Uso de CPU calculado a partir de /proc/stat entre leituras ({ms / 1000}s).</span>}
        right={<RefreshButton onClick={poll.refresh} loading={poll.loading} lastUpdated={poll.lastUpdated} />}
      />
      <ErrorBox error={poll.error} onRetry={poll.refresh} />

      <Grid min={210}>
        <Card>
          <Stat label="CPU total" icon={<Cpu size={13} />} value={fmtPct(D.total)} tone={toneFor(D.total, 70, 90)}
            sub={`carga ${D.load.map((x) => (x == null ? '—' : x.toFixed(2))).join(' · ')}`} />
          <Sparkline data={D.totalHist} max={100} tone={toneFor(D.total, 70, 90) === 'ok' ? 'info' : toneFor(D.total, 70, 90)} height={34} />
        </Card>
        <Card><Stat label="Núcleos online" icon={<Cpu size={13} />} value={`${onlineCount} / ${D.cores.length}`} sub={cfg.CPU_ONLINE != null ? `CPU_ONLINE="${cfg.CPU_ONLINE}"` : undefined} /></Card>
        <Card>
          <Stat label="Memória em uso" icon={<MemoryStick size={13} />} value={fmtPct(D.memUsedPct)} tone={toneFor(D.memUsedPct, 80, 92)}
            sub={`${fmtBytes(mt - avail)} de ${fmtBytes(mt)} · disponível ${fmtBytes(avail)}`} />
          <Sparkline data={D.memHist} max={100} tone="info" height={34} />
        </Card>
        <Card>
          <Stat label={`Temperatura (zona ${tempZone})`} icon={<Thermometer size={13} />}
            value={mainZone?.temp != null ? `${mainZone.temp.toFixed(1)} °C` : '—'}
            tone={toneFor(mainZone?.temp, tempWarn, tempCrit)}
            sub={`${mainZone?.type || '?'} · aviso ${tempWarn} °C · crítico ${tempCrit} °C`} />
        </Card>
      </Grid>

      <Card title="Núcleos" icon={<Cpu size={15} />}
        actions={<span className="muted small">{[info.hardware, info.core].filter(Boolean).join(' · ')}</span>}>
        <Grid min={200}>
          {D.cores.map((c) => (
            <div key={c.id} className={`sys-core ${c.online ? '' : 'off'}`}>
              <div className="sys-core-head">
                <strong>CPU {c.id}</strong>
                {c.online ? <Badge tone="ok">online</Badge> : <Badge tone="muted">offline</Badge>}
              </div>
              <div className={`sys-core-pct ${c.online ? '' : 'muted'}`}>{c.online ? fmtPct(c.pct) : '—'}</div>
              {c.online && <Meter value={c.pct} />}
              {c.online && <Sparkline data={c.hist} max={100} height={26} tone="info" />}
              <div className="small muted">
                {c.cur != null ? `${(c.cur / 1000).toFixed(0)} MHz` : '— MHz'}
                {c.max != null ? ` / máx ${(c.max / 1000).toFixed(0)} MHz` : ''}
                {c.gov ? ` · ${c.gov}` : ''}
              </div>
            </div>
          ))}
        </Grid>
        {info.model && (
          <div className="sys-note" style={{ marginTop: 12 }}>
            {info.model} · ARMv{info.arch || '?'} rev {info.rev || '?'} · BogoMIPS {info.bogo || '?'}
            {D.cores[0]?.hwMin != null && D.cores[0]?.hwMax != null ? ` · faixa ${(D.cores[0].hwMin! / 1000).toFixed(0)}–${(D.cores[0].hwMax! / 1000).toFixed(0)} MHz` : ''}
            {info.features ? <> · <span className="mono">{info.features}</span></> : null}
          </div>
        )}
        <div className="sys-note" style={{ marginTop: 6 }}>O kernel da MediaTek liga e desliga núcleos sozinho (hotplug) conforme a carga.</div>
      </Card>

      <Grid cols={2}>
        <Card title="Memória" icon={<MemoryStick size={15} />}>
          <div className="col gap-m">
            <div>
              <div className="sys-stack" title="composição da RAM">
                <div className="sys-c-apps" style={{ width: w(apps) }} title={`Aplicações ${fmtBytes(apps)}`} />
                <div className="sys-c-slab" style={{ width: w(slab) }} title={`Slab ${fmtBytes(slab)}`} />
                <div className="sys-c-buf" style={{ width: w(buf) }} title={`Buffers ${fmtBytes(buf)}`} />
                <div className="sys-c-cache" style={{ width: w(cache) }} title={`Cache ${fmtBytes(cache)}`} />
              </div>
              <div className="sys-legend">
                <span><i className="sys-c-apps" />Aplicações {fmtBytes(apps)}</span>
                <span><i className="sys-c-slab" />Slab {fmtBytes(slab)}</span>
                <span><i className="sys-c-buf" />Buffers {fmtBytes(buf)}</span>
                <span><i className="sys-c-cache" />Cache {fmtBytes(cache)}</span>
                <span><i className="sys-c-free" />Livre {fmtBytes(free)}</span>
              </div>
            </div>
            <Meter value={D.memUsedPct} warn={80} bad={92} label="RAM em uso (total − disponível)" right={`${fmtBytes(mt - avail)} / ${fmtBytes(mt)}`} />
            <Meter value={pctOf(swapU, swapT)} warn={50} bad={80} label="Swap (zram)" right={swapT ? `${fmtBytes(swapU)} / ${fmtBytes(swapT)}` : 'sem swap'} />
            {D.mem.CmaTotal != null && (
              <Meter value={pctOf((D.mem.CmaTotal ?? 0) - (D.mem.CmaFree ?? 0), D.mem.CmaTotal)} warn={101} bad={101} label="CMA (reservada para vídeo/DMA)" right={`${fmtBytes((D.mem.CmaTotal ?? 0) - (D.mem.CmaFree ?? 0))} / ${fmtBytes(D.mem.CmaTotal)}`} />
            )}
          </div>
        </Card>
        <Card title="/proc/meminfo" icon={<ListTree size={15} />}>
          <div className="sys-kv-tight">
            <KV items={([
              ['MemTotal', 'Total'], ['MemAvailable', 'Disponível'], ['MemFree', 'Livre'], ['Buffers', 'Buffers'], ['Cached', 'Cache'],
              ['Shmem', 'Compartilhada (shmem)'], ['AnonPages', 'Anônima (apps)'], ['Mapped', 'Mapeada'], ['Slab', 'Slab'],
              ['SReclaimable', 'Slab recuperável'], ['KernelStack', 'Pilhas do kernel'], ['PageTables', 'Tabelas de páginas'],
              ['SwapTotal', 'Swap total'], ['SwapFree', 'Swap livre'], ['SwapCached', 'Swap em cache'], ['Dirty', 'Sujas (dirty)'],
              ['Committed_AS', 'Comprometida (Committed_AS)'], ['CommitLimit', 'Limite de commit'],
            ] as [string, string][]).filter(([k]) => D.mem[k] != null).map(([k, label]) => [
              <span title={k}>{label}</span>,
              <span className="mono">{fmtBytes(D.mem[k])}{k !== 'MemTotal' && /^Mem|Buffers|Cached|Shmem|Anon|Mapped|Slab|SRecl|Kernel|PageT/.test(k) ? <span className="muted"> · {fmtPct(pctOf(D.mem[k], mt), 1)}</span> : null}</span>,
            ] as [ReactNode, ReactNode])} />
          </div>
        </Card>
      </Grid>

      <Grid cols={2}>
        <Card title="Zonas térmicas" icon={<Thermometer size={15} />} pad={false}
          actions={<span className="muted small">TEMP_ZONE={tempZone} · aviso {tempWarn} °C · crítico {tempCrit} °C</span>}>
          {D.zones.length === 0 ? <Empty>Nenhuma zona térmica</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Zona</th><th>Tipo</th><th className="num">Temperatura</th><th>Modo</th></tr></thead>
                <tbody>
                  {D.zones.map((z) => {
                    const tone = toneFor(z.temp, tempWarn, tempCrit);
                    return (
                      <tr key={z.id} className={z.id === tempZone ? 'sys-hl' : z.temp == null ? 'sys-dim' : ''}>
                        <td className="mono">thermal_zone{z.id}</td>
                        <td>
                          <span className="row gap-s">{z.type || '—'}{z.id === tempZone && <Badge tone="info" title="zona monitorada pelo supervisor (TEMP_ZONE)">monitorada</Badge>}</span>
                        </td>
                        <td className="num">{z.temp == null ? <span className="muted">—</span> : <Badge tone={tone}>{z.temp.toFixed(1)} °C</Badge>}</td>
                        <td>{z.mode ? <Badge tone={z.mode === 'enabled' ? 'ok' : 'muted'}>{z.mode === 'enabled' ? 'ativa' : z.mode === 'disabled' ? 'desativada' : z.mode}</Badge> : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Dispositivos de resfriamento" icon={<Fan size={15} />}>
          {D.cooling.length === 0 ? <Empty>Nenhum dispositivo de resfriamento</Empty> : (
            <div className="col gap-m">
              <div className="row gap-s wrap">
                <Badge tone="muted">{D.cooling.length} dispositivos</Badge>
                {activeCooling.length === 0
                  ? <Badge tone="ok">nenhum limitando o sistema</Badge>
                  : <Badge tone="warn">{activeCooling.length} ativo(s)</Badge>}
              </div>
              {activeCooling.length > 0 && (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Dispositivo</th><th>Tipo</th><th className="num">Estado</th></tr></thead>
                    <tbody>
                      {activeCooling.map((c) => (
                        <tr key={c.id}><td className="mono">cooling_device{c.id}</td><td>{c.type}</td><td className="num"><Badge tone="warn">{c.cur}/{c.max ?? '?'}</Badge></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <CoolingSummary cooling={D.cooling} />
            </div>
          )}
        </Card>
      </Grid>
    </>
  );
}

function CoolingSummary({ cooling }: { cooling: CoolingDev[] }) {
  // Group by type prefix (cpu00…cpu24 → "cpu", mtk-cl-shutdown01 → "mtk-cl-shutdown").
  const groups = new Map<string, { n: number; active: number }>();
  for (const c of cooling) {
    const k = c.type.replace(/\d+$/, '') || '?';
    const g = groups.get(k) ?? { n: 0, active: 0 };
    g.n++;
    if ((c.cur ?? 0) > 0) g.active++;
    groups.set(k, g);
  }
  return (
    <div className="sys-chips">
      {[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, g]) => (
        <Badge key={k} tone={g.active ? 'warn' : 'muted'} title={`${g.n} dispositivo(s), ${g.active} ativo(s)`}>{k}{g.n > 1 ? ` ×${g.n}` : ''}</Badge>
      ))}
    </div>
  );
}

/* ───────────────────────────── 3. Processos ───────────────────────────── */

interface Proc {
  pid: number; ppid: number; state: string; ticks: number; nice: number | null; threads: number | null;
  start: number | null; vsz: number | null; rss: number | null; user: string; args: string;
  cpu: number | null; memPct: number | null; kernel: boolean;
}
type ProcSortKey = 'pid' | 'user' | 'cpu' | 'mem' | 'time' | 'age' | 'threads' | 'args';

const PAGE_SIZE = 4096;
const CLK_TCK = 100;
// pid state ppid utime+stime nice threads starttime vsize rss — comm (field 2) may hold spaces/parens, so strip up to the last ") ".
const PROC_AWK = "awk '{p=$1; s=$0; sub(/^.*\\) /,\"\",s); split(s,a,\" \"); print p, a[1], a[2], a[12]+a[13], a[17], a[18], a[20], a[21], a[22]}' /proc/[0-9]*/stat 2>/dev/null";

const PROC_STATE: Record<string, [string, Tone]> = {
  R: ['executando', 'ok'], S: ['dormindo', 'muted'], D: ['E/S (D)', 'warn'], Z: ['zumbi', 'bad'], T: ['parado', 'warn'],
  t: ['rastreado', 'warn'], I: ['ocioso', 'muted'], X: ['morto', 'bad'], W: ['paginando', 'warn'],
};

const CRITICAL: [RegExp, string][] = [
  [/^\/sbin\/init\b|^init$/, 'init: o sistema inteiro depende dele.'],
  [/dropbear/, 'dropbear é o servidor SSH: encerrá-lo pode derrubar esta conexão.'],
  [/techo5/, 'techo5 é o supervisor do echo-penguin (watchdog, temperatura, serviços).'],
  [/\bdockerd\b|\bcontainerd\b/, 'encerrar o Docker para todos os contêineres.'],
  [/penguin-ui/, 'penguin-ui é a interface da tela.'],
  [/wpa_supplicant|udhcpc/, 'encerrar pode desconectar o Wi-Fi (e esta sessão).'],
];

type KillSignal = 'TERM' | 'KILL';
const KILL_SIGNALS: readonly KillSignal[] = ['TERM', 'KILL'];

function ProcessesTab() {
  const ms = useRefreshMs();
  const { confirm } = useApp();
  const { busy, act } = useAction();
  const [auto, setAuto] = useStored('system.proc.auto', true);
  const [showKernel, setShowKernel] = useStored('system.proc.kernel', false);
  const [sort, setSort] = useStored<SortState<ProcSortKey>>('system.proc.sort', { key: 'cpu', dir: 'desc' });
  const [filter, setFilter] = useState('');
  const [allRows, setAllRows] = useState(false);
  const prev = useRef<{ ticks: Map<number, number>; total: number; uptime: number } | null>(null);

  const sample = async () => {
    const s = await runSections({
      self: 'echo $$',
      up: 'cat /proc/uptime; grep "^cpu " /proc/stat; grep "^MemTotal" /proc/meminfo',
      st: PROC_AWK,
      ps: 'ps -o pid,user,args',
    }, { timeout: 20000 });
    const self = toNum((s.self ?? '').trim()) ?? -1;
    const [upL, cpuL, memL] = lines(s.up);
    const uptime = toNum(upL?.split(/\s+/)[0]) ?? 0;
    const total = (cpuL ?? '').trim().split(/\s+/).slice(1, 9).reduce((a, x) => a + (toNum(x) ?? 0), 0);
    const memTotal = (toNum(memL?.match(/(\d+)/)?.[1]) ?? 0) * 1024;
    const meta = new Map<number, { user: string; args: string }>();
    for (const l of lines(s.ps)) {
      const m = l.match(/^\s*(\d+)\s+(\S+)\s?(.*)$/);
      if (m) meta.set(+m[1], { user: m[2], args: m[3] });
    }
    const procs: Proc[] = [];
    for (const l of lines(s.st)) {
      const t = l.trim().split(/\s+/);
      if (t.length < 9) continue;
      const pid = toNum(t[0]);
      const ppid = toNum(t[2]);
      if (pid == null || ppid == null) continue;
      if (pid === self || ppid === self) continue; // this poll's own shell, ps, awk…
      const md = meta.get(pid);
      const rssPages = toNum(t[8]);
      procs.push({
        pid, ppid, state: t[1], ticks: toNum(t[3]) ?? 0, nice: toNum(t[4]), threads: toNum(t[5]), start: toNum(t[6]),
        vsz: toNum(t[7]), rss: rssPages == null ? null : rssPages * PAGE_SIZE,
        user: md?.user ?? '?', args: md?.args ?? '', cpu: null, memPct: null,
        kernel: pid === 2 || ppid === 2,
      });
      const p = procs[procs.length - 1];
      p.memPct = p.rss != null && memTotal ? (p.rss / memTotal) * 100 : null;
    }
    return { procs, total, uptime, memTotal };
  };

  const poll = usePoll(async () => {
    if (!prev.current) {
      const a = await sample();
      prev.current = { ticks: new Map(a.procs.map((p) => [p.pid, p.ticks])), total: a.total, uptime: a.uptime };
      await sleep(800);
    }
    const b = await sample();
    const pv = prev.current!;
    const dTotal = b.total - pv.total;
    for (const p of b.procs) {
      const before = pv.ticks.get(p.pid) ?? ((p.start ?? 0) / CLK_TCK > pv.uptime ? 0 : null);
      if (before != null && dTotal > 0) p.cpu = Math.max(0, ((p.ticks - before) / dTotal) * 100);
    }
    prev.current = { ticks: new Map(b.procs.map((p) => [p.pid, p.ticks])), total: b.total, uptime: b.uptime };
    return b;
  }, auto ? ms : null, [auto]);

  const D = poll.data;

  const rows = useMemo(() => {
    if (!D) return [];
    const q = filter.trim().toLowerCase();
    const list = D.procs.filter((p) => (showKernel || !p.kernel) && (!q || p.args.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid) === q));
    const val = (p: Proc): string | number | null => {
      switch (sort.key) {
        case 'pid': return p.pid;
        case 'user': return p.user;
        case 'cpu': return p.cpu ?? -1;
        case 'mem': return p.rss ?? -1;
        case 'time': return p.ticks;
        case 'age': return p.start == null ? null : -p.start;
        case 'threads': return p.threads;
        case 'args': return p.args;
      }
    };
    const dir = sort.dir === 'asc' ? 1 : -1;
    return list.sort((a, b) => cmp(val(a), val(b)) * dir || a.pid - b.pid);
  }, [D, filter, showKernel, sort]);

  const kill = async (p: Proc, sig: KillSignal) => {
    // Everything here came from the device: only a real PID (never init/kthreadd) and a fixed signal.
    if (!Number.isInteger(p.pid) || p.pid <= 2 || p.kernel || !KILL_SIGNALS.includes(sig)) return;
    const crit = CRITICAL.find(([re]) => re.test(p.args))?.[1];
    const ok = await confirm({
      title: sig === 'KILL' ? `Forçar encerramento do PID ${p.pid}?` : `Encerrar o PID ${p.pid}?`,
      message:
        `${p.args || '(sem comando)'}\n\n` +
        (sig === 'KILL'
          ? 'Envia SIGKILL (kill -9): o processo termina imediatamente, sem chance de salvar estado.'
          : 'Envia SIGTERM: pede ao processo que termine de forma limpa.') +
        (crit ? `\n\nAtenção: ${crit}` : ''),
      confirmLabel: sig === 'KILL' ? 'Forçar (kill -9)' : 'Encerrar',
      danger: true,
    });
    if (!ok) return;
    // If the process ended meanwhile, its PID may now belong to another one: check its start time.
    const sameProc = p.start != null && Number.isInteger(p.start) && p.start >= 0
      ? `[ "$(sed 's/^.*) //' /proc/${p.pid}/stat 2>/dev/null | cut -d' ' -f20)" = ${p.start} ] || { echo 'o processo ${p.pid} já terminou' >&2; exit 1; }; `
      : '';
    await act(`kill-${p.pid}`, () => run(`${sameProc}kill -s ${sig} ${p.pid}`), `Sinal ${sig} enviado ao PID ${p.pid}`);
    setTimeout(poll.refresh, 600);
  };

  // Per sample, not per keystroke in the filter.
  const stats = useMemo(() => {
    const procs = D?.procs ?? [];
    const visible = procs.filter((p) => !p.kernel);
    return {
      visible,
      running: procs.filter((p) => p.state === 'R').length,
      zombies: procs.filter((p) => p.state === 'Z').length,
      threads: procs.reduce((a, p) => a + (p.threads ?? 0), 0),
      userRss: visible.reduce((a, p) => a + (p.rss ?? 0), 0),
    };
  }, [D]);

  if (!D) return poll.error ? <ErrorBox error={poll.error} onRetry={poll.refresh} /> : <Loading label="Lendo processos…" />;

  const { visible, running, zombies, threads, userRss } = stats;

  return (
    <>
      <Grid min={180}>
        <Card><Stat label="Processos" value={D.procs.length} sub={`${visible.length} de usuário · ${D.procs.length - visible.length} do kernel`} /></Card>
        <Card><Stat label="Executando" value={running} sub={`${threads} threads no total`} /></Card>
        <Card><Stat label="Zumbis" value={zombies} tone={zombies ? 'warn' : undefined} /></Card>
        <Card><Stat label="RSS somado" value={fmtBytes(userRss)} sub={`de ${fmtBytes(D.memTotal)} (inclui páginas compartilhadas)`} /></Card>
      </Grid>

      <Card pad={false}
        title={<span>Processos <span className="muted small">({rows.length})</span></span>}
        icon={<Terminal size={15} />}
        actions={
          <>
            <SearchInput value={filter} onChange={setFilter} placeholder="Filtrar por comando, usuário ou PID…" />
            <Switch checked={showKernel} onChange={setShowKernel} label={<span className="small">threads do kernel</span>} />
            <Switch checked={auto} onChange={setAuto} label={<span className="small">auto ({ms / 1000}s)</span>} />
            <RefreshButton onClick={poll.refresh} loading={poll.loading} lastUpdated={poll.lastUpdated} />
          </>
        }>
        <ErrorBox error={poll.error} onRetry={poll.refresh} />
        {rows.length === 0 ? <Empty>Nenhum processo corresponde ao filtro</Empty> : (
          <div className="table-wrap sys-table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <SortTh k="pid" sort={sort} setSort={setSort} num defaultDir="asc">PID</SortTh>
                  <SortTh k="user" sort={sort} setSort={setSort} defaultDir="asc">Usuário</SortTh>
                  <th>Estado</th>
                  <SortTh k="cpu" sort={sort} setSort={setSort} num title="% do total de CPU (todos os núcleos online) desde a última leitura">CPU</SortTh>
                  <SortTh k="mem" sort={sort} setSort={setSort} num title="memória residente (RSS)">Memória</SortTh>
                  <SortTh k="threads" sort={sort} setSort={setSort} num>Threads</SortTh>
                  <SortTh k="time" sort={sort} setSort={setSort} num title="tempo de CPU acumulado">Tempo CPU</SortTh>
                  <SortTh k="age" sort={sort} setSort={setSort} num title="há quanto tempo o processo está rodando">Rodando há</SortTh>
                  <SortTh k="args" sort={sort} setSort={setSort} defaultDir="asc">Comando</SortTh>
                  <th className="right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {(allRows ? rows : rows.slice(0, ROW_CAP)).map((p) => {
                  const [stLabel, stTone] = PROC_STATE[p.state] ?? [p.state, 'muted' as Tone];
                  const canKill = p.pid > 1 && !p.kernel;
                  return (
                    <tr key={p.pid}>
                      <td className="num mono">{p.pid}</td>
                      <td className="mono small">{p.user}</td>
                      <td><Badge tone={stTone} title={`estado ${p.state}${p.nice ? ` · nice ${p.nice}` : ''}`}>{stLabel}</Badge></td>
                      <td className="num">{p.cpu == null ? <span className="muted">…</span> : <span style={{ color: p.cpu >= 50 ? 'var(--bad)' : p.cpu >= 20 ? 'var(--warn)' : undefined }}>{p.cpu.toFixed(1)}%</span>}</td>
                      <td className="num" title={p.vsz != null ? `VSZ ${fmtBytes(p.vsz)}` : undefined}>
                        {p.rss ? fmtBytes(p.rss) : <span className="muted">—</span>}
                        {p.memPct != null && p.rss ? <span className="muted small"> · {p.memPct.toFixed(1)}%</span> : null}
                      </td>
                      <td className="num">{p.threads ?? '—'}</td>
                      <td className="num mono small">{fmtDuration(p.ticks / CLK_TCK)}</td>
                      <td className="num small">{p.start != null ? fmtDuration(Math.max(0, D.uptime - p.start / CLK_TCK)) : '—'}</td>
                      <td><div className="sys-cmd" title={p.args}>{p.args || <span className="muted">?</span>}</div></td>
                      <td className="right nowrap">
                        {canKill && (
                          <span className="row gap-s" style={{ justifyContent: 'flex-end' }}>
                            <Button size="s" variant="ghost" icon={<XCircle size={13} />} title="Encerrar (SIGTERM)" busy={busy === `kill-${p.pid}`} onClick={() => kill(p, 'TERM')}>Encerrar</Button>
                            <Button size="s" variant="danger" icon={<Skull size={13} />} title="Forçar (SIGKILL, kill -9)" disabled={!!busy} onClick={() => kill(p, 'KILL')} />
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <MoreRows total={rows.length} shown={allRows ? rows.length : Math.min(rows.length, ROW_CAP)} onShowAll={() => setAllRows(true)} />
          </div>
        )}
      </Card>
    </>
  );
}

/* ───────────────────────────── 4. Rede ───────────────────────────── */

interface Iface {
  idx: number; name: string; flags: string[]; state: string; mtu: string; mac: string;
  addrs: { family: string; addr: string; scope: string }[];
  rx: number | null; tx: number | null; rxPk: number | null; txPk: number | null; rxErr: number; txErr: number; rxDrop: number; txDrop: number;
  rxRate: number | null; txRate: number | null;
}

function parseIpLink(text: string | undefined): Map<string, Partial<Iface>> {
  const m = new Map<string, Partial<Iface>>();
  for (const l of lines(text)) {
    const r = l.match(/^(\d+):\s+([^:@\s]+)(?:@\S+)?:\s+<([^>]*)>(.*)$/);
    if (!r) continue;
    const rest = r[4];
    m.set(r[2], {
      idx: +r[1], name: r[2], flags: r[3].split(',').filter(Boolean),
      state: rest.match(/\bstate\s+(\S+)/)?.[1] ?? '', mtu: rest.match(/\bmtu\s+(\d+)/)?.[1] ?? '',
      mac: rest.match(/link\/\S+\s+([0-9a-f:]{17})/i)?.[1] ?? '',
    });
  }
  return m;
}

function parseIpAddr(text: string | undefined): Map<string, Iface['addrs']> {
  const m = new Map<string, Iface['addrs']>();
  for (const l of lines(text)) {
    const r = l.match(/^\d+:\s+(\S+)\s+(inet6?)\s+(\S+)(.*)$/);
    if (!r) continue;
    const name = r[1].replace(/@.*$/, '');
    const arr = m.get(name) ?? [];
    arr.push({ family: r[2], addr: r[3], scope: r[4].match(/scope\s+(\S+)/)?.[1] ?? '' });
    m.set(name, arr);
  }
  return m;
}

function parseNetDev(text: string | undefined): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const l of lines(text)) {
    const i = l.indexOf(':');
    if (i < 0 || l.includes('|')) continue;
    const name = l.slice(0, i).trim();
    const nums = l.slice(i + 1).trim().split(/\s+/).map((x) => toNum(x) ?? 0);
    if (nums.length >= 12) m.set(name, nums);
  }
  return m;
}

function parseColonBlock(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines(text)) {
    const m = l.trim().match(/^([A-Za-z][A-Za-z0-9 _-]*?):\s+(.*)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function wifiChannel(freq: number | null): { ch: number | null; band: string } {
  if (freq == null) return { ch: null, band: '' };
  if (freq === 2484) return { ch: 14, band: '2,4 GHz' };
  if (freq >= 2412 && freq < 2484) return { ch: Math.round((freq - 2407) / 5), band: '2,4 GHz' };
  if (freq >= 5000 && freq < 5925) return { ch: Math.round((freq - 5000) / 5), band: '5 GHz' };
  if (freq >= 5925 && freq < 7200) return { ch: Math.round((freq - 5950) / 5), band: '6 GHz' };
  return { ch: null, band: '' };
}

function rateSignal(dbm: number | null): { label: string; tone: Tone; pct: number } {
  if (dbm == null) return { label: '—', tone: 'muted', pct: 0 };
  const pct = Math.max(0, Math.min(100, ((dbm + 90) / 60) * 100));
  if (dbm >= -50) return { label: 'Excelente', tone: 'ok', pct };
  if (dbm >= -60) return { label: 'Bom', tone: 'ok', pct };
  if (dbm >= -70) return { label: 'Razoável', tone: 'warn', pct };
  if (dbm >= -80) return { label: 'Fraco', tone: 'bad', pct };
  return { label: 'Muito fraco', tone: 'bad', pct };
}

function ifaceKind(name: string): string {
  if (name === 'lo') return 'loopback';
  if (/^wlan/.test(name)) return 'Wi-Fi';
  if (name === 'docker0' || /^br-/.test(name)) return 'bridge Docker';
  if (/^veth/.test(name)) return 'veth (contêiner)';
  if (/^(p2p|ap)\d/.test(name)) return 'Wi-Fi virtual';
  if (/^(ifb|tunl|sit|ip6tnl|ip_vti|ip6_vti|gre|dummy)/.test(name)) return 'virtual';
  if (/^usb|^rndis/.test(name)) return 'USB';
  return '';
}

interface Route { dst: string; via: string; dev: string; src: string; metric: string; raw: string }
function parseRoutes(text: string | undefined): Route[] {
  return lines(text).map((l) => {
    const t = l.trim();
    return {
      dst: t.split(/\s+/)[0] ?? '', via: t.match(/\bvia\s+(\S+)/)?.[1] ?? '', dev: t.match(/\bdev\s+(\S+)/)?.[1] ?? '',
      src: t.match(/\bsrc\s+(\S+)/)?.[1] ?? '', metric: t.match(/\bmetric\s+(\S+)/)?.[1] ?? '', raw: t,
    };
  });
}

interface Sock { proto: string; local: string; addr: string; port: string; state: string; prog: string }
function parseNetstat(text: string | undefined): Sock[] {
  const out: Sock[] = [];
  for (const l of lines(text)) {
    const t = l.trim().split(/\s+/);
    if (!/^(tcp|udp|raw)6?$/.test(t[0]) || t.length < 5) continue;
    const local = t[3];
    let state = '';
    let prog = '';
    if (t.length >= 7) { state = t[5]; prog = t.slice(6).join(' '); }
    else if (t.length === 6) { if (/^[A-Z_]+$/.test(t[5])) state = t[5]; else prog = t[5]; }
    const i = local.lastIndexOf(':');
    out.push({ proto: t[0], local, addr: i >= 0 ? local.slice(0, i) : local, port: i >= 0 ? local.slice(i + 1) : '', state, prog });
  }
  return out;
}

interface ArpRow { ip: string; mac: string; flags: string; dev: string }
function parseArp(text: string | undefined): ArpRow[] {
  return lines(text).slice(1).map((l) => l.trim().split(/\s+/)).filter((t) => t.length >= 6)
    .map((t) => ({ ip: t[0], flags: t[2], mac: t[3], dev: t[5] }));
}

const NET_SLOW_MS = 30000;
const NET_SLOW_SECTIONS: Record<string, string> = {
  wli: 'iw dev wlan0 info',
  r4: 'ip route',
  r6: 'ip -6 route',
  dns: 'cat /etc/resolv.conf',
  sock: 'netstat -tulpn 2>/dev/null',
  arp: 'cat /proc/net/arp',
  fwd: 'cat /proc/sys/net/ipv4/ip_forward',
};

function NetworkTab() {
  const ms = useRefreshMs();
  const [showAll, setShowAll] = useStored('system.net.all', false);
  const prev = useRef<{ t: number; dev: Map<string, number[]> } | null>(null);
  // Routes, DNS, sockets (netstat -p walks every process's fds), ARP: refreshed every NET_SLOW_MS
  // (or on the refresh button) in the same exec as the counters, not on every tick.
  const slow = useRef<{ at: number; s: Record<string, string> } | null>(null);
  const forceSlow = useRef(false);

  const poll = usePoll(async () => {
    const needSlow = forceSlow.current || !slow.current || Date.now() - slow.current.at >= NET_SLOW_MS;
    forceSlow.current = false;
    const fresh = await runSections({
      addr: 'ip -o addr',
      link: 'ip -o link',
      dev: 'cat /proc/net/dev',
      wl: 'iw dev wlan0 link',
      ...(needSlow ? NET_SLOW_SECTIONS : {}),
    });
    if (needSlow || !slow.current) {
      const kept: Record<string, string> = {};
      for (const k of Object.keys(NET_SLOW_SECTIONS)) kept[k] = fresh[k] ?? '';
      slow.current = { at: Date.now(), s: kept };
    }
    const s = { ...slow.current.s, ...fresh };
    const now = Date.now();
    const link = parseIpLink(s.link);
    const addrs = parseIpAddr(s.addr);
    const dev = parseNetDev(s.dev);
    const pv = prev.current;
    const dt = pv ? (now - pv.t) / 1000 : 0;
    const names = new Set<string>([...link.keys(), ...dev.keys()]);
    const ifaces: Iface[] = [...names].map((name) => {
      const l = link.get(name) ?? {};
      const d = dev.get(name);
      const p = pv?.dev.get(name);
      const rate = (i: number) => (d && p && dt > 0 && d[i] >= p[i] ? (d[i] - p[i]) / dt : null);
      return {
        idx: l.idx ?? 999, name, flags: l.flags ?? [], state: l.state ?? '', mtu: l.mtu ?? '', mac: l.mac ?? '',
        addrs: addrs.get(name) ?? [],
        rx: d ? d[0] : null, rxPk: d ? d[1] : null, rxErr: d ? d[2] : 0, rxDrop: d ? d[3] : 0,
        tx: d ? d[8] : null, txPk: d ? d[9] : null, txErr: d ? d[10] : 0, txDrop: d ? d[11] : 0,
        rxRate: rate(0), txRate: rate(8),
      };
    }).sort((a, b) => a.idx - b.idx);
    prev.current = { t: now, dev };
    const wl = parseColonBlock(s.wl);
    const connected = /^Connected to/m.test(s.wl ?? '');
    const bssid = (s.wl ?? '').match(/Connected to\s+([0-9a-f:]{17})/i)?.[1] ?? '';
    const wli: Record<string, string> = {};
    for (const l of lines(s.wli)) {
      const m = l.trim().match(/^(\S+)\s+(.*)$/);
      if (m && !/^Interface$/.test(m[1])) wli[m[1]] = m[2];
    }
    const dns = lines(s.dns).filter((l) => !l.trim().startsWith('#'));
    return {
      ifaces, wifi: { connected, bssid, raw: s.wl ?? '', info: wl }, wli,
      r4: parseRoutes(s.r4), r6: parseRoutes(s.r6),
      nameservers: dns.filter((l) => /^nameserver\s/.test(l.trim())).map((l) => l.trim().split(/\s+/)[1]),
      search: dns.filter((l) => /^(search|domain)\s/.test(l.trim())).map((l) => l.trim().split(/\s+/).slice(1).join(' ')).join(' '),
      socks: parseNetstat(s.sock),
      arp: parseArp(s.arp),
      forward: (s.fwd ?? '').trim() === '1',
    };
  }, ms);

  const D = poll.data;
  if (!D) return poll.error ? <ErrorBox error={poll.error} onRetry={poll.refresh} /> : <Loading />;

  // Hidden by default: interfaces that are down (or loopback) and never moved a byte.
  const idle = (i: Iface) => !(i.rx || i.tx) && (i.name === 'lo' || i.state === 'DOWN' || !i.flags.includes('UP'));
  const shown = showAll ? D.ifaces : D.ifaces.filter((i) => !idle(i));
  const hiddenCount = D.ifaces.length - shown.length;
  const def = D.r4.find((r) => r.dst === 'default');
  const freq = toNum((D.wifi.info.freq ?? '').split(/\s+/)[0]);
  const { ch, band } = wifiChannel(freq);
  const dbm = toNum((D.wifi.info.signal ?? '').match(/-?\d+(?:\.\d+)?/)?.[0]);
  const sig = rateSignal(dbm);
  const wlan = D.ifaces.find((i) => i.name === 'wlan0');

  return (
    <>
      <Toolbar
        left={<span className="muted small">Taxas calculadas entre leituras ({ms / 1000}s); rotas, portas e vizinhos a cada {NET_SLOW_MS / 1000}s.</span>}
        right={<RefreshButton onClick={() => { forceSlow.current = true; poll.refresh(); }} loading={poll.loading} lastUpdated={poll.lastUpdated} />}
      />
      <ErrorBox error={poll.error} onRetry={poll.refresh} />

      <Grid cols={2}>
        <Card title="Wi-Fi (wlan0)" icon={<Wifi size={15} />}
          actions={D.wifi.connected ? <Badge tone="ok">conectado</Badge> : <Badge tone="bad">desconectado</Badge>}>
          {D.wifi.connected ? (
            <div className="col gap-m">
              <div className="col gap-s">
                <div className="row between">
                  <span><strong>{D.wifi.info.ssid || '(SSID oculto)'}</strong></span>
                  <span className="row gap-s"><span className="mono">{dbm != null ? `${dbm} dBm` : '—'}</span><Badge tone={sig.tone}>{sig.label}</Badge></span>
                </div>
                <div className="sys-sig"><div className={`tone-bg-${sig.tone === 'muted' ? 'info' : sig.tone}`} style={{ width: `${sig.pct}%` }} /></div>
              </div>
              <KV items={[
                ['Ponto de acesso (BSSID)', <span className="mono">{D.wifi.bssid || '—'}</span>],
                ['Frequência', freq != null ? `${freq} MHz${band ? ` · ${band}` : ''}${ch != null ? ` · canal ${ch}` : ''}` : '—'],
                ['Taxa de transmissão', D.wifi.info['tx bitrate'] ?? '—'],
                ...(D.wifi.info['rx bitrate'] ? [['Taxa de recepção', D.wifi.info['rx bitrate']] as [ReactNode, ReactNode]] : []),
                ['MAC', <span className="mono">{D.wli.addr || wlan?.mac || '—'}</span>],
                ['Endereços', wlan?.addrs.length ? <div className="col">{wlan.addrs.filter((a) => a.scope !== 'link').map((a) => <span key={a.addr} className="mono small">{a.addr}</span>)}</div> : '—'],
                ['Tráfego', wlan ? <span className="small">↓ {fmtBytes(wlan.rx)} ({fmtRate(wlan.rxRate)}) · ↑ {fmtBytes(wlan.tx)} ({fmtRate(wlan.txRate)})</span> : '—'],
              ]} />
            </div>
          ) : (
            <div className="col gap-s">
              <Empty>wlan0 não está associado a nenhuma rede</Empty>
              {D.wifi.raw && <Pre>{D.wifi.raw}</Pre>}
            </div>
          )}
        </Card>

        <Card title="Rotas e DNS" icon={<Router size={15} />}
          actions={<Badge tone={D.forward ? 'info' : 'muted'} title="/proc/sys/net/ipv4/ip_forward">encaminhamento IPv4 {D.forward ? 'ligado' : 'desligado'}</Badge>}>
          <div className="col gap-m">
            <KV items={[
              ['Rota padrão', def ? <span className="mono">{def.via || '—'} <span className="muted">via {def.dev}</span></span> : <Badge tone="bad">nenhuma</Badge>],
              ['DNS', D.nameservers.length ? <span className="mono">{D.nameservers.join(', ')}</span> : <Badge tone="warn">nenhum</Badge>],
              ...(D.search ? [['Domínio de busca', D.search] as [ReactNode, ReactNode]] : []),
            ]} />
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Destino</th><th>Gateway</th><th>Interface</th><th>Origem / métrica</th></tr></thead>
                <tbody>
                  {[...D.r4, ...D.r6].map((r, i) => (
                    <tr key={i} className={r.dst === 'default' ? 'sys-hl' : ''} title={r.raw}>
                      <td className="mono small">{r.dst}</td>
                      <td className="mono small">{r.via || <span className="muted">—</span>}</td>
                      <td className="mono small">{r.dev}</td>
                      <td className="mono small muted">{[r.src, r.metric && `métrica ${r.metric}`].filter(Boolean).join(' · ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      </Grid>

      <Card title="Interfaces" icon={<Network size={15} />} pad={false}
        actions={<Switch checked={showAll} onChange={setShowAll} label={<span className="small">mostrar todas{!showAll && hiddenCount ? ` (+${hiddenCount} inativas)` : ''}</span>} />}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Interface</th><th>Estado</th><th>Endereços</th><th>MAC</th><th className="num">Recebido</th><th className="num">Enviado</th><th className="num">Erros/descartes</th></tr>
            </thead>
            <tbody>
              {shown.map((i) => {
                const up = i.flags.includes('UP');
                const st = i.state || (up ? 'UP' : 'DOWN');
                const tone: Tone = st === 'UP' || (st === 'UNKNOWN' && up) ? 'ok' : st === 'DOWN' ? 'muted' : 'warn';
                const errs = i.rxErr + i.txErr;
                const drops = i.rxDrop + i.txDrop;
                return (
                  <tr key={i.name} className={i.name === 'wlan0' ? 'sys-hl' : ''}>
                    <td>
                      <div className="mono">{i.name}</div>
                      <div className="muted small">{ifaceKind(i.name)}{i.mtu ? ` · mtu ${i.mtu}` : ''}</div>
                    </td>
                    <td><Badge tone={tone}>{st}</Badge></td>
                    <td>{i.addrs.length ? <div className="col">{i.addrs.map((a) => <span key={a.addr} className={`mono small ${a.scope === 'link' ? 'muted' : ''}`} title={`${a.family} · escopo ${a.scope}`}>{a.addr}</span>)}</div> : <span className="muted">—</span>}</td>
                    <td className="mono small">{i.mac || '—'}</td>
                    <td className="num">{fmtBytes(i.rx)}<div className="sys-rate">{fmtRate(i.rxRate)}</div></td>
                    <td className="num">{fmtBytes(i.tx)}<div className="sys-rate">{fmtRate(i.txRate)}</div></td>
                    <td className="num small">{errs || drops ? <Badge tone={errs ? 'bad' : 'warn'}>{errs} / {drops}</Badge> : <span className="muted">0 / 0</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Grid cols={2}>
        <Card title="Portas em escuta" icon={<Cable size={15} />} pad={false}>
          {D.socks.length === 0 ? <Empty>Nenhum socket em escuta</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Proto</th><th>Endereço</th><th className="num">Porta</th><th>Alcance</th><th>Processo</th></tr></thead>
                <tbody>
                  {[...D.socks].sort((a, b) => cmp(+a.port, +b.port) || a.proto.localeCompare(b.proto)).map((s, i) => {
                    const local = /^(127\.|::1$|::ffff:127\.)/.test(s.addr);
                    const any = s.addr === '0.0.0.0' || s.addr === '::' || s.addr === '*' || s.addr === ':::' || s.addr === '';
                    return (
                      <tr key={i}>
                        <td className="mono small">{s.proto}</td>
                        <td className="mono small">{s.addr || '*'}</td>
                        <td className="num mono">{s.port}</td>
                        <td>{local ? <Badge tone="ok">só local</Badge> : any ? <Badge tone="info">todas as interfaces</Badge> : <Badge tone="muted">{s.addr}</Badge>}</td>
                        <td className="mono small">{s.prog || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Vizinhos (ARP)" icon={<Globe size={15} />} pad={false}>
          {D.arp.length === 0 ? <Empty>Tabela ARP vazia</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>IP</th><th>MAC</th><th>Interface</th><th>Estado</th></tr></thead>
                <tbody>
                  {[...D.arp].sort((a, b) => cmp(a.dev, b.dev) || cmp(a.ip, b.ip)).map((a) => (
                    <tr key={`${a.dev}-${a.ip}`} className={def?.via === a.ip ? 'sys-hl' : ''}>
                      <td className="mono small">{a.ip}{def?.via === a.ip && <> <Badge tone="info">gateway</Badge></>}</td>
                      <td className="mono small">{a.mac}</td>
                      <td className="mono small">{a.dev}</td>
                      <td>{a.flags === '0x0' || a.mac === '00:00:00:00:00:00' ? <Badge tone="warn">incompleto</Badge> : <Badge tone="ok">ok</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Grid>

      <FirewallCard />
    </>
  );
}

type FwView = 'summary' | 'S' | 'L' | 'nat';

function FirewallCard() {
  const [view, setView] = useState<FwView>('summary');
  const fw = usePoll(async () => {
    const s = await runSections({
      bin: 'readlink /usr/sbin/iptables 2>/dev/null || echo iptables',
      S: 'iptables -S 2>&1',
      L: 'iptables -L -n -v 2>&1',
      nat: 'iptables -t nat -S 2>/dev/null',
    }, { timeout: 20000 });
    return s;
  }, null);

  const summary = useMemo(() => {
    const policies: { chain: string; policy: string }[] = [];
    const chains = new Map<string, string[]>();
    for (const l of lines(fw.data?.S)) {
      let m: RegExpMatchArray | null;
      if ((m = l.match(/^-P\s+(\S+)\s+(\S+)/))) policies.push({ chain: m[1], policy: m[2] });
      else if ((m = l.match(/^-N\s+(\S+)/))) { if (!chains.has(m[1])) chains.set(m[1], []); }
      else if ((m = l.match(/^-A\s+(\S+)\s*(.*)$/))) chains.set(m[1], [...(chains.get(m[1]) ?? []), m[2]]);
    }
    return { policies, chains };
  }, [fw.data]);

  const penguin = summary.chains.get('PENGUIN-IN') ?? [];
  const lanPorts = penguin.map((r) => r.match(/--dport\s+(\d+)/)?.[1]).filter(Boolean) as string[];

  return (
    <Card title="Firewall (iptables)" icon={<Shield size={15} />}
      actions={
        <>
          {fw.data?.bin && <span className="muted small mono">{fw.data.bin.trim()}</span>}
          <RefreshButton onClick={fw.refresh} loading={fw.loading} lastUpdated={fw.lastUpdated} />
        </>
      }>
      <ErrorBox error={fw.error} onRetry={fw.refresh} />
      {!fw.data ? <Loading /> : (
        <div className="col gap-m">
          <Tabs<FwView> tabs={[
            { id: 'summary', label: 'Resumo' }, { id: 'S', label: 'iptables -S' }, { id: 'L', label: 'iptables -L -n -v' }, { id: 'nat', label: 'nat' },
          ]} value={view} onChange={setView} />
          {view === 'summary' && (
            <div className="col gap-m">
              <div className="row gap-s wrap">
                {summary.policies.map((p) => (
                  <Badge key={p.chain} tone={p.policy === 'DROP' || p.policy === 'REJECT' ? 'warn' : 'muted'}>{p.chain}: {p.policy}</Badge>
                ))}
              </div>
              <KV items={[
                ['Entrada pelo Wi-Fi (PENGUIN-IN)', penguin.length
                  ? <span className="row gap-s wrap">
                      <Badge tone="info">{penguin.length} regra(s)</Badge>
                      {lanPorts.length > 0 && <span className="small">portas: <span className="mono">{[...new Set(lanPorts)].join(', ')}</span></span>}
                    </span>
                  : <Badge tone="warn">cadeia ausente</Badge>],
              ]} />
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Cadeia</th><th className="num">Regras</th></tr></thead>
                  <tbody>
                    {[...summary.chains.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, rules]) => (
                      <tr key={c} className={c === 'PENGUIN-IN' ? 'sys-hl' : ''}><td className="mono small">{c}</td><td className="num">{rules.length}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {penguin.length > 0 && <Pre maxHeight={220}>{penguin.map((r) => `-A PENGUIN-IN ${r}`).join('\n')}</Pre>}
            </div>
          )}
          {view === 'S' && <Pre maxHeight={480}>{fw.data.S || 'sem saída'}</Pre>}
          {view === 'L' && <Pre maxHeight={480}>{fw.data.L || 'sem saída'}</Pre>}
          {view === 'nat' && <Pre maxHeight={480}>{fw.data.nat || 'sem saída'}</Pre>}
        </div>
      )}
    </Card>
  );
}

/* ───────────────────────────── 5. Pacotes ───────────────────────────── */

interface Pkg { name: string; version: string; arch: string; size: number | null; desc: string; license: string; origin: string; built: number | null; explicit: boolean }
type PkgSortKey = 'name' | 'size' | 'built';

function parseApkDb(text: string): Pkg[] {
  const out: Pkg[] = [];
  let cur: Pkg | null = null;
  for (const l of text.split('\n')) {
    if (l.length < 2 || l[1] !== ':') continue;
    const k = l[0];
    const v = l.slice(2);
    if (k === 'P') { cur = { name: v, version: '', arch: '', size: null, desc: '', license: '', origin: '', built: null, explicit: false }; out.push(cur); continue; }
    if (!cur) continue;
    if (k === 'V') cur.version = v;
    else if (k === 'A') cur.arch = v;
    else if (k === 'I') cur.size = toNum(v);
    else if (k === 'T') cur.desc = v;
    else if (k === 'L') cur.license = v;
    else if (k === 'o') cur.origin = v;
    else if (k === 't') cur.built = toNum(v);
  }
  return out;
}

/** Fallback: `apk list --installed` → "name-1.2.3-r0 armv7 {origin} (license) [installed]" */
function parseApkList(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const l of lines(text)) {
    const m = l.match(/^(.+)-([^-\s]+-r\d+)\s+(\S+)\s+\{([^}]*)\}\s+\(([^)]*)\)/);
    if (m) out.push({ name: m[1], version: m[2], arch: m[3], origin: m[4], license: m[5], size: null, desc: '', built: null, explicit: false });
  }
  return out;
}

function PackagesTab() {
  const [filter, setFilter] = useState('');
  const [allRows, setAllRows] = useState(false);
  const [onlyWorld, setOnlyWorld] = useStored('system.pkg.world', false);
  const [sort, setSort] = useState<SortState<PkgSortKey>>({ key: 'name', dir: 'asc' });
  const poll = usePoll(async () => {
    const s = await runSections({
      db: 'grep -E "^[PVAITLot]:" /lib/apk/db/installed 2>/dev/null',
      world: 'cat /etc/apk/world 2>/dev/null',
    }, { timeout: 30000 });
    let pkgs = parseApkDb(s.db ?? '');
    if (pkgs.length === 0) pkgs = parseApkList(await run('apk list --installed 2>/dev/null', { timeout: 60000 }));
    const world = new Set(lines(s.world).map((w) => w.trim().split(/[<>=~]/)[0]));
    for (const p of pkgs) p.explicit = world.has(p.name);
    return { pkgs, world };
  }, null);

  const D = poll.data;
  const rows = useMemo(() => {
    if (!D) return [];
    const q = filter.trim().toLowerCase();
    const list = D.pkgs.filter((p) => (!onlyWorld || p.explicit) && (!q || p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q) || p.origin.toLowerCase().includes(q)));
    const dir = sort.dir === 'asc' ? 1 : -1;
    return list.sort((a, b) => (sort.key === 'name' ? cmp(a.name, b.name) : sort.key === 'size' ? cmp(a.size, b.size) : cmp(a.built, b.built)) * dir || cmp(a.name, b.name));
  }, [D, filter, onlyWorld, sort]);

  const stats = useMemo(() => {
    const pkgs = D?.pkgs ?? [];
    return {
      totalSize: pkgs.reduce((a, p) => a + (p.size ?? 0), 0),
      explicitCount: pkgs.filter((p) => p.explicit).length,
      archs: [...new Set(pkgs.map((p) => p.arch).filter(Boolean))],
    };
  }, [D]);

  if (!D) return poll.error ? <ErrorBox error={poll.error} onRetry={poll.refresh} /> : <Loading label="Lendo banco de pacotes do apk…" />;

  const { totalSize, explicitCount, archs } = stats;

  return (
    <>
      <Grid min={200}>
        <Card><Stat label="Pacotes instalados" icon={<Package size={13} />} value={D.pkgs.length} sub={archs.length ? `arquitetura ${archs.join(', ')}` : undefined} /></Card>
        <Card><Stat label="Explícitos (world)" value={explicitCount} sub={`${D.pkgs.length - explicitCount} dependências`} /></Card>
        <Card><Stat label="Tamanho instalado" value={totalSize ? fmtBytes(totalSize) : '—'} sub="soma dos pacotes" /></Card>
      </Grid>
      <Card pad={false}
        title={<span>Pacotes <span className="muted small">({rows.length})</span></span>}
        icon={<Package size={15} />}
        actions={
          <>
            <SearchInput value={filter} onChange={setFilter} placeholder="Buscar nome, descrição…" />
            <Switch checked={onlyWorld} onChange={setOnlyWorld} label={<span className="small">só explícitos</span>} />
            <RefreshButton onClick={poll.refresh} loading={poll.loading} lastUpdated={poll.lastUpdated} />
          </>
        }>
        <ErrorBox error={poll.error} onRetry={poll.refresh} />
        {rows.length === 0 ? <Empty>Nenhum pacote encontrado</Empty> : (
          <div className="table-wrap sys-table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <SortTh k="name" sort={sort} setSort={setSort} defaultDir="asc">Pacote</SortTh>
                  <th>Versão</th>
                  <SortTh k="size" sort={sort} setSort={setSort} num>Tamanho</SortTh>
                  <th>Descrição</th>
                  <th>Licença</th>
                  <SortTh k="built" sort={sort} setSort={setSort}>Compilado em</SortTh>
                </tr>
              </thead>
              <tbody>
                {(allRows ? rows : rows.slice(0, ROW_CAP)).map((p) => (
                  <tr key={p.name}>
                    <td>
                      <span className="row gap-s">
                        <span className="mono">{p.name}</span>
                        {p.explicit && <Badge tone="info" title="listado em /etc/apk/world">explícito</Badge>}
                      </span>
                      {p.origin && p.origin !== p.name && <div className="muted small">origem {p.origin}</div>}
                    </td>
                    <td className="mono small nowrap">{p.version}</td>
                    <td className="num">{p.size != null ? fmtBytes(p.size) : '—'}</td>
                    <td className="small">{p.desc || <span className="muted">—</span>}</td>
                    <td className="small muted">{p.license || '—'}</td>
                    <td className="small nowrap">{p.built ? new Date(p.built * 1000).toLocaleDateString('pt-BR') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <MoreRows total={rows.length} shown={allRows ? rows.length : Math.min(rows.length, ROW_CAP)} onShowAll={() => setAllRows(true)} />
          </div>
        )}
      </Card>
    </>
  );
}

/* ───────────────────────────── 6. Hardware/kernel ───────────────────────────── */

const LEVELS: [string, Tone][] = [
  ['emerg', 'bad'], ['alert', 'bad'], ['crit', 'bad'], ['err', 'bad'], ['warn', 'warn'], ['notice', 'info'], ['info', 'muted'], ['debug', 'muted'],
];

interface Module { name: string; size: number | null; refs: string; usedBy: string[]; state: string; flags: string }

function parseModules(text: string | undefined): Module[] {
  return lines(text).map((l) => {
    const t = l.trim().split(/\s+/);
    const used = (t[3] ?? '-').replace(/,$/, '');
    return {
      name: t[0], size: toNum(t[1]), refs: t[2] ?? '', usedBy: used === '-' ? [] : used.split(',').filter(Boolean),
      state: t[4] ?? '', flags: (l.match(/\(([A-Z+-]+)\)\s*$/)?.[1]) ?? '',
    };
  });
}

function parseDmesgLines(text: string | undefined, btime: number | null) {
  return lines(text).map((l) => {
    const m = l.match(/^<(\d+)>\s*(?:\[\s*([\d.]+)\])?\s?(.*)$/);
    if (!m) return { level: 6, ts: null as number | null, msg: l, clock: '' };
    const lvl = +m[1] & 7;
    const ts = m[2] != null ? +m[2] : null;
    const clock = ts != null && btime ? new Date((btime + ts) * 1000).toLocaleTimeString('pt-BR') : '';
    return { level: lvl, ts, msg: m[3], clock };
  });
}

type DmesgView = 'err' | 'warn';

function HardwareTab() {
  const [dview, setDview] = useState<DmesgView>('err');
  const poll = usePoll(async () => {
    const s = await runSections({
      mods: 'cat /proc/modules',
      cmd: 'cat /proc/cmdline',
      ver: 'cat /proc/version',
      btime: 'grep "^btime" /proc/stat',
      // The kernel buffer is read once (sections share the shell) instead of four dmesg runs.
      dcount: "_dm=$(dmesg -r); printf '%s\\n' \"$_dm\" | sed -n 's/^<\\([0-9]*\\)>.*/\\1/p' | sort | uniq -c",
      dlines: `[ -n "$_dm" ] && printf '%s\\n' "$_dm" | wc -l || echo 0`,
      derr: "printf '%s\\n' \"$_dm\" | grep -E '^<[0-3]>' | tail -n 150",
      dwarn: "printf '%s\\n' \"$_dm\" | grep -E '^<4>' | tail -n 150; unset _dm",
      udc: 'for f in /sys/class/udc/*; do [ -r "$f/state" ] && echo "${f##*/}|$(cat "$f/state")"; done',
      gadget: 'grep -H . /sys/kernel/config/usb_gadget/*/UDC /sys/kernel/config/usb_gadget/*/idVendor /sys/kernel/config/usb_gadget/*/idProduct /sys/kernel/config/usb_gadget/*/strings/0x409/* 2>/dev/null; ls -d /sys/kernel/config/usb_gadget/*/functions/* 2>/dev/null',
      bl: 'cat /sys/class/leds/lcd-backlight/brightness /sys/class/leds/lcd-backlight/max_brightness 2>/dev/null',
      wdog: 'ls /dev/watchdog* 2>/dev/null',
      emmc: 'grep -H . /sys/block/mmcblk0/device/name /sys/block/mmcblk0/device/type /sys/block/mmcblk0/device/manfid /sys/block/mmcblk0/device/date /sys/block/mmcblk0/device/fwrev /sys/block/mmcblk0/size 2>/dev/null',
      hw: 'grep -E "^Hardware" /proc/cpuinfo',
    }, { timeout: 30000 });
    const btime = toNum((s.btime ?? '').trim().split(/\s+/)[1]);
    const counts = new Map<number, number>();
    for (const l of lines(s.dcount)) {
      const m = l.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) counts.set(+m[2] & 7, (counts.get(+m[2] & 7) ?? 0) + +m[1]);
    }
    const g = parseGrepH(s.gadget);
    const gadgets = new Map<string, { udc: string; vid: string; pid: string; strings: Record<string, string>; functions: string[] }>();
    const gg = (name: string) => {
      let x = gadgets.get(name);
      if (!x) { x = { udc: '', vid: '', pid: '', strings: {}, functions: [] }; gadgets.set(name, x); }
      return x;
    };
    for (const [path, v] of g) {
      const m = path.match(/usb_gadget\/([^/]+)\/(.*)$/);
      if (!m) continue;
      const x = gg(m[1]);
      if (m[2] === 'UDC') x.udc = v;
      else if (m[2] === 'idVendor') x.vid = v;
      else if (m[2] === 'idProduct') x.pid = v;
      else if (m[2].startsWith('strings/')) x.strings[m[2].split('/').pop() ?? m[2]] = v;
    }
    for (const l of lines(s.gadget)) {
      const m = l.match(/usb_gadget\/([^/]+)\/functions\/([^/:]+)$/);
      if (m) gg(m[1]).functions.push(m[2]);
    }
    const [bri, maxBri] = lines(s.bl).map((x) => toNum(x));
    const emmc = new Map<string, string>();
    for (const [p, v] of parseGrepH(s.emmc)) emmc.set(p.split('/').pop() ?? p, v);
    return {
      modules: parseModules(s.mods),
      cmdline: (s.cmd ?? '').trim(),
      version: (s.ver ?? '').trim(),
      counts,
      total: toNum((s.dlines ?? '').trim()),
      derr: parseDmesgLines(s.derr, btime),
      dwarn: parseDmesgLines(s.dwarn, btime),
      udc: lines(s.udc).map((l) => { const [n, st] = l.split('|'); return { name: n, state: st ?? '' }; }),
      gadgets: [...gadgets.entries()],
      bri: bri ?? null,
      maxBri: maxBri ?? null,
      watchdogs: lines(s.wdog),
      emmc,
      hardware: (s.hw ?? '').split(':').slice(1).join(':').trim(),
    };
  }, null);

  const D = poll.data;
  const tokens = useMemo(() => {
    if (!D) return [] as [string, string][];
    const seen = new Map<string, string>();
    const out: [string, string][] = [];
    for (const tok of D.cmdline.split(/\s+/).filter(Boolean)) {
      const i = tok.indexOf('=');
      const k = i >= 0 ? tok.slice(0, i) : tok;
      const v = i >= 0 ? tok.slice(i + 1) : '';
      if (seen.get(k) === v) continue;
      seen.set(k, v);
      out.push([k, v]);
    }
    return out;
  }, [D]);

  if (!D) return poll.error ? <ErrorBox error={poll.error} onRetry={poll.refresh} /> : <Loading />;

  const errCount = [0, 1, 2, 3].reduce((a, l) => a + (D.counts.get(l) ?? 0), 0);
  const warnCount = D.counts.get(4) ?? 0;
  const dl = dview === 'err' ? D.derr : D.dwarn;
  const sectors = toNum(D.emmc.get('size'));
  const cmdMap = new Map(tokens);
  const highlights: [string, string][] = [
    ['androidboot.serialno', 'Número de série'], ['androidboot.bootreason', 'Motivo do boot'], ['androidboot.product', 'Produto'],
    ['androidboot.hardware', 'Plataforma'], ['techo5', 'techo5'], ['lcm', 'Painel LCD'], ['bl_level', 'Brilho no boot'],
  ];

  return (
    <>
      <Toolbar
        left={<span className="muted small">Carregado sob demanda.</span>}
        right={<RefreshButton onClick={poll.refresh} loading={poll.loading} lastUpdated={poll.lastUpdated} />}
      />
      <ErrorBox error={poll.error} onRetry={poll.refresh} />

      <Grid min={200}>
        <Card><Stat label="Erros no dmesg" icon={<Info size={13} />} value={errCount} tone={errCount ? 'bad' : 'ok'} sub="níveis emerg … err" /></Card>
        <Card><Stat label="Avisos no dmesg" value={warnCount} tone={warnCount ? 'warn' : undefined} sub={`${D.total ?? '?'} linhas no buffer`} /></Card>
        <Card><Stat label="Módulos carregados" icon={<Layers size={13} />} value={D.modules.length} /></Card>
        <Card>
          <Stat label="Brilho da tela" icon={<Sun size={13} />} value={D.bri != null ? `${D.bri}${D.maxBri ? ` / ${D.maxBri}` : ''}` : '—'}
            sub={D.bri === 0 ? 'tela desligada' : D.bri != null && D.maxBri ? `${Math.round((D.bri / D.maxBri) * 100)}%` : undefined} />
          {D.bri != null && D.maxBri ? <Meter value={(D.bri / D.maxBri) * 100} warn={101} bad={101} /> : null}
        </Card>
      </Grid>

      <Card title="Mensagens do kernel (dmesg)" icon={<Terminal size={15} />}
        actions={
          <div className="row gap-s wrap">
            {LEVELS.map(([name, tone], i) => (D.counts.get(i) ? <Badge key={name} tone={tone}>{name} {D.counts.get(i)}</Badge> : null))}
          </div>
        }>
        <div className="col gap-m">
          <Tabs<DmesgView> tabs={[{ id: 'err', label: `Erros (${errCount})` }, { id: 'warn', label: `Avisos (${warnCount})` }]} value={dview} onChange={setDview} />
          {dl.length === 0 ? <Empty>{dview === 'err' ? 'Nenhum erro no buffer do kernel' : 'Nenhum aviso no buffer do kernel'}</Empty> : (
            <>
              <div className="sys-note">Últimas {dl.length} linhas{(dview === 'err' ? errCount : warnCount) > dl.length ? ` de ${dview === 'err' ? errCount : warnCount}` : ''}; horário aproximado (boot + tempo do kernel).</div>
              <Pre maxHeight={380} autoScroll>
                {dl.map((d, i) => (
                  <div key={i} className={`log-line ${d.level <= 3 ? 'err' : d.level === 4 ? 'warn' : ''}`}>
                    <span className="muted">{d.clock || (d.ts != null ? d.ts.toFixed(3) : '')}</span> {d.msg}
                  </div>
                ))}
              </Pre>
            </>
          )}
        </div>
      </Card>

      <Grid cols={2}>
        <Card title="Módulos do kernel" icon={<Layers size={15} />} pad={false}>
          {D.modules.length === 0 ? <Empty>Nenhum módulo carregado (tudo embutido no kernel)</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Módulo</th><th className="num">Tamanho</th><th className="num">Uso</th><th>Usado por</th><th>Estado</th></tr></thead>
                <tbody>
                  {D.modules.map((m) => (
                    <tr key={m.name}>
                      <td>
                        <span className="row gap-s">
                          <span className="mono">{m.name}</span>
                          {m.flags.includes('O') && <Badge tone="warn" title="módulo fora da árvore do kernel (out-of-tree)">externo</Badge>}
                        </span>
                      </td>
                      <td className="num">{fmtBytes(m.size)}</td>
                      <td className="num">{m.refs}</td>
                      <td className="mono small">{m.usedBy.join(', ') || <span className="muted">—</span>}</td>
                      <td><Badge tone={m.state === 'Live' ? 'ok' : 'warn'}>{m.state || '?'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Dispositivo" icon={<Monitor size={15} />}>
          <KV items={[
            ['SoC', D.hardware || '—'],
            ...highlights.filter(([k]) => cmdMap.has(k)).map(([k, label]) => [label, <span className="mono small">{cmdMap.get(k) || '—'}</span>] as [ReactNode, ReactNode]),
            ['eMMC', D.emmc.get('name') ? <span className="mono small">{D.emmc.get('name')} {D.emmc.get('type') ?? ''}{sectors ? ` · ${fmtBytes(sectors * 512)}` : ''}{D.emmc.get('fwrev') ? ` · fw ${D.emmc.get('fwrev')}` : ''}{D.emmc.get('date') ? ` · ${D.emmc.get('date')}` : ''}</span> : '—'],
            ['Watchdog', D.watchdogs.length ? <span className="mono small">{D.watchdogs.join(', ')}</span> : <Badge tone="muted">não encontrado</Badge>],
            ['Brilho (lcd-backlight)', D.bri != null ? `${D.bri} / ${D.maxBri ?? '?'}` : '—'],
          ]} />
        </Card>
      </Grid>

      <Grid cols={2}>
        <Card title="USB (gadget)" icon={<Usb size={15} />}>
          {D.udc.length === 0 && D.gadgets.length === 0 ? <Empty>Nenhum controlador USB device visível</Empty> : (
            <div className="col gap-m">
              {D.udc.map((u) => (
                <div key={u.name} className="row gap-s wrap">
                  <span className="mono">{u.name}</span>
                  <Badge tone={u.state === 'configured' ? 'ok' : u.state === 'not attached' ? 'muted' : 'warn'}>
                    {u.state === 'configured' ? 'conectado a um computador' : u.state === 'not attached' ? 'cabo desconectado' : u.state || '?'}
                  </Badge>
                </div>
              ))}
              {D.gadgets.map(([name, g]) => (
                <KV key={name} items={[
                  ['Gadget', <span className="mono">{name}</span>],
                  ['Vinculado ao UDC', g.udc ? <Badge tone="ok">{g.udc}</Badge> : <Badge tone="muted">não vinculado</Badge>],
                  ['VID:PID', <span className="mono">{g.vid || '?'}:{g.pid || '?'}</span>],
                  ['Fabricante', g.strings.manufacturer || '—'],
                  ['Produto', g.strings.product || '—'],
                  ['Série', g.strings.serialnumber || '—'],
                  ['Funções', g.functions.length ? <span className="row gap-s wrap">{g.functions.map((f) => <Badge key={f} tone="info">{f}</Badge>)}</span> : '—'],
                ]} />
              ))}
            </div>
          )}
        </Card>
        <Card title="Kernel" icon={<Cpu size={15} />}>
          <div className="col gap-m">
            <Pre>{D.version || '—'}</Pre>
            <div className="muted small">Linha de comando (/proc/cmdline) — {tokens.length} parâmetros</div>
            <div className="table-wrap sys-table-scroll short">
              <table className="table">
                <tbody>
                  {tokens.map(([k, v], i) => (
                    <tr key={i}><td className="mono small">{k}</td><td className="mono small" style={{ wordBreak: 'break-all' }}>{v || <span className="muted">—</span>}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      </Grid>
    </>
  );
}
