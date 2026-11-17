'use strict';
// Połączenie z kontem Claude przez oficjalny program Claude Code:
// instalacja jednym kliknięciem, logowanie w przeglądarce (strona logowania Claude),
// sprawdzanie stanu i wylogowanie. Aplikacja nie widzi ani nie przechowuje Twojego
// hasła ani tokenów – logowanie i dane sesji obsługuje wyłącznie Claude Code.

const { spawn } = require('child_process');
const { findClaude } = require('./ai/providers');

function spawnClaude(bin, args, opts = {}) {
  const isWinScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  return spawn(isWinScript ? `"${bin}"` : bin, args, { shell: isWinScript, windowsHide: true, env: process.env, ...opts });
}

function run(bin, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawnClaude(bin, args); } catch (e) { resolve({ code: -1, out: '', err: e.message }); return; }
    const t = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    child.stdin.end();
  });
}

class ClaudeAccount {
  constructor({ getSettings, emit }) {
    this.getSettings = getSettings;
    this.emit = emit;
    this.login = null; // trwający proces logowania
  }

  bin() { return findClaude(this.getSettings().ai.claudePath); }

  async status() {
    const bin = this.bin();
    if (!bin) return { installed: false, loggedIn: false };
    const v = await run(bin, ['--version'], 20000);
    const s = await run(bin, ['auth', 'status', '--json'], 20000);
    let info = {};
    try { info = JSON.parse(s.out); } catch (_) { /* starsza wersja bez JSON */ }
    const email = info.email || (info.account && info.account.email) || info.emailAddress || null;
    return {
      installed: true,
      path: bin,
      version: (v.out || v.err).trim().split('\n')[0],
      loggedIn: !!info.loggedIn,
      authMethod: info.authMethod || null,
      email,
      plan: info.subscriptionType || info.plan || (info.account && info.account.plan) || null,
      expiresAt: info.loginExpiresAt || null
    };
  }

  install() {
    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const child = isWin
        ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'], { windowsHide: true })
        : spawn('bash', ['-lc', '(curl -fsSL https://claude.ai/install.sh || wget -qO- https://claude.ai/install.sh) | bash'], { env: process.env });
      const log = (d) => this.emit('claude:log', String(d));
      child.stdout.on('data', log);
      child.stderr.on('data', log);
      child.on('error', (e) => reject(new Error('Nie udało się uruchomić instalatora: ' + e.message)));
      child.on('close', async (code) => {
        const st = await this.status();
        if (st.installed) resolve(st);
        else reject(new Error(`Instalacja nie powiodła się (kod ${code}). Sprawdź połączenie z internetem i spróbuj ponownie.`));
      });
    });
  }

  // Start logowania: Claude Code otwiera stronę logowania Claude w przeglądarce.
  // Jeśli strona pokaże kod do przepisania, użytkownik wkleja go w aplikacji (przekazujemy go do Claude Code).
  startLogin() {
    const bin = this.bin();
    if (!bin) throw new Error('Najpierw zainstaluj Claude Code.');
    this.cancelLogin();
    const child = spawnClaude(bin, ['auth', 'login', '--claudeai']);
    const state = { child, url: null, done: false };
    this.login = state;
    let buf = '';
    const onData = (d) => {
      buf += String(d);
      const m = buf.match(/https:\/\/\S+oauth\S+/);
      if (m && !state.url) {
        state.url = m[0];
        this.emit('claude:login', { stage: 'url', url: state.url });
      }
      if (/paste code/i.test(buf)) this.emit('claude:login', { stage: 'code', url: state.url });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => this.emit('claude:login', { stage: 'error', error: e.message }));
    child.on('close', () => { state.closed = true; });
    // sprawdzanie, czy logowanie się udało
    const started = Date.now();
    const poll = async () => {
      if (this.login !== state || state.done) return;
      const st = await this.status();
      if (st.loggedIn) {
        state.done = true;
        this.cancelLogin();
        this.emit('claude:login', { stage: 'done', status: st });
        return;
      }
      if (Date.now() - started > 10 * 60 * 1000) {
        this.cancelLogin();
        this.emit('claude:login', { stage: 'error', error: 'Upłynął czas na zalogowanie. Spróbuj ponownie.' });
        return;
      }
      setTimeout(poll, 2500);
    };
    setTimeout(poll, 2500);
    return { started: true };
  }

  submitCode(code) {
    if (!this.login || this.login.closed) throw new Error('Logowanie nie jest w toku – kliknij „Zaloguj się” ponownie.');
    this.login.child.stdin.write(String(code).trim() + '\n');
    return true;
  }

  cancelLogin() {
    if (this.login) {
      try { this.login.child.kill(); } catch (_) { /* ignore */ }
    }
    this.login = null;
  }

  async logout() {
    const bin = this.bin();
    if (!bin) return this.status();
    await run(bin, ['auth', 'logout'], 20000);
    return this.status();
  }
}

module.exports = { ClaudeAccount };
