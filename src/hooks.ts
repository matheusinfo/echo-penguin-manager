import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { echo, errMsg, EchoConfig, SshStatus } from './api';

/** App-wide connection + config context (provided by App.tsx). */
export interface AppCtx {
  status: SshStatus;
  config: EchoConfig | null;
  connected: boolean;
  reloadConfig(): Promise<void>;
  toast(msg: string, kind?: 'info' | 'ok' | 'error'): void;
  /** Promise-based confirm dialog. `danger` styles the confirm button red. */
  confirm(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  navigate(page: PageId, params?: Record<string, string>): void;
  pageParams: Record<string, string>;
}

export type PageId = 'dashboard' | 'system' | 'docker' | 'logs' | 'device' | 'settings' | 'terminal';

export const AppContext = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(AppContext);

/**
 * Run an async loader, optionally polling every `intervalMs` while connected.
 * Returns { data, error, loading, refresh, lastUpdated }.
 * The loader is skipped while disconnected. Polling pauses when the window is hidden.
 */
export function usePoll<T>(loader: () => Promise<T>, intervalMs: number | null, deps: unknown[] = []) {
  const { connected } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const inflight = useRef(false);
  const again = useRef(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  // Never two loads at once (the Echo is slow); a refresh asked for meanwhile runs right after.
  const refresh = useCallback(async () => {
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    setLoading(true);
    try {
      do {
        again.current = false;
        try {
          const d = await loaderRef.current();
          setData(d);
          setError(null);
          setLastUpdated(Date.now());
        } catch (e) {
          setError(errMsg(e));
        }
      } while (again.current);
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    refresh();
    if (!intervalMs) return;
    const t = setInterval(() => {
      if (!document.hidden) refresh();
    }, intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, intervalMs, refresh, ...deps]);

  return { data, error, loading, refresh, lastUpdated, setData };
}

/**
 * Follow a long-running command (tail -f, docker logs -f). Returns lines and controls.
 * Keeps at most `maxLines` lines. `exitCode` is set when the command ends on its own.
 */
export function useStream(maxLines = 5000) {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  // Lines dropped from the front to respect maxLines: lines[i] is line number dropped + i of the stream.
  const [dropped, setDropped] = useState(0);
  const droppedRef = useRef(0);
  const idRef = useRef<string | null>(null);
  const partial = useRef('');
  // Events can arrive before stream.start() resolves with the id: keep them until the id is known.
  const starting = useRef(false);
  const early = useRef<({ kind: 'data'; id: string; data: string } | { kind: 'end'; id: string; code: number | null })[]>([]);

  const handleData = useCallback((data: string) => {
    const text = partial.current + data;
    const parts = text.split('\n');
    partial.current = parts.pop() ?? '';
    if (parts.length) setLines((prev) => {
      const next = prev.concat(parts);
      if (next.length <= maxLines) return next;
      const cut = next.length - maxLines;
      droppedRef.current += cut;
      setDropped(droppedRef.current);
      return next.slice(cut);
    });
  }, [maxLines]);

  const handleEnd = useCallback((code: number | null) => {
    if (partial.current) {
      const rest = partial.current;
      setLines((prev) => prev.concat(rest));
      partial.current = '';
    }
    idRef.current = null;
    setExitCode(code);
    setRunning(false);
  }, []);

  useEffect(() => {
    const offData = echo.stream.onData(({ id, data }) => {
      if (id === idRef.current) handleData(data);
      else if (starting.current) early.current.push({ kind: 'data', id, data });
    });
    const offEnd = echo.stream.onEnd(({ id, code }) => {
      if (id === idRef.current) handleEnd(code);
      else if (starting.current) early.current.push({ kind: 'end', id, code });
    });
    return () => {
      offData();
      offEnd();
      if (idRef.current) echo.stream.stop(idRef.current);
    };
  }, [handleData, handleEnd]);

  const start = useCallback(async (command: string, clear = true) => {
    if (idRef.current) await echo.stream.stop(idRef.current);
    idRef.current = null;
    if (clear) {
      setLines([]);
      droppedRef.current = 0;
      setDropped(0);
    }
    partial.current = '';
    setExitCode(null);
    starting.current = true;
    early.current = [];
    setRunning(true);
    try {
      const id = await echo.stream.start(command);
      idRef.current = id;
      const buffered = early.current.filter((e) => e.id === id);
      early.current = [];
      for (const e of buffered) {
        if (e.kind === 'data') handleData(e.data);
        else handleEnd(e.code);
      }
    } catch (e) {
      setRunning(false);
      throw e;
    } finally {
      starting.current = false;
    }
  }, [handleData, handleEnd]);

  const stop = useCallback(async () => {
    if (idRef.current) await echo.stream.stop(idRef.current);
    idRef.current = null;
    setRunning(false);
  }, []);

  return { lines, setLines, running, exitCode, dropped, start, stop };
}

/** Persisted local value (userData/<name>.json). */
export function useStored<T>(name: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    echo.store.get<T>(name, initial).then((v) => {
      setValue(v ?? initial);
      setReady(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  const update = useCallback((v: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      echo.store.set(name, next);
      return next;
    });
  }, [name]);
  return [value, update, ready] as const;
}

/** Wrap an async action with busy state + toast on error/success. */
export function useAction() {
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const act = useCallback(async (key: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (okMsg) toast(okMsg, 'ok');
      return true;
    } catch (e) {
      toast(errMsg(e), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return { busy, act };
}
