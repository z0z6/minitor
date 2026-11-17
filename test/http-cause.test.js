import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttp, describeNetError } from '../src/http.js';

const netError = (code, msg = code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(msg), { code }) });

test('createHttp: „fetch failed” dostaje zrozumiały opis i prawdziwą przyczynę z e.cause', async () => {
  const http = createHttp({ fetchImpl: async () => { throw netError('ECONNRESET', 'read ECONNRESET'); }, retries: 0 });
  await assert.rejects(() => http.text('https://example.test/x'), /zerwane.*fetch failed \(ECONNRESET: read ECONNRESET\).* dla https:\/\/example\.test\/x/);
});

test('błąd sieci jest ponawiany najwyżej raz, a nieosiągalny serwer jest pomijany do końca skanu', async () => {
  let calls = 0;
  const http = createHttp({ fetchImpl: async () => { calls++; throw new Error('net::ERR_CONNECTION_TIMED_OUT'); }, retries: 3, backoffMs: 1 });
  await assert.rejects(() => http.text('https://rcl.test/a'), /serwer nie odpowiada/);
  assert.equal(calls, 2);
  await assert.rejects(() => http.text('https://rcl.test/b'), /serwer nie odpowiada/);
  assert.equal(calls, 2, 'drugie zapytanie do tego samego serwera kończy się od razu');
  http.resetHosts();
  await assert.rejects(() => http.text('https://rcl.test/c'));
  assert.equal(calls, 4);
});

test('przekroczony czas pobierania nie blokuje całego serwera (to może być jeden duży plik)', async () => {
  let calls = 0;
  const http = createHttp({ fetchImpl: async () => { calls++; throw new Error('przekroczono limit czasu 45000 ms'); }, retries: 3, backoffMs: 1 });
  await assert.rejects(() => http.buffer('https://api.test/duzy.pdf'), /zbyt wolno/);
  await assert.rejects(() => http.text('https://api.test/lista'));
  assert.equal(calls, 4);
});

test('429 respektuje Retry-After, a po sukcesie odpowiedź wraca normalnie', async () => {
  const seen = [];
  let n = 0;
  const fetchImpl = async () => {
    seen.push(Date.now());
    return ++n === 1
      ? { ok: false, status: 429, headers: { 'retry-after': '0.05' }, text: async () => '' }
      : { ok: true, status: 200, headers: {}, text: async () => 'ok' };
  };
  const http = createHttp({ fetchImpl, retries: 2, backoffMs: 5000 });
  assert.equal(await http.text('https://x.test/'), 'ok');
  assert.ok(seen[1] - seen[0] < 1000, 'czekał według Retry-After, nie według domyślnej przerwy');
});

test('opisy błędów sieci: Chromium i Node', () => {
  assert.equal(describeNetError('net::ERR_NAME_NOT_RESOLVED').down, true);
  assert.match(describeNetError('getaddrinfo ENOTFOUND x').label, /DNS/);
  assert.match(describeNetError('net::ERR_CERT_DATE_INVALID').label, /certyfikat/);
  assert.equal(describeNetError('net::ERR_CONNECTION_RESET').down, false);
  assert.equal(describeNetError('coś innego').label, null);
});
