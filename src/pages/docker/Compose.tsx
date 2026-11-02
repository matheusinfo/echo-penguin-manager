// "Compose" tab: projects from `docker compose ls -a`, their containers, actions and compose files.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpFromLine, CloudDownload, RotateCw, Square, FileText, Layers } from 'lucide-react';
import { echo, errMsg, run, shq } from '../../api';
import { useAction, useApp, usePoll } from '../../hooks';
import { Badge, Button, Card, Empty, ErrorBox, Loading, Modal, Pre, RefreshButton, Tabs } from '../../components/ui';
import { ContainerRow, CopyButton, HealthBadge, parseJsonLines, StateBadge, StreamJob, str, Tone } from './common';
import type { DetailTab } from './Containers';

interface Project { name: string; status: string; files: string[] }

function parseStatus(s: string): { parts: [string, number][]; tone: Tone } {
  const parts: [string, number][] = [];
  for (const m of s.matchAll(/(\w+)\((\d+)\)/g)) parts.push([m[1], parseInt(m[2], 10)]);
  const states = parts.map((p) => p[0]);
  let tone: Tone = 'muted';
  if (states.length && states.every((x) => x === 'running')) tone = 'ok';
  else if (states.includes('restarting') || states.includes('dead')) tone = 'bad';
  else if (states.includes('running')) tone = 'warn';
  return { parts, tone };
}

const STATUS_PT: Record<string, string> = { running: 'rodando', exited: 'parado', paused: 'pausado', restarting: 'reiniciando', created: 'criado', dead: 'morto' };

export default function ComposeTab({ containers, refreshContainers, runStream, onOpen, focus, intervalMs }: {
  containers: ContainerRow[] | null;
  refreshContainers: () => void;
  runStream: (job: StreamJob) => void;
  onOpen: (name: string, tab?: DetailTab) => void;
  focus: string | null;
  intervalMs: number | null;
}) {
  const { confirm } = useApp();
  const { busy, act } = useAction();
  const [fileView, setFileView] = useState<Project | null>(null);

  // compose ls is only needed for the project list and its files: polled slowly (the per-project status shown
  // below is derived from the container list, which the page already polls).
  const poll = usePoll(async () => {
    const out = await run(`docker compose ls -a --format json`, { timeout: 20000 });
    return parseJsonLines<Record<string, unknown>>(out).map((o): Project => ({
      name: str(o.Name),
      status: str(o.Status),
      files: str(o.ConfigFiles).split(',').map((f) => f.trim()).filter(Boolean),
    }));
  }, intervalMs);

  const byProject = useMemo(() => {
    const m: Record<string, ContainerRow[]> = {};
    for (const c of containers ?? []) if (c.project) (m[c.project] ??= []).push(c);
    return m;
  }, [containers]);

  // Projects only known from container labels (compose ls hides some edge cases) are listed too.
  const projects = useMemo(() => {
    const list = [...(poll.data ?? [])];
    for (const name of Object.keys(byProject)) {
      if (list.some((p) => p.name === name)) continue;
      const files = (byProject[name][0].labels['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean);
      list.push({ name, status: '', files });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [poll.data, byProject]);

  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (focus && refs.current[focus]) refs.current[focus]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus, projects.length]);

  // Labels come from the device: only an absolute path is used for `cd` (anything else could be read as an option).
  const workdir = (p: Project) => {
    const wd = byProject[p.name]?.[0]?.labels['com.docker.compose.project.working_dir'] ||
      (p.files[0] ? p.files[0].replace(/\/[^/]*$/, '') || '/' : '');
    return wd.startsWith('/') ? wd : '';
  };

  // "running(2), exited(1)" from the live container list (fresher than the slow compose ls poll).
  const liveStatus = (p: Project) => {
    const cs = byProject[p.name];
    if (!cs?.length) return p.status;
    const n: Record<string, number> = {};
    for (const c of cs) n[c.state] = (n[c.state] ?? 0) + 1;
    return Object.entries(n).map(([k, v]) => `${k}(${v})`).join(', ');
  };

  const base = (p: Project) => {
    const wd = workdir(p);
    return `${wd ? `cd ${shq(wd)} && ` : ''}docker compose -p ${shq(p.name)}${p.files.map((f) => ` -f ${shq(f)}`).join('')}`;
  };

  const after = () => { poll.refresh(); refreshContainers(); };

  const up = async (p: Project) => {
    if (!(await confirm({
      title: `docker compose up -d — ${p.name}`,
      message: `Criar/atualizar e iniciar os serviços de "${p.name}"?\n\nSe a configuração ou a imagem mudou, os contêineres são recriados. Serviços com "build:" sem imagem pronta são construídos aqui no Echo, o que pode levar bastante tempo.`,
      confirmLabel: 'Subir',
    }))) return;
    runStream({ title: `compose up -d · ${p.name}`, command: `${base(p)} up -d`, onDone: after });
  };

  const pull = async (p: Project) => {
    if (!(await confirm({
      title: `docker compose pull — ${p.name}`,
      message: `Baixar as versões mais novas das imagens de "${p.name}"? Imagens construídas localmente são ignoradas (--ignore-buildable).\n\nO Echo roda imagens linux/arm/v7: imagens sem essa arquitetura falham.\n\nOs contêineres só usam as novas imagens depois de "up -d".`,
      confirmLabel: 'Baixar',
    }))) return;
    runStream({ title: `compose pull · ${p.name}`, command: `${base(p)} pull --ignore-buildable`, onDone: after });
  };

  const restart = async (p: Project) => {
    if (!(await confirm({ title: `docker compose restart — ${p.name}`, message: `Reiniciar todos os serviços de "${p.name}"?`, confirmLabel: 'Reiniciar' }))) return;
    await act(`${p.name}:restart`, () => run(`${base(p)} restart`, { timeout: 180000 }), `${p.name} reiniciado`);
    after();
  };

  const down = async (p: Project) => {
    if (!(await confirm({
      title: `docker compose down — ${p.name}`,
      message: `Parar e REMOVER os contêineres e redes de "${p.name}"?\n\nVolumes nomeados e bind mounts ficam. Os serviços só voltam com "up -d" (inclusive depois de reiniciar o Echo).`,
      confirmLabel: 'Derrubar',
      danger: true,
    }))) return;
    runStream({ title: `compose down · ${p.name}`, command: `${base(p)} down`, onDone: after });
  };

  if (!poll.data && poll.loading) return <Loading />;

  return (
    <>
      <div className="row gap-s between">
        <span className="muted small">Projetos do <code>docker compose ls -a</code>. Os comandos rodam no diretório do projeto com os mesmos arquivos (-f).</span>
        <RefreshButton onClick={after} loading={poll.loading} lastUpdated={poll.lastUpdated} />
      </div>
      <ErrorBox error={poll.error} onRetry={poll.refresh} />
      {projects.length === 0 && !poll.loading && <Empty>Nenhum projeto compose</Empty>}
      {projects.map((p) => {
        const st = parseStatus(liveStatus(p));
        const cs = byProject[p.name] ?? [];
        return (
          <div key={p.name} ref={(el) => { refs.current[p.name] = el; }} className={focus === p.name ? 'dk-focus' : ''}>
            <Card pad={false} icon={<Layers size={15} />}
              title={<span className="row gap-s">{p.name}
                {st.parts.length
                  ? st.parts.map(([s, n]) => <Badge key={s} tone={s === 'running' ? st.tone : s === 'exited' ? 'muted' : 'warn'}>{STATUS_PT[s] ?? s} ({n})</Badge>)
                  : <Badge tone="muted">{p.status || 'sem status'}</Badge>}
              </span>}
              actions={<>
                <Button size="s" icon={<ArrowUpFromLine size={13} />} onClick={() => up(p)} disabled={!p.files.length}>Up -d</Button>
                <Button size="s" icon={<RotateCw size={13} />} onClick={() => restart(p)} busy={busy === `${p.name}:restart`} disabled={!p.files.length}>Reiniciar</Button>
                <Button size="s" icon={<CloudDownload size={13} />} onClick={() => pull(p)} disabled={!p.files.length}>Pull</Button>
                <Button size="s" variant="danger" icon={<Square size={13} />} onClick={() => down(p)} disabled={!p.files.length}>Down</Button>
                <Button size="s" variant="ghost" icon={<FileText size={13} />} onClick={() => setFileView(p)} disabled={!p.files.length}>Arquivo</Button>
              </>}>
              <div className="dk-pad muted small row gap-s wrap">
                <span>Arquivos: {p.files.length ? p.files.map((f) => <code key={f}>{f} </code>) : '—'}</span>
                <span>· Diretório: <code>{workdir(p) || '—'}</code></span>
              </div>
              {cs.length === 0 ? <Empty>Nenhum contêiner (projeto derrubado?)</Empty> : (
                <div className="table-wrap">
                  <table className="table dk-table">
                    <thead><tr><th>Serviço</th><th>Contêiner</th><th>Estado</th><th>Status</th><th>Imagem</th></tr></thead>
                    <tbody>
                      {[...cs].sort((a, b) => a.service.localeCompare(b.service)).map((c) => (
                        <tr key={c.id} className="clickable" onClick={() => onOpen(c.name)}>
                          <td><strong>{c.service || '—'}</strong></td>
                          <td className="mono small">{c.name}</td>
                          <td><div className="row gap-s"><StateBadge state={c.state} status={c.status} /><HealthBadge health={c.health} /></div></td>
                          <td className="muted small">{c.status}</td>
                          <td className="mono small ellipsis dk-image" title={c.image}>{c.image}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        );
      })}
      <ComposeFileModal project={fileView} onClose={() => setFileView(null)} />
    </>
  );
}

function ComposeFileModal({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const [file, setFile] = useState<string>('');
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFile(project?.files[0] ?? '');
  }, [project]);

  useEffect(() => {
    if (!file) return;
    let alive = true;
    setContent(null);
    setError(null);
    echo.readFile(file)
      .then((t) => { if (alive) setContent(t); })
      .catch((e) => { if (alive) setError(errMsg(e)); });
    return () => { alive = false; };
  }, [file]);

  return (
    <Modal open={!!project} wide title={`Compose · ${project?.name ?? ''}`} onClose={onClose}
      footer={<>
        <span className="muted small grow">Somente leitura. Edite no Echo e use "Up -d" para aplicar.</span>
        {content != null && <CopyButton text={content} title="Copiar conteúdo" />}
        <Button onClick={onClose}>Fechar</Button>
      </>}>
      {project && project.files.length > 1 && (
        <Tabs<string> value={file} onChange={setFile} tabs={project.files.map((f) => ({ id: f, label: f.split('/').pop() ?? f }))} />
      )}
      <div className="mono small muted">{file}</div>
      <ErrorBox error={error} />
      {content == null && !error ? <Loading /> : content != null && <Pre maxHeight="65vh">{content}</Pre>}
    </Modal>
  );
}
