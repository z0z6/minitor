// Lokalny magazyn danych (jeden dokument JSON): potok skanu, interfejs aplikacji, CLI i testy.
// Trwałość zapewnia platforma przez load() / save(json): Electron (plik w folderze danych), Android (pamięć aplikacji),
// Node (src/node.js, fileBackend). Zapisy są łączone: seria zmian w krótkim czasie daje jeden zapis na dysk.

const EMPTY = () => ({ version: 1, seen: {}, changes: {}, runs: {}, reports: {}, config: null, log: [] });
const SEEN_KEEP_DAYS = 400;
const REPORTS_KEEP = 60;
const LOG_KEEP = 300;
const HIDDEN = new Set(['done', 'dismissed']);

export function createStore({ load = async () => null, save = async () => {} } = {}) {
  let state = null;
  let loading = null;
  let seenSources = null; // Set identyfikatorów źródeł, które mają już zapamiętane pozycje (dla hasSeenFrom)
  let dirty = false;
  let saving = null;

  // Jedno wczytanie naraz: równoległe wywołania na starcie dostają ten sam stan.
  const get = async () => {
    if (state) return state;
    loading ??= Promise.resolve().then(load).catch(() => null).then((raw) => {
      state ??= { ...EMPTY(), ...(raw && typeof raw === 'object' ? raw : {}) };
      seenSources = null;
      loading = null;
      return state;
    });
    return loading;
  };

  // Jedna pętla zapisu naraz; kolejne zmiany w trakcie zapisu trafiają do jednego, następnego zapisu.
  const persist = () => {
    dirty = true;
    if (!saving) {
      saving = (async () => {
        await Promise.resolve(); // zbiera zmiany z bieżącego kroku
        while (dirty) {
          dirty = false;
          try { await save(JSON.stringify(state)); } catch (e) { console.error('Zapis danych nie powiódł się:', e); }
        }
        saving = null;
      })();
    }
    return saving;
  };
  const flush = () => saving ?? Promise.resolve();

  const sourcesWithSeen = () => {
    if (!seenSources) seenSources = new Set(Object.values(state.seen).map((r) => r.source_id));
    return seenSources;
  };

  return {
    kind: 'lokalny',
    get: () => get(),
    flush,

    /* interfejs potoku (src/pipeline.js) */
    async hasRun(date) { return (await get()).runs[date]?.status === 'ok'; },
    async recordRun(date, summary) {
      const s = await get();
      s.runs[date] = { status: 'ok', summary, at: new Date().toISOString() };
      const cut = new Date(Date.now() - SEEN_KEEP_DAYS * 86400000).toISOString();
      let pruned = false;
      for (const [k, v] of Object.entries(s.seen)) if (v.seen_at && v.seen_at < cut) { delete s.seen[k]; pruned = true; }
      if (pruned) seenSources = null;
      await persist();
    },
    async getSeen(keys) { const s = await get(); return new Set(keys.filter((k) => s.seen[k])); },
    async hasSeenFrom(sourceId) { await get(); return sourcesWithSeen().has(sourceId); },
    async markSeen(rows) {
      const s = await get();
      const at = new Date().toISOString();
      const src = sourcesWithSeen();
      rows.forEach((r) => { s.seen[r.key] = { ...r, seen_at: at }; src.add(r.source_id); });
      await persist();
    },
    async saveChange(c) {
      const s = await get();
      const prev = s.changes[c.key];
      // Stan obsługi (workflow, notatka) należy do użytkownika: ponowna analiza go nie nadpisuje.
      const { workflow, note, handled_at, ...fromEngine } = c;
      s.changes[c.key] = {
        workflow: prev?.workflow ?? workflow ?? 'new', note: prev?.note ?? note ?? '', handled_at: prev?.handled_at ?? handled_at ?? null,
        ...(prev ?? {}), ...fromEngine, created_at: prev?.created_at ?? new Date().toISOString(),
      };
      persist(); // bez czekania: skan nie stoi na zapisie, a recordRun() i tak czeka na komplet
    },
    async getChange(key) { return (await get()).changes[key] ?? null; },
    async listByRunDate(date) { return Object.values((await get()).changes).filter((c) => c.run_date === date); },
    async listUpcoming(from, to) {
      return Object.values((await get()).changes)
        .filter((c) => c.workflow !== 'dismissed' && c.effective_date && c.effective_date >= from && c.effective_date <= to)
        .sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    },
    async listOpenChanges() { return Object.values((await get()).changes).filter((c) => !HIDDEN.has(c.workflow)); },
    async getConfig() { return (await get()).config ?? null; },

    /* interfejs aplikacji */
    async listChanges() {
      return Object.values((await get()).changes).sort((a, b) =>
        (b.run_date || '').localeCompare(a.run_date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
    },
    async updateChange(key, patch) {
      const s = await get();
      if (!s.changes[key]) throw new Error('Nie znaleziono zmiany');
      const done = HIDDEN.has(patch.workflow);
      s.changes[key] = { ...s.changes[key], ...patch, ...(patch.workflow ? { handled_at: done ? new Date().toISOString() : null } : {}) };
      await persist();
      return s.changes[key];
    },
    async deleteChange(key) { const s = await get(); delete s.changes[key]; await persist(); },
    async listRuns() {
      return Object.entries((await get()).runs).map(([date, r]) => ({ date, ...r })).sort((a, b) => b.date.localeCompare(a.date));
    },
    async lastRun() { return (await this.listRuns())[0] ?? null; },
    async setConfig(cfg) { const s = await get(); s.config = cfg; await persist(); },
    async saveReport(date, report) {
      const s = await get();
      s.reports[date] = { subject: report.subject, html: report.html, at: new Date().toISOString() };
      const keys = Object.keys(s.reports).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - REPORTS_KEEP))) delete s.reports[k];
      await persist();
    },
    async getReport(date) { return (await get()).reports[date] ?? null; },
    async log(entry) {
      const s = await get();
      s.log = [...(s.log ?? []), { at: new Date().toISOString(), ...entry }].slice(-LOG_KEEP);
      await persist();
    },
    async exportAll() { await flush(); return JSON.stringify(await get(), null, 2); },
    async importAll(json) {
      const raw = typeof json === 'string' ? JSON.parse(json) : json;
      if (!raw || typeof raw !== 'object' || !raw.changes || !raw.seen) throw new Error('To nie jest kopia danych Monitora prawa');
      state = { ...EMPTY(), ...raw };
      seenSources = null;
      await persist();
    },
    async reset({ keepConfig = true } = {}) {
      const cfg = keepConfig ? (await get()).config : null;
      state = { ...EMPTY(), config: cfg };
      seenSources = null;
      await persist();
    },
  };
}
