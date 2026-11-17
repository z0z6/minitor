'use strict';
/* global UI, icon, Engine, P, Cap */
// Interfejs Monitora prawa: wspólny dla Windows, Linuksa (Electron) i Androida (Capacitor).
const { h, iconEl, toast, sheet, toggle, segmented, select, spinner, group, row, busy } = UI;

const PRIORITY_LABEL = { hi: 'Wysoki', mid: 'Średni', lo: 'Niski' };
const PRIORITY_CHIP = { hi: 'red', mid: 'orange', lo: 'teal' };
const WORKFLOW_LABEL = { new: 'Nowa', in_progress: 'W toku', done: 'Zrobiona', dismissed: 'Odrzucona' };
const WORKFLOW_CHIP = { new: 'blue', in_progress: 'purple', done: 'green', dismissed: '' };
const STATUS_LABEL = { obowiazuje: 'Obowiązuje', projekt: 'Projekt', wytyczne: 'Wytyczne', informacja: 'Informacja' };
const AFFECTS_LABEL = { yes: 'Dotyczy placówki', maybe: 'Może dotyczyć', no: 'Nie dotyczy' };
const CONF_LABEL = { high: 'wysoka', medium: 'średnia', low: 'niska' };
const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const WD = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const OPEN = new Set(['new', 'in_progress']);

const SETTINGS_DEFAULTS = () => ({
  ai: { provider: P.kind === 'desktop' ? 'claude-code' : 'gemini', model: 'sonnet', apiModel: 'claude-sonnet-5-5', geminiModel: 'gemini-3.5-flash', claudePath: '' },
  ui: { theme: 'system' },
  app: { autoScan: true, runInBackground: true, autostart: false, notifications: true },
  hints: {},
});

const state = {
  info: null,
  settings: null,
  monitor: null,
  cfg: null,
  changes: [],
  runs: [],
  lastLog: null,
  view: 'dashboard',
  scanning: null, // { reason, lines: [] }
  filter: { wf: 'open', prio: 'all', q: '', source: 'all' },
  tasksMode: 'role',
  tasksRole: 'all',
  settingsTab: 'general',
  secrets: { anthropic: false, gemini: false },
  claude: { status: null, login: null, installing: false, log: '', path: null },
  check: null,
  mobile: false,
};

// ───────────────────────── narzędzia ─────────────────────────
const plural = (n, a, b, c) => { if (n === 1) return a; const d = n % 10, t = n % 100; return d >= 2 && d <= 4 && !(t >= 12 && t <= 14) ? b : c; };
const tz = () => (state.cfg && state.cfg.school.timezone) || 'Europe/Warsaw';
const today = () => Engine.localParts(new Date(), tz()).date;
const plDate = (iso) => (iso ? Engine.plDate(String(iso).slice(0, 10)) : '');
const longToday = () => new Date().toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz() });
const timeOf = (isoTs) => new Date(isoTs).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: tz() });
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
function errToast(e) { toast(e.message || String(e), 'error', 8000); }

function relDays(iso) {
  if (!iso) return '';
  const d = Engine.daysBetween(today(), String(iso).slice(0, 10));
  if (d === 0) return 'dziś';
  if (d === 1) return 'jutro';
  if (d === -1) return 'wczoraj';
  return d > 0 ? `za ${d} ${plural(d, 'dzień', 'dni', 'dni')}` : `${-d} ${plural(-d, 'dzień', 'dni', 'dni')} temu`;
}

const chip = (text, color, ic) => h('span', { class: 'chip ' + (color || '') }, ic ? iconEl(ic, 11) : null, text);
const prioChip = (p) => chip(PRIORITY_LABEL[p] || p, PRIORITY_CHIP[p]);
const wfChip = (w) => chip(WORKFLOW_LABEL[w] || w, WORKFLOW_CHIP[w]);

function aiReady() {
  const p = state.settings.ai.provider;
  if (p === 'claude-code') return !!(state.claude.status && state.claude.status.loggedIn);
  if (p === 'claude') return state.secrets.anthropic;
  if (p === 'gemini') return state.secrets.gemini;
  return true;
}
function aiLabel() {
  const p = state.settings.ai.provider;
  return { 'claude-code': 'Konto Claude', claude: 'Claude (klucz API)', gemini: 'Gemini (klucz API)', rules: 'Bez AI' }[p] || p;
}

// ───────────────────────── dane ─────────────────────────
async function loadSettings() {
  const raw = (await P.kvGet('settings')) || {};
  const d = SETTINGS_DEFAULTS();
  state.settings = { ai: { ...d.ai, ...(raw.ai || {}) }, ui: { ...d.ui, ...(raw.ui || {}) }, app: { ...d.app, ...(raw.app || {}) }, hints: { ...(raw.hints || {}) } };
  if (P.kind !== 'desktop' && state.settings.ai.provider === 'claude-code') state.settings.ai.provider = 'gemini';
}

async function saveSettings(patch, quiet) {
  try {
    const s = state.settings;
    for (const [k, v] of Object.entries(patch)) s[k] = { ...(s[k] || {}), ...v };
    await P.kvSet('settings', s);
    await P.settingsChanged();
    applyTheme();
    if (!quiet) toast('Zapisano ustawienia', 'success', 1600);
  } catch (e) { errToast(e); }
}

async function loadData() {
  const m = state.monitor;
  state.cfg = await m.config();
  state.changes = await m.store.listChanges();
  state.runs = await m.store.listRuns();
  const st = await m.store.get();
  state.lastLog = (st.log || []).slice().reverse().find((l) => l.kind === 'scan' || l.kind === 'scan-error') || null;
}

async function loadSecrets() {
  state.secrets.anthropic = await P.hasSecret('anthropic');
  state.secrets.gemini = await P.hasSecret('gemini');
}

/** Zapisuje zmianę ustawień placówki (warstwa nad config/default.json). */
async function saveCfg(patch, quiet) {
  try {
    const cur = (await state.monitor.store.getConfig()) || {};
    const next = { ...cur, ...patch };
    const errors = Engine.validateConfig(next);
    if (errors.length) throw new Error('Niepoprawne ustawienia: ' + errors.slice(0, 2).join('; '));
    await state.monitor.store.setConfig(next);
    state.cfg = await state.monitor.config();
    if (!quiet) toast('Zapisano', 'success', 1400);
  } catch (e) { errToast(e); }
}

function applyTheme() {
  const t = state.settings.ui.theme;
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
}

// ───────────────────────── start ─────────────────────────
async function init() {
  state.info = await P.info();
  document.body.classList.add('platform-' + state.info.platform, 'kind-' + P.kind);
  const mq = window.matchMedia('(max-width: 760px)');
  state.mobile = P.kind === 'android' || mq.matches;
  document.body.classList.toggle('mobile', state.mobile);
  mq.addEventListener('change', (e) => { if (P.kind !== 'android') { state.mobile = e.matches; document.body.classList.toggle('mobile', state.mobile); render(); } });

  await loadSettings();
  applyTheme();
  state.monitor = Engine.createMonitor({
    platform: {
      fetch: P.fetch, loadState: () => P.kvGet('state'), saveState: (json) => P.kvSet('state', json),
      secret: P.secret, claudeCode: P.claudeCode, notify: (t, b) => { if (state.settings.app.notifications) P.notify(t, b); },
    },
    getSettings: () => state.settings,
  });
  state.monitor.on(onEngineEvent);
  await Promise.all([loadData(), loadSecrets()]);

  if (P.kind === 'desktop') {
    document.querySelectorAll('#traffic .tl').forEach((b) => b.addEventListener('click', async () => {
      const maximized = await P.windowControl(b.dataset.act);
      if (b.dataset.act === 'maximize') b.title = maximized ? 'Przywróć' : 'Maksymalizuj';
    }));
    P.on('window:state', (s) => { const b = document.querySelector('#traffic .tl.max'); if (b) b.title = s.maximized ? 'Przywróć' : 'Maksymalizuj'; });
    document.querySelector('.titlebar').addEventListener('dblclick', (e) => { if (!e.target.closest('.traffic')) P.windowControl('maximize'); });
    window.addEventListener('blur', () => document.body.classList.add('window-blur'));
    window.addEventListener('focus', () => document.body.classList.remove('window-blur'));
    P.on('claude:log', (t) => { state.claude.log = (state.claude.log + t).slice(-4000); const el = document.querySelector('.acc-log'); if (el) el.textContent = state.claude.log.split('\n').slice(-6).join('\n'); });
    P.on('claude:login', onClaudeLogin);
    P.on('scan:request', (r) => runScan(r && r.reason));
  }
  P.on('nav', (n) => go(n.view || 'changes'));
  if (P.kind === 'android') {
    // Przycisk „wstecz”: zamyka arkusz, potem wraca na pulpit, na końcu chowa aplikację (skan nie jest przerywany).
    Cap.App.addListener('backButton', () => {
      const o = document.querySelector('.sheet-overlay');
      if (o) { const x = o.querySelector('.sheet-head .icon-btn'); if (x) x.click(); return; }
      if (state.view !== 'dashboard') { go('dashboard'); return; }
      Cap.App.minimizeApp();
    });
  }
  P.onResume(() => { reload().then(() => autoScan()); });
  document.getElementById('content').addEventListener('scroll', (e) => e.target.classList.toggle('scrolled', e.target.scrollTop > 4));

  render();
  if (P.kind === 'desktop') await refreshClaude();
  if (state.info.shots) return; // zrzuty ekranu: bez automatycznego skanu
  setTimeout(autoScan, P.kind === 'android' ? 2500 : 8000);
  setInterval(autoScan, 5 * 60 * 1000);
}

async function reload() { await loadData(); render(); }

async function autoScan() {
  try {
    if (!state.settings.app.autoScan || state.scanning || !aiReady()) return;
    if (await state.monitor.isDue()) await runScan('automatycznie');
  } catch (e) { console.error('Automatyczny skan:', e); }
}

function onEngineEvent(ev) {
  if (ev.type === 'start') { state.scanning = { reason: ev.reason, lines: [] }; render(); }
  if (ev.type === 'progress' && state.scanning) {
    state.scanning.lines.push(ev.line);
    const el = document.getElementById('scan-line');
    if (el) el.textContent = ev.line.trim();
    const pill = document.querySelector('.agent-pill .t2');
    if (pill) pill.textContent = ev.line.trim().slice(0, 60);
  }
  if (ev.type === 'check') { state.check = ev.results; if (state.view === 'sources') render(); }
}

async function runScan(reason = 'ręcznie') {
  if (state.scanning) { toast('Skan już trwa…', 'info', 2000); return; }
  if (!aiReady() && state.settings.ai.provider !== 'rules') {
    toast('Najpierw połącz AI w Ustawieniach → AI (albo wybierz tryb „Bez AI”).', 'error', 6000);
    state.settingsTab = 'ai'; go('settings');
    return;
  }
  try {
    const sum = await state.monitor.scan({ reason });
    state.scanning = null;
    await loadData();
    render();
    const bad = sum.health.filter((x) => !x.ok).length;
    const aiMissed = sum.ai ? sum.ai.failed + sum.ai.pending : 0;
    const extra = [
      bad ? `${bad} ${plural(bad, 'źródło', 'źródła', 'źródeł')} z błędem` : '',
      aiMissed ? `${aiMissed} ${plural(aiMissed, 'pozycja czeka', 'pozycje czekają', 'pozycji czeka')} na analizę AI${sum.ai.stopped ? ` (${sum.ai.stopped.slice(0, 120)})` : ''}` : '',
    ].filter(Boolean).join(', ');
    toast(`Skan zakończony: ${sum.fresh.length ? `${sum.fresh.length} ${plural(sum.fresh.length, 'nowa zmiana', 'nowe zmiany', 'nowych zmian')}` : 'brak nowych zmian'}${extra ? `, ${extra}` : ''}.`,
      bad || aiMissed ? 'error' : 'success', aiMissed ? 10000 : 6000);
  } catch (e) {
    state.scanning = null;
    await loadData();
    render();
    errToast(e);
  }
}

function go(view) {
  state.view = view;
  render();
  document.getElementById('content').scrollTop = 0;
}

// ───────────────────────── nawigacja ─────────────────────────
const NAV = [
  ['dashboard', 'home', 'Pulpit'],
  ['changes', 'scale', 'Zmiany prawa'],
  ['tasks', 'tasks', 'Zadania'],
  ['sources', 'antenna', 'Źródła'],
];
const TITLES = { dashboard: 'Pulpit', changes: 'Zmiany prawa', tasks: 'Zadania', sources: 'Źródła i skany', settings: 'Ustawienia' };

function openCount() { return state.changes.filter((c) => c.workflow === 'new').length; }

function scanPill() {
  const S = state.scanning;
  const last = state.runs[0];
  const err = state.lastLog && state.lastLog.kind === 'scan-error' && (!last || state.lastLog.at > last.at);
  const dotCls = S ? 'busy' : err ? 'err' : !state.settings.app.autoScan ? 'off' : '';
  const t1 = S ? 'Skanuję…' : err ? 'Skan: problem' : last ? (last.date === today() ? 'Dzisiejszy skan gotowy' : 'Ostatni skan: ' + plDate(last.date)) : 'Jeszcze bez skanu';
  const t2 = S ? (S.lines[S.lines.length - 1] || 'Pobieram listy aktów…').trim().slice(0, 60)
    : err ? state.lastLog.error.slice(0, 60)
      : last ? `${timeOf(last.at)} · kliknij, aby skanować` : 'Kliknij, aby skanować teraz';
  return h('div', { class: 'agent-pill', title: 'Skanuj teraz', onclick: () => runScan() },
    h('span', { class: 'agent-dot ' + dotCls }),
    h('div', { style: { minWidth: 0 } }, h('div', { class: 't1' }, t1), h('div', { class: 't2' }, t2)));
}

function renderSidebar() {
  const sb = document.getElementById('sidebar');
  const n = openCount();
  sb.replaceChildren(
    h('div', { class: 'brand' },
      h('div', { class: 'brand-logo', html: icon('scale', 20) }),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'brand-name' }, 'Monitor prawa'), h('div', { class: 'brand-sub' }, shortSchool()))),
    h('div', { class: 'nav-section' }, 'Monitoring'),
    ...NAV.map(([v, ic, label]) => h('div', { class: 'nav-item' + (state.view === v ? ' active' : ''), onclick: () => go(v) },
      h('span', { html: icon(ic, 17) }), label, v === 'changes' && n ? h('span', { class: 'nav-badge' }, n) : null)),
    h('div', { class: 'nav-section' }, 'Aplikacja'),
    h('div', { class: 'nav-item' + (state.view === 'settings' ? ' active' : ''), onclick: () => go('settings') }, h('span', { html: icon('gear', 17) }), 'Ustawienia'),
    h('div', { class: 'sidebar-spacer' }),
    scanPill());
  const tb = document.getElementById('tabbar');
  tb.replaceChildren(...[...NAV, ['settings', 'gear', 'Ustawienia']].map(([v, ic, label]) =>
    h('button', { class: 'tab' + (state.view === v ? ' active' : ''), onclick: () => go(v) },
      h('span', { class: 'tab-ic', html: icon(ic, 22) }, v === 'changes' && n ? h('span', { class: 'tab-badge' }, n) : null),
      h('span', { class: 'tab-label' }, label === 'Zmiany prawa' ? 'Zmiany' : label))));
}

function shortSchool() {
  const n = (state.cfg && state.cfg.school.name) || '';
  return n.replace(/^Specjalny Ośrodek Szkolno-Wychowawczy/, 'SOSW');
}

function render() {
  renderSidebar();
  const c = document.getElementById('content');
  const views = { dashboard: viewDashboard, changes: viewChanges, tasks: viewTasks, sources: viewSources, settings: viewSettings };
  const el = views[state.view]();
  el.classList.add('fade-in');
  c.replaceChildren(el);
  document.getElementById('window-title').textContent = `${TITLES[state.view]} — Monitor prawa`;
}

function toolbar(title, ...right) {
  return h('div', { class: 'toolbar' }, h('h1', null, title), h('div', { class: 'spacer' }), ...right);
}

function scanButton(cls = '') {
  return h('button', { class: 'btn primary ' + cls, disabled: state.scanning ? true : null, onclick: () => runScan() },
    state.scanning ? spinner(14) : iconEl('refresh', 14), state.scanning ? 'Skanuję…' : 'Skanuj teraz');
}

function scanBanner() {
  if (!state.scanning) return null;
  const last = state.scanning.lines[state.scanning.lines.length - 1] || 'Pobieram listy nowych aktów…';
  return h('div', { class: 'card progress-banner scan-banner' }, spinner(18),
    h('div', { style: { minWidth: 0, flex: 1 } },
      h('div', { style: { fontWeight: 600 } }, `Trwa skan (${state.scanning.reason})`),
      h('div', { class: 'muted small ellipsis', id: 'scan-line' }, last.trim())));
}

function connectBanner() {
  if (aiReady()) return null;
  const desk = P.kind === 'desktop' && state.settings.ai.provider === 'claude-code';
  return h('div', { class: 'card connect-banner' },
    h('div', { class: 'acc-logo', html: icon('key', 22) }),
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { class: 'acc-title' }, desk ? 'Połącz aplikację z kontem Claude' : 'Podłącz analizę AI'),
      h('div', { class: 'muted small' }, desk
        ? 'Jedno kliknięcie: zainstaluję Claude Code i otworzę stronę logowania Claude. Potem każdy nowy akt dostanie streszczenie i zadania dla ról.'
        : 'Wpisz klucz API Gemini (darmowy poziom Google AI Studio) albo Claude. Bez tego aplikacja nie przeanalizuje nowych aktów.')),
    h('button', { class: 'btn primary lg', onclick: () => { state.settingsTab = 'ai'; go('settings'); } }, desk ? 'Połącz' : 'Ustaw'));
}

// ───────────────────────── PULPIT ─────────────────────────
function upcomingItems(days = 45) {
  const t = today();
  const out = [];
  for (const c of state.changes) {
    if (!OPEN.has(c.workflow)) continue;
    if (c.effective_date) out.push({ date: c.effective_date, kind: 'effective', text: 'Wejście w życie', c });
    for (const task of c.tasks || []) if (task.deadline) out.push({ date: task.deadline, kind: 'task', text: `${task.role}: ${task.action}`, c });
  }
  return out.filter((x) => { const d = Engine.daysBetween(t, x.date); return d >= -3 && d <= days; }).sort((a, b) => a.date.localeCompare(b.date));
}

function viewDashboard() {
  const hour = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz() }));
  const greet = hour < 5 || hour >= 18 ? 'Dobry wieczór' : 'Dzień dobry';
  const RANK = { hi: 0, mid: 1, lo: 2 };
  const open = state.changes.filter((c) => OPEN.has(c.workflow)).sort((a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3));
  const fresh = state.changes.filter((c) => c.workflow === 'new');
  const hi = open.filter((c) => c.priority === 'hi');
  const tasks = open.reduce((n, c) => n + (c.tasks || []).length, 0);
  const last = state.runs[0];
  const badSources = last ? (last.summary.health || []).filter((x) => !x.ok).length : 0;
  const up = upcomingItems();
  const next = up.find((u) => Engine.daysBetween(today(), u.date) >= 0);

  return h('div', null,
    toolbar('Pulpit', scanButton()),
    h('div', { class: 'page' },
      h('div', { class: 'hello' }, h('h1', null, greet), h('p', null, `${cap(longToday())} · ${shortSchool()}`)),
      connectBanner(),
      scanBanner(),
      h('div', { class: 'grid grid-3', style: { marginBottom: '16px' } },
        h('div', { class: 'hero blue', onclick: () => { state.filter.wf = 'new'; go('changes'); } },
          h('div', { class: 'hero-ic', html: icon('bell', 22) }),
          h('div', null, h('h3', null, fresh.length ? `${fresh.length} ${plural(fresh.length, 'nowa zmiana', 'nowe zmiany', 'nowych zmian')}` : 'Brak nowych zmian'),
            h('p', null, fresh.length ? 'Przejrzyj streszczenia i oznacz, co już obsłużone.' : last ? `Ostatni skan: ${plDate(last.date)}, ${timeOf(last.at)}.` : 'Uruchom pierwszy skan, aby pobrać akty z ostatnich 7 dni.'))),
        h('div', { class: 'hero purple', onclick: () => go('tasks') },
          h('div', { class: 'hero-ic', html: icon('tasks', 22) }),
          h('div', null, h('h3', null, tasks ? `${tasks} ${plural(tasks, 'zadanie', 'zadania', 'zadań')} dla ról` : 'Zadania dla ról'),
            h('p', null, tasks ? 'Konkretne działania przypisane dyrektorowi, pedagogom i administracji.' : 'Po analizie AI każda zmiana dostaje zadania dla właściwych osób.'))),
        h('div', { class: 'hero green', onclick: () => next && openChange(next.c) },
          h('div', { class: 'hero-ic', html: icon('calendar', 22) }),
          h('div', null, h('h3', null, next ? `Termin ${relDays(next.date)}` : 'Brak bliskich terminów'),
            h('p', { class: 'clamp2' }, next ? `${plDate(next.date)}: ${next.c.title}` : 'Tu pojawi się najbliższa data wejścia w życie lub termin zadania.')))),
      h('div', { class: 'grid grid-4', style: { marginBottom: '16px' } },
        statCard('Otwarte zmiany', open.length, plural(open.length, 'zmiana', 'zmiany', 'zmian'), 'scale'),
        statCard('Wysoki priorytet', hi.length, 'otwarte', 'flag'),
        statCard('Sprawdzone w ostatnim skanie', last ? last.summary.reviewed || 0 : 0, 'pozycji', 'search'),
        statCard('Źródła z błędem', badSources, last ? `z ${(last.summary.health || []).length}` : '', 'warn')),
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'card card-pad' },
          h('div', { class: 'card-title' }, h('span', { html: icon('scale', 16) }), 'Ostatnie zmiany', h('span', { class: 'spacer' }),
            h('button', { class: 'btn plain sm', onclick: () => { state.filter.wf = 'open'; go('changes'); } }, 'Wszystkie')),
          open.length ? open.slice(0, 6).map((c) => h('div', { class: 'ch-row', onclick: () => openChange(c) },
            prioChip(c.priority),
            h('div', { style: { minWidth: 0, flex: 1 } }, h('div', { class: 'ch-title' }, c.title), h('div', { class: 'muted small' }, `${c.source_name} · ${plDate(c.run_date)}`)),
            h('span', { class: 'muted', html: icon('chevronR', 14) })))
            : h('div', { class: 'empty' }, iconEl('checkCircle', 28), h('p', { style: { marginTop: '8px' } }, 'Wszystko obsłużone, brak otwartych zmian.'))),
        h('div', { class: 'card card-pad' },
          h('div', { class: 'card-title' }, h('span', { html: icon('calendar', 16) }), 'Nadchodzące terminy'),
          up.length ? up.slice(0, 7).map((u) => {
            const d = new Date(`${u.date}T12:00:00Z`);
            return h('div', { class: 'up-item', style: { cursor: 'pointer' }, onclick: () => openChange(u.c) },
              h('div', { class: 'date-badge' }, h('div', { class: 'm' }, MONTHS_SHORT[d.getUTCMonth()]), h('div', { class: 'd' }, d.getUTCDate())),
              h('div', { style: { minWidth: 0 } }, h('div', { class: 'ellipsis', style: { fontWeight: 550 } }, u.kind === 'task' ? u.text : u.c.title),
                h('div', { class: 'kind' }, h('span', { class: 'dot ' + (u.kind === 'task' ? 'occasion' : 'holiday') }), u.kind === 'task' ? 'Termin zadania' : 'Wejście w życie', ' · ', relDays(u.date))));
          }) : h('div', { class: 'empty' }, 'Brak terminów w najbliższych tygodniach.')))));
}

function statCard(label, value, unit, ic) {
  return h('div', { class: 'card stat' },
    h('div', { class: 'label', html: icon(ic, 14) + ' ' + label }),
    h('div', { class: 'value' }, String(value), unit ? h('small', null, unit) : null));
}

// ───────────────────────── ZMIANY ─────────────────────────
function filteredChanges() {
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  const RANK = { hi: 0, mid: 1, lo: 2 };
  return state.changes.slice().sort((a, b) => (b.run_date || '').localeCompare(a.run_date || '') || (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3)).filter((c) =>
    (f.wf === 'all' || (f.wf === 'open' ? OPEN.has(c.workflow) : c.workflow === f.wf))
    && (f.prio === 'all' || c.priority === f.prio)
    && (f.source === 'all' || c.source_id === f.source)
    && (!q || `${c.title} ${c.summary} ${c.what_changes}`.toLowerCase().includes(q)));
}

function viewChanges() {
  const f = state.filter;
  const list = filteredChanges();
  const search = h('input', { class: 'input search', type: 'search', placeholder: 'Szukaj w tytułach i streszczeniach', value: f.q,
    oninput: (e) => { f.q = e.target.value; const pos = e.target.selectionStart; render(); const s = document.querySelector('.input.search'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } } });
  const sources = [...new Map(state.changes.map((c) => [c.source_id, c.source_name])).entries()];
  return h('div', null,
    toolbar('Zmiany prawa', state.mobile ? null : search, scanButton()),
    h('div', { class: 'page' },
      scanBanner(),
      state.mobile ? h('div', { style: { marginBottom: '12px' } }, search) : null,
      h('div', { class: 'filterbar' },
        segmented([{ value: 'open', label: 'Otwarte' }, { value: 'new', label: 'Nowe' }, { value: 'done', label: 'Zrobione' }, { value: 'dismissed', label: 'Odrzucone' }, { value: 'all', label: 'Wszystkie' }], f.wf, (v) => { f.wf = v; render(); }),
        segmented([{ value: 'all', label: 'Każdy priorytet' }, { value: 'hi', label: 'Wysoki' }, { value: 'mid', label: 'Średni' }, { value: 'lo', label: 'Niski' }], f.prio, (v) => { f.prio = v; render(); }),
        sources.length > 1 ? select([{ value: 'all', label: 'Wszystkie źródła' }, ...sources.map(([v, l]) => ({ value: v, label: l }))], f.source, (v) => { f.source = v; render(); }) : null),
      list.length ? h('div', { class: 'ch-list' }, list.map(changeCard))
        : h('div', { class: 'card empty', style: { padding: '48px 20px' } }, iconEl('scale', 30),
          h('p', { style: { marginTop: '10px' } }, state.changes.length ? 'Brak zmian spełniających filtr.' : 'Jeszcze nie ma żadnych zmian. Uruchom skan, aby pobrać akty z ostatnich dni.'),
          !state.changes.length ? h('div', { style: { marginTop: '14px' } }, scanButton()) : null)));
}

function changeCard(c) {
  const tasks = (c.tasks || []).length;
  return h('div', { class: 'card ch-card prio-' + c.priority, onclick: () => openChange(c) },
    h('div', { class: 'ch-chips' }, prioChip(c.priority), c.workflow !== 'new' ? wfChip(c.workflow) : chip('Nowa', 'blue', 'bell'),
      chip(STATUS_LABEL[c.status] || c.status), h('span', { class: 'muted small ellipsis' }, c.source_name)),
    h('h3', { class: 'ch-h' }, c.title),
    c.summary ? h('p', { class: 'ch-sum' }, c.summary) : null,
    h('div', { class: 'ch-foot muted small' },
      c.effective_date ? h('span', null, iconEl('calendar', 12), ` Wejście w życie ${plDate(c.effective_date)} (${relDays(c.effective_date)})`) : h('span', null, iconEl('calendar', 12), ' Bez daty wejścia w życie'),
      tasks ? h('span', null, iconEl('tasks', 12), ` ${tasks} ${plural(tasks, 'zadanie', 'zadania', 'zadań')}`) : null,
      c.requires_statute_change ? h('span', null, iconEl('doc', 12), ' Zmiana statutu') : null,
      h('span', { class: 'spacer' }), h('span', null, `wykryto ${plDate(c.run_date)}`)));
}

function openChange(c0) {
  const c = state.changes.find((x) => x.key === c0.key) || c0;
  const note = h('textarea', { class: 'input full', rows: 3, placeholder: 'Notatka (np. kto się zajmuje, co już zrobiono)', value: c.note || '' });
  let wf = c.workflow;
  const excerpt = c.act_excerpt ? h('details', { class: 'excerpt' }, h('summary', null, 'Najważniejsze przepisy (cytat z aktu)'), h('pre', null, c.act_excerpt)) : null;
  const body = h('div', { class: 'ch-detail' },
    h('div', { class: 'ch-chips' }, prioChip(c.priority), chip(STATUS_LABEL[c.status] || c.status), chip(AFFECTS_LABEL[c.affects_school] || '', c.affects_school === 'yes' ? 'purple' : ''),
      c.confidence ? chip(`Pewność: ${CONF_LABEL[c.confidence] || c.confidence}`, c.confidence === 'low' ? 'orange' : '') : null),
    c.summary ? h('p', { class: 'lead' }, c.summary) : null,
    c.what_changes ? h('div', { class: 'd-sec' }, h('h4', null, 'Co się zmienia dla placówki'), h('p', null, c.what_changes)) : null,
    (c.priority_reasons || []).length ? h('div', { class: 'd-sec' }, h('h4', null, 'Dlaczego taki priorytet'), h('ul', { class: 'bullets' }, c.priority_reasons.map((r) => h('li', null, r)))) : null,
    (c.tasks || []).length ? h('div', { class: 'd-sec' }, h('h4', null, 'Zadania'),
      c.tasks.map((t) => h('div', { class: 'issue' }, h('span', { class: 'ic', html: icon('person', 14) }),
        h('div', null, h('b', null, t.role), ': ', t.action, t.deadline ? h('span', { class: 'muted' }, ` (do ${plDate(t.deadline)}, ${relDays(t.deadline)})`) : null)))) : null,
    (c.documents || []).length || c.requires_statute_change || c.requires_council_resolution ? h('div', { class: 'd-sec' }, h('h4', null, 'Dokumenty szkoły'),
      h('div', { class: 'ch-chips' }, (c.documents || []).map((d) => chip(d, 'blue', 'doc')),
        c.requires_statute_change ? chip('Wymaga zmiany statutu', 'red') : null,
        c.requires_council_resolution ? chip('Wymaga uchwały rady pedagogicznej', 'orange') : null)) : null,
    h('div', { class: 'd-sec' }, h('h4', null, 'Akt'),
      h('div', { class: 'kv' },
        h('span', null, 'Źródło'), h('span', null, c.source_name),
        c.published_at ? h('span', null, 'Publikacja') : null, c.published_at ? h('span', null, plDate(c.published_at)) : null,
        h('span', null, 'Wejście w życie'), h('span', null, c.effective_date ? `${plDate(c.effective_date)} (${relDays(c.effective_date)})` : 'brak w danych'),
        c.legal_basis ? h('span', null, 'Podstawa') : null, c.legal_basis ? h('span', null, c.legal_basis) : null)),
    c.review_note ? h('div', { class: 'note-box warn' }, iconEl('warn', 16), h('div', null, h('b', null, 'Do sprawdzenia: '), c.review_note)) : null,
    excerpt,
    h('div', { class: 'd-sec' }, h('h4', null, 'Stan obsługi'),
      segmented(Object.entries(WORKFLOW_LABEL).map(([value, label]) => ({ value, label })), wf, (v) => { wf = v; }),
      h('div', { style: { marginTop: '10px' } }, note)),
    h('p', { class: 'muted small', style: { marginTop: '14px' } }, 'Streszczenie przygotował asystent AI i może zawierać błędy. Przed zmianą dokumentów sprawdź treść aktu w źródle.'));
  sheet({
    title: c.title,
    subtitle: `${c.source_name} · wykryto ${plDate(c.run_date)}`,
    wide: true,
    body,
    actions: [
      c.url ? { label: 'Otwórz źródło', onClick: () => { P.openExternal(c.url); return false; } } : null,
      { label: 'Zamknij' },
      { label: 'Zapisz', kind: 'primary', onClick: async () => {
        try { await state.monitor.store.updateChange(c.key, { workflow: wf, note: note.value }); await loadData(); render(); toast('Zapisano', 'success', 1400); } catch (e) { errToast(e); return false; }
      } },
    ].filter(Boolean),
  });
}

// ───────────────────────── ZADANIA ─────────────────────────
function allTasks() {
  const out = [];
  for (const c of state.changes) {
    if (!OPEN.has(c.workflow)) continue;
    for (const t of c.tasks || []) out.push({ ...t, c });
  }
  return out;
}

function viewTasks() {
  const tasks = allTasks();
  const roles = state.cfg.roles.map((r) => r.name);
  const filtered = tasks.filter((t) => state.tasksRole === 'all' || t.role === state.tasksRole);
  let content;
  if (!filtered.length) {
    content = h('div', { class: 'card empty', style: { padding: '48px 20px' } }, iconEl('tasks', 30), h('p', { style: { marginTop: '10px' } }, 'Brak otwartych zadań.'));
  } else if (state.tasksMode === 'role') {
    const byRole = new Map();
    for (const t of filtered) { if (!byRole.has(t.role)) byRole.set(t.role, []); byRole.get(t.role).push(t); }
    const order = [...roles, ...[...byRole.keys()].filter((r) => !roles.includes(r))];
    content = h('div', null, order.filter((r) => byRole.has(r)).map((r) => group(`${r} · ${byRole.get(r).length}`,
      byRole.get(r).sort((a, b) => (a.deadline || '9').localeCompare(b.deadline || '9')).map(taskRow))));
  } else {
    const sorted = filtered.slice().sort((a, b) => (a.deadline || a.c.effective_date || '9').localeCompare(b.deadline || b.c.effective_date || '9'));
    content = group(null, sorted.map(taskRow));
  }
  return h('div', null,
    toolbar('Zadania', segmented([{ value: 'role', label: 'Według ról' }, { value: 'date', label: 'Według terminów' }], state.tasksMode, (v) => { state.tasksMode = v; render(); })),
    h('div', { class: 'page' },
      h('div', { class: 'filterbar' }, select([{ value: 'all', label: 'Wszystkie role' }, ...roles.map((r) => ({ value: r, label: r }))], state.tasksRole, (v) => { state.tasksRole = v; render(); }),
        h('span', { class: 'muted small' }, 'Zadania z otwartych zmian. Oznacz zmianę jako zrobioną, gdy wszystkie zadania są wykonane.')),
      content));
}

function taskRow(t) {
  const date = t.deadline || t.c.effective_date;
  const late = date && Engine.daysBetween(today(), date) < 0;
  return h('div', { class: 'row task-row', onclick: () => openChange(t.c) },
    h('div', { class: 'row-label' },
      h('span', { class: 'row-icon', style: { background: `var(--${PRIORITY_CHIP[t.c.priority] === 'teal' ? 'teal' : PRIORITY_CHIP[t.c.priority]})` }, html: icon('check', 13) }),
      h('div', { style: { minWidth: 0 } },
        h('div', null, state.tasksMode === 'date' ? h('b', null, `${t.role}: `) : null, t.action),
        h('div', { class: 'row-hint ellipsis' }, t.c.title))),
    h('div', { class: 'row-control' }, date ? h('span', { class: 'chip ' + (late ? 'red' : '') }, t.deadline ? `do ${plDate(date)}` : `wchodzi ${plDate(date)}`) : h('span', { class: 'muted small' }, 'bez terminu')));
}

// ───────────────────────── ŹRÓDŁA ─────────────────────────
function viewSources() {
  const last = state.runs[0];
  const health = new Map(((last && last.summary.health) || []).map((x) => [x.id, x]));
  const checks = new Map((state.check || []).map((x) => [x.id, x]));
  const cfgSources = state.cfg.sources;
  const toggleSource = async (s, on) => {
    const cur = (await state.monitor.store.getConfig()) || {};
    const list = (cur.sources || []).filter((x) => x.id !== s.id);
    await saveCfg({ sources: [...list, { ...s, enabled: on }] }, true);
    render();
  };
  return h('div', null,
    toolbar('Źródła i skany',
      h('button', { class: 'btn', disabled: state.check === 'busy' ? true : null, onclick: async (e) => {
        await busy(e.currentTarget, async () => { state.check = []; try { state.check = await state.monitor.checkSources(); } catch (er) { errToast(er); } render(); }, 'Sprawdzam…');
      } }, iconEl('antenna', 14), 'Sprawdź źródła'),
      scanButton()),
    h('div', { class: 'page' },
      scanBanner(),
      last ? h('div', { class: 'card card-pad', style: { marginBottom: '18px' } },
        h('div', { class: 'card-title' }, h('span', { html: icon('clock', 16) }), `Ostatni skan: ${plDate(last.date)}, ${timeOf(last.at)}`, h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm', onclick: () => openReport(last.date) }, iconEl('doc', 13), 'Raport')),
        h('div', { class: 'muted' }, `Sprawdzono ${last.summary.reviewed || 0} nowych pozycji, ${last.summary.changes || 0} ${plural(last.summary.changes || 0, 'zmiana dotyczy', 'zmiany dotyczą', 'zmian dotyczy')} placówki.`),
        state.lastLog && state.lastLog.lines ? h('details', { class: 'excerpt', style: { marginTop: '10px' } }, h('summary', null, 'Dziennik ostatniego skanu'), h('pre', null, state.lastLog.lines.join('\n'))) : null)
        : h('div', { class: 'note-box' }, iconEl('info', 16), h('div', null, 'Pierwszy skan obejmie ostatnie ', String(state.cfg.schedule.lookbackDays), ' dni. Źródła bez dat (np. BIP) przy pierwszym skanie tylko zapamiętują istniejące pozycje.')),
      group('Źródła', cfgSources.map((s) => {
        const hl = health.get(s.id);
        const ck = checks.get(s.id);
        const aiWait = hl ? (hl.aiFailed || 0) + (hl.aiPending || 0) : 0;
        const hint = ck ? (ck.ok ? `Test: OK, ${ck.count} pozycji${ck.sample ? ` (np. ${ck.sample.slice(0, 60)})` : ''}${ck.warn ? `. Uwaga: ${ck.warn}` : ''}` : `Test: błąd: ${ck.error}`)
          : hl ? (hl.ok ? `Ostatnio: ${hl.listed} na liście, ${hl.fresh} nowych, ${hl.analyzed} przeanalizowanych${hl.baselined ? `, zapamiętano ${hl.baselined}` : ''}${aiWait ? `, ${aiWait} czeka na analizę AI` : ''}${hl.warn ? `. Uwaga: ${hl.warn}` : ''}` : `Błąd: ${hl.error}`) : 'Jeszcze nie sprawdzano';
        const bad = (ck && !ck.ok) || (!ck && hl && !hl.ok);
        const warn = !bad && ((ck && ck.warn) || (!ck && hl && (hl.warn || aiWait)));
        return row(s.name, toggle(s.enabled !== false, (v) => toggleSource(s, v)),
          { icon: bad || warn ? 'warn' : 'antenna', color: s.enabled === false ? 'var(--text-3)' : bad ? 'var(--red)' : warn ? 'var(--orange)' : 'var(--green)', hint });
      }), 'Wyłączone źródło nie jest pobierane przy skanie. Wiarygodność źródeł opisuje README w repozytorium.'),
      state.runs.length ? group('Historia skanów', state.runs.slice(0, 30).map((r) => {
        const bad = (r.summary.health || []).filter((x) => !x.ok).length;
        return row(`${cap(new Date(`${r.date}T12:00:00Z`).toLocaleDateString('pl-PL', { weekday: 'long', timeZone: 'UTC' }))}, ${plDate(r.date)}`,
          h('button', { class: 'btn sm', onclick: () => openReport(r.date) }, 'Raport'),
          { icon: bad ? 'warn' : 'checkCircle', color: bad ? 'var(--orange)' : 'var(--green)', hint: `${r.summary.changes || 0} ${plural(r.summary.changes || 0, 'zmiana', 'zmiany', 'zmian')}, sprawdzono ${r.summary.reviewed || 0}${bad ? `, ${bad} ${plural(bad, 'źródło', 'źródła', 'źródeł')} z błędem` : ''}` });
      })) : null));
}

async function openReport(date) {
  const r = await state.monitor.store.getReport(date);
  if (!r) { toast('Brak zapisanego raportu z tego dnia.', 'info'); return; }
  const frame = h('iframe', { class: 'report-frame', sandbox: '', srcdoc: r.html, title: r.subject });
  sheet({ title: r.subject, subtitle: `Raport z ${plDate(date)}`, wide: true, body: frame, actions: [{ label: 'Zamknij', kind: 'primary' }] });
}

// ───────────────────────── USTAWIENIA ─────────────────────────
function viewSettings() {
  const tabs = [
    { value: 'general', label: 'Ogólne', icon: 'home' },
    { value: 'ai', label: 'AI', icon: 'cpu' },
    { value: 'scan', label: 'Skan', icon: 'clock' },
    { value: 'roles', label: 'Role', icon: 'people' },
    { value: 'docs', label: 'Dokumenty', icon: 'doc' },
    { value: 'rules', label: 'Reguły', icon: 'flag' },
  ];
  const body = { general: settingsGeneral, ai: settingsAi, scan: settingsScan, roles: settingsRoles, docs: settingsDocs, rules: settingsRules }[state.settingsTab]();
  return h('div', null,
    toolbar('Ustawienia'),
    h('div', { class: 'page' },
      h('div', { class: 'settings-tabs' }, segmented(tabs, state.settingsTab, (v) => { state.settingsTab = v; render(); })),
      body));
}

function textInput(value, onSave, attrs = {}) {
  return h('input', { class: 'input', style: { width: attrs.width || '300px' }, value: value == null ? '' : value, placeholder: attrs.placeholder || '', type: attrs.type || 'text', min: attrs.min, max: attrs.max, onchange: (e) => onSave(e.target.value) });
}

function settingsGeneral() {
  const s = state.settings;
  const school = state.cfg.school;
  return h('div', null,
    group('Placówka', [
      row('Nazwa', textInput(school.name, (v) => saveCfg({ school: { ...school, name: v.trim() || school.name } }), { width: '380px' }), { icon: 'home', color: 'var(--accent)' }),
      row('Opis placówki dla AI', h('textarea', { class: 'input full', rows: 5, value: school.profile, onchange: (e) => saveCfg({ school: { ...state.cfg.school, profile: e.target.value } }) }),
        { icon: 'sparkles', color: 'var(--purple)', stack: true, hint: 'Typ szkoły, oddziały, internat, kształcenie zawodowe. Od tego opisu zależy ocena, czy akt dotyczy placówki.' }),
    ]),
    group('Wygląd', [
      row('Motyw', segmented([{ value: 'system', label: 'Systemowy' }, { value: 'light', label: 'Jasny' }, { value: 'dark', label: 'Ciemny' }], s.ui.theme, (v) => saveSettings({ ui: { theme: v } }, true)), { icon: 'paint', color: 'var(--pink)' }),
    ]),
    group('Dane', [
      row('Folder danych', P.kind === 'desktop' ? h('button', { class: 'btn sm', onclick: () => P.openData() }, iconEl('folder', 13), 'Otwórz') : h('span', { class: 'muted' }, state.info.dataDir),
        { icon: 'folder', color: 'var(--orange)', hint: P.kind === 'desktop' ? (state.info.portable ? `Wersja przenośna: dane leżą obok pliku .exe (${state.info.dataDir}).` : state.info.dataDir) : 'Dane są tylko na tym urządzeniu. Rób kopię przed odinstalowaniem.' }),
      row('Kopia danych', h('div', { class: 'btn-row' },
        h('button', { class: 'btn sm', onclick: exportBackup }, iconEl('download', 13), 'Zapisz kopię'),
        h('button', { class: 'btn sm', onclick: importBackup }, iconEl('upload', 13), 'Wczytaj kopię')),
        { icon: 'shield', color: 'var(--green)', hint: 'Plik JSON ze zmianami, historią skanów i ustawieniami placówki (bez kluczy API).' }),
      row('Wersja', h('span', { class: 'muted' }, `${state.info.version} · ${{ desktop: state.info.platform === 'win32' ? 'Windows' : 'Linux', android: 'Android', web: 'przeglądarka' }[P.kind]}`), { icon: 'info', color: 'var(--text-3)' }),
    ]));
}

async function exportBackup() {
  try {
    const name = `monitor-prawa-kopia-${today()}.json`;
    const p = await P.saveFile({ title: 'Zapisz kopię danych', name, text: await state.monitor.store.exportAll() });
    if (p) toast(`Zapisano kopię: ${p}`, 'success', 5000);
  } catch (e) { errToast(e); }
}

async function importBackup() {
  try {
    const text = await P.openFile({ title: 'Wczytaj kopię danych' });
    if (!text) return;
    await state.monitor.store.importAll(text);
    await loadData(); render();
    toast('Wczytano kopię danych', 'success');
  } catch (e) { errToast(e); }
}

// ── połączenie z kontem Claude (komputer) ──
function onClaudeLogin(ev) {
  const C = state.claude;
  if (ev.stage === 'url' || ev.stage === 'code') { C.login = { ...(C.login || {}), stage: ev.stage, url: ev.url || (C.login && C.login.url) }; if (state.view === 'settings') render(); }
  if (ev.stage === 'done') { C.login = null; C.status = ev.status; toast('Połączono z kontem Claude', 'success'); render(); }
  if (ev.stage === 'error') { C.login = null; errToast(new Error(ev.error)); render(); }
}

async function refreshClaude() {
  if (!P.claude) return;
  try { state.claude.status = await P.claude.status(); state.claude.path = await P.claude.path(); } catch (e) { state.claude.status = { installed: false, loggedIn: false }; }
  render();
}

async function installAndLogin() {
  const C = state.claude;
  C.installing = true; C.log = ''; render();
  try {
    C.status = await P.claude.install();
    C.installing = false; render();
    if (C.status.installed && !C.status.loggedIn) await startLogin();
  } catch (e) { C.installing = false; errToast(e); render(); }
}

async function startLogin() {
  const C = state.claude;
  try { C.login = { stage: 'start' }; render(); await P.claude.login(); } catch (e) { C.login = null; errToast(e); render(); }
}

function accountCard() {
  const C = state.claude;
  const st = C.status;
  const wrap = h('div', { class: 'account' });
  if (!st) { wrap.append(h('div', { class: 'acc-row' }, spinner(18), h('span', { class: 'muted' }, 'Sprawdzam połączenie z kontem Claude…'))); return wrap; }
  const logo = (cls) => h('div', { class: 'acc-logo ' + (cls || ''), html: icon(st.loggedIn ? 'checkCircle' : 'person', 24) });
  if (st.loggedIn) {
    wrap.append(h('div', { class: 'acc-row' }, logo('ok'),
      h('div', { style: { flex: 1 } },
        h('div', { class: 'acc-title' }, 'Połączono z kontem Claude'),
        h('div', { class: 'muted small' }, [st.email, st.plan ? `plan ${st.plan}` : null].filter(Boolean).join(' · ') || 'Analizy korzystają z Twojego planu Claude.')),
      h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, testAi, 'Testuję…') }, iconEl('bolt', 14), 'Testuj'),
      h('button', { class: 'btn danger', onclick: async () => { try { C.status = await P.claude.logout(); render(); } catch (er) { errToast(er); } } }, 'Wyloguj')));
    return wrap;
  }
  if (!st.installed) {
    wrap.append(h('div', { class: 'acc-row' }, logo(),
      h('div', { style: { flex: 1 } },
        h('div', { class: 'acc-title' }, 'Połącz aplikację ze swoim kontem Claude'),
        h('div', { class: 'muted small' }, 'Jednorazowo zainstaluję oficjalny program Claude Code od Anthropic (ok. 1 minuty), a potem otworzę stronę logowania Claude.')),
      h('button', { class: 'btn primary lg', disabled: C.installing || null, onclick: installAndLogin }, C.installing ? spinner(14) : iconEl('download', 15), C.installing ? 'Instaluję…' : 'Zainstaluj i połącz')));
    if (C.installing || C.log) wrap.append(h('pre', { class: 'acc-log' }, (C.log || '').split('\n').slice(-6).join('\n')));
    return wrap;
  }
  const L = C.login;
  if (!L) {
    wrap.append(h('div', { class: 'acc-row' }, logo(),
      h('div', { style: { flex: 1 } },
        h('div', { class: 'acc-title' }, 'Zaloguj się swoim kontem Claude'),
        h('div', { class: 'muted small' }, 'Otworzy się strona logowania Claude w przeglądarce. Zaloguj się tak samo jak na claude.ai.')),
      h('button', { class: 'btn primary lg', onclick: startLogin }, iconEl('key', 15), 'Zaloguj się')));
    return wrap;
  }
  const code = h('input', { class: 'input', style: { flex: 1 }, placeholder: 'Wklej kod ze strony logowania (jeśli się pojawił)' });
  wrap.append(
    h('div', { class: 'acc-row' }, h('div', { class: 'acc-logo' }, spinner(20)),
      h('div', { style: { flex: 1 } },
        h('div', { class: 'acc-title' }, 'Czekam na zalogowanie w przeglądarce…'),
        h('div', { class: 'muted small' }, 'Zaloguj się na stronie Claude, która otworzyła się w przeglądarce. Po zalogowaniu aplikacja połączy się sama.')),
      h('button', { class: 'btn', onclick: async () => { await P.claude.cancel(); C.login = null; render(); } }, 'Anuluj')),
    h('div', { class: 'acc-sub' },
      L.url ? h('button', { class: 'btn plain sm', onclick: () => P.openExternal(L.url) }, iconEl('globe', 12), 'Przeglądarka się nie otworzyła? Otwórz stronę logowania') : null,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } }, code,
        h('button', { class: 'btn primary', onclick: async () => { if (!code.value.trim()) return; try { await P.claude.submit(code.value); toast('Przekazano kod, trwa łączenie…', 'info', 3000); } catch (er) { errToast(er); } } }, 'Zatwierdź kod'))));
  return wrap;
}

async function testAi() {
  try { const r = await state.monitor.testAi(); toast(r, 'success', 7000); } catch (e) { errToast(e); }
}

function keyRow(name, label, placeholder, url) {
  const input = h('input', { class: 'input', type: 'password', style: { width: '260px' }, placeholder: state.secrets[name] ? '•••••••• (zapisany)' : placeholder, autocomplete: 'off' });
  return [
    row(label, h('div', { class: 'btn-row' }, input,
      h('button', { class: 'btn', onclick: async () => {
        try { state.secrets[name] = await P.setSecret(name, input.value); toast(state.secrets[name] ? 'Zapisano klucz' : 'Usunięto klucz', 'success'); render(); } catch (e) { errToast(e); }
      } }, 'Zapisz')),
    { icon: 'key', color: state.secrets[name] ? 'var(--green)' : 'var(--text-3)', hint: state.secrets[name] ? 'Klucz zapisany. Zostaw pole puste i kliknij Zapisz, aby go usunąć.' : null }),
    row('Skąd wziąć klucz', h('button', { class: 'btn sm', onclick: () => P.openExternal(url) }, iconEl('globe', 12), new URL(url).hostname), { icon: 'globe', color: 'var(--teal)' }),
  ];
}

function settingsAi() {
  const s = state.settings;
  const p = s.ai.provider;
  const providers = [
    P.kind === 'desktop' ? { value: 'claude-code', label: 'Konto Claude' } : null,
    { value: 'claude', label: 'Klucz Claude' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'rules', label: 'Bez AI' },
  ].filter(Boolean);
  const testBtn = h('button', { class: 'btn' }, iconEl('bolt', 14), 'Testuj połączenie');
  testBtn.addEventListener('click', () => busy(testBtn, testAi, 'Testuję…'));
  return h('div', null,
    group('Sposób analizy', [
      row('Dostawca', segmented(providers, p, async (v) => { await saveSettings({ ai: { provider: v } }, true); if (v === 'claude-code') refreshClaude(); render(); }), { icon: 'cpu', color: 'var(--accent)' }),
    ], {
      'claude-code': 'Aplikacja uruchamia oficjalny program Claude Code zalogowany Twoim kontem (Pro/Max). Nie widzi hasła ani tokenów logowania.',
      claude: 'Klucz API z platform.claude.com, rozliczany za faktyczne zużycie (grosze za akt), niezależnie od planu Claude.',
      gemini: 'Darmowy poziom Google AI Studio (bez karty). Google może używać wysyłanych treści do ulepszania usług, dlatego do analizy trafiają wyłącznie publiczne akty prawne.',
      rules: 'Bez AI i bez kosztów: tylko dopasowanie słów kluczowych i terminy z metadanych, bez streszczeń.',
    }[p]),
    p === 'claude-code' ? h('div', { class: 'group' }, h('h3', { class: 'group-title' }, 'Konto Claude'), h('div', { class: 'group-body' }, accountCard())) : null,
    p === 'claude-code' ? group('Model', [
      row('Model Claude', select([{ value: 'sonnet', label: 'Sonnet (zalecany)' }, { value: 'opus', label: 'Opus (najmocniejszy)' }, { value: 'haiku', label: 'Haiku (najszybszy)' }], s.ai.model, (v) => saveSettings({ ai: { model: v } })), { icon: 'sparkles', color: 'var(--purple)' }),
      row('Program Claude Code', h('div', { class: 'btn-row' }, h('span', { class: 'path', style: { maxWidth: '260px' } }, state.claude.path || 'nie znaleziono'),
        h('button', { class: 'btn sm', onclick: async () => { const f = await P.claude.browse(); if (f) { await saveSettings({ ai: { claudePath: f } }, true); await refreshClaude(); } } }, 'Wskaż…')), { icon: 'folder', color: 'var(--orange)' }),
    ]) : null,
    p === 'claude' ? group('Klucz API Claude', [
      ...keyRow('anthropic', 'Klucz', 'sk-ant-…', 'https://platform.claude.com/settings/keys'),
      row('Model', select([{ value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (zalecany)' }, { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (najtańszy)' }], s.ai.apiModel, (v) => saveSettings({ ai: { apiModel: v } })), { icon: 'sparkles', color: 'var(--purple)' }),
    ], P.kind === 'desktop' ? 'Klucz jest szyfrowany przez system i nigdy nie trafia do okna aplikacji.' : 'Klucz jest zapisany tylko w pamięci tej aplikacji na telefonie.') : null,
    p === 'gemini' ? group('Klucz API Gemini', [
      ...keyRow('gemini', 'Klucz', 'AIza…', 'https://aistudio.google.com/apikey'),
      row('Model', textInput(s.ai.geminiModel, (v) => saveSettings({ ai: { geminiModel: v.trim() || 'gemini-3.5-flash' } }), { width: '220px' }), { icon: 'sparkles', color: 'var(--purple)' }),
    ], 'Nie włączaj płatności w Google Cloud: bez niej przekroczenie darmowego limitu kończy się błędem, a nie opłatą.') : null,
    p !== 'rules' && p !== 'claude-code' ? h('div', { class: 'group', style: { display: 'flex', alignItems: 'center', gap: '12px' } }, testBtn) : null);
}

function settingsScan() {
  const s = state.settings;
  const cfg = state.cfg;
  const hours = Array.from({ length: 17 }, (_, i) => i + 6).map((n) => ({ value: String(n), label: `${n}:00` }));
  return h('div', null,
    group('Automatyczny skan', [
      row('Skanuj codziennie sam', toggle(s.app.autoScan, (v) => saveSettings({ app: { autoScan: v } }, true)), { icon: 'refresh', color: 'var(--accent)',
        hint: P.kind === 'android' ? 'Na telefonie skan rusza po otwarciu aplikacji, jeśli tego dnia jeszcze go nie było.' : 'Raz dziennie, gdy aplikacja działa (także schowana w zasobniku).' }),
      row('Od godziny', select(hours, String(cfg.schedule.window.from), (v) => saveCfg({ schedule: { ...state.cfg.schedule, window: { ...state.cfg.schedule.window, from: Number(v) } } })), { icon: 'clock', color: 'var(--indigo)', hint: 'Jeśli o tej porze komputer był wyłączony, skan nadrobi się później tego samego dnia.' }),
      row('Powiadomienia o nowych zmianach', toggle(s.app.notifications, async (v) => { await saveSettings({ app: { notifications: v } }, true); if (v && P.requestNotifications) P.requestNotifications(); }), { icon: 'bell', color: 'var(--red)' }),
      P.kind === 'desktop' ? row('Działaj w tle po zamknięciu okna', toggle(s.app.runInBackground, (v) => saveSettings({ app: { runInBackground: v } }, true)), { icon: 'moon', color: 'var(--purple)', hint: 'Ikona w zasobniku systemowym, skąd zamkniesz aplikację całkowicie.' }) : null,
      P.kind === 'desktop' ? row('Uruchamiaj przy starcie systemu', toggle(s.app.autostart, async (v) => { try { await P.setAutostart(v); await saveSettings({ app: { autostart: v } }, true); } catch (e) { errToast(e); } }), { icon: 'bolt', color: 'var(--orange)' }) : null,
    ]),
    group('Zakres', [
      row('Pierwszy skan: dni wstecz', textInput(cfg.schedule.lookbackDays, (v) => saveCfg({ schedule: { ...state.cfg.schedule, lookbackDays: Math.max(1, Math.min(60, Number(v) || 7)) } }), { type: 'number', width: '90px', min: 1, max: 60 }), { icon: 'calendar', color: 'var(--teal)', hint: 'Każdy skan patrzy tyle dni wstecz; pozycje już widziane są pomijane.' }),
      row('Terminy w raporcie: dni naprzód', textInput(cfg.schedule.upcomingDays, (v) => saveCfg({ schedule: { ...state.cfg.schedule, upcomingDays: Math.max(1, Math.min(180, Number(v) || 30)) } }), { type: 'number', width: '90px', min: 1, max: 180 }), { icon: 'calendar', color: 'var(--green)' }),
      row('Próg trafności (słowa kluczowe)', textInput(cfg.filter.minScore, (v) => saveCfg({ filter: { ...state.cfg.filter, minScore: Math.max(1, Number(v) || 2) } }), { type: 'number', width: '90px', min: 1, max: 10 }), { icon: 'search', color: 'var(--orange)', hint: 'Niższy próg = więcej aktów trafia do analizy AI (dokładniej, ale drożej).' }),
    ]),
    group('Dane skanów', [
      row('Wyczyść historię', h('button', { class: 'btn danger sm', onclick: () => confirmReset() }, iconEl('trash', 13), 'Wyczyść'), { icon: 'trash', color: 'var(--red)', hint: 'Usuwa zmiany, raporty i listę widzianych aktów. Ustawienia placówki zostają.' }),
    ]));
}

function confirmReset() {
  sheet({
    title: 'Wyczyścić historię?',
    subtitle: 'Następny skan znów pobierze akty z ostatnich dni.',
    body: h('p', null, 'Usuniesz wszystkie zmiany (także ich stan i notatki), raporty i listę widzianych aktów. Zrób najpierw kopię danych, jeśli chcesz je zachować.'),
    actions: [{ label: 'Anuluj' }, { label: 'Wyczyść', kind: 'danger', onClick: async () => { await state.monitor.store.reset({ keepConfig: true }); await loadData(); render(); toast('Wyczyszczono historię', 'success'); } }],
  });
}

function listEditor({ items, onSave, fields, addLabel, emptyItem }) {
  const list = items.map((x) => ({ ...x }));
  const save = () => onSave(list.filter((x) => String(x.name || '').trim()));
  return h('div', null,
    group(null, list.map((it, i) => h('div', { class: 'row edit-row' },
      h('div', { class: 'edit-fields' }, fields.map((f) => f.type === 'toggle'
        ? h('label', { class: 'check' }, toggle(!!it[f.key], (v) => { it[f.key] = v; save(); }), h('span', null, f.label))
        : f.type === 'textarea'
          ? h('textarea', { class: 'input full', rows: 2, placeholder: f.label, value: it[f.key] || '', onchange: (e) => { it[f.key] = e.target.value; save(); } })
          : h('input', { class: 'input', style: { width: f.width || '260px' }, placeholder: f.label, value: it[f.key] || '', onchange: (e) => { it[f.key] = e.target.value.trim(); save(); } }))),
      h('button', { class: 'icon-btn', title: 'Usuń', onclick: async () => { list.splice(i, 1); await save(); render(); }, html: icon('trash', 15) })))),
    h('div', { class: 'group' }, h('button', { class: 'btn', onclick: async () => { list.push({ ...emptyItem }); await onSave(list); render(); } }, iconEl('plus', 14), addLabel)));
}

function settingsRoles() {
  return h('div', null,
    h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'AI przypisuje zadania wyłącznie do tych ról, używając dokładnie tych nazw. Zakres obowiązków pomaga trafnie dobrać osobę.'),
    listEditor({
      items: state.cfg.roles,
      fields: [{ key: 'name', label: 'Nazwa roli', width: '220px' }, { key: 'scope', label: 'Zakres obowiązków', type: 'textarea' }],
      addLabel: 'Dodaj rolę', emptyItem: { name: 'Nowa rola', scope: '' },
      onSave: (roles) => saveCfg({ roles: roles.filter((r) => r.name) }, true),
    }));
}

function settingsDocs() {
  return h('div', null,
    h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'Dokumenty szkoły, które AI może wskazać do aktualizacji. Zaznacz te, których zmiana wymaga uchwały rady pedagogicznej.'),
    listEditor({
      items: state.cfg.documents,
      fields: [{ key: 'name', label: 'Nazwa dokumentu', width: '320px' }, { key: 'needsCouncil', label: 'Wymaga uchwały rady', type: 'toggle' }],
      addLabel: 'Dodaj dokument', emptyItem: { name: 'Nowy dokument', needsCouncil: false },
      onSave: (docs) => saveCfg({ documents: docs.filter((d) => d.name) }, true),
    }));
}

function settingsRules() {
  const cfg = state.cfg;
  const saveRule = async (r, patch) => {
    const cur = (await state.monitor.store.getConfig()) || {};
    const list = (cur.rules || []).filter((x) => x.id !== r.id);
    await saveCfg({ rules: [...list, { ...r, ...patch }] }, true);
  };
  const kwGroups = Object.entries(cfg.keywords);
  const KW_LABEL = { education: 'Słowa oświatowe', supporting: 'Słowa wspierające', administrative: 'Słowa administracyjne', exclude: 'Wykluczenia' };
  return h('div', null,
    group('Reguły priorytetu', cfg.rules.map((r) => row(r.label,
      h('div', { class: 'btn-row' },
        r.num != null ? h('input', { class: 'input', type: 'number', style: { width: '76px' }, value: r.num, onchange: (e) => saveRule(r, { num: Number(e.target.value) || r.num }) }) : null,
        select([{ value: 'hi', label: 'Wysoki' }, { value: 'mid', label: 'Średni' }, { value: 'lo', label: 'Niski' }], r.prio, (v) => saveRule(r, { prio: v })),
        toggle(r.on !== false, (v) => saveRule(r, { on: v }))),
      { icon: 'flag', color: `var(--${PRIORITY_CHIP[r.prio] === 'teal' ? 'teal' : PRIORITY_CHIP[r.prio]})` })),
    'Gdy pasuje kilka reguł, wygrywa najwyższy priorytet.'),
    group('Słowa kluczowe', kwGroups.map(([k, words]) => row(KW_LABEL[k] || k,
      h('textarea', { class: 'input full', rows: 3, value: (words || []).join(', '), onchange: (e) => saveCfg({ keywords: { ...state.cfg.keywords, [k]: e.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) } }) }),
      { icon: 'search', color: 'var(--accent)', stack: true })), 'Wpisuj początki słów, np. „nauczyciel” pasuje też do „nauczycieli”. Oddzielaj przecinkami.'),
    group('Akty obserwowane', [
      ...cfg.watchedActs.map((w, i) => row(w.name, h('div', { class: 'btn-row' }, h('span', { class: 'mono muted' }, w.eli),
        h('button', { class: 'icon-btn', title: 'Usuń', html: icon('trash', 14), onclick: async () => { await saveCfg({ watchedActs: state.cfg.watchedActs.filter((_, j) => j !== i) }, true); render(); } })), { icon: 'book', color: 'var(--indigo)' })),
      row('Dodaj akt', (() => {
        const eli = h('input', { class: 'input', style: { width: '140px' }, placeholder: 'DU/2017/59' });
        const name = h('input', { class: 'input', style: { width: '200px' }, placeholder: 'Nazwa' });
        return h('div', { class: 'btn-row' }, eli, name, h('button', { class: 'btn sm', onclick: async () => {
          if (!/^(DU|MP)\/\d{4}\/\d+$/.test(eli.value.trim())) { toast('Podaj oznaczenie w formacie DU/rok/pozycja', 'error'); return; }
          await saveCfg({ watchedActs: [...state.cfg.watchedActs, { eli: eli.value.trim(), name: name.value.trim() || eli.value.trim() }] }, true); render();
        } }, iconEl('plus', 12), 'Dodaj'));
      })(), { icon: 'plus', color: 'var(--green)', stack: state.mobile }),
    ], 'Ustawa zmieniająca „niektóre inne ustawy” często nie ma w tytule nic o oświacie: silnik sprawdza też, czy akt zmienia któryś z tych aktów.'));
}

window.addEventListener('DOMContentLoaded', () => { init().catch((e) => { console.error(e); document.getElementById('content').textContent = 'Nie udało się uruchomić aplikacji: ' + e.message; }); });
