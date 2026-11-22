'use strict';
// The "brain": turn a narration script (array of sentences) into a storyboard — one scene template
// + params per sentence. Two paths: buildStoryboard (deterministic heuristic, always works, the
// safety net) and validateBoard (normalise an AI-produced board, falling back per-beat). The daily
// pipeline sends STORYBOARD_PROMPT + the script to its AI, then validates the result here.

const { TEMPLATE_NAMES } = require('./scenes');

const STORYBOARD_PROMPT = `You are the visual director for "The Unknown Archive", a channel of fascinating true stories told as calm, clear animated explainers.
Given a narration script (an array of sentences) plus a title and optional geography, produce a
STORYBOARD: for each sentence, choose ONE scene template and fill its params. Return STRICT JSON:
an array (same length as the script) of { "tpl": <template>, "params": {...}, "cap": <on-screen
caption, <=90 chars, or ""> }.

Templates: opening {title,subtitle} (first beat only); closing {title,note} (last beat only);
stat {number,label} (a figure is the point); map {shape,pin|route,labels} (a real place);
seaScene {storm} (ships/sea/storms); portrait {name,role} (a person); timeline {events:[{year,label}]}
(a sequence of dates); skyEvent {} (a meteor/fireball in the sky); explosion {} (a blast/impact);
cityscape {} (a city, company or urban scene); document {} (a law, letter, writing or report);
machine {} (an engine, machine or industry); crowd {} (people, population, a society);
landscape {} (land, nature, terrain); cosmos {} (space, the universe, stars, planets, galaxies);
statement {} (anything else — atmospheric, by caption).

Rules: every scene must DEPICT what the sentence says — never leave a concrete thing (fireball,
ship, person, blast) on an empty statement card. Prefer stat over statement when a figure is
present; prefer map only for genuine places, not figures of speech. Stay grounded in the sentence;
invent nothing. Numbers as words in narration, digits in captions. Keep captions tight and plain.`;

function shorten(s, n) { s = String(s).replace(/\.$/, ''); return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…'; }

// Pick the intro/outro backdrop theme from the topic text (title + series + keywords).
function themeFor(text) {
  const h = String(text || '').toLowerCase();
  if (/\b(univers|cosmos|cosmic|galax|star|planet|black hole|alien|space|nebula|astronom|voyager|solar|orbit|comet|asteroid)\b/.test(h)) return 'cosmic';
  if (/\b(haunt|ghost|spirit|curse|eerie|abandoned|fort|castle|catacomb|crypt|tomb|graveyard|paranormal|legend|myth|haunted|ruin)\b/.test(h)) return 'haunted';
  if (/\b(empire|dynasty|ancient|history|historic|colon|king|queen|emperor|war|battle|expedition|century|medieval|revolution|civilization|ship|titanic)\b/.test(h)) return 'archive';
  return 'sea';
}

function pickNumber(s) {
  const m = s.match(/\b(\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand)?\b/i);
  if (!m) return null;
  const number = m[1].replace(/,/g, '') + (m[2] ? ' ' + m[2].toLowerCase() : '');
  const after = s.slice(m.index + m[0].length).replace(/[^a-zA-Z ]/g, ' ').trim().split(/\s+/).filter(w => w.length > 2).slice(0, 3).join(' ');
  const before = s.slice(0, m.index).replace(/[^a-zA-Z ]/g, ' ').trim().split(/\s+/).filter(w => w.length > 2).slice(-2).join(' ');
  return { number, label: shorten(after || before || 'in total', 26) };
}

// Deterministic heuristic storyboard — the safe fallback and a decent baseline on its own.
function buildStoryboard(script) {
  const beats = script.beats || [];
  const n = beats.length;
  const theme = script.theme;
  const pick = (say, i) => {
    const cap = shorten(say, 92);
    if (i === 0) return { tpl: 'opening', params: { title: script.title, subtitle: script.subtitle }, say, cap: '' };
    if (i === n - 1) return { tpl: 'closing', params: { title: shorten(say, 70), note: script.sourceNote }, say, cap: '' };
    if (/\b(explod|explosion|blast|detonat|erupt|shockwave)\b/i.test(say)) return { tpl: 'explosion', params: {}, say, cap };
    if (/\b(fireball|meteor|shooting star|streaked across the sky)\b/i.test(say)) return { tpl: 'skyEvent', params: {}, say, cap };
    const num = pickNumber(say);
    if (num) return { tpl: 'stat', params: num, say, cap };
    if (/\b(universe|cosmos|cosmic|galax\w*|planets?|stars?|orbit\w*|solar system|nebula\w*|black holes?|asteroids?|comets?|astronom\w+|light[-\s]?years?|interstellar|celestial|supernova|milky way|spacecraft|spaceflight|outer space)\b/i.test(say)) return { tpl: 'cosmos', params: {}, say, cap };
    if (script.loc && /\b(river|island|coast|near|over|region|lake|sea|across|valley|mountain|forest|desert|bay|city|town|border|harbou?r)\b/i.test(say)) return { tpl: 'map', params: script.loc, say, cap };
    if (/\b(sea|ship|storm|wave|sank|sink|ocean|sail|vessel|boat|freighter)\b/i.test(say)) return { tpl: 'seaScene', params: { storm: /\b(storm|sank|sink|savage|fierce)\b/i.test(say) }, say, cap };
    if (/\b(machine|engine|gears?|mechanical|invention|clockwork|factory|industr)\b/i.test(say)) return { tpl: 'machine', params: {}, say, cap };
    if (/\b(city|skyline|building|skyscraper|metropolis|downtown|urban|company|headquarters|empire)\b/i.test(say)) return { tpl: 'cityscape', params: {}, say, cap };
    if (/\b(document|letter|law|treaty|wrote|writing|manuscript|report|signed|decree|published|contract)\b/i.test(say)) return { tpl: 'document', params: {}, say, cap };
    if (/\b(people|population|crowd|workers|soldiers|citizens|society|refugees|villagers|passengers)\b/i.test(say)) return { tpl: 'crowd', params: {}, say, cap };
    if (/\b(forest|mountain|valley|desert|plain|countryside|wilderness|hills?|terrain|jungle|tundra|landscape|fields?)\b/i.test(say)) return { tpl: 'landscape', params: {}, say, cap };
    return { tpl: 'statement', params: {}, say, cap };
  };
  // Every beat carries the video's theme so even generic scenes look on-subject (e.g. a space video stays in space).
  return beats.map((say, i) => { const b = pick(say, i); b.params = { ...b.params, theme }; return b; });
}

// Normalise an AI-produced board; narration always comes from the script verbatim. Any invalid beat
// falls back to the heuristic choice for that sentence, so a bad AI reply never breaks a render.
function validateBoard(aiBoard, script) {
  const fallback = buildStoryboard(script);
  if (!Array.isArray(aiBoard) || aiBoard.length !== script.beats.length) return fallback;
  return aiBoard.map((b, i) => {
    if (!b || !TEMPLATE_NAMES.includes(b.tpl)) return fallback[i];
    return { tpl: b.tpl, params: { ...(b.params || {}), theme: script.theme }, say: script.beats[i], cap: typeof b.cap === 'string' ? b.cap : fallback[i].cap };
  });
}

module.exports = { STORYBOARD_PROMPT, buildStoryboard, validateBoard, pickNumber, themeFor };
