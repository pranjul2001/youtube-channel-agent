#!/usr/bin/env node
// Daily (GitHub Actions): make one video from the owner's ticked topic (else the top topic),
// upload it to YouTube as PRIVATE, and report on the topic issue. The owner reviews it in
// YouTube Studio and makes it public there; nothing here ever sets a video public.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { ROOT, gh, parseIssue, openTopicIssue, saveIssueTopics, chooseTopic, seededDatabase, history, saveHistory, startApp, api } = require('./common');
const { createTopicIssue } = require('./topics');

const summary = text => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
};

async function makeVideo(db, topic, today) {
  await db.createContentIdea({
    topic: topic.topic, angle: topic.angle, style: 'story', status: 'picked', rationale: topic.why,
    tag: topic.tag, rank: 1, batch: today, wikipedia: topic.wikipedia, trending: topic.trending, scheduledFor: today
  });
  const { child, base } = await startApp();
  try {
    await api(base, '/api/daily-video/run', { method: 'POST', body: {} });
    const started = Date.now();
    let last = '';
    while (Date.now() - started < 115 * 60 * 1000) {
      await new Promise(resolve => setTimeout(resolve, 20000));
      const tasks = await api(base, '/api/progress').catch(() => []);
      const video = tasks.find(task => task.id === 'video');
      const line = video ? `${video.percent}% ${video.steps.find(s => s.state === 'current')?.label || video.status} — ${video.detail}` : 'starting';
      if (line !== last) { console.log(`[progress] ${line}`); last = line; }
      const { topics } = await api(base, '/api/topics');
      const idea = topics.find(t => t.topic === topic.topic);
      if (idea && ['generated', 'failed'].includes(idea.status)) {
        if (idea.status === 'failed') throw new Error(`Video failed: ${(await db.getSetting('daily_last_error')) || 'see the log'}`);
        const job = await api(base, `/api/jobs/${idea.jobId}`);
        return { productionId: job.production_id, jobId: idea.jobId };
      }
      if (idea && idea.status === 'picked' && Date.now() - started > 10 * 60 * 1000) {
        const error = await db.getSetting('daily_last_error');
        if (error) throw new Error(`Video failed: ${error}`);
      }
    }
    throw new Error('The video was not finished within 115 minutes');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

async function uploadPrivate(db, productionId) {
  const { CredentialManager } = require('../../utils/credential-manager');
  const { PublishingSchedulingAgent } = require('../../agents/publishing-scheduling-agent');
  const bundle = await db.getProductionBundle(productionId);
  const parse = value => (typeof value === 'string' ? JSON.parse(value) : value || {});
  const assets = parse(bundle.assets);
  const credentials = new CredentialManager();
  await credentials.initialize();
  const publisher = new PublishingSchedulingAgent(db, credentials);
  await publisher.setupYouTubeAPI();
  const entry = {
    productionId,
    title: parse(bundle.script).title,
    publishTime: new Date().toISOString(),
    status: 'scheduled',
    metadata: {
      seo: parse(bundle.seo),
      thumbnail: assets.thumbnail,
      video: assets.finalVideo,
      captions: assets.captions,
      privacyStatus: 'private', // always: the owner makes it public in YouTube Studio
      containsSyntheticMedia: false
    }
  };
  const result = await publisher.uploadToYouTube(entry, { publishNow: true });
  return { videoId: result.id, title: entry.title, seconds: Math.round(Number(assets.audio?.duration) || 0) };
}

(async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const db = await seededDatabase();
  let issue = await openTopicIssue();
  if (!issue) issue = await createTopicIssue(db);
  const topics = parseIssue(issue.body);
  const past = history();
  if (past.videos.some(video => video.date === today) && process.env.FORCE_RUN !== 'true') {
    summary(`A video was already made today (${today}); nothing to do.`);
    process.exit(0);
  }
  const topic = chooseTopic(topics, past.videos.map(v => v.topic));
  if (!topic) throw new Error('Every topic on the list has been made; the weekly list will refresh on Sunday (or run "Weekly topics" now).');
  summary(`## Daily video ${today}\n**Topic:** ${topic.topic} (${topic.checked ? 'ticked by you' : 'top of the list'})`);

  let made;
  try {
    made = await makeVideo(db, topic, today);
  } catch (error) {
    await gh(`/issues/${issue.number}/comments`, { method: 'POST', body: { body: `⚠️ **${today}: the video for "${topic.topic}" could not be made.**\n\n${error.message}\n\nThe topic stays on the list and will be tried again tomorrow (or re-run the "Daily video" workflow).` } }).catch(() => {});
    throw error;
  }

  const upload = await uploadPrivate(db, made.productionId);
  const studioUrl = `https://studio.youtube.com/video/${upload.videoId}/edit`;
  summary(`**Uploaded (private):** ${upload.title} — ${studioUrl}`);

  // Script and fact-check report go into the repo so the owner can read them from the issue.
  const checkPath = await db.getSetting(`daily_check_${made.jobId}`);
  let scriptLink = '';
  let toCheck = [];
  if (checkPath && fs.existsSync(checkPath)) {
    const check = JSON.parse(fs.readFileSync(checkPath, 'utf8'));
    toCheck = [...check.report.failedClaims.map(c => `- ${c.text} _(${c.check.reason})_`), ...check.report.unknownNumbers.map(n => `- The number **${n}** was not found in the sources`)];
    const scriptFile = checkPath.replace(/\.check\.json$/, '.md');
    const target = path.join(ROOT, 'docs', 'scripts', 'auto', path.basename(scriptFile));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(scriptFile, target);
    const branch = process.env.GITHUB_REF_NAME || 'channel';
    scriptLink = `https://github.com/${process.env.GITHUB_REPOSITORY}/blob/${branch}/docs/scripts/auto/${encodeURIComponent(path.basename(scriptFile))}`;
  }

  past.videos.push({ date: today, topic: topic.topic, wikipedia: topic.wikipedia, title: upload.title, youtubeId: upload.videoId, privacy: 'private' });
  saveHistory(past);
  const fresh = await gh(`/issues/${issue.number}`);
  const current = parseIssue(fresh.body);
  const item = current.find(t => t.n === topic.n);
  if (item) item.made = { date: today, studioUrl };
  await saveIssueTopics(fresh, current);

  const minutes = upload.seconds ? ` (${Math.floor(upload.seconds / 60)} min ${upload.seconds % 60} s)` : '';
  await gh(`/issues/${issue.number}/comments`, { method: 'POST', body: { body: [
    `✅ **${today}: "${upload.title}" is ready${minutes}.** It is on YouTube as **private**.`,
    '',
    `1. Watch it: [open in YouTube Studio](${studioUrl})`,
    scriptLink ? `2. Script and fact check: [read it here](${scriptLink})` : '',
    toCheck.length ? `\n**Please check these ${toCheck.length} fact(s) before publishing:**\n${toCheck.join('\n')}` : '\nEvery checked fact matched the sources.',
    '',
    'When you are happy, set it to **Public** (or schedule it) in YouTube Studio. To pick tomorrow\'s video, tick a box in the list above.'
  ].filter(Boolean).join('\n') } });
  summary('Done.');
  process.exit(0);
})().catch(error => { console.error('FAILED', error.stack || error.message); process.exit(1); });
