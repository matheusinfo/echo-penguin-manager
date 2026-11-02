// Unified log viewer: system logs, kernel, crash records (ramoops) and per-container logs.
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowDownToLine, Copy, Download, Eraser, Pause, Play, Radio, RefreshCw, Search } from 'lucide-react';
import { echo, errMsg, fmtBytes } from '../api';
import { useApp, usePoll, useStored, useStream } from '../hooks';
import { Badge, Button, Empty, ErrorBox, Loading, NeedsConnection, Page, Switch } from '../components/ui';
import { canFollow, discover, followCommand, loadSource, resolveSource, SourceMeta, TailSize } from './logs/sources';
import { buildMatcher, cleanLine, Entry, levelOf, LogLine, MAX_QUERY } from './logs/LogText';
import { crashTags, fmtWhen, SourceList } from './logs/SourceList';
import './Logs.css';

/** Lines kept in memory while following. */
const STREAM_MAX = 20000;
/** Lines actually put in the DOM (the newest ones of the filtered set). */
const RENDER_CAP = 5000;
const POLL_MS = 3000;

interface Prefs {
  source: string;
  tail: TailSize;
  wrap: boolean;
  lineNumbers: boolean;
  autoScroll: boolean;
  timestamps: boolean;
  searchMode: 'filter' | 'highlight';
  regex: boolean;
}

const DEFAULT_PREFS: Prefs = {
  source: 'supervisor',
  tail: '500',
  wrap: true,
  lineNumbers: false,
  autoScroll: true,
  timestamps: false,
  searchMode: 'filter',
  regex: false,
};

const TAILS: { id: TailSize; label: string }[] = [
  { id: '100', label: '100' },
  { id: '500', label: '500' },
  { id: '2000', label: '2000' },
  { id: 'all', label: 'tudo' },
];

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * The stream only appends (and drops from the front once full). Returns how many lines were dropped from
 * the front of `prev` to get `next`'s prefix, verifying every kept line, or -1 when `next` does not
 * continue `prev` (cleared, restarted…). Comparisons are mostly pointer-equal strings, so this is cheap.
 */
function keptOffset(prev: string[], next: string[]): number {
  const pl = prev.length;
  let budget = 400000;
  for (let d = 0; d < pl; d++) {
    const keep = pl - d;
    if (keep > next.length || (d === 0 && next.length < pl)) continue;
    if (prev[d] !== next[0]) continue;
    let ok = true;
    for (let i = 1; i < keep; i++) {
      if (--budget < 0) return -1;
      if (prev[d + i] !== next[i]) { ok = false; break; }
    }
    if (ok) return d;
  }
  return -1;
}

export default function LogsPage() {
  const { connected } = useApp();
  return (
    <Page title="Logs" subtitle="Logs do sistema, kernel, registros de crash e containers">
      <NeedsConnection connected={connected}>
        <LogsView />
      </NeedsConnection>
    </Page>
  );
}

function LogsView() {
  const { connected, toast, pageParams } = useApp();
  const [storedPrefs, setPrefs, prefsReady] = useStored<Prefs>('logs-prefs', DEFAULT_PREFS);
  const prefs = { ...DEFAULT_PREFS, ...storedPrefs };
  // The tail size ends up in shell commands: never trust the persisted value.
  if (!TAILS.some((t) => t.id === prefs.tail)) prefs.tail = DEFAULT_PREFS.tail;
  const setPref = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => ({ ...DEFAULT_PREFS, ...p, [k]: v })), [setPrefs]);

  // Deep link from other pages: navigate('logs', { source: 'supervisor' | 'container:<name>' | ... }).
  useEffect(() => {
    if (prefsReady && pageParams.source && resolveSource(pageParams.source)) setPref('source', pageParams.source);
  }, [prefsReady, pageParams.source, setPref]);

  const disc = usePoll(discover, 30000);

  const src = useMemo(() => resolveSource(prefs.source) ?? resolveSource('supervisor')!, [prefs.source]);
  const syslogOff = src.kind === 'logread' && !!disc.data && !disc.data.syslog;
  const followable = canFollow(src) && !syslogOff;
  const streamCmd = useMemo(
    () => (followable ? followCommand(src, prefs.tail, prefs.timestamps, disc.data) : null),
    [src, followable, prefs.tail, prefs.timestamps, disc.data],
  );

  // ---------- data ----------
  const stream = useStream(STREAM_MAX);
  const [follow, setFollow] = useState(false);
  const [staticLines, setStaticLines] = useState<string[]>([]);
  const [meta, setMeta] = useState<SourceMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);
  // Background refreshes (poll fallback / metadata) are skipped while another read is still running,
  // so a slow Echo never gets a queue of overlapping execs.
  const busyRef = useRef(false);
  // Pause freezes what is shown while the stream keeps filling.
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<string[] | null>(null);
  // Scroll: stick to the bottom unless the user scrolled up.
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const streaming = follow && streamCmd != null;
  const polling = follow && streamCmd == null && followable;

  const fetchStatic = useCallback(async (metaOnly = false, quiet = false, fromTimer = false) => {
    if (fromTimer && busyRef.current) return;
    const id = ++reqId.current;
    busyRef.current = true;
    if (!quiet) setLoading(true);
    try {
      const r = await loadSource(src, prefs.tail, prefs.timestamps, metaOnly);
      if (id !== reqId.current) return;
      setMeta(r.meta);
      if (!metaOnly) setStaticLines(r.lines);
      setError(null);
    } catch (e) {
      if (id === reqId.current) setError(errMsg(e));
    } finally {
      if (id === reqId.current) {
        busyRef.current = false;
        if (!quiet) setLoading(false);
      }
    }
  }, [src, prefs.tail, prefs.timestamps]);

  const startStream = useCallback(async () => {
    if (!streamCmd) return;
    setError(null);
    try {
      await stream.start(streamCmd);
    } catch (e) {
      setError(errMsg(e));
    }
    fetchStatic(true, true);
  }, [streamCmd, stream.start, fetchStatic]); // eslint-disable-line react-hooks/exhaustive-deps

  // (Re)load whenever the source or its read options change.
  useEffect(() => {
    if (!connected || !prefsReady) return;
    setPaused(false);
    setFrozen(null);
    stickRef.current = true;
    setAtBottom(true);
    if (!followable && follow) setFollow(false);
    if (follow && streamCmd) {
      setMeta(null);
      startStream();
    } else {
      stream.stop();
      setStaticLines([]);
      setMeta(null);
      fetchStatic();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, prefsReady, src.id, prefs.tail, prefs.timestamps]);

  // Poll fallback (e.g. dmesg without python3) and periodic metadata refresh while following.
  useEffect(() => {
    if (!follow || !connected) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      if (polling) fetchStatic(false, true, true);
      else fetchStatic(true, true, true);
    }, polling ? POLL_MS : 10000);
    return () => clearInterval(t);
  }, [follow, polling, connected, fetchStatic]);

  const toggleFollow = (on: boolean) => {
    setFollow(on);
    setPaused(false);
    setFrozen(null);
    if (on) {
      stickRef.current = true;
      if (streamCmd) startStream();
      else fetchStatic(false, true);
    } else if (streaming) {
      // Keep what was streamed on screen.
      setStaticLines(stream.lines);
      stream.stop();
    }
  };

  const reload = () => {
    stickRef.current = true;
    setPaused(false);
    setFrozen(null);
    if (streaming) startStream();
    else fetchStatic();
    disc.refresh();
  };

  const clearView = () => {
    stream.setLines([]);
    setStaticLines([]);
    setFrozen(paused ? [] : null);
  };

  const rawLines = streaming ? stream.lines : staticLines;

  // ---------- pause ----------
  const togglePause = () => {
    if (paused) {
      setPaused(false);
      setFrozen(null);
      stickRef.current = true;
    } else {
      setPaused(true);
      setFrozen(rawLines);
    }
  };
  const lines = paused && frozen ? frozen : rawLines;
  const pendingNew = paused && frozen ? Math.max(0, rawLines.length - frozen.length) : 0;

  // ---------- search / filter ----------
  const [query, setQuery] = useState('');
  // Filtering 20k lines per keystroke would make typing lag: match against a deferred copy.
  const deferredQuery = useDeferredValue(query);
  const { matcher, error: reError } = useMemo(() => buildMatcher(deferredQuery, prefs.regex), [deferredQuery, prefs.regex]);

  // Classification is the per-line cost; while streaming, only classify the appended tail. Once the stream
  // buffer is full (oldest lines dropped), the kept prefix is found by offset so the work stays incremental,
  // and `n` keeps counting from the stream start, so React keys stay stable and memoized lines are reused.
  const classCache = useRef<{ lines: string[]; out: Entry[]; base: number }>({ lines: [], out: [], base: 0 });
  const classified = useMemo<Entry[]>(() => {
    const c = classCache.current;
    if (lines === c.lines) return c.out;
    const pl = c.lines.length;
    let drop = -1; // lines dropped from the front of the previous array; -1 = no reuse
    if (streaming && pl > 0 && lines.length > 0) drop = keptOffset(c.lines, lines);
    const reuse = drop < 0 ? 0 : pl - drop;
    const base = drop < 0 ? 0 : c.base + drop;
    const out = drop < 0 ? [] : c.out.slice(drop);
    for (let i = reuse; i < lines.length; i++) {
      const text = cleanLine(lines[i]);
      out.push({ n: base + i, text, level: levelOf(text), hit: false });
    }
    classCache.current = { lines, out, base };
    return out;
  }, [lines, streaming]);

  const { entries, hits } = useMemo(() => {
    if (!matcher) return { entries: classified, hits: 0 };
    let hits = 0;
    const out: Entry[] = [];
    for (const e of classified) {
      const hit = matcher.t.test(e.text);
      if (hit) hits++;
      if (hit || prefs.searchMode === 'highlight') out.push(hit ? { ...e, hit } : e);
    }
    return { entries: out, hits };
  }, [classified, matcher, prefs.searchMode]);

  const rendered = entries.length > RENDER_CAP ? entries.slice(entries.length - RENDER_CAP) : entries;
  const levelCounts = useMemo(() => {
    let err = 0;
    let warn = 0;
    for (const e of classified) {
      if (e.level === 'err') err++;
      else if (e.level === 'warn') warn++;
    }
    return { err, warn };
  }, [classified]);

  // ---------- scrolling ----------
  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    const b = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickRef.current = b;
    if (b !== atBottom) setAtBottom(b);
  };

  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && prefs.autoScroll && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [rendered, prefs.autoScroll, prefs.wrap, prefs.lineNumbers]);

  const toBottom = () => {
    const el = preRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  // ---------- keyboard ----------
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') setQuery('');
  };

  // ---------- export ----------
  const visibleText = () => entries.map((e) => e.text).join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(visibleText());
      toast(`${entries.length} linhas copiadas`, 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };
  const download = async () => {
    const slug = src.id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
    try {
      const saved = await echo.app.saveText(`echo-${slug}-${stamp()}.log`, visibleText() + '\n');
      if (saved) toast(`Salvo em ${saved}`, 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  // ---------- render ----------
  const isContainer = src.kind === 'container';
  const crash = src.kind === 'crash' ? disc.data?.crashes.find((c) => `crash:${c.file}` === src.id) : undefined;
  const showLoading = loading && lines.length === 0;
  const re = matcher ? matcher.g : null;

  return (
    <div className="logs-layout">
      <aside className="logs-side card">
        <div className="logs-side-head">
          <span className="card-title">Fontes</span>
          <Button size="s" variant="ghost" title="Atualizar lista" onClick={disc.refresh} icon={<RefreshCw size={13} className={disc.loading ? 'spin' : ''} />} />
        </div>
        {disc.error && <div className="logs-note err">{disc.error}</div>}
        <SourceList disc={disc.data} selected={src.id} onSelect={(id) => setPref('source', id)} loading={disc.loading} />
      </aside>

      <section className="logs-main card">
        {/* header: source + metadata */}
        <div className="logs-head">
          <div className="logs-title">
            <h2>{src.label}</h2>
            {streaming && stream.running && !paused && <Badge tone="ok"><Radio size={11} /> ao vivo</Badge>}
            {streaming && !stream.running && !loading && <Badge tone="warn" title="O comando de acompanhamento terminou">seguimento encerrado</Badge>}
            {polling && !paused && <Badge tone="info" title={`Atualizando a cada ${POLL_MS / 1000}s (dmesg do busybox não tem -w)`}>atualizando</Badge>}
            {paused && <Badge tone="warn">pausado{pendingNew > 0 ? ` · +${pendingNew} novas` : ''}</Badge>}
            {crash && crashTags(crash).map((t) => <Badge key={t.label} tone={t.tone}>{t.label}</Badge>)}
          </div>
          <div className="logs-meta">
            {meta?.missing && !isContainer && <span className="lt-warn">arquivo não existe</span>}
            {meta?.path && <span className="mono ellipsis" title={meta.path}>{meta.path}</span>}
            {meta?.size != null && !isNaN(meta.size) && <span>{fmtBytes(meta.size)}</span>}
            {meta?.mtime != null && !isNaN(meta.mtime) && <span title="Última modificação">modificado {fmtWhen(meta.mtime)}</span>}
            {meta?.lineCount != null && !isNaN(meta.lineCount) && <span>{meta.lineCount.toLocaleString('pt-BR')} linhas</span>}
            {meta?.extra?.map(([k, v]) => <span key={k}><span className="muted">{k}</span> {v}</span>)}
          </div>
        </div>

        {/* toolbar */}
        <div className="logs-toolbar">
          <div className="row gap-s wrap">
            <div className="seg" title="Quantas linhas finais carregar">
              {TAILS.map((t) => (
                <button key={t.id} className={prefs.tail === t.id ? 'active' : ''} onClick={() => setPref('tail', t.id)}>{t.label}</button>
              ))}
            </div>
            <Switch checked={follow} disabled={!followable} onChange={toggleFollow} label="Seguir" />
            <Button size="s" icon={paused ? <Play size={14} /> : <Pause size={14} />} disabled={!follow} onClick={togglePause} title="Congelar a visualização (o acompanhamento continua)">
              {paused ? 'Retomar' : 'Pausar'}
            </Button>
            <Switch checked={prefs.autoScroll} onChange={(v) => { setPref('autoScroll', v); if (v) toBottom(); }} label="Auto-rolagem" />
            <span className="grow" />
            <Button size="s" variant="ghost" icon={<RefreshCw size={14} className={loading ? 'spin' : ''} />} onClick={reload} title="Recarregar" />
            <Button size="s" variant="ghost" icon={<Copy size={14} />} onClick={copy} disabled={!entries.length} title="Copiar linhas visíveis" />
            <Button size="s" variant="ghost" icon={<Download size={14} />} onClick={download} disabled={!entries.length} title="Salvar linhas visíveis em arquivo" />
            <Button size="s" variant="ghost" icon={<Eraser size={14} />} onClick={clearView} disabled={!lines.length} title="Limpar a visualização (não apaga o log)" />
          </div>
          <div className="row gap-s wrap">
            <div className={`logs-search ${reError ? 'bad' : ''}`}>
              <Search size={14} />
              <input
                ref={searchRef}
                className="input"
                value={query}
                placeholder={prefs.regex ? 'Expressão regular… (Ctrl+F)' : 'Buscar… (Ctrl+F)'}
                onChange={(e) => setQuery(e.target.value)}
                maxLength={MAX_QUERY}
                onKeyDown={onSearchKey}
                spellCheck={false}
              />
            </div>
            <div className="seg">
              <button className={prefs.searchMode === 'filter' ? 'active' : ''} onClick={() => setPref('searchMode', 'filter')} title="Mostrar só as linhas que correspondem">Filtrar</button>
              <button className={prefs.searchMode === 'highlight' ? 'active' : ''} onClick={() => setPref('searchMode', 'highlight')} title="Mostrar tudo, destacando as correspondências">Destacar</button>
            </div>
            <Switch checked={prefs.regex} onChange={(v) => setPref('regex', v)} label="Regex" />
            {reError ? <span className="small lt-bad">regex inválida: {reError}</span>
              : query ? <span className="small muted">{hits.toLocaleString('pt-BR')} {hits === 1 ? 'linha corresponde' : 'linhas correspondem'}</span> : null}
            <span className="grow" />
            <Switch checked={prefs.wrap} onChange={(v) => setPref('wrap', v)} label="Quebrar linhas" />
            <Switch checked={prefs.lineNumbers} onChange={(v) => setPref('lineNumbers', v)} label="Nº" />
            {isContainer && <Switch checked={prefs.timestamps} onChange={(v) => setPref('timestamps', v)} label="Timestamps" />}
          </div>
        </div>

        <ErrorBox error={error} onRetry={reload} />

        {/* viewer */}
        <div className="logs-viewport">
          {syslogOff ? (
            <Empty>O syslogd não está rodando neste sistema, então o logread não tem buffer para ler.</Empty>
          ) : showLoading ? (
            <Loading label="Lendo log…" />
          ) : lines.length === 0 ? (
            <Empty>{meta?.missing ? 'Fonte não encontrada' : streaming ? 'Aguardando novas linhas…' : 'Log vazio'}</Empty>
          ) : entries.length === 0 ? (
            <Empty>Nenhuma linha corresponde à busca</Empty>
          ) : (
            <pre
              ref={preRef}
              className={`pre logs-pre ${prefs.wrap ? '' : 'nowrap'}`}
              onScroll={onScroll}
            >
              {entries.length > rendered.length && (
                <div className="logs-capnote">… {(entries.length - rendered.length).toLocaleString('pt-BR')} linhas anteriores ocultas (mostrando as últimas {RENDER_CAP.toLocaleString('pt-BR')}; use a busca, copiar ou salvar para ver tudo)</div>
              )}
              {rendered.map((e) => <LogLine key={e.n} n={e.n} text={e.text} level={e.level} hit={e.hit} re={re} showLn={prefs.lineNumbers} />)}
            </pre>
          )}
          {!atBottom && lines.length > 0 && (
            <button className="logs-tobottom" onClick={toBottom}>
              <ArrowDownToLine size={14} /> Ir para o fim
            </button>
          )}
        </div>

        <div className="logs-status">
          <span>{lines.length.toLocaleString('pt-BR')} linhas carregadas</span>
          {matcher && <span>{entries.length.toLocaleString('pt-BR')} exibidas</span>}
          {levelCounts.err > 0 && <span className="lt-bad">{levelCounts.err} erros</span>}
          {levelCounts.warn > 0 && <span className="lt-warn">{levelCounts.warn} avisos</span>}
          {streaming && lines.length >= STREAM_MAX && <span className="muted">buffer cheio: mantendo as últimas {STREAM_MAX.toLocaleString('pt-BR')}</span>}
          <span className="grow" />
          {prefs.autoScroll && !atBottom && <span className="muted">auto-rolagem suspensa (rolado para cima)</span>}
        </div>
      </section>
    </div>
  );
}
