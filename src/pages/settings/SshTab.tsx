// Tab 2: `penguin ssh` status, the allow list (penguin ssh allow/deny), SSH on/off and authorized_keys.
import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Laptop, Plus, ShieldCheck, ShieldAlert, Trash, Power, TriangleAlert, LockOpen } from 'lucide-react';
import { echo, errMsg, run, runSections, shq } from '../../api';
import { useApp, usePoll } from '../../hooks';
import { Badge, Button, Card, Dot, Empty, ErrorBox, Grid, KV, Loading, Modal, RefreshButton } from '../../components/ui';
import { AUTH_KEYS, AuthKey, addrKind, parseAuthKeys, parseKeyLine, fingerprint, validatePublicKey } from './lib';

interface SshState {
  sshOn: boolean;
  running: boolean;
  allowed: string[];
  youIp: string;
  youMac: string;
  firewall: string;
  keys: AuthKey[];
  pubkeyInfo: string;
  raw: string;
}

async function loadSsh(): Promise<SshState> {
  const s = await runSections({
    st: 'penguin ssh',
    keys: `cat ${AUTH_KEYS} 2>/dev/null; true`,
    info: 'echo "${SSH_PUBKEYINFO:-}"',
  });
  const st = s.st ?? '';
  const field = (name: string) => st.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
  const sshLine = field('SSH');
  if (!sshLine) throw new Error(st.trim() || 'penguin ssh não retornou nada');
  const allowedLine = field('allowed');
  const you = field('you').split(/\s+/);
  return {
    sshOn: !/^off\b/.test(sshLine),
    running: /dropbear running/.test(sshLine),
    allowed: /^any device/.test(allowedLine) || !allowedLine ? [] : allowedLine.split(/\s+/),
    youIp: you[0] ?? '',
    youMac: (you[1] ?? '').toLowerCase(),
    firewall: field('firewall'),
    keys: await parseAuthKeys(s.keys ?? ''),
    pubkeyInfo: (s.info ?? '').trim(),
    raw: st,
  };
}

/** Whether an allow-list entry matches this computer (MAC, exact IP or an IPv4 network). */
function matchesYou(entry: string, ip: string, mac: string): boolean {
  if (mac && entry.toLowerCase() === mac) return true;
  if (entry === ip) return true;
  const m = entry.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (m && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const toN = (a: string) => a.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
    const bits = Number(m[2]);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (toN(m[1]) & mask) === (toN(ip) & mask);
  }
  return false;
}

const AUTH_DIR = AUTH_KEYS.slice(0, AUTH_KEYS.lastIndexOf('/'));

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** authorized_keys as it is now; null when the file does not exist (any other failure throws). */
async function readAuthKeys(): Promise<string | null> {
  const r = await echo.exec(`[ -e ${AUTH_KEYS} ] || exit 3; cat ${AUTH_KEYS}`);
  if (r.code === 3) return null;
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `não foi possível ler ${AUTH_KEYS}`);
  return r.stdout;
}

/**
 * Replaces authorized_keys atomically (tmp file with mode 600 + mv), only if it still is `before`
 * (null: still absent), and never with a file that has no key at all.
 */
async function writeAuthKeys(content: string, before: string | null): Promise<void> {
  if (!content.split('\n').some((l) => parseKeyLine(l))) throw new Error('Recusado: o arquivo ficaria sem nenhuma chave.');
  const unchanged = before == null
    ? '[ ! -e "$f" ]'
    : `[ "$(sha256sum < "$f" | cut -d' ' -f1)" = ${shq(await sha256Hex(before))} ]`;
  await run(
    `f=${AUTH_KEYS}; t="$f.echo-manager.tmp"; umask 077; mkdir -p ${AUTH_DIR} && chmod 700 ${AUTH_DIR} || exit 1
${unchanged} || { echo 'authorized_keys foi alterado no Echo enquanto isso; atualize e tente de novo' >&2; exit 3; }
cat > "$t" && chmod 600 "$t" && mv -f "$t" "$f" || { rm -f "$t"; exit 1; }`,
    { stdin: content },
  );
}

export default function SshTab() {
  const { confirm, toast } = useApp();
  const { data, error, loading, refresh, lastUpdated } = usePoll(loadSsh, null);
  const [busy, setBusy] = useState<string | null>(null);
  const [addr, setAddr] = useState('');
  const [withHere, setWithHere] = useState(true);
  const [newKey, setNewKey] = useState('');
  const [offOpen, setOffOpen] = useState(false);

  // Runs a penguin ssh command and shows its own message (it explains refusals itself).
  const doSsh = async (key: string, cmd: string) => {
    setBusy(key);
    try {
      const r = await echo.exec(cmd, { timeout: 30000 });
      const out = (r.stdout + '\n' + r.stderr).trim();
      if (r.code !== 0) toast(out || `falhou (código ${r.code})`, 'error');
      else toast(out.split('\n').filter((l) => !/^techo5-firewall|iptables/.test(l)).join('\n') || 'Feito', 'ok');
      return r.code === 0;
    } catch (e) {
      toast(errMsg(e), 'error');
      return false;
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const addrError = useMemo(() => {
    const a = addr.trim();
    if (!a) return null;
    if (!addrKind(a)) return 'não é um MAC (aa:bb:cc:dd:ee:ff), IP ou rede (192.168.1.0/24, IPv6)';
    if (data?.allowed.some((x) => x.toLowerCase() === a.toLowerCase())) return 'já está na lista';
    return null;
  }, [addr, data]);

  if (!data) return error ? <ErrorBox error={error} onRetry={refresh} /> : <Loading />;

  const youListed = data.allowed.some((a) => matchesYou(a, data.youIp, data.youMac));
  const listEmpty = data.allowed.length === 0;

  const allowAddr = async () => {
    const a = addr.trim();
    if (!a || addrError) return;
    const kind = addrKind(a);
    if (!kind) return;
    const norm = kind === 'MAC' ? a.toLowerCase() : a;
    const parts = [shq(norm)];
    if (listEmpty && withHere) parts.unshift('here');
    const msg = listEmpty
      ? `Hoje qualquer dispositivo do Wi-Fi pode tentar conectar. Depois disto SÓ ${withHere ? 'este computador e ' : ''}${norm} poderão.` +
        (withHere ? '' : '\n\nSe este computador não estiver incluído, o penguin recusa (proteção contra bloqueio).')
      : `${norm} será adicionado à lista de computadores permitidos.`;
    if (!(await confirm({ title: 'Permitir endereço', message: msg + '\n\nUma chave autorizada continua sendo necessária.', confirmLabel: 'Permitir' }))) return;
    if (await doSsh('allow', `penguin ssh allow ${parts.join(' ')}`)) setAddr('');
  };

  const allowHere = async () => {
    const msg = listEmpty
      ? `Hoje qualquer dispositivo do Wi-Fi pode tentar conectar. Depois disto, SÓ este computador (${data.youMac || data.youIp}) poderá — outros computadores precisarão ser adicionados aqui.`
      : `Adiciona este computador (${data.youMac || data.youIp}) à lista.`;
    if (!(await confirm({ title: 'Permitir este computador', message: msg + '\n\nO penguin usa o MAC (visto na tabela ARP) quando há um; senão o IP.', confirmLabel: 'Permitir' }))) return;
    await doSsh('here', 'penguin ssh allow here');
  };

  const deny = async (a: string) => {
    // The entry comes from the device: only ever pass penguin a well-formed address.
    if (!addrKind(a)) return toast(`"${a}" não é um MAC, IP ou rede válido; corrija SSH_ALLOW pelo console`, 'error');
    const mine = matchesYou(a, data.youIp, data.youMac);
    if (!(await confirm({
      title: `Remover ${a}`,
      message: `${a} não poderá mais conectar por SSH.` + (mine ? '\n\nEsta entrada corresponde a ESTE computador. Se nenhuma outra entrada o incluir, o penguin recusa a remoção (proteção contra bloqueio).' : ''),
      confirmLabel: 'Remover', danger: true,
    }))) return;
    await doSsh(`deny-${a}`, `penguin ssh deny ${shq(a)}`);
  };

  const allowAny = async () => {
    if (!(await confirm({
      title: 'Permitir qualquer dispositivo',
      message: 'Limpa a lista (SSH_ALLOW vazio): qualquer dispositivo na rede Wi-Fi poderá TENTAR conectar na porta 22.\n\nUma chave autorizada continua obrigatória (não há senha), mas a superfície de ataque aumenta. Recomendado só temporariamente.',
      confirmLabel: 'Permitir qualquer um', danger: true,
    }))) return;
    await doSsh('any', 'penguin ssh allow any');
  };

  const sshOn = async () => {
    await doSsh('on', 'penguin ssh on');
  };

  const sshOff = async () => {
    setOffOpen(false);
    const ok = await doSsh('off', 'penguin ssh off');
    if (ok) {
      toast('SSH desligado. O Echo Manager foi desconectado.', 'info');
      setTimeout(() => { echo.ssh.disconnect(); }, 1500);
    }
  };

  // --- Authorized keys.

  const myKeys = data.pubkeyInfo ? data.keys.filter((k) => k.comment === data.pubkeyInfo) : [];
  const isMine = (k: AuthKey) => myKeys.includes(k);
  const mineUnique = myKeys.length === 1;

  const removeKey = async (k: AuthKey) => {
    if (data.keys.length <= 1) return toast('Recusado: é a única chave. Sem nenhuma, o SSH não inicia mais e só o console USB/tela dão acesso.', 'error');
    if (isMine(k) && mineUnique) return toast('Recusado: esta é a chave que o Echo Manager está usando nesta conexão. Remova-a a partir de outro computador/chave.', 'error');
    const ok = await confirm({
      title: 'Remover chave autorizada',
      message: `${k.type} ${k.fingerprint ?? ''}\n${k.comment || '(sem comentário)'}\n\nO computador com esta chave não conseguirá mais entrar por SSH. Sessões já abertas continuam.` +
        (isMine(k) ? '\n\n⚠ ATENÇÃO: o comentário desta chave é igual ao da chave usada por esta conexão. Pode ser a chave do Echo Manager — se for, o app não conseguirá reconectar.' : ''),
      confirmLabel: 'Remover chave', danger: true,
    });
    if (!ok) return;
    setBusy(`key-${k.index}`);
    try {
      const fresh = await readAuthKeys();
      if (fresh == null) throw new Error('O arquivo authorized_keys não existe mais no Echo; atualize.');
      const lines = fresh.split('\n');
      // Exactly the chosen line: by its position when the file is unchanged, else by its full text.
      let idx = lines[k.index] === k.line ? k.index : -1;
      if (idx < 0) {
        const same = lines.flatMap((l, i) => (l === k.line ? [i] : []));
        if (same.length === 0) throw new Error('O arquivo authorized_keys mudou no Echo; atualize e tente de novo.');
        idx = same[0]; // identical lines: removing any of them gives the same file
      }
      lines.splice(idx, 1);
      await writeAuthKeys(lines.join('\n').replace(/\n*$/, '\n'), fresh);
      toast('Chave removida', 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const keyErr = newKey.trim() ? validatePublicKey(newKey) : null;
  const addKey = async () => {
    const line = newKey.trim();
    const err = validatePublicKey(line);
    if (err) return toast(err, 'error');
    const k = parseKeyLine(line)!;
    const fp = await fingerprint(k.blob);
    if (data.keys.some((x) => x.fingerprint === fp)) return toast('Esta chave já está autorizada', 'error');
    if (!(await confirm({
      title: 'Autorizar chave',
      message: `${k.type} ${fp}\n${k.comment || '(sem comentário)'}\n\nQuem tiver a chave privada correspondente poderá entrar como root (se o computador estiver na lista de permitidos).`,
      confirmLabel: 'Autorizar',
    }))) return;
    setBusy('addkey');
    try {
      const fresh = await readAuthKeys();
      const freshKeys = await parseAuthKeys(fresh ?? '');
      if (freshKeys.some((x) => x.fingerprint === fp)) throw new Error('Esta chave já está autorizada');
      const content = (fresh && fresh.trim() ? fresh.replace(/\n*$/, '\n') : '') + line + '\n';
      await writeAuthKeys(content, fresh);
      toast('Chave autorizada', 'ok');
      setNewKey('');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <div className="col gap-m">
      <div className="row between">
        <div className="muted small">Somente chaves (nenhuma senha funciona). Quem pode tentar conectar é decidido pelo firewall (SSH_ALLOW).</div>
        <RefreshButton onClick={refresh} loading={loading} lastUpdated={lastUpdated} />
      </div>
      {error && <ErrorBox error={error} onRetry={refresh} />}

      <Grid cols={2}>
        <Card title="Estado" icon={<ShieldCheck size={16} />}>
          <KV items={[
            ['SSH', <span className="row gap-s"><Dot tone={data.sshOn ? 'ok' : 'bad'} />{data.sshOn ? 'ligado' : 'desligado'} <span className="muted small">(dropbear {data.running ? 'rodando' : 'parado'})</span></span>],
            ['Você (este computador)', <span className="mono">{data.youIp} {data.youMac || <span className="muted">(sem MAC: fora do Wi-Fi local?)</span>}</span>],
            ['Firewall', <span className="small">{data.firewall || '—'}</span>],
            ['Chave desta conexão', data.pubkeyInfo ? <span className="mono">{data.pubkeyInfo}</span> : <span className="muted">não identificada</span>],
          ]} />
        </Card>
        <Card title="Ligar / desligar" icon={<Power size={16} />}>
          <div className="col gap-s">
            {data.sshOn ? (
              <>
                <div className="small muted">Desligar fecha a porta 22 e para o dropbear. Esta conexão cai em 2 s e o Echo Manager não poderá reconectar.</div>
                <div><Button variant="danger" icon={<Power size={14} />} busy={busy === 'off'} onClick={() => setOffOpen(true)}>Desligar SSH…</Button></div>
              </>
            ) : (
              <>
                <div className="small muted">SSH=off no settings.conf (o dropbear ainda atende esta sessão).</div>
                <div><Button variant="primary" icon={<Power size={14} />} busy={busy === 'on'} onClick={sshOn}>Ligar SSH</Button></div>
              </>
            )}
          </div>
        </Card>
      </Grid>

      <Card title="Computadores permitidos" icon={<Laptop size={16} />}
        actions={!listEmpty && <Button size="s" variant="danger" icon={<LockOpen size={14} />} busy={busy === 'any'} onClick={allowAny}>Permitir qualquer dispositivo</Button>}>
        <div className="col gap-m">
          {listEmpty ? (
            <div className="st-callout warn"><ShieldAlert size={16} /><div>Qualquer dispositivo na rede Wi-Fi pode tentar conectar (uma chave autorizada ainda é necessária). Restrinja aos seus computadores — de preferência por MAC.</div></div>
          ) : (
            <div>
              {data.allowed.map((a) => {
                const mine = matchesYou(a, data.youIp, data.youMac);
                return (
                  <div key={a} className="st-addr-row">
                    <code className="mono grow">{a}</code>
                    <Badge tone="muted">{addrKind(a) ?? '?'}</Badge>
                    {mine && <Badge tone="ok">este computador</Badge>}
                    <Button size="s" variant="ghost" icon={<Trash size={13} />} busy={busy === `deny-${a}`}
                      disabled={data.allowed.length === 1}
                      title={data.allowed.length === 1 ? 'Única entrada: esvaziar a lista libera para todos (use “Permitir qualquer dispositivo”)' : 'penguin ssh deny'}
                      onClick={() => deny(a)}>Remover</Button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="row gap-s wrap">
            <Button variant="primary" icon={<Laptop size={14} />} busy={busy === 'here'} disabled={youListed} onClick={allowHere}
              title={youListed ? 'Este computador já está na lista' : 'penguin ssh allow here'}>
              {youListed ? 'Este computador já está permitido' : 'Permitir este computador'}
            </Button>
          </div>
          <div className="col gap-s">
            <div className="row gap-s">
              <input className="input mono grow" placeholder="aa:bb:cc:dd:ee:ff, 192.168.1.20 ou 192.168.1.0/24" value={addr}
                onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') allowAddr(); }} />
              <Button icon={<Plus size={14} />} busy={busy === 'allow'} disabled={!addr.trim() || !!addrError} onClick={allowAddr}>Permitir endereço</Button>
            </div>
            {addrError && <span className="st-err">{addrError}</span>}
            {listEmpty && (
              <label className="st-check"><input type="checkbox" checked={withHere} onChange={(e) => setWithHere(e.target.checked)} /> incluir também este computador (senão o penguin recusa, para não bloquear esta sessão)</label>
            )}
            <span className="field-hint">Prefira MAC na mesma rede Wi-Fi: um IP de DHCP pode passar a outro aparelho. IP/rede só para VPN ou redes roteadas.</span>
          </div>
        </div>
      </Card>

      <Card title={`Chaves autorizadas (${data.keys.length})`} icon={<KeyRound size={16} />}>
        <div className="col gap-m">
          {data.keys.length === 0 ? <Empty>Nenhuma chave em {AUTH_KEYS}</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>#</th><th>Tipo</th><th>Impressão digital</th><th>Comentário</th><th /></tr></thead>
                <tbody>
                  {data.keys.map((k, i) => {
                    const mine = isMine(k);
                    const last = data.keys.length <= 1;
                    return (
                      <tr key={k.index}>
                        <td className="muted">{i + 1}</td>
                        <td className="mono">{k.type}</td>
                        <td><span className="st-keyfp">{k.fingerprint ?? '(inválida)'}</span></td>
                        <td>
                          <div className="row gap-s wrap">
                            <span>{k.comment || <span className="muted">(sem comentário)</span>}</span>
                            {mine && <Badge tone={mineUnique ? 'ok' : 'warn'} title="O comentário coincide com SSH_PUBKEYINFO desta conexão">{mineUnique ? 'esta conexão' : 'talvez esta conexão'}</Badge>}
                            {k.options && <Badge tone="muted" title={k.options}>com opções</Badge>}
                          </div>
                        </td>
                        <td className="right">
                          <Button size="s" variant="ghost" icon={<Trash size={13} />} busy={busy === `key-${k.index}`}
                            disabled={last || (mine && mineUnique)}
                            title={last ? 'Recusado: é a única chave' : mine && mineUnique ? 'Recusado: é a chave usada por esta conexão' : 'Remover esta linha'}
                            onClick={() => removeKey(k)}>Remover</Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="col gap-s">
            <span className="field-label">Adicionar chave pública (conteúdo do arquivo .pub do outro computador)</span>
            <textarea className="input" rows={3} spellCheck={false} placeholder="ssh-ed25519 AAAAC3Nza… usuario@computador" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
            {keyErr && <span className="st-err">{keyErr}</span>}
            <div><Button variant="primary" icon={<Plus size={14} />} busy={busy === 'addkey'} disabled={!newKey.trim() || !!keyErr} onClick={addKey}>Autorizar chave</Button></div>
            <span className="field-hint">Cada computador deve ter sua própria chave. Para revogar um computador, remova a linha dele. Arquivo: <code>{AUTH_KEYS}</code></span>
          </div>
        </div>
      </Card>

      <SshOffModal open={offOpen} onClose={() => setOffOpen(false)} onConfirm={sshOff} />
    </div>
  );
}

function SshOffModal({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (open) setTyped(''); }, [open]);
  const WORD = 'DESLIGAR';
  return (
    <Modal open={open} title="Desligar o SSH" onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="danger" icon={<Power size={14} />} disabled={typed.trim().toUpperCase() !== WORD} onClick={onConfirm}>Desligar SSH</Button>
      </>}>
      <div className="st-callout bad">
        <TriangleAlert size={18} />
        <div className="col gap-s">
          <strong>Você vai perder o acesso remoto ao Echo.</strong>
          <div>A porta 22 é fechada e o dropbear para. Esta conexão cai em 2 segundos e o Echo Manager <b>não conseguirá reconectar</b> — nem nenhum outro computador.</div>
          <div>Para religar será preciso estar fisicamente com o Echo:</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>na tela: <b>Network &amp; SSH → SSH is OFF</b> (toque duas vezes), ou</li>
            <li>pelo console USB: <code>penguin ssh on</code>.</li>
          </ul>
          <div>A configuração persiste: após reiniciar o SSH continua desligado.</div>
        </div>
      </div>
      <label className="field">
        <span className="field-label">Digite <b>{WORD}</b> para confirmar</span>
        <input className="input mono" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
    </Modal>
  );
}
