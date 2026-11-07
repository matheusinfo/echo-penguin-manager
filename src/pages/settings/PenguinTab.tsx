// Tab 1: every setting from /etc/penguin/defaults.conf as a form row, diff-based save, raw editor.
import { useEffect, useMemo, useState } from 'react';
import { FileText, RotateCcw, Save, Undo2, Info, TriangleAlert, Power, RefreshCw, Flame } from 'lucide-react';
import { echo, errMsg, run, runSections } from '../../api';
import { useApp, usePoll } from '../../hooks';
import { Badge, Button, Card, ErrorBox, Loading, Modal, RefreshButton, Switch } from '../../components/ui';
import {
  APPLY_LABEL, ApplyKind, DEFAULTS_FILE, META_BY_KEY, SETTINGS_FILE, SETTINGS_META, SettingMeta,
  addrKind, normValue, parseConf, parseEffective, removeCommand, setCommand, unsafeValue, validateSetting,
} from './lib';
import { usePenguinActions } from './actions';

interface Loaded {
  effective: Record<string, string>;
  defaults: Record<string, string>;
  overrides: Record<string, string>;
  keys: string[];
}

export async function loadSettings(): Promise<Loaded> {
  const s = await runSections({
    eff: 'penguin settings',
    defs: `cat ${DEFAULTS_FILE}`,
    conf: `cat ${SETTINGS_FILE} 2>/dev/null; true`,
  });
  const defaults = parseConf(s.defs ?? '');
  const effective = parseEffective(s.eff ?? '');
  if (!Object.keys(effective).length) throw new Error((s.eff || 'penguin settings não retornou nada').trim());
  const keys = Object.keys(defaults);
  return { effective, defaults, overrides: parseConf(s.conf ?? ''), keys };
}

const tone = (a: ApplyKind) => (a === 'boot' ? 'warn' : a === 'ssh' ? 'info' : 'muted') as 'warn' | 'info' | 'muted';

export default function PenguinTab({ onGoTab }: { onGoTab: (t: string) => void }) {
  const { confirm, toast } = useApp();
  const { data, error, loading, refresh, lastUpdated } = usePoll(loadSettings, null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ kinds: ApplyKind[]; keys: string[] } | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const { busy, act, restartSupervisor, applyFirewall, rebootEcho } = usePenguinActions(refresh);

  const metas: SettingMeta[] = useMemo(() => {
    if (!data) return [];
    const known = SETTINGS_META.filter((m) => data.keys.includes(m.key));
    // Settings in the image this app does not know yet: plain text rows.
    const unknown = data.keys.filter((k) => !META_BY_KEY[k]).map<SettingMeta>((k) => ({
      key: k, label: k, group: 'Outras', kind: 'text', apply: 'restart',
      desc: 'Configuração da imagem sem descrição neste app (veja /etc/penguin/defaults.conf).',
    }));
    return [...known, ...unknown];
  }, [data]);

  const value = (k: string) => drafts[k] ?? data?.effective[k] ?? '';
  const changes = useMemo(() => {
    if (!data) return [];
    return metas
      .filter((m) => !m.managedBy && drafts[m.key] !== undefined && normValue(m, drafts[m.key]) !== (data.effective[m.key] ?? ''))
      .map((m) => ({ meta: m, from: data.effective[m.key] ?? '', to: normValue(m, drafts[m.key]) }));
  }, [data, drafts, metas]);
  const allValues = useMemo(() => {
    const o: Record<string, string> = { ...(data?.effective ?? {}) };
    for (const c of changes) o[c.meta.key] = c.to;
    return o;
  }, [data, changes]);
  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    for (const c of changes) {
      const err = validateSetting(c.meta, c.to, allValues);
      if (err) e[c.meta.key] = err;
    }
    return e;
  }, [changes, allValues]);

  if (!data) return error ? <ErrorBox error={error} onRetry={refresh} /> : <Loading />;

  const groups = Array.from(new Set(metas.map((m) => m.group)));
  const show = (v: string) => (v === '' ? '(vazio)' : v);

  const save = async () => {
    if (Object.keys(errors).length) return toast('Corrija os campos marcados antes de salvar', 'error');
    const kinds = Array.from(new Set(changes.map((c) => c.meta.apply)));
    const lines = changes.map((c) => {
      const back = c.to === data.defaults[c.meta.key] ? ' (volta ao padrão)' : '';
      return `• ${c.meta.key}: ${show(c.from)} → ${show(c.to)}${back}\n   vale ${APPLY_LABEL[c.meta.apply]}`;
    });
    const ok = await confirm({
      title: `Salvar ${changes.length} alteração(ões)`,
      message: `Será gravado em ${SETTINGS_FILE} (penguin set):\n\n${lines.join('\n')}\n\n` +
        (kinds.includes('restart') ? 'Depois: "penguin restart" para o supervisor reler.\n' : '') +
        (kinds.includes('firewall') ? 'Depois: "penguin firewall" para refazer as regras.\n' : '') +
        (kinds.includes('boot') ? 'Algumas só valem depois de reiniciar o Echo.\n' : ''),
      confirmLabel: 'Salvar',
    });
    if (!ok) return;
    const done = await act('save', () => {
      // setCommand refuses unsafe keys/values (throws, reported by act) before anything runs.
      for (const c of changes) {
        const err = validateSetting(c.meta, c.to, allValues);
        if (err) throw new Error(`${c.meta.key}: ${err}`);
      }
      return run(changes.map((c) => setCommand(c.meta.key, c.to, data.defaults[c.meta.key])).join(' && '));
    }, 'Configurações salvas');
    if (done) {
      setPending((p) => ({
        kinds: Array.from(new Set([...(p?.kinds ?? []), ...kinds])),
        keys: Array.from(new Set([...(p?.keys ?? []), ...changes.map((c) => c.meta.key)])),
      }));
      setDrafts({});
    }
    refresh();
  };

  const restore = async (m: SettingMeta) => {
    const ok = await confirm({
      title: `Restaurar padrão de ${m.key}`,
      message: `Remove a linha ${m.key}= de ${SETTINGS_FILE}.\n\nValor atual: ${show(data.effective[m.key] ?? '')}\nPadrão da imagem: ${show(data.defaults[m.key] ?? '')}\n\nVale ${APPLY_LABEL[m.apply]}.`,
      confirmLabel: 'Restaurar padrão',
    });
    if (!ok) return;
    const done = await act(`restore-${m.key}`, () => run(removeCommand(m.key)), `${m.key} voltou ao padrão`);
    if (done) {
      setDrafts((d) => { const n = { ...d }; delete n[m.key]; return n; });
      setPending((p) => ({ kinds: Array.from(new Set([...(p?.kinds ?? []), m.apply])), keys: Array.from(new Set([...(p?.keys ?? []), m.key])) }));
    }
    refresh();
  };

  return (
    <div className="col gap-m">
      <div className="row between wrap gap-s">
        <div className="muted small">
          Padrões em <code>{DEFAULTS_FILE}</code>; suas alterações ficam em <code>{SETTINGS_FILE}</code> e sobrevivem a atualizações.
        </div>
        <div className="row gap-s">
          <Button size="s" icon={<FileText size={14} />} onClick={() => setRawOpen(true)}>Editar settings.conf</Button>
          <RefreshButton onClick={refresh} loading={loading} lastUpdated={lastUpdated} />
        </div>
      </div>
      {error && <ErrorBox error={error} onRetry={refresh} />}

      {pending && (
        <div className="st-callout info">
          <Info size={16} />
          <div className="grow col gap-s">
            <div>Alterações salvas ({pending.keys.join(', ')}). Para entrarem em vigor:</div>
            <div className="row gap-s wrap">
              {pending.kinds.includes('restart') && (
                <Button size="s" variant="primary" icon={<RefreshCw size={14} />} busy={busy === 'restart'} onClick={() => restartSupervisor()}>penguin restart</Button>
              )}
              {pending.kinds.includes('firewall') && (
                <Button size="s" variant="primary" icon={<Flame size={14} />} busy={busy === 'firewall'} onClick={() => applyFirewall()}>penguin firewall</Button>
              )}
              {pending.kinds.includes('boot') && (
                <Button size="s" variant="danger" icon={<Power size={14} />} busy={busy === 'reboot'}
                  onClick={() => rebootEcho('Necessário para: ' + pending.keys.filter((k) => META_BY_KEY[k]?.apply === 'boot').join(', '))}>
                  Reiniciar o Echo
                </Button>
              )}
              {pending.kinds.includes('session') && <span className="small muted">SCREEN_MIRROR vale para as próximas sessões SSH/USB.</span>}
              {pending.kinds.includes('screen') && <span className="small muted">As de brilho valem em segundos: a tela as relê sozinha.</span>}
              <Button size="s" variant="ghost" onClick={() => setPending(null)}>Dispensar</Button>
            </div>
          </div>
        </div>
      )}

      {groups.map((g) => (
        <Card key={g} title={g}>
          {metas.filter((m) => m.group === g).map((m) => (
            <SettingRow
              key={m.key}
              meta={m}
              value={value(m.key)}
              effective={data.effective[m.key] ?? ''}
              def={data.defaults[m.key] ?? ''}
              overridden={m.key in data.overrides}
              error={errors[m.key]}
              busy={busy === `restore-${m.key}`}
              onChange={(v) => setDrafts((d) => ({ ...d, [m.key]: v }))}
              onReset={() => setDrafts((d) => { const n = { ...d }; delete n[m.key]; return n; })}
              onRestore={() => restore(m)}
              onGoTab={onGoTab}
            />
          ))}
        </Card>
      ))}

      {changes.length > 0 && (
        <div className="st-savebar">
          <strong>{changes.length} alteração(ões) não salvas</strong>
          <span className="muted small grow ellipsis">{changes.map((c) => c.meta.key).join(', ')}</span>
          <Button icon={<Undo2 size={14} />} onClick={() => setDrafts({})}>Descartar</Button>
          <Button variant="primary" icon={<Save size={14} />} busy={busy === 'save'} disabled={Object.keys(errors).length > 0} onClick={save}>Salvar alterações</Button>
        </div>
      )}

      <RawEditor open={rawOpen} onClose={() => setRawOpen(false)} known={data.keys} onSaved={() => { setDrafts({}); refresh(); }} />
    </div>
  );
}

function SettingRow({ meta, value, effective, def, overridden, error, busy, onChange, onReset, onRestore, onGoTab }: {
  meta: SettingMeta; value: string; effective: string; def: string; overridden: boolean; error?: string; busy: boolean;
  onChange: (v: string) => void; onReset: () => void; onRestore: () => void; onGoTab: (t: string) => void;
}) {
  const changed = normValue(meta, value) !== effective;
  const show = (v: string) => (v === '' ? '(vazio)' : v);
  let ctrl;
  if (meta.managedBy) {
    ctrl = (
      <>
        <code className="mono">{show(effective)}</code>
        <Button size="s" onClick={() => onGoTab(meta.key.startsWith('SSH') ? 'ssh' : 'firewall')}>Alterar em “{meta.managedBy}”</Button>
      </>
    );
  } else if (meta.kind === 'bool') {
    ctrl = <Switch checked={value === '1'} onChange={(v) => onChange(v ? '1' : '0')} label={value === '1' ? 'Ligado (1)' : 'Desligado (0)'} />;
  } else if (meta.kind === 'select') {
    const opts = meta.options ?? [];
    ctrl = (
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {!opts.some((o) => o.value === value) && <option value={value}>{show(value)} (atual)</option>}
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else if (meta.kind === 'int') {
    ctrl = (
      <div className="row gap-s">
        <input className="input" type="number" min={meta.min} max={meta.max} value={value} style={{ width: 160 }} onChange={(e) => onChange(e.target.value)} />
        {meta.unit && <span className="muted small">{meta.unit}</span>}
        {meta.min != null && meta.max != null && <span className="muted small">({meta.min}–{meta.max})</span>}
      </div>
    );
  } else {
    ctrl = <input className="input mono" value={value} placeholder={meta.kind === 'ports' ? 'ex.: 80 443' : ''} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className={`st-row ${changed ? 'changed' : ''}`}>
      <div>
        <div className="st-row-head">
          <span className="st-row-label">{meta.label}</span>
          <span className="st-row-key">{meta.key}</span>
          {overridden && <Badge tone="info" title="Definido em settings.conf">personalizado</Badge>}
          <Badge tone={tone(meta.apply)} title="Quando a mudança entra em vigor">{APPLY_LABEL[meta.apply]}</Badge>
        </div>
        <div className="st-row-desc">{meta.desc}</div>
        <div className="st-row-meta">
          <span>padrão: <code>{show(def)}</code></span>
          <span>atual: <code>{show(effective)}</code></span>
        </div>
        {meta.applyNote && <div className="st-row-meta">{meta.applyNote}</div>}
      </div>
      <div className="st-row-ctrl">
        {ctrl}
        {error && <span className="st-err">{error}</span>}
        <div className="row gap-s">
          {changed && !meta.managedBy && <Button size="s" variant="ghost" icon={<Undo2 size={13} />} onClick={onReset}>Desfazer</Button>}
          {overridden && !meta.managedBy && (
            <Button size="s" variant="ghost" icon={<RotateCcw size={13} />} busy={busy} onClick={onRestore} title="Remove a linha de settings.conf">Restaurar padrão</Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Line checks for the raw settings.conf editor. The file is sourced by busybox sh as root, so only
 * blank lines, comments and KEY="value" / KEY=value lines with harmless values are accepted.
 */
function checkRawConf(text: string, known: string[]): { line: number; msg: string; bad: boolean }[] {
  const out: { line: number; msg: string; bad: boolean }[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((l, i) => {
    if (/^[ \t]*(#.*)?$/.test(l)) return;
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(l)) return out.push({ line: i + 1, msg: 'contém caracteres de controle', bad: true });
    const m = l.match(/^[ \t]*([A-Z_][A-Z0-9_]*)=(.*?)[ \t]*$/);
    if (!m) return out.push({ line: i + 1, msg: 'não é KEY="valor"', bad: true });
    if (!known.includes(m[1])) out.push({ line: i + 1, msg: `${m[1]} não existe em defaults.conf (será ignorada)`, bad: false });
    if (seen.has(m[1])) out.push({ line: i + 1, msg: `${m[1]} repetida: vale a última`, bad: false });
    seen.add(m[1]);
    const v = m[2];
    const quoted = v.match(/^"(.*)"$/);
    if (quoted ? unsafeValue(quoted[1]) : !/^[A-Za-z0-9_.,:/@%+=-]*$/.test(v)) {
      return out.push({ line: i + 1, msg: 'valor deve estar entre aspas duplas, sem aspas internas, $, crase ou barra invertida', bad: true });
    }
    // Same checks as the form, as warnings (the device ignores what it cannot use).
    const val = quoted ? quoted[1] : v;
    const meta = META_BY_KEY[m[1]];
    if (m[1] === 'SSH_ALLOW') {
      const badAddr = val.split(/\s+/).filter(Boolean).find((a) => !addrKind(a));
      if (badAddr) out.push({ line: i + 1, msg: `SSH_ALLOW: "${badAddr}" não é um MAC, IP ou rede`, bad: false });
    } else if (meta) {
      const err = validateSetting(meta, normValue(meta, val));
      if (err) out.push({ line: i + 1, msg: `${m[1]}: ${err}`, bad: false });
    }
  });
  return out;
}

function RawEditor({ open, onClose, known, onSaved }: { open: boolean; onClose: () => void; known: string[]; onSaved: () => void }) {
  const { confirm, toast } = useApp();
  const [orig, setOrig] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const readConf = async () => {
    const r = await echo.exec(`cat ${SETTINGS_FILE} 2>/dev/null || true`);
    return r.stdout;
  };

  // Load each time it opens.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setOrig(null);
    setLoadErr(null);
    readConf()
      .then((t) => { if (alive) { setOrig(t); setText(t); } })
      .catch((e) => { if (alive) setLoadErr(errMsg(e)); });
    return () => { alive = false; };
  }, [open]);

  const issues = useMemo(() => checkRawConf(text, known), [text, known]);

  const sshChanged = useMemo(() => {
    if (orig == null) return false;
    const a = parseConf(orig), b = parseConf(text);
    return a.SSH !== b.SSH || a.SSH_ALLOW !== b.SSH_ALLOW;
  }, [orig, text]);

  const save = async () => {
    // Re-checked here, not only in the rendered list: the file is sourced by sh as root.
    if (checkRawConf(text, known).some((i) => i.bad)) return toast('Há linhas inválidas (marcadas em vermelho)', 'error');
    const ok = await confirm({
      title: 'Gravar settings.conf',
      message: `O arquivo ${SETTINGS_FILE} será substituído pelo conteúdo do editor.\n\n` +
        (sshChanged ? '⚠ SSH ou SSH_ALLOW mudaram. Aqui NÃO há a proteção contra se trancar para fora que "penguin ssh allow/deny" tem. Se a lista não incluir este computador, o próximo "penguin firewall" (ou boot) bloqueia o acesso — só a tela ou o console USB poderão desfazer.\n\n' : '') +
        'As mudanças valem conforme cada configuração (penguin restart, penguin firewall ou reiniciar).',
      confirmLabel: 'Gravar',
      danger: sshChanged,
    });
    if (!ok) return;
    setSaving(true);
    try {
      const now = await readConf();
      if (orig != null && now !== orig) {
        const over = await confirm({
          title: 'O arquivo mudou no Echo',
          message: 'settings.conf foi alterado no Echo desde que o editor foi aberto (por exemplo, pela tela ou por outra sessão). Gravar mesmo assim descarta essas mudanças.',
          confirmLabel: 'Sobrescrever', danger: true,
        });
        if (!over) return;
      }
      const content = text.endsWith('\n') || text === '' ? text : text + '\n';
      await run('mkdir -p /data/penguin');
      await echo.writeFile(SETTINGS_FILE, content);
      toast('settings.conf gravado', 'ok');
      onSaved();
      onClose();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} wide title={<>Editar <code>{SETTINGS_FILE}</code></>} onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" icon={<Save size={14} />} busy={saving} disabled={orig == null || text === orig} onClick={save}>Gravar</Button>
      </>}>
      {loadErr && <ErrorBox error={loadErr} />}
      {orig == null && !loadErr ? <Loading /> : (
        <>
          <div className="muted small">Uma configuração por linha, no formato <code>KEY="valor"</code>. Linhas iniciadas por # são comentários. O arquivo é lido pelo shell (busybox sh).</div>
          <textarea className="input" rows={16} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          {sshChanged && (
            <div className="st-callout bad"><TriangleAlert size={16} /><div>SSH/SSH_ALLOW alterados aqui não passam pela proteção contra bloqueio. Prefira a aba “Acesso SSH”.</div></div>
          )}
          {issues.map((i, n) => (
            <div key={n} className={i.bad ? 'st-err' : 'st-warn'}>Linha {i.line}: {i.msg}</div>
          ))}
        </>
      )}
    </Modal>
  );
}
