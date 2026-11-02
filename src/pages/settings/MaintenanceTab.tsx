// Tab 4: A/B slots, supervisor restart, reboot (normal / bootloader), rollback, cleanup, weekly
// reboot schedule and the diagnostics export.
import { useEffect, useState } from 'react';
import { HardDrive, RefreshCw, Power, Usb, Undo2, Eraser, CalendarClock, Download, Search, Stethoscope } from 'lucide-react';
import { echo, errMsg, fmtDuration, run, runSections } from '../../api';
import { useApp, usePoll } from '../../hooks';
import { Badge, Button, Card, ErrorBox, Grid, KV, Loading, Pre, RefreshButton } from '../../components/ui';
import { FIREWALL_LOG, SETTINGS_FILE, WEEKDAYS, parseEffective } from './lib';
import { BOOTLOADER_CMD, usePenguinActions } from './actions';

interface Slot { name: string; state: string; desc: string }
interface MaintState {
  slotRaw: string;
  active: string;
  booted: string;
  slots: Slot[];
  effective: Record<string, string>;
  uptime: number;
  now: number[] | null; // Y M D h m s wday
}

async function loadMaint(): Promise<MaintState> {
  const s = await runSections({
    slot: 'slotctl status',
    eff: 'penguin settings',
    up: 'cut -d. -f1 /proc/uptime',
    now: "date '+%Y %m %d %H %M %S %w'",
  });
  const raw = s.slot ?? '';
  const slots: Slot[] = [];
  for (const l of raw.split('\n')) {
    const m = l.match(/^slot (\w+):\s*(.*)$/);
    if (!m) continue;
    const [state, ...rest] = m[2].split(/\s+—\s+/);
    slots.push({ name: m[1], state: state.trim(), desc: rest.join(' — ') });
  }
  const now = (s.now ?? '').trim().split(/\s+/).map(Number);
  return {
    slotRaw: raw,
    active: raw.match(/^active:\s*(\S+)/m)?.[1] ?? '',
    booted: raw.match(/^booted:\s*(\S+)/m)?.[1] ?? '',
    slots,
    effective: parseEffective(s.eff ?? ''),
    uptime: Number(s.up) || 0,
    now: now.length === 7 && now.every((n) => !isNaN(n)) ? now : null,
  };
}

function stateTone(st: string) {
  return st === 'good' ? 'ok' : st.startsWith('trial') ? 'warn' : st === 'bad' ? 'bad' : 'muted';
}

/** Next weekly restart (device local time), as text. */
function nextWeekly(day: string, hour: string, now: number[] | null): string {
  if (day === '' || !now) return '';
  const d = Number(day), h = Number(hour || 4);
  const [Y, M, D, hh, , , w] = now;
  let add = (d - w + 7) % 7;
  if (add === 0 && hh >= h) add = 7;
  const dt = new Date(Date.UTC(Y, M - 1, D + add, h));
  return `${WEEKDAYS[dt.getUTCDay()].toLowerCase()}, ${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')} às ${String(h).padStart(2, '0')}:00` +
    (add === 0 ? ' (hoje)' : add === 1 ? ' (amanhã)' : ` (em ${add} dias)`);
}

export default function MaintenanceTab({ onGoTab }: { onGoTab: (t: string) => void }) {
  const { confirm, toast } = useApp();
  const { data, error, loading, refresh, lastUpdated } = usePoll(loadMaint, 30000);
  const { busy, act, restartSupervisor, rebootEcho } = usePenguinActions(refresh);
  const [withSlot, setWithSlot] = useState(false);
  const [rolledBack, setRolledBack] = useState(false);
  // The preview remembers which --slot it was made for: the confirm must show what --yes removes.
  const cleanup = usePoll(async () => {
    const slot = withSlot;
    return { slot, out: await run(`penguin cleanup${slot ? ' --slot' : ''}`, { timeout: 90000 }) };
  }, null, [withSlot]);
  const preview = cleanup.data && cleanup.data.slot === withSlot ? cleanup.data.out : null;
  // Toggling --slot while a preview was still running: that refresh was skipped, run it now.
  const { data: cleanData, loading: cleanLoading, refresh: cleanRefresh } = cleanup;
  useEffect(() => {
    if (cleanData && cleanData.slot !== withSlot && !cleanLoading) cleanRefresh();
  }, [cleanData, cleanLoading, cleanRefresh, withSlot]);
  const [cleanOut, setCleanOut] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  if (!data) return error ? <ErrorBox error={error} onRetry={refresh} /> : <Loading />;

  const other = data.slots.find((s) => s.name !== data.booted);
  const canRollback = !!data.booted && other?.state === 'good';
  const day = data.effective.WEEKLY_REBOOT_DAY ?? '';
  const hour = data.effective.WEEKLY_REBOOT_HOUR ?? '4';

  const bootloader = async () => {
    if (!(await confirm({
      title: 'Reiniciar no bootloader (fastboot)',
      message: 'Executa "rebootto bootloader": o supervisor e o dockerd são parados e o Echo reinicia no modo fastboot do bootloader (LK).\n\n' +
        'O Echo NÃO volta sozinho ao sistema: fica esperando comandos pelo USB. Você vai precisar de um computador com cabo USB e fastboot — por exemplo "fastboot reboot" para voltar ao sistema, ou "fastboot flash boot …" para gravar uma imagem de boot.\n\n' +
        'O Echo Manager perde a conexão até o sistema voltar. Use só se for gravar uma imagem de boot (troca de kernel, recuperação).',
      confirmLabel: 'Reiniciar no fastboot', danger: true,
    }))) return;
    await act('bootloader', () => run(BOOTLOADER_CMD), 'Reiniciando no bootloader (fastboot)…');
  };

  const rollback = async () => {
    if (!other) return;
    if (!(await confirm({
      title: `Voltar para o slot ${other.name}`,
      message: `Executa "slotctl rollback": o slot atual (${data.booted}) é marcado como RUIM e o slot ${other.name} (${other.desc}) passa a ser o ativo no próximo boot.\n\n` +
        'Nada muda até reiniciar. Configurações, logs e containers em /data são mantidos. Voltar depois para o slot atual exige reinstalar (slotctl install) ou "slotctl switch" pela linha de comando.\n\n' +
        'Use quando a versão atual do sistema estiver com problema.',
      confirmLabel: 'Fazer rollback', danger: true,
    }))) return;
    const ok = await act('rollback', () => run('slotctl rollback'), `Slot ${data.booted} marcado como ruim; próximo boot: slot ${other.name}`);
    if (ok) setRolledBack(true);
    refresh();
  };

  const runCleanup = async () => {
    if (preview == null) return;
    if (!(await confirm({
      title: 'Limpar o que não é mais necessário',
      message: `Executa "penguin cleanup${withSlot ? ' --slot' : ''} --yes", que remove:\n\n${preview.trim() || '(veja a prévia)'}\n\n` +
        (withSlot ? 'Com --slot o slot antigo também é apagado: não haverá mais como voltar para ele.\n\n' : '') +
        'Isto não pode ser desfeito.',
      confirmLabel: 'Remover', danger: true,
    }))) return;
    await act('cleanup', async () => { setCleanOut(await run(`penguin cleanup${withSlot ? ' --slot' : ''} --yes`, { timeout: 300000 })); }, 'Limpeza concluída');
    cleanup.refresh();
    refresh();
  };

  const exportDiag = async () => {
    setExporting(true);
    try {
      const s = await runSections({
        'data e uptime': 'date; uptime',
        'release': 'cat /etc/techo5-release 2>/dev/null; uname -a',
        'penguin status': 'penguin status',
        'penguin settings': 'penguin settings',
        [SETTINGS_FILE]: `cat ${SETTINGS_FILE} 2>/dev/null`,
        'slotctl status': 'slotctl status',
        'penguin ssh': 'penguin ssh',
        'firewall.log': `tail -n 60 ${FIREWALL_LOG}`,
        'boot.log (tail 150)': 'tail -n 150 /run/boot.log',
        'supervisor.log (tail 150)': 'tail -n 150 /data/penguin/logs/supervisor.log',
        'docker.log (tail 80)': 'tail -n 80 /data/penguin/logs/docker.log',
        'docker ps -a': "docker ps -a --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'",
        'docker system df': 'docker system df',
        'free -m': 'free -m',
        'df -h': 'df -h',
        'ip addr': 'ip addr',
        'dmesg (tail 120)': 'dmesg | tail -n 120',
        'crash records': 'ls -la /data/techo5-linux/crash 2>/dev/null',
        'processos': 'ps -o pid,user,vsz,rss,stat,args 2>/dev/null || ps',
      }, { timeout: 90000 });
      const text = `Echo Manager — diagnóstico do Echo (gerado ${new Date().toLocaleString()})\n\n` +
        Object.entries(s).map(([k, v]) => `===== ${k} =====\n${v}\n`).join('\n');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');
      const path = await echo.app.saveText(`echo-diagnostico-${stamp}.txt`, text);
      if (path) toast(`Diagnóstico salvo em ${path}`, 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="col gap-m">
      <div className="row between">
        <div className="muted small">Atualizações vão para o slot inativo e são testadas antes de valerem (A/B com rollback automático).</div>
        <RefreshButton onClick={refresh} loading={loading} lastUpdated={lastUpdated} />
      </div>
      {error && <ErrorBox error={error} onRetry={refresh} />}

      <Grid cols={2}>
        <Card title="Slots do sistema (A/B)" icon={<HardDrive size={16} />}>
          {data.slots.length === 0 ? <Pre>{data.slotRaw || '(slotctl status sem saída)'}</Pre> : (
            <div className="col gap-s">
              <table className="table">
                <thead><tr><th>Slot</th><th>Estado</th><th>Versão</th><th /></tr></thead>
                <tbody>
                  {data.slots.map((s) => (
                    <tr key={s.name}>
                      <td className="mono"><b>{s.name}</b></td>
                      <td><Badge tone={stateTone(s.state)}>{s.state}</Badge></td>
                      <td className="small">{s.desc}</td>
                      <td className="right">
                        <div className="row gap-s" style={{ justifyContent: 'flex-end' }}>
                          {s.name === data.booted && <Badge tone="info">em uso</Badge>}
                          {s.name === data.active && <Badge tone="muted">próximo boot</Badge>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <span className="small muted">Ligado há {fmtDuration(data.uptime)}.</span>
            </div>
          )}
          {rolledBack && (
            <div className="st-callout warn" style={{ marginTop: 10 }}>
              <Undo2 size={16} />
              <div className="grow">Rollback feito: o próximo boot usa o slot {data.active}.</div>
              <Button size="s" variant="danger" busy={busy === 'reboot'} onClick={() => rebootEcho('Para iniciar no slot anterior após o rollback.')}>Reiniciar agora</Button>
            </div>
          )}
        </Card>

        <Card title="Reinício semanal" icon={<CalendarClock size={16} />}
          actions={<Button size="s" onClick={() => onGoTab('penguin')}>Alterar</Button>}>
          <KV items={[
            ['Agenda', day === '' ? <Badge tone="muted">desativado</Badge> : <span>toda {WEEKDAYS[Number(day)]?.toLowerCase() ?? `dia ${day}`} às {String(hour).padStart(2, '0')}:00</span>],
            ['Próximo', day === '' ? '—' : nextWeekly(day, hour, data.now)],
            ['Condição', <span className="small">só reinicia se estiver ligado há mais de 1 dia (agora: {fmtDuration(data.uptime)}){data.uptime <= 86400 && day !== '' ? ' — hoje não reiniciaria' : ''}</span>],
          ]} />
          <div className="field-hint" style={{ marginTop: 8 }}>WEEKLY_REBOOT_DAY / WEEKLY_REBOOT_HOUR, hora local do Echo. Mudanças valem após penguin restart.</div>
        </Card>
      </Grid>

      <Card title="Ações" icon={<Power size={16} />}>
        <div className="st-actions">
          <div className="st-action">
            <h4><RefreshCw size={15} />Reiniciar supervisor</h4>
            <p>"penguin restart": o supervisor relê as configurações. dockerd e containers continuam rodando.</p>
            <div><Button busy={busy === 'restart'} onClick={() => restartSupervisor()}>penguin restart</Button></div>
          </div>
          <div className="st-action danger">
            <h4><Power size={15} />Reiniciar o Echo</h4>
            <p>Reboot completo (~1–2 min). O Echo Manager reconecta automaticamente quando o SSH voltar.</p>
            <div><Button variant="danger" busy={busy === 'reboot'} onClick={() => rebootEcho()}>Reiniciar…</Button></div>
          </div>
          <div className="st-action danger">
            <h4><Usb size={15} />Bootloader (fastboot)</h4>
            <p>"rebootto bootloader": reinicia no fastboot e fica lá. Requer cabo USB e fastboot para sair.</p>
            <div><Button variant="danger" busy={busy === 'bootloader'} onClick={bootloader}>Reiniciar no fastboot…</Button></div>
          </div>
          <div className="st-action danger">
            <h4><Undo2 size={15} />Rollback de slot</h4>
            <p>"slotctl rollback": marca o slot atual como ruim e ativa o outro no próximo boot.{!canRollback && ' Indisponível: o outro slot não está "good".'}</p>
            <div><Button variant="danger" busy={busy === 'rollback'} disabled={!canRollback} onClick={rollback}>Voltar para o slot {other?.name ?? '?'}…</Button></div>
          </div>
          <div className="st-action">
            <h4><Stethoscope size={15} />Exportar diagnóstico</h4>
            <p>status, configurações, slots, SSH, logs (boot, supervisor, docker, firewall), containers e dmesg num .txt.</p>
            <div><Button icon={<Download size={14} />} busy={exporting} onClick={exportDiag}>Exportar…</Button></div>
          </div>
        </div>
      </Card>

      <Card title="Limpeza (penguin cleanup)" icon={<Eraser size={16} />}
        actions={<Button size="s" variant="ghost" icon={<Search size={14} />} busy={cleanup.loading} onClick={cleanup.refresh}>Verificar de novo</Button>}>
        <div className="col gap-s">
          <span className="small muted">Tarballs de rootfs já instalados, arquivos de teste, containers parados fora de projetos compose, imagens sem tag e o cache de build.</span>
          <label className="st-check">
            <input type="checkbox" checked={withSlot} onChange={(e) => setWithSlot(e.target.checked)} />
            incluir o slot antigo (--slot): libera só o /store e elimina o caminho de volta
          </label>
          {cleanup.error && <ErrorBox error={cleanup.error} onRetry={cleanup.refresh} />}
          {preview == null && !cleanup.error ? <Loading label="Verificando…" /> : preview != null && <Pre maxHeight={220}>{preview.trim()}</Pre>}
          <div>
            <Button variant="danger" icon={<Eraser size={14} />} busy={busy === 'cleanup'}
              disabled={!preview || /^\s*nothing\s*$/m.test(preview)} onClick={runCleanup}>
              Remover (--yes)…
            </Button>
          </div>
          {cleanOut != null && <Pre maxHeight={200}>{cleanOut.trim()}</Pre>}
        </div>
      </Card>
    </div>
  );
}
