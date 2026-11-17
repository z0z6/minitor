(async () => {
  const t0 = Date.now();
  const r = await state.monitor.checkSources();
  console.log('CHECK ' + (Date.now() - t0) + 'ms ' + JSON.stringify(r.map((x) => [x.id, x.ok, x.count, x.error, x.warn])));
  const t1 = Date.now();
  try {
    const s = await state.monitor.scan({ reason: 'diag' });
    console.log('SCAN ' + (Date.now() - t1) + 'ms ' + JSON.stringify({ ai: s.ai, health: s.health.map((h) => [h.id, h.ok, h.listed, h.analyzed, h.failed, h.error, h.warn]) }));
  } catch (e) { console.log('SCAN-ERR ' + e.message); }
})()
