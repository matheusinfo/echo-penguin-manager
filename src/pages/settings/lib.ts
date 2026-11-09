// Shared helpers for the "Configurações" and "Alarme & Tela" pages: what each echo-penguin setting
// means (from /etc/penguin/defaults.conf), when a change takes effect, and small parsers.
import { run, shq } from '../../api';

export const SETTINGS_FILE = '/data/penguin/settings.conf';
export const DEFAULTS_FILE = '/etc/penguin/defaults.conf';
export const AUTH_KEYS = '/data/misc/techo5/ssh/authorized_keys';
export const FIREWALL_LOG = '/data/techo5-linux/firewall.log';
export const BACKLIGHT_SYS = '/sys/class/leds/lcd-backlight';

/**
 * When a changed setting takes effect:
 *  restart  — `penguin restart` (the supervisor re-reads its settings)
 *  firewall — `penguin firewall`
 *  boot     — only read by boot.sh: reboot the Echo
 *  session  — read by each new SSH / USB-console login
 *  ssh      — managed by `penguin ssh` (applies immediately)
 *  screen   — re-read by the touch UI (penguin-ui) every few seconds
 *  weather  — used by the next weather update (`penguin-weather update`, every 30 min)
 */
export type ApplyKind = 'restart' | 'firewall' | 'boot' | 'session' | 'ssh' | 'screen' | 'weather';

export const APPLY_LABEL: Record<ApplyKind, string> = {
  restart: 'após penguin restart',
  firewall: 'após penguin firewall',
  boot: 'após reiniciar o Echo',
  session: 'em novas sessões SSH/USB',
  ssh: 'imediato (penguin ssh)',
  screen: 'em segundos (tela)',
  weather: 'na próxima atualização do clima',
};

export type SettingKind = 'bool' | 'int' | 'select' | 'text' | 'ports';

export interface SettingMeta {
  key: string;
  label: string;
  desc: string;
  group: string;
  kind: SettingKind;
  min?: number;
  max?: number;
  unit?: string;
  options?: { value: string; label: string }[];
  apply: ApplyKind;
  /** Extra note about applying (shown under the row). */
  applyNote?: string;
  /** Not editable here: changed through another tab (SSH has lock-out protection). */
  managedBy?: string;
}

export const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export const SETTINGS_META: SettingMeta[] = [
  {
    key: 'DOCKER', label: 'Docker', group: 'Serviços', kind: 'select', apply: 'restart',
    options: [{ value: 'auto', label: 'auto (quando o kernel suporta)' }, { value: 'off', label: 'off (desligado)' }],
    desc: 'auto: o Docker é iniciado quando o kernel tem namespaces (a imagem de boot "docker"). off: não inicia.',
    applyNote: 'Ligar vale após penguin restart; desligar só para o dockerd já em execução ao reiniciar o Echo.',
  },
  {
    key: 'SSH', label: 'SSH', group: 'Serviços', kind: 'select', apply: 'ssh', managedBy: 'Acesso SSH',
    options: [{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }],
    desc: 'SSH (dropbear, somente chaves: nenhuma senha funciona). off para o SSH e fecha a porta 22; o console USB e a tela continuam funcionando.',
  },
  {
    key: 'SSH_ALLOW', label: 'Computadores permitidos (SSH)', group: 'Serviços', kind: 'text', apply: 'ssh', managedBy: 'Acesso SSH',
    desc: 'MACs e/ou endereços/redes IP que podem conectar. Vazio: qualquer dispositivo do Wi-Fi pode tentar (ainda precisa de uma chave autorizada). Prefira MACs.',
  },
  {
    key: 'LAN_PORTS', label: 'Portas abertas no Wi-Fi', group: 'Firewall', kind: 'ports', apply: 'firewall',
    desc: 'Portas TCP extras abertas no Wi-Fi, separadas por espaço. Fora estas e o SSH (22), toda entrada pelo wlan0 é fechada.',
  },
  {
    key: 'DOCKER_LAN', label: 'Portas dos containers no Wi-Fi', group: 'Firewall', kind: 'bool', apply: 'firewall',
    desc: 'Portas publicadas por containers (docker run -p): 0 = recusadas no Wi-Fi (acessíveis por túnel SSH), 1 = abertas no Wi-Fi.',
  },
  {
    key: 'CPU_ONLINE', label: 'Núcleos a ligar', group: 'Hardware', kind: 'text', apply: 'boot',
    desc: 'Núcleos de CPU que o Android deixava desligados e que o boot liga (padrão "2 3"). Números de 0 a 3 separados por espaço.',
  },
  {
    key: 'ZRAM_MB', label: 'Swap em zram', group: 'Hardware', kind: 'int', min: 0, max: 1024, unit: 'MB', apply: 'boot',
    desc: 'Tamanho do swap comprimido em RAM (zram), como o Android tinha. 0 = sem swap.',
  },
  {
    key: 'BACKLIGHT', label: 'Brilho da tela', group: 'Hardware', kind: 'int', min: 0, max: 255, apply: 'boot',
    desc: 'Brilho de 0 a 255 aplicado no boot; 0 = tela desligada (e apagada). Com o brilho automático, é o brilho num ambiente claro (e a tela o aplica em segundos). Para mudar na hora, use "Alarme & Tela".',
  },
  {
    key: 'WATCHDOG', label: 'Watchdog', group: 'Hardware', kind: 'bool', apply: 'boot',
    desc: 'Alimenta /dev/watchdog: se o sistema travar, o aparelho reinicia sozinho.',
    applyNote: 'Desligar só vale depois de reiniciar (o daemon já em execução continua).',
  },
  {
    key: 'TEMP_ZONE', label: 'Sensor de temperatura', group: 'Temperatura', kind: 'int', min: 0, max: 40, apply: 'restart',
    desc: 'Zona térmica lida (thermal_zone12 = mtktscpu, a CPU).',
  },
  {
    key: 'TEMP_WARN', label: 'Temperatura de aviso', group: 'Temperatura', kind: 'int', min: 40, max: 110, unit: '°C', apply: 'restart',
    desc: 'Acima disto a temperatura é registrada no log; containers pausados voltam quando a CPU esfria até aqui.',
  },
  {
    key: 'TEMP_CRIT', label: 'Temperatura crítica', group: 'Temperatura', kind: 'int', min: 40, max: 110, unit: '°C', apply: 'restart',
    desc: 'Acima disto os containers em execução são pausados até a CPU voltar a TEMP_WARN (o aparelho não tem ventoinha).',
  },
  {
    key: 'WEEKLY_REBOOT_DAY', label: 'Reinício semanal: dia', group: 'Manutenção', kind: 'select', apply: 'restart',
    options: [{ value: '', label: 'Nunca' }, ...WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))],
    desc: 'Dia da semana do reinício automático semanal (hora local). "Nunca" desativa.',
  },
  {
    key: 'WEEKLY_REBOOT_HOUR', label: 'Reinício semanal: hora', group: 'Manutenção', kind: 'int', min: 0, max: 23, unit: 'h', apply: 'restart',
    desc: 'Hora (0–23, hora local) do reinício semanal. Só acontece se o aparelho estiver ligado há mais de um dia.',
  },
  {
    key: 'LOG_MAX', label: 'Tamanho máximo dos logs', group: 'Manutenção', kind: 'int', min: 100000, max: 100000000, unit: 'bytes', apply: 'restart',
    desc: 'Logs em /data são rotacionados ao atingir este tamanho; uma geração antiga é mantida.',
  },
  {
    key: 'SCREEN_UI', label: 'Interface de toque', group: 'Tela', kind: 'bool', apply: 'boot',
    desc: '1: a interface de toque (penguin-ui) na tela, com o console de logs a um toque (tty2). 0: a tela é só o console de logs — e o alarme não toca.',
  },
  {
    key: 'SCREEN_MIRROR', label: 'Espelhar sessões na tela', group: 'Tela', kind: 'bool', apply: 'session',
    desc: '1: toda sessão interativa SSH e do console USB aparece no console de logs da tela (o que é digitado e a saída).',
  },
  {
    key: 'SCREEN_LOGLEVEL', label: 'Mensagens do kernel na tela', group: 'Tela', kind: 'select', apply: 'boot',
    options: [
      { value: '1', label: '1 — nenhuma' }, { value: '2', label: '2 — emergência' }, { value: '3', label: '3 — críticas' },
      { value: '4', label: '4 — erros e piores (padrão)' }, { value: '5', label: '5 — avisos' }, { value: '6', label: '6 — notices' },
      { value: '7', label: '7 — info' }, { value: '8', label: '8 — todas' },
    ],
    desc: 'Após o boot, mensagens do kernel mais urgentes que este nível chegam ao console de logs.',
  },
  {
    key: 'AUTO_BRIGHTNESS', label: 'Brilho automático', group: 'Tela', kind: 'bool', apply: 'screen',
    desc: '1: a tela segue o sensor de luz do ambiente, de BACKLIGHT_DARK (quarto escuro) até BACKLIGHT (quarto aceso), com transição suave. 0: fica fixa em BACKLIGHT. Precisa da interface de toque (SCREEN_UI=1).',
  },
  {
    key: 'BACKLIGHT_DARK', label: 'Brilho no escuro', group: 'Tela', kind: 'int', min: 1, max: 255, apply: 'screen',
    desc: 'Com o brilho automático: o brilho (1–255) quando o ambiente está escuro. Não passa de BACKLIGHT.',
  },
  {
    key: 'LIGHT_DARK', label: 'Sensor: escuro até', group: 'Tela', kind: 'int', min: 0, max: 4094, apply: 'screen',
    desc: 'Leitura do sensor de luz (0–4095, mostrada em "Alarme & Tela" e na tela do Echo) até a qual o ambiente conta como escuro. Aumente se a tela continuar forte com a luz apagada.',
  },
  {
    key: 'LIGHT_BRIGHT', label: 'Sensor: claro a partir de', group: 'Tela', kind: 'int', min: 1, max: 4095, apply: 'screen',
    desc: 'Leitura do sensor a partir da qual o ambiente conta como claro (brilho BACKLIGHT). Entre LIGHT_DARK e este valor o brilho é intermediário, numa escala logarítmica.',
  },
  {
    key: 'NIGHT_CLOCK', label: 'Relógio noturno', group: 'Tela', kind: 'select', apply: 'screen',
    options: [
      { value: 'auto', label: 'auto (quando o quarto escurece)' }, { value: 'on', label: 'on (sempre, após 30 s sem toque)' },
      { value: 'off', label: 'off (nunca)' },
    ],
    desc: 'auto: com o quarto escuro (sensor ≤ LIGHT_DARK) e 30 s sem toque na tela, só um relógio fraco e o próximo alarme aparecem; um toque traz a interface de volta. on: sempre que a tela fica 30 s sem toque, mesmo com o quarto claro. off: nunca.',
  },
  {
    key: 'NIGHT_COLOR', label: 'Cor do relógio noturno', group: 'Tela', kind: 'select', apply: 'screen',
    options: [{ value: 'red', label: 'vermelho' }, { value: 'amber', label: 'âmbar' }],
    desc: 'A cor dos dígitos do relógio noturno. Vermelho atrapalha menos a visão no escuro.',
  },
  {
    key: 'VOLUME', label: 'Volume', group: 'Som', kind: 'int', min: 0, max: 100, unit: '%', apply: 'boot',
    desc: 'Volume do amplificador no boot (0–100). A interface e os botões de volume também o alteram. Para mudar na hora, use "Alarme & Tela".',
  },
  {
    key: 'WAKE_LIGHT', label: 'Nascer do sol', group: 'Despertar', kind: 'int', min: 0, max: 60, unit: 'min', apply: 'screen',
    desc: 'Minutos antes de um alarme em que a tela começa a clarear aos poucos, em cores quentes, de BACKLIGHT_DARK até BACKLIGHT (mesmo com a tela desligada, se ninguém a tocou há 30 s). 0 = desligado.',
  },
  {
    key: 'WAKE_RAMP', label: 'Volume gradual', group: 'Despertar', kind: 'int', min: 0, max: 600, unit: 's', apply: 'screen',
    desc: 'Segundos que o volume do alarme leva para subir do volume inicial (WAKE_VOLUME_START % de VOLUME) até VOLUME. 0 = desligado (toca direto no volume).',
  },
  {
    key: 'WAKE_VOLUME_START', label: 'Volume inicial', group: 'Despertar', kind: 'int', min: 0, max: 100, unit: '% de VOLUME', apply: 'screen',
    desc: 'Onde o volume gradual começa, em % do volume do alarme (VOLUME): com VOLUME=50, o padrão 80 começa em 40 e sobe até 50. 100 = sem subida. Depois do alarme, o volume volta a VOLUME.',
  },
  {
    key: 'WEATHER_LAT', label: 'Clima: latitude', group: 'Clima', kind: 'text', apply: 'weather',
    desc: 'Latitude do local do clima, em graus decimais (−90 a 90, ponto decimal, ex.: -23.5475). Vazio = sem clima. Mais fácil: busque a cidade em "Alarme & Tela" → Clima.',
  },
  {
    key: 'WEATHER_LON', label: 'Clima: longitude', group: 'Clima', kind: 'text', apply: 'weather',
    desc: 'Longitude do local do clima, em graus decimais (−180 a 180, ex.: -46.6361). Vazio = sem clima.',
  },
  {
    key: 'WEATHER_PLACE', label: 'Clima: nome do local', group: 'Clima', kind: 'text', apply: 'weather',
    desc: 'O nome do local, só para exibir (ex.: São Paulo, Brasil). Os dados vêm do Open-Meteo, sem chave; a tela os atualiza a cada 30 min.',
  },
  {
    key: 'SPEAK_VOICE', label: 'Voz', group: 'Voz', kind: 'text', apply: 'screen',
    desc: 'Voz do espeak-ng (en, pt-br, es, …; letras minúsculas, números, + e -). Vozes pt* falam português; as outras, inglês.',
  },
  {
    key: 'SPEAK_ALARM', label: 'Falar depois do alarme', group: 'Voz', kind: 'bool', apply: 'screen',
    desc: '1: ao parar um alarme, o Echo diz a hora e o clima. 0: silêncio. Tocar no relógio grande da tela inicial também fala.',
  },
  {
    key: 'SLEEP_LOG', label: 'Diário de sono', group: 'Sono', kind: 'bool', apply: 'screen',
    desc: '1: anota quando a luz do quarto apaga e acende (pelo sensor de luz, LIGHT_DARK) e os alarmes, para o diário de sono (penguin-sleep). 0: não anota.',
  },
];

export const META_BY_KEY: Record<string, SettingMeta> = Object.fromEntries(SETTINGS_META.map((m) => [m.key, m]));

/** KEY="value" lines (shell syntax as written by `penguin set`, plus the defaults' inline comments). */
export function parseConf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*(#.*)?$/);
    if (m) out[m[1]] = m[3];
  }
  return out;
}

/** `penguin settings` output: KEY=value (unquoted, value may contain spaces). */
export function parseEffective(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Characters that would break `printf '%s="%s"'` in settings.conf when it is sourced by sh. */
export function unsafeValue(v: string): string | null {
  if (/["$`\\\n\r]/.test(v)) return 'não pode conter aspas, $, crase, barra invertida ou quebra de linha';
  // Other control characters (NUL, ESC…) have no business in a setting either.
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(v)) return 'não pode conter caracteres de controle';
  return null;
}

/** A setting name as penguin writes it (also what is safe inside a sed regex / shell word). */
export function isSettingKey(k: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(k);
}

export function validateSetting(meta: SettingMeta, v: string, all?: Record<string, string>): string | null {
  const bad = unsafeValue(v);
  if (bad) return bad;
  switch (meta.kind) {
    case 'bool':
      return v === '0' || v === '1' ? null : 'use 0 ou 1';
    case 'int': {
      if (!/^\d+$/.test(v)) return 'número inteiro';
      const n = Number(v);
      if (meta.min != null && n < meta.min) return `mínimo ${meta.min}`;
      if (meta.max != null && n > meta.max) return `máximo ${meta.max}`;
      if (meta.key === 'TEMP_CRIT' && all && Number(all.TEMP_WARN) >= n) return 'precisa ser maior que TEMP_WARN';
      if (meta.key === 'TEMP_WARN' && all && Number(all.TEMP_CRIT) <= n) return 'precisa ser menor que TEMP_CRIT';
      if (meta.key === 'LIGHT_DARK' && all && /^\d+$/.test(all.LIGHT_BRIGHT ?? '') && Number(all.LIGHT_BRIGHT) <= n) return 'precisa ser menor que LIGHT_BRIGHT';
      if (meta.key === 'LIGHT_BRIGHT' && all && /^\d+$/.test(all.LIGHT_DARK ?? '') && Number(all.LIGHT_DARK) >= n) return 'precisa ser maior que LIGHT_DARK';
      return null;
    }
    case 'select':
      return meta.options && !meta.options.some((o) => o.value === v) ? 'valor inválido' : null;
    case 'ports': {
      for (const p of v.split(/\s+/).filter(Boolean)) {
        if (!isPort(p)) return `"${p}" não é uma porta (1–65535)`;
      }
      return null;
    }
    case 'text':
      if (meta.key === 'CPU_ONLINE' && v.trim() && !/^[0-3](\s+[0-3])*$/.test(v.trim())) return 'números de 0 a 3 separados por espaço';
      if (meta.key === 'WEATHER_LAT' || meta.key === 'WEATHER_LON') {
        const lim = meta.key === 'WEATHER_LAT' ? 90 : 180;
        if (v !== '' && !isCoord(v, lim)) return /,/.test(v) ? 'use ponto decimal (ex.: -23.55)' : `graus decimais de −${lim} a ${lim}`;
        const other = meta.key === 'WEATHER_LAT' ? 'WEATHER_LON' : 'WEATHER_LAT';
        if (all && other in all && (v === '') !== ((all[other] ?? '') === '')) return v === '' ? `apague também ${other}` : `preencha também ${other}`;
        return null;
      }
      if (meta.key === 'WEATHER_PLACE' && v.length > 80) return 'no máximo 80 caracteres';
      if (meta.key === 'SPEAK_VOICE' && !/^[a-z0-9+-]{1,32}$/.test(v)) return 'nome de voz: minúsculas, números, + e - (ex.: pt-br)';
      return null;
  }
}

/** Decimal degrees within ±limit, written plainly ("-23.5475"). */
export function isCoord(v: string, limit: number): boolean {
  return /^-?\d{1,3}(\.\d{1,8})?$/.test(v) && Math.abs(Number(v)) <= limit;
}

export function isPort(p: string): boolean {
  return /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;
}

/** Normalise a value the way the shell would read it back (collapse whitespace for list settings). */
export function normValue(meta: SettingMeta | undefined, v: string): string {
  if (meta && (meta.kind === 'ports' || meta.key === 'CPU_ONLINE')) return v.trim().split(/\s+/).filter(Boolean).join(' ');
  return v;
}

/** Shell command that writes KEY=VALUE, or removes the override when the value is the default. */
export function setCommand(key: string, value: string, defaultValue: string | undefined): string {
  if (!isSettingKey(key)) throw new Error(`chave inválida: ${key}`);
  if (defaultValue !== undefined && value === defaultValue) return removeCommand(key);
  const bad = unsafeValue(value);
  if (bad) throw new Error(`${key}: ${bad}`);
  return `penguin set ${shq(key)} ${shq(value)}`;
}

/** Removes KEY's override line from settings.conf (back to the image's default). */
export function removeCommand(key: string): string {
  if (!isSettingKey(key)) throw new Error(`chave inválida: ${key}`);
  return `[ ! -f ${SETTINGS_FILE} ] || sed -i ${shq(`/^${key}=/d`)} ${SETTINGS_FILE}`;
}

export async function setSetting(key: string, value: string, defaultValue?: string): Promise<string> {
  return run(setCommand(key, value, defaultValue));
}

// --- Addresses (SSH_ALLOW).

export function isMac(s: string): boolean {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(s);
}

export function isIPv4(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!m) return false;
  if ([m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) return false;
  return m[5] == null || Number(m[5]) <= 32;
}

export function isIPv6(s: string): boolean {
  const [addr, prefix, ...rest] = s.split('/');
  if (rest.length) return false;
  if (prefix != null && !(/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128)) return false;
  if (!/^[0-9a-f:.]+$/i.test(addr) || !addr.includes(':')) return false;
  if ((addr.match(/::/g) || []).length > 1) return false;
  const groups = addr.split(':');
  return groups.length >= 3 && groups.length <= 8 && groups.every((g) => g === '' || /^[0-9a-f]{1,4}$/i.test(g) || isIPv4(g));
}

export function addrKind(s: string): 'MAC' | 'IPv4' | 'IPv6' | null {
  if (isMac(s)) return 'MAC';
  if (isIPv4(s)) return 'IPv4';
  if (isIPv6(s)) return 'IPv6';
  return null;
}

// --- SSH public keys.

export interface AuthKey {
  index: number;      // line index in the file
  line: string;
  type: string;
  blob: string;
  comment: string;
  options: string;
  fingerprint: string | null; // SHA256:... (no padding), as ssh-keygen -l
}

const KEY_TYPE = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-[A-Za-z0-9@._-]+)$/;

export function parseKeyLine(line: string): Omit<AuthKey, 'index' | 'fingerprint'> | null {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const parts = t.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    if (/^(ssh-|ecdsa-|sk-)/.test(parts[i]) && i + 1 < parts.length) {
      return { line, type: parts[i], blob: parts[i + 1], comment: parts.slice(i + 2).join(' '), options: parts.slice(0, i).join(' ') };
    }
  }
  return null;
}

function b64decode(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function fingerprint(blob: string): Promise<string | null> {
  const raw = b64decode(blob);
  if (!raw) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  let bin = '';
  digest.forEach((b) => { bin += String.fromCharCode(b); });
  return 'SHA256:' + btoa(bin).replace(/=+$/, '');
}

export async function parseAuthKeys(text: string): Promise<AuthKey[]> {
  const lines = text.split('\n');
  const out: AuthKey[] = [];
  for (let i = 0; i < lines.length; i++) {
    const k = parseKeyLine(lines[i]);
    if (k) out.push({ ...k, index: i, fingerprint: await fingerprint(k.blob) });
  }
  return out;
}

/**
 * Validates one pasted public key line. Returns an error message or null.
 * Only a plain "type base64 [comment]" line is accepted: no options (command=, from=…), no second
 * line, no control characters — what ends up in authorized_keys is exactly one key.
 */
export function validatePublicKey(line: string): string | null {
  const t = line.trim();
  if (!t) return 'cole uma chave pública';
  if (/PRIVATE KEY/.test(t)) return 'isto é uma chave PRIVADA — nunca a envie; cole o conteúdo do arquivo .pub';
  if (/[\r\n\u2028\u2029]/.test(t)) return 'uma chave por vez (uma linha só)';
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(t)) return 'a chave contém caracteres de controle';
  const parts = t.split(/[ \t]+/);
  if (parts.length < 2) return 'formato esperado: "ssh-ed25519 AAAA… comentário"';
  const [type, blob] = parts;
  if (!KEY_TYPE.test(type)) {
    return /^(ssh-|ecdsa-|sk-)/.test(type) ? `tipo de chave desconhecido: ${type}` : 'formato esperado: "ssh-ed25519 AAAA… comentário" (opções como command= ou from= não são aceitas)';
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob) || blob.length % 4 !== 0) return 'a parte base64 da chave é inválida';
  const raw = b64decode(blob);
  if (!raw || raw.length < 20) return 'a parte base64 da chave é inválida';
  // The blob starts with the key type as an SSH string (uint32 length + bytes).
  const len = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
  if (len > raw.length - 4) return 'a parte base64 da chave é inválida';
  const inner = new TextDecoder().decode(raw.slice(4, 4 + len));
  if (inner !== type) return `a chave diz "${type}" mas o conteúdo é "${inner}"`;
  return null;
}

// --- Misc.

export function tail(text: string, n: number): string {
  const lines = text.replace(/\n+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}
