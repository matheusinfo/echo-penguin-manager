import { lazy, ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Cpu, Container, ScrollText, AlarmClock, Settings2, TerminalSquare, Plug, PlugZap, Pencil } from 'lucide-react';
import { echo, EchoConfig, errMsg, SshStatus } from './api';
import { AppContext, AppCtx, PageId } from './hooks';
import { Button, Dot, Loading, Modal } from './components/ui';
import ConnectionDialog from './components/ConnectionDialog';
// Each page is its own chunk: the app opens faster, and xterm.js only loads with the terminal.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const SystemPage = lazy(() => import('./pages/System'));
const DockerPage = lazy(() => import('./pages/Docker'));
const LogsPage = lazy(() => import('./pages/Logs'));
const DevicePage = lazy(() => import('./pages/Device'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const TerminalPage = lazy(() => import('./pages/Terminal'));

const NAV: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: 'dashboard', label: 'Visão geral', icon: <Activity size={17} /> },
  { id: 'system', label: 'Sistema', icon: <Cpu size={17} /> },
  { id: 'docker', label: 'Docker', icon: <Container size={17} /> },
  { id: 'logs', label: 'Logs', icon: <ScrollText size={17} /> },
  { id: 'device', label: 'Alarme & Tela', icon: <AlarmClock size={17} /> },
  { id: 'settings', label: 'Configurações', icon: <Settings2 size={17} /> },
  { id: 'terminal', label: 'Terminal SSH', icon: <TerminalSquare size={17} /> },
];

interface Toast { id: number; msg: string; kind: 'info' | 'ok' | 'error' }
interface ConfirmReq { title: string; message: string; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void }

export default function App() {
  const [status, setStatus] = useState<SshStatus>({ state: 'disconnected', error: null, host: null, connectedAt: null });
  const [config, setConfig] = useState<EchoConfig | null>(null);
  const [page, setPage] = useState<PageId>('dashboard');
  const [pageParams, setPageParams] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  const [connOpen, setConnOpen] = useState(false);
  // The terminal keeps its sessions alive while other pages are shown.
  const [terminalMounted, setTerminalMounted] = useState(false);
  const toastId = useRef(0);

  const [firstRun, setFirstRun] = useState(false);
  const reloadConfig = useCallback(async () => setConfig(await echo.config.get()), []);

  useEffect(() => {
    // No address yet (no "Host echo" in ~/.ssh/config): open the connection form right away.
    echo.config.get().then((c) => {
      setConfig(c);
      if (!c.host) {
        setFirstRun(true);
        setConnOpen(true);
      }
    });
    echo.ssh.status().then(setStatus);
    return echo.ssh.onStatus(setStatus);
  }, [reloadConfig]);

  const toast = useCallback((msg: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  const confirm = useCallback<AppCtx['confirm']>((opts) => new Promise((resolve) => setConfirmReq({ ...opts, resolve })), []);

  const navigate = useCallback((p: PageId, params: Record<string, string> = {}) => {
    setPage(p);
    setPageParams(params);
    if (p === 'terminal') setTerminalMounted(true);
  }, []);

  const connected = status.state === 'connected';
  const ctx: AppCtx = { status, config, connected, reloadConfig, toast, confirm, navigate, pageParams };

  const connect = async () => {
    try {
      await echo.ssh.connect();
      toast('Conectado ao Echo', 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const tone = connected ? 'ok' : status.state === 'connecting' ? 'warn' : status.state === 'error' ? 'bad' : 'muted';
  const stateLabel = { connected: 'Conectado', connecting: 'Conectando…', error: 'Erro', disconnected: 'Desconectado' }[status.state];

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <img className="brand-logo" src="./icon.png" alt="" />
            <div>
              <div className="brand-name">Echo Manager</div>
              <div className="brand-sub">echo-penguin · Echo Show 5</div>
            </div>
          </div>
          {NAV.map((n) => (
            <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => navigate(n.id)}>
              {n.icon}{n.label}
            </button>
          ))}
          <div className="nav-sep" />
          <div className="conn-box">
            <div className="row gap-s between">
              <div className="row gap-s"><Dot tone={tone} /><strong>{stateLabel}</strong></div>
              <Button size="s" variant="ghost" icon={<Pencil size={13} />} title="Editar conexão" onClick={() => setConnOpen(true)} />
            </div>
            <div className="muted mono ellipsis" title={config ? `${config.username}@${config.host}:${config.port}` : ''}>
              {config ? (config.host ? `${config.username}@${config.host}` : 'endereço não configurado') : '…'}
            </div>
            {status.error && status.state !== 'connected' && <div className="small" style={{ color: 'var(--bad)' }}>{status.error}</div>}
            {connected
              ? <Button size="s" icon={<PlugZap size={14} />} onClick={() => echo.ssh.disconnect()}>Desconectar</Button>
              : <Button size="s" variant="primary" icon={<Plug size={14} />} busy={status.state === 'connecting'} onClick={connect}>Conectar</Button>}
          </div>
        </aside>

        <main className="main">
          <Suspense fallback={<Loading />}>
            {page === 'dashboard' && <Dashboard />}
            {page === 'system' && <SystemPage />}
            {page === 'docker' && <DockerPage />}
            {page === 'logs' && <LogsPage />}
            {page === 'device' && <DevicePage />}
            {page === 'settings' && <SettingsPage />}
          </Suspense>
          {terminalMounted && (
            <Suspense fallback={page === 'terminal' ? <Loading /> : null}>
              <div style={{ display: page === 'terminal' ? 'contents' : 'none' }}><TerminalPage visible={page === 'terminal'} /></div>
            </Suspense>
          )}
        </main>
      </div>

      <ConnectionDialog open={connOpen} firstRun={firstRun} onClose={() => { setConnOpen(false); setFirstRun(false); }} />

      <Modal
        open={!!confirmReq}
        title={confirmReq?.title}
        onClose={() => { confirmReq?.resolve(false); setConfirmReq(null); }}
        footer={<>
          <Button onClick={() => { confirmReq?.resolve(false); setConfirmReq(null); }}>Cancelar</Button>
          <Button variant={confirmReq?.danger ? 'danger' : 'primary'} onClick={() => { confirmReq?.resolve(true); setConfirmReq(null); }}>
            {confirmReq?.confirmLabel ?? 'Confirmar'}
          </Button>
        </>}
      >
        <div style={{ whiteSpace: 'pre-wrap' }}>{confirmReq?.message}</div>
      </Modal>

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}
      </div>
    </AppContext.Provider>
  );
}
