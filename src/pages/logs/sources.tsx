// Log sources on the Echo: discovery (one ssh exec), commands to read/follow each source.
import { runSections, shq } from '../../api';

export type SourceKind = 'file' | 'dmesg' | 'logread' | 'container' | 'crash';
export type TailSize = '100' | '500' | '2000' | 'all';

export interface SourceDef {
  id: string;
  kind: SourceKind;
  label: string;
  /** File path (file / crash). */
  path?: string;
  /** Container name. */
  name?: string;
}

export interface FileInfo { size: number; mtime: number }
export interface CrashInfo {
  file: string;
  num: number;
  size: number;
  mtime: number;
  panic: boolean;
  oops: boolean;
  hung: boolean;
  watchdog: boolean;
  reboot: boolean;
}
export interface ContainerInfo { name: string; state: string; status: string }

export interface Discovery {
  files: Record<string, FileInfo>;
  crashes: CrashInfo[];
  containers: ContainerInfo[];
  dockerError: string | null;
  syslog: boolean;
  python: boolean;
}

export const CRASH_DIR = '/data/techo5-linux/crash';

/** Fixed file sources (ids are what other pages pass in navigate('logs', {source})). */
export const FILE_SOURCES: { id: string; label: string; path: string }[] = [
  { id: 'supervisor', label: 'Supervisor', path: '/data/penguin/logs/supervisor.log' },
  { id: 'docker', label: 'Docker (daemon)', path: '/data/penguin/logs/docker.log' },
  { id: 'boot', label: 'Boot (este boot)', path: '/run/boot.log' },
  { id: 'boot-persist', label: 'Boot (persistente)', path: '/data/techo5-linux/boot.log' },
  { id: 'firewall', label: 'Firewall', path: '/data/techo5-linux/firewall.log' },
  { id: 'rescue', label: 'Rescue', path: '/data/techo5-linux/rescue.log' },
];

/** Suffixes of the one old generation kept by p_rotate / techo5-run (`.1`), plus `.old` just in case. */
const ROTATED = ['.1', '.old'];

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Directory whose extra files discovery lists as `file:<path>` sources. */
const EXTRA_LOG_DIR = '/data/penguin/logs/';
/** Docker container names (what `docker ps` can return). */
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

// Source ids also come from deep links and the persisted prefs: only accept what discovery could have produced.
const okExtraPath = (p: string) =>
  p.startsWith(EXTRA_LOG_DIR) && p.length > EXTRA_LOG_DIR.length && !p.slice(EXTRA_LOG_DIR.length).includes('/') && !/[\0\n]/.test(p);
const okCrashFile = (f: string) => !!f && !f.includes('/') && f !== '.' && f !== '..' && !/[\0\n]/.test(f);

/** Turn a source id into a definition. Works without discovery so a page can deep-link. */
export function resolveSource(id: string): SourceDef | null {
  const fixed = FILE_SOURCES.find((f) => f.id === id);
  if (fixed) return { id, kind: 'file', label: fixed.label, path: fixed.path };
  for (const suf of ROTATED) {
    if (id.endsWith(suf)) {
      const base = FILE_SOURCES.find((f) => f.id === id.slice(0, -suf.length));
      if (base) return { id, kind: 'file', label: `${base.label} (anterior)`, path: base.path + suf };
    }
  }
  if (id === 'dmesg') return { id, kind: 'dmesg', label: 'Kernel (dmesg)' };
  if (id === 'syslog') return { id, kind: 'logread', label: 'Syslog (logread)' };
  if (id.startsWith('file:')) {
    const path = id.slice(5);
    if (!okExtraPath(path)) return null;
    return { id, kind: 'file', label: basename(path), path };
  }
  if (id.startsWith('crash:')) {
    const file = id.slice(6);
    if (!okCrashFile(file)) return null;
    return { id, kind: 'crash', label: `Crash #${crashNum(file)}`, path: `${CRASH_DIR}/${file}` };
  }
  if (id.startsWith('container:')) {
    const name = id.slice(10);
    return CONTAINER_RE.test(name) ? { id, kind: 'container', label: name, name } : null;
  }
  return null;
}

export function crashNum(file: string): number {
  const m = /^(\d+)/.exec(file);
  return m ? parseInt(m[1], 10) : 0;
}

/** Sistema group, in display order, from the discovered files. */
export function systemSources(d: Discovery | null): (SourceDef & { info?: FileInfo; missing?: boolean })[] {
  const out: (SourceDef & { info?: FileInfo; missing?: boolean })[] = [];
  const known = new Set<string>();
  for (const f of FILE_SOURCES) {
    known.add(f.path);
    const info = d?.files[f.path];
    out.push({ id: f.id, kind: 'file', label: f.label, path: f.path, info, missing: !!d && !info });
    for (const suf of ROTATED) {
      known.add(f.path + suf);
      const ri = d?.files[f.path + suf];
      if (ri) out.push({ id: f.id + suf, kind: 'file', label: `${f.label} (anterior)`, path: f.path + suf, info: ri });
    }
  }
  // Any other file under /data/penguin/logs (a future log the supervisor starts writing).
  if (d) {
    for (const [path, info] of Object.entries(d.files)) {
      if (!known.has(path)) out.push({ id: `file:${path}`, kind: 'file', label: basename(path), path, info });
    }
  }
  out.push({ id: 'dmesg', kind: 'dmesg', label: 'Kernel (dmesg)' });
  out.push({ id: 'syslog', kind: 'logread', label: 'Syslog (logread)', missing: !!d && !d.syslog });
  return out;
}

export async function discover(): Promise<Discovery> {
  const files = [
    ...FILE_SOURCES.map((f) => f.path),
    ...FILE_SOURCES.flatMap((f) => ROTATED.map((s) => f.path + s)),
  ];
  const r = await runSections({
    files: `for f in ${files.map(shq).join(' ')} /data/penguin/logs/*; do [ -f "$f" ] && stat -c '%s|%Y|%n' "$f"; done; true`,
    // size|mtime|file|flags (panic oops hung watchdog reboot)
    crash: `[ -d ${CRASH_DIR} ] && ( cd ${CRASH_DIR} && for f in *; do [ -f "$f" ] || continue; printf '%s|' "$(stat -c '%s|%Y' "$f")" "$f"; awk '/Kernel panic/{p=1} /Oops|Internal error|Unable to handle kernel|BUG: /{o=1} /blocked for more than/{h=1} /soft lockup|hard LOCKUP|NMI watchdog|[Ww]atchdog (bark|bite|detected)|WDT (bark|bite)/{w=1} /reboot: |Restarting system/{r=1} END{printf "%d%d%d%d%d\\n",p,o,h,w,r}' "$f"; done ); true`,
    docker: `docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}' 2>&1 || echo '@@ERR'`,
    syslog: `logread >/dev/null 2>&1 && echo yes || echo no`,
    python: `command -v python3 >/dev/null && echo yes || echo no`,
  }, { timeout: 30000 });

  const fileMap: Record<string, FileInfo> = {};
  for (const line of (r.files || '').split('\n')) {
    const [size, mtime, ...rest] = line.split('|');
    const path = rest.join('|');
    if (path && !isNaN(+size)) fileMap[path] = { size: +size, mtime: +mtime };
  }

  const crashes: CrashInfo[] = [];
  for (const line of (r.crash || '').split('\n')) {
    const [size, mtime, file, flags = ''] = line.split('|');
    if (!file || isNaN(+size)) continue;
    crashes.push({
      file, num: crashNum(file), size: +size, mtime: +mtime,
      panic: flags[0] === '1', oops: flags[1] === '1', hung: flags[2] === '1', watchdog: flags[3] === '1', reboot: flags[4] === '1',
    });
  }
  crashes.sort((a, b) => b.num - a.num || b.mtime - a.mtime);

  const containers: ContainerInfo[] = [];
  let dockerError: string | null = null;
  const dockerOut = r.docker || '';
  if (dockerOut.includes('@@ERR')) {
    dockerError = dockerOut.replace('@@ERR', '').trim() || 'docker indisponível';
  } else {
    for (const line of dockerOut.split('\n')) {
      const [name, state, status] = line.split('|');
      if (name && state) containers.push({ name, state, status: status || '' });
    }
    containers.sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.name.localeCompare(b.name));
  }

  return { files: fileMap, crashes, containers, dockerError, syslog: r.syslog === 'yes', python: r.python === 'yes' };
}

// ---------- reading ----------

export interface SourceMeta {
  path?: string;
  size?: number;
  mtime?: number;
  lineCount?: number;
  missing?: boolean;
  /** Extra key/values shown in the header (container state, etc.). */
  extra?: [string, string][];
}

const tailArg = (t: TailSize) => (t === 'all' ? '' : ` | tail -n ${parseInt(t, 10)}`);

const fileMetaCmd = (path: string) =>
  `if [ -f ${shq(path)} ]; then stat -c '%s|%Y' ${shq(path)}; wc -l < ${shq(path)}; else echo MISSING; fi`;

function parseFileMeta(out: string, path: string): SourceMeta {
  if (out.trim() === 'MISSING') return { path, missing: true };
  const [first = '', second = ''] = out.split('\n');
  const [size, mtime] = first.split('|');
  return { path, size: +size, mtime: +mtime, lineCount: parseInt(second.trim(), 10) };
}

/** One-shot read: metadata + last N lines. */
export async function loadSource(src: SourceDef, tail: TailSize, timestamps: boolean, metaOnly = false): Promise<{ lines: string[]; meta: SourceMeta }> {
  let sections: Record<string, string>;
  switch (src.kind) {
    case 'file':
    case 'crash':
      sections = {
        meta: fileMetaCmd(src.path!),
        body: `[ -f ${shq(src.path!)} ] && ${tail === 'all' ? 'cat' : `tail -n ${parseInt(tail, 10)}`} ${shq(src.path!)}`,
      };
      break;
    case 'dmesg':
      sections = { meta: 'dmesg | wc -l', body: `dmesg${tailArg(tail)}` };
      break;
    case 'logread':
      sections = { meta: 'logread | wc -l', body: `logread${tailArg(tail)}` };
      break;
    case 'container': {
      const n = shq(src.name!);
      sections = {
        // inspect line, then (json-file driver) size|mtime and line count of the container's log file.
        meta: `i=$(docker inspect -f '{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.HostConfig.LogConfig.Type}}|{{.Config.Image}}|{{.LogPath}}' ${n} 2>&1 | head -n 1); echo "$i"; lp=\${i##*|}; if [ -n "$lp" ] && [ -f "$lp" ]; then stat -c '%s|%Y' "$lp"; wc -l < "$lp"; fi`,
        body: `docker logs --tail ${tail === 'all' ? 'all' : parseInt(tail, 10)}${timestamps ? ' --timestamps' : ''} ${n}`,
      };
      break;
    }
  }
  if (metaOnly) delete sections.body;
  const r = await runSections(sections, { timeout: 45000 });
  const body = r.body ?? '';
  const lines = body === '' ? [] : body.split('\n');
  let meta: SourceMeta = {};
  const m = r.meta ?? '';
  switch (src.kind) {
    case 'file':
    case 'crash':
      meta = parseFileMeta(m, src.path!);
      break;
    case 'dmesg':
      meta = { path: 'buffer do kernel (dmesg)', lineCount: parseInt(m, 10) };
      break;
    case 'logread':
      meta = { path: 'buffer do syslogd (logread)', lineCount: parseInt(m, 10) };
      break;
    case 'container': {
      const [info = '', stat = '', wc = ''] = m.split('\n');
      const parts = info.split('|');
      if (parts.length < 6) {
        meta = { missing: true, extra: [['erro', info.trim()]] };
        break;
      }
      const [state, started, restarts, driver, image, logPath] = parts;
      const [size, mtime] = stat.split('|');
      meta = {
        path: logPath || `(driver de log: ${driver})`,
        size: stat ? +size : undefined,
        mtime: stat ? +mtime : undefined,
        lineCount: wc ? parseInt(wc, 10) : undefined,
        extra: [
          ['estado', state],
          ['iniciado', started && !started.startsWith('0001') ? new Date(started).toLocaleString('pt-BR') : '—'],
          ['reinícios', restarts],
          ['imagem', image.startsWith('sha256:') ? image.slice(7, 19) : image],
          ['driver', driver],
        ],
      };
      break;
    }
  }
  return { lines, meta };
}

/**
 * Wrap a long-running command so it dies when the ssh channel closes.
 * Without a PTY, closing the channel does not signal the remote process: `tail -F` on a quiet file
 * would linger forever. A background watcher reads the channel's stdin (fd 3) and kills the
 * command on EOF; if the command ends by itself the watcher is killed and the channel closes.
 */
function withChannelWatch(cmd: string): string {
  // electron/ssh.js streamStart now wraps every stream with the same watcher (killing the whole
  // process group), so nothing to add here.
  return cmd;
}

// /dev/kmsg follower: seek to the end, print new records formatted like dmesg.
const KMSG_PY = `import os,sys
fd=os.open('/dev/kmsg',os.O_RDONLY)
os.lseek(fd,0,2)
while True:
    try:
        r=os.read(fd,8192)
    except OSError:
        continue
    if not r:
        break
    h,_,m=r.decode('utf-8','replace').partition(';')
    p=h.split(',')
    try:
        ts=int(p[2])/1e6
    except Exception:
        ts=0
    sys.stdout.write('[%12.6f] %s\\n'%(ts,m.split('\\n')[0]))
    sys.stdout.flush()
`;

/** Command for follow mode, or null when the source can't be followed by a stream (poll instead). */
export function followCommand(src: SourceDef, tail: TailSize, timestamps: boolean, d: Discovery | null): string | null {
  const n = tail === 'all' ? null : parseInt(tail, 10);
  switch (src.kind) {
    case 'file':
      return withChannelWatch(`tail -n ${n == null ? '+1' : n} -F ${shq(src.path!)} 2>&1`);
    case 'container':
      return withChannelWatch(`docker logs -f --tail ${n == null ? 'all' : n}${timestamps ? ' --timestamps' : ''} ${shq(src.name!)} 2>&1`);
    case 'dmesg':
      // busybox dmesg has no -w; read /dev/kmsg with python3 when present.
      if (d && !d.python) return null;
      return withChannelWatch(`( dmesg${n == null ? '' : ` | tail -n ${n}`}; exec python3 -u -c ${shq(KMSG_PY)} )`);
    case 'logread':
      return withChannelWatch(`( logread${n == null ? '' : ` | tail -n ${n}`}; exec logread -f )`);
    case 'crash':
      return null;
  }
}

/** Sources that can be followed at all (by stream or polling). */
export const canFollow = (src: SourceDef) => src.kind !== 'crash';
