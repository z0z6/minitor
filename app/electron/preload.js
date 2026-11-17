'use strict';
// Most między oknem a procesem głównym. Okno widzi wyłącznie te funkcje (window.desktop).
const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('desktop', {
  info: () => call('app:info'),
  windowControl: (a) => call('window:control', a),
  kvGet: (name) => call('kv:get', name),
  kvSet: (name, json) => call('kv:set', name, json),
  settingsChanged: () => call('settings:changed'),
  setAutostart: (on) => call('autostart:set', on),
  hasSecret: (name) => call('secret:has', name),
  setSecret: (name, value) => call('secret:set', name, value),
  fetch: (url, opts) => call('http:fetch', url, opts),
  notify: (title, body) => call('notify', title, body),
  claudeCode: (req) => call('ai:claudeCode', req),
  claudeStatus: () => call('claude:status'),
  claudeInstall: () => call('claude:install'),
  claudeLogin: () => call('claude:login'),
  claudeCodeSubmit: (code) => call('claude:code', code),
  claudeCancel: () => call('claude:cancel'),
  claudeLogout: () => call('claude:logout'),
  claudePath: () => call('claude:path'),
  claudeBrowse: () => call('claude:browse'),
  saveFile: (o) => call('file:save', o),
  openFile: (o) => call('file:open', o),
  openExternal: (u) => call('shell:openExternal', u),
  openData: () => call('shell:openData'),
  on: (channel, fn) => {
    const allowed = ['window:state', 'claude:log', 'claude:login', 'scan:request', 'nav'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
