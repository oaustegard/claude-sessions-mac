// Preload for the hidden sound player window.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('player', {
  onPlay: (cb) => ipcRenderer.on('player:play', (_e, msg) => cb(msg)),
  load: (id) => ipcRenderer.invoke('player:load', id),
  done: (n) => ipcRenderer.send('player:done', n),
  failed: (n, message, code) => ipcRenderer.send('player:failed', n, message, code),
  status: (info) => ipcRenderer.send('player:status', info),
});
