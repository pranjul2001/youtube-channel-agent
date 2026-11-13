#!/usr/bin/env node
// Imports an owner-approved script (Markdown) as a generation job with completed strategy and
// script checkpoints, so `POST /api/jobs/:id/resume` produces it without AI rewriting a word.
//
// Usage: node scripts/import-approved-script.js <script.md> [--publish-time ISO] [--keywords "a, b"]
//
// Markdown format:
//   # Script N: Title
//   Series: <series>. ...
//   ## Script            -> sections marked **\[Section title\]**; [Hook] first, [Closing] last
//                          (the Closing's last paragraph is the call to action)
//   ## Fact-check report -> table | # | Claim | Status | Sources | Risk |  (Sources = keys)
//   ## Sources           -> lines "- [KEY] Title (Publisher): https://..."
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Database } = require('../database/db');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function parseScript(md) {
  const title = (md.match(/^# (?:Script \d+:\s*)?(.+)$/m) || [])[1]?.trim();
  if (!title) throw new Error('Missing "# Script N: Title" heading');
  const series = (md.match(/^Series:\s*([^.\n]+)/m) || [])[1]?.trim() || '';
  const body = md.split(/^## Script\s*$/m)[1]?.split(/^## /m)[0];
  if (!body) throw new Error('Missing "## Script" section');
  const blocks = body.split(/\*\*\\\[(.+?)\\\]\*\*/).slice(1);
  const parts = [];
  for (let i = 0; i < blocks.length; i += 2) {
    parts.push({ title: blocks[i].trim(), paragraphs: blocks[i + 1].trim().split(/\n\s*\n/).map(p => p.trim()).filter(Boolean) });
  }
  const hook = parts.find(p => p.title === 'Hook');
  const closing = parts.find(p => p.title === 'Closing');
  if (!hook || !closing) throw new Error('Script needs [Hook] and [Closing] sections');
  const sections = parts.filter(p => p !== hook && p !== closing);

  const sources = [];
  const sourceBlock = md.split(/^## Sources\s*$/m)[1] || '';
  for (const line of sourceBlock.split('\n')) {
    const m = line.match(/^-\s*\[([A-Za-z0-9]+)\]\s*(.+?):\s*(https?:\/\/\S+)\s*$/);
    if (!m) continue;
    const pub = m[2].match(/^(.*)\(([^()]+)\)\s*$/);
    sources.push({ key: m[1], url: m[3], title: (pub ? pub[1] : m[2]).trim(), publisher: pub ? pub[2].trim() : '', sourceType: /nasa|esa\.int|gov/.test(m[3]) ? 'official' : 'article' });
  }
  const byKey = new Map(sources.map(s => [s.key, s.url]));
  const claims = [];
  const report = md.split(/^## Fact-check report.*$/m)[1]?.split(/^## /m)[0] || '';
  for (const line of report.split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 6 || !/^\d+$/.test(cells[1])) continue;
    const urls = cells[4].split(/[,\s]+/).map(k => byKey.get(k)).filter(Boolean);
    if (!urls.length) throw new Error(`Claim ${cells[1]} has no known source keys: ${cells[4]}`);
    claims.push({ text: cells[2], sourceUrls: urls, riskLevel: /high/i.test(cells[5]) ? 'high' : 'standard' });
  }
  return { title, series, hook, closing, sections, sources, claims };
}

// Builds the strategy and script artifacts and saves them as a resumable job.
async function importScript(markdown, options = {}, db = null) {
  const parsed = parseScript(markdown);
  const { title, hook, closing, sections, sources, claims } = parsed;
  const cta = closing.paragraphs[closing.paragraphs.length - 1];
  const finalThought = closing.paragraphs.slice(0, -1).join(' ');
  const fullText = [hook.paragraphs.join('\n\n'), ...sections.flatMap(s => s.paragraphs), finalThought, cta].join('\n\n');
  const words = fullText.split(/\s+/).length;
  const seconds = Math.round((words / 150) * 60);
  const keywords = options.keywords || [];
  const script = {
    title,
    hook: { type: 'imported', text: hook.paragraphs.join('\n\n'), duration: '0:00-0:30' },
    introduction: null,
    mainContent: {
      sections: sections.map(s => ({ type: 'imported', title: s.title, content: s.paragraphs, duration: Math.round((s.paragraphs.join(' ').split(/\s+/).length / 150) * 60) })),
      totalDuration: seconds
    },
    conclusion: { recap: [], finalThought },
    callToAction: { type: 'call_to_action', subscribe: cta, like: '', comment: '', nextVideo: '', duration: '10 seconds' },
    duration: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    tone: 'calm, factual, respectful',
    pacing: 'slow, short sentences',
    keywords,
    claims,
    fullScript: fullText,
    metadata: { generatedAt: new Date().toISOString(), version: '1.0', generationSource: 'imported-approved-script', sourceFile: options.sourceFile || null }
  };
  const strategy = {
    topic: title,
    contentType: 'Story',
    requestedStyle: 'story',
    requestedLengthKey: 'medium',
    requestedLength: `${Math.max(1, Math.round(seconds / 60))} minutes`,
    angle: 'Separate what is known, what experts believe, and what is speculation.',
    contentPillar: parsed.series,
    targetAudience: 'Curious adults worldwide; English narration, clear and simple pacing, no prior knowledge assumed.',
    keywords,
    researchSources: sources.map(({ key, ...rest }) => rest),
    bestPublishTime: options.publishTime || null,
    estimatedViews: 0,
    competitorAnalysis: []
  };
  script.metadata.strategy = strategy;
  const database = db || new Database();
  if (!db) await database.initialize();
  const job = await database.createGenerationJob({ topic: strategy.topic, style: 'story', length: 'medium', source: 'manual', strategyContext: {} });
  const now = new Date().toISOString();
  await database.saveGenerationCheckpoint(job.id, 'strategy', { status: 'completed', artifact: strategy, startedAt: now, completedAt: now, error: null });
  await database.saveGenerationCheckpoint(job.id, 'script', { status: 'completed', artifact: script, startedAt: now, completedAt: now, error: null });
  await database.updateGenerationJob(job.id, { status: 'interrupted', error: 'Imported approved script; resume to produce' });
  return { jobId: job.id, title, sections: sections.map(s => s.title), words, claims: claims.length, sources: sources.length };
}

module.exports = { parseScript, importScript };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-approved-script.js <script.md> [--publish-time ISO] [--keywords "a, b"]');
    process.exit(1);
  }
  importScript(fs.readFileSync(file, 'utf8'), {
    sourceFile: path.basename(file),
    publishTime: arg('publish-time', null),
    keywords: (arg('keywords') || '').split(',').map(k => k.trim()).filter(Boolean)
  }).then(result => {
    console.log(JSON.stringify(result));
    process.exit(0);
  }).catch(error => { console.error('FAILED', error.message); process.exit(1); });
}
