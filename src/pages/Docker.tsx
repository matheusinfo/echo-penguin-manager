// Docker page: containers, compose projects, images, volumes/networks and cleanup on the Echo.
import { useEffect, useMemo, useRef, useState } from 'react';
import { run } from '../api';
import { useApp, usePoll, useStored } from '../hooks';
import { Badge, NeedsConnection, Page, RefreshButton, Tabs } from '../components/ui';
import { isDockerName, parseJsonLines, parseStats, StatRow, StreamJob, StreamModal, toContainer } from './docker/common';
import ContainersTab, { DetailTab } from './docker/Containers';
import ContainerDetails from './docker/ContainerDetails';
import ComposeTab from './docker/Compose';
import ImagesTab from './docker/Images';
import VolumesNetworksTab from './docker/VolumesNetworks';
import CleanupTab from './docker/Cleanup';
import './Docker.css';

type MainTab = 'containers' | 'compose' | 'images' | 'storage' | 'system';
const MAIN_TABS: MainTab[] = ['containers', 'compose', 'images', 'storage', 'system'];

export default function DockerPage() {
  const { connected, config, pageParams } = useApp();
  const [tab, setTab] = useState<MainTab>('containers');
  const [detail, setDetail] = useState<{ name: string; tab: DetailTab } | null>(null);
  const [job, setJob] = useState<StreamJob | null>(null);
  const [focusProject, setFocusProject] = useState<string | null>(null);
  const [statsOn, setStatsOn] = useStored<boolean>('docker.stats', true);

  const refreshMs = Math.max(2, config?.refreshSeconds ?? 5) * 1000;

  const containers = usePoll(async () => {
    const out = await run(`docker ps -a --no-trunc --format '{{json .}}'`, { timeout: 20000 });
    return parseJsonLines<Record<string, unknown>>(out).map(toContainer);
  }, refreshMs);

  // docker stats --no-stream takes seconds on the Echo: separate, slower poll, only while someone looks at it
  // (the table, or the "Resumo" tab of the details modal — not its logs/exec/json tabs).
  const wantStats = statsOn && (detail ? detail.tab === 'resumo' : tab === 'containers');
  const statsRef = useRef<Record<string, StatRow> | null>(null);
  const stats = usePoll(async () => {
    if (!wantStats) return statsRef.current;
    const out = await run(`docker stats --no-stream --format '{{json .}}'`, { timeout: 45000 });
    statsRef.current = parseStats(out);
    return statsRef.current;
  }, wantStats ? Math.max(15000, refreshMs * 3) : null, [wantStats]);

  // Deep links: navigate('docker', { container: 'name', tab: 'logs' }) or { tab: 'images' }.
  useEffect(() => {
    const t = pageParams?.tab as MainTab | undefined;
    // The name ends up in docker commands (quoted with shq): still refuse anything that is not a valid docker name.
    if (isDockerName(pageParams?.container)) {
      setTab('containers');
      const dt = (['resumo', 'logs', 'exec', 'json'] as DetailTab[]).includes(t as unknown as DetailTab) ? (t as unknown as DetailTab) : 'resumo';
      setDetail({ name: pageParams.container, tab: dt });
    } else if (t && MAIN_TABS.includes(t)) {
      setTab(t);
    }
  }, [pageParams]);

  const list = containers.data;
  const counts = useMemo(() => {
    const c = { running: 0, stopped: 0, paused: 0, unhealthy: 0, restarting: 0, projects: new Set<string>() };
    for (const x of list ?? []) {
      if (x.state === 'running') c.running++;
      else if (x.state === 'paused') c.paused++;
      else if (x.state === 'restarting') c.restarting++;
      else c.stopped++;
      if (x.health === 'unhealthy') c.unhealthy++;
      if (x.project) c.projects.add(x.project);
    }
    return c;
  }, [list]);

  const openDetails = (name: string, t: DetailTab = 'resumo') => setDetail({ name, tab: t });
  const goProject = (p: string) => { setFocusProject(p); setTab('compose'); };
  const runStream = (j: StreamJob) => setJob(j);

  const subtitle = list ? (
    <span className="row gap-s wrap">
      <Badge tone="ok">{counts.running} rodando</Badge>
      {counts.stopped > 0 && <Badge tone="muted">{counts.stopped} parado(s)</Badge>}
      {counts.paused > 0 && <Badge tone="warn">{counts.paused} pausado(s)</Badge>}
      {counts.restarting > 0 && <Badge tone="warn">{counts.restarting} reiniciando</Badge>}
      {counts.unhealthy > 0 && <Badge tone="bad">{counts.unhealthy} não saudável(is)</Badge>}
      <span className="muted small">{list.length} contêiner(es) · {counts.projects.size} projeto(s) compose</span>
    </span>
  ) : 'Contêineres, compose, imagens e limpeza';

  const detailRow = detail ? list?.find((c) => c.name === detail.name) : undefined;
  const detailStat = detailRow ? (stats.data?.[detailRow.shortId] ?? stats.data?.[detailRow.name]) : undefined;

  return (
    <Page title="Docker" subtitle={subtitle}
      actions={connected && <RefreshButton onClick={containers.refresh} loading={containers.loading} lastUpdated={containers.lastUpdated} />}>
      <NeedsConnection connected={connected}>
        <Tabs<MainTab>
          value={tab}
          onChange={(t) => { setTab(t); if (t !== 'compose') setFocusProject(null); }}
          tabs={[
            { id: 'containers', label: `Contêineres${list ? ` (${list.length})` : ''}` },
            { id: 'compose', label: `Compose${list ? ` (${counts.projects.size})` : ''}` },
            { id: 'images', label: 'Imagens' },
            { id: 'storage', label: 'Volumes & redes' },
            { id: 'system', label: 'Limpeza / sistema' },
          ]}
        />
        {tab === 'containers' && (
          <ContainersTab
            list={list}
            error={containers.error}
            loading={containers.loading}
            refresh={containers.refresh}
            stats={stats.data}
            statsOn={statsOn}
            setStatsOn={setStatsOn}
            statsLoading={stats.loading}
            statsError={stats.error}
            onOpen={openDetails}
            onProject={goProject}
          />
        )}
        {tab === 'compose' && (
          <ComposeTab containers={list} refreshContainers={containers.refresh} runStream={runStream}
            onOpen={openDetails} focus={focusProject} intervalMs={Math.max(30000, refreshMs * 6)} />
        )}
        {tab === 'images' && <ImagesTab runStream={runStream} />}
        {tab === 'storage' && <VolumesNetworksTab containers={list} />}
        {tab === 'system' && <CleanupTab runStream={runStream} onChanged={containers.refresh} />}

        <ContainerDetails
          name={detail?.name ?? null}
          tab={detail?.tab ?? 'resumo'}
          onTab={(t) => setDetail((d) => (d ? { ...d, tab: t } : d))}
          row={detailRow}
          stat={detailStat}
          onClose={() => setDetail(null)}
          onChanged={containers.refresh}
        />
        <StreamModal job={job} onClose={() => setJob(null)} />
      </NeedsConnection>
    </Page>
  );
}
