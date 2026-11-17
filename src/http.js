// Klient HTTP silnika, niezależny od platformy. Zapytanie wykonuje `fetchImpl` dostarczony z zewnątrz:
//  - Electron: proces główny (net.fetch, bez blokad CORS, klucze API podstawiane dopiero tam),
//  - Android: natywny CapacitorHttp,
//  - Node (testy, CLI): src/node.js.
// fetchImpl(url, { method, headers, body, binary, timeoutMs, maxBytes }) zwraca obiekt podobny do Response.
import { sleep } from './util.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

/** Bajty → base64. Używa natywnej implementacji (Chromium 140+, Node 25+), gdy jest dostępna. */
export function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}

/** base64 → bajty (toleruje białe znaki i brak dopełnienia). */
export function base64ToBytes(b64) {
  const s = String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '');
  if (typeof Uint8Array.fromBase64 === 'function') {
    try { return Uint8Array.fromBase64(s, { lastChunkHandling: 'loose' }); } catch { /* niżej wersja ręczna */ }
  }
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  const at = (i) => (i < s.length ? B64_INDEX[s.charCodeAt(i)] & 63 : 0);
  for (let i = 0; i < s.length; i += 4) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6) | at(i + 3);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < s.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

/** Bajty z metodą toString('base64'), tak jak Buffer w Node (tego oczekują źródła w src/sources). */
export function asBuffer(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  b.toString = (enc) => (enc === 'base64' ? bytesToBase64(b) : new TextDecoder().decode(b));
  return b;
}

/**
 * Buduje obiekt podobny do Response z surowej odpowiedzi platformy:
 * { status, headers, text } albo { status, headers, bytes } (Uint8Array, Electron) albo { status, headers, base64 } (Android).
 */
export function makeResponse({ status, headers = {}, text, bytes, base64 }) {
  const raw = () => (bytes != null ? (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    : base64 != null ? base64ToBytes(base64) : new TextEncoder().encode(text ?? ''));
  const asText = () => (text != null ? text : new TextDecoder().decode(raw()));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => asText(),
    json: async () => JSON.parse(asText()),
    arrayBuffer: async () => { const b = raw(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
  };
}

/** Klient z ponawianiem prób (429, 5xx, błędy sieci), limitem czasu i czytelnymi komunikatami błędów. */
export function createHttp({ fetchImpl, retries = 3, timeoutMs = 45000, userAgent = 'monitor-prawa/1.0 (monitoring prawa oswiatowego)', backoffMs = 1000 }) {
  if (typeof fetchImpl !== 'function') throw new Error('createHttp: brak fetchImpl');
  async function request(url, { method = 'GET', headers = {}, body, binary = false, maxBytes } = {}) {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetchImpl(url, { method, body, binary, timeoutMs, maxBytes, headers: { 'User-Agent': userAgent, ...headers } });
        if (res.status === 429 || res.status >= 500) {
          last = Object.assign(new Error(`HTTP ${res.status} dla ${url}`), { status: res.status });
          if (i < retries) await sleep(backoffMs * 2 ** i);
          continue;
        }
        if (!res.ok) {
          // Treść odpowiedzi (np. komunikat API) mówi, co dokładnie poszło nie tak.
          let detail = '';
          try { detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 300); } catch { /* brak treści */ }
          throw Object.assign(new Error(`HTTP ${res.status} dla ${url}${detail ? `: ${detail}` : ''}`), { status: res.status, fatal: true });
        }
        return res;
      } catch (e) {
        if (e.fatal || e.tooLarge) throw e;
        // fetch() w Node zgłasza tylko „fetch failed”; prawdziwa przyczyna (ECONNRESET, certyfikat, DNS) siedzi w e.cause.
        const c = e.cause;
        if (c && (c.code || c.message) && !e.message.includes(' dla ')) e.message = `${e.message} (${[c.code, c.message].filter(Boolean).join(': ')})`;
        if (!/ dla https?:/.test(e.message)) e.message = `${e.message} dla ${url}`;
        last = e;
        if (i < retries) await sleep(backoffMs * 2 ** i);
      }
    }
    throw last;
  }
  return {
    request,
    json: async (u, o = {}) => (await request(u, { ...o, headers: { Accept: 'application/json', ...o.headers } })).json(),
    text: async (u, o = {}) => (await request(u, o)).text(),
    buffer: async (u, o = {}) => asBuffer(new Uint8Array(await (await request(u, { ...o, binary: true })).arrayBuffer())),
  };
}
