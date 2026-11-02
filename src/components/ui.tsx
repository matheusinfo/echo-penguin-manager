// Shared UI building blocks. Every page should use these so the app looks like one thing.
import { ReactNode, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle, Inbox } from 'lucide-react';

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {subtitle && <div className="page-sub">{subtitle}</div>}
        </div>
        {actions && <div className="row gap-s">{actions}</div>}
      </header>
      <div className="page-body">{children}</div>
    </div>
  );
}

export function Card({ title, icon, actions, children, className = '', pad = true }: { title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div className="card-title">{icon}{title}</div>
          {actions && <div className="row gap-s">{actions}</div>}
        </div>
      )}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function Grid({ cols = 3, children, min }: { cols?: number; children: ReactNode; min?: number }) {
  const style = min ? { gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` } : { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
  return <div className="grid" style={style}>{children}</div>;
}

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

export function Badge({ tone = 'muted', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge tone-${tone}`} title={title}>{children}</span>;
}

export function Dot({ tone = 'muted' }: { tone?: Tone }) {
  return <span className={`dot tone-${tone}`} />;
}

export function Stat({ label, value, sub, tone, icon }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; icon?: ReactNode }) {
  return (
    <div className={`stat ${tone ? `tone-text-${tone}` : ''}`}>
      <div className="stat-label">{icon}{label}</div>
      <div className="stat-value">{value}</div>
      {sub != null && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** Horizontal meter 0..100 with automatic warn/bad colouring. */
export function Meter({ value, warn = 70, bad = 90, label, right, tone: fixedTone }: { value: number | null | undefined; warn?: number; bad?: number; label?: ReactNode; right?: ReactNode; /** fixed colour instead of warn/bad thresholds */ tone?: Tone }) {
  const v = value == null || isNaN(value) ? 0 : Math.max(0, Math.min(100, value));
  const tone = fixedTone ?? (v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok');
  return (
    <div className="meter-wrap">
      {(label || right) && (
        <div className="meter-labels"><span>{label}</span><span className="muted">{right}</span></div>
      )}
      <div className="meter"><div className={`meter-fill tone-bg-${tone}`} style={{ width: `${v}%` }} /></div>
    </div>
  );
}

/** Tiny line chart for a numeric series. */
export function Sparkline({ data, height = 40, max, min = 0, tone = 'info' }: { data: number[]; height?: number; max?: number; min?: number; tone?: Tone }) {
  const w = 200;
  if (data.length < 2) return <svg className="spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }} />;
  const hi = max ?? Math.max(...data, min + 1);
  const span = hi - min || 1;
  const pts = data.map((d, i) => [(i / (data.length - 1)) * w, height - ((d - min) / span) * (height - 4) - 2]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${height} L0,${height} Z`;
  return (
    <svg className={`spark tone-stroke-${tone}`} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }}>
      <path d={area} className="spark-area" />
      <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Button({ children, onClick, variant = 'default', size = 'm', disabled, busy, icon, title, type = 'button' }: {
  children?: ReactNode; onClick?: () => void; variant?: 'default' | 'primary' | 'danger' | 'ghost'; size?: 's' | 'm';
  disabled?: boolean; busy?: boolean; icon?: ReactNode; title?: string; type?: 'button' | 'submit';
}) {
  return (
    <button type={type} className={`btn btn-${variant} btn-${size}`} onClick={onClick} disabled={disabled || busy} title={title}>
      {busy ? <Loader2 size={14} className="spin" /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function RefreshButton({ onClick, loading, lastUpdated }: { onClick: () => void; loading?: boolean; lastUpdated?: number | null }) {
  return (
    <div className="row gap-s">
      {lastUpdated && <span className="muted small">atualizado {new Date(lastUpdated).toLocaleTimeString()}</span>}
      <Button size="s" variant="ghost" onClick={onClick} icon={<RefreshCw size={14} className={loading ? 'spin' : ''} />} title="Atualizar" />
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string | null | undefined; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="errorbox">
      <AlertTriangle size={16} />
      <span className="grow">{error}</span>
      {onRetry && <Button size="s" onClick={onRetry}>Tentar de novo</Button>}
    </div>
  );
}

export function Loading({ label = 'Carregando…' }: { label?: string }) {
  return <div className="loading"><Loader2 size={16} className="spin" /> {label}</div>;
}

export function Empty({ children = 'Nada aqui' }: { children?: ReactNode }) {
  return <div className="empty"><Inbox size={18} /> {children}</div>;
}

/** Key/value list. */
export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} className="kv-row"><dt>{k}</dt><dd>{v ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

/** Pre-formatted output block with optional auto-scroll to bottom. */
export function Pre({ children, autoScroll = false, maxHeight, className = '' }: { children: ReactNode; autoScroll?: boolean; maxHeight?: number | string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  // Follow the bottom only while the user is already there; scrolling up pauses it.
  const atBottom = useRef(true);
  useEffect(() => {
    if (autoScroll && atBottom.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
  const onScroll = () => {
    const el = ref.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return <pre ref={ref} className={`pre ${className}`} style={{ maxHeight }} onScroll={onScroll}>{children}</pre>;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode }) {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track"><span className="switch-thumb" /></span>
      {label && <span>{label}</span>}
    </label>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Filtrar…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input className="input search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/** Modal dialog. */
export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`}>
        <div className="modal-head"><h3>{title}</h3><button className="btn btn-ghost btn-s" onClick={onClose}>✕</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Small inline copy-to-clipboard. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: (text: string) => {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    },
  };
}

/** Requires an active connection; shows a friendly placeholder otherwise. */
export function NeedsConnection({ connected, children }: { connected: boolean; children: ReactNode }) {
  if (connected) return <>{children}</>;
  return <Empty>Sem conexão com o Echo. Conecte-se pela barra lateral.</Empty>;
}

export function toneFor(value: number | null | undefined, warn: number, bad: number): Tone {
  if (value == null || isNaN(value)) return 'muted';
  return value >= bad ? 'bad' : value >= warn ? 'warn' : 'ok';
}
