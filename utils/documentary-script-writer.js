// Research → script → automatic fact check, for the daily video.
//
// 1. Research pack: the topic's Wikipedia article plus related articles (plain text).
// 2. The AI writes the whole narration from that text only, with a claim list.
// 3. Code checks every claim, and every number spoken in the narration, against the source
//    text. Failures go back to the AI once for correction; what still fails is flagged for
//    the human reviewer instead of being marked verified.
// Output is the same Markdown format as hand-written approved scripts, so production uses
// the one import path that the end-to-end check covers.
const axios = require('axios');
const { progress } = require('./progress-tracker');
const { Logger } = require('./logger');
const { generateTextWithRetry } = require('./ai-retry');

const USER_AGENT = 'CuriousFilesResearch/1.0 (local tool)';
const API = 'https://en.wikipedia.org/w/api.php';
const STOP = new Set(('the a an and or of to in on at for with by from as is was were be been it its this that these those there their they them he she ' +
  'his her we you our your not no but so if then than into over about after before what which who why how when where while had has have also more most ' +
  'about around roughly nearly almost some many much very still only just each every other another first second later early').split(' '));

const norm = text => String(text || '').toLowerCase().replace(/[’']/g, '').replace(/(\d)[,\u202f\u00a0](?=\d{3}\b)/g, '$1').replace(/[^\p{L}\p{N}.\s]/gu, ' ').replace(/\s+/g, ' ');
const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

// Numbers a viewer would hear as facts: digits (years, quantities, decimals). Small counts
// written as words ("three keepers") are checked through the claim list instead.
function numbersIn(text) {
  return [...new Set((norm(text).match(/\d+(?:\.\d+)?/g) || []).map(n => n.replace(/\.0+$/, '')))];
}

function sourceHasNumber(sourceNorm, number) {
  if (new RegExp(`(^|[^\\d.])${number.replace('.', '\\.')}(?![\\d]|\\.\\d)`).test(sourceNorm)) return true;
  const n = Number(number);
  // "12" in the script may be "twelve" in the source.
  const word = Object.entries(WORD_NUMBERS).find(([, value]) => value === n)?.[0];
  return Boolean(word && new RegExp(`\\b${word}\\b`).test(sourceNorm));
}

// Share of the script's 6-word runs that appear word for word in the sources (copied phrasing).
function copiedShare(text, sourcesNorm) {
  const words = norm(text).split(' ').filter(Boolean);
  if (words.length < 12) return 0;
  let copied = 0;
  let total = 0;
  for (let i = 0; i + 6 <= words.length; i += 3) {
    total += 1;
    if (sourcesNorm.includes(words.slice(i, i + 6).join(' '))) copied += 1;
  }
  return total ? copied / total : 0;
}

// A claim is supported when all its numbers and most of its content words are in a cited source.
function checkClaim(claim, sourcesByKey) {
  const cited = (claim.sources || []).map(key => sourcesByKey.get(key)).filter(Boolean);
  if (!cited.length) return { ok: false, reason: 'no known source cited' };
  const text = cited.map(source => source.norm).join(' ');
  const missingNumbers = numbersIn(claim.text).filter(number => !sourceHasNumber(text, number));
  if (missingNumbers.length) return { ok: false, reason: `number(s) not in the source: ${missingNumbers.join(', ')}` };
  const words = norm(claim.text).split(' ').filter(word => word.length > 3 && !STOP.has(word) && !/^\d/.test(word));
  const sourceWords = new Set(text.split(' '));
  const stems = new Set([...sourceWords].filter(word => word.length >= 5).map(word => word.slice(0, 5)));
  const hits = words.filter(word => sourceWords.has(word) || (word.length >= 5 && stems.has(word.slice(0, 5))));
  const ratio = words.length ? hits.length / words.length : 0;
  return ratio >= 0.7 ? { ok: true } : { ok: false, reason: `only ${Math.round(ratio * 100)}% of its key words appear in the source` };
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'script';
}

class DocumentaryScriptWriter {
  constructor(options = {}) {
    this.aiText = options.aiText;
    this.http = options.http || axios;
    this.logger = options.logger || new Logger('ScriptWriter');
  }

  async wikiArticle(title, maxChars) {
    const response = await this.http.get(API, {
      timeout: 30000, headers: { 'User-Agent': USER_AGENT },
      params: { action: 'query', format: 'json', prop: 'extracts|info', explaintext: 1, redirects: 1, inprop: 'url', titles: title }
    });
    const page = Object.values(response.data?.query?.pages || {})[0];
    if (!page || page.missing !== undefined || !page.extract || page.extract.length < 800) return null;
    const text = page.extract.replace(/\n==+\s*(See also|References|External links|Further reading|Notes|Bibliography)\s*==+[\s\S]*$/i, '').replace(/\n{3,}/g, '\n\n');
    return { title: page.title, url: page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`, text: text.slice(0, maxChars) };
  }

  // Main article plus up to two related ones found by search.
  async research(topic) {
    const sources = [];
    const main = await this.wikiArticle(topic.wikipedia || topic.topic, 16000);
    if (main) sources.push(main);
    try {
      const search = await this.http.get(API, {
        timeout: 30000, headers: { 'User-Agent': USER_AGENT },
        params: { action: 'query', format: 'json', list: 'search', srsearch: main ? `${main.title} ${topic.angle || ''}`.slice(0, 200) : topic.topic, srlimit: 6 }
      });
      for (const hit of search.data?.query?.search || []) {
        if (sources.length >= 3) break;
        if (sources.some(source => source.title === hit.title) || /\(disambiguation\)|^List of/i.test(hit.title)) continue;
        const article = await this.wikiArticle(hit.title, 7000);
        if (article && !sources.some(source => source.title === article.title)) sources.push(article);
      }
    } catch (error) {
      this.logger.warn(`Related-article search failed: ${error.message}`);
    }
    if (!sources.length) throw new Error(`No usable Wikipedia article for "${topic.wikipedia || topic.topic}"`);
    return sources.map((source, i) => ({ ...source, key: `W${i + 1}`, norm: norm(source.text) }));
  }

  prompt(topic, sources, fixes = '') {
    return `You write narration for "The Unknown Archive", a YouTube channel of fascinating true stories told as calm, clear animated explainers. Write the full script for this video.
Topic: ${topic.topic}
Angle: ${topic.angle || ''}
Series: ${topic.tag || 'Wildcard'}

STRICT RULES
- Use ONLY facts found in the SOURCES below. If the sources do not say it, do not say it. No invented numbers, dates, names or quotes.
- Tell it as a STORY in your own words, the way a thoughtful person explains something fascinating to a friend: curiosity first, then answers. Never copy or lightly reword sentences from the sources, and do not follow their order of sentences. Choose the 24-36 most interesting facts; leave out catalogue detail (model numbers, long lists, minor dates).
- Help the listener picture things: compare sizes and speeds to familiar things only when the comparison is simple arithmetic on source facts; otherwise do not compare.
- Separate clearly, in the wording itself, what is known, what experts believe, and what is speculation or legend.
- 1600 to 1900 spoken words in total (about 10 to 12 minutes of narration). Short, clear sentences for a calm narrator; vary their length. Plain English; explain any technical term in a few words.
- "title": a specific, curiosity-driven title under 90 characters that makes a stranger need to click, while staying 100% true to the content. Name the real subject and hint at the intrigue, surprise, stakes or scale. Prefer concrete specifics over vague words. Good: "The Colony That Vanished Without a Trace: Roanoke"; "What's Really at the Edge of the Universe?". Avoid: ALL CAPS, "you won't believe", "#1", fake urgency, and flat titles like "The History of Glass".
- "hook": 2-3 short paragraphs that win the first 30 seconds. Start COLD with ONE vivid concrete image, one stunning true fact, or one real unanswered question — a single sentence under 20 words that opens a loop the listener needs closed. No throat-clearing, no greeting, no "today", no "this video", no "we will cover". Then, in a sentence or two, promise what they will discover and why it matters, raising the stakes so they cannot look away.
- Then 9 to 12 sections, each with a short title (2-5 words) and 2-4 short paragraphs. End most sections with a sentence that makes the listener want the next part. Choose a structure that suits THIS story (timeline, question and answer, three key moments, myth versus record...), not a fixed template.
- "closing": 1-2 paragraphs that sum up honestly and leave one thought to remember.
- No greetings, no "in this video we will", no "smash that like button", no hype, no clickbait. No gore or graphic detail. Respect real people. No medical or financial advice.
- Write numbers as digits (for example 1912, 3.8, 32,000).
- "cta": one calm sentence inviting the viewer to subscribe.
- "claims": 12 to 18 of the most important checkable facts you used, each a full sentence in your own words containing the exact numbers and names, with "sources" (keys such as "W1") and "risk": "high" for dates, numbers, causes and anything about real people, otherwise "standard".
- "keywords": 6 to 8 search phrases.
${fixes}
Return ONLY JSON: {"title":"curiosity-driven, honest title under 90 characters","hook":["..."],"sections":[{"title":"...","paragraphs":["..."]}],"closing":["..."],"cta":"...","claims":[{"text":"...","sources":["W1"],"risk":"standard"}],"keywords":["..."]}

SOURCES
${sources.map(source => `[${source.key}] ${source.title} (Wikipedia) ${source.url}\n${source.text}`).join('\n\n---\n\n')}`;
  }

  parse(raw) {
    const match = String(raw || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('script response was not JSON');
    const data = JSON.parse(match[0]);
    const paragraphs = list => (Array.isArray(list) ? list : [list]).map(p => String(p || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const script = {
      title: String(data.title || '').replace(/\s+/g, ' ').trim().slice(0, 95),
      hook: paragraphs(data.hook),
      sections: (data.sections || []).map(section => ({ title: String(section.title || '').replace(/[[\]*]/g, '').trim().slice(0, 60), paragraphs: paragraphs(section.paragraphs) }))
        .filter(section => section.title && section.paragraphs.length),
      closing: paragraphs(data.closing),
      cta: String(data.cta || '').replace(/\s+/g, ' ').trim(),
      claims: (data.claims || []).map(claim => ({
        text: String(claim.text || '').replace(/\|/g, ',').replace(/\s+/g, ' ').trim(),
        sources: (Array.isArray(claim.sources) ? claim.sources : [claim.sources]).map(key => String(key || '').replace(/[^A-Za-z0-9]/g, '')).filter(Boolean),
        risk: /high/i.test(claim.risk) ? 'high' : 'standard'
      })).filter(claim => claim.text.length > 15),
      keywords: (data.keywords || []).map(k => String(k).trim()).filter(Boolean).slice(0, 8)
    };
    if (!script.title || !script.hook.length || script.sections.length < 4 || !script.closing.length || !script.cta) throw new Error('script is missing required parts');
    return script;
  }

  narration(script) {
    return [...script.hook, ...script.sections.flatMap(section => section.paragraphs), ...script.closing].join(' ');
  }

  // Claims and spoken numbers that the sources do not support.
  verify(script, sources) {
    const byKey = new Map(sources.map(source => [source.key, source]));
    const all = sources.map(source => source.norm).join(' ');
    const claims = script.claims.map(claim => ({ ...claim, check: checkClaim(claim, byKey) }));
    const unknownNumbers = numbersIn(this.narration(script)).filter(number => !sourceHasNumber(all, number));
    const narration = this.narration(script);
    const words = narration.split(/\s+/).length;
    const copied = copiedShare(narration, all);
    const banned = (narration.match(/\b(this video|in this video|we will cover|smash|don't forget to like)\b/gi) || []);
    return { claims, unknownNumbers, words, copied, banned, failedClaims: claims.filter(claim => !claim.check.ok) };
  }

  async write(topic) {
    if (!this.aiText?.isAvailable?.()) throw new Error('AI text provider is required to write scripts');
    progress.update('video', { step: 'script', fraction: 0.05, detail: 'Reading the sources' });
    const sources = await this.research(topic);
    let script = null;
    let report = null;
    let fixes = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      progress.update('video', { step: 'script', fraction: 0.15 + 0.28 * (attempt - 1), detail: attempt === 1 ? 'Writing the script' : `Improving the script (draft ${attempt} of 3)` });
      const raw = await generateTextWithRetry(this.aiText, this.prompt(topic, sources, fixes), { maxTokens: 7000, temperature: attempt === 1 ? 0.6 : 0.4, logger: this.logger });
      let candidate;
      try {
        candidate = this.parse(raw);
      } catch (error) {
        this.logger.warn(`Script attempt ${attempt} unusable: ${error.message}`);
        fixes = '\nYour previous answer was not valid JSON in the required shape. Return the complete JSON object only.';
        continue;
      }
      const check = this.verify(candidate, sources);
      const score = c => c.failedClaims.length * 3 + c.unknownNumbers.length * 3 + (c.copied > 0.08 ? 4 : 0) + c.banned.length + (c.words < 900 ? 2 : 0);
      const better = !report || score(check) < score(report);
      if (better) { script = candidate; report = check; }
      const problems = [];
      if (check.words < 900) problems.push(`The script had only ${check.words} words; write 950 to 1150 by telling the story more fully, not by adding minor detail.`);
      if (check.copied > 0.08) problems.push(`About ${Math.round(check.copied * 100)}% of the wording was copied from the sources. Rewrite every sentence in your own words and your own order.`);
      if (check.banned.length) problems.push(`Remove these phrases: ${[...new Set(check.banned.map(b => b.toLowerCase()))].join(', ')}.`);
      if (check.words > 1300) problems.push(`The script had ${check.words} words; cut it to 950-1150.`);
      if (check.unknownNumbers.length) problems.push(`These numbers are not in the sources, remove or correct them: ${check.unknownNumbers.join(', ')}.`);
      if (check.failedClaims.length) problems.push(`These claims are not supported by the cited source, fix or remove them and the matching narration: ${check.failedClaims.map(c => `"${c.text}"`).join(' ')}`);
      if (!problems.length) break;
      this.logger.info(`Script attempt ${attempt}: ${check.words} words, ${check.failedClaims.length} unsupported claim(s), ${check.unknownNumbers.length} unknown number(s), ${Math.round(check.copied * 100)}% copied wording`);
      fixes = `\nFIX THESE PROBLEMS FROM YOUR PREVIOUS DRAFT:\n- ${problems.join('\n- ')}`;
    }
    if (!script) throw new Error('The AI did not return a usable script');
    if (report.words < 600) throw new Error(`Script too short (${report.words} words)`);
    return { script, sources, report, markdown: this.toMarkdown(topic, script, sources, report) };
  }

  // Same format as the hand-written approved scripts (see scripts/import-approved-script.js).
  toMarkdown(topic, script, sources, report) {
    const escape = text => String(text).replace(/\|/g, ',');
    const lines = [
      `# ${script.title}`,
      '',
      `Series: ${topic.tag || 'Wildcard'}. Written automatically on ${new Date().toISOString().slice(0, 10)} from the sources below; ${report.words} words. Review before publishing.`,
      '',
      '## Script',
      '',
      '**\\[Hook\\]**',
      '',
      ...script.hook.flatMap(p => [p, '']),
      ...script.sections.flatMap(section => [`**\\[${section.title}\\]**`, '', ...section.paragraphs.flatMap(p => [p, ''])]),
      '**\\[Closing\\]**',
      '',
      ...script.closing.flatMap(p => [p, '']),
      script.cta,
      '',
      '## Fact-check report (automatic)',
      '',
      '| # | Claim | Status | Sources | Risk |',
      '|---|---|---|---|---|',
      ...report.claims.map((claim, i) => `| ${i + 1} | ${escape(claim.text)} | ${claim.check.ok ? 'Matches the source text' : `NEEDS YOUR CHECK: ${escape(claim.check.reason)}`} | ${claim.sources.filter(key => sources.some(source => source.key === key)).join(', ') || 'W1'} | ${claim.check.ok ? claim.risk : 'high'} |`),
      '',
      report.unknownNumbers.length
        ? `Numbers spoken in the script that were NOT found in the sources (check these): ${report.unknownNumbers.join(', ')}.`
        : 'Every number spoken in the script was found in the sources.',
      `Wording copied from the sources: ${Math.round(report.copied * 100)}% (limit 8%).`,
      '',
      '## Sources',
      '',
      ...sources.map(source => `- [${source.key}] ${source.title} (Wikipedia): ${source.url}`),
      ''
    ];
    return lines.join('\n');
  }
}

module.exports = { DocumentaryScriptWriter, checkClaim, numbersIn, copiedShare, slugify };
