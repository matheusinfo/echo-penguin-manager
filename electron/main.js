'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EchoSSH } = require('./ssh');

const DEFAULT_CONFIG = {
  host: '',
  port: 22,
  username: 'root',
  keyPath: '~/.ssh/techo5',
  useAgent: true,
  refreshSeconds: 5,
  autoConnect: true,
  notifications: true,
  hostKeys: {},          // "host:port" -> pinned SHA256 fingerprint
};

// ---------------------------------------------------------------------------------------------
// Config on disk (userData/config.json). The key passphrase is never stored in plain text: it is
// encrypted with the system keyring (safeStorage → libsecret on Linux Mint), or kept in memory only
// when no keyring is available.

const configFile = () => path.join(app.getPath('userData'), 'config.json');
// Letters, digits, '_', '-', '.' (e.g. "system.tab"); never a path: no '/', no '..', no leading dot.
const STORE_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
const dataFile = (name) => {
  if (typeof name !== 'string' || !STORE_NAME.test(name) || name.includes('..') || name.toLowerCase() === 'config') throw new Error('nome inválido');
  return path.join(app.getPath('userData'), `${name}.json`);
};

let memoryPassphrase = '';

function keyringAvailable() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // 'basic_text' means "no keyring": the "encryption" would be a fixed, public key.
    if (typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  } catch (_) {
    return false;
  }
}

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeConfigFile(obj) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/** Full config for the main process, with the passphrase decrypted. */
function loadConfig() {
  const raw = readConfigFile();
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  cfg.passphrase = memoryPassphrase;
  if (!cfg.passphrase && raw.passphraseEnc && keyringAvailable()) {
    try {
      cfg.passphrase = safeStorage.decryptString(Buffer.from(raw.passphraseEnc, 'base64'));
    } catch (_) { /* keyring changed: ask again */ }
  }
  // Older versions stored it in plain text: migrate on the next save.
  if (!cfg.passphrase && typeof raw.passphrase === 'string') cfg.passphrase = raw.passphrase;
  delete cfg.passphraseEnc;
  return cfg;
}

/** What the window may see: no secrets. */
function publicConfig() {
  const cfg = loadConfig();
  const id = `${cfg.host}:${Number(cfg.port) || 22}`;
  const { passphrase, hostKeys, ...rest } = cfg;
  return { ...rest, passphrase: '', hasPassphrase: !!passphrase, hostKey: (hostKeys || {})[id] || null, keyringAvailable: keyringAvailable() };
}

const str = (v, max = 512) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const int = (v, min, max) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

/** Validates what the window sends; unknown fields are ignored. */
function saveConfig(input = {}) {
  const raw = readConfigFile();
  const next = { ...DEFAULT_CONFIG, ...raw };
  delete next.passphrase;
  const host = str(input.host, 253);
  if (host !== undefined) {
    if (host && !/^[a-z0-9._:-]+$/i.test(host)) throw new Error('Endereço inválido');
    next.host = host;
  }
  const port = int(input.port, 1, 65535); if (port !== undefined) next.port = port;
  const user = str(input.username, 64);
  if (user !== undefined) {
    if (!/^[a-z0-9._-]+$/i.test(user)) throw new Error('Usuário inválido');
    next.username = user;
  }
  const keyPath = str(input.keyPath, 1024); if (keyPath !== undefined) next.keyPath = keyPath;
  const refresh = int(input.refreshSeconds, 2, 300); if (refresh !== undefined) next.refreshSeconds = refresh;
  for (const k of ['useAgent', 'autoConnect', 'notifications']) {
    const b = bool(input[k]); if (b !== undefined) next[k] = b;
  }
  if (input.forgetHostKey) {
    next.hostKeys = { ...(next.hostKeys || {}) };
    delete next.hostKeys[`${next.host}:${next.port}`];
  }
  // Passphrase: '' = keep, clearPassphrase = forget, anything else = replace.
  const migrate = typeof raw.passphrase === 'string' && raw.passphrase;
  const newPass = typeof input.passphrase === 'string' && input.passphrase ? input.passphrase : (migrate || null);
  if (input.clearPassphrase) {
    delete next.passphraseEnc;
    memoryPassphrase = '';
  } else if (newPass) {
    if (keyringAvailable()) {
      next.passphraseEnc = safeStorage.encryptString(newPass).toString('base64');
      memoryPassphrase = '';
    } else {
      delete next.passphraseEnc;
      memoryPassphrase = newPass; // this session only
    }
  }
  writeConfigFile(next);
  return publicConfig();
}

// Prefill from ~/.ssh/config "Host echo" on the first run.
function sshConfigDefaults() {
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    const m = txt.match(/^Host\s+echo\s*\n((?:[ \t]+.*\n?)*)/m);
    if (!m) return {};
    const out = {};
    for (const line of m[1].split('\n')) {
      const [k, ...v] = line.trim().split(/\s+/);
      const val = v.join(' ');
      if (/^hostname$/i.test(k)) out.host = val;
      if (/^user$/i.test(k)) out.username = val;
      if (/^port$/i.test(k)) out.port = Number(val);
      if (/^identityfile$/i.test(k)) out.keyPath = val;
    }
    return out;
  } catch (_) {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// SSH events → window. Stream output is batched (every 50 ms) so a chatty `tail -f` doesn't flood IPC.

const ssh = new EchoSSH();
let win = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const pendingStream = new Map(); // id -> { out: string[], err: string[] }
let flushTimer = null;
function flushStreams() {
  flushTimer = null;
  for (const [id, b] of pendingStream) {
    if (b.out.length) send('stream:data', { id, data: b.out.join(''), stderr: false });
    if (b.err.length) send('stream:data', { id, data: b.err.join(''), stderr: true });
  }
  pendingStream.clear();
}
ssh.on('stream-data', ({ id, data, stderr }) => {
  let b = pendingStream.get(id);
  if (!b) pendingStream.set(id, (b = { out: [], err: [] }));
  (stderr ? b.err : b.out).push(data);
  if (!flushTimer) flushTimer = setTimeout(flushStreams, 50);
});
ssh.on('stream-end', (p) => {
  if (pendingStream.has(p.id)) flushStreams();
  send('stream:end', p);
});
ssh.on('shell-data', (p) => send('shell:data', p));
ssh.on('shell-exit', (p) => send('shell:exit', p));

ssh.on('hostkey-pinned', ({ id, fingerprint }) => {
  const raw = readConfigFile();
  writeConfigFile({ ...raw, hostKeys: { ...(raw.hostKeys || {}), [id]: fingerprint } });
});

// Desktop notification when an established connection drops (and when it comes back).
let lastState = 'disconnected';
let lostNotified = false;
ssh.on('status', (s) => {
  send('ssh:status', s);
  const cfg = readConfigFile();
  if (cfg.notifications !== false && Notification.isSupported()) {
    if (lastState === 'connected' && s.state !== 'connected' && s.state !== 'connecting' && ssh.wantConnected) {
      new Notification({ title: 'Echo Manager', body: `Conexão com o Echo perdida${s.error ? `: ${s.error}` : ''}. Tentando reconectar…` }).show();
      lostNotified = true;
    } else if (s.state === 'connected' && lostNotified) {
      new Notification({ title: 'Echo Manager', body: 'Conexão com o Echo restabelecida.' }).show();
      lostNotified = false;
    }
  }
  if (s.state !== 'connecting') lastState = s.state;
});

// ---------------------------------------------------------------------------------------------
// Window

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const APP_INDEX = path.join(__dirname, '..', 'dist', 'index.html');

function isAppUrl(url) {
  if (!url) return false;
  if (DEV_URL && url.startsWith(DEV_URL)) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && path.resolve(decodeURIComponent(u.pathname)) === path.resolve(APP_INDEX);
  } catch (_) {
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'Echo Manager',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());

  // Links open in the system browser; the app window never navigates away or opens new windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  if (process.env.ECHO_SCREENSHOT_DIR && !app.isPackaged) require('./screenshot')(app, win, process.env.ECHO_SCREENSHOT_DIR);

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(APP_INDEX);
}

// Every IPC call must come from the app's own page.
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url)) throw new Error('origem não autorizada');
    return fn(...args);
  });
}
const needString = (v, name) => {
  if (typeof v !== 'string') throw new Error(`${name} inválido`);
  return v;
};

handle('config:get', () => publicConfig());
handle('config:set', (cfg) => saveConfig(cfg && typeof cfg === 'object' ? cfg : {}));
handle('config:pickKey', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Escolha a chave privada SSH',
    defaultPath: path.join(os.homedir(), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('ssh:connect', async () => {
  const cfg = loadConfig();
  if (!cfg.host) throw new Error('Informe o endereço do Echo (lápis na barra lateral).');
  return ssh.connect(cfg);
});
handle('ssh:disconnect', () => { ssh.disconnect(); return ssh.status(); });
handle('ssh:status', () => ssh.status());
handle('ssh:exec', (command, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  return ssh.exec(needString(command, 'comando'), {
    timeout: o.timeout,
    stdin: typeof o.stdin === 'string' ? o.stdin : undefined,
  });
});
handle('ssh:readFile', (p) => ssh.readFile(needString(p, 'caminho')));
handle('ssh:writeFile', (p, content) => ssh.writeFile(needString(p, 'caminho'), needString(content, 'conteúdo')));

handle('stream:start', (command) => ssh.streamStart(needString(command, 'comando')));
handle('stream:stop', (id) => { ssh.close(String(id)); return true; });

handle('shell:open', (size) => ssh.shellOpen(size && typeof size === 'object' ? size : {}));
handle('shell:write', (id, data) => { ssh.write(String(id), needString(data, 'dados')); return true; });
handle('shell:resize', (id, cols, rows) => { ssh.resize(String(id), cols, rows); return true; });
handle('shell:close', (id) => { ssh.close(String(id)); return true; });

// Small local JSON documents (command snippets, history, metric history...) kept in userData.
handle('store:get', (name, fallback) => {
  const file = dataFile(name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback === undefined ? null : fallback;
  }
});
handle('store:set', (name, value) => {
  const file = dataFile(name);
  const json = JSON.stringify(value, null, 2);
  if (json && json.length > 8 * 1024 * 1024) throw new Error('dados grandes demais');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(file, json ?? 'null');
  return true;
});

handle('app:notify', (title, body) => {
  if (Notification.isSupported()) new Notification({ title: String(title).slice(0, 200), body: String(body).slice(0, 1000) }).show();
  return true;
});
handle('app:saveText', async (defaultName, content) => {
  const name = path.basename(String(defaultName || 'echo.txt'));
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(os.homedir(), name) });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, needString(content, 'conteúdo'));
  return r.filePath;
});
handle('app:openExternal', (url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  return true;
});
handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform }));

// ---------------------------------------------------------------------------------------------

// One window only: opening the app again just brings it to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // The page needs no camera, microphone, location, etc. Only the clipboard (terminal copy/paste).
    const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

    if (!fs.existsSync(configFile())) writeConfigFile({ ...DEFAULT_CONFIG, ...sshConfigDefaults() });
    else if (typeof readConfigFile().passphrase === 'string') saveConfig({}); // migrate a plain-text passphrase
    createWindow();
    const cfg = loadConfig();
    if (cfg.autoConnect && cfg.host) ssh.connect(cfg).catch(() => {});
  });

  app.on('window-all-closed', () => {
    ssh.disconnect();
    app.quit();
  });
}
