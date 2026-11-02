import { useEffect, useState } from 'react';
import { FolderOpen, ShieldCheck, KeyRound } from 'lucide-react';
import { ConfigUpdate, echo, EchoConfig, errMsg } from '../api';
import { useApp } from '../hooks';
import { Badge, Button, Field, Modal, Switch } from './ui';

export default function ConnectionDialog({ open, onClose, firstRun }: { open: boolean; onClose: () => void; firstRun?: boolean }) {
  const { config, reloadConfig, toast, confirm } = useApp();
  const [form, setForm] = useState<EchoConfig | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open && config) setForm({ ...config, passphrase: '' }); }, [open, config]);
  if (!form) return null;
  const set = <K extends keyof EchoConfig>(k: K, v: EchoConfig[K]) => setForm({ ...form, [k]: v });

  const persist = async (extra: ConfigUpdate = {}) => {
    const { hasPassphrase, hostKey, keyringAvailable, ...rest } = form;
    void hasPassphrase; void hostKey; void keyringAvailable;
    await echo.config.set({ ...rest, ...extra });
    await reloadConfig();
  };

  const save = async (reconnect: boolean) => {
    if (!form.host.trim()) {
      toast('Informe o endereço IP do Echo (aparece na tela Rede & SSH do próprio Echo).', 'error');
      return;
    }
    setBusy(true);
    try {
      await persist();
      if (reconnect) {
        await echo.ssh.connect();
        toast('Conectado ao Echo', 'ok');
      }
      onClose();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const forgetHostKey = async () => {
    const ok = await confirm({
      title: 'Esquecer a identidade do Echo?',
      message: 'Faça isso só se você reinstalou o sistema do Echo (ou trocou de aparelho). Na próxima conexão, a nova identidade será aceita e lembrada.',
      confirmLabel: 'Esquecer identidade',
      danger: true,
    });
    if (!ok) return;
    try {
      await persist({ forgetHostKey: true });
      toast('Identidade esquecida. Conecte de novo.', 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const forgetPassphrase = async () => {
    try {
      await persist({ clearPassphrase: true });
      toast('Senha da chave esquecida', 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  return (
    <Modal open={open} title={firstRun ? 'Bem-vindo! Vamos conectar ao seu Echo' : 'Conexão com o Echo'} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancelar</Button>
      <Button onClick={() => save(false)} busy={busy}>Salvar</Button>
      <Button variant="primary" onClick={() => save(true)} busy={busy}>Salvar e conectar</Button>
    </>}>
      {firstRun && (
        <div className="muted small">
          O endereço IP aparece na tela do Echo em <strong>Rede &amp; SSH</strong>. A chave SSH é a mesma usada na instalação do echo-penguin.
        </div>
      )}
      <div className="row gap-m">
        <div className="grow"><Field label="Endereço (IP ou host)"><input className="input" value={form.host} placeholder="ex.: 192.168.1.50" onChange={(e) => set('host', e.target.value)} /></Field></div>
        <div style={{ width: 90 }}><Field label="Porta"><input className="input" type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))} /></Field></div>
      </div>
      <Field label="Usuário"><input className="input" value={form.username} onChange={(e) => set('username', e.target.value)} /></Field>
      <Field label="Chave privada" hint="O echo-penguin só aceita chaves (sem senha de login). Padrão: ~/.ssh/techo5">
        <div className="row gap-s">
          <input className="input grow mono" value={form.keyPath} onChange={(e) => set('keyPath', e.target.value)} />
          <Button icon={<FolderOpen size={14} />} title="Escolher arquivo" onClick={async () => { const p = await echo.config.pickKey(); if (p) set('keyPath', p); }} />
        </div>
      </Field>
      <Field
        label="Senha da chave (se houver)"
        hint={config?.keyringAvailable
          ? 'Guardada criptografada no chaveiro do sistema. Com o ssh-agent ligado normalmente não é preciso.'
          : 'Sem chaveiro disponível: a senha fica só na memória até fechar o app.'}
      >
        <div className="row gap-s">
          <input className="input grow" type="password" value={form.passphrase} placeholder={config?.hasPassphrase ? '•••••• (salva — deixe em branco para manter)' : ''} onChange={(e) => set('passphrase', e.target.value)} />
          {config?.hasPassphrase && <Button size="s" variant="ghost" icon={<KeyRound size={14} />} onClick={forgetPassphrase}>Esquecer</Button>}
        </div>
      </Field>
      <Field label="Identidade do Echo" hint="Lembrada na primeira conexão. Se mudar, o app recusa a conexão para sua segurança.">
        <div className="row gap-s">
          {config?.hostKey
            ? <><Badge tone="ok"><ShieldCheck size={12} /> verificada</Badge><span className="mono small ellipsis grow" title={config.hostKey}>{config.hostKey}</span>
                <Button size="s" variant="ghost" onClick={forgetHostKey}>Esquecer identidade</Button></>
            : <span className="muted small">Ainda não conectado a este endereço.</span>}
        </div>
      </Field>
      <Field label="Intervalo de atualização (segundos)" hint="Quanto menor, mais carga no Echo (1 GB de RAM).">
        <input className="input" type="number" min={2} value={form.refreshSeconds} onChange={(e) => set('refreshSeconds', Number(e.target.value))} />
      </Field>
      <Switch checked={form.useAgent} onChange={(v) => set('useAgent', v)} label="Usar ssh-agent (chaves já desbloqueadas no chaveiro do Mint)" />
      <Switch checked={form.autoConnect} onChange={(v) => set('autoConnect', v)} label="Conectar automaticamente ao abrir" />
      <Switch checked={form.notifications} onChange={(v) => set('notifications', v)} label="Notificações do sistema (temperatura, containers parados, conexão perdida)" />
    </Modal>
  );
}
