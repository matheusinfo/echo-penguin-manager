// Shared types, parsers and small components for the Docker page.
// Everything here parses defensively: bad input yields empty values, never a throw.
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Badge, Button, Modal, Pre } from '../../components/ui';
import { useStream } from '../../hooks';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

// ---------------------------------------------------------------- parsing

/** Parse `--format '{{json .}}'` output (one JSON object per line), or a single JSON array. */
export function parseJsonLines<T = Record<string, unknown>>(text: string | undefined | null): T[] {
  if (!text) return [];
  const t = text.trim();
  if (t.startsWith('[')) {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v as T[];
    } catch { /* fall through to line mode */ }
  }
  const out: T[] = [];
  for (const line of t.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try { out.push(JSON.parse(l) as T); } catch { /* skip */ }
  }
  return out;
}

export function parseJsonSafe<T = unknown>(text: string | undefined | null): T | null {
  if (!text) return null;
  const t = text.trim();
  const start = t.search(/[[{]/);
  if (start < 0) return null;
  try { return JSON.parse(t.slice(start)) as T; } catch { return null; }
}

export const str = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : String(v));

/** "a=b,c=d" (docker ps Labels) into a map. Values may contain commas, so a piece without "=" joins the previous value. */
export function parseLabels(s: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const text = str(s);
  if (!text) return out;
  let last: string | null = null;
  for (const part of text.split(',')) {
    const i = part.indexOf('=');
    if (i > 0 && /^[\w.\-/]+$/.test(part.slice(0, i))) {
      last = part.slice(0, i);
      out[last] = part.slice(i + 1);
    } else if (last) {
      out[last] += ',' + part;
    }
  }
  return out;
}

const UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

/** "221.9MiB", "37.8kB (virtual 802MB)", "1.2GB" → bytes (first number). */
export function parseSize(s: unknown): number | null {
  const m = /([\d.]+)\s*([kKmMgGtT]?i?B)\b/.exec(str(s));
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = UNITS[m[2].toLowerCase()];
  return isNaN(n) || !u ? null : n * u;
}

export function parsePercent(s: unknown): number | null {
  const n = parseFloat(str(s).replace('%', ''));
  return isNaN(n) ? null : n;
}

/** Docker CLI dates ("2026-11-01 23:34:22 -0300 -03") and API dates (RFC3339 with ns) → epoch ms. */
export function parseDockerDate(s: unknown): number | null {
  const t = str(s).trim();
  if (!t) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(t);
  if (!m) return null;
  const frac = m[3] ? m[3].slice(0, 4) : '';
  let tz = m[4] || '';
  if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${frac}${tz}`);
  if (isNaN(ms) || new Date(ms).getUTCFullYear() < 1980) return null;
  return ms;
}

export function fmtAgo(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 60) return `há ${Math.floor(s / 86400)} d`;
  if (s < 86400 * 730) return `há ${Math.floor(s / (86400 * 30))} meses`;
  return `há ${Math.floor(s / (86400 * 365))} anos`;
}

export function fmtDate(ms: number | null): string {
  return ms == null ? '—' : new Date(ms).toLocaleString('pt-BR');
}

/** Hide obvious secrets in a command line (cloudflared --token, passwords in args). */
export function maskSecrets(cmd: string): string {
  return cmd
    .replace(/(--?(?:token|password|passwd|secret|api[-_]?key)[= ]+)("[^"]*"|'[^']*'|\S+)/gi, '$1••••••')
    .replace(/\b(eyJ[\w-]{10,})(\.[\w-]+)*/g, '••••••');
}

/** Docker object names (containers, volumes, networks) as the daemon allows them. Used to reject deep links / odd input. */
export const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
export const isDockerName = (s: unknown): s is string => typeof s === 'string' && DOCKER_NAME_RE.test(s);

const SECRET_FLAG_RE = /^--?(?:token|password|passwd|secret|api[-_]?key)$/i;

/** maskSecrets for an argv array: also hides the value that follows a bare `--token` style flag. */
export function maskArgv(args: unknown[]): string[] {
  const out = args.map(str);
  for (let i = 0; i < out.length; i++) {
    if (SECRET_FLAG_RE.test(out[i]) && i + 1 < out.length) out[++i] = '••••••';
    else out[i] = maskSecrets(out[i]);
  }
  return out;
}

/** Remove ANSI escapes and keep what a terminal would show after carriage returns. */
export function cleanTerm(line: string): string {
  // eslint-disable-next-line no-control-regex
  const noAnsi = line.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
  const parts = noAnsi.split('\r').filter((p) => p !== '');
  return parts.length ? parts[parts.length - 1] : '';
}

// ---------------------------------------------------------------- containers

export interface PortMap {
  hostIp: string | null;
  hostPort: string | null;
  containerPort: string;
  proto: string;
  published: boolean;
}

/** "127.0.0.1:8090->8090/tcp, [::]:80->80/tcp, 8000/tcp" → maps, IPv4/IPv6 duplicates merged. */
export function parsePorts(s: unknown): PortMap[] {
  const out: PortMap[] = [];
  const seen = new Set<string>();
  for (const raw of str(s).split(',')) {
    const p = raw.trim();
    if (!p) continue;
    let m = /^(?:(.*):)?(\d+(?:-\d+)?)->(\d+(?:-\d+)?)\/(\w+)$/.exec(p);
    if (m) {
      const key = `${m[2]}>${m[3]}/${m[4]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ hostIp: m[1] || '0.0.0.0', hostPort: m[2], containerPort: m[3], proto: m[4], published: true });
      continue;
    }
    m = /^(\d+(?:-\d+)?)\/(\w+)$/.exec(p);
    if (m) {
      const key = `x${m[1]}/${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ hostIp: null, hostPort: null, containerPort: m[1], proto: m[2], published: false });
    }
  }
  return out;
}

export const isLoopback = (ip: string | null) => !!ip && (ip.startsWith('127.') || ip === '::1' || ip === '[::1]');

export interface ContainerRow {
  id: string;
  shortId: string;
  name: string;
  image: string;
  command: string;
  created: number | null;
  state: string;
  status: string;
  health: string; // healthy | unhealthy | starting | ''
  ports: PortMap[];
  labels: Record<string, string>;
  project: string;
  service: string;
  networks: string[];
  mounts: string[];
  size: string;
}

export function toContainer(o: Record<string, unknown>): ContainerRow {
  const labels = parseLabels(o.Labels);
  const status = str(o.Status);
  let health = str(o.HealthStatus);
  if (!health || health === 'none') {
    const m = /\((healthy|unhealthy|health: starting)\)/.exec(status);
    health = m ? (m[1] === 'health: starting' ? 'starting' : m[1]) : '';
  }
  const id = str(o.ID);
  return {
    id,
    shortId: id.slice(0, 12),
    name: str(o.Names).split(',')[0],
    image: str(o.Image),
    command: str(o.Command).replace(/^"|"$/g, ''),
    created: parseDockerDate(o.CreatedAt),
    state: str(o.State).toLowerCase() || guessState(status),
    status,
    health,
    ports: parsePorts(o.Ports),
    labels,
    project: labels['com.docker.compose.project'] || '',
    service: labels['com.docker.compose.service'] || '',
    networks: str(o.Networks).split(',').map((x) => x.trim()).filter(Boolean),
    mounts: str(o.Mounts).split(',').map((x) => x.trim()).filter(Boolean),
    size: str(o.Size),
  };
}

function guessState(status: string): string {
  if (/^Up/.test(status)) return /Paused/.test(status) ? 'paused' : 'running';
  if (/^Restarting/.test(status)) return 'restarting';
  if (/^Exited/.test(status)) return 'exited';
  if (/^Created/.test(status)) return 'created';
  return 'unknown';
}

export const STATE_LABEL: Record<string, [string, Tone]> = {
  running: ['rodando', 'ok'],
  exited: ['parado', 'muted'],
  paused: ['pausado', 'warn'],
  restarting: ['reiniciando', 'warn'],
  created: ['criado', 'info'],
  dead: ['morto', 'bad'],
  removing: ['removendo', 'warn'],
};

export const HEALTH_LABEL: Record<string, [string, Tone]> = {
  healthy: ['saudável', 'ok'],
  unhealthy: ['não saudável', 'bad'],
  starting: ['verificando', 'info'],
};

export function StateBadge({ state, status }: { state: string; status?: string }) {
  let [label, tone] = STATE_LABEL[state] ?? [state || '?', 'muted' as Tone];
  if (state === 'exited') {
    const code = /Exited \((\d+)\)/.exec(status || '')?.[1];
    if (code && code !== '0') tone = 'bad';
    if (code) label = `${label} (${code})`;
  }
  return <Badge tone={tone} title={status}>{label}</Badge>;
}

export function HealthBadge({ health }: { health: string }) {
  const h = HEALTH_LABEL[health];
  if (!h) return null;
  return <Badge tone={h[1]} title="healthcheck">{h[0]}</Badge>;
}

export interface StatRow { cpu: number | null; memPct: number | null; mem: number | null; memLimit: number | null; net: string; block: string; pids: string }

export function parseStats(text: string): Record<string, StatRow> {
  const out: Record<string, StatRow> = {};
  for (const o of parseJsonLines<Record<string, unknown>>(text)) {
    const [used, limit] = str(o.MemUsage).split('/');
    const row: StatRow = {
      cpu: parsePercent(o.CPUPerc),
      memPct: parsePercent(o.MemPerc),
      mem: parseSize(used),
      memLimit: parseSize(limit),
      net: str(o.NetIO),
      block: str(o.BlockIO),
      pids: str(o.PIDs),
    };
    const full = str(o.Container);
    const id = str(o.ID);
    if (full) out[full.slice(0, 12)] = row;
    if (id) out[id.slice(0, 12)] = row;
    if (o.Name) out[str(o.Name)] = row;
  }
  return out;
}

// ---------------------------------------------------------------- small components

export function CopyButton({ text, title = 'Copiar' }: { text: string; title?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Button size="s" variant="ghost" title={title} icon={ok ? <Check size={13} /> : <Copy size={13} />}
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }} />
  );
}

/** Highlight case-insensitive occurrences of `q` in `text`. */
export function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  let k = 0;
  for (;;) {
    const j = lower.indexOf(ql, i);
    if (j < 0) break;
    if (j > i) parts.push(text.slice(i, j));
    parts.push(<mark key={k++}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}

export function logTone(line: string): '' | 'err' | 'warn' {
  if (/\b(error|erro|fatal|panic|exception|traceback|critical|failed|falha)\b/i.test(line)) return 'err';
  if (/\b(warn|warning|aviso|deprecated)\b/i.test(line)) return 'warn';
  return '';
}

// ---------------------------------------------------------------- streaming job modal

export interface StreamJob {
  title: string;
  command: string;
  /** Short explanation shown above the output. */
  note?: ReactNode;
  onDone?: (code: number | null) => void;
}

const EXIT_MARK = '@@ECHO_EXIT@@';

/** Runs a long command (pull, compose up…) and shows its live output. */
export function StreamModal({ job, onClose }: { job: StreamJob | null; onClose: () => void }) {
  const s = useStream(4000);
  const [started, setStarted] = useState<number | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const doneRef = useRef(false);
  const jobRef = useRef<StreamJob | null>(null);

  useEffect(() => {
    jobRef.current = job;
    doneRef.current = false;
    setStartErr(null);
    // Drop the previous job's output now, so its exit marker is not read as this job's result.
    s.setLines([]);
    if (!job) { setStarted(null); return; }
    setStarted(Date.now());
    s.start(`{ ${job.command} ; } 2>&1; echo "${EXIT_MARK}$?"`).catch((e) => setStartErr(String(e?.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  // Only recomputed when output arrives (not on every re-render of the page behind the modal).
  const { code, shown } = useMemo(() => {
    let code: number | null = null;
    const shown: string[] = [];
    for (const l of s.lines) {
      if (l.startsWith(EXIT_MARK)) {
        const n = parseInt(l.slice(EXIT_MARK.length), 10);
        code = isNaN(n) ? null : n;
      } else {
        const c = cleanTerm(l);
        if (c.trim() !== '') shown.push(c);
      }
    }
    return { code, shown };
  }, [s.lines]);
  const finished = !!job && !s.running && started != null && (code != null || s.lines.length > 0 || !!startErr);

  useEffect(() => {
    if (finished && !doneRef.current) {
      doneRef.current = true;
      jobRef.current?.onDone?.(code);
    }
  }, [finished, code]);

  const close = () => {
    if (s.running) s.stop();
    if (!doneRef.current) {
      doneRef.current = true;
      jobRef.current?.onDone?.(null);
    }
    onClose();
  };

  const statusBadge = s.running
    ? <Badge tone="info">executando…</Badge>
    : code === 0 ? <Badge tone="ok">concluído</Badge>
      : code != null ? <Badge tone="bad">falhou (código {code})</Badge>
        : finished ? <Badge tone="warn">interrompido</Badge> : null;

  return (
    <Modal open={!!job} wide title={<span className="row gap-s">{job?.title} {statusBadge}</span>} onClose={close}
      footer={<>
        <span className="muted small mono grow ellipsis" title={job?.command}>$ {job ? maskSecrets(job.command) : ''}</span>
        {s.running && <Button variant="danger" onClick={() => s.stop()}>Interromper</Button>}
        <Button onClick={close}>{s.running ? 'Fechar (interrompe)' : 'Fechar'}</Button>
      </>}>
      {job?.note && <div className="muted small">{job.note}</div>}
      {startErr && <div className="errorbox">{startErr}</div>}
      <Pre autoScroll maxHeight="60vh" className="dk-stream">
        {shown.length ? shown.map((l, i) => <div key={i} className={`log-line ${logTone(l)}`}>{l}</div>)
          : <span className="muted">{s.running ? 'Aguardando saída…' : 'Sem saída.'}</span>}
      </Pre>
    </Modal>
  );
}
