// One interactive SSH shell rendered with xterm.js. Owns the remote shell's lifecycle (open / exit / reopen).
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal, ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { echo, errMsg } from '../../api';

export type SessionState = 'idle' | 'opening' | 'open' | 'closed' | 'error';

export interface TermHandle {
  /** Type text into the shell (as if pasted/typed). Returns false if the session is not open. */
  send(text: string): boolean;
  focus(): void;
  clear(): void;
  reopen(): void;
  copySelection(): Promise<boolean>;
  paste(): Promise<void>;
}

export interface Hotkeys {
  newTab(): void;
  closeTab(): void;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function buildTheme(): ITheme {
  const red = cssVar('--bad', '#ef5a5a');
  const green = cssVar('--ok', '#3ecf8e');
  const yellow = cssVar('--warn', '#f5b041');
  const blue = cssVar('--accent', '#5b9cff');
  return {
    background: '#0b0d11',
    foreground: '#cfd5e1',
    cursor: blue,
    cursorAccent: '#0b0d11',
    selectionBackground: 'rgba(91, 156, 255, 0.35)',
    scrollbarSliderBackground: 'rgba(111, 119, 138, 0.35)',
    scrollbarSliderHoverBackground: 'rgba(111, 119, 138, 0.55)',
    scrollbarSliderActiveBackground: 'rgba(111, 119, 138, 0.7)',
    black: cssVar('--panel', '#1a1e27'),
    red,
    green,
    yellow,
    blue,
    magenta: '#b48cff',
    cyan: '#4fd1d9',
    white: '#cfd5e1',
    brightBlack: cssVar('--muted', '#6f778a'),
    brightRed: '#ff7b7b',
    brightGreen: '#62e0a6',
    brightYellow: '#ffc861',
    brightBlue: '#7fb3ff',
    brightMagenta: '#c9a8ff',
    brightCyan: '#7ae3ea',
    brightWhite: cssVar('--text', '#e6e9ef'),
  };
}

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
// Leave the alternate screen, show the cursor, soft-reset modes — so a shell that died inside vim/top
// does not leave the terminal in a weird state.
const RESET_MODES = '\x1b[?1049l\x1b[?25h\x1b[!p';

interface Props {
  connected: boolean;
  /** This tab is the selected one AND the page/mode is shown. */
  shown: boolean;
  onState(state: SessionState, info?: { code?: number | null; error?: string }): void;
  hotkeys: Hotkeys;
  onCopied?(): void;
}

const TermView = forwardRef<TermHandle, Props>(function TermView({ connected, shown, onState, hotkeys, onCopied }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const shellId = useRef<string | null>(null);
  const stateRef = useRef<SessionState>('idle');
  const disposed = useRef(false);
  const everOpened = useRef(false);
  // Latest props for use inside long-lived callbacks.
  const live = useRef({ connected, shown, onState, hotkeys, onCopied });
  live.current = { connected, shown, onState, hotkeys, onCopied };

  const setState = useCallback((s: SessionState, info?: { code?: number | null; error?: string }) => {
    stateRef.current = s;
    live.current.onState(s, info);
  }, []);

  const fit = useCallback(() => {
    const host = hostRef.current;
    const fitAddon = fitRef.current;
    if (!host || !fitAddon || host.offsetWidth === 0 || host.offsetHeight === 0) return;
    try {
      fitAddon.fit();
    } catch { /* not rendered yet */ }
  }, []);

  const markClosed = useCallback((code: number | null, reason?: string) => {
    if (stateRef.current !== 'open' && stateRef.current !== 'opening') return;
    shellId.current = null;
    const term = termRef.current;
    if (term) {
      const tail = reason ?? (code == null ? 'conexão perdida' : `código ${code}`);
      term.write(`${RESET_MODES}\r\n${YELLOW('[sessão encerrada]')} ${DIM(`(${tail}) — Enter para reabrir`)}\r\n`);
    }
    setState('closed', { code });
  }, [setState]);

  const openShell = useCallback(async () => {
    const term = termRef.current;
    if (!term || disposed.current) return;
    if (stateRef.current === 'open' || stateRef.current === 'opening') return;
    if (!live.current.connected) {
      setState('closed');
      return;
    }
    if (everOpened.current) term.write(`${RESET_MODES}\r\n${DIM('— reabrindo sessão —')}\r\n`);
    setState('opening');
    fit();
    try {
      const id = await echo.shell.open({ cols: term.cols, rows: term.rows });
      if (disposed.current) {
        echo.shell.close(id).catch(() => {});
        return;
      }
      shellId.current = id;
      everOpened.current = true;
      setState('open');
      // Flush output that arrived before we knew our id.
      const early = pending.current.filter((p) => p.id === id);
      pending.current = [];
      for (const p of early) term.write(p.data);
      if (earlyExit.current.has(id)) {
        earlyExit.current.clear();
        markClosed(null);
        return;
      }
      earlyExit.current.clear();
      // The size may have changed while opening.
      echo.shell.resize(id, term.cols, term.rows).catch(() => {});
      if (live.current.shown) term.focus();
    } catch (e) {
      pending.current = [];
      earlyExit.current.clear();
      term.write(`\r\n\x1b[31m[erro ao abrir sessão: ${errMsg(e)}]\x1b[0m ${DIM('— Enter para tentar de novo')}\r\n`);
      setState('error', { error: errMsg(e) });
    }
  }, [fit, markClosed, setState]);

  // Data/exit events that arrive while shell.open() is still pending (id unknown yet).
  const pending = useRef<{ id: string; data: string }[]>([]);
  const earlyExit = useRef<Set<string>>(new Set());

  // Create the terminal once.
  useEffect(() => {
    disposed.current = false;
    const host = hostRef.current!;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      lineHeight: 1.1,
      scrollback: 10000,
      cursorBlink: true,
      allowProposedApi: false,
      macOptionIsMeta: true,
      theme: buildTheme(),
      linkHandler: {
        activate: (_e, uri) => { echo.app.openExternal(uri); },
        allowNonHttpProtocols: false,
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon((e, uri) => {
      e.preventDefault();
      echo.app.openExternal(uri);
    }));
    term.open(host);
    termRef.current = term;
    fitRef.current = fitAddon;

    term.attachCustomKeyEventHandler((e) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
      const k = e.key.toLowerCase();
      if (!['c', 'v', 't', 'w'].includes(k)) return true;
      if (e.type === 'keydown') {
        e.preventDefault();
        if (k === 'c') handle.copySelection();
        else if (k === 'v') handle.paste();
        else if (k === 't') live.current.hotkeys.newTab();
        else if (k === 'w') live.current.hotkeys.closeTab();
      }
      return false;
    });

    const offInput = term.onData((data) => {
      const id = shellId.current;
      if (id && stateRef.current === 'open') {
        echo.shell.write(id, data).catch(() => {});
      } else if ((stateRef.current === 'closed' || stateRef.current === 'error') && data === '\r') {
        openShell();
      }
    });
    const offResize = term.onResize(({ cols, rows }) => {
      const id = shellId.current;
      if (id && stateRef.current === 'open') echo.shell.resize(id, cols, rows).catch(() => {});
    });

    const offData = echo.shell.onData(({ id, data }) => {
      if (id === shellId.current) term.write(data);
      else if (stateRef.current === 'opening') pending.current.push({ id, data });
    });
    const offExit = echo.shell.onExit(({ id, code }) => {
      if (id === shellId.current) markClosed(code);
      else if (stateRef.current === 'opening') earlyExit.current.add(id);
    });

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    });
    ro.observe(host);
    // Web fonts may load after the first measurement.
    document.fonts?.ready.then(() => { if (!disposed.current) fit(); });

    fit();
    openShell();

    return () => {
      disposed.current = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      offData();
      offExit();
      offInput.dispose();
      offResize.dispose();
      if (shellId.current) echo.shell.close(shellId.current).catch(() => {});
      shellId.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Connection dropped → the session is gone (ssh.js also emits shell-exit, this is a safety net).
  // Connection came back and this tab never got a shell → open it now.
  useEffect(() => {
    if (!connected) {
      if (stateRef.current === 'open' || stateRef.current === 'opening') markClosed(null, 'conexão SSH caiu');
      else if (stateRef.current === 'idle') setState('closed');
    } else if (!everOpened.current && stateRef.current !== 'opening' && stateRef.current !== 'open') {
      openShell();
    }
  }, [connected, markClosed, openShell, setState]);

  // Became visible → re-fit (it may have been resized while display:none) and focus.
  useEffect(() => {
    if (!shown) return;
    const raf = requestAnimationFrame(() => {
      fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [shown, fit]);

  const handle: TermHandle = {
    send(text) {
      const id = shellId.current;
      if (!id || stateRef.current !== 'open') return false;
      echo.shell.write(id, text).catch(() => {});
      termRef.current?.focus();
      return true;
    },
    focus() { termRef.current?.focus(); },
    clear() { termRef.current?.clear(); termRef.current?.focus(); },
    reopen() { openShell(); },
    async copySelection() {
      const term = termRef.current;
      if (!term || !term.hasSelection()) return false;
      await navigator.clipboard.writeText(term.getSelection());
      live.current.onCopied?.();
      return true;
    },
    async paste() {
      const term = termRef.current;
      if (!term) return;
      try {
        const text = await navigator.clipboard.readText();
        if (text) term.paste(text); // goes through onData, honours bracketed paste
      } catch { /* clipboard unavailable */ }
      term.focus();
    },
  };
  useImperativeHandle(ref, () => handle);

  return <div ref={hostRef} className="tp-xterm" />;
});

export default TermView;
