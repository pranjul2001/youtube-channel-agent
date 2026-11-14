// Motion-documentary renderer: visuals that change with the narration, sentence by sentence.
//
// Narration sentences (with real timings) are grouped into beats of a few seconds. A visual
// director (AI text, with a deterministic fallback) picks one visual per beat:
//   stock    real stock footage (Pixabay/Pexels), graded to one look
//   archive  a public-domain / CC BY image (Wikimedia Commons) or NASA image, with slow
//            Ken Burns motion
//   map      an animated locator map (Natural Earth outlines) zooming to the place
//   card     a date / figure / name card
// plus chapter title cards and small on-screen labels. On-screen words must come from the
// narration itself (channel bible: honest, no invented facts). Everything here is free.
const crypto = require('crypto');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');
const { toASS } = require('./narration-timing');
const { Logger } = require('./logger');
const { generateTextWithRetry } = require('./ai-retry');

const W = 1920;
const H = 1080;
const FPS = 30;
const USER_AGENT = 'CuriousFilesDocumentaryRenderer/1.0 (local video tool)';
const ACCENT = '#e2b35e';

const mentions = (text, words) => !words?.length || words.some(word => String(text || '').toLowerCase().includes(word.toLowerCase()));
const xml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripHtml = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------------------
// Planning

// Group timed sentences into beats of roughly `target` seconds, never crossing a section.
function groupBeats(sentences, totalDuration, options = {}) {
  const target = options.target || 6.5;
  const max = options.max || 10;
  const min = options.min || 3;
  const beats = [];
  let current = null;
  for (const sentence of sentences) {
    const newSection = !current || sentence.label !== current.label;
    const length = current ? current.end - current.start : 0;
    const wouldBe = current ? sentence.end - current.start : 0;
    if (newSection || length >= target || (wouldBe > max && length >= min)) {
      current = { label: sentence.label, sectionStart: newSection, sentences: [], start: sentence.start, end: sentence.end };
      beats.push(current);
    }
    current.sentences.push(sentence);
    current.end = sentence.end;
  }
  // Cover the whole timeline: each beat runs until the next one starts.
  beats.forEach((beat, i) => {
    beat.start = i === 0 ? 0 : beat.start;
    beat.end = i < beats.length - 1 ? beats[i + 1].start : Math.max(beat.end, Number(totalDuration) || beat.end);
    beat.text = beat.sentences.map(s => s.text).join(' ');
  });
  // A very long beat (one long sentence) is split so the picture keeps moving.
  const out = [];
  for (const beat of beats) {
    const length = beat.end - beat.start;
    if (length > max * 1.4) {
      const parts = Math.ceil(length / target);
      for (let p = 0; p < parts; p++) {
        out.push({ ...beat, sectionStart: beat.sectionStart && p === 0, continued: p > 0,
          start: beat.start + (length * p) / parts, end: beat.start + (length * (p + 1)) / parts });
      }
    } else out.push(beat);
  }
  return out.map((beat, index) => ({ ...beat, index }));
}

const STOP = new Set(('the a an and or of to in on at for with by from as is was were be been it its this that these those ' +
  'there their they them he she his her we you our your not no but so if then than into over about after before ' +
  'what which who why how when where while').split(' '));

// True when every number in `text` appears in `source` and most of its words do too, so a card
// or label can only repeat what the narration says.
function isGrounded(text, source) {
  const clean = value => String(value || '').toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const src = clean(source);
  const srcWords = new Set(src.split(/\s+/).filter(Boolean));
  const numbers = clean(text).match(/\d+/g) || [];
  if (numbers.some(n => !new RegExp(`(^|\\D)${n}(\\D|$)`).test(src.replace(/(\d),(\d)/g, '$1$2')))) return false;
  const words = clean(text).split(/\s+/).filter(word => word && !STOP.has(word) && !/^\d+$/.test(word));
  if (!words.length) return numbers.length > 0;
  const hits = words.filter(word => srcWords.has(word) || [...srcWords].some(s => s.length >= 5 && word.length >= 5 && s.slice(0, 5) === word.slice(0, 5)));
  return hits.length / words.length >= 0.75;
}

// Stock and archive searches must not return people (channel bible: nothing that could read as
// a real victim or a recreation of a real person).
const PEOPLE = /\b(portraits?|persons?|people|man|men|woman|women|faces?|child(ren)?|kids?|boys?|girls?|crowds?|famil(y|ies)|keepers?|sailors?|fisherm[ae]n|workers?|soldiers?|wearing|shirts?|sleeves?|selfies?|hands?|astronauts?|scientists?|portrait)\b/i;
// Stock tags that never fit this channel's documentaries (people, food, tropical holidays).
const OFF_TOPIC_TAGS = /\b(people|person|man|men|woman|women|girl|boy|child|children|kid|baby|family|couple|face|portrait|selfie|hands?|food|cooking|kitchen|chef|restaurant|palm|palms|tropical|tropic|resort|holiday|vacation|bikini|party|wedding|business|office|smartphone|laptop)\b/i;
const GENERIC_CAPS = new Set(['The', 'A', 'An', 'Old', 'Vintage', 'Historic', 'Historical', 'Photo', 'Image']);

// Proper-noun words an archive image's title must contain, so a search for "Hesperus ship"
// never returns some other ship from another country.
function subjectWords(query) {
  return String(query || '').split(/\s+/).filter(word => /^[A-Z][\p{L}'-]{2,}$/u.test(word) && !GENERIC_CAPS.has(word));
}

function keywordQuery(text, fallback = 'dramatic sky clouds') {
  const words = String(text).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w).join(' ') || fallback;
}

// Enforce variety and honesty on a raw plan: grounded text only, limited maps, no repeats.
function sanitizePlan(beats, raw = {}, options = {}) {
  const items = Array.isArray(raw.beats) ? raw.beats : Array.isArray(raw) ? raw : [];
  const byIndex = new Map(items.map(item => [Number(item.i ?? item.index), item]));
  const maxMaps = Math.max(1, Math.round(beats.length / 25));
  let maps = 0;
  const placesMapped = new Set();
  const plan = [];
  for (const beat of beats) {
    const item = byIndex.get(beat.index + 1) || byIndex.get(beat.index) || {};
    let type = ['stock', 'archive', 'map', 'card'].includes(item.type) ? item.type : 'stock';
    const previous = plan[plan.length - 1];
    const entry = {
      type,
      query: String(item.query || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60),
      source: item.source === 'nasa' ? 'nasa' : 'commons',
      place: String(item.place || '').trim().slice(0, 80),
      kicker: String(item.kicker || '').trim().slice(0, 40),
      headline: String(item.headline || '').trim().slice(0, 70),
      label: String(item.label || '').trim().slice(0, 48)
    };
    if (type === 'card' && (!entry.headline || !isGrounded(`${entry.kicker} ${entry.headline}`, beat.text) || previous?.type === 'card' || beat.continued)) type = 'stock';
    if (type === 'map') {
      const key = entry.place.toLowerCase();
      if (!entry.place || maps >= maxMaps || placesMapped.has(key) || !isGrounded(entry.place, beat.text) || beat.end - beat.start < 4) type = 'stock';
      else { maps += 1; placesMapped.add(key); }
    }
    if (type === 'archive') {
      entry.subject = subjectWords(entry.query);
      if (!entry.query || !entry.subject.length || PEOPLE.test(entry.query)) type = 'stock';
    }
    if (PEOPLE.test(entry.query)) entry.query = '';
    if (entry.label && !isGrounded(entry.label, beat.text)) entry.label = '';
    if (!entry.query) entry.query = options.fallbackQuery || keywordQuery(beat.text);
    plan.push({ ...entry, type });
  }
  // Dates spoken in the narration become date cards when the AI suggested few cards: a
  // reliable, honest anchor for the viewer ("December 26, 1900").
  const MONTH = '(January|February|March|April|May|June|July|August|September|October|November|December)';
  const DATE = new RegExp(`\\b(${MONTH} \\d{1,2}(st|nd|rd|th)?,? \\d{4}|\\d{1,2} ${MONTH},? \\d{4}|${MONTH} \\d{4})\\b`);
  const wanted = Math.max(1, Math.floor(beats.length / 10));
  let cards = plan.filter(p => p.type === 'card').length;
  let lastCard = -10;
  plan.forEach((p, i) => { if (p.type === 'card') lastCard = i; });
  for (const [i, beat] of beats.entries()) {
    if (cards >= wanted) break;
    const date = (beat.text.match(DATE) || [])[0];
    const nearCard = plan.slice(Math.max(0, i - 3), i + 4).some(p => p.type === 'card');
    if (!date || nearCard || beat.continued || plan[i].type === 'map' || i === 0) continue;
    plan[i] = { ...plan[i], type: 'card', kicker: beat.label, headline: date.replace(/(\d)(st|nd|rd|th)/, '$1') };
    cards += 1;
    lastCard = i;
  }
  return plan;
}

// ---------------------------------------------------------------------------------------
// Pictures (SVG rendered with sharp; system fonts)

function wrapWords(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > maxChars) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

const GRAIN = `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.07"/></feComponentTransfer></filter>`;

// Full-screen title/date/figure card at 2x resolution (it slowly zooms).
function cardSvg({ kicker = '', headline = '', footnote = '' }, scale = 2) {
  const w = W * scale;
  const h = H * scale;
  const lines = wrapWords(headline, headline.length > 40 ? 26 : 22).slice(0, 3);
  const size = (lines.length > 2 ? 92 : 112) * scale;
  const lineHeight = size * 1.16;
  const blockTop = h / 2 - ((lines.length - 1) * lineHeight) / 2 + size * 0.32;
  const kickerY = blockTop - size - 70 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<defs><radialGradient id="bg" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#1b2630"/><stop offset="1" stop-color="#080c10"/></radialGradient>${GRAIN}</defs>
<rect width="100%" height="100%" fill="url(#bg)"/><rect width="100%" height="100%" filter="url(#grain)"/>
${kicker ? `<text x="${w / 2}" y="${kickerY}" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial" font-weight="bold" font-size="${34 * scale}" letter-spacing="${9 * scale}" fill="${ACCENT}">${xml(kicker.toUpperCase())}</text>
<rect x="${w / 2 - 60 * scale}" y="${kickerY + 30 * scale}" width="${120 * scale}" height="${3 * scale}" fill="${ACCENT}"/>` : ''}
${lines.map((line, i) => `<text x="${w / 2}" y="${blockTop + i * lineHeight}" text-anchor="middle" font-family="Georgia, Times New Roman, serif" font-size="${size}" fill="#f4efe6">${xml(line)}</text>`).join('\n')}
${footnote ? `<text x="${w / 2}" y="${h - 90 * scale}" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial" font-size="${24 * scale}" fill="#9aa5ad">${xml(footnote)}</text>` : ''}
</svg>`;
}

// Transparent 1080p overlay: small label at the top left (place, date, "Artist's concept").
function labelSvg(text) {
  const size = 36;
  const width = Math.min(W - 160, Math.round(text.length * size * 0.56) + 70);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect x="80" y="72" width="${width}" height="${size + 40}" rx="6" fill="#000" fill-opacity="0.5"/>
<rect x="80" y="72" width="6" height="${size + 40}" fill="${ACCENT}"/>
<text x="112" y="${72 + size + 10}" font-family="Helvetica Neue, Helvetica, Arial" font-weight="bold" font-size="${size}" fill="#ffffff">${xml(text)}</text>
</svg>`;
}

// Label beside the centered map pin (fades in while the map zooms).
function mapLabelSvg(name, detail = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><filter id="s"><feGaussianBlur stdDeviation="4"/></filter></defs>
<g transform="translate(${W / 2 + 46}, ${H / 2 - 18})">
<text x="2" y="4" font-family="Georgia, serif" font-size="58" fill="#000" fill-opacity="0.7" filter="url(#s)">${xml(name)}</text>
<text x="0" y="0" font-family="Georgia, serif" font-size="58" fill="#ffffff">${xml(name)}</text>
${detail ? `<text x="2" y="52" font-family="Helvetica Neue, Helvetica, Arial" font-weight="bold" font-size="26" letter-spacing="5" fill="${ACCENT}">${xml(detail.toUpperCase())}</text>` : ''}
</g></svg>`;
}

let mapData = null;
function loadMapData() {
  if (mapData) return mapData;
  const { feature, mesh } = require('topojson-client');
  const land = JSON.parse(fsSync.readFileSync(require.resolve('world-atlas/land-50m.json'), 'utf8'));
  const countries = JSON.parse(fsSync.readFileSync(require.resolve('world-atlas/countries-50m.json'), 'utf8'));
  mapData = {
    land: feature(land, land.objects.land),
    borders: mesh(countries, countries.objects.countries, (a, b) => a !== b)
  };
  return mapData;
}

// Locator map centered on (lat, lon) at 2x resolution; local equirectangular projection.
function mapSvg({ lat, lon, spanLat = 16 }, scale = 2) {
  const w = W * scale;
  const h = H * scale;
  const k = h / spanLat;
  const cos = Math.cos((lat * Math.PI) / 180);
  const project = ([x, y]) => [w / 2 + (x - lon) * cos * k, h / 2 - (y - lat) * k];
  const inView = points => points.some(([x, y]) => x > -w * 0.2 && x < w * 1.2 && y > -h * 0.2 && y < h * 1.2);
  // Unwrap longitudes so a polygon crossing the date line does not draw an edge across the map.
  const unwrap = ring => {
    let shift = 0;
    const out = ring.map(([x, y], i) => {
      if (i > 0) {
        const previous = ring[i - 1][0] + shift;
        while (x + shift - previous > 180) shift -= 360;
        while (x + shift - previous < -180) shift += 360;
      }
      return [x + shift, y];
    });
    // Then move the whole outline by whole turns so most of it sits near the map centre.
    let best = 0;
    let bestCount = -1;
    for (const turn of [-720, -360, 0, 360, 720]) {
      const count = out.reduce((n, [x]) => n + (Math.abs(x + turn - lon) < 90 ? 1 : 0), 0);
      if (count > bestCount) { best = turn; bestCount = count; }
    }
    return best ? out.map(([x, y]) => [x + best, y]) : out;
  };
  const ringPath = ring => {
    const pts = unwrap(ring).map(project);
    if (!inView(pts)) return '';
    let d = '';
    let last = null;
    for (const [x, y] of pts) {
      if (last && Math.abs(x - last[0]) < 1.2 && Math.abs(y - last[1]) < 1.2) continue;
      d += `${d ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      last = [x, y];
    }
    return d ? `${d}Z` : '';
  };
  const { land, borders } = loadMapData();
  let landPath = '';
  for (const f of land.features || [land]) {
    const g = f.geometry || f;
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates || [];
    for (const polygon of polygons) for (const ring of polygon) landPath += ringPath(ring);
  }
  let borderPath = '';
  for (const line of borders.coordinates || []) {
    const pts = unwrap(line).map(project);
    if (!inView(pts)) continue;
    borderPath += pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  }
  let graticule = '';
  for (let g = Math.floor((lon - 90) / 5) * 5; g <= lon + 90; g += 5) {
    const [x] = project([g, lat]);
    if (x >= 0 && x <= w) graticule += `M${x.toFixed(1)} 0V${h}`;
  }
  for (let g = Math.floor((lat - 45) / 5) * 5; g <= lat + 45; g += 5) {
    const [, y] = project([lon, g]);
    if (y >= 0 && y <= h) graticule += `M0 ${y.toFixed(1)}H${w}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<defs><radialGradient id="sea" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="#16293a"/><stop offset="1" stop-color="#0a131c"/></radialGradient>
<radialGradient id="vig" cx="50%" cy="50%" r="72%"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></radialGradient>${GRAIN}</defs>
<rect width="100%" height="100%" fill="url(#sea)"/>
<path d="${graticule}" stroke="#23394b" stroke-width="${1.2 * scale}" fill="none"/>
<path d="${landPath}" fill="#34443b" stroke="#9fb0a2" stroke-width="${1.4 * scale}" stroke-linejoin="round" fill-rule="evenodd"/>
<path d="${borderPath}" stroke="#738578" stroke-width="${1 * scale}" stroke-dasharray="${5 * scale} ${4 * scale}" fill="none"/>
<circle cx="${w / 2}" cy="${h / 2}" r="${15 * scale}" fill="none" stroke="${ACCENT}" stroke-width="${2.5 * scale}" stroke-opacity="0.55"/>
<circle cx="${w / 2}" cy="${h / 2}" r="${6 * scale}" fill="${ACCENT}"/>
<rect width="100%" height="100%" fill="url(#vig)"/><rect width="100%" height="100%" filter="url(#grain)"/>
</svg>`;
}

// ---------------------------------------------------------------------------------------
// Renderer

class DocumentaryRenderer {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('Documentary');
    this.aiText = options.aiText || null;
    this.mediaGeneration = options.mediaGeneration || null;
    this.http = options.http || axios;
    this.cacheDir = options.cacheDir || path.join(__dirname, '..', 'data', 'media-cache');
    this.lastGeocodeAt = 0;
  }

  async direct(beats, script = {}, settings = {}) {
    const fallbackQuery = settings.fallbackQuery || 'dramatic sky clouds';
    if (!this.aiText?.isAvailable?.()) return sanitizePlan(beats, {}, { fallbackQuery });
    const prompt = `You are the picture editor of a calm, factual documentary titled "${script.title || ''}".
For each numbered beat of narration choose ONE visual. Types:
- "stock": generic stock footage. Give "query": 2-4 plain words a stock video library would match (places, landscapes, weather, sea, sky, space, objects, documents). Never identifiable people, faces, children, brands, gore, modern objects that break the period, or anything a viewer could mistake for real footage of the actual event.${settings.mood ? ` Fit this visual mood: ${settings.mood}.` : ''}
- "archive": a real photograph that likely exists in a free archive, of a NAMED real place, building, ship, spacecraft, telescope, instrument, document or object in this beat. Give "query": 2-5 words including the proper name, and "source": "nasa" for space subjects, otherwise "commons". Never photos of people, victims or bodies.
- "map": only the FIRST time the narration introduces a real geographic place. Give "place": the place name as written in the narration, geocodable. At most one map per 25 beats.
- "card": a key date, number, measurement or very short phrase that the narration states in this beat. Give "kicker" (1-4 words) and "headline" (at most 7 words). Copy words and numbers from the narration exactly; never add facts. About one beat in seven; never two cards in a row.
Optionally give "label" (at most 5 words copied from the narration: a place or date) for stock or archive beats where it helps the viewer.
Vary the types; avoid more than three of the same type in a row. Aim for roughly 45% stock, 30% archive, 15% card.
Return ONLY JSON: {"fallback":"2-3 word stock query that fits the whole video","beats":[{"i":1,"type":"stock","query":"..."}, ...]} with one entry per beat.

${beats.map(beat => `${beat.index + 1}. [${beat.label}] ${beat.text.slice(0, 320)}`).join('\n')}`;
    try {
      const raw = await generateTextWithRetry(this.aiText, prompt, { maxTokens: 6000, temperature: 0.4, logger: this.logger, triesPerModel: 2 });
      const match = String(raw || '').match(/\{[\s\S]*\}/);
      const parsed = match ? JSON.parse(match[0]) : {};
      const fallback = String(parsed.fallback || '').replace(/[^\p{L}\s]/gu, ' ').trim() || fallbackQuery;
      return sanitizePlan(beats, parsed, { fallbackQuery: fallback }).map(entry => ({ ...entry, fallback }));
    } catch (error) {
      this.logger.warn(`Visual direction failed; using stock footage throughout: ${error.message}`);
      return sanitizePlan(beats, {}, { fallbackQuery });
    }
  }

  async render({ productionId, script = {}, timing, audioPath, outputPath, settings = {} }) {
    const total = await getMediaDuration(audioPath);
    const beats = groupBeats(timing.sentences, total);
    const plan = await this.direct(beats, script, settings);
    const workDir = path.join(path.dirname(outputPath), `${productionId || 'render'}_documentary`);
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(this.cacheDir, { recursive: true });
    this.logger.info(`Documentary plan: ${beats.length} beats (${['stock', 'archive', 'map', 'card'].map(t => `${plan.filter(p => p.type === t).length} ${t}`).join(', ')})`);

    // Segment list (chapter cards carve their time from the start of a section's first beat).
    const segments = [];
    const sectionLabels = [...new Set(beats.map(b => b.label))];
    const titleShort = String(script.title || '').split(/[:—–]/)[0].trim();
    for (const [i, beat] of beats.entries()) {
      let start = beat.start;
      const sectionNumber = sectionLabels.indexOf(beat.label);
      const isChapter = beat.sectionStart && sectionNumber > 0 && !/^(conclusion|closing)$/i.test(beat.label) && beat.end - beat.start >= 5;
      if (isChapter) {
        const cardEnd = start + Math.min(3, (beat.end - beat.start) / 2);
        const first = sectionNumber === 1 && titleShort;
        segments.push({ kind: 'card', start, end: cardEnd, label: beat.label, beat: i, chapter: true,
          card: first ? { kicker: settings.channelName || 'Curious Files', headline: titleShort } : { kicker: `Part ${sectionNumber}`, headline: beat.label } });
        start = cardEnd;
      }
      // A card is read in a few seconds; longer beats continue on footage.
      if (plan[i].type === 'card' && beat.end - start > 7) {
        segments.push({ kind: 'card', start, end: start + 5, label: beat.label, beat: i, text: beat.text, plan: plan[i] });
        segments.push({ kind: 'stock', start: start + 5, end: beat.end, label: beat.label, beat: i, text: beat.text, plan: { ...plan[i], type: 'stock', query: plan[i].fallback || '' } });
      } else {
        segments.push({ kind: plan[i].type, start, end: beat.end, label: beat.label, beat: i, text: beat.text, plan: plan[i] });
      }
    }

    // Acquire assets (network) with fallbacks, then render each segment.
    const stock = await this.stockContext(settings);
    const credits = [];
    const addCredit = credit => {
      if (credit && !credits.some(c => c.source === credit.source && (c.videoId || c.pageUrl) === (credit.videoId || credit.pageUrl))) credits.push(credit);
    };
    const scenes = [];
    const parts = [];
    let frameCursor = 0;
    for (const [n, segment] of segments.entries()) {
      const endFrame = Math.round(segment.end * FPS);
      const frames = Math.max(1, endFrame - frameCursor);
      frameCursor = endFrame;
      const out = path.join(workDir, `seg_${String(n).padStart(4, '0')}.mp4`);
      const result = await this.renderSegment(segment, out, frames, { stock, addCredit, plan, workDir, n, settings });
      parts.push(out);
      scenes.push({
        index: n, label: segment.label, prompt: result.prompt || segment.plan?.query || segment.card?.headline || segment.kind,
        duration: Number((frames / FPS).toFixed(3)), path: result.assetPath || out, provider: 'documentary',
        model: result.kind, taskId: result.taskId || `documentary:${result.kind}:${n}`, attribution: result.attribution || null
      });
      this.logger.info(`Segment ${n + 1}/${segments.length} ${result.kind} (${(frames / FPS).toFixed(1)}s)`);
    }

    // Join the segments, burn in subtitles and add the narration.
    const listPath = path.join(workDir, 'segments.txt');
    await fs.writeFile(listPath, parts.map(p => `file '${p}'`).join('\n'));
    const visualPath = path.join(workDir, 'visual.mp4');
    await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', visualPath]);
    const vf = [];
    if (settings.burnSubtitles !== false && timing.cues?.length) {
      const assPath = path.join(workDir, 'subtitles.ass');
      await fs.writeFile(assPath, toASS(timing.cues, { font: settings.subtitleFont || 'Arial' }));
      // macOS system fonts, or Liberation (Arial-compatible) on a Linux server.
      const fontsDir = settings.fontsDir || process.env.SUBTITLE_FONTS_DIR ||
        ['/System/Library/Fonts/Supplemental', '/usr/share/fonts/truetype/liberation', '/usr/share/fonts/truetype/dejavu', '/usr/share/fonts'].find(dir => fsSync.existsSync(dir));
      const esc = value => value.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      vf.push(`subtitles='${esc(assPath)}'${fontsDir ? `:fontsdir='${esc(fontsDir)}'` : ''}`);
    }
    const maxBytes = String(Number(process.env.FFMPEG_MAX_OUTPUT_BYTES) || 8 * 1024 * 1024 * 1024);
    await runFFmpeg(['-y', '-i', visualPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0',
      ...(vf.length ? ['-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy']),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', total.toFixed(3), '-movflags', '+faststart', '-fs', maxBytes, outputPath]);
    if (settings.keepWork !== true) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

    const counts = scenes.reduce((acc, s) => ({ ...acc, [s.model]: (acc[s.model] || 0) + 1 }), {});
    return { path: outputPath, scenes, credits, counts, stockSeconds: scenes.filter(s => s.model === 'stock').reduce((a, s) => a + s.duration, 0) };
  }

  async stockContext(settings) {
    const service = this.mediaGeneration;
    if (!service) return null;
    const stored = await service.settings();
    let provider = null;
    try {
      provider = service.registry.select(stored.provider, stored.order, {});
    } catch (_error) { provider = null; }
    if (!provider?.capabilities?.stock) return null;
    return { provider, blocked: stored.stockBlocklist || new Set(), used: new Set(), targetWidth: 1920, service, fallback: [] };
  }

  async renderSegment(segment, out, frames, ctx) {
    const seconds = frames / FPS;
    const plan = segment.plan || {};
    if (segment.kind === 'card') {
      const card = segment.card || { kicker: plan.kicker, headline: plan.headline };
      const png = path.join(ctx.workDir, `card_${ctx.n}.png`);
      await sharp(Buffer.from(cardSvg(card))).png().toFile(png);
      await this.encodeStill(png, out, frames, { motion: 'slowIn' });
      return { kind: segment.chapter ? 'chapter' : 'card', prompt: `${card.kicker}: ${card.headline}` };
    }
    if (segment.kind === 'map') {
      try {
        const place = await this.geocode(plan.place);
        if (!place) throw new Error(`could not locate "${plan.place}"`);
        const png = path.join(ctx.workDir, `map_${ctx.n}.png`);
        const label = path.join(ctx.workDir, `maplabel_${ctx.n}.png`);
        await sharp(Buffer.from(mapSvg({ lat: place.lat, lon: place.lon }))).png().toFile(png);
        await sharp(Buffer.from(mapLabelSvg(plan.place, place.region))).png().toFile(label);
        await this.encodeStill(png, out, frames, { motion: 'mapZoom', overlay: label, overlayFrom: seconds * 0.45 });
        ctx.addCredit({ kind: 'data', source: 'Natural Earth', title: 'Map outlines', license: 'public domain', pageUrl: 'https://www.naturalearthdata.com/' });
        ctx.addCredit({ kind: 'data', source: 'OpenStreetMap', title: 'Place location via Nominatim', license: 'ODbL', pageUrl: 'https://www.openstreetmap.org/copyright' });
        return { kind: 'map', prompt: plan.place };
      } catch (error) {
        this.logger.warn(`Map skipped (${error.message}); using footage`);
      }
    }
    if (segment.kind === 'archive') {
      try {
        const image = plan.source === 'nasa' ? await this.searchNasa(plan.query, { subject: plan.subject }) : await this.searchCommons(plan.query, { allowShareAlike: ctx.settings.allowShareAlike === true, subject: plan.subject });
        if (!image) throw new Error(`no free-licence image for "${plan.query}"`);
        const png = path.join(ctx.workDir, `still_${ctx.n}.png`);
        await this.composeStill(image.path, png);
        const label = image.label || plan.label;
        const overlay = label ? path.join(ctx.workDir, `label_${ctx.n}.png`) : null;
        if (overlay) await sharp(Buffer.from(labelSvg(label))).png().toFile(overlay);
        const motions = ['in', 'out', 'panRight', 'panLeft'];
        await this.encodeStill(png, out, frames, { motion: motions[ctx.n % motions.length], overlay, overlayFrom: 0.4, grade: true });
        ctx.addCredit(image.credit);
        return { kind: 'archive', prompt: plan.query, assetPath: image.path, attribution: image.credit, taskId: image.id };
      } catch (error) {
        this.logger.warn(`Archive image skipped (${error.message}); using footage`);
      }
    }
    // Stock footage (also the fallback for every other type).
    const clip = await this.stockClip(plan.query || plan.fallback, ctx, plan.fallback, segment.text);
    if (clip) {
      const overlay = plan.label ? path.join(ctx.workDir, `label_${ctx.n}.png`) : null;
      if (overlay) await sharp(Buffer.from(labelSvg(plan.label))).png().toFile(overlay);
      await this.encodeVideo(clip.path, out, frames, { overlay });
      ctx.addCredit(clip.credit);
      return { kind: 'stock', prompt: clip.query, assetPath: clip.path, attribution: clip.credit, taskId: clip.taskId };
    }
    // Nothing reachable: a quiet text card from the narration keeps the video going.
    const png = path.join(ctx.workDir, `card_${ctx.n}.png`);
    await sharp(Buffer.from(cardSvg({ kicker: segment.label, headline: '' }))).png().toFile(png);
    await this.encodeStill(png, out, frames, { motion: 'slowIn' });
    return { kind: 'card', prompt: segment.label };
  }

  async stockClip(query, ctx, fallback, beatText = '') {
    const stock = ctx.stock;
    if (!stock) return null;
    const { provider, blocked, used, service } = stock;
    let lastResort = null;
    for (const q of [query, fallback, 'dramatic sky clouds'].filter(Boolean)) {
      let found = [];
      // Slow or flaky connections: retry a failed search twice before moving on.
      let searchError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          found = await provider.search(q, { perPage: 15, targetWidth: stock.targetWidth });
          searchError = null;
          break;
        } catch (error) {
          searchError = error;
          await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
        }
      }
      if (searchError) {
        this.logger.warn(`Stock search "${q}" failed after 3 tries: ${searchError.message}`);
        continue;
      }
      // Cheap filter first: Pixabay's own flags and tags (people, food, tropical, AI-made).
      const acceptable = found.filter(item => !blocked.has(String(item.id)) && !item.isAiGenerated && !item.isLowQuality &&
        !OFF_TOPIC_TAGS.test(item.tags || ''));
      const fresh = acceptable.filter(item => !used.has(item.id));
      let candidates = (fresh.length ? fresh : acceptable).slice(0, 4);
      if (!candidates.length) continue;
      lastResort = lastResort || { q, candidates };
      // Then the picture check: the AI looks at each preview frame against this beat.
      const pick = await this.visionPick(candidates, beatText, ctx.settings?.mood);
      if (pick === -1) {
        this.logger.info(`No clip for "${q}" fits this beat; trying a broader search`);
        continue;
      }
      if (pick > 0) candidates = [candidates[pick], ...candidates.filter((_, i) => i !== pick)];
      const clip = await this.downloadFirst(candidates, provider, service, used, q);
      if (clip) return clip;
    }
    // Every search failed the picture check: use the best tag-filtered match rather than stop.
    return lastResort ? this.downloadFirst(lastResort.candidates, provider, service, used, lastResort.q) : null;
  }

  async downloadFirst(candidates, provider, service, used, q) {
    for (const candidate of candidates) {
      const outputPath = path.join(path.dirname(this.cacheDir), 'videos', 'stock-cache', `${provider.id}_${candidate.id}.mp4`);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      let ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        try {
          try { await fs.access(outputPath); } catch (_missing) { await provider.download(candidate, outputPath); }
          ok = await service.isValidVideo(outputPath);
          if (!ok) await fs.unlink(outputPath).catch(() => {});
        } catch (error) {
          this.logger.warn(`${provider.sourceName} clip ${candidate.id} download attempt ${attempt} failed: ${error.code || error.message}`);
        }
      }
      if (!ok) continue;
      used.add(candidate.id);
      return {
        path: outputPath, query: q, taskId: `${provider.id}:${candidate.id}`,
        credit: { source: provider.sourceName, videoId: candidate.id, videoUrl: candidate.pageUrl, photographer: candidate.photographer, photographerUrl: candidate.photographerUrl }
      };
    }
    return null;
  }

  // Returns the index of the best-fitting preview, -1 when none fit, or 0 when the check is
  // unavailable (no AI, no previews, quota). Free Gemini model; calls are spaced out.
  async visionPick(candidates, beatText, mood) {
    const gemini = this.aiText?.gemini;
    const withPreview = candidates.filter(c => c.previewUrl);
    if (!gemini || !beatText || withPreview.length !== candidates.length) return 0;
    try {
      const images = [];
      for (const candidate of candidates) {
        const response = await this.http.get(candidate.previewUrl, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': USER_AGENT } });
        const small = await sharp(Buffer.from(response.data)).resize(384, 216, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
        images.push({ inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } });
      }
      const wait = 4200 - (Date.now() - (this.lastVisionAt || 0));
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      this.lastVisionAt = Date.now();
      const prompt = `You pick B-roll for a calm, factual documentary. Narration at this moment: "${beatText.slice(0, 400)}"${mood ? `\nVisual mood of the whole video: ${mood}` : ''}
Images 1 to ${images.length} are preview frames of stock clips. Choose the one that best fits the narration and mood.
Reject an image if it shows people, faces or hands, readable text or logos, food or kitchens, or a place, season or era that contradicts the narration (for example palm trees or tropical sun for a cold northern sea, or a modern city for 1900).
Return ONLY JSON {"best": <number 1-${images.length}, or 0 if none fit>}.`;
      const response = await this.aiText.gemini.models.generateContent({
        model: this.aiText.model,
        contents: [{ role: 'user', parts: [{ text: prompt }, ...images] }]
      });
      const text = response.text || response.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      const best = Number((text.match(/"best"\s*:\s*(\d+)/) || [])[1]);
      if (!Number.isFinite(best)) return 0;
      return best === 0 ? -1 : Math.min(candidates.length, best) - 1;
    } catch (error) {
      this.logger.warn(`Clip picture check unavailable (${String(error.message).slice(0, 120)}); using the top match`);
      return 0;
    }
  }

  // ----- free image archives ---------------------------------------------------------------

  async cachedDownload(url, prefix) {
    const ext = /\.png($|\?)/i.test(url) ? '.png' : '.jpg';
    const file = path.join(this.cacheDir, `${prefix}_${crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)}${ext}`);
    try {
      await fs.access(file);
      return file;
    } catch (_missing) { /* download */ }
    let response;
    for (let attempt = 1; ; attempt++) {
      try {
        response = await this.http.get(url, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': USER_AGENT } });
        break;
      } catch (error) {
        if (error.response?.status !== 429 || attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 4000 * attempt));
      }
    }
    const meta = await sharp(Buffer.from(response.data)).metadata();
    if (!meta.width || meta.width < 900) throw new Error('image too small');
    await fs.writeFile(file, Buffer.from(response.data));
    return file;
  }

  // Wikimedia Commons: public domain, CC0 and CC BY only (share-alike only when the owner opts
  // in with archive_allow_share_alike; never non-commercial or no-derivatives), no
  // personality-rights restrictions, no people-centred titles.
  async searchCommons(query, options = {}) {
    const response = await this.http.get('https://commons.wikimedia.org/w/api.php', {
      timeout: 30000,
      headers: { 'User-Agent': USER_AGENT },
      params: {
        action: 'query', format: 'json', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: 6,
        gsrlimit: 15, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: 1920
      }
    });
    const pages = Object.values(response.data?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    const acceptable = pages.map(page => {
      const info = page.imageinfo?.[0] || {};
      const meta = info.extmetadata || {};
      const license = stripHtml(meta.LicenseShortName?.value);
      const normalized = license.toLowerCase().replace(/[-_]/g, ' ');
      const allowed = /^(public domain|pd\b|cc0|cc by \d|cc by sa \d)/.test(normalized) && !/\b(nc|nd)\b/.test(normalized) &&
        (options.allowShareAlike === true || !/\bsa\b/.test(normalized));
      return {
        page, info, license, allowed,
        restricted: Boolean(stripHtml(meta.Restrictions?.value)),
        author: stripHtml(meta.Artist?.value).slice(0, 80) || 'Unknown',
        title: page.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '')
      };
    }).filter(item => mentions(item.title, options.subject) && item.allowed && !item.restricted && /image\/(jpeg|png)/.test(item.info.mime || '') && item.info.width >= 1200 &&
      !/portrait|grave|funeral|corpse|body|victim|child|selfie|logo/i.test(item.title));
    acceptable.sort((a, b) => Number(b.info.width >= b.info.height * 1.15) - Number(a.info.width >= a.info.height * 1.15));
    for (const item of acceptable.slice(0, 3)) {
      try {
        const file = await this.cachedDownload(item.info.thumburl || item.info.url, 'commons');
        return {
          path: file, id: `commons:${item.page.pageid}`,
          credit: { kind: 'image', source: 'Wikimedia Commons', title: item.title, author: item.author, license: item.license, pageUrl: item.info.descriptionurl }
        };
      } catch (error) {
        this.logger.warn(`Commons image "${item.title}" unusable: ${error.message}`);
      }
    }
    return null;
  }

  // NASA Image and Video Library. Illustrations are labelled on screen as artist's concepts.
  async searchNasa(query, options = {}) {
    const response = await this.http.get('https://images-api.nasa.gov/search', {
      timeout: 30000, headers: { 'User-Agent': USER_AGENT }, params: { q: query, media_type: 'image' }
    });
    const items = (response.data?.collection?.items || []).map(item => ({ ...(item.data?.[0] || {}), href: item.href }))
      .filter(item => item.nasa_id && mentions(`${item.title} ${item.description || ''}`, options.subject) &&
        !/©|copyright|courtesy of (?!nasa)/i.test(`${item.description || ''} ${item.title || ''}`))
      .slice(0, 6);
    for (const item of items) {
      try {
        const asset = await this.http.get(`https://images-api.nasa.gov/asset/${encodeURIComponent(item.nasa_id)}`, { timeout: 30000, headers: { 'User-Agent': USER_AGENT } });
        const hrefs = (asset.data?.collection?.items || []).map(i => String(i.href).replace(/^http:/, 'https:'));
        const url = hrefs.find(h => /~large\.(jpg|png)$/i.test(h)) || hrefs.find(h => /~orig\.(jpg|png)$/i.test(h));
        if (!url) continue;
        const file = await this.cachedDownload(url, 'nasa');
        const concept = /artist|illustration|concept|render|animation|simulat/i.test(`${item.title} ${item.description || ''}`);
        return {
          path: file, id: `nasa:${item.nasa_id}`, label: concept ? "Artist's concept" : '',
          credit: { kind: 'image', source: 'NASA', title: String(item.title || item.nasa_id).slice(0, 90),
            author: [item.center, item.photographer || item.secondary_creator].filter(Boolean).join(' / ') || 'NASA',
            license: 'public domain', pageUrl: `https://images.nasa.gov/details/${encodeURIComponent(item.nasa_id)}` }
        };
      } catch (error) {
        this.logger.warn(`NASA image ${item.nasa_id} unusable: ${error.message}`);
      }
    }
    return null;
  }

  // OpenStreetMap Nominatim (max one request per second; results cached on disk).
  async geocode(place) {
    if (!place) return null;
    const cacheFile = path.join(this.cacheDir, 'geocode.json');
    let cache = {};
    try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch (_error) { cache = {}; }
    const key = place.toLowerCase();
    if (cache[key] !== undefined) return cache[key];
    const wait = 1100 - (Date.now() - this.lastGeocodeAt);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.lastGeocodeAt = Date.now();
    const response = await this.http.get('https://nominatim.openstreetmap.org/search', {
      timeout: 30000, headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      params: { q: place, format: 'json', limit: 1, addressdetails: 1 }
    });
    const hit = response.data?.[0];
    const result = hit ? {
      lat: Number(hit.lat), lon: Number(hit.lon),
      region: [hit.address?.state || hit.address?.county, hit.address?.country].filter(Boolean).slice(-2).join(', ')
    } : null;
    cache[key] = result;
    await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
    return result;
  }

  // ----- pictures to moving segments -----------------------------------------------------

  // Archive photo on a 2x canvas: full-bleed when it is already wide, otherwise centred over
  // a blurred, darkened copy of itself.
  async composeStill(source, out) {
    const w = W * 2;
    const h = H * 2;
    const meta = await sharp(source).metadata();
    const ratio = meta.width / meta.height;
    if (ratio >= 1.55 && ratio <= 2.0) {
      await sharp(source).resize(w, h, { fit: 'cover' }).png().toFile(out);
      return out;
    }
    const background = await sharp(source).resize(w, h, { fit: 'cover' }).blur(40).modulate({ brightness: 0.45 }).toBuffer();
    const foreground = await sharp(source).resize(Math.round(w * 0.9), Math.round(h * 0.9), { fit: 'inside' }).toBuffer();
    await sharp(background).composite([{ input: foreground, gravity: 'center' }]).png().toFile(out);
    return out;
  }

  async encodeStill(png, out, frames, options = {}) {
    const N = Math.max(1, frames);
    const p = `(on/${N})`;
    const ease = `(${p}*${p}*(3-2*${p}))`;
    const motions = {
      in: { z: `1+0.12*${p}`, fx: '0.5', fy: '0.5' },
      out: { z: `1.12-0.12*${p}`, fx: '0.5', fy: '0.5' },
      panRight: { z: '1.1', fx: `0.15+0.7*${p}`, fy: '0.5' },
      panLeft: { z: '1.1', fx: `0.85-0.7*${p}`, fy: '0.5' },
      slowIn: { z: `1+0.045*${p}`, fx: '0.5', fy: '0.5' },
      mapZoom: { z: `1+2.2*${ease}`, fx: '0.5', fy: '0.5' }
    };
    const m = motions[options.motion] || motions.in;
    const zoom = `zoompan=z='${m.z}':x='(iw-iw/zoom)*(${m.fx})':y='(ih-ih/zoom)*(${m.fy})':d=1:s=${W}x${H}:fps=${FPS}`;
    const grade = options.grade ? ',eq=saturation=0.9:contrast=1.03,vignette=PI/5' : '';
    const args = ['-y', '-loop', '1', '-framerate', String(FPS), '-t', (N / FPS + 0.5).toFixed(3), '-i', png];
    let filter = `[0:v]${zoom}${grade},setsar=1,format=yuv420p[base]`;
    if (options.overlay) {
      args.push('-loop', '1', '-framerate', String(FPS), '-t', (N / FPS + 0.5).toFixed(3), '-i', options.overlay);
      filter += `;[1:v]format=rgba,fade=t=in:st=${Number(options.overlayFrom || 0.4).toFixed(2)}:d=0.6:alpha=1[ov];[base][ov]overlay=0:0:shortest=1,format=yuv420p[v]`;
    } else filter = filter.replace('[base]', '[v]');
    await runFFmpeg([...args, '-filter_complex', filter, '-map', '[v]', '-frames:v', String(N), '-r', String(FPS),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-an', out]);
    return out;
  }

  async encodeVideo(clip, out, frames, options = {}) {
    const seconds = (frames / FPS + 0.5).toFixed(3);
    const args = ['-y', '-stream_loop', '-1', '-t', seconds, '-i', clip];
    let filter = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},eq=saturation=0.88:contrast=1.03,vignette=PI/5,setsar=1,format=yuv420p[base]`;
    if (options.overlay) {
      args.push('-loop', '1', '-framerate', String(FPS), '-t', seconds, '-i', options.overlay);
      filter += `;[1:v]format=rgba,fade=t=in:st=0.4:d=0.6:alpha=1[ov];[base][ov]overlay=0:0:shortest=1,format=yuv420p[v]`;
    } else filter = filter.replace('[base]', '[v]');
    await runFFmpeg([...args, '-filter_complex', filter, '-map', '[v]', '-frames:v', String(frames), '-r', String(FPS),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-an', out]);
    return out;
  }
}

module.exports = { DocumentaryRenderer, groupBeats, sanitizePlan, isGrounded, subjectWords, cardSvg, mapSvg, labelSvg, mapLabelSvg };
