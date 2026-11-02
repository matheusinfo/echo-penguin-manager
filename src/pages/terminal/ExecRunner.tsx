// "Executar comando": one-shot runner over echo.exec with persisted history.
import { KeyboardEvent, useMemo, useRef, useState } from 'react';
import { Play, Copy, Download, BookmarkPlus, Trash2, History, Eraser, Check } from 'lucide-react';
import { echo, errMsg, ExecResult } from '../../api';
import { useApp, useStored } from '../../hooks';
import { Badge, Button, Card, Empty, Field, Pre, SearchInput } from '../../components/ui';
import { confirmIfDangerous, destructiveReasons, looksSecret } from './common';

interface HistEntry { cmd: string; at: number; code?: number | null; ms?: number }

const MAX_HISTORY = 100;

function normalize(h: unknown): HistEntry[] {
  if (!Array.isArray(h)) return [];
  return h
    .map((e) => (typeof e === 'string' ? { cmd: e, at: 0 } : e))
    .filter((e): e is HistEntry => !!e && typeof e.cmd === 'string' && !looksSecret(e.cmd));
}

/** Persisted history never keeps commands that carry a password/token (they would sit in plain text on disk). */
function pushHistory(prev: unknown, entry: HistEntry): HistEntry[] {
  const rest = normalize(prev).filter((h) => h.cmd !== entry.cmd);
  return (looksSecret(entry.cmd) ? rest : [entry, ...rest]).slice(0, MAX_HISTORY);
}

function fmtMs(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

function fmtWhen(at: number) {
  if (!at) return '';
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
}

export default function ExecRunner({ onSaveSnippet }: { onSaveSnippet(command: string): void }) {
  const { connected, toast, confirm } = useApp();
  const [cmd, setCmd] = useState('');
  const [timeoutS, setTimeoutS] = useState('30');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<(ExecResult & { cmd: string; at: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawHistory, setHistory] = useStored<HistEntry[]>('cmdHistory', []);
  const [histFilter, setHistFilter] = useState('');
  const [copied, setCopied] = useState(false);
  const history = useMemo(() => normalize(rawHistory), [rawHistory]);
  // Position while browsing history with ↑/↓ (-1 = editing a fresh command).
  const histPos = useRef(-1);
  const draft = useRef('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const warn = cmd.trim() ? destructiveReasons(cmd) : [];

  const execute = async () => {
    const command = cmd.trim();
    if (!command || running || !connected) return;
    if (!(await confirmIfDangerous(confirm, command))) return;
    const t = Math.max(1, Math.min(3600, Number(timeoutS) || 30));
    setRunning(true);
    setError(null);
    histPos.current = -1;
    const at = Date.now();
    if (looksSecret(command)) toast('O comando parece conter uma senha/token: ele não será salvo no histórico');
    try {
      const r = await echo.exec(command, { timeout: t * 1000 });
      setResult({ ...r, cmd: command, at });
      setHistory((prev) => pushHistory(prev, { cmd: command, at, code: r.code, ms: r.durationMs }));
    } catch (e) {
      setResult(null);
      setError(errMsg(e));
      setHistory((prev) => pushHistory(prev, { cmd: command, at, code: null }));
    } finally {
      setRunning(false);
    }
  };

  const reuse = (c: string) => {
    setCmd(c);
    histPos.current = -1;
    taRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      execute();
      return;
    }
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.shiftKey || !history.length) return;
    const ta = e.currentTarget;
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    // Only navigate history when the caret is on the first (↑) / last (↓) line.
    if (e.key === 'ArrowUp' && before.includes('\n')) return;
    if (e.key === 'ArrowDown' && after.includes('\n')) return;
    if (e.key === 'ArrowDown' && histPos.current < 0) return;
    e.preventDefault();
    if (histPos.current < 0) draft.current = cmd;
    const next = e.key === 'ArrowUp' ? Math.min(histPos.current + 1, history.length - 1) : histPos.current - 1;
    histPos.current = next;
    const value = next < 0 ? draft.current : history[next].cmd;
    setCmd(value);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (el) el.selectionStart = el.selectionEnd = value.length;
    });
  };

  const outputText = () => {
    if (!result) return '';
    const { stdout, stderr } = result;
    if (!stderr) return stdout;
    return stdout + (stdout && !stdout.endsWith('\n') ? '\n' : '') + stderr;
  };

  const copyOut = async () => {
    await navigator.clipboard.writeText(outputText());
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const download = async () => {
    if (!result) return;
    const stamp = new Date(result.at).toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const content = [
      `# comando: ${result.cmd}`,
      `# data: ${new Date(result.at).toLocaleString()}`,
      `# código de saída: ${result.code ?? '—'}${result.signal ? ` (sinal ${result.signal})` : ''} · duração: ${fmtMs(result.durationMs)}`,
      '',
      '## stdout',
      result.stdout,
      ...(result.stderr ? ['', '## stderr', result.stderr] : []),
    ].join('\n');
    try {
      const p = await echo.app.saveText(`echo-comando-${stamp}.txt`, content);
      if (p) toast(`Salvo em ${p}`, 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const clearHistory = async () => {
    if (!history.length) return;
    if (await confirm({ title: 'Limpar histórico', message: `Apagar os ${history.length} comandos do histórico?`, confirmLabel: 'Apagar', danger: true })) {
      setHistory([]);
      histPos.current = -1;
    }
  };

  const hq = histFilter.trim().toLowerCase();
  const shownHistory = hq ? history.filter((h) => h.cmd.toLowerCase().includes(hq)) : history;

  const codeTone = (code: number | null | undefined) => (code === 0 ? 'ok' : code == null ? 'warn' : 'bad');

  return (
    <div className="tp-exec">
      <div className="tp-exec-main">
        <Card pad>
          <div className="col gap-m">
            <Field label="Comando" hint="Ctrl+Enter executa · ↑/↓ navega pelo histórico · roda em sh (busybox), sem TTY">
              <textarea
                ref={taRef}
                className="input tp-exec-input"
                rows={4}
                spellCheck={false}
                value={cmd}
                placeholder="ex.: docker ps -a"
                onChange={(e) => { setCmd(e.target.value); histPos.current = -1; }}
                onKeyDown={onKey}
              />
            </Field>
            {warn.length > 0 && (
              <div className="tp-warn small">Atenção: {warn.join('; ')}. Será pedida confirmação.</div>
            )}
            <div className="row gap-s wrap">
              <Button variant="primary" icon={<Play size={14} />} busy={running} disabled={!connected || !cmd.trim()} onClick={execute}>Executar</Button>
              <label className="row gap-s small muted">
                Tempo limite
                <input className="input tp-timeout" type="number" min={1} max={3600} value={timeoutS} onChange={(e) => setTimeoutS(e.target.value)} />
                s
              </label>
              <div className="grow" />
              <Button size="s" icon={<BookmarkPlus size={14} />} disabled={!cmd.trim()} onClick={() => onSaveSnippet(cmd.trim())}>Salvar como snippet</Button>
              <Button size="s" variant="ghost" icon={<Eraser size={14} />} disabled={!cmd && !result && !error} onClick={() => { setCmd(''); setResult(null); setError(null); histPos.current = -1; }}>Limpar</Button>
            </div>
            {!connected && <div className="muted small">Sem conexão com o Echo. Conecte-se pela barra lateral.</div>}
          </div>
        </Card>

        {error && <div className="errorbox">{error}</div>}

        {result && (
          <Card
            title={<span className="row gap-s">
              Resultado
              <Badge tone={codeTone(result.code)} title="Código de saída">
                {result.code === 124 && result.stderr.includes('tempo esgotado') ? 'tempo esgotado' : `saída ${result.code ?? '—'}`}
              </Badge>
              {result.signal && <Badge tone="warn">sinal {result.signal}</Badge>}
              <span className="muted small">{fmtMs(result.durationMs)}</span>
            </span>}
            actions={<>
              <Button size="s" variant="ghost" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={copyOut} title="Copiar saída">Copiar</Button>
              <Button size="s" variant="ghost" icon={<Download size={14} />} onClick={download} title="Salvar saída em arquivo">Baixar</Button>
            </>}
          >
            <div className="col gap-s">
              <code className="muted small ellipsis" title={result.cmd}>$ {result.cmd}</code>
              {result.stdout
                ? <Pre maxHeight="50vh">{result.stdout}</Pre>
                : <div className="muted small">(sem saída em stdout)</div>}
              {result.stderr && (
                <>
                  <div className="small tp-stderr-label">stderr</div>
                  <Pre maxHeight="30vh" className="tp-stderr">{result.stderr}</Pre>
                </>
              )}
            </div>
          </Card>
        )}
      </div>

      <Card
        className="tp-history"
        title="Histórico"
        icon={<History size={15} />}
        actions={<Button size="s" variant="ghost" icon={<Trash2 size={13} />} title="Limpar histórico" disabled={!history.length} onClick={clearHistory} />}
        pad={false}
      >
        <div className="tp-history-filter"><SearchInput value={histFilter} onChange={setHistFilter} placeholder="Filtrar histórico…" /></div>
        <div className="tp-history-list">
          {shownHistory.length === 0 && <Empty>{hq ? 'Nada encontrado' : 'Nenhum comando ainda'}</Empty>}
          {shownHistory.map((h, i) => (
            <button key={`${h.at}-${i}`} className="tp-history-item" onClick={() => reuse(h.cmd)} title="Clique para reutilizar">
              <code className="tp-history-cmd">{h.cmd}</code>
              <span className="row gap-s small muted">
                {h.code !== undefined && <Badge tone={codeTone(h.code)}>{h.code ?? 'erro'}</Badge>}
                {h.ms != null && <span>{fmtMs(h.ms)}</span>}
                <span className="grow" />
                <span>{fmtWhen(h.at)}</span>
              </span>
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}
