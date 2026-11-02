// Left column: log sources grouped (Sistema / Falhas / Containers).
import { ReactNode, useState } from 'react';
import { ChevronDown, ChevronRight, Container, Cpu, FileText, Flame, Terminal } from 'lucide-react';
import { fmtBytes } from '../../api';
import { Badge, Dot } from '../../components/ui';
import { CrashInfo, Discovery, systemSources } from './sources';

/** Records written while the RTC was unset carry a 2009/2010 mtime. */
export const CLOCK_OK_AFTER = 1420070400; // 2015-01-01

export function fmtWhen(epoch: number | undefined): string {
  if (!epoch) return '—';
  if (epoch < CLOCK_OK_AFTER) return 'sem data (relógio não ajustado)';
  return new Date(epoch * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function containerTone(state: string): 'ok' | 'warn' | 'bad' | 'info' | 'muted' {
  switch (state) {
    case 'running': return 'ok';
    case 'restarting': return 'warn';
    case 'paused': return 'info';
    case 'dead': return 'bad';
    default: return 'muted';
  }
}

export function crashTags(c: CrashInfo): { label: string; tone: 'bad' | 'warn' | 'muted' }[] {
  const t: { label: string; tone: 'bad' | 'warn' | 'muted' }[] = [];
  if (c.panic) t.push({ label: 'panic', tone: 'bad' });
  if (c.oops) t.push({ label: 'oops', tone: 'bad' });
  if (c.watchdog) t.push({ label: 'watchdog', tone: 'warn' });
  if (c.hung) t.push({ label: 'travamento', tone: 'warn' });
  if (c.reboot && !c.panic) t.push({ label: 'reboot', tone: 'muted' });
  return t;
}

function Group({ title, count, children, defaultOpen = true }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="logs-group">
      <button className="logs-group-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{title}</span>
        {count != null && <span className="logs-count">{count}</span>}
      </button>
      {open && <div className="logs-group-body">{children}</div>}
    </div>
  );
}

function Item({ active, disabled, icon, label, right, sub, title, onClick }: {
  active: boolean; disabled?: boolean; icon: ReactNode; label: ReactNode; right?: ReactNode; sub?: ReactNode; title?: string; onClick: () => void;
}) {
  return (
    <button className={`logs-src ${active ? 'active' : ''} ${disabled ? 'dim' : ''}`} onClick={onClick} title={title}>
      <span className="logs-src-icon">{icon}</span>
      <span className="logs-src-main">
        <span className="logs-src-label">{label}</span>
        {sub && <span className="logs-src-sub">{sub}</span>}
      </span>
      {right && <span className="logs-src-right">{right}</span>}
    </button>
  );
}

export function SourceList({ disc, selected, onSelect, loading }: { disc: Discovery | null; selected: string; onSelect: (id: string) => void; loading: boolean }) {
  const sys = systemSources(disc);
  return (
    <nav className="logs-sources">
      <Group title="Sistema">
        {sys.map((s) => (
          <Item
            key={s.id}
            active={selected === s.id}
            disabled={s.missing}
            icon={s.kind === 'dmesg' ? <Cpu size={14} /> : s.kind === 'logread' ? <Terminal size={14} /> : <FileText size={14} />}
            label={s.label}
            right={s.missing ? <span className="muted">{s.kind === 'logread' ? 'inativo' : 'ausente'}</span> : s.info ? fmtBytes(s.info.size) : null}
            title={s.kind === 'logread' && s.missing ? 'syslogd não está rodando (logread sem buffer)' : s.path}
            onClick={() => onSelect(s.id)}
          />
        ))}
      </Group>

      <Group title="Falhas" count={disc?.crashes.length}>
        {!disc && loading && <div className="logs-note">Carregando…</div>}
        {disc && disc.crashes.length === 0 && <div className="logs-note">Nenhum registro de crash</div>}
        {disc?.crashes.map((c) => (
          <Item
            key={c.file}
            active={selected === `crash:${c.file}`}
            icon={<Flame size={14} />}
            label={<>#{c.num} <span className="muted small">{fmtBytes(c.size)}</span></>}
            sub={
              <>
                <span>{fmtWhen(c.mtime)}</span>
                {crashTags(c).map((t) => <Badge key={t.label} tone={t.tone}>{t.label}</Badge>)}
              </>
            }
            title={c.file}
            onClick={() => onSelect(`crash:${c.file}`)}
          />
        ))}
      </Group>

      <Group title="Containers" count={disc?.containers.length}>
        {disc?.dockerError && <div className="logs-note" title={disc.dockerError}>Docker indisponível</div>}
        {disc && !disc.dockerError && disc.containers.length === 0 && <div className="logs-note">Nenhum container</div>}
        {disc?.containers.map((c) => (
          <Item
            key={c.name}
            active={selected === `container:${c.name}`}
            icon={<Container size={14} />}
            label={<span className="row gap-s"><Dot tone={containerTone(c.state)} /><span className="ellipsis">{c.name}</span></span>}
            sub={c.status}
            title={`${c.name} — ${c.status}`}
            onClick={() => onSelect(`container:${c.name}`)}
          />
        ))}
      </Group>
    </nav>
  );
}
