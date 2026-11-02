// "Limpeza / sistema" tab: disk usage, docker info, `penguin cleanup` preview/run, prune buttons.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { HardDrive, Server, Sparkles, Eraser, Layers, Box } from 'lucide-react';
import { fmtBytes, run, runSections } from '../../api';
import { useAction, useApp, usePoll } from '../../hooks';
import { Badge, Button, Card, Empty, ErrorBox, Grid, KV, Loading, Meter, Pre, RefreshButton, Switch } from '../../components/ui';
import { parseJsonLines, parseJsonSafe, StreamJob, str } from './common';

const TYPE_PT: Record<string, string> = { Images: 'Imagens', Containers: 'Contêineres', 'Local Volumes': 'Volumes', 'Build Cache': 'Cache de build' };

function parseDf(text: string | undefined): { total: number; used: number; avail: number; pct: number } | null {
  const line = (text ?? '').trim().split('\n').pop() ?? '';
  const f = line.trim().split(/\s+/);
  if (f.length < 5) return null;
  const n = f.length;
  const total = parseInt(f[n - 5], 10) * 1024;
  const used = parseInt(f[n - 4], 10) * 1024;
  const avail = parseInt(f[n - 3], 10) * 1024;
  if ([total, used, avail].some(isNaN) || !total) return null;
  return { total, used, avail, pct: (used / total) * 100 };
}

export default function CleanupTab({ runStream, onChanged }: { runStream: (job: StreamJob) => void; onChanged: () => void }) {
  const { confirm, toast } = useApp();
  const { busy, act } = useAction();
  const [withSlot, setWithSlot] = useState(false);

  const poll = usePoll(async () => {
    const r = await runSections({
      df: `docker system df --format '{{json .}}'`,
      info: `docker info --format '{{json .}}'`,
      ver: `docker version --format '{{json .}}'`,
      compose: `docker compose version --short`,
      data: `df -k /data | tail -1`,
      cleanup: `penguin cleanup${withSlot ? ' --slot' : ''}`,
    }, { timeout: 45000 });
    return {
      df: parseJsonLines<Record<string, unknown>>(r.df),
      info: parseJsonSafe<any>(r.info),
      infoRaw: r.info ?? '',
      ver: parseJsonSafe<any>(r.ver),
      compose: (r.compose ?? '').trim(),
      data: parseDf(r.data),
      cleanup: r.cleanup ?? '',
    };
  }, null, [withSlot]);

  const after = () => { poll.refresh(); onChanged(); };

  const prune = async (key: string, title: string, message: string, cmd: string) => {
    if (!(await confirm({ title, message, confirmLabel: 'Executar', danger: true }))) return;
    await act(key, async () => {
      const out = await run(cmd, { timeout: 180000 });
      const reclaimed = /Total reclaimed space:\s*(.+)/i.exec(out)?.[1] ?? out.trim().split('\n').pop() ?? '';
      toast(`${title}: ${reclaimed || 'nada a remover'}`, 'ok');
    });
    after();
  };

  const runCleanup = async () => {
    const ok = await confirm({
      title: `penguin cleanup --yes${withSlot ? ' --slot' : ''}`,
      message: 'Remover tudo o que a prévia lista: tarballs de rootfs já instalados, arquivos de teste, contêineres parados fora de projetos compose, imagens sem tag e o cache de build.' +
        (withSlot ? '\n\n--slot também apaga o slot inativo: deixa de existir o caminho de volta para a versão anterior do sistema.' : '') +
        '\n\nNão há como desfazer.',
      confirmLabel: 'Limpar',
      danger: true,
    });
    if (!ok) return;
    runStream({ title: 'penguin cleanup --yes', command: `penguin cleanup --yes${withSlot ? ' --slot' : ''}`, onDone: after });
  };

  if (!poll.data && poll.loading) return <Loading />;
  const d = poll.data;
  const info = d?.info;
  const server = d?.ver?.Server;
  const client = d?.ver?.Client;
  const dfMap: Record<string, string> = {};
  for (const [k, v] of Array.isArray(info?.DriverStatus) ? info.DriverStatus : []) dfMap[str(k)] = str(v);
  const warnings: string[] = Array.isArray(info?.Warnings) ? info.Warnings.map(str) : [];

  return (
    <>
      <div className="row gap-s between">
        <span className="muted small">Dados do Docker ficam em <code>{str(info?.DockerRootDir) || '/data/docker'}</code>.</span>
        <RefreshButton onClick={poll.refresh} loading={poll.loading} lastUpdated={poll.lastUpdated} />
      </div>
      <ErrorBox error={poll.error} onRetry={poll.refresh} />

      <Grid cols={2}>
        <Card title="Uso de disco" icon={<HardDrive size={15} />}>
          {d?.data && (
            <div style={{ marginBottom: 12 }}>
              <Meter value={d.data.pct} label={<span>/data</span>} right={`${fmtBytes(d.data.used)} de ${fmtBytes(d.data.total)} · livre ${fmtBytes(d.data.avail)}`} />
            </div>
          )}
          {!d?.df.length ? <Empty>Sem dados do docker system df</Empty> : (
            <div className="table-wrap">
              <table className="table dk-table">
                <thead><tr><th>Tipo</th><th className="right">Total</th><th className="right">Ativos</th><th className="right">Tamanho</th><th className="right">Recuperável</th></tr></thead>
                <tbody>
                  {d.df.map((r) => (
                    <tr key={str(r.Type)}>
                      <td>{TYPE_PT[str(r.Type)] ?? str(r.Type)}</td>
                      <td className="right mono small">{str(r.TotalCount)}</td>
                      <td className="right mono small">{str(r.Active)}</td>
                      <td className="right mono small">{str(r.Size)}</td>
                      <td className="right mono small">{str(r.Reclaimable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Docker" icon={<Server size={15} />}>
          {!info ? <Empty>docker info indisponível{d?.infoRaw ? `: ${d.infoRaw.slice(0, 200)}` : ''}</Empty> : (
            <KV items={[
              ['Servidor', `${str(server?.Version ?? info.ServerVersion)} (API ${str(server?.ApiVersion) || '?'}, ${str(server?.Arch) || '?'})`],
              ['Cliente / compose', `${str(client?.Version) || '?'} (${str(client?.Arch) || '?'}) · compose ${d?.compose || '?'}`],
              ['Storage driver', `${str(info.Driver)}${dfMap['Backing Filesystem'] ? ` sobre ${dfMap['Backing Filesystem']}` : ''}`],
              ['Diretório raiz', <code>{str(info.DockerRootDir)}</code>],
              ['Cgroup', `${str(info.CgroupDriver)} · v${str(info.CgroupVersion)}`],
              ['Logging', str(info.LoggingDriver)],
              ['Kernel / SO', `${str(info.KernelVersion)} · ${str(info.OperatingSystem)} (${str(info.Architecture)})`],
              ['CPUs / memória', `${str(info.NCPU)} · ${fmtBytes(Number(info.MemTotal))}`],
              ['Contêineres', `${str(info.Containers)} (${str(info.ContainersRunning)} rodando, ${str(info.ContainersPaused)} pausados, ${str(info.ContainersStopped)} parados)`],
              ['Imagens (com camadas)', str(info.Images)],
            ]} />
          )}
          {warnings.length > 0 && (
            <div className="col gap-s" style={{ marginTop: 10 }}>
              {warnings.map((w, i) => <div key={i} className="small" style={{ color: 'var(--warn)' }}>⚠ {w}</div>)}
            </div>
          )}
        </Card>
      </Grid>

      <Card title="penguin cleanup" icon={<Sparkles size={15} />}
        actions={<>
          <Switch checked={withSlot} onChange={setWithSlot} label={<span className="small">incluir slot inativo (--slot)</span>} />
          <Button size="s" variant="danger" icon={<Eraser size={13} />} onClick={runCleanup}>Executar limpeza</Button>
        </>}>
        <div className="muted small" style={{ marginBottom: 8 }}>
          Prévia do que o <code>penguin cleanup</code> removeria (nada é apagado até você executar). Contêineres de projetos compose parados ficam.
        </div>
        {d ? <Pre maxHeight={260}>{d.cleanup || 'Sem saída.'}</Pre> : null}
      </Card>

      <Card title="Prune manual" icon={<Layers size={15} />}>
        <div className="row gap-s wrap">
          <Button icon={<Layers size={14} />} busy={busy === 'img'} onClick={() => prune('img', 'Remover imagens sem tag',
            'docker image prune -f\n\nRemove as imagens dangling (sem tag, sobras de rebuilds) que nenhum contêiner usa.', 'docker image prune -f')}>
            Imagens sem tag
          </Button>
          <Button icon={<Box size={14} />} busy={busy === 'build'} onClick={() => prune('build', 'Limpar cache de build',
            'docker builder prune -f\n\nApaga o cache de build; o próximo build no Echo será mais lento.', 'docker builder prune -f')}>
            Cache de build
          </Button>
          <Button variant="danger" icon={<Box size={14} />} busy={busy === 'ctr'} onClick={() => prune('ctr', 'Remover contêineres parados',
            'docker container prune -f\n\nRemove TODOS os contêineres parados, inclusive os de projetos compose (que voltam só com "up -d"). Prefira o penguin cleanup, que preserva os de compose.',
            'docker container prune -f')}>
            Contêineres parados
          </Button>
          <Button variant="danger" icon={<Layers size={14} />} busy={busy === 'imgall'} onClick={() => prune('imgall', 'Remover imagens sem uso',
            'docker image prune -a -f\n\nRemove TODAS as imagens que nenhum contêiner usa, inclusive as com tag (ex.: bases de build). Vão precisar ser baixadas/construídas de novo.',
            'docker image prune -a -f')}>
            Todas as imagens sem uso
          </Button>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>
          Volumes nunca são removidos aqui. <Badge tone="muted">dica</Badge> rode a prévia acima antes de qualquer prune.
        </div>
      </Card>
    </>
  );
}
