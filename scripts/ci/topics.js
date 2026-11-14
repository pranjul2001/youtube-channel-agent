#!/usr/bin/env node
// Weekly (GitHub Actions): find trending topics and post them as a tick-box issue.
// The previous week's issue is closed, keeping the topics that were never made.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { LABEL, gh, issueBody, parseIssue, openTopicIssue, seededDatabase, history } = require('./common');

async function createTopicIssue(db, logger = console) {
  const { TopicCurator } = require('../../utils/topic-curator');
  const { AITextService } = require('../../utils/ai-text-service');
  const { CredentialManager } = require('../../utils/credential-manager');
  const credentials = new CredentialManager();
  await credentials.loadCredentials();
  // Recently made topics are not suggested again.
  for (const video of history().videos.slice(-40)) {
    await db.createContentIdea({ topic: video.topic, status: 'generated', batch: 'history', wikipedia: video.wikipedia || null });
  }
  const curator = new TopicCurator({ db, aiText: new AITextService(credentials.credentials || {}) });
  const { topics } = await curator.curate({ limit: 14 });

  const previous = await openTopicIssue();
  const carried = previous ? parseIssue(previous.body).filter(t => !t.made).slice(0, 4) : [];
  const seen = new Set(topics.map(t => t.wikipedia.toLowerCase()));
  const all = [...topics, ...carried.filter(t => !seen.has(String(t.wikipedia).toLowerCase()))]
    .map((t, i) => ({ n: i + 1, topic: t.topic, angle: t.angle, why: t.why, tag: t.tag, wikipedia: t.wikipedia, trending: Boolean(t.trending) }));

  await gh('/labels', { method: 'POST', body: { name: LABEL, color: 'e2b35e', description: 'Weekly topic shortlist for the daily video' } }).catch(() => {});
  const weekOf = new Date().toISOString().slice(0, 10);
  const issue = await gh('/issues', { method: 'POST', body: { title: `🎬 Topics: week of ${weekOf}`, body: issueBody(all, weekOf), labels: [LABEL] } });
  if (previous) {
    await gh(`/issues/${previous.number}/comments`, { method: 'POST', body: { body: `A new list is ready: #${issue.number}. Unmade topics from here were carried over.` } }).catch(() => {});
    await gh(`/issues/${previous.number}`, { method: 'PATCH', body: { state: 'closed' } });
  }
  logger.log(`Topic issue #${issue.number}: ${all.length} topics`);
  return issue;
}

module.exports = { createTopicIssue };

if (require.main === module) {
  (async () => {
    const db = await seededDatabase();
    await createTopicIssue(db);
    process.exit(0);
  })().catch(error => { console.error('FAILED', error.message); process.exit(1); });
}
