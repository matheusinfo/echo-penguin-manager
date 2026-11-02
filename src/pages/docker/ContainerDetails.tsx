// Wide modal with everything about one container: inspect summary, logs (follow), one-shot exec, raw JSON.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { FormEvent, memo, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Download, Play, SquareTerminal, Trash, Pause } from 'lucide-react';
import { echo, errMsg, fmtBytes, run, shq } from '../../api';
import { useApp, useStored, useStream } from '../../hooks';
import { Badge, Button, Card, Empty, ErrorBox, Grid, KV, Loading, Modal, Pre, RefreshButton, SearchInput, Switch, Tabs } from '../../components/ui';
import { ContainerRow, CopyButton, fmtAgo, fmtDate, HealthBadge, Highlight, logTone, maskArgv, maskSecrets, parseDockerDate, StatRow, StateBadge, str } from './common';
import { LifecycleButtons, useContainerActions } from './actions';
import type { DetailTab } from './Containers';

const MASK = '••••••••';

export default function ContainerDetails({ name, tab, onTab, row, stat, onClose, onChanged }: {
  name: string | null;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  row: ContainerRow | undefined;
  stat: StatRow | undefined;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState<number | null>(null);
  const [reveal, setReveal] = useState(false);

  const load = async () => {
    if (!name) return;
    setLoading(true);
    try {
      const out = await run(`docker inspect ${shq(name)}`, { timeout: 20000 });
      const arr = JSON.parse(out);
      setData(Array.isArray(arr) ? arr[0] ?? null : arr);
      setError(null);
      setUpdated(Date.now());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setData(null);
    setError(null);
    setReveal(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const { busy, doAction } = useContainerActions(() => { onChanged(); load(); });

  const state = str(data?.State?.Status) || row?.state || '';
  const target = { name: name ?? '', state, project: row?.project };
  const running = state === 'running';

  return (
    <Modal open={!!name} wide onClose={onClose}
      title={<span className="row gap-s">{name} {state && <StateBadge state={state} status={row?.status} />}{row?.health && <HealthBadge health={row.health} />}</span>}>
      <div className="row gap-s between wrap">
        <Tabs<DetailTab>
          value={tab}
          onChange={onTab}
          tabs={[
            { id: 'resumo', label: 'Resumo' },
            { id: 'logs', label: 'Logs' },
            { id: 'exec', label: 'Executar' },
            { id: 'json', label: 'Inspect (JSON)' },
          ]}
        />
        <div className="row gap-s">
          <LifecycleButtons c={target} busy={busy} labels onAction={async (a) => {
            const ok = await doAction(target, a);
            if (ok && a === 'rm') onClose();
          }} />
          <Button size="s" variant="ghost" icon={reveal ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => setReveal(!reveal)}
            title="Mostrar/ocultar valores de variáveis de ambiente e tokens">{reveal ? 'Ocultar segredos' : 'Mostrar segredos'}</Button>
          <RefreshButton onClick={load} loading={loading} lastUpdated={updated} />
        </div>
      </div>
      <ErrorBox error={error} onRetry={load} />
      {tab === 'resumo' && (data ? <Summary d={data} reveal={reveal} stat={running ? stat : undefined} /> : loading ? <Loading /> : null)}
      {tab === 'logs' && name && <LogsView name={name} />}
      {tab === 'exec' && name && <ExecView name={name} running={running} />}
      {tab === 'json' && (data ? <RawJson d={data} reveal={reveal} /> : loading ? <Loading /> : null)}
    </Modal>
  );
}

// ---------------------------------------------------------------- summary

const nsToS = (n: unknown) => (typeof n === 'number' && n > 0 ? `${n / 1e9}s` : '—');
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

function Summary({ d, reveal, stat }: { d: any; reveal: boolean; stat?: StatRow }) {
  const [shown, setShown] = useState<Set<string>>(new Set());
  const st = obj(d.State);
  const hc = obj(d.HostConfig);
  const cfg = obj(d.Config);
  const labels = obj(cfg.Labels);
  const started = parseDockerDate(st.StartedAt);
  const finished = parseDockerDate(st.FinishedAt);
  const cmd = [...arr(cfg.Entrypoint), ...arr(cfg.Cmd)].map(str).join(' ') || [str(d.Path), ...arr(d.Args).map(str)].join(' ');
  const rp = obj(hc.RestartPolicy);
  const env = arr(cfg.Env).map((e) => {
    const s = str(e);
    const i = s.indexOf('=');
    return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
  });
  const mounts = arr(d.Mounts);
  const nets = Object.entries(obj(d.NetworkSettings?.Networks));
  const ports = Object.entries(obj(d.NetworkSettings?.Ports));
  const health = obj(st.Health);
  const hlog = arr(health.Log).slice(-5).reverse();
  const hcfg = obj(cfg.Healthcheck);
  const logCfg = obj(hc.LogConfig);

  const toggle = (k: string) => setShown((prev) => {
    const n = new Set(prev);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  return (
    <div className="col gap-m">
      <Grid cols={2}>
        <Card title="Geral">
          <KV items={[
            ['ID', <span className="mono small">{str(d.Id).slice(0, 12)}</span>],
            ['Imagem', <span className="mono small">{str(cfg.Image)}</span>],
            ['Comando', <span className="mono small">{reveal ? cmd : maskSecrets(cmd)}</span>],
            ['Criado', `${fmtDate(parseDockerDate(d.Created))} (${fmtAgo(parseDockerDate(d.Created))})`],
            ['Iniciado', started ? `${fmtDate(started)} (${fmtAgo(started)})` : '—'],
            ['Terminado', finished && !st.Running ? `${fmtDate(finished)} · código ${st.ExitCode}${st.OOMKilled ? ' · OOM' : ''}` : st.OOMKilled ? 'OOM' : '—'],
            ['Erro', st.Error ? <span style={{ color: 'var(--bad)' }}>{str(st.Error)}</span> : '—'],
            ['Usuário / dir.', `${str(cfg.User) || 'root'} · ${str(cfg.WorkingDir) || '/'}`],
          ]} />
        </Card>
        <Card title="Execução">
          <KV items={[
            ['Restart policy', <span>{str(rp.Name) || 'no'}{rp.MaximumRetryCount ? ` (máx. ${rp.MaximumRetryCount})` : ''} · reinícios: {str(d.RestartCount) || '0'}</span>],
            ['Limite de memória', hc.Memory ? fmtBytes(hc.Memory) : 'sem limite'],
            ['CPUs', hc.NanoCpus ? `${hc.NanoCpus / 1e9}` : hc.CpusetCpus ? `cpuset ${hc.CpusetCpus}` : 'sem limite'],
            ['Uso agora', stat ? `CPU ${stat.cpu?.toFixed(1) ?? '—'}% · mem ${fmtBytes(stat.mem)} (${stat.memPct?.toFixed(0) ?? '—'}%) · PIDs ${stat.pids}` : '—'],
            ['Rede (modo)', str(hc.NetworkMode) || '—'],
            ['Privilegiado', hc.Privileged ? <Badge tone="warn">sim</Badge> : 'não'],
            ['Logs', `${str(logCfg.Type) || '—'} ${Object.entries(obj(logCfg.Config)).map(([k, v]) => `${k}=${str(v)}`).join(' ')}`],
            ['Compose', labels['com.docker.compose.project']
              ? `${labels['com.docker.compose.project']} / ${labels['com.docker.compose.service'] ?? '?'} (${labels['com.docker.compose.project.config_files'] ?? ''})`
              : '—'],
          ]} />
        </Card>
      </Grid>

      {(hcfg.Test || health.Status) && (
        <Card title={<span className="row gap-s">Healthcheck {health.Status && <HealthBadge health={str(health.Status)} />}
          {health.FailingStreak ? <Badge tone="bad">{health.FailingStreak} falha(s) seguidas</Badge> : null}</span>}>
          {hcfg.Test && (
            <div className="muted small" style={{ marginBottom: 8 }}>
              <code>{(reveal ? arr(hcfg.Test).map(str) : maskArgv(arr(hcfg.Test))).join(' ')}</code> · intervalo {nsToS(hcfg.Interval)} · timeout {nsToS(hcfg.Timeout)} · tentativas {str(hcfg.Retries) || '—'}
            </div>
          )}
          {hlog.length === 0 ? <Empty>Sem resultados ainda</Empty> : (
            <div className="table-wrap">
              <table className="table dk-table">
                <thead><tr><th>Início</th><th>Duração</th><th>Código</th><th>Saída</th></tr></thead>
                <tbody>
                  {hlog.map((h, i) => {
                    const s = parseDockerDate(h.Start);
                    const e = parseDockerDate(h.End);
                    return (
                      <tr key={i}>
                        <td className="small nowrap">{s ? new Date(s).toLocaleTimeString('pt-BR') : '—'}</td>
                        <td className="small nowrap">{s && e ? `${((e - s) / 1000).toFixed(2)}s` : '—'}</td>
                        <td><Badge tone={h.ExitCode === 0 ? 'ok' : 'bad'}>{str(h.ExitCode)}</Badge></td>
                        <td className="mono small dk-wrap">{str(h.Output).trim() || <span className="muted">(vazio)</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card pad={false} title={<span className="row gap-s">Variáveis de ambiente <span className="muted small">{env.length}</span></span>}>
        {env.length === 0 ? <Empty>Nenhuma</Empty> : (
          <div className="table-wrap" style={{ maxHeight: 320 }}>
            <table className="table dk-table">
              <tbody>
                {env.map(([k, v], i) => {
                  const vis = reveal || shown.has(k);
                  return (
                    <tr key={i}>
                      <td className="mono small nowrap">{k}</td>
                      <td className="mono small dk-wrap">{vis ? v : <span className="muted">{v ? MASK : '(vazio)'}</span>}</td>
                      <td className="right nowrap">
                        {!reveal && v && <Button size="s" variant="ghost" icon={vis ? <EyeOff size={13} /> : <Eye size={13} />} title={vis ? 'Ocultar' : 'Mostrar'} onClick={() => toggle(k)} />}
                        {vis && v && <CopyButton text={v} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Grid cols={2}>
        <Card pad={false} title="Montagens">
          {mounts.length === 0 ? <Empty>Nenhuma</Empty> : (
            <div className="table-wrap">
              <table className="table dk-table">
                <thead><tr><th>Tipo</th><th>Origem</th><th>Destino</th><th>Modo</th></tr></thead>
                <tbody>
                  {mounts.map((m, i) => (
                    <tr key={i}>
                      <td><Badge tone="muted">{str(m.Type)}</Badge></td>
                      <td className="mono small dk-wrap">{str(m.Name) || str(m.Source)}</td>
                      <td className="mono small dk-wrap">{str(m.Destination)}</td>
                      <td>{m.RW ? <Badge tone="info">rw</Badge> : <Badge tone="muted">ro</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card pad={false} title="Redes e portas">
          {nets.length === 0 ? <Empty>Nenhuma</Empty> : (
            <div className="table-wrap">
              <table className="table dk-table">
                <thead><tr><th>Rede</th><th>IP</th><th>Gateway</th><th>Aliases</th></tr></thead>
                <tbody>
                  {nets.map(([n, v]) => (
                    <tr key={n}>
                      <td className="mono small">{n}</td>
                      <td className="mono small">{str(v?.IPAddress) || '—'}</td>
                      <td className="mono small">{str(v?.Gateway) || '—'}</td>
                      <td className="small dk-wrap">{[...arr(v?.Aliases), ...arr(v?.DNSNames)].map(str).filter((x, i, a) => a.indexOf(x) === i).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {ports.length > 0 && (
            <div className="dk-pad dk-ports">
              {ports.map(([cp, binds]) => arr(binds).length
                ? arr(binds).map((b, i) => <Badge key={cp + i} tone="info">{str(b.HostIp) || '0.0.0.0'}:{str(b.HostPort)} → {cp}</Badge>)
                : <Badge key={cp} tone="muted">{cp} (não publicada)</Badge>)}
            </div>
          )}
        </Card>
      </Grid>

      <Card pad={false} title={<span className="row gap-s">Labels <span className="muted small">{Object.keys(labels).length}</span></span>}>
        {Object.keys(labels).length === 0 ? <Empty>Nenhuma</Empty> : (
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table className="table dk-table">
              <tbody>
                {Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => (
                  <tr key={k}><td className="mono small nowrap">{k}</td><td className="mono small dk-wrap">{str(v)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function RawJson({ d, reveal }: { d: any; reveal: boolean }) {
  const text = useMemo(() => {
    let o: any;
    try { o = JSON.parse(JSON.stringify(d)); } catch { return ''; }
    if (!reveal && o) {
      if (Array.isArray(o.Config?.Env)) {
        o.Config.Env = o.Config.Env.map((e: unknown) => {
          const s = str(e);
          const i = s.indexOf('=');
          return i < 0 ? s : `${s.slice(0, i)}=${MASK}`;
        });
      }
      if (Array.isArray(o.Args)) o.Args = maskArgv(o.Args);
      if (Array.isArray(o.Config?.Cmd)) o.Config.Cmd = maskArgv(o.Config.Cmd);
      if (Array.isArray(o.Config?.Entrypoint)) o.Config.Entrypoint = maskArgv(o.Config.Entrypoint);
      if (Array.isArray(o.Config?.Healthcheck?.Test)) o.Config.Healthcheck.Test = maskArgv(o.Config.Healthcheck.Test);
    }
    return JSON.stringify(o, null, 2);
  }, [d, reveal]);
  return (
    <div className="col gap-s">
      <div className="row gap-s between">
        <span className="muted small">{reveal ? 'Valores reais.' : 'Variáveis de ambiente e tokens ocultos — use "Mostrar segredos" para ver tudo.'}</span>
        <CopyButton text={text} title="Copiar JSON" />
      </div>
      <Pre maxHeight="62vh">{text}</Pre>
    </div>
  );
}

// ---------------------------------------------------------------- logs

const TAILS = ['100', '200', '500', '1000', '5000', 'all'];
const MAX_RENDER = 3000;

// Memoized so a new batch of streamed lines only renders the lines that changed.
const DkLogLine = memo(function DkLogLine({ text, q }: { text: string; q: string }) {
  return <div className={`log-line ${logTone(text)}`}><Highlight text={text} q={q} /></div>;
});

function LogsView({ name }: { name: string }) {
  const { toast } = useApp();
  const s = useStream(20000);
  const [tail, setTail] = useStored<string>('docker.logs.tail', '200');
  const [timestamps, setTimestamps] = useStored<boolean>('docker.logs.timestamps', false);
  const [follow, setFollow] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [q, setQ] = useState('');
  const [onlyMatches, setOnlyMatches] = useState(true);
  const [startErr, setStartErr] = useState<string | null>(null);

  const start = () => {
    const t = TAILS.includes(tail) ? tail : '200';
    setStartErr(null);
    s.start(`docker logs ${follow ? '-f ' : ''}--tail ${t} ${timestamps ? '-t ' : ''}${shq(name)} 2>&1`)
      .catch((e) => setStartErr(errMsg(e)));
  };

  useEffect(() => {
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, tail, timestamps, follow]);

  const ql = q.trim();
  const filtered = useMemo(() => {
    if (!ql || !onlyMatches) return s.lines;
    const low = ql.toLowerCase();
    return s.lines.filter((l) => l.toLowerCase().includes(low));
  }, [s.lines, ql, onlyMatches]);
  const visible = filtered.length > MAX_RENDER ? filtered.slice(filtered.length - MAX_RENDER) : filtered;

  const download = async () => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const path = await echo.app.saveText(`${name}-${stamp}.log`, s.lines.join('\n') + '\n');
      if (path) toast(`Logs salvos em ${path}`, 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  return (
    <div className="col gap-s">
      <div className="row gap-s wrap">
        <label className="row gap-s small">Últimas
          <select className="input" value={tail} onChange={(e) => setTail(e.target.value)}>
            {TAILS.map((t) => <option key={t} value={t}>{t === 'all' ? 'todas' : t}</option>)}
          </select>
          linhas
        </label>
        <Switch checked={follow} onChange={setFollow} label={<span className="small">Acompanhar</span>} />
        <Switch checked={timestamps} onChange={setTimestamps} label={<span className="small">Horários</span>} />
        <Switch checked={autoScroll} onChange={setAutoScroll} label={<span className="small">Rolar ao fim</span>} />
        <span className="grow" />
        <SearchInput value={q} onChange={setQ} placeholder="Buscar nos logs…" />
        <Switch checked={onlyMatches} onChange={setOnlyMatches} disabled={!ql} label={<span className="small">Só correspondências</span>} />
      </div>
      <div className="row gap-s">
        {s.running ? <Badge tone="info">{follow ? 'acompanhando' : 'carregando…'}</Badge> : <Badge tone="muted">parado</Badge>}
        <span className="muted small">
          {s.lines.length} linha(s){ql ? ` · ${filtered.length} correspondência(s)` : ''}{filtered.length > MAX_RENDER ? ` · mostrando as últimas ${MAX_RENDER}` : ''}
        </span>
        <span className="grow" />
        {s.running
          ? <Button size="s" icon={<Pause size={13} />} onClick={() => s.stop()}>Parar</Button>
          : <Button size="s" icon={<Play size={13} />} onClick={start}>Recarregar</Button>}
        <Button size="s" variant="ghost" icon={<Trash size={13} />} onClick={() => s.setLines([])} title="Limpar a visualização" />
        <Button size="s" icon={<Download size={13} />} onClick={download} disabled={!s.lines.length}>Baixar</Button>
      </div>
      <ErrorBox error={startErr} />
      <Pre autoScroll={autoScroll} maxHeight="58vh" className="dk-logs">
        {visible.length === 0
          ? <span className="muted">{s.running ? 'Aguardando logs…' : ql && s.lines.length ? 'Nenhuma linha corresponde à busca.' : 'Sem logs.'}</span>
          : visible.map((l, i) => <DkLogLine key={i} text={l} q={ql} />)}
      </Pre>
    </div>
  );
}

// ---------------------------------------------------------------- exec

interface ExecOut { cmd: string; stdout: string; stderr: string; code: number | null; ms: number }

const QUICK = ['ps', 'env', 'df -h', 'cat /etc/os-release', 'ls -la /', 'free -m'];

function ExecView({ name, running }: { name: string; running: boolean }) {
  const { navigate } = useApp();
  const [cmd, setCmd] = useState('');
  const [user, setUser] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ExecOut[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const exec = async (c: string) => {
    const command = c.trim();
    if (!command || busy) return;
    setBusy(true);
    const t0 = Date.now();
    try {
      const u = user.trim() ? `-u ${shq(user.trim())} ` : '';
      const r = await echo.exec(`docker exec ${u}${shq(name)} sh -c ${shq(command)}`, { timeout: 60000 });
      setHistory((h) => [{ cmd: command, stdout: r.stdout, stderr: r.stderr, code: r.code, ms: r.durationMs }, ...h].slice(0, 30));
    } catch (e) {
      setHistory((h) => [{ cmd: command, stdout: '', stderr: errMsg(e), code: null, ms: Date.now() - t0 }, ...h].slice(0, 30));
    } finally {
      setBusy(false);
      setCmd('');
      inputRef.current?.focus();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    exec(cmd);
  };

  if (!running) return <Empty>O contêiner não está rodando — inicie-o para executar comandos.</Empty>;

  const interactive = `docker exec -it ${name} sh`;
  return (
    <div className="col gap-s">
      <div className="muted small">
        Executa um comando avulso com <code>docker exec {name} sh -c '…'</code> (sem TTY; imagens sem <code>sh</code>, como as distroless, não funcionam).
        Para um shell interativo, abra o Terminal SSH e rode <code>{interactive}</code>.
      </div>
      <form className="row gap-s" onSubmit={submit}>
        <input ref={inputRef} className="input mono grow" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="comando, ex.: ls -la /app" autoFocus />
        <input className="input mono" style={{ width: 120 }} value={user} onChange={(e) => setUser(e.target.value)} placeholder="usuário" title="Opcional: -u usuário[:grupo]" />
        <Button type="submit" variant="primary" busy={busy} disabled={!cmd.trim()} icon={<Play size={14} />}>Executar</Button>
      </form>
      <div className="row gap-s wrap">
        {QUICK.map((q) => <Button key={q} size="s" onClick={() => exec(q)} disabled={busy}><span className="mono">{q}</span></Button>)}
        <span className="grow" />
        <CopyButton text={interactive} title="Copiar comando interativo" />
        <Button size="s" icon={<SquareTerminal size={13} />} onClick={() => navigate('terminal')}>Abrir Terminal SSH</Button>
      </div>
      {history.length === 0 ? <Empty>Nenhum comando executado ainda</Empty> : history.map((h, i) => (
        <div key={history.length - i} className="dk-exec">
          <div className="row gap-s">
            <code className="grow ellipsis">$ {h.cmd}</code>
            <Badge tone={h.code === 0 ? 'ok' : 'bad'}>código {h.code ?? '?'}</Badge>
            <span className="muted small">{(h.ms / 1000).toFixed(2)}s</span>
            <Button size="s" variant="ghost" onClick={() => setCmd(h.cmd)} title="Reutilizar comando">↺</Button>
          </div>
          <Pre maxHeight={320}>
            {h.stdout}
            {h.stderr && <span className="log-line err">{h.stderr}</span>}
            {!h.stdout && !h.stderr && <span className="muted">(sem saída)</span>}
          </Pre>
        </div>
      ))}
    </div>
  );
}
