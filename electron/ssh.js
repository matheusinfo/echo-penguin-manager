// SSH connection to the Echo: one multiplexed ssh2 Client for exec, streams and interactive shells.
'use strict';
const { Client } = require('ssh2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { fingerprint, knownHostsLookup, hostToken } = require('./hostkeys');

// Non-interactive sessions on echo-penguin do not have /usr/local/sbin (penguin, slotctl) on PATH.
const PATH_PREFIX = 'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ';

// The Echo has a slow CPU and 1 GB of RAM: never run more than this many one-shot commands at once.
const MAX_CONCURRENT_EXEC = 4;
// One command's output is capped so a huge file can't freeze the app.
const MAX_OUTPUT = 16 * 1024 * 1024;
// Reconnect: 3 s, 6 s, 12 s… up to one minute.
const RECONNECT_MIN = 3000;
const RECONNECT_MAX = 60000;

/** Turns ssh2/network errors into something a person can act on. */
function friendlyError(msg, config) {
  const host = config && config.host;
  if (/ECONNREFUSED/.test(msg)) return `O Echo (${host}) recusou a conexão: o SSH pode estar desligado (ligue em Rede & SSH na tela do Echo).`;
  if (/ETIMEDOUT|Timed out while waiting for handshake|EHOSTUNREACH|ENETUNREACH/.test(msg)) return `O Echo (${host}) não respondeu. Ele está ligado e no mesmo Wi-Fi que este computador?`;
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return `Endereço "${host}" não encontrado. Confira o IP do Echo (aparece na tela Rede & SSH).`;
  if (/All configured authentication methods failed/.test(msg)) return 'O Echo não aceitou a chave SSH. Confira a chave escolhida, ou se este computador está na lista de permitidos do Echo.';
  if (/ECONNRESET|Connection lost/.test(msg)) return 'A conexão com o Echo caiu.';
  return msg;
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

class EchoSSH extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.state = 'disconnected'; // disconnected | connecting | connected | error
    this.error = null;
    this.config = null;
    this.channels = new Map(); // id -> { kind: 'stream'|'shell', stream }
    this.nextId = 1;
    this.reconnectTimer = null;
    this.wantConnected = false;
    this.connectedAt = null;
    this.reconnectDelay = RECONNECT_MIN;
    this.hostKeyProblem = null;
    this.running = 0;      // one-shot commands in flight
    this.queue = [];       // commands waiting for a free slot
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      host: this.config ? this.config.host : null,
      connectedAt: this.connectedAt,
      hostKey: this.hostKey || null,
    };
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('status', this.status());
  }

  async connect(config) {
    this.config = config;
    this.wantConnected = true;
    clearTimeout(this.reconnectTimer);
    if (this.client) this.teardown();
    this.setState('connecting');

    // Auth: the running ssh-agent (Linux Mint's GNOME keyring provides one and unlocks encrypted keys),
    // plus the key file when it is usable without a prompt (unencrypted, or a passphrase was given).
    const agent = config.useAgent !== false ? findAgentSocket() : undefined;
    let privateKey;
    if (config.keyPath) {
      try {
        const raw = fs.readFileSync(expandHome(config.keyPath));
        const encrypted = /ENCRYPTED/.test(raw.toString('utf8', 0, 200)) || isEncryptedOpenSSH(raw);
        if (!encrypted || config.passphrase) privateKey = raw;
      } catch (e) {
        if (!agent) {
          this.setState('error', `Não foi possível ler a chave ${config.keyPath}: ${e.message}`);
          throw new Error(this.error);
        }
      }
    }
    if (!agent && !privateKey) {
      this.setState('error', 'A chave é protegida por senha e não há ssh-agent: informe a senha da chave na conexão.');
      throw new Error(this.error);
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;
      this.hostKeyProblem = null;
      let settled = false;
      client.on('ready', () => {
        settled = true;
        this.connectedAt = Date.now();
        this.reconnectDelay = RECONNECT_MIN;
        this.setState('connected');
        resolve(this.status());
      });
      client.on('error', (err) => {
        const raw = err && err.message ? err.message : String(err);
        const msg = this.hostKeyProblem || friendlyError(raw, config);
        if (!settled) {
          settled = true;
          this.setState('error', msg);
          reject(new Error(msg));
        } else {
          this.setState('error', msg);
        }
      });
      client.on('close', () => {
        if (this.client !== client) return;
            for (const [id, ch] of this.channels) this.emit(ch.kind === 'shell' ? 'shell-exit' : 'stream-end', { id, code: null });
        this.channels.clear();
        this.client = null;
        this.connectedAt = null;
        if (this.state !== 'error') this.setState('disconnected');
        // A changed host key is not a network blip: wait for the user instead of retrying.
        if (this.wantConnected && !this.hostKeyProblem) this.scheduleReconnect();
      });
      client.connect({
        host: config.host,
        port: Number(config.port) || 22,
        username: config.username || 'root',
        agent,
        privateKey,
        passphrase: privateKey && config.passphrase ? config.passphrase : undefined,
        // Agent keys first, then the key file.
        authHandler: buildAuthOrder(agent, privateKey, config),
        hostVerifier: (key) => this.verifyHostKey(key, config),
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      });
    });
  }

  // Pinned identity (config.hostKeys["host:port"]) wins; otherwise ~/.ssh/known_hosts is consulted
  // and a first-seen key is pinned (trust on first use, like `ssh`).
  verifyHostKey(key, config) {
    const blob = Buffer.isBuffer(key) ? key : Buffer.from(key);
    const fp = fingerprint(blob);
    const id = `${config.host}:${Number(config.port) || 22}`;
    this.hostKey = fp;
    const pinned = config.hostKeys && config.hostKeys[id];
    if (pinned) {
      if (pinned === fp) return true;
      this.hostKeyProblem = `A identidade do Echo mudou! Esperado ${pinned}, recebido ${fp}. ` +
        'Se você reinstalou o sistema do Echo isso é normal: abra a conexão (lápis) e clique em "Esquecer identidade". ' +
        'Se não, outro aparelho pode estar se passando pelo Echo.';
      return false;
    }
    const kh = knownHostsLookup(config.host, Number(config.port) || 22, blob);
    if (kh === 'mismatch' || kh === 'revoked') {
      this.hostKeyProblem = `A chave do Echo (${fp}) não confere com a registrada em ~/.ssh/known_hosts para ${hostToken(config.host, Number(config.port) || 22)}. ` +
        'Se você reinstalou o Echo, rode: ssh-keygen -R ' + config.host;
      return false;
    }
    config.hostKeys = { ...(config.hostKeys || {}), [id]: fp };
    this.emit('hostkey-pinned', { id, fingerprint: fp, fromKnownHosts: kh === 'match' });
    return true;
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(() => {
      if (!this.wantConnected || this.client) return;
      this.connect(this.config).catch(() => {});
    }, delay);
  }

  teardown() {
    const c = this.client;
    this.client = null;
    this.channels.clear();
    if (c) {
      try { c.end(); } catch (_) { /* ignore */ }
    }
  }

  disconnect() {
    this.wantConnected = false;
    this.reconnectDelay = RECONNECT_MIN;
    for (const q of this.queue.splice(0)) q.reject(new Error('Desconectado'));
    clearTimeout(this.reconnectTimer);
    this.teardown();
    this.connectedAt = null;
    this.setState('disconnected');
  }

  requireClient() {
    if (!this.client || this.state !== 'connected') throw new Error('Não conectado ao Echo');
    return this.client;
  }

  // Run a command, collect its output. Resolves { stdout, stderr, code, signal, durationMs }.
  exec(command, opts = {}) {
    this.requireClient();
    return new Promise((resolve, reject) => {
      this.queue.push({ command, opts, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.running < MAX_CONCURRENT_EXEC && this.queue.length) {
      const job = this.queue.shift();
      this.running++;
      this.execNow(job.command, job.opts)
        .then(job.resolve, job.reject)
        .finally(() => { this.running--; this.pump(); });
    }
  }

  execNow(command, opts) {
    const client = this.requireClient();
    const timeout = Math.min(Math.max(Number(opts.timeout) || 30000, 1000), 30 * 60 * 1000);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      client.exec(PATH_PREFIX + command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { stream.close(); } catch (_) { /* ignore */ }
          resolve({ stdout, stderr: stderr + `\n[tempo esgotado após ${timeout} ms]`, code: 124, signal: null, durationMs: Date.now() - started });
        }, timeout);
        stream.on('data', (d) => {
          if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
          else truncated = true;
        });
        stream.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8'); });
        stream.on('close', (code, signal) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (truncated) stderr += `\n[saída cortada em ${MAX_OUTPUT / 1024 / 1024} MB]`;
          resolve({ stdout, stderr, code: code == null ? null : code, signal: signal || null, durationMs: Date.now() - started });
        });
        if (opts.stdin != null) stream.end(opts.stdin);
      });
    });
  }

  // Long-running command whose output is pushed as events (tail -f, docker logs -f, docker stats).
  streamStart(command) {
    const client = this.requireClient();
    const id = `s${this.nextId++}`;
    return new Promise((resolve, reject) => {
      client.exec(PATH_PREFIX + watchChannel(command), (err, stream) => {
        if (err) return reject(err);
        this.channels.set(id, { kind: 'stream', stream });
        stream.on('data', (d) => this.emit('stream-data', { id, data: d.toString('utf8'), stderr: false }));
        stream.stderr.on('data', (d) => this.emit('stream-data', { id, data: d.toString('utf8'), stderr: true }));
        stream.on('close', (code) => {
          this.channels.delete(id);
          this.emit('stream-end', { id, code: code == null ? null : code });
        });
        resolve(id);
      });
    });
  }

  // Interactive login shell with a PTY (xterm.js on the other side).
  shellOpen({ cols = 80, rows = 24 } = {}) {
    cols = clampInt(cols, 10, 1000, 80);
    rows = clampInt(rows, 5, 500, 24);
    const client = this.requireClient();
    const id = `t${this.nextId++}`;
    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return reject(err);
        this.channels.set(id, { kind: 'shell', stream });
        stream.on('data', (d) => this.emit('shell-data', { id, data: d.toString('utf8') }));
        stream.stderr.on('data', (d) => this.emit('shell-data', { id, data: d.toString('utf8') }));
        stream.on('close', (code) => {
          this.channels.delete(id);
          this.emit('shell-exit', { id, code: code == null ? null : code });
        });
        resolve(id);
      });
    });
  }

  channel(id) {
    const ch = this.channels.get(id);
    if (!ch) throw new Error(`Canal ${id} não existe`);
    return ch;
  }

  write(id, data) { this.channel(id).stream.write(data); }

  resize(id, cols, rows) {
    const ch = this.channels.get(id);
    if (ch && ch.kind === 'shell') ch.stream.setWindow(clampInt(rows, 5, 500, 24), clampInt(cols, 10, 1000, 80), 0, 0);
  }

  close(id) {
    const ch = this.channels.get(id);
    if (!ch) return;
    try {
      if (ch.kind === 'stream') ch.stream.signal('INT');
    } catch (_) { /* dropbear may not support signals */ }
    try { ch.stream.close(); } catch (_) { /* ignore */ }
    this.channels.delete(id);
  }

  // File access goes through exec (cat / atomic write) so it works even if dropbear has no sftp-server.
  async readFile(remotePath) {
    if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) throw new Error('caminho inválido');
    const r = await this.exec(`cat -- ${shq(remotePath)}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `cat saiu com código ${r.code}`);
    return r.stdout;
  }

  async writeFile(remotePath, content) {
    if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) throw new Error('caminho inválido');
    if (typeof content !== 'string') throw new Error('conteúdo inválido');
    const tmp = `${remotePath}.echo-manager.tmp`;
    // Private temp file, flushed to the eMMC before it replaces the original (a power cut keeps
    // either the old or the new file, never half of one).
    const r = await this.exec(`umask 077 && cat > ${shq(tmp)} && sync && mv -f -- ${shq(tmp)} ${shq(remotePath)} && sync`, { stdin: content });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `escrita saiu com código ${r.code}`);
    return true;
  }
}

// Closing an exec channel does not stop the remote command on dropbear (no pty, no SIGHUP), so a
// `tail -F` would linger forever. Run the command in its own process group, and have a watcher
// that reads the channel's stdin (kept on fd 3) kill the whole group when the channel closes.
// When the command ends by itself, its exit code is passed through.
function watchChannel(command) {
  return `exec 3<&0; setsid sh -c ${shq(PATH_PREFIX + command)} & p=$!; ` +
    '( while read -r _; do :; done; kill -TERM -$p 2>/dev/null || kill -TERM $p ) <&3 >/dev/null 2>&1 & w=$!; ' +
    'wait $p; c=$?; kill $w 2>/dev/null; exit $c';
}

function findAgentSocket() {
  const candidates = [process.env.SSH_AUTH_SOCK];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid != null) {
    candidates.push(`/run/user/${uid}/keyring/ssh`, `/run/user/${uid}/gcr/ssh`, `/run/user/${uid}/ssh-agent.socket`);
  }
  for (const c of candidates) {
    try {
      if (c && fs.statSync(c).isSocket()) return c;
    } catch (_) { /* next */ }
  }
  return undefined;
}

// openssh-key-v1 format: the cipher name follows the magic; "none" means unencrypted.
function isEncryptedOpenSSH(raw) {
  const txt = raw.toString('utf8');
  const m = txt.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END/);
  if (!m) return false;
  const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  const magic = 'openssh-key-v1\0';
  if (buf.toString('latin1', 0, magic.length) !== magic) return false;
  const len = buf.readUInt32BE(magic.length);
  return buf.toString('latin1', magic.length + 4, magic.length + 4 + len) !== 'none';
}

function buildAuthOrder(agent, privateKey, config) {
  const methods = [];
  if (agent) methods.push('agent');
  if (privateKey) methods.push({ type: 'publickey', username: config.username || 'root', key: privateKey, passphrase: config.passphrase || undefined });
  return methods;
}

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { EchoSSH, expandHome };
