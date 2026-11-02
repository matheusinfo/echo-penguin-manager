// "Contêineres" tab: the container table, live stats and SSH tunnel hints for published ports.
import { useMemo, useState } from 'react';
import { ScrollText, Info, SquareTerminal, Activity, Network, ExternalLink } from 'lucide-react';
import { echo, fmtBytes } from '../../api';
import { useApp } from '../../hooks';
import { Badge, Button, Card, Empty, ErrorBox, Loading, SearchInput, Switch, toneFor } from '../../components/ui';
import { ContainerRow, CopyButton, fmtAgo, fmtDate, HealthBadge, isLoopback, PortMap, StatRow, StateBadge } from './common';
import { LifecycleButtons, useContainerActions } from './actions';

export type DetailTab = 'resumo' | 'logs' | 'exec' | 'json';

type Filter = 'all' | 'running' | 'stopped' | 'problem';

export function useTunnel() {
  const { config } = useApp();
  return (ports: (string | null)[], persistent = false) => {
    const host = config?.host || '<echo-ip>';
    const user = config?.username || 'root';
    const parts = ['ssh'];
    if (config?.keyPath && !config.useAgent) parts.push('-i', config.keyPath);
    if (config?.port && config.port !== 22) parts.push('-p', String(config.port));
    if (persistent) parts.push('-N');
    for (const p of ports) if (p) parts.push('-L', `${p}:localhost:${p}`);
    parts.push(`${user}@${host}`);
    return parts.join(' ');
  };
}

const isProblem = (c: ContainerRow) =>
  c.health === 'unhealthy' || c.state === 'restarting' || c.state === 'dead' ||
  (c.state === 'exited' && !/Exited \(0\)/.test(c.status));

export default function ContainersTab({ list, error, loading, refresh, stats, statsOn, setStatsOn, statsLoading, statsError, onOpen, onProject }: {
  list: ContainerRow[] | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
  stats: Record<string, StatRow> | null;
  statsOn: boolean;
  setStatsOn: (v: boolean) => void;
  statsLoading: boolean;
  statsError: string | null;
  onOpen: (name: string, tab?: DetailTab) => void;
  onProject: (project: string) => void;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const { busy, doAction } = useContainerActions(refresh);
  const tunnel = useTunnel();

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (list ?? [])
      .filter((c) => {
        if (filter === 'running' && c.state !== 'running') return false;
        if (filter === 'stopped' && (c.state === 'running' || c.state === 'paused')) return false;
        if (filter === 'problem' && !isProblem(c)) return false;
        if (!ql) return true;
        return [c.name, c.image, c.project, c.service, c.status].some((x) => x.toLowerCase().includes(ql));
      })
      .sort((a, b) => (a.project || '~').localeCompare(b.project || '~') || a.name.localeCompare(b.name));
  }, [list, q, filter]);

  const published = useMemo(() => {
    const out: { c: ContainerRow; p: PortMap }[] = [];
    for (const c of list ?? []) {
      if (c.state !== 'running') continue;
      for (const p of c.ports) if (p.published && p.hostPort && !p.hostPort.includes('-')) out.push({ c, p });
    }
    return out;
  }, [list]);

  if (!list && loading) return <Loading />;

  return (
    <>
      <ErrorBox error={error} onRetry={refresh} />

      {published.length > 0 && (
        <Card title="Acesso às portas publicadas" icon={<Network size={15} />}
          actions={<CopyButton text={tunnel(published.map((x) => x.p.hostPort), true)} title="Copiar um túnel com todas as portas" />}>
          <div className="muted small" style={{ marginBottom: 8 }}>
            No echo-penguin as portas publicadas ficam fechadas no Wi-Fi (a menos que <code>DOCKER_LAN=1</code>), e as ligadas a
            <code> 127.0.0.1</code> só existem no próprio Echo. Use um túnel SSH e abra <code>http://localhost:&lt;porta&gt;</code>.
          </div>
          <div className="dk-tunnels">
            {published.map(({ c, p }) => {
              const cmd = tunnel([p.hostPort]);
              return (
                <div key={`${c.id}-${p.hostPort}`} className="dk-tunnel">
                  <span className="dk-tunnel-name ellipsis" title={c.name}>{c.name}</span>
                  <Badge tone={isLoopback(p.hostIp) ? 'info' : 'warn'}
                    title={isLoopback(p.hostIp) ? 'Só em 127.0.0.1 no Echo: precisa de túnel' : 'Em todas as interfaces: no Wi-Fi só com DOCKER_LAN=1'}>
                    {p.hostIp}:{p.hostPort} → {p.containerPort}/{p.proto}
                  </Badge>
                  <code className="dk-tunnel-cmd ellipsis grow" title={cmd}>{cmd}</code>
                  <CopyButton text={cmd} title="Copiar comando do túnel" />
                  {p.proto === 'tcp' && (
                    <Button size="s" variant="ghost" icon={<ExternalLink size={13} />} title={`Abrir http://localhost:${p.hostPort} (com o túnel ativo)`}
                      onClick={() => echo.app.openExternal(`http://localhost:${p.hostPort}`)} />
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card pad={false}
        title={<span className="row gap-s">Contêineres <span className="muted small">{rows.length}/{list?.length ?? 0}</span></span>}
        actions={<>
          <SearchInput value={q} onChange={setQ} placeholder="Filtrar por nome, imagem, projeto…" />
          <select className="input" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="all">Todos</option>
            <option value="running">Rodando</option>
            <option value="stopped">Parados</option>
            <option value="problem">Com problema</option>
          </select>
          <Switch checked={statsOn} onChange={setStatsOn} label={<span className="row gap-s small"><Activity size={13} />CPU/memória{statsLoading && statsOn ? '…' : ''}</span>} />
        </>}>
        {statsOn && statsError && <div className="dk-pad"><ErrorBox error={`docker stats: ${statsError}`} /></div>}
        {rows.length === 0 ? <Empty>{list?.length ? 'Nenhum contêiner corresponde ao filtro' : 'Nenhum contêiner'}</Empty> : (
          <div className="table-wrap">
            <table className="table dk-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Imagem</th>
                  <th>Estado</th>
                  <th>Status</th>
                  <th>Portas</th>
                  {statsOn && <th className="right">CPU</th>}
                  {statsOn && <th className="right">Memória</th>}
                  <th>Criado</th>
                  <th className="right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const st = stats?.[c.shortId] ?? stats?.[c.name];
                  const live = c.state === 'running';
                  return (
                    <tr key={c.id}>
                      <td>
                        <div className="dk-name">
                          <button className="dk-link" onClick={() => onOpen(c.name)} title="Detalhes">{c.name}</button>
                          {c.project && (
                            <button className="dk-chip" onClick={() => onProject(c.project)} title="Projeto compose">
                              {c.project}{c.service ? ` · ${c.service}` : ''}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="mono small dk-image ellipsis" title={c.image}>{c.image.startsWith('sha256:') ? c.image.slice(7, 19) : c.image}</td>
                      <td><div className="row gap-s"><StateBadge state={c.state} status={c.status} /><HealthBadge health={c.health} /></div></td>
                      <td className="muted small nowrap">{c.status}</td>
                      <td><Ports ports={c.ports} tunnel={tunnel} /></td>
                      {statsOn && (
                        <td className="right mono small nowrap">
                          {live && st?.cpu != null ? <span className={`tone-fg-${toneFor(st.cpu, 50, 90)}`}>{st.cpu.toFixed(1)}%</span> : <span className="muted">—</span>}
                        </td>
                      )}
                      {statsOn && (
                        <td className="right mono small nowrap" title={st ? `${fmtBytes(st.mem)} de ${fmtBytes(st.memLimit)} · PIDs ${st.pids} · rede ${st.net}` : ''}>
                          {live && st?.mem != null ? <>{fmtBytes(st.mem)} <span className={`tone-fg-${toneFor(st.memPct, 70, 90)}`}>({st.memPct?.toFixed(0)}%)</span></> : <span className="muted">—</span>}
                        </td>
                      )}
                      <td className="small nowrap" title={fmtDate(c.created)}>{fmtAgo(c.created)}</td>
                      <td>
                        <div className="dk-actions">
                          <LifecycleButtons c={c} busy={busy} onAction={(a) => doAction(c, a)} />
                          <Button size="s" variant="ghost" icon={<ScrollText size={14} />} title="Logs" onClick={() => onOpen(c.name, 'logs')} />
                          <Button size="s" variant="ghost" icon={<SquareTerminal size={14} />} title="Executar comando" disabled={c.state !== 'running'} onClick={() => onOpen(c.name, 'exec')} />
                          <Button size="s" variant="ghost" icon={<Info size={14} />} title="Inspecionar" onClick={() => onOpen(c.name, 'resumo')} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {(list ?? []).some((c) => c.state === 'paused') && (
        <div className="muted small">
          Contêineres pausados: o supervisor do echo-penguin pausa tudo quando a CPU passa de <code>TEMP_CRIT</code> e retoma ao esfriar até <code>TEMP_WARN</code>.
        </div>
      )}
    </>
  );
}

function Ports({ ports, tunnel }: { ports: PortMap[]; tunnel: (p: (string | null)[]) => string }) {
  if (!ports.length) return <span className="muted">—</span>;
  return (
    <div className="dk-ports">
      {ports.map((p, i) => {
        if (!p.published) {
          return <Badge key={i} tone="muted" title="Exposta só na rede do Docker (não publicada)">{p.containerPort}/{p.proto}</Badge>;
        }
        const loop = isLoopback(p.hostIp);
        const title = loop
          ? `Ligada a ${p.hostIp} no Echo. Túnel: ${tunnel([p.hostPort])}`
          : `Ligada a ${p.hostIp}. No Wi-Fi só fica acessível com DOCKER_LAN=1 (penguin set DOCKER_LAN 1 && penguin firewall); senão use: ${tunnel([p.hostPort])}`;
        return (
          <Badge key={i} tone={loop ? 'info' : 'warn'} title={title}>
            {loop ? '127.0.0.1:' : ''}{p.hostPort}→{p.containerPort}{p.proto !== 'tcp' ? `/${p.proto}` : ''}
          </Badge>
        );
      })}
    </div>
  );
}
