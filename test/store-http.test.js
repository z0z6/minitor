import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createHttp, bytesToBase64, base64ToBytes, makeResponse } from '../src/http.js';

test('magazyn: seria zmian w jednym kroku daje jeden zapis na dysk', async () => {
  const writes = [];
  const store = createStore({ save: async (json) => { writes.push(json); } });
  await Promise.all([1, 2, 3, 4, 5].map((i) => store.saveChange({ key: `k${i}`, title: `T${i}`, run_date: '2026-10-02' })));
  await store.markSeen([{ key: 'k1', source_id: 's' }]);
  await store.flush();
  assert.ok(writes.length <= 2, `za dużo zapisów: ${writes.length}`);
  const last = JSON.parse(writes.at(-1));
  assert.equal(Object.keys(last.changes).length, 5);
  assert.ok(await store.hasSeenFrom('s'));
  assert.ok(!(await store.hasSeenFrom('inne')));
});

test('magazyn: eksport czeka na zaległy zapis i zawiera komplet danych', async () => {
  const store = createStore({ save: () => new Promise((r) => setTimeout(r, 10)) });
  await store.saveChange({ key: 'a', title: 'A', run_date: '2026-10-02' });
  const json = JSON.parse(await store.exportAll());
  assert.ok(json.changes.a);
});

test('base64: zgodność z Node dla różnych długości', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 255, 1000, 70000]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    const b64 = bytesToBase64(bytes);
    assert.equal(b64, Buffer.from(bytes).toString('base64'));
    assert.deepEqual(Buffer.from(base64ToBytes(b64)), Buffer.from(bytes));
  }
});

test('http: odpowiedź binarna z platformy (bajty) bez kodowania base64', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const http = createHttp({ fetchImpl: async () => makeResponse({ status: 200, bytes }), retries: 0 });
  const buf = await http.buffer('https://x.test/a.pdf');
  assert.equal(buf.toString('base64'), 'JVBERg==');
});

test('http: zbyt duży plik nie jest ponawiany', async () => {
  let calls = 0;
  const http = createHttp({ fetchImpl: async () => { calls++; throw Object.assign(new Error('plik zbyt duży'), { tooLarge: true }); }, retries: 3, backoffMs: 1 });
  await assert.rejects(http.buffer('https://x.test/a.pdf'), /zbyt duży/);
  assert.equal(calls, 1);
});
