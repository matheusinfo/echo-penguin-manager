// Shared bits for the Terminal page: snippet model, defaults, destructive-command detection, snippet editor.
import { useEffect, useState } from 'react';
import { Button, Field, Modal, Switch } from '../../components/ui';

export interface Snippet {
  id: string;
  name: string;
  command: string;
  /** Ask for confirmation before running. */
  danger?: boolean;
}

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const DEFAULT_SNIPPETS: Snippet[] = [
  { id: 'd-status', name: 'Status do penguin', command: 'penguin status' },
  { id: 'd-settings', name: 'Configurações efetivas', command: 'penguin settings' },
  { id: 'd-ssh', name: 'SSH: estado e chaves', command: 'penguin ssh' },
  { id: 'd-slot', name: 'Slots do sistema', command: 'slotctl status' },
  { id: 'd-log-sup', name: 'Log do supervisor', command: 'penguin logs supervisor' },
  { id: 'd-log-boot', name: 'Log do boot', command: 'penguin logs boot' },
  { id: 'd-docker-ps', name: 'Contêineres (todos)', command: 'docker ps -a' },
  { id: 'd-docker-stats', name: 'Uso dos contêineres', command: 'docker stats --no-stream' },
  { id: 'd-df', name: 'Uso de disco', command: 'df -h' },
  { id: 'd-free', name: 'Memória', command: 'free -m' },
  { id: 'd-top', name: 'Processos (top)', command: 'top -bn1 | head -20' },
  { id: 'd-dmesg', name: 'Kernel (dmesg)', command: 'dmesg | tail -50' },
  { id: 'd-cleanup', name: 'Limpeza (só listar)', command: 'penguin cleanup' },
];

/** rm with a recursive flag (-r, -R, -rf, -fr, --recursive) anywhere in its option list. */
function rmRecursive(cmd: string): boolean {
  const re = /(?:^|[\s;&|(`])rm((?:\s+-\S+)+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const flags = m[1].trim().split(/\s+/);
    if (flags.some((f) => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)))) return true;
  }
  return false;
}

const DESTRUCTIVE: [RegExp | ((cmd: string) => boolean), string][] = [
  [/\b(reboot|poweroff|halt|shutdown)\b/, 'reinicia ou desliga o Echo'],
  [/\brebootto\b/, 'reinicia em outro modo/slot'],
  [/\bfastboot\b/, 'mexe com o bootloader (fastboot)'],
  [rmRecursive, 'apaga arquivos recursivamente (rm -r/-rf)'],
  [/\bpenguin\s+ssh\s+(off|deny)\b/, 'pode cortar o acesso SSH a este computador'],
  [/\bpenguin\s+set\s+SSH(_ALLOW)?\b/, 'altera o acesso SSH'],
  [/\bpenguin\s+cleanup\b.*--yes\b/, 'remove arquivos/imagens/contêineres de verdade'],
  [/\bpenguin\s+(restart|firewall)\b/, 'reinicia o supervisor / reaplica o firewall'],
  [/\bdocker\s+(system|image|container|volume|network|builder)\s+prune\b/, 'remove dados do Docker (prune)'],
  [/\bdocker\s+(rm|rmi|kill)\b/, 'remove/mata contêineres ou imagens'],
  [/\bmkfs(\.\w+)?\b/, 'formata um sistema de arquivos'],
  [/(^|[\s;&|(])dd\s/, 'escreve direto em dispositivos (dd)'],
  [/\b(fdisk|sfdisk|parted|wipefs|blkdiscard)\b/, 'altera partições'],
  [/\bslotctl\s+(?!status\b)\w+/, 'altera os slots do sistema'],
  [/>\s*\/dev\/(mmcblk|sd|block)/, 'escreve direto no armazenamento'],
  [/\bkill(all)?\s+(-\S+\s+)*(1|dropbear|dockerd)\b/, 'mata um processo essencial'],
];

/** Returns why a command looks destructive (or null). */
export function destructiveReasons(cmd: string): string[] {
  const out: string[] = [];
  for (const [test, why] of DESTRUCTIVE) {
    const hit = typeof test === 'function' ? test(cmd) : test.test(cmd);
    if (hit && !out.includes(why)) out.push(why);
  }
  return out;
}

const SECRET_PATTERNS: RegExp[] = [
  /--?(?:token|password|passwd|pass|secret|api[-_]?key|auth)[= ]+\S/i,
  /\b\w*(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)\w*\s*=\s*\S/i,
  /\bpenguin\s+set\s+\w*(?:PASS|SECRET|TOKEN|KEY)\w*\s+\S/i,
  /\beyJ[\w-]{10,}/, // JWT / cloudflared tunnel tokens
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16})\b/,
  /authorization:\s*(?:bearer|basic)\s+\S/i,
  /:\/\/[^\s/:@]+:[^\s/@]+@/, // user:password@host in a URL
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bchpasswd\b|\bdocker\s+login\b.*\s(?:-p|--password)\b/,
];

/** True when a command line seems to carry a password/token (so it must not be persisted in history). */
export function looksSecret(cmd: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(cmd));
}

/** Confirm before running a snippet flagged dangerous or a command matching a destructive pattern. */
export async function confirmIfDangerous(
  confirm: (o: { title: string; message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>,
  cmd: string,
  flagged = false,
): Promise<boolean> {
  const reasons = destructiveReasons(cmd);
  if (!flagged && reasons.length === 0) return true;
  const lines = [`Este comando pode ser perigoso:\n\n${cmd.length > 400 ? cmd.slice(0, 400) + '…' : cmd}`];
  if (reasons.length) lines.push(reasons.map((r) => `• ${r}`).join('\n'));
  if (flagged && !reasons.length) lines.push('• marcado como perigoso');
  lines.push('Executar mesmo assim?');
  return confirm({ title: 'Confirmar comando', message: lines.join('\n\n'), confirmLabel: 'Executar', danger: true });
}

/** Add/edit snippet dialog. `initial.id` empty → new snippet. */
export function SnippetEditor({ initial, onSave, onClose }: {
  initial: Snippet | null;
  onSave: (s: Snippet) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Snippet>({ id: '', name: '', command: '' });
  useEffect(() => {
    if (initial) setDraft({ ...initial, danger: initial.danger ?? destructiveReasons(initial.command).length > 0 });
  }, [initial]);
  const valid = draft.name.trim() && draft.command.trim();
  const save = () => {
    if (!valid) return;
    onSave({ ...draft, id: draft.id || newId(), name: draft.name.trim(), command: draft.command.replace(/\s+$/, '') });
  };
  return (
    <Modal
      open={!!initial}
      title={initial?.id ? 'Editar comando rápido' : 'Novo comando rápido'}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" disabled={!valid} onClick={save}>Salvar</Button>
      </>}
    >
      <Field label="Nome">
        <input className="input" autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="ex.: Reiniciar contêiner web" />
      </Field>
      <Field label="Comando" hint="Executado no shell do Echo (busybox ash).">
        <textarea
          className="input"
          rows={4}
          value={draft.command}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); }}
          placeholder="docker restart web"
        />
      </Field>
      {looksSecret(draft.command) && (
        <div className="tp-warn small">
          Este comando parece conter uma senha ou token. Comandos rápidos ficam salvos em texto puro neste computador:
          prefira ler o segredo de um arquivo no Echo (ex.: <code>$(cat /data/…)</code>).
        </div>
      )}
      <Switch checked={!!draft.danger} onChange={(v) => setDraft({ ...draft, danger: v })} label="Perigoso (pedir confirmação antes de executar)" />
    </Modal>
  );
}
