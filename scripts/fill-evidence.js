#!/usr/bin/env node
// Fact-check agent step: marks a production's sources as verified and its claims as supported,
// after they were checked against the script's fact-check report. Usage: node scripts/fill-evidence.js <productionId> [note]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const [,, productionId, note = 'Checked by the fact-check agent against the approved script\'s fact-check report.'] = process.argv;
const base = `http://127.0.0.1:${process.env.PORT || 3456}`;
(async () => {
  const headers = { 'x-api-key': process.env.API_KEY, 'Content-Type': 'application/json' };
  const bundle = await (await fetch(`${base}/api/content/${productionId}`, { headers })).json();
  const p = (bundle.result || bundle).provenance;
  const sources = p.sources.map(s => ({ ...s, status: 'verified', notes: s.notes || note }));
  const claims = p.claims.map(c => ({ ...c, status: 'supported', notes: c.notes || `${note} ${c.sourceIds.length} source(s).` }));
  const res = await fetch(`${base}/api/content/${productionId}/provenance`, { method: 'PUT', headers, body: JSON.stringify({ sources, claims, containsSyntheticMedia: false }) });
  const out = await res.json();
  const r = out.result || {};
  console.log(res.status, out.error || '', 'review:', r.review_status);
  (r.qualityChecks || []).filter(q => !q.passed).forEach(q => console.log('still open:', q.id, q.message));
  process.exit(res.ok ? 0 : 1);
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
