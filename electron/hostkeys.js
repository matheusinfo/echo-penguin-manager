// Host key checking: the Echo's identity is pinned on first use (TOFU) and cross-checked with the
// user's ~/.ssh/known_hosts, so a different machine answering on the Echo's address is refused.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** OpenSSH-style fingerprint of a raw public key blob: "SHA256:base64(no padding)". */
function fingerprint(blob) {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/** Key type stored at the start of a public key blob (e.g. "ssh-ed25519"). */
function keyType(blob) {
  try {
    const len = blob.readUInt32BE(0);
    return blob.toString('latin1', 4, 4 + len);
  } catch (_) {
    return '';
  }
}

function hostToken(host, port) {
  return Number(port) === 22 ? host : `[${host}]:${port}`;
}

function globToRegExp(glob) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

function patternMatches(pattern, token) {
  if (pattern.startsWith('|1|')) {
    // Hashed entry: |1|base64(salt)|base64(HMAC-SHA1(salt, host))
    const [, , salt, hash] = pattern.split('|');
    if (!salt || !hash) return false;
    const h = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(token).digest('base64');
    return h === hash;
  }
  return globToRegExp(pattern).test(token);
}

/**
 * Looks the host up in ~/.ssh/known_hosts.
 * Returns 'match' (same key listed), 'mismatch' (host listed with a different key of the same type),
 * 'revoked' (key marked @revoked) or 'unknown'.
 */
function knownHostsLookup(host, port, blob, file = path.join(os.homedir(), '.ssh', 'known_hosts')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return 'unknown';
  }
  const token = hostToken(host, port);
  const type = keyType(blob);
  const b64 = blob.toString('base64');
  let sawOtherKeyOfType = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let parts = line.split(/\s+/);
    let marker = null;
    if (parts[0].startsWith('@')) {
      marker = parts[0];
      parts = parts.slice(1);
    }
    if (parts.length < 3) continue;
    const [hosts, ktype, kdata] = parts;
    const patterns = hosts.split(',');
    const negated = patterns.some((p) => p.startsWith('!') && patternMatches(p.slice(1), token));
    if (negated || !patterns.some((p) => !p.startsWith('!') && patternMatches(p, token))) continue;
    if (marker === '@cert-authority') continue;
    if (marker === '@revoked') {
      if (kdata === b64) return 'revoked';
      continue;
    }
    if (ktype === type) {
      if (kdata === b64) return 'match';
      sawOtherKeyOfType = true;
    }
  }
  return sawOtherKeyOfType ? 'mismatch' : 'unknown';
}

module.exports = { fingerprint, keyType, knownHostsLookup, hostToken };
