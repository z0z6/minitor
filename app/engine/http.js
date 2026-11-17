// Klient HTTP silnika w aplikacji (przeglądarka / WebView). Ta sama logika ponawiania co src/http.js,
// ale bez modułów Node: zapytanie wykonuje funkcja `fetchImpl` dostarczona przez platformę
// (Electron: proces główny przez net.fetch, Android: natywny CapacitorHttp), więc nie ma blokad CORS.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes) {
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

export function base64ToBytes(b64) {
  const s = String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
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

export function createAppHttp({ fetchImpl, retries = 3, timeoutMs = 45000, userAgent = 'monitor-prawa-app/1.0 (monitoring prawa oswiatowego)' }) {
  async function request(url, { method = 'GET', headers = {}, body, binary = false } = {}) {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetchImpl(url, { method, body, binary, timeoutMs, headers: { 'User-Agent': userAgent, ...headers } });
        if (res.status === 429 || res.status >= 500) {
          last = Object.assign(new Error(`HTTP ${res.status} dla ${url}`), { status: res.status });
          await sleep(1000 * 2 ** i);
          continue;
        }
        if (!res.ok) {
          let detail = '';
          try { detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 300); } catch { /* brak treści */ }
          throw Object.assign(new Error(`HTTP ${res.status} dla ${url}${detail ? `: ${detail}` : ''}`), { status: res.status, fatal: true });
        }
        return res;
      } catch (e) {
        if (e.fatal) throw e;
        if (!/dla https?:/.test(e.message)) e.message = `${e.message} dla ${url}`;
        last = e;
        await sleep(1000 * 2 ** i);
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

/**
 * Buduje obiekt podobny do Response z surowej odpowiedzi platformy:
 * { status, headers, text } albo { status, headers, base64 } dla danych binarnych.
 */
export function makeResponse({ status, headers = {}, text, base64 }) {
  const bytes = () => (base64 != null ? base64ToBytes(base64) : new TextEncoder().encode(text ?? ''));
  const asText = () => (text != null ? text : new TextDecoder().decode(bytes()));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => asText(),
    json: async () => JSON.parse(asText()),
    arrayBuffer: async () => { const b = bytes(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
  };
}
