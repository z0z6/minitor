'use strict';
// Dwa sposoby korzystania z Claude:
//  "claude-code" – oficjalny program Claude Code (CLI) zainstalowany na komputerze
//     i zalogowany kontem użytkownika (Pro/Max). Aplikacja uruchamia go w trybie
//     nieinteraktywnym (`claude -p`), więc korzysta z Twojego planu w sposób dozwolony
//     przez Anthropic – bez wyciągania tokenów logowania.
//  Klucz API (Claude lub Gemini) obsługuje silnik w oknie aplikacji przez pośrednika HTTP (main.js).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function candidatesForClaude() {
  const home = os.homedir();
  const list = [];
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    list.push(
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(appdata, 'npm', 'claude.cmd'),
      path.join(local, 'Programs', 'claude', 'claude.exe'),
      path.join(local, 'AnthropicClaude', 'claude.exe')
    );
  } else {
    list.push(
      path.join(home, '.local', 'bin', 'claude'),
      path.join(home, '.claude', 'local', 'claude'),
      path.join(home, '.npm-global', 'bin', 'claude'),
      path.join(home, '.bun', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      '/opt/homebrew/bin/claude'
    );
  }
  // katalogi z PATH
  const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) list.push(path.join(dir, 'claude' + ext));
  }
  return [...new Set(list)];
}

// Uruchamiamy wyłącznie program o nazwie claude / claude.exe / claude.cmd (ścieżka pochodzi z ustawień).
function isClaudeBinary(p) {
  if (typeof p !== 'string' || !p || /["\r\n%^&|<>]/.test(p)) return false;
  return /^claude(\.exe|\.cmd)?$/i.test(path.basename(p));
}

const SAFE_MODEL = /^[A-Za-z0-9._:-]{1,64}$/;

function findClaude(customPath) {
  if (customPath && isClaudeBinary(customPath) && fs.existsSync(customPath)) return customPath;
  for (const p of candidatesForClaude()) {
    try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* brak */ }
  }
  return null;
}

function runProcess(cmd, args, input, { cwd, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const isWinScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const child = spawn(isWinScript ? `"${cmd}"` : cmd, args, {
      cwd,
      shell: isWinScript,
      windowsHide: true,
      env: process.env
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Claude Code nie odpowiedział w wyznaczonym czasie.'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (input != null) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

class ClaudeCodeProvider {
  constructor(settings) {
    this.settings = settings;
  }

  get label() { return 'Konto Claude (Claude Code)'; }

  locate() { return findClaude(this.settings.ai.claudePath); }

  async run({ system, prompt, files: docs = [], model }) {
    if (typeof system !== 'string' || typeof prompt !== 'string') throw new Error('Niepoprawne zapytanie do Claude Code.');
    if (!Array.isArray(docs) || docs.length > 5) throw new Error('Za dużo plików do analizy.');
    const bin = this.locate();
    if (!bin) {
      throw new Error('Nie znaleziono programu Claude Code. Zainstaluj go (https://claude.com/claude-code), zaloguj się poleceniem „claude” i spróbuj ponownie – albo wskaż ścieżkę w Ustawieniach.');
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-prawa-'));
    try {
      const files = [];
      for (const [i, d] of docs.entries()) {
        const f = path.join(work, `akt-${i + 1}.pdf`); // stała nazwa: nazwa z okna nie wpływa na ścieżkę
        fs.writeFileSync(f, Buffer.from(String(d && d.data || ''), 'base64'), { mode: 0o600 });
        files.push(f);
      }
      // Jedyne narzędzie to odczyt plików (gdy są załączniki): bez powłoki, sieci i zapisu.
      const tools = files.length ? ['Read'] : [];
      let full = `${system}\n\n---\n\n${prompt}`;
      if (files.length) {
        full += `\n\nPliki do analizy (odczytaj każdy w całości narzędziem Read):\n${files.map((f) => '- ' + f).join('\n')}`;
      }
      full += '\n\nNie twórz ani nie modyfikuj żadnych plików. Odpowiedz wyłącznie wynikiem w żądanym formacie JSON.';
      const chosen = model || this.settings.ai.model || 'sonnet';
      if (!SAFE_MODEL.test(String(chosen))) throw new Error('Niepoprawna nazwa modelu.');
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--model', chosen];
      if (tools.length) args.push('--tools', tools.join(','), '--allowedTools', tools.join(','));
      else args.push('--tools', process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) ? '""' : '');
      const r = await runProcess(bin, args, full, { cwd: work, timeoutMs: 6 * 60 * 1000 });
      let parsed = null;
      try {
        parsed = JSON.parse(r.out);
        if (Array.isArray(parsed)) parsed = parsed.find((x) => x.type === 'result') || parsed[parsed.length - 1];
      } catch (_) { /* nie JSON */ }
      if (!parsed) {
        const msg = (r.err || r.out || '').trim().slice(0, 600);
        if (/login|log in|authenticat|zaloguj/i.test(msg)) {
          throw new Error('Claude Code nie jest zalogowany. Otwórz terminal, uruchom „claude” i zaloguj się swoim kontem Claude.');
        }
        throw new Error('Claude Code zwrócił nieoczekiwaną odpowiedź: ' + (msg || `kod ${r.code}`));
      }
      if (parsed.is_error) {
        const msg = String(parsed.result || parsed.subtype || 'błąd');
        if (/authenticat|log ?in|credential|unauthori[sz]ed|401/i.test(msg)) {
          throw new Error('Claude Code nie jest zalogowany (lub sesja wygasła). Otwórz terminal, uruchom „claude”, wpisz /login i zaloguj się swoim kontem Claude.');
        }
        if (/usage limit|rate limit|limit reached|429/i.test(msg)) {
          throw new Error('Osiągnięto limit użycia Twojego planu Claude. Spróbuj później albo przełącz się na klucz API w Ustawieniach → AI.');
        }
        throw new Error('Claude Code: ' + msg.slice(0, 600));
      }
      return { text: String(parsed.result || ''), usage: { costUsd: parsed.total_cost_usd || null } };
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = { ClaudeCodeProvider, findClaude, isClaudeBinary };
