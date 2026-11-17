'use strict';
// Testy logiki aplikacji bez Electrona i bez internetu: npm test (w folderze app)
// Silnik (www/engine.js) jest ładowany tak jak w przeglądarce, a zapytania HTTP obsługują dane testowe z ../test/fixtures.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const fixtures = path.join(root, '..', 'test', 'fixtures');
const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, 'manifest.json'), 'utf8'));

function loadEngine() {
  const ctx = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Intl, Date, URL, URLSearchParams, structuredClone };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'www', 'engine.js'), 'utf8'), ctx, { filename: 'engine.js' });
  return ctx.Engine;
}

function fixturePlatform(Engine, { settings = { ai: { provider: 'rules' } } } = {}) {
  let saved = null;
  const requests = [];
  return {
    saved: () => saved,
    requests,
    settings,
    platform: {
      async fetch(url, o = {}) {
        requests.push(url);
        const e = manifest[url];
        if (!e) return { status: 404, headers: {}, text: 'brak danych testowych' };
        if (e.error) throw new Error(e.error);
        const buf = fs.readFileSync(path.join(fixtures, e.file));
        return o.binary ? { status: 200, headers: {}, base64: buf.toString('base64') } : { status: 200, headers: {}, text: buf.toString('utf8') };
      },
      async loadState() { return saved ? JSON.parse(saved) : null; },
      async saveState(json) { saved = json; },
      async secret() { return null; },
      notify() {},
    },
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('base64: kodowanie i dekodowanie bajtów', () => {
  const E = loadEngine();
  for (const n of [0, 1, 2, 3, 4, 5, 255, 1000]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    const b64 = E.bytesToBase64(bytes);
    assert.strictEqual(b64, Buffer.from(bytes).toString('base64'), `dł. ${n}`);
    assert.deepStrictEqual(Array.from(E.base64ToBytes(b64)), Array.from(bytes));
  }
});

test('skan na danych testowych (bez AI) zapisuje zmiany, raport i historię', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  const sum = await m.scan({ reason: 'test', now: '2026-10-02T15:40:00Z' });
  assert.strictEqual(sum.date, '2026-10-02');
  assert.ok(sum.fresh.length > 0, 'powinny być nowe zmiany');
  assert.ok(sum.health.length >= 5, 'raport o źródłach');
  const changes = await m.store.listChanges();
  assert.ok(changes.every((c) => c.workflow === 'new'));
  assert.ok(changes.every((c) => ['hi', 'mid', 'lo'].includes(c.priority)));
  assert.ok(await m.store.getReport('2026-10-02'), 'raport zapisany');
  assert.strictEqual((await m.store.listRuns()).length, 1);
  assert.ok(fx.saved(), 'stan zapisany przez platformę');
  // drugi skan tego samego dnia nie dubluje zmian
  const again = await m.scan({ reason: 'test', now: '2026-10-02T16:10:00Z' });
  assert.strictEqual(again.fresh.length, 0);
});

test('stan zmiany (workflow) przetrwa ponowny zapis zmiany przez silnik', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  await m.scan({ now: '2026-10-02T15:40:00Z' });
  const [c] = await m.store.listChanges();
  await m.store.updateChange(c.key, { workflow: 'done', note: 'zrobione' });
  await m.store.saveChange({ ...c, summary: 'nowe' });
  const after = await m.store.getChange(c.key);
  assert.strictEqual(after.workflow, 'done');
  assert.strictEqual(after.note, 'zrobione');
  assert.ok(after.handled_at);
});

test('isDue: przed oknem nie, po oknie tak, po skanie nie', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  assert.strictEqual(await m.isDue(new Date('2026-10-02T12:00:00Z')), false); // 14:00 w Warszawie
  assert.strictEqual(await m.isDue(new Date('2026-10-02T19:30:00Z')), true); // 21:30, nadrabia po oknie
  await m.scan({ now: '2026-10-02T15:40:00Z' });
  assert.strictEqual(await m.isDue(new Date('2026-10-02T19:30:00Z')), false);
});

test('ustawienia z aplikacji nadpisują domyślne (wyłączone źródło)', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  const base = await m.config();
  await m.store.setConfig({ sources: [{ ...base.sources.find((s) => s.id === 'rcl'), enabled: false }] });
  const cfg = await m.config();
  assert.strictEqual(cfg.sources.find((s) => s.id === 'rcl').enabled, false);
  assert.strictEqual(cfg.sources.length, base.sources.length);
});

test('analizator Claude Code: PDF trafia jako plik, wynik jest normalizowany', async () => {
  const E = loadEngine();
  let call = null;
  const an = E.createClaudeCodeAnalyzer({ run: async (o) => { call = o; return { text: '```json\n{"relevant":true,"relevance_reason":"x","summary":"Streszczenie","what_changes":"y","affects_school":"yes","status":"obowiazuje","requires_statute_change":true,"requires_council_resolution":false,"documents_to_update":["Statut SOSW","Nieznany"],"roles":[{"role":"Dyrektor","action":"Zrobić"},{"role":"Obcy","action":"z"}],"legal_basis":"a","confidence":"high"}\n```' }; } });
  const cfg = E.defaultConfig;
  const a = await an.analyze({ title: 'Akt', sourceName: 'DU' }, { kind: 'pdf', base64: 'JVBERi0=' }, { score: 3, reasons: [] }, cfg, '2026-10-02');
  assert.strictEqual(call.files.length, 1);
  assert.strictEqual(call.files[0].data, 'JVBERi0=');
  assert.match(call.prompt, /PDF/);
  assert.strictEqual(JSON.stringify(a.documents), '["Statut SOSW"]');
  assert.strictEqual(JSON.stringify(a.roles.map((r) => r.role)), '["Dyrektor"]');
});

test('import i eksport kopii danych', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  await m.scan({ now: '2026-10-02T15:40:00Z' });
  const json = await m.store.exportAll();
  const fx2 = fixturePlatform(E);
  const m2 = E.createMonitor({ platform: fx2.platform, getSettings: () => fx2.settings });
  await m2.store.importAll(json);
  assert.strictEqual((await m2.store.listChanges()).length, (await m.store.listChanges()).length);
  await assert.rejects(() => m2.store.importAll('{"a":1}'));
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  BŁĄD ${t.name}\n       ${e.stack}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} testów zaliczonych`);
  process.exit(failed ? 1 : 0);
})();
