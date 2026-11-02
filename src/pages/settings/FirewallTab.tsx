// Tab 3: LAN_PORTS and DOCKER_LAN, applying the firewall, its log and the live iptables rules.
import { useMemo, useState } from 'react';
import { Flame, Plus, Save, Undo2, ScrollText, ListChecks, Network } from 'lucide-react';
import { run, runSections } from '../../api';
import { useApp, usePoll } from '../../hooks';
import { Badge, Button, Card, ErrorBox, Loading, Pre, RefreshButton, Switch } from '../../components/ui';
import { DEFAULTS_FILE, FIREWALL_LOG, META_BY_KEY, isPort, parseConf, parseEffective, setCommand, tail, validateSetting } from './lib';
import { FIREWALL_CMD, usePenguinActions } from './actions';

interface FwState {
  effective: Record<string, string>;
  defaults: Record<string, string>;
  log: string;
  v4: string;
  v6: string;
  listening: { port: string; local: boolean }[];
}

async function loadFw(): Promise<FwState> {
  const s = await runSections({
    eff: 'penguin settings',
    defs: `cat ${DEFAULTS_FILE}`,
    log: `tail -n 80 ${FIREWALL_LOG} 2>/dev/null; true`,
    v4: 'iptables-legacy -w -S',
    v6: 'ip6tables-legacy -w -S',
    listen: 'netstat -tln 2>/dev/null; true',
  }, { timeout: 30000 });
  const listening = new Map<string, boolean>();
  for (const l of (s.listen ?? '').split('\n')) {
    const m = l.match(/^tcp6?\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s+LISTEN/);
    if (!m) continue;
    const local = /^(127\.|::1$|::ffff:127\.)/.test(m[1]);
    // A port is "only local" if every listener on it is on loopback.
    listening.set(m[2], (listening.get(m[2]) ?? true) && local);
  }
  return {
    effective: parseEffective(s.eff ?? ''),
    defaults: parseConf(s.defs ?? ''),
    log: s.log ?? '',
    v4: s.v4 ?? '',
    v6: s.v6 ?? '',
    listening: Array.from(listening, ([port, local]) => ({ port, local })).sort((a, b) => Number(a.port) - Number(b.port)),
  };
}

function chainLines(rules: string, chain: string): string {
  if (chain === 'all') return rules;
  const re = new RegExp(`^-[ANP] ${chain}( |$)|-j ${chain}( |$)`);
  return rules.split('\n').filter((l) => re.test(l)).join('\n');
}

export default function FirewallTab() {
  const { confirm, toast } = useApp();
  const { data, error, loading, refresh, lastUpdated } = usePoll(loadFw, null);
  const { busy, act } = usePenguinActions(refresh);
  const [ports, setPorts] = useState<string[] | null>(null);
  const [dockerLan, setDockerLan] = useState<string | null>(null);
  const [newPort, setNewPort] = useState('');
  const [chain, setChain] = useState('PENGUIN-IN');
  const [fam, setFam] = useState<'v4' | 'v6'>('v4');
  const [lastOut, setLastOut] = useState<string | null>(null);

  const curPorts = useMemo(() => (data?.effective.LAN_PORTS ?? '').split(/\s+/).filter(Boolean), [data]);
  if (!data) return error ? <ErrorBox error={error} onRetry={refresh} /> : <Loading />;

  const draftPorts = ports ?? curPorts;
  const draftLan = dockerLan ?? data.effective.DOCKER_LAN ?? '0';
  const portsStr = draftPorts.join(' ');
  const portsChanged = portsStr !== curPorts.join(' ');
  const lanChanged = draftLan !== (data.effective.DOCKER_LAN ?? '0');
  const dirty = portsChanged || lanChanged;

  const addPort = (p: string) => {
    const v = p.trim();
    if (!isPort(v)) return toast(`"${v}" não é uma porta (1–65535)`, 'error');
    if (v === '22') return toast('A porta 22 (SSH) é controlada por SSH / SSH_ALLOW, não por LAN_PORTS', 'error');
    if (draftPorts.includes(v)) return;
    setPorts([...draftPorts, v].sort((a, b) => Number(a) - Number(b)));
    setNewPort('');
  };

  const saveApply = async () => {
    // LAN_PORTS may carry entries read back from the device: check the whole list before writing.
    const bad = (portsChanged && validateSetting(META_BY_KEY.LAN_PORTS, portsStr)) ||
      (lanChanged && validateSetting(META_BY_KEY.DOCKER_LAN, draftLan));
    if (bad) return toast(bad, 'error');
    const lines: string[] = [];
    if (portsChanged) lines.push(`• LAN_PORTS: ${curPorts.join(' ') || '(nenhuma)'} → ${portsStr || '(nenhuma)'}`);
    if (lanChanged) lines.push(`• DOCKER_LAN: ${data.effective.DOCKER_LAN} → ${draftLan} (${draftLan === '1' ? 'portas de containers ABERTAS no Wi-Fi' : 'portas de containers fechadas no Wi-Fi'})`);
    if (!(await confirm({
      title: 'Salvar e aplicar firewall',
      message: `${lines.join('\n')}\n\nGrava em settings.conf (penguin set) e executa "penguin firewall". Conexões já estabelecidas continuam.`,
      confirmLabel: 'Salvar e aplicar',
    }))) return;
    const ok = await act('save', async () => {
      const cmds: string[] = [];
      if (portsChanged) cmds.push(setCommand('LAN_PORTS', portsStr, data.defaults.LAN_PORTS));
      if (lanChanged) cmds.push(setCommand('DOCKER_LAN', draftLan, data.defaults.DOCKER_LAN));
      await run(cmds.join(' && '));
      setLastOut(await run(FIREWALL_CMD));
    }, 'Configurações salvas e firewall aplicado');
    if (ok) { setPorts(null); setDockerLan(null); }
    refresh();
  };

  const applyOnly = async () => {
    if (!(await confirm({
      title: 'Aplicar firewall',
      message: 'Executa "penguin firewall" com as configurações salvas (LAN_PORTS, DOCKER_LAN, SSH, SSH_ALLOW). Conexões já estabelecidas continuam.',
      confirmLabel: 'Aplicar',
    }))) return;
    await act('apply', async () => { setLastOut(await run(FIREWALL_CMD)); }, 'Firewall aplicado');
    refresh();
  };

  const rules = chainLines(fam === 'v4' ? data.v4 : data.v6, chain);
  const suggestions = data.listening.filter((l) => l.port !== '22' && !draftPorts.includes(l.port));

  return (
    <div className="col gap-m">
      <div className="row between">
        <div className="muted small">Entrada pelo Wi-Fi (wlan0) é fechada, exceto SSH (22) e as portas abaixo.</div>
        <RefreshButton onClick={refresh} loading={loading} lastUpdated={lastUpdated} />
      </div>
      {error && <ErrorBox error={error} onRetry={refresh} />}

      <Card title="Portas abertas no Wi-Fi (LAN_PORTS)" icon={<Network size={16} />}>
        <div className="col gap-m">
          <div className="st-chips">
            {draftPorts.length === 0 && <span className="muted small">Nenhuma porta extra aberta.</span>}
            {draftPorts.map((p) => (
              <span key={p} className={`st-chip ${curPorts.includes(p) ? '' : 'new'}`}>
                tcp {p}
                <button title="Remover" onClick={() => setPorts(draftPorts.filter((x) => x !== p))}>✕</button>
              </span>
            ))}
          </div>
          <div className="row gap-s">
            <input className="input mono" style={{ width: 140 }} placeholder="porta" value={newPort} inputMode="numeric"
              onChange={(e) => setNewPort(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addPort(newPort); }} />
            <Button icon={<Plus size={14} />} disabled={!newPort.trim()} onClick={() => addPort(newPort)}>Adicionar</Button>
          </div>
          {suggestions.length > 0 && (
            <div className="col gap-s">
              <span className="small muted">Portas TCP escutando no Echo agora (clique para adicionar):</span>
              <div className="st-chips">
                {suggestions.map((l) => (
                  <button key={l.port} className="st-suggest" onClick={() => addPort(l.port)}
                    title={l.local ? 'Só escuta em 127.0.0.1: abrir no firewall não adianta' : 'Escutando em todas as interfaces'}>
                    + {l.port}{l.local ? ' (só local)' : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
          <span className="field-hint">Portas de containers publicadas com -p são controladas por DOCKER_LAN abaixo, não por esta lista.</span>
        </div>
      </Card>

      <Card title="Portas dos containers (DOCKER_LAN)" icon={<Flame size={16} />}>
        <div className="col gap-s">
          <Switch checked={draftLan === '1'} onChange={(v) => setDockerLan(v ? '1' : '0')}
            label={draftLan === '1' ? 'Abertas no Wi-Fi (1)' : 'Fechadas no Wi-Fi (0)'} />
          <span className="small muted">
            0: portas publicadas (docker run -p) são recusadas vindas do Wi-Fi; acesse por túnel SSH (<code>ssh -L 8080:localhost:8080 …</code>).
            1: abertas para qualquer dispositivo do Wi-Fi.
          </span>
        </div>
      </Card>

      <div className="row gap-s">
        {dirty && <Button icon={<Undo2 size={14} />} onClick={() => { setPorts(null); setDockerLan(null); }}>Descartar</Button>}
        <Button variant="primary" icon={<Save size={14} />} disabled={!dirty} busy={busy === 'save'} onClick={saveApply}>Salvar e aplicar firewall</Button>
        <Button icon={<Flame size={14} />} busy={busy === 'apply'} onClick={applyOnly}>Aplicar firewall</Button>
        {dirty && <Badge tone="warn">alterações não salvas</Badge>}
      </div>
      {lastOut != null && <Card title="Saída de penguin firewall"><Pre maxHeight={160}>{lastOut.trim() || '(sem saída)'}</Pre></Card>}

      <Card title="Log do firewall" icon={<ScrollText size={16} />} actions={<span className="muted small mono">{FIREWALL_LOG}</span>}>
        <Pre maxHeight={220} autoScroll>{tail(data.log, 40) || '(vazio)'}</Pre>
      </Card>

      <Card title="Regras atuais (somente leitura)" icon={<ListChecks size={16} />}
        actions={<div className="row gap-s">
          <select className="input" value={fam} onChange={(e) => setFam(e.target.value as 'v4' | 'v6')}>
            <option value="v4">IPv4 (iptables-legacy)</option>
            <option value="v6">IPv6 (ip6tables-legacy)</option>
          </select>
          <select className="input" value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="PENGUIN-IN">PENGUIN-IN (Wi-Fi)</option>
            <option value="DOCKER-USER">DOCKER-USER</option>
            <option value="INPUT">INPUT</option>
            <option value="all">todas</option>
          </select>
        </div>}>
        <Pre maxHeight={360}>{rules || '(nenhuma regra nesta chain)'}</Pre>
      </Card>
    </div>
  );
}
