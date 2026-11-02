// Terminal SSH: interactive shells in tabs (xterm.js), quick-command snippets and a one-shot command runner.
// The page stays mounted (hidden) while other pages are shown, so shells survive page switches.
import { useCallback, useEffect, useRef, useState, KeyboardEvent } from 'react';
import { Plus, X, Copy, ClipboardPaste, Eraser, RotateCw, PanelRightOpen, TerminalSquare, Play } from 'lucide-react';
import { useApp, useStored } from '../hooks';
import { Page, Tabs, Button, Dot } from '../components/ui';
import TermView, { SessionState, TermHandle } from './terminal/TermView';
import SnippetPanel from './terminal/SnippetPanel';
import ExecRunner from './terminal/ExecRunner';
import { DEFAULT_SNIPPETS, Snippet, SnippetEditor, confirmIfDangerous } from './terminal/common';
import './Terminal.css';

interface Session {
  key: string;
  name: string;
  state: SessionState;
  code?: number | null;
}

type Mode = 'terminal' | 'exec';

const STATE_TONE: Record<SessionState, 'ok' | 'warn' | 'bad' | 'muted'> = {
  open: 'ok', opening: 'warn', idle: 'muted', closed: 'muted', error: 'bad',
};
const STATE_LABEL: Record<SessionState, string> = {
  open: 'aberta', opening: 'abrindo…', idle: 'aguardando', closed: 'encerrada', error: 'erro',
};

let sessionSeq = 0;
const makeSession = (): Session => {
  sessionSeq += 1;
  return { key: `s${sessionSeq}-${Date.now().toString(36)}`, name: `Sessão ${sessionSeq}`, state: 'idle' };
};

export default function TerminalPage({ visible }: { visible: boolean }) {
  const { connected, toast, confirm } = useApp();
  const [mode, setMode] = useState<Mode>('terminal');
  const [sessions, setSessions] = useState<Session[]>(() => [makeSession()]);
  const [activeKey, setActiveKey] = useState<string>(() => sessions[0].key);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [snippets, setSnippets] = useStored<Snippet[]>('snippets', DEFAULT_SNIPPETS);
  const [panelOpen, setPanelOpen] = useStored<boolean>('terminalSnippetsPanel', true);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const handles = useRef(new Map<string, TermHandle>());

  const active = sessions.find((s) => s.key === activeKey) ?? sessions[0];
  const termShown = visible && mode === 'terminal';
  const activeHandle = () => (active ? handles.current.get(active.key) : undefined);

  // ---- sessions -------------------------------------------------------------------------------
  const addSession = useCallback(() => {
    const s = makeSession();
    setSessions((prev) => [...prev, s]);
    setActiveKey(s.key);
    setMode('terminal');
  }, []);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const closeSession = useCallback((key: string) => {
    const prev = sessionsRef.current;
    const idx = prev.findIndex((s) => s.key === key);
    if (idx < 0) return;
    const next = prev.filter((s) => s.key !== key);
    sessionsRef.current = next;
    setSessions(next);
    setActiveKey((cur) => (cur === key ? (next[Math.min(idx, next.length - 1)]?.key ?? '') : cur));
    handles.current.delete(key);
  }, []);

  const setSessionState = useCallback((key: string, state: SessionState, info?: { code?: number | null }) => {
    setSessions((prev) => prev.map((s) => (s.key === key ? { ...s, state, code: info?.code } : s)));
  }, []);

  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const hotkeys = useRef({
    newTab: () => addSession(),
    closeTab: () => closeSession(activeKeyRef.current),
  }).current;

  const startRename = (s: Session) => {
    setRenaming(s.key);
    setRenameText(s.name);
  };
  const commitRename = () => {
    const name = renameText.trim();
    if (renaming && name) setSessions((prev) => prev.map((s) => (s.key === renaming ? { ...s, name } : s)));
    setRenaming(null);
    requestAnimationFrame(() => activeHandle()?.focus());
  };
  const renameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitRename();
    else if (e.key === 'Escape') setRenaming(null);
  };

  // Re-focus the active terminal when switching tabs.
  useEffect(() => {
    if (!termShown) return;
    const raf = requestAnimationFrame(() => handles.current.get(activeKey)?.focus());
    return () => cancelAnimationFrame(raf);
  }, [activeKey, termShown]);

  // ---- snippets -------------------------------------------------------------------------------
  const runSnippet = async (s: Snippet, execute: boolean) => {
    const h = activeHandle();
    if (!h || active?.state !== 'open') {
      toast('Nenhuma sessão aberta para receber o comando', 'error');
      return;
    }
    // "Inserir" of a multi-line snippet still runs every line but the last (each newline is an Enter for the
    // shell), so it gets the same confirmation as executing it.
    const multiLine = /\r?\n/.test(s.command.trim());
    if ((execute || multiLine) && !(await confirmIfDangerous(confirm, s.command, !!s.danger))) return;
    if (!execute && multiLine && !(await confirm({
      title: 'Inserir comando de várias linhas',
      message: `Ao inserir, o terminal executa imediatamente todas as linhas menos a última:\n\n${s.command.length > 400 ? s.command.slice(0, 400) + '…' : s.command}\n\nContinuar?`,
      confirmLabel: 'Inserir',
    }))) return;
    const text = s.command.replace(/\r?\n/g, '\r');
    if (!h.send(execute ? `${text}\r` : text)) toast('A sessão não está aberta', 'error');
  };

  const saveSnippet = (s: Snippet) => {
    setSnippets((prev) => (prev.some((p) => p.id === s.id) ? prev.map((p) => (p.id === s.id ? s : p)) : [...prev, s]));
    setEditing(null);
    toast(`Comando "${s.name}" salvo`, 'ok');
  };

  const deleteSnippet = async (s: Snippet) => {
    if (!(await confirm({ title: 'Excluir comando rápido', message: `Excluir "${s.name}"?\n\n${s.command}`, confirmLabel: 'Excluir', danger: true }))) return;
    setSnippets((prev) => prev.filter((p) => p.id !== s.id));
  };

  const restoreDefaults = () => {
    const missing = DEFAULT_SNIPPETS.filter((d) => !snippets.some((s) => s.id === d.id));
    if (!missing.length) {
      toast('Todos os comandos padrão já estão na lista');
      return;
    }
    setSnippets((prev) => [...prev, ...missing.filter((d) => !prev.some((s) => s.id === d.id))]);
    toast(`${missing.length} comando(s) padrão restaurado(s)`, 'ok');
  };

  const openCount = sessions.filter((s) => s.state === 'open').length;
  const activeClosed = !!active && (active.state === 'closed' || active.state === 'error');

  return (
    <div className="tp-root">
      <Page
        title="Terminal SSH"
        subtitle={connected
          ? `${openCount} sessão(ões) aberta(s) · Ctrl+Shift+C/V copia/cola · Ctrl+Shift+T nova aba`
          : 'Sem conexão com o Echo — conecte-se pela barra lateral'}
      >
        <Tabs<Mode>
          tabs={[
            { id: 'terminal', label: <span className="row gap-s"><TerminalSquare size={14} />Terminal</span> },
            { id: 'exec', label: <span className="row gap-s"><Play size={14} />Executar comando</span> },
          ]}
          value={mode}
          onChange={setMode}
        />

        <div className="tp-mode" style={{ display: mode === 'terminal' ? 'flex' : 'none' }}>
          <div className="tp-term-col">
            <div className="tp-tabbar">
              {sessions.map((s) => (
                <div
                  key={s.key}
                  className={`tp-tab ${s.key === active?.key ? 'active' : ''}`}
                  onClick={() => setActiveKey(s.key)}
                  onAuxClick={(e) => { if (e.button === 1) closeSession(s.key); }}
                  title={`${s.name} — ${STATE_LABEL[s.state]} (duplo clique para renomear)`}
                >
                  <Dot tone={STATE_TONE[s.state]} />
                  {renaming === s.key ? (
                    <input
                      className="tp-tab-rename"
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={renameKey}
                      onBlur={commitRename}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="tp-tab-name" onDoubleClick={() => startRename(s)}>{s.name}</span>
                  )}
                  <button
                    className="tp-tab-close"
                    title="Fechar aba (Ctrl+Shift+W)"
                    onClick={(e) => { e.stopPropagation(); closeSession(s.key); }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button className="tp-tab-add" title="Nova sessão (Ctrl+Shift+T)" onClick={addSession}><Plus size={14} /></button>
              <div className="grow" />
              <div className="row tp-term-tools">
                <Button size="s" variant="ghost" icon={<Copy size={13} />} title="Copiar seleção (Ctrl+Shift+C)" disabled={!active}
                  onClick={async () => { if (!(await activeHandle()?.copySelection())) toast('Nada selecionado'); }} />
                <Button size="s" variant="ghost" icon={<ClipboardPaste size={13} />} title="Colar (Ctrl+Shift+V)" disabled={active?.state !== 'open'}
                  onClick={() => activeHandle()?.paste()} />
                <Button size="s" variant="ghost" icon={<Eraser size={13} />} title="Limpar tela" disabled={!active} onClick={() => activeHandle()?.clear()} />
                {!panelOpen && (
                  <Button size="s" variant="ghost" icon={<PanelRightOpen size={13} />} title="Mostrar comandos rápidos" onClick={() => setPanelOpen(true)} />
                )}
              </div>
            </div>

            <div className="term-host tp-host">
              {sessions.map((s) => (
                <div key={s.key} className="tp-session" style={{ display: s.key === active?.key ? 'block' : 'none' }}>
                  <TermView
                    ref={(h) => { if (h) handles.current.set(s.key, h); }}
                    connected={connected}
                    shown={termShown && s.key === active?.key}
                    onState={(state, info) => setSessionState(s.key, state, info)}
                    hotkeys={hotkeys}
                    onCopied={() => toast('Seleção copiada', 'ok')}
                  />
                </div>
              ))}
              {sessions.length === 0 && (
                <div className="tp-empty">
                  <span className="muted">Nenhuma sessão aberta.</span>
                  <Button variant="primary" icon={<Plus size={14} />} onClick={addSession}>Nova sessão</Button>
                </div>
              )}
              {activeClosed && (
                <div className="tp-closed-bar">
                  <span>
                    {active.state === 'error' ? 'Não foi possível abrir a sessão.' : '[sessão encerrada]'}
                    {active.state === 'closed' && active.code != null && <span className="muted"> código {active.code}</span>}
                    {!connected && <span className="muted"> · sem conexão com o Echo</span>}
                  </span>
                  <Button size="s" variant="primary" icon={<RotateCw size={13} />} disabled={!connected} onClick={() => activeHandle()?.reopen()}>
                    Reabrir
                  </Button>
                </div>
              )}
            </div>
          </div>

          {panelOpen && (
            <SnippetPanel
              snippets={snippets}
              canSend={active?.state === 'open'}
              onRun={runSnippet}
              onEdit={(s) => setEditing(s)}
              onDelete={deleteSnippet}
              onAdd={() => setEditing({ id: '', name: '', command: '' })}
              onRestore={restoreDefaults}
              onCollapse={() => setPanelOpen(false)}
            />
          )}
        </div>

        <div className="tp-mode tp-mode-exec" style={{ display: mode === 'exec' ? 'flex' : 'none' }}>
          <ExecRunner onSaveSnippet={(command) => setEditing({ id: '', name: '', command })} />
        </div>
      </Page>

      <SnippetEditor initial={editing} onSave={saveSnippet} onClose={() => setEditing(null)} />
    </div>
  );
}
