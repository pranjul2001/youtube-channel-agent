// Weekly topic shortlist. Gathers free trend signals (Google Trends, Wikipedia's most-read
// pages, YouTube most-popular when signed in), then asks the AI to turn them into a wide list
// of documentary topics. Each topic is tagged with one of the channel's series or "Wildcard",
// and anything that breaks the channel bible is dropped in code, not just in the prompt.
const axios = require('axios');
const { progress } = require('./progress-tracker');
const { Logger } = require('./logger');
const { generateTextWithRetry } = require('./ai-retry');

const USER_AGENT = 'CuriousFilesTopicCurator/1.0 (local tool)';
const SERIES = ['Mysteries', 'Money explained', 'True stories'];
const WILDCARD = 'Wildcard';

// Channel bible, enforced on every candidate: no gore, no medical or financial advice, no
// topics centred on real victims, children or living private people, nothing sexual.
const BLOCKED = /\b(murder(ed|er|s)?|serial killer|massacre|shooting|suicide|rape|abuse|kidnap\w*|beheading|gore|autopsy|porn\w*|sex(ual)?|nude|onlyfans|how to (invest|get rich|lose weight|cure)|stock tips?|crypto (tips?|picks?)|which stocks?|buy now|diet|cure for|treatment for|symptoms of|diagnos\w+|election|vote for|celebrity gossip|net worth)\b/i;

const SMALL = new Set('the a an and of in on at for to from with how what why when who is are was were history story science rise fall new world global great big real true inside part one two list'.split(' '));
const contentWords = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(word => word.length > 2 && !SMALL.has(word));
const shareWord = (a, b) => {
  const words = new Set(contentWords(b).map(word => word.slice(0, 6)));
  return contentWords(a).some(word => words.has(word.slice(0, 6)));
};

const decode = text => String(text || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

class TopicCurator {
  constructor(options = {}) {
    this.db = options.db;
    this.aiText = options.aiText;
    this.http = options.http || axios;
    this.logger = options.logger || new Logger('TopicCurator');
    this.youtubeTrends = options.youtubeTrends || null; // async () => [{title, viewCount}]
    this.now = options.now || (() => new Date());
  }

  async googleTrends(geos = ['US', 'GB', 'IN']) {
    const out = [];
    for (const geo of geos) {
      try {
        const response = await this.http.get(`https://trends.google.com/trending/rss?geo=${geo}`, { timeout: 20000, headers: { 'User-Agent': USER_AGENT } });
        const titles = [...String(response.data).matchAll(/<item>[\s\S]*?<title>([^<]+)<\/title>/g)].map(m => decode(m[1]).trim());
        titles.slice(0, 20).forEach(title => out.push({ signal: title, source: `Google Trends (${geo})` }));
      } catch (error) {
        this.logger.warn(`Google Trends ${geo} unavailable: ${error.message}`);
      }
    }
    return out;
  }

  // Most-read English Wikipedia articles over the last few days (two-day publishing delay).
  async wikipediaTop(days = 3) {
    const counts = new Map();
    for (let d = 2; d < 2 + days; d++) {
      const date = new Date(this.now().getTime() - d * 86400000);
      const day = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
      try {
        const response = await this.http.get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${day}`, { timeout: 20000, headers: { 'User-Agent': USER_AGENT } });
        for (const article of response.data?.items?.[0]?.articles || []) {
          if (/^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Category:|\.)/.test(article.article)) continue;
          counts.set(article.article, (counts.get(article.article) || 0) + article.views);
        }
      } catch (error) {
        this.logger.warn(`Wikipedia top pages ${day} unavailable: ${error.message}`);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)
      .map(([article, views]) => ({ signal: article.replace(/_/g, ' '), source: 'Wikipedia most read', views }));
  }

  async signals() {
    const [trends, wiki, youtube] = await Promise.all([
      this.googleTrends(),
      this.wikipediaTop(),
      this.youtubeTrends ? this.youtubeTrends().catch(() => []) : []
    ]);
    const yt = (youtube || []).slice(0, 25).map(video => ({ signal: video.title, source: 'YouTube most popular' }));
    const seen = new Set();
    return [...trends, ...wiki, ...yt].filter(item => {
      const key = item.signal.toLowerCase();
      if (!item.signal || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Validate and clean AI candidates; returns ranked topics that pass the bible filter.
  static sanitize(candidates, { signals = [], recentTopics = [], limit = 18 } = {}) {
    const signalText = signals.map(s => s.signal.toLowerCase());
    const recent = recentTopics.map(t => String(t).toLowerCase());
    const out = [];
    for (const item of Array.isArray(candidates) ? candidates : []) {
      const topic = String(item?.topic || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      const why = String(item?.why || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      const angle = String(item?.angle || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      const wikipedia = String(item?.wikipedia || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (topic.length < 8 || !wikipedia) continue;
      if (BLOCKED.test(`${topic} ${angle}`)) continue;
      if (recent.some(r => r === topic.toLowerCase() || r.includes(wikipedia.toLowerCase()))) continue;
      if (out.some(o => o.wikipedia.toLowerCase() === wikipedia.toLowerCase())) continue;
      const tag = SERIES.find(s => s.toLowerCase() === String(item.tag || '').toLowerCase()) || WILDCARD;
      // The trend the AI names must be one we actually collected (no invented "trending" claims).
      const trend = String(item?.trend || '').toLowerCase().trim();
      const inSignals = trend && signalText.some(s => s === trend || s.includes(trend) || trend.includes(s));
      // ...and it must really be the topic's subject: a meaningful word in common.
      const grounded = inSignals && shareWord(trend, `${topic} ${wikipedia}`);
      out.push({ topic, angle, why: grounded ? why : `Evergreen pick. ${why}`.trim(), tag, wikipedia, trending: Boolean(grounded) });
    }
    // Trending first, then series topics before wildcards; keep the AI's order within a group.
    const score = t => (t.trending ? 2 : 0) + (t.tag !== WILDCARD ? 1 : 0);
    return out.map((t, i) => ({ ...t, i })).sort((a, b) => score(b) - score(a) || a.i - b.i).slice(0, limit)
      .map(({ i, ...t }, rank) => ({ ...t, rank: rank + 1 }));
  }

  async curate({ limit = 18 } = {}) {
    if (!this.aiText?.isAvailable?.()) throw new Error('AI text provider is required to curate topics');
    progress.start('topics', 'Finding trending topics');
    const signals = await this.signals();
    progress.update('topics', { step: 'choosing', detail: `${signals.length} trends found` });
    const recentRows = this.db?.getAllRows
      ? await this.db.getAllRows("SELECT topic FROM content_ideas WHERE status IN ('generated','generating','picked') ORDER BY created_at DESC LIMIT 60").catch(() => [])
      : [];
    const prompt = `You plan topics for "Curious Files", a calm, factual documentary YouTube channel (7-9 minute videos, real footage, maps, archive images).
Series: "Mysteries" (unexplained events, space and the universe, open questions of history and science), "Money explained" (how money, economies and famous financial events work: explanation only, never advice), "True stories" (real survival, exploration, engineering and historical events).
Below are things people are searching and reading about right now. Propose ${limit + 6} video topics.
Rules:
- Each topic must be an evergreen documentary subject that will still be interesting in six months. Use a trend as the DOOR to a lasting subject (a film about a ship -> the real ship's story; a storm in the news -> how hurricanes get their names). Skip breaking news, sports results, celebrities' private lives, politics and elections.
- Never: gore, crime against identifiable victims, children, medical or financial advice, sexual content.
- The topic must be genuinely ABOUT the trend's own subject (the real person, ship, place, company, event, object or idea behind it), not a loose association. If a trend has no documentary subject, skip it.
- "wikipedia": the exact title of the English Wikipedia article about the TOPIC's subject (the thing the video explains), with plenty of facts. It is often, but not always, the trend itself.
- "trend": copy the exact trend text from the list that inspired the topic, or "" for an evergreen idea of your own (at most a third of the list).
- "tag": "Mysteries", "Money explained" or "True stories" ONLY when it truly fits; otherwise "Wildcard" (science, technology, nature, culture, arts, how things work...). Do not force topics into a series; a good list has several Wildcards.
- "topic": an honest video title under 90 characters, no clickbait. "angle": one sentence on what the video explains. "why": one sentence on why viewers care now.
Recently made (do not repeat): ${recentRows.map(r => r.topic).slice(0, 30).join('; ') || 'none'}
Return ONLY a JSON array of objects {"topic","angle","why","tag","wikipedia","trend"}.

Trends:
${signals.slice(0, 140).map(s => `- ${s.signal} [${s.source}]`).join('\n')}`;
    const raw = await generateTextWithRetry(this.aiText, prompt, { maxTokens: 6000, temperature: 0.7, logger: this.logger });
    const match = String(raw || '').match(/\[[\s\S]*\]/);
    const candidates = TopicCurator.sanitize(match ? JSON.parse(match[0]) : [], { signals, recentTopics: recentRows.map(r => r.topic), limit: limit + 6 });
    progress.update('topics', { step: 'checking', detail: `${candidates.length} candidate topics` });
    const topics = (await this.resolveArticles(candidates)).slice(0, limit).map((topic, i) => ({ ...topic, rank: i + 1 }));
    if (topics.length < 5) throw new Error(`Only ${topics.length} usable topics came back; keeping the previous list`);
    return { topics, signalCount: signals.length };
  }

  // Every topic needs a real, substantial Wikipedia article about its own subject. When the AI's
  // article does not match the topic, search for a better one; drop the topic if none fits.
  async resolveArticles(candidates) {
    const out = [];
    const used = new Set();
    for (const [n, candidate] of candidates.entries()) {
      progress.update('topics', { fraction: n / candidates.length, detail: `Checking ${n + 1} of ${candidates.length}` });
      try {
        // Stay well inside Wikipedia's rate limit.
        await new Promise(resolve => setTimeout(resolve, this.pauseMs ?? 1200));
        let title = shareWord(candidate.wikipedia, candidate.topic) ? await this.articleTitle(candidate.wikipedia) : null;
        if (!title) {
          const search = await this.http.get('https://en.wikipedia.org/w/api.php', {
            timeout: 20000, headers: { 'User-Agent': USER_AGENT },
            params: { action: 'query', format: 'json', list: 'search', srsearch: candidate.topic, srlimit: 4 }
          });
          for (const hit of search.data?.query?.search || []) {
            if (/disambiguation|^List of/i.test(hit.title) || !shareWord(hit.title, candidate.topic) || hit.size < 12000) continue;
            title = hit.title;
            break;
          }
        }
        if (!title || used.has(title)) continue;
        used.add(title);
        out.push({ ...candidate, wikipedia: title });
      } catch (error) {
        this.logger.warn(`Could not verify the article for "${candidate.topic}": ${error.message}`);
      }
    }
    return out;
  }

  // Canonical title when the article exists and is long enough to research from.
  async articleTitle(title) {
    const response = await this.http.get('https://en.wikipedia.org/w/api.php', {
      timeout: 20000, headers: { 'User-Agent': USER_AGENT },
      params: { action: 'query', format: 'json', prop: 'info', redirects: 1, titles: title }
    });
    const page = Object.values(response.data?.query?.pages || {})[0];
    return page && page.missing === undefined && page.length >= 12000 ? page.title : null;
  }

  // Curate and store as the current shortlist; the previous unpicked shortlist is archived.
  async refresh(options = {}) {
    let curated;
    try {
      curated = await this.curate(options);
    } catch (error) {
      progress.fail('topics', error.message);
      throw error;
    }
    const { topics, signalCount } = curated;
    const batch = this.now().toISOString().slice(0, 10);
    await this.db.executeQuery("UPDATE content_ideas SET status = 'archived', updated_at = datetime('now') WHERE status = 'shortlist'");
    for (const topic of topics) {
      await this.db.createContentIdea({
        topic: topic.topic, angle: topic.angle, style: 'story', status: 'shortlist', rationale: topic.why,
        tag: topic.tag, rank: topic.rank, batch, wikipedia: topic.wikipedia, trending: topic.trending
      });
    }
    await this.db.setSetting('topics_curated_at', this.now().toISOString(), 'When the topic shortlist was last refreshed');
    progress.finish('topics', `${topics.length} topics ready`);
    this.logger.info(`Topic shortlist refreshed: ${topics.length} topics from ${signalCount} trend signals`);
    return { topics, batch, signalCount };
  }
}

module.exports = { TopicCurator, SERIES, WILDCARD, BLOCKED };
