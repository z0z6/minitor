import { localParts, addDays } from './util.js';
import { buildSources } from './sources/index.js';
import { scoreCandidate } from './filter.js';
import { decidePriority } from './priority.js';
import { renderReport } from './report.js';

/**
 * Jeden przebieg: pobierz nowe akty -> odfiltruj -> przeanalizuj -> nadaj priorytet -> zapisz -> zbuduj raport.
 * O tym, KIEDY skan rusza, decyduje aplikacja (Monitor.isDue). Raport powstaje z zapisanych zmian danego dnia,
 * więc ponowny skan tego samego dnia niczego nie gubi i nie dubluje.
 */
export async function runScan({ cfg, http, store, analyzer, now = new Date(), log = () => {} }) {
  const today = localParts(now, cfg.school.timezone).date;
  log(`Start skanu ${today}, analizator: ${analyzer.name}, magazyn: ${store.kind}`);

  const ctx = { http, now, today, lookbackDays: cfg.schedule.lookbackDays, cfg };
  const sources = buildSources(cfg);
  const toMark = [];
  let reviewed = 0;

  // Źródła pobieramy równolegle (to głównie czekanie na sieć); analiza AI idzie potem po kolei,
  // bo darmowe i abonamentowe limity modeli źle znoszą równoległe zapytania.
  const listed = await Promise.all(sources.map(async (src) => {
    try { return { items: await src.listNew(ctx) }; } catch (e) { return { error: e }; }
  }));

  const health = [];
  for (const [i, src] of sources.entries()) {
    const h = { id: src.id, name: src.name, ok: true, listed: 0, fresh: 0, analyzed: 0, failed: 0, error: null };
    health.push(h);
    const { items, error } = listed[i];
    if (error) {
      h.ok = false;
      h.error = error.message;
      log(`BŁĄD źródła ${src.name}: ${error.message}`);
      continue;
    }
    h.listed = items.length;

    // Źródła bez dat (np. BIP): pierwszy przebieg tylko zapamiętuje istniejące pozycje, żeby nie zalać raportu.
    if (src.baseline && !(await store.hasSeenFrom(src.id))) {
      toMark.push(...items.map((c) => ({ key: c.key, source_id: src.id, title: c.title, relevant: false })));
      h.baselined = items.length;
      log(`  ${src.name}: zainicjowano, zapamiętano ${items.length} istniejących pozycji`);
      continue;
    }

    const seen = await store.getSeen(items.map((c) => c.key));
    const fresh = items.filter((c) => !seen.has(c.key));
    h.fresh = fresh.length;
    reviewed += fresh.length;

    for (const light of fresh) {
      try {
        const c = await src.enrich(light, ctx);
        const sc = scoreCandidate(c, cfg);
        if (sc.score < cfg.filter.minScore) {
          toMark.push({ key: c.key, source_id: src.id, title: c.title, relevant: false });
          continue;
        }
        const text = await src.loadText(c, ctx).catch((e) => ({ kind: 'none', note: e.message }));
        const a = await analyzer.analyze(c, text, sc, cfg, today);
        h.analyzed++;

        if (!a.relevant || a.affects_school === 'no') {
          toMark.push({ key: c.key, source_id: src.id, title: c.title, relevant: false });
          log(`  bez wpływu: ${c.title.slice(0, 80)}`);
          continue;
        }

        const merged = { ...a, effective_date: c.effectiveDate ?? a.effective_date, category: sc.category ?? 'oswiatowe' };
        const prio = decidePriority(merged, cfg.rules, today);
        await store.saveChange({
          key: c.key,
          source_id: src.id,
          source_name: src.name,
          title: c.title,
          url: c.url,
          published_at: c.publishedAt ?? null,
          effective_date: merged.effective_date,
          category: merged.category,
          priority: prio.priority,
          priority_reasons: prio.reasons,
          summary: a.summary,
          what_changes: a.what_changes,
          status: a.status,
          affects_school: a.affects_school,
          requires_statute_change: a.requires_statute_change,
          requires_council_resolution: a.requires_council_resolution,
          documents: a.documents,
          tasks: a.roles,
          legal_basis: a.legal_basis,
          confidence: a.confidence,
          review_note: a.review_note,
          act_excerpt: a.act_excerpt || null,
          run_date: today,
        });
        toMark.push({ key: c.key, source_id: src.id, title: c.title, relevant: true });
        log(`  [${prio.priority}] ${c.title.slice(0, 80)}`);
      } catch (e) {
        // Jedna nieudana pozycja nie przerywa reszty. Nie oznaczamy jej jako widzianej, więc wróci przy następnym skanie.
        h.failed++;
        h.error = `${h.failed} pozycji nie udało się przetworzyć (ostatni błąd: ${e.message})`;
        h.ok = false;
        log(`  BŁĄD pozycji ${light.key}: ${e.message}`);
      }
    }
  }

  await store.markSeen(toMark);

  const changes = await store.listByRunDate(today);
  const upcoming = (await store.listUpcoming(today, addDays(today, cfg.schedule.upcomingDays)))
    .filter((c) => c.run_date !== today);
  const report = renderReport({ cfg, today, changes, upcoming, health, stats: { reviewed, sources: sources.length } });

  const summary = { reviewed, changes: changes.length, health };
  await store.recordRun(today, summary);
  return { report, changes, health, summary };
}
