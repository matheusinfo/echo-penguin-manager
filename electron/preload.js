'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

// Subscribe to a main→renderer event; returns an unsubscribe function.
function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('echo', {
  config: {
    get: () => invoke('config:get'),
    set: (cfg) => invoke('config:set', cfg),
    pickKey: () => invoke('config:pickKey'),
  },
  ssh: {
    connect: () => invoke('ssh:connect'),
    disconnect: () => invoke('ssh:disconnect'),
    status: () => invoke('ssh:status'),
    onStatus: (cb) => on('ssh:status', cb),
  },
  exec: (command, opts) => invoke('ssh:exec', command, opts),
  readFile: (p) => invoke('ssh:readFile', p),
  writeFile: (p, content) => invoke('ssh:writeFile', p, content),
  stream: {
    start: (command) => invoke('stream:start', command),
    stop: (id) => invoke('stream:stop', id),
    onData: (cb) => on('stream:data', cb),
    onEnd: (cb) => on('stream:end', cb),
  },
  shell: {
    open: (size) => invoke('shell:open', size),
    write: (id, data) => invoke('shell:write', id, data),
    resize: (id, cols, rows) => invoke('shell:resize', id, cols, rows),
    close: (id) => invoke('shell:close', id),
    onData: (cb) => on('shell:data', cb),
    onExit: (cb) => on('shell:exit', cb),
  },
  store: {
    get: (name, fallback) => invoke('store:get', name, fallback),
    set: (name, value) => invoke('store:set', name, value),
  },
  app: {
    notify: (title, body) => invoke('app:notify', title, body),
    saveText: (defaultName, content) => invoke('app:saveText', defaultName, content),
    openExternal: (url) => invoke('app:openExternal', url),
    info: () => invoke('app:info'),
  },
});
