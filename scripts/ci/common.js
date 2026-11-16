// Shared helpers for the GitHub Actions runs: the topic issue (owner picks by ticking a box),
// a fresh database seeded with the channel's settings, and the app started as a local server.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const LABEL = 'topics';
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;

async function gh(route, options = {}) {
  if (!REPO || !TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const response = await fetch(`https://api.github.com/repos/${REPO}${route}`, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`GitHub ${options.method || 'GET'} ${route}: ${response.status} ${data?.message || ''}`);
  return data;
}

// ----- topic issue ---------------------------------------------------------------------------
// The issue body is a checklist the owner ticks on github.com or the GitHub mobile app. Topic
// details (article, angle, tag) ride along in a hidden JSON comment at the end of the body.
const DATA_RE = /<!-- topics-data: ([A-Za-z0-9+/=]+) -->/;

function issueBody(topics, weekOf) {
  const lines = [
    `Pick tomorrow's video by **ticking one box by 11:59 PM** (on github.com or in the GitHub app). If nothing is ticked, the best available topic (the highest one not yet made) is used.`,
    '',
    `The video is made early each morning and is on YouTube as **PRIVATE** **by 10:00 AM**. A comment appears here when it is ready. Watch it in YouTube Studio, then make it public yourself when you are happy with it.`,
    '',
    `_List made ${weekOf} from Google Trends, Wikipedia's most-read pages and YouTube trending. "Fits" = one of your series, "Wildcard" = outside them._`,
    '',
    ...topics.map(topicLine),
    '',
    `<!-- topics-data: ${Buffer.from(JSON.stringify(topics)).toString('base64')} -->`
  ];
  return lines.join('\n');
}

function topicLine(topic) {
  const tag = topic.tag === 'Wildcard' ? 'Wildcard' : `Fits: ${topic.tag}`;
  const made = topic.made ? ` ✅ made ${topic.made.date}${topic.made.studioUrl ? ` · [open in YouTube Studio](${topic.made.studioUrl})` : ''}` : '';
  const title = topic.made ? `~~**${topic.topic}**~~` : `**${topic.topic}**`;
  return `- [${topic.made || topic.checked ? 'x' : ' '}] ${title} · ${tag}${topic.trending ? ' · Trending' : ''}${made}<!-- topic:${topic.n} -->\n  <sub>${(topic.why || topic.angle || '').replace(/\n/g, ' ')}</sub>`;
}

// Topics with the owner's current ticks read from the body (the hidden data has the details).
function parseIssue(body) {
  const match = String(body || '').match(DATA_RE);
  if (!match) return [];
  const topics = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  for (const topic of topics) {
    const line = String(body).split('\n').find(l => l.includes(`<!-- topic:${topic.n} -->`));
    topic.checked = Boolean(line && /^- \[[xX]\]/.test(line.trim()));
  }
  return topics;
}

async function openTopicIssue() {
  const issues = await gh(`/issues?labels=${LABEL}&state=open&sort=created&direction=desc&per_page=5`);
  return (issues || []).find(issue => !issue.pull_request) || null;
}

async function saveIssueTopics(issue, topics) {
  const body = String(issue.body).replace(/\n- \[[ xX]\][\s\S]*?(?=\n\n<!-- topics-data)/, `\n${topics.map(topicLine).join('\n')}`)
    .replace(DATA_RE, `<!-- topics-data: ${Buffer.from(JSON.stringify(topics.map(({ checked, ...t }) => t))).toString('base64')} -->`);
  return gh(`/issues/${issue.number}`, { method: 'PATCH', body: { body } });
}

// The owner's ticked topic that hasn't been made yet, else the top unmade topic.
function chooseTopic(topics, madeTitles = []) {
  const made = new Set(madeTitles.map(t => t.toLowerCase()));
  const open = topics.filter(t => !t.made && !made.has(t.topic.toLowerCase()));
  return open.find(t => t.checked) || open[0] || null;
}

// Build the next weekly list: fresh trending topics first, then carried-over unmade topics from
// the previous list (deduped by article), renumbered from 1. A ticked-but-unmade pick keeps its
// tick across the refresh and is ordered first among carried topics so slice() can never drop it.
function mergeTopics(fresh, prevUnmade = [], limit = 4) {
  const key = t => String(t.wikipedia).toLowerCase();
  const checkedKeys = new Set(prevUnmade.filter(t => t.checked).map(key));
  const carried = [...prevUnmade.filter(t => t.checked), ...prevUnmade.filter(t => !t.checked)].slice(0, limit);
  const seen = new Set(fresh.map(key));
  return [...fresh, ...carried.filter(t => !seen.has(key(t)))]
    .map((t, i) => ({ n: i + 1, topic: t.topic, angle: t.angle, why: t.why, tag: t.tag, wikipedia: t.wikipedia, trending: Boolean(t.trending), checked: checkedKeys.has(key(t)) }));
}

// ----- database and app ----------------------------------------------------------------------
async function seededDatabase() {
  process.env.YAA_DB_PATH = process.env.YAA_DB_PATH || path.join(ROOT, 'data', 'ci.db');
  const { Database } = require('../../database/db');
  const db = new Database();
  await db.initialize();
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'channel-seed.json'), 'utf8'));
  for (const [key, value] of Object.entries(seed.settings || {})) await db.setSetting(key, value);
  for (const [table, rows] of [['channel_profiles', seed.channelProfiles], ['channel_strategies', seed.channelStrategies]]) {
    for (const row of rows || []) {
      const columns = Object.keys(row);
      await db.executeQuery(`INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(c => row[c]));
    }
  }
  // Cloud runs never publish on their own schedule; uploads happen only in ci/daily.js, as private.
  await db.setSetting('automation_paused', 'true');
  await db.setSetting('daily_video_enabled', 'false');
  return db;
}

function history() {
  const file = path.join(ROOT, 'state', 'history.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_error) { return { videos: [] }; }
}

function saveHistory(data) {
  const file = path.join(ROOT, 'state', 'history.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

async function startApp() {
  const port = process.env.PORT || '3456';
  const child = spawn(process.execPath, ['index.js'], { cwd: ROOT, env: { ...process.env, PORT: port, HOST: '127.0.0.1' }, stdio: ['ignore', 'inherit', 'inherit'] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`App exited during start (code ${child.exitCode})`);
    try {
      const response = await fetch(`${base}/api/readiness`);
      if (response.ok) return { child, base };
    } catch (_error) { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  child.kill();
  throw new Error('App did not start within 2 minutes');
}

async function api(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { 'x-api-key': process.env.API_KEY, 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data.result ?? data;
}

module.exports = { ROOT, LABEL, gh, issueBody, parseIssue, openTopicIssue, saveIssueTopics, chooseTopic, mergeTopics, seededDatabase, history, saveHistory, startApp, api };
