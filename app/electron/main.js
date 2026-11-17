'use strict';
// Proces główny Electrona (Windows, Linux). Interfejs i silnik skanu działają w oknie (www/),
// a tutaj są tylko rzeczy, których okno nie może zrobić samo: pobieranie stron bez blokad CORS,
// zapis plików, zaszyfrowane klucze API, program Claude Code, zasobnik i powiadomienia.
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage, nativeTheme, safeStorage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { ClaudeAccount } = require('./claude-account');
const { ClaudeCodeProvider, findClaude } = require('./ai/providers');

const APP_NAME = 'Monitor prawa';
app.setName(APP_NAME);
app.commandLine.appendSwitch('lang', 'pl');
if (process.platform === 'win32') app.setAppUserModelId('pl.projektnumer4.monitorprawa');

// Wersja portable (Windows): dane obok pliku .exe
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataDir = process.env.MONITOR_DATA_DIR || (portableDir ? path.join(portableDir, `${APP_NAME} - dane`) : path.join(app.getPath('userData'), 'dane'));
fs.mkdirSync(dataDir, { recursive: true });

if (!process.env.APP_SHOTS && !app.requestSingleInstanceLock()) app.quit();

let win = null;
let tray = null;
let quitting = false;
let account = null;

// ─────────────────────────── pliki danych ───────────────────────────
const KV_NAMES = new Set(['state', 'settings']);
const kvFile = (name) => path.join(dataDir, `${name}.json`);

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch (_) { /* kopia zapasowa niekonieczna */ }
  fs.renameSync(tmp, file);
}

function kvGet(name) {
  if (!KV_NAMES.has(name)) throw new Error('Nieznany magazyn');
  for (const f of [kvFile(name), `${kvFile(name)}.bak`]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { /* następny */ }
  }
  return null;
}

function kvSet(name, json) {
  if (!KV_NAMES.has(name)) throw new Error('Nieznany magazyn');
  JSON.parse(json); // walidacja
  writeAtomic(kvFile(name), json);
  return true;
}

const SETTINGS_DEFAULTS = { ai: { provider: 'claude-code', model: 'sonnet', claudePath: '' }, ui: { theme: 'system' }, app: { runInBackground: true, autostart: false, notifications: true } };
function settings() {
  const s = kvGet('settings') || {};
  return {
    ai: { ...SETTINGS_DEFAULTS.ai, ...(s.ai || {}) },
    ui: { ...SETTINGS_DEFAULTS.ui, ...(s.ui || {}) },
    app: { ...SETTINGS_DEFAULTS.app, ...(s.app || {}) },
  };
}

// ─────────────────────────── klucze API ───────────────────────────
// Klucze są szyfrowane systemowo (safeStorage) i nigdy nie trafiają do okna:
// okno wysyła znacznik __SECRET:nazwa__, a proces główny podstawia klucz tuż przed wysłaniem zapytania.
const SECRET_HOSTS = { anthropic: 'api.anthropic.com', gemini: 'generativelanguage.googleapis.com' };
const secretFile = (name) => path.join(dataDir, `klucz-${name}.bin`);

function getSecret(name) {
  if (!SECRET_HOSTS[name]) return null;
  try {
    const raw = fs.readFileSync(secretFile(name));
    if (raw.slice(0, 4).toString() === 'b64:') return Buffer.from(raw.slice(4).toString(), 'base64').toString('utf8');
    return safeStorage.decryptString(raw);
  } catch (_) { return null; }
}

function setSecret(name, value) {
  if (!SECRET_HOSTS[name]) throw new Error('Nieznany klucz');
  const v = String(value || '').trim();
  if (!v) { try { fs.unlinkSync(secretFile(name)); } catch (_) { /* brak */ } return false; }
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(secretFile(name), safeStorage.encryptString(v));
  else fs.writeFileSync(secretFile(name), 'b64:' + Buffer.from(v, 'utf8').toString('base64'));
  return true;
}

function fillSecrets(url, headers) {
  const host = new URL(url).hostname;
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const m = typeof v === 'string' && v.match(/^__SECRET:(\w+)__$/);
    if (!m) { out[k] = v; continue; }
    if (SECRET_HOSTS[m[1]] !== host) throw new Error('Klucz API może trafić wyłącznie do swojego serwisu.');
    const key = getSecret(m[1]);
    if (!key) throw new Error('Brak zapisanego klucza API. Wpisz go w Ustawieniach → AI.');
    out[k] = key;
  }
  return out;
}

// ─────────────────────────── pobieranie stron ───────────────────────────
async function httpFetch(url, { method = 'GET', headers = {}, body, binary = false, timeoutMs = 45000 } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Dozwolone są tylko adresy http(s)');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { method, headers: fillSecrets(url, headers), body, signal: ctl.signal, redirect: 'follow' });
    const h = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    if (binary && res.ok) return { status: res.status, headers: h, base64: Buffer.from(await res.arrayBuffer()).toString('base64') };
    return { status: res.status, headers: h, text: await res.text() };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`przekroczono limit czasu ${timeoutMs} ms`);
    throw new Error(e.message || String(e));
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────── okno ───────────────────────────
function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const iconPath = () => path.join(__dirname, '..', 'www', 'icon.png');

function notify(title, body) {
  if (!settings().app.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath() });
  n.on('click', () => { showWindow(); emit('nav', { view: 'changes' }); });
  n.show();
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f7',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false, // automatyczny skan działa też przy oknie schowanym w zasobniku
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  if (process.env.APP_SHOTS) {
    win.webContents.on('console-message', (...a) => { const e = a[0]; console.log('[okno]', e && e.message ? e.message : a.slice(1).join(' ')); });
    win.webContents.once('did-finish-load', () => devScreenshots(process.env.APP_SHOTS));
  }
  win.on('close', (e) => {
    if (!quitting && settings().app.runInBackground && tray) {
      e.preventDefault();
      win.hide();
      const st = kvGet('settings') || {};
      if (!(st.hints && st.hints.tray)) {
        try { kvSet('settings', JSON.stringify({ ...st, hints: { ...(st.hints || {}), tray: true } })); } catch (_) { /* ignore */ }
        notify(`${APP_NAME} działa w tle`, 'Codzienny skan prawa uruchomi się sam. Aplikację zamkniesz z menu ikony w zasobniku.');
      }
    }
  });
  win.on('maximize', () => emit('window:state', { maximized: true }));
  win.on('unmaximize', () => emit('window:state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Tryb deweloperski: zrzuty ekranu widoków (APP_SHOTS=katalog, APP_STEPS="nazwa=<JS>,...")
async function devScreenshots(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  const steps = (process.env.APP_STEPS || 'pulpit').split(',');
  const [sw, sh] = (process.env.APP_SIZE || '1320x860').split('x').map(Number);
  win.setMinimumSize(320, 480);
  win.setSize(sw, sh);
  await wait(1800);
  for (const step of steps) {
    const [name, js] = step.split('=');
    if (js) await win.webContents.executeJavaScript(decodeURIComponent(js)).catch((e) => console.error(e));
    await wait(1000);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
  }
  quitting = true;
  app.quit();
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(iconPath()).resize({ width: 22, height: 22 });
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Otwórz ${APP_NAME}`, click: showWindow },
      { label: 'Skanuj teraz', click: () => emit('scan:request', { reason: 'z zasobnika' }) },
      { type: 'separator' },
      { label: 'Zakończ', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch (_) { tray = null; }
}

// ─────────────────────────── autostart ───────────────────────────
function applyAutostart(on) {
  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'autostart');
    const file = path.join(dir, 'monitor-prawa.desktop');
    const exe = process.env.APPIMAGE || process.execPath;
    if (on) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${APP_NAME}\nExec="${exe}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    } else {
      try { fs.unlinkSync(file); } catch (_) { /* brak */ }
    }
    return on;
  }
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: !!on, path: exe, args: ['--hidden'] });
  return on;
}

function applySettings() {
  const s = settings();
  nativeTheme.themeSource = s.ui.theme || 'system';
}

// ─────────────────────────── IPC ───────────────────────────
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    kind: 'desktop',
    dataDir,
    portable: !!portableDir,
    shots: !!process.env.APP_SHOTS,
  }));

  handle('window:control', (action) => {
    if (!win) return false;
    if (action === 'close') { win.close(); return false; }
    if (action === 'minimize') { win.minimize(); return win.isMaximized(); }
    if (action === 'maximize') {
      const target = !win.isMaximized(); // Linux maksymalizuje asynchronicznie: zwracamy stan docelowy
      if (target) win.maximize(); else win.unmaximize();
      return target;
    }
    return win.isMaximized();
  });

  handle('kv:get', (name) => kvGet(name));
  handle('kv:set', (name, json) => kvSet(name, json));
  handle('settings:changed', () => { applySettings(); return true; });
  handle('autostart:set', (on) => applyAutostart(on));

  handle('secret:has', (name) => !!getSecret(name));
  handle('secret:set', (name, value) => setSecret(name, value));

  handle('http:fetch', (url, opts) => httpFetch(url, opts));
  handle('notify', (title, body) => { notify(title, body); return true; });

  handle('ai:claudeCode', (req) => new ClaudeCodeProvider(settings()).run(req));
  handle('claude:status', () => account.status());
  handle('claude:install', () => account.install());
  handle('claude:login', () => account.startLogin());
  handle('claude:code', (code) => account.submitCode(code));
  handle('claude:cancel', () => { account.cancelLogin(); return true; });
  handle('claude:logout', () => account.logout());
  handle('claude:path', () => findClaude(settings().ai.claudePath));
  handle('claude:browse', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Wskaż program Claude Code', properties: ['openFile'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  handle('file:save', async ({ title, name, text, ext = 'json' }) => {
    const r = await dialog.showSaveDialog(win, { title, defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, text);
    return r.filePath;
  });
  handle('file:open', async ({ title, ext = 'json' }) => {
    const r = await dialog.showOpenDialog(win, { title, filters: [{ name: ext.toUpperCase(), extensions: [ext] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return fs.readFileSync(r.filePaths[0], 'utf8');
  });
  handle('shell:openExternal', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });
  handle('shell:openData', () => shell.openPath(dataDir));
}

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  applySettings();
  account = new ClaudeAccount({ getSettings: settings, emit });
  registerIpc();
  createWindow();
  if (!process.env.APP_SHOTS) createTray();
  app.on('activate', showWindow);
});

app.on('before-quit', () => { quitting = true; if (account) account.cancelLogin(); });
app.on('window-all-closed', () => {
  if (!settings().app.runInBackground || !tray) app.quit();
});
