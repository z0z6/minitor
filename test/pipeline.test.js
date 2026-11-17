import test from 'node:test';
import assert from 'node:assert/strict';
import { runScan } from '../src/pipeline.js';
import { createMockAnalyzer, normalizeAnalysis } from '../src/analyze.js';
import { renderReport, pluralZmiana } from '../src/report.js';
import { fixtureHttp, NOW, loadCfg, memStore } from './helpers.js';

async function setup() {
  return { cfg: await loadCfg(), http: await fixtureHttp(), store: memStore(), analyzer: createMockAnalyzer() };
}

test('potok: wykrywa zmiany, nadaje priorytety, buduje jeden raport', async () => {
  const s = await setup();
  const r = await runScan({ ...s, now: NOW });
  const byKey = Object.fromEntries(r.changes.map((c) => [c.key, c]));
  assert.ok(byKey['DU/2026/1900'], 'rozporządzenie MEN');
  assert.equal(byKey['DU/2026/1900'].priority, 'hi');
  assert.ok(byKey['DU/2026/1905'], 'ustawa zmieniająca Prawo oświatowe');
  assert.ok(byKey['DU/2026/1950'], 'dostępność cyfrowa');
  assert.equal(byKey['DU/2026/1950'].category, 'administracyjne');
  assert.ok(!byKey['DU/2026/1901'], 'znaki drogowe odfiltrowane');
  assert.ok(Object.keys(byKey).some((k) => k.startsWith('rss:men-komunikaty')), 'projekt z MEN');
  assert.match(r.report.subject, /Monitor prawa/);
  assert.ok(await s.store.hasRun('2026-10-02'));
});

test('potok: awaria jednego źródła nie zatrzymuje reszty i trafia do raportu', async () => {
  const s = await setup();
  const r = await runScan({ ...s, now: NOW });
  const bad = r.health.find((h) => h.id === 'men-wiadomosci');
  assert.equal(bad.ok, false);
  assert.ok(r.health.find((h) => h.id === 'eli-du').ok);
  assert.match(r.report.text, /źródła z błędem/);
});

test('potok: drugi przebieg tego samego dnia nie dubluje zmian, a raport nadal obejmuje cały dzień', async () => {
  const s = await setup();
  const first = await runScan({ ...s, now: NOW });
  const again = await runScan({ ...s, now: new Date('2026-10-02T16:40:00Z') });
  assert.equal(again.summary.reviewed, 0);
  assert.equal(again.changes.length, first.changes.length);
});

test('potok: następnego dnia te same akty nie są zgłaszane ponownie, ale terminy wracają jako przypomnienie', async () => {
  const s = await setup();
  await runScan({ ...s, now: NOW });
  const next = await runScan({ ...s, now: new Date('2026-10-03T15:40:00Z') });
  assert.equal(next.changes.length, 0);
  assert.match(next.report.subject, /bez zmian/);
  assert.match(next.report.text, /Zbliżające się terminy/);
});

test('analiza: odpowiedź modelu jest czyszczona (role i dokumenty spoza listy, zła data)', async () => {
  const cfg = await loadCfg();
  const a = normalizeAnalysis({
    relevant: true, summary: 's', what_changes: 'w', affects_school: 'yes', status: 'obowiazuje',
    effective_date: 'jutro', requires_statute_change: true, requires_council_resolution: true,
    documents_to_update: ['Statut SOSW', 'Wymyślony dokument'],
    roles: [{ role: 'Dyrektor', action: 'Zrób X', deadline: '2026-12-01' }, { role: 'Hobbit', action: 'Y' }],
    legal_basis: 'b', confidence: 'wysoka',
  }, cfg);
  assert.deepEqual(a.documents, ['Statut SOSW']);
  assert.equal(a.roles.length, 1);
  assert.equal(a.effective_date, null);
  assert.equal(a.confidence, 'low');
  assert.match(a.review_note, /spoza listy/);
});

test('raport: treści z internetu są escapowane w HTML', async () => {
  const cfg = await loadCfg();
  const { html } = renderReport({
    cfg, today: '2026-10-02',
    changes: [{ key: 'k', title: '<script>alert(1)</script>', source_name: 'S', priority: 'hi', status: 'obowiazuje', summary: '<img src=x onerror=1>', tasks: [], documents: [], priority_reasons: [] }],
  });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<img src=x'));
});

test('odmiana: 1 zmiana, 2 zmiany, 5 zmian, 12 zmian, 22 zmiany', () => {
  assert.deepEqual([1, 2, 5, 12, 22, 25].map(pluralZmiana), ['zmiana', 'zmiany', 'zmian', 'zmian', 'zmiany', 'zmian']);
});

test('raport: adres inny niż http(s) nie trafia do linku', async () => {
  const cfg = await loadCfg();
  const { html, text } = renderReport({
    cfg, today: '2026-10-02',
    changes: [{ key: 'k', title: 'Akt', url: 'javascript:alert(1)', source_name: 'S', priority: 'hi', status: 'obowiazuje', summary: 's', tasks: [], documents: [], priority_reasons: [] }],
  });
  assert.ok(!html.includes('javascript:'));
  assert.ok(!text.includes('javascript:'));
});

test('potok: źródła są pobierane równolegle', async () => {
  const s = await setup();
  let active = 0;
  let peak = 0;
  const base = s.http;
  const slow = (fn) => async (...a) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); try { return await fn(...a); } finally { active--; } };
  s.http = { ...base, json: slow(base.json), text: slow(base.text) };
  await runScan({ ...s, now: NOW });
  assert.ok(peak > 1, `oczekiwano równoległych zapytań, było ${peak}`);
});
