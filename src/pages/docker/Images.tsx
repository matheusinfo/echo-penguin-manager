// "Imagens" tab: local images (tagged + dangling), remove, and pull with streamed output.
import { FormEvent, useMemo, useState } from 'react';
import { CloudDownload, Trash } from 'lucide-react';
import { fmtBytes, run, runSections, shq } from '../../api';
import { useAction, useApp, usePoll } from '../../hooks';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, RefreshButton, SearchInput } from '../../components/ui';
import { CopyButton, fmtAgo, fmtDate, parseDockerDate, parseJsonLines, parseSize, StreamJob, str } from './common';

interface Img {
  key: string;
  repo: string;
  tag: string;
  id: string;
  size: number | null;
  sizeText: string;
  created: number | null;
  containers: number | null;
  dangling: boolean;
}

const NONE = '<none>';
const PLATFORMS = [
  { id: 'linux/arm/v7', label: 'linux/arm/v7 (recomendado)' },
  { id: 'linux/arm64', label: 'linux/arm64' },
  { id: '', label: 'padrão do daemon' },
];
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/;

export default function ImagesTab({ runStream }: { runStream: (job: StreamJob) => void }) {
  const { confirm } = useApp();
  const { busy, act } = useAction();
  const [q, setQ] = useState('');
  const [onlyDangling, setOnlyDangling] = useState(false);
  const [pullName, setPullName] = useState('');
  const [platform, setPlatform] = useState('linux/arm/v7');

  const poll = usePoll(async () => {
    const r = await runSections({
      tagged: `docker images --format '{{json .}}'`,
      dangling: `docker images -f dangling=true --format '{{json .}}'`,
    }, { timeout: 30000 });
    const out: Img[] = [];
    const seen = new Set<string>();
    const add = (o: Record<string, unknown>, dangling: boolean) => {
      const repo = str(o.Repository);
      const tag = str(o.Tag);
      const id = str(o.ID).replace(/^sha256:/, '').slice(0, 12);
      const key = `${repo}:${tag}@${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      const c = parseInt(str(o.Containers), 10);
      out.push({
        key, repo, tag, id,
        size: parseSize(o.Size), sizeText: str(o.Size),
        created: parseDockerDate(o.CreatedAt),
        containers: isNaN(c) ? null : c,
        dangling: dangling || (repo === NONE && tag === NONE),
      });
    };
    for (const o of parseJsonLines<Record<string, unknown>>(r.dangling)) add(o, true);
    for (const o of parseJsonLines<Record<string, unknown>>(r.tagged)) add(o, false);
    if (!out.length && /error|cannot|denied/i.test(`${r.tagged}`)) throw new Error(r.tagged.trim());
    return out.sort((a, b) => Number(a.dangling) - Number(b.dangling) || (b.created ?? 0) - (a.created ?? 0));
  }, null);

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (poll.data ?? []).filter((i) =>
      (!onlyDangling || i.dangling) && (!ql || `${i.repo}:${i.tag} ${i.id}`.toLowerCase().includes(ql)));
  }, [poll.data, q, onlyDangling]);

  const totals = useMemo(() => {
    const list = poll.data ?? [];
    const uniq = new Map<string, number>();
    for (const i of list) if (i.size != null) uniq.set(i.id, i.size);
    return {
      count: list.length,
      dangling: list.filter((i) => i.dangling).length,
      size: [...uniq.values()].reduce((a, b) => a + b, 0),
    };
  }, [poll.data]);

  const remove = async (i: Img) => {
    const ref = i.dangling || i.repo === NONE ? i.id : `${i.repo}:${i.tag}`;
    const sameId = (poll.data ?? []).filter((x) => x.id === i.id).length;
    const ok = await confirm({
      title: 'Remover imagem',
      message: `Remover "${ref}" (${i.sizeText})?` +
        (sameId > 1 && !i.dangling ? `\n\nOutras tags apontam para a mesma imagem (${i.id}); só esta tag é removida.` : '') +
        (i.containers ? `\n\n${i.containers} contêiner(es) usam esta imagem — o Docker recusa a remoção enquanto existirem.` : ''),
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    await act(`rmi:${i.key}`, () => run(`docker rmi ${shq(ref)}`, { timeout: 60000 }), `Imagem ${ref} removida`);
    poll.refresh();
  };

  const pull = (e: FormEvent) => {
    e.preventDefault();
    const name = pullName.trim();
    if (!NAME_RE.test(name)) return;
    runStream({
      title: `docker pull ${name}`,
      command: `docker pull ${platform ? `--platform ${platform} ` : ''}${shq(name)}`,
      note: <>O Echo tem userland de 32 bits: prefira imagens com variante <code>linux/arm/v7</code>. Pull grande pode demorar e ocupa espaço em <code>/data</code>.</>,
      onDone: () => poll.refresh(),
    });
  };

  return (
    <>
      <Card title="Baixar imagem (pull)" icon={<CloudDownload size={15} />}>
        <form className="row gap-s wrap dk-pull" onSubmit={pull}>
          <Field label="Imagem">
            <input className="input mono" value={pullName} onChange={(e) => setPullName(e.target.value)} placeholder="ex.: alpine:3.20, ghcr.io/org/app:1.2" />
          </Field>
          <Field label="Plataforma">
            <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Field>
          <Button type="submit" variant="primary" icon={<CloudDownload size={14} />} disabled={!NAME_RE.test(pullName.trim())}>Baixar</Button>
        </form>
        {pullName.trim() && !NAME_RE.test(pullName.trim()) && <div className="small" style={{ color: 'var(--bad)', marginTop: 6 }}>Nome de imagem inválido.</div>}
      </Card>

      <Card pad={false}
        title={<span className="row gap-s">Imagens <span className="muted small">{totals.count} · {fmtBytes(totals.size)} (aprox.)</span>
          {totals.dangling > 0 && <Badge tone="warn">{totals.dangling} sem tag</Badge>}</span>}
        actions={<>
          <SearchInput value={q} onChange={setQ} placeholder="Filtrar imagens…" />
          <label className="row gap-s small"><input type="checkbox" checked={onlyDangling} onChange={(e) => setOnlyDangling(e.target.checked)} />só sem tag</label>
          <RefreshButton onClick={poll.refresh} loading={poll.loading} lastUpdated={poll.lastUpdated} />
        </>}>
        <ErrorBox error={poll.error} onRetry={poll.refresh} />
        {!poll.data && poll.loading ? <Loading /> : rows.length === 0 ? <Empty>Nenhuma imagem</Empty> : (
          <div className="table-wrap">
            <table className="table dk-table">
              <thead>
                <tr><th>Repositório</th><th>Tag</th><th>ID</th><th className="right">Tamanho</th><th>Criada</th><th>Uso</th><th className="right">Ações</th></tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.key}>
                    <td className="mono small">{i.repo === NONE ? <span className="muted">&lt;sem nome&gt;</span> : i.repo}</td>
                    <td className="mono small">{i.tag === NONE ? <span className="muted">—</span> : i.tag}</td>
                    <td className="mono small"><span className="row gap-s">{i.id}<CopyButton text={i.id} title="Copiar ID" /></span></td>
                    <td className="right mono small nowrap">{i.sizeText || '—'}</td>
                    <td className="small nowrap" title={fmtDate(i.created)}>{fmtAgo(i.created)}</td>
                    <td>
                      <div className="row gap-s">
                        {i.dangling && <Badge tone="warn" title="Sem tag (dangling): sobra de rebuilds">sem tag</Badge>}
                        {i.containers ? <Badge tone="ok">{i.containers} contêiner(es)</Badge> : i.containers === 0 ? <Badge tone="muted">sem uso</Badge> : null}
                      </div>
                    </td>
                    <td className="right">
                      <Button size="s" variant="ghost" icon={<Trash size={14} />} title="Remover imagem" busy={busy === `rmi:${i.key}`} onClick={() => remove(i)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="muted small">
        Tamanhos compartilham camadas, então o total é aproximado. O uso real de disco está na aba <strong>Limpeza / sistema</strong>.
      </div>
    </>
  );
}
