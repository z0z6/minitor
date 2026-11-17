// Dodatki tylko dla Node (CLI i testy). Aplikacja (Electron, Android) ich nie ładuje.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHttp } from './http.js';

/** fetch z Node z limitem czasu i limitem rozmiaru odpowiedzi. */
export function nodeFetch(fetchFn = globalThis.fetch) {
  return async (url, { method, headers, body, timeoutMs = 90000, connectTimeoutMs = 20000, maxBytes } = {}) => {
    const ctl = new AbortController();
    let phase = 'connect';
    const connectTimer = setTimeout(() => ctl.abort(), connectTimeoutMs);
    const totalTimer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { method, headers, body, signal: ctl.signal });
      phase = 'body';
      clearTimeout(connectTimer);
      const len = Number(res.headers?.get?.('content-length') || 0);
      if (maxBytes && len > maxBytes) {
        ctl.abort();
        throw Object.assign(new Error(`plik zbyt duży (${Math.round(len / 1048576)} MB), analiza tylko na podstawie metadanych`), { tooLarge: true });
      }
      // Treść czytamy tutaj, żeby limit czasu objął też pobieranie (później timer jest już wyłączony).
      const buf = await res.arrayBuffer();
      return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(phase === 'connect' ? `brak odpowiedzi serwera w ciągu ${Math.round(connectTimeoutMs / 1000)} s` : `przekroczono limit czasu ${timeoutMs} ms`);
      }
      throw e;
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
    }
  };
}

export const createNodeHttp = (opts = {}) => createHttp({ fetchImpl: nodeFetch(opts.fetch), ...opts });

/**
 * Klient HTTP oparty na plikach: manifest mapuje URL na plik z danymi testowymi.
 * Służy do testów i do uruchomienia próbnego bez internetu.
 */
export function createFixtureHttp(manifest, dir) {
  const load = async (url) => {
    const entry = manifest[url];
    if (!entry) throw Object.assign(new Error(`Brak danych testowych dla ${url}`), { status: 404, fatal: true });
    if (entry.error) throw new Error(entry.error);
    return readFile(path.join(dir, entry.file));
  };
  return {
    json: async (u) => JSON.parse((await load(u)).toString('utf8')),
    text: async (u) => (await load(u)).toString('utf8'),
    buffer: async (u) => load(u),
    request: async () => { throw new Error('request() nie jest dostępne w trybie danych testowych'); },
  };
}

/** Trwałość magazynu (src/store.js) w pliku JSON, z zapisem atomowym. */
export function fileBackend(file) {
  return {
    load: async () => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } },
    save: async (json) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, json);
      await rename(`${file}.tmp`, file);
    },
  };
}
