// Typed access to the preload bridge (window.echo) plus small shared helpers.

export interface EchoConfig {
  host: string;
  port: number;
  username: string;
  keyPath: string;
  /** Always '' when read; send a value to replace the saved one. */
  passphrase: string;
  useAgent: boolean;
  refreshSeconds: number;
  autoConnect: boolean;
  notifications: boolean;
  /** Read-only: a passphrase is saved (encrypted in the system keyring). */
  hasPassphrase?: boolean;
  /** Read-only: pinned host key fingerprint of the current host, if any. */
  hostKey?: string | null;
  /** Read-only: whether the system keyring can store the passphrase. */
  keyringAvailable?: boolean;
}

export interface ConfigUpdate extends Partial<EchoConfig> {
  clearPassphrase?: boolean;
  forgetHostKey?: boolean;
}

export type ConnState = 'disconnected' | 'connecting' | 'connected' | 'error';
export interface SshStatus {
  state: ConnState;
  error: string | null;
  host: string | null;
  connectedAt: number | null;
  /** Fingerprint of the key the Echo presented on the last connection. */
  hostKey?: string | null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  durationMs: number;
}

export interface EchoBridge {
  config: {
    get(): Promise<EchoConfig>;
    set(cfg: ConfigUpdate): Promise<EchoConfig>;
    pickKey(): Promise<string | null>;
  };
  ssh: {
    connect(): Promise<SshStatus>;
    disconnect(): Promise<SshStatus>;
    status(): Promise<SshStatus>;
    onStatus(cb: (s: SshStatus) => void): () => void;
  };
  /** Runs a command on the Echo (busybox sh, PATH already includes /usr/local/sbin). */
  exec(command: string, opts?: { timeout?: number; stdin?: string }): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  /** Atomic write (tmp file + mv). */
  writeFile(path: string, content: string): Promise<boolean>;
  stream: {
    start(command: string): Promise<string>;
    stop(id: string): Promise<boolean>;
    onData(cb: (p: { id: string; data: string; stderr: boolean }) => void): () => void;
    onEnd(cb: (p: { id: string; code: number | null }) => void): () => void;
  };
  shell: {
    open(size?: { cols: number; rows: number }): Promise<string>;
    write(id: string, data: string): Promise<boolean>;
    resize(id: string, cols: number, rows: number): Promise<boolean>;
    close(id: string): Promise<boolean>;
    onData(cb: (p: { id: string; data: string }) => void): () => void;
    onExit(cb: (p: { id: string; code: number | null }) => void): () => void;
  };
  store: {
    get<T>(name: string, fallback?: T): Promise<T>;
    set<T>(name: string, value: T): Promise<boolean>;
  };
  app: {
    notify(title: string, body: string): Promise<boolean>;
    saveText(defaultName: string, content: string): Promise<string | null>;
    openExternal(url: string): Promise<boolean>;
    info(): Promise<{ version: string; electron: string; platform: string }>;
  };
}

declare global {
  interface Window {
    echo: EchoBridge;
  }
}

export const echo: EchoBridge = window.echo;

/** exec that throws on non-zero exit, returning stdout. */
export async function run(command: string, opts?: { timeout?: number; stdin?: string }): Promise<string> {
  const r = await echo.exec(command, opts);
  if (r.code !== 0) {
    throw new Error((r.stderr || r.stdout).trim() || `comando saiu com código ${r.code}`);
  }
  return r.stdout;
}

/** Single-quote a value for busybox sh. */
export function shq(s: string | number): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run several labelled shell snippets in ONE ssh exec and split the output back by label.
 * Keeps polling cheap on the Echo (1 GB RAM, slow CPU).
 */
export async function runSections(sections: Record<string, string>, opts?: { timeout?: number }): Promise<Record<string, string>> {
  const marker = '@@ECHO_SECTION@@';
  // The leading `echo` guarantees the marker starts a line even if the previous output had no final newline.
  const script = Object.entries(sections)
    .map(([k, cmd]) => `echo; echo '${marker}${k}'; { ${cmd} ; } 2>&1`)
    .join('\n');
  const r = await echo.exec(script, opts);
  const out: Record<string, string> = {};
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith(marker)) {
      if (current !== null) out[current] = buf.join('\n').replace(/\n+$/, '');
      current = line.slice(marker.length);
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  if (current !== null) out[current] = buf.join('\n').replace(/\n+$/, '');
  return out;
}

export function fmtBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${(n < 0 ? -v : v).toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds)) return '—';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // Strip Electron's "Error invoking remote method 'x': Error: " prefix.
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
