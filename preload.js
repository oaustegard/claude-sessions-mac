// Preload for the popup window. The renderer gets this one object and no
// Node: every change it asks for goes to main, which checks it first.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('popup', {
  // main -> renderer
  onModel: on('popup:model'),
  onRename: on('popup:rename'),
  onReset: on('popup:reset'),

  // renderer -> main
  rowMenu: (key) => ipcRenderer.send('popup:row-menu', key),
  dndMenu: () => ipcRenderer.send('popup:dnd-menu'),
  activateRow: (key) => ipcRenderer.invoke('popup:activate', key), // -> { ok, notice }
  mute: (key) => ipcRenderer.send('popup:mute', key),
  copyResume: (key) => ipcRenderer.invoke('popup:copy-resume', key), // -> true when copied
  openFolder: (key) => ipcRenderer.send('popup:open-folder', key),
  setAlias: (key, text) => ipcRenderer.send('popup:alias', key, text),
  setSound: (key, id, scope) => ipcRenderer.send('popup:sound', key, id, scope),
  preview: (id) => ipcRenderer.invoke('popup:preview', id), // -> { ok, notice }
  setVolume: (pct) => ipcRenderer.send('popup:volume', pct),
  setShowAll: (on) => ipcRenderer.send('popup:show-all', on),
  setOpenAtLogin: (on) => ipcRenderer.send('popup:login', on),
  addSound: () => ipcRenderer.invoke('popup:add-sound'),
  installHooks: () => ipcRenderer.send('popup:install-hooks'),
  openDataFolder: () => ipcRenderer.send('popup:data-folder'),
  resize: (height) => ipcRenderer.send('popup:resize', height),
  close: () => ipcRenderer.send('popup:close'),
});
