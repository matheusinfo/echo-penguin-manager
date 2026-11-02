// "Volumes & redes" tab.
import { useMemo, useState } from 'react';
import { HardDrive, Network, Trash, Calculator } from 'lucide-react';
import { errMsg, run, runSections, shq } from '../../api';
import { useAction, useApp, usePoll } from '../../hooks';
import { Badge, Button, Card, Empty, ErrorBox, Loading, RefreshButton } from '../../components/ui';
import { ContainerRow, fmtAgo, fmtDate, parseDockerDate, parseJsonLines, parseJsonSafe, parseLabels, str } from './common';

interface Vol { name: string; driver: string; mountpoint: string; scope: string; project: string; labels: Record<string, string> }
interface Net { id: string; name: string; driver: string; scope: string; internal: boolean; ipv6: boolean; created: number | null; project: string; subnets: string; attached: number | null }
interface VolSize { size: string; links: string }

const BUILTIN_NETS = new Set(['bridge', 'host', 'none']);

export default function VolumesNetworksTab({ containers }: { containers: ContainerRow[] | null }) {
  const { confirm } = useApp();
  const { busy, act } = useAction();
  const [sizes, setSizes] = useState<Record<string, VolSize> | null>(null);
  const [sizesBusy, setSizesBusy] = useState(false);
  const [sizesErr, setSizesErr] = useState<string | null>(null);

  const poll = usePoll(async () => {
    const r = await runSections({
      vols: `docker volume ls --format '{{json .}}'`,
      nets: `docker network ls --format '{{json .}}'`,
      ipam: `docker network inspect -f '{{.Name}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}|{{len .Containers}}' $(docker network ls -q)`,
    }, { timeout: 30000 });
    const ipam: Record<string, { subnets: string; attached: number | null }> = {};
    for (const line of (r.ipam ?? '').split('\n')) {
      const [n, sub, cnt] = line.split('|');
      if (!n || sub == null) continue;
      const c = parseInt(cnt ?? '', 10);
      ipam[n] = { subnets: sub.trim(), attached: isNaN(c) ? null : c };
    }
    const vols = parseJsonLines<Record<string, unknown>>(r.vols).map((o): Vol => {
      const labels = parseLabels(o.Labels);
      return {
        name: str(o.Name), driver: str(o.Driver), mountpoint: str(o.Mountpoint), scope: str(o.Scope),
        project: labels['com.docker.compose.project'] || '', labels,
      };
    });
    const nets = parseJsonLines<Record<string, unknown>>(r.nets).map((o): Net => {
      const name = str(o.Name);
      const labels = parseLabels(o.Labels);
      return {
        id: str(o.ID), name, driver: str(o.Driver), scope: str(o.Scope),
        internal: str(o.Internal) === 'true', ipv6: str(o.IPv6) === 'true',
        created: parseDockerDate(o.CreatedAt), project: labels['com.docker.compose.project'] || '',
        subnets: ipam[name]?.subnets ?? '', attached: ipam[name]?.attached ?? null,
      };
    });
    return { vols, nets };
  }, null);

  const netUsers = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const c of containers ?? []) for (const n of c.networks) (m[n] ??= []).push(c.name);
    return m;
  }, [containers]);

  const volUsers = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const c of containers ?? []) for (const v of c.mounts) (m[v] ??= []).push(c.name);
    return m;
  }, [containers]);

  const loadSizes = async () => {
    setSizesBusy(true);
    setSizesErr(null);
    try {
      const out = await run(`docker system df -v --format '{{json .}}'`, { timeout: 90000 });
      const d = parseJsonSafe<{ Volumes?: Record<string, unknown>[] }>(out);
      const m: Record<string, VolSize> = {};
      for (const v of Array.isArray(d?.Volumes) ? d!.Volumes : []) m[str(v.Name)] = { size: str(v.Size), links: str(v.Links) };
      setSizes(m);
    } catch (e) {
      setSizesErr(errMsg(e));
    } finally {
      setSizesBusy(false);
    }
  };

  const removeVol = async (v: Vol) => {
    const users = volUsers[v.name] ?? [];
    const ok = await confirm({
      title: 'Remover volume',
      message: `Apagar o volume "${v.name}" e TODOS os dados dele? Não há como desfazer.` +
        (users.length ? `\n\nEm uso por: ${users.join(', ')} — o Docker recusa enquanto algum contêiner (mesmo parado) o usar.` : ''),
      confirmLabel: 'Apagar volume',
      danger: true,
    });
    if (!ok) return;
    await act(`vol:${v.name}`, () => run(`docker volume rm ${shq(v.name)}`, { timeout: 60000 }), `Volume ${v.name} removido`);
    poll.refresh();
    if (sizes) loadSizes();
  };

  if (!poll.data && poll.loading) return <Loading />;
  const vols = poll.data?.vols ?? [];
  const nets = poll.data?.nets ?? [];

  return (
    <>
      <ErrorBox error={poll.error} onRetry={poll.refresh} />
      <Card pad={false} icon={<HardDrive size={15} />}
        title={<span className="row gap-s">Volumes <span className="muted small">{vols.length}</span></span>}
        actions={<>
          <Button size="s" icon={<Calculator size={13} />} busy={sizesBusy} onClick={loadSizes} title="docker system df -v (pode demorar)">
            {sizes ? 'Recalcular tamanhos' : 'Calcular tamanhos'}
          </Button>
          <RefreshButton onClick={poll.refresh} loading={poll.loading} lastUpdated={poll.lastUpdated} />
        </>}>
        {sizesErr && <div className="dk-pad"><ErrorBox error={sizesErr} /></div>}
        {vols.length === 0 ? (
          <Empty>Nenhum volume nomeado. Os contêineres atuais usam bind mounts em <code>/data/…</code> (veja Montagens nos detalhes).</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table dk-table">
              <thead><tr><th>Nome</th><th>Driver</th><th>Projeto</th><th>Usado por</th><th className="right">Tamanho</th><th>Ponto de montagem</th><th /></tr></thead>
              <tbody>
                {vols.map((v) => {
                  const users = volUsers[v.name] ?? [];
                  return (
                    <tr key={v.name}>
                      <td className="mono small dk-wrap">{v.name}</td>
                      <td className="small">{v.driver}</td>
                      <td>{v.project ? <Badge tone="info">{v.project}</Badge> : <span className="muted">—</span>}</td>
                      <td className="small">{users.length ? users.join(', ') : sizes?.[v.name]?.links === '0' ? <Badge tone="warn">sem uso</Badge> : <span className="muted">—</span>}</td>
                      <td className="right mono small nowrap">{sizes ? sizes[v.name]?.size || '—' : <span className="muted">?</span>}</td>
                      <td className="mono small muted dk-wrap">{v.mountpoint || '—'}</td>
                      <td className="right">
                        <Button size="s" variant="ghost" icon={<Trash size={14} />} title="Remover volume" busy={busy === `vol:${v.name}`} onClick={() => removeVol(v)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card pad={false} icon={<Network size={15} />} title={<span className="row gap-s">Redes <span className="muted small">{nets.length}</span></span>}>
        {nets.length === 0 ? <Empty>Nenhuma rede</Empty> : (
          <div className="table-wrap">
            <table className="table dk-table">
              <thead><tr><th>Nome</th><th>Driver</th><th>Sub-rede</th><th>Projeto</th><th>Contêineres</th><th>Criada</th><th>ID</th></tr></thead>
              <tbody>
                {nets.map((n) => {
                  const users = netUsers[n.name] ?? [];
                  return (
                    <tr key={n.id || n.name}>
                      <td className="mono small">
                        <span className="row gap-s">{n.name}
                          {BUILTIN_NETS.has(n.name) && <Badge tone="muted">padrão</Badge>}
                          {n.internal && <Badge tone="warn">interna</Badge>}
                          {n.ipv6 && <Badge tone="info">IPv6</Badge>}
                        </span>
                      </td>
                      <td className="small">{n.driver}</td>
                      <td className="mono small">{n.subnets || '—'}</td>
                      <td>{n.project ? <Badge tone="info">{n.project}</Badge> : <span className="muted">—</span>}</td>
                      <td className="small dk-wrap">{users.length ? users.join(', ') : n.attached ? `${n.attached}` : <span className="muted">—</span>}</td>
                      <td className="small nowrap" title={fmtDate(n.created)}>{fmtAgo(n.created)}</td>
                      <td className="mono small muted">{n.id.slice(0, 12)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="muted small">
        A rede <code>host</code> compartilha a rede do Echo: portas abertas por esses contêineres não passam pelo filtro <code>DOCKER-USER</code>, só pelo firewall do sistema (<code>LAN_PORTS</code>).
      </div>
    </>
  );
}
