// One finished video in the review queue every day.
//
// Weekly: refresh the topic shortlist from trends. Nightly: the owner picks tomorrow's topic
// (otherwise the top of the list is used). Each morning at the build time: research → script →
// automatic fact check → narration → video → thumbnail, then it waits for human review.
// Nothing here ever publishes: uploading stays a human click in the review queue.
//
// The clock is checked every few minutes instead of with a one-shot timer, so a machine that
// was asleep or restarted at the build time still makes the day's video when it wakes.
const fs = require('fs').promises;
const { progress } = require('./progress-tracker');
const path = require('path');
const { Logger } = require('./logger');
const { slugify } = require('./documentary-script-writer');

class DailyVideoService {
  constructor(options = {}) {
    this.db = options.db;
    this.curator = options.curator;
    this.writer = options.writer;
    this.importScript = options.importScript;      // async (markdown, opts, db) => {jobId,...}
    this.resumeJob = options.resumeJob;            // async jobId => job
    this.fillEvidence = options.fillEvidence || null; // async (productionId, report, sources) => void
    this.logger = options.logger || new Logger('DailyVideo');
    this.now = options.now || (() => new Date());
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.scriptsDir = options.scriptsDir || path.join(__dirname, '..', 'data', 'scripts-generated');
    this.running = null;
    this.refreshing = null;
    this.timer = null;
  }

  async settings() {
    const stored = await this.db.getAllSettings();
    const time = /^\d{1,2}:\d{2}$/.test(stored.daily_build_time || '') ? stored.daily_build_time : '06:00';
    const [h, m] = time.split(':').map(Number);
    return {
      enabled: stored.daily_video_enabled === 'true',
      buildTime: time,
      buildMinutes: Math.min(23, h) * 60 + Math.min(59, m),
      timezone: stored.channel_timezone || 'UTC',
      refreshDays: Math.max(1, Number(stored.topics_refresh_days) || 7),
      lastBuildDate: stored.daily_last_build_date || null,
      attempts: Number(stored.daily_attempts) || 0,
      curatedAt: stored.topics_curated_at || null,
      lastError: stored.daily_last_error || null
    };
  }

  // Local calendar date and minutes since midnight in the channel's timezone.
  localClock(timezone, at = this.now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(at).map(part => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  async tomorrow() {
    const { timezone } = await this.settings();
    return this.localClock(timezone, new Date(this.now().getTime() + 86400000)).date;
  }

  async listTopics() {
    const rows = await this.db.getAllRows(
      "SELECT * FROM content_ideas WHERE status IN ('shortlist','picked','generating','generated','failed') AND (batch IS NOT NULL) ORDER BY CASE status WHEN 'picked' THEN 0 WHEN 'generating' THEN 1 WHEN 'shortlist' THEN 2 ELSE 3 END, COALESCE(rank, 999), created_at DESC LIMIT 80"
    );
    const settings = await this.settings();
    return {
      settings: { enabled: settings.enabled, buildTime: settings.buildTime, timezone: settings.timezone, curatedAt: settings.curatedAt, lastBuildDate: settings.lastBuildDate, lastError: settings.lastError },
      tomorrow: await this.tomorrow(),
      building: Boolean(this.running),
      refreshing: Boolean(this.refreshing),
      topics: rows.map(row => ({
        id: row.id, topic: row.topic, angle: row.angle, why: row.rationale, tag: row.tag || 'Wildcard', rank: row.rank,
        trending: row.trending === 1, status: row.status, scheduledFor: row.scheduled_for, jobId: row.job_id, wikipedia: row.wikipedia
      }))
    };
  }

  // Choose a topic for a date (default: tomorrow). Only one topic per date.
  async pick(ideaId, date = null) {
    const day = date || await this.tomorrow();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Object.assign(new Error('Date must be YYYY-MM-DD'), { status: 400 });
    const idea = await this.db.getRow('SELECT * FROM content_ideas WHERE id = ?', [ideaId]);
    if (!idea || !['shortlist', 'picked', 'failed'].includes(idea.status)) throw Object.assign(new Error('Topic not found in the shortlist'), { status: 404 });
    await this.db.executeQuery("UPDATE content_ideas SET status = 'shortlist', scheduled_for = NULL, updated_at = datetime('now') WHERE status = 'picked' AND scheduled_for = ?", [day]);
    return this.db.updateContentIdea(ideaId, { status: 'picked', scheduledFor: day });
  }

  async unpick(ideaId) {
    const idea = await this.db.getRow('SELECT * FROM content_ideas WHERE id = ?', [ideaId]);
    if (!idea || idea.status !== 'picked') throw Object.assign(new Error('Topic is not picked'), { status: 404 });
    return this.db.updateContentIdea(ideaId, { status: 'shortlist', scheduledFor: null });
  }

  refreshTopics() {
    if (!this.refreshing) {
      this.refreshing = this.curator.refresh().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async shortlistIsStale(settings) {
    const row = await this.db.getRow("SELECT COUNT(*) AS n FROM content_ideas WHERE status = 'shortlist'");
    if (!row || row.n < 3) return true;
    if (!settings.curatedAt) return true;
    return this.now().getTime() - new Date(settings.curatedAt).getTime() > settings.refreshDays * 86400000;
  }

  // After a restart mid-build the in-memory wait is gone. Bring topics still marked "generating"
  // in line with what their job actually did: finished -> ready (fact-check desk filled from the
  // saved check), stopped -> resumed once, never started -> back to the list.
  async reconcile() {
    if (this.running) return;
    const stuck = await this.db.getAllRows("SELECT * FROM content_ideas WHERE status = 'generating' AND batch IS NOT NULL");
    for (const idea of stuck) {
      const job = idea.job_id ? await this.db.getGenerationJob(idea.job_id) : null;
      if (!job) {
        await this.db.updateContentIdea(idea.id, { status: 'picked' });
        continue;
      }
      if (['completed', 'completed_with_issues'].includes(job.status) && job.production_id) {
        try {
          const checkPath = await this.db.getSetting(`daily_check_${job.id}`);
          const bundle = checkPath ? JSON.parse(await fs.readFile(checkPath, 'utf8')) : null;
          const review = await this.db.getRow('SELECT status FROM content_reviews WHERE production_id = ?', [job.production_id]);
          if (bundle && this.fillEvidence && review && !['approved', 'rejected'].includes(review.status)) {
            await this.fillEvidence(job.production_id, bundle.report, bundle.sources);
          }
        } catch (error) {
          this.logger.warn(`Fact-check desk could not be restored for "${idea.topic}": ${error.message}`);
        }
        await this.db.updateContentIdea(idea.id, { status: 'generated' });
        await this.notify('success', 'Daily video is ready for review', `"${idea.topic}" is in the review queue.`);
        this.logger.info(`Recovered finished daily video: "${idea.topic}"`);
      } else if (['failed', 'interrupted'].includes(job.status)) {
        const resumed = await this.db.getSetting(`daily_resumed_${job.id}`);
        if (resumed === 'true') {
          await this.db.updateContentIdea(idea.id, { status: 'failed' });
          await this.db.setSetting('daily_last_error', `Production ${job.status}: ${job.error || 'no details'}`.slice(0, 400));
          continue;
        }
        await this.db.setSetting(`daily_resumed_${job.id}`, 'true');
        this.logger.info(`Resuming interrupted daily video: "${idea.topic}"`);
        progress.start('video', idea.topic, 'Resuming after a restart');
        this.running = (async () => {
          try {
            await this.resumeJob(job.id);
            await this.waitForJob(job.id);
          } finally {
            this.running = null;
          }
          await this.reconcile();
        })().catch(error => this.logger.warn(`Resume failed: ${error.message}`));
        return;
      }
    }
  }

  // Called every few minutes. Safe to call at any time.
  async tick() {
    await this.reconcile().catch(error => this.logger.warn(`Daily video recovery failed: ${error.message}`));
    const settings = await this.settings();
    if (!settings.enabled) return { skipped: 'disabled' };
    if (!this.refreshing && await this.shortlistIsStale(settings)) {
      this.refreshTopics().catch(error => this.logger.warn(`Topic refresh failed: ${error.message}`));
    }
    const clock = this.localClock(settings.timezone);
    if (this.running) return { skipped: 'building' };
    if (clock.minutes < settings.buildMinutes) return { skipped: 'before build time' };
    const sameDay = settings.lastBuildDate === clock.date;
    // One automatic retry per day if the first build failed.
    if (sameDay && !(settings.lastError && settings.attempts < 2)) return { skipped: 'already built today' };
    this.start(clock.date, sameDay ? settings.attempts + 1 : 1);
    return { started: clock.date };
  }

  start(date, attempt = 1) {
    if (this.running) return this.running;
    this.running = this.runDaily(date, attempt)
      .catch(error => this.logger.error(`Daily video failed: ${error.message}`))
      .finally(() => { this.running = null; });
    return this.running;
  }

  async chooseIdea(date) {
    const picked = await this.db.getRow("SELECT * FROM content_ideas WHERE status = 'picked' AND scheduled_for <= ? ORDER BY scheduled_for DESC LIMIT 1", [date]);
    if (picked) return picked;
    let top = await this.db.getRow("SELECT * FROM content_ideas WHERE status = 'shortlist' ORDER BY COALESCE(rank, 999) LIMIT 1");
    if (!top) {
      await this.refreshTopics();
      top = await this.db.getRow("SELECT * FROM content_ideas WHERE status = 'shortlist' ORDER BY COALESCE(rank, 999) LIMIT 1");
    }
    return top;
  }

  async runDaily(date, attempt = 1) {
    await this.db.setSetting('daily_last_build_date', date, 'Last date the daily video build started');
    await this.db.setSetting('daily_attempts', String(attempt), 'Daily build attempts for that date');
    await this.db.setSetting('daily_last_error', '', 'Why the last daily build failed, if it did');
    let idea = null;
    progress.start('video', 'Daily video', 'Choosing the topic');
    try {
      idea = await this.chooseIdea(date);
      if (!idea) throw new Error('No topic available: the shortlist is empty and could not be refreshed');
      this.logger.info(`Daily video ${date}: "${idea.topic}" (${idea.status === 'picked' ? 'picked by owner' : 'top of the shortlist'})`);
      await this.db.updateContentIdea(idea.id, { status: 'generating', scheduledFor: date });
      progress.update('video', { title: idea.topic, step: 'script' });

      const written = await this.writer.write({ topic: idea.topic, angle: idea.angle, tag: idea.tag, wikipedia: idea.wikipedia });
      await fs.mkdir(this.scriptsDir, { recursive: true });
      const scriptPath = path.join(this.scriptsDir, `${date}-${slugify(written.script.title)}.md`);
      await fs.writeFile(scriptPath, written.markdown);
      // Kept so the fact-check desk can still be filled if the app restarts during the build.
      await fs.writeFile(scriptPath.replace(/\.md$/, '.check.json'), JSON.stringify({ report: written.report, sources: written.sources.map(({ key, title, url }) => ({ key, title, url })) }));
      this.logger.info(`Script written (${written.report.words} words, ${written.report.failedClaims.length} claim(s) and ${written.report.unknownNumbers.length} number(s) need review): ${scriptPath}`);

      const imported = await this.importScript(written.markdown, { sourceFile: path.basename(scriptPath), keywords: written.script.keywords }, this.db);
      await this.db.updateContentIdea(idea.id, { jobId: imported.jobId });
      await this.db.setSetting(`daily_check_${imported.jobId}`, scriptPath.replace(/\.md$/, '.check.json'));
      await this.resumeJob(imported.jobId);
      const job = await this.waitForJob(imported.jobId);
      if (!job.production_id || !['completed', 'completed_with_issues'].includes(job.status)) {
        throw new Error(`Production ${job.status} at ${job.stage}: ${job.error || 'no details'}`);
      }
      if (this.fillEvidence) {
        await this.fillEvidence(job.production_id, written.report, written.sources)
          .catch(error => this.logger.warn(`Fact-check desk could not be filled automatically: ${error.message}`));
      }
      await this.db.updateContentIdea(idea.id, { status: 'generated' });
      progress.finish('video', 'Ready for your review');
      const open = written.report.failedClaims.length + written.report.unknownNumbers.length;
      await this.notify('success', 'Daily video is ready for review',
        `"${written.script.title}" is in the review queue.${open ? ` ${open} fact(s) need your check.` : ' All checked facts matched the sources.'}`);
      return { productionId: job.production_id, scriptPath, title: written.script.title };
    } catch (error) {
      progress.fail('video', error.message);
      await this.db.setSetting('daily_last_error', String(error.message).slice(0, 400));
      if (idea) await this.db.updateContentIdea(idea.id, { status: attempt >= 2 ? 'failed' : 'picked', scheduledFor: date }).catch(() => {});
      await this.notify('error', 'Daily video could not be made', String(error.message).slice(0, 300));
      throw error;
    }
  }

  async waitForJob(jobId, limitMs = 2 * 60 * 60 * 1000) {
    const started = Date.now();
    while (Date.now() - started < limitMs) {
      await this.sleep(15000);
      const job = await this.db.getGenerationJob(jobId);
      if (!job) throw new Error('Generation job disappeared');
      if (['completed', 'completed_with_issues', 'failed', 'interrupted', 'cancelled'].includes(job.status)) return job;
    }
    throw new Error('Production did not finish within 2 hours');
  }

  async notify(type, title, message) {
    try {
      if (this.db.createNotification) await this.db.createNotification({ type: 'daily_video', level: type === 'error' ? 'error' : 'info', title, message });
    } catch (error) {
      this.logger.warn(`Notification failed: ${error.message}`);
    }
  }

  startClock(intervalMs = 5 * 60 * 1000) {
    if (this.timer) return;
    const run = () => this.tick().catch(error => this.logger.warn(`Daily video check failed: ${error.message}`));
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
    setTimeout(run, 20000).unref?.();
  }

  stopClock() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { DailyVideoService };
