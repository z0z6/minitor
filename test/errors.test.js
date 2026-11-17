import test from 'node:test';
import assert from 'node:assert/strict';
import { runScan } from '../src/pipeline.js';
import { createMockAnalyzer } from '../src/analyze.js';
import { createRclSource } from '../src/sources/rcl.js';
import { fixtureHttp, NOW, loadCfg, memStore } from './helpers.js';

const failingAnalyzer = (message, { failFirst = Infinity } = {}) => {
  const mock = createMockAnalyzer();
  let n = 0;
  return { name: 'test', calls: () => n, async analyze(...a) { n++; if (n <= failFirst) throw new Error(message); return mock.analyze(...a); } };
};

test('błąd AI nie oznacza źródła jako zepsutego, a pozycje wracają przy następnym skanie', async () => {
  const cfg = await loadCfg();
  const store = memStore();
  const http = await fixtureHttp();
  const an = failingAnalyzer('Claude Code nie jest zalogowany (lub sesja wygasła).');
  const r = await runScan({ cfg, http, store, analyzer: an, now: NOW });
  assert.equal(an.calls(), 1, 'po błędzie stałym analiza zatrzymana od razu');
  assert.ok(r.ai.stopped);
  assert.ok(r.ai.pending > 0);
  assert.ok(r.health.find((h) => h.id === 'eli-du').ok, 'Dziennik Ustaw nadal „działa”');
  assert.match(r.report.text, /analiza AI/);
  assert.equal(r.changes.length, 0);

  // następny skan z działającym AI analizuje zaległe pozycje
  const next = await runScan({ cfg, http, store, analyzer: createMockAnalyzer(), now: new Date('2026-10-02T17:00:00Z') });
  assert.ok(next.changes.some((c) => c.key === 'DU/2026/1900'));
});

test('kilka błędów AI z rzędu (np. przekroczony czas) też wstrzymuje analizę', async () => {
  const an = failingAnalyzer('Model nie zwrócił wyniku (stop_reason: max_tokens)');
  const r = await runScan({ cfg: await loadCfg(), http: await fixtureHttp(), store: memStore(), analyzer: an, now: NOW });
  assert.equal(an.calls(), 3);
  assert.equal(r.ai.failed, 3);
});

test('pojedynczy błąd AI nie zatrzymuje kolejnych analiz', async () => {
  const an = failingAnalyzer('Model nie zwrócił wyniku', { failFirst: 1 });
  const r = await runScan({ cfg: await loadCfg(), http: await fixtureHttp(), store: memStore(), analyzer: an, now: NOW });
  assert.equal(r.ai.stopped, null);
  assert.equal(r.ai.failed, 1);
  assert.ok(r.changes.length >= 3);
});

test('RCL: nieudane pojedyncze wyszukiwanie daje uwagę, a nie błąd źródła', async () => {
  const base = await fixtureHttp();
  let n = 0;
  const http = { ...base, text: async (u, o) => { if (u.includes('lista') && n++ === 0) throw Object.assign(new Error('serwer nie odpowiada'), { network: true }); return base.text(u, o); } };
  const src = createRclSource({ id: 'rcl', name: 'RCL', queries: ['Edukacji', 'oświat'] });
  const items = await src.listNew({ http, today: '2026-10-02', lookbackDays: 7 });
  assert.match(items.warning, /1 z 2/);
});

test('RCL: gdy żadne wyszukiwanie nie działa, komunikat mówi, że strona RCL nie odpowiada', async () => {
  const http = { text: async () => { throw Object.assign(new Error('serwer nie odpowiada [net::ERR_CONNECTION_TIMED_OUT]'), { network: true }); } };
  const src = createRclSource({ id: 'rcl', name: 'RCL', queries: ['a', 'b'] });
  await assert.rejects(src.listNew({ http, today: '2026-10-02', lookbackDays: 7 }), /strona RCL nie odpowiada/);
});
