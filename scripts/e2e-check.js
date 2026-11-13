#!/usr/bin/env node
// End-to-end check: makes a ~30-second test video through the real pipeline (script import →
// thumbnail/SEO → narration with timed subtitles → documentary visuals → review) and reports
// every step in plain words. Never uploads. The test production is rejected afterwards.
//
// Usage: npm run e2e        (the app must be running: npm start)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { importScript } = require('./import-approved-script');
const { getMediaDuration } = require('../utils/ffmpeg');

const BASE = process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3456}`;
const KEY = process.env.API_KEY;
const results = [];
const report = (ok, step, detail = '') => {
  results.push({ ok, step });
  console.log(`${ok === true ? '✅' : ok === 'warn' ? '⚠️ ' : '❌'} ${step}${detail ? ` — ${detail}` : ''}`);
};
const api = async (route, options = {}) => {
  const response = await fetch(`${BASE}${route}`, {
    ...options,
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeout || 120000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body.result || body;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function preflight() {
  console.log('\nBefore the test');
  try {
    await api('/api/readiness');
    report(true, 'App is running');
  } catch (error) {
    report(false, 'App is running', `start it with "npm start" (${error.message})`);
    return false;
  }
  try {
    const readiness = await api('/api/readiness/run', { method: 'POST', body: '{}', timeout: 180000 });
    const checks = readiness.checks || readiness.items || [];
    const failing = checks.filter(check => check.status === 'failed' && check.blocking !== false);
    report(failing.length ? false : true, 'Readiness checks', failing.length ? failing.map(c => c.label || c.name || c.id).join(', ') : `${checks.length} passed`);
  } catch (error) {
    report('warn', 'Readiness checks', error.message);
  }
  const tokens = path.join(__dirname, '..', 'config', 'tokens.json');
  if (fs.existsSync(tokens)) {
    // Google "Testing" apps: the YouTube sign-in lasts 7 days from when it was made.
    const daysLeft = (fs.statSync(tokens).mtimeMs + 7 * 86400000 - Date.now()) / 86400000;
    report(daysLeft > 2 ? true : daysLeft > 0 ? 'warn' : false, 'YouTube sign-in',
      daysLeft > 0 ? `about ${Math.floor(daysLeft)} day(s) left${daysLeft <= 2 ? ' — run "node modern-auth.js" soon' : ''}` : 'expired — run "node modern-auth.js"');
  } else {
    report(false, 'YouTube sign-in', 'not signed in — run "node modern-auth.js"');
  }
  try {
    const freeGb = Number(execFileSync('df', ['-k', path.join(__dirname, '..')]).toString().trim().split('\n').pop().split(/\s+/)[3]) / 1048576;
    report(freeGb > 5 ? true : false, 'Free disk space', `${freeGb.toFixed(0)} GB`);
  } catch (_error) {
    report('warn', 'Free disk space', 'could not measure');
  }
  return true;
}

async function runTest() {
  console.log('\nTest video (about 30 seconds, not uploaded)');
  const markdown = fs.readFileSync(path.join(__dirname, 'e2e-sample.md'), 'utf8');
  const imported = await importScript(markdown, { sourceFile: 'e2e-sample.md' });
  report(true, 'Script imported', `${imported.words} words, ${imported.claims} claims, ${imported.sources} source`);
  await api(`/api/jobs/${imported.jobId}/resume`, { method: 'POST', body: '{}' });

  let job = null;
  let lastStage = null;
  const started = Date.now();
  const limit = Number(process.env.E2E_TIMEOUT_MS) || 40 * 60 * 1000;
  while (Date.now() - started < limit) {
    await sleep(10000);
    job = await api(`/api/jobs/${imported.jobId}`);
    if (job.stage !== lastStage) {
      console.log(`   … ${job.stage} (${Math.round((Date.now() - started) / 1000)}s)`);
      lastStage = job.stage;
    }
    if (['completed', 'failed', 'completed_with_issues', 'interrupted'].includes(job.status) && job.production_id) break;
    if (['failed', 'interrupted'].includes(job.status)) break;
  }
  if (!job?.production_id) {
    report(false, 'Production finished', job ? `${job.status} at ${job.stage}: ${job.error || 'no error message'}` : 'timed out');
    return null;
  }
  report(job.status === 'completed' ? true : 'warn', 'Production finished', `${job.status} in ${Math.round((Date.now() - started) / 60000)} min`);
  return job.production_id;
}

async function verify(productionId) {
  console.log('\nWhat was made');
  const bundle = await api(`/api/content/${productionId}`);
  const parse = value => (typeof value === 'string' ? JSON.parse(value) : value || {});
  const assets = parse(bundle.assets);
  const seo = parse(bundle.seo);
  const audio = assets.audio || {};
  const video = assets.finalVideo || {};
  const provider = video.provider || {};

  const narrated = audio.status === 'ready' && !audio.simulated && fs.existsSync(audio.path || '');
  report(narrated, 'Narration', narrated ? `${audio.model || audio.provider}, voice ${audio.voice || 'default'}, ${Number(audio.duration).toFixed(0)}s` : audio.error || 'missing');
  const cues = audio.timing?.cues?.length || 0;
  report(cues > 0, 'Subtitle timing', cues ? `${cues} lines timed from the voice` : 'no timed subtitles');

  let videoSeconds = 0;
  if (video.path && fs.existsSync(video.path)) videoSeconds = await getMediaDuration(video.path).catch(() => 0);
  const lengthOk = videoSeconds > 0 && Math.abs(videoSeconds - Number(audio.duration || 0)) < 1.5;
  report(lengthOk, 'Video file', videoSeconds ? `${videoSeconds.toFixed(1)}s, matches the narration${lengthOk ? '' : ' — NOT matching'}` : 'missing');
  report(provider.actualProvider === 'documentary', 'Documentary visuals',
    provider.visualCounts ? Object.entries(provider.visualCounts).map(([k, v]) => `${v} ${k}`).join(', ') : provider.actualProvider || 'not used');
  report(provider.subtitlesBurned === true, 'Subtitles in the picture');

  const captions = assets.captions?.path && fs.existsSync(assets.captions.path) ? fs.readFileSync(assets.captions.path, 'utf8') : '';
  report(Boolean(captions && assets.captions.timed), 'Caption file for YouTube', captions ? `${captions.split('-->').length - 1} captions${assets.captions.timed ? '' : ' (not timed from the voice)'}` : 'missing');

  const thumb = assets.thumbnail || {};
  const thumbOk = thumb.path && fs.existsSync(thumb.path) && !thumb.placeholder;
  report(thumbOk, 'Thumbnail', thumbOk ? `from a video frame: "${[thumb.text?.line1, thumb.text?.line2].filter(Boolean).join(' ')}"` : 'only a placeholder (it will not be uploaded)');

  const description = String(seo.description || '');
  report(description.includes('Sources') && description.includes('Credits & disclosure'), 'Description', 'sources, credits and AI-voice disclosure');
  report(bundle.containsSyntheticMedia !== true, 'Not marked as synthetic video');
  // "needs_attention" here only means the fact-check desk is not ticked yet (a human step).
  const quality = parse(bundle.qualityChecks || bundle.quality_checks);
  const open = (Array.isArray(quality) ? quality : []).filter(check => !check.passed);
  const onlyEvidence = open.every(check => check.id === 'provenance');
  report(onlyEvidence ? true : false, 'Waiting for your review',
    open.length ? (onlyEvidence ? 'only the fact-check desk is left (your step)' : open.map(check => check.message).join('; ')) : 'all automatic checks passed');

  // Clean up: the test is never published.
  await api(`/api/content/${productionId}/reject`, { method: 'POST', body: JSON.stringify({ notes: 'Automatic end-to-end test; never publish.' }) }).catch(() => {});
  for (const file of [video.path, audio.path, audio.timingPath].filter(Boolean)) fs.rmSync(file, { force: true });
}

(async () => {
  if (!KEY) {
    console.log('❌ API_KEY missing in .env');
    process.exit(1);
  }
  console.log('Curious Files — end-to-end check');
  const ok = await preflight();
  if (ok) {
    try {
      const productionId = await runTest();
      if (productionId) await verify(productionId);
    } catch (error) {
      report(false, 'Test run', error.message);
    }
  }
  const failed = results.filter(r => r.ok === false).length;
  const warned = results.filter(r => r.ok === 'warn').length;
  console.log(`\n${failed ? `❌ ${failed} problem(s)` : '✅ Everything works'}${warned ? `, ⚠️  ${warned} warning(s)` : ''}`);
  process.exit(failed ? 1 : 0);
})();
