// Accurate subtitle timing without a speech-recognition model.
//
// Narration is synthesized in a few chunks. In each chunk we know the exact sentences that
// were read, and FFmpeg's silencedetect tells us where the voice pauses. Sentence breaks are
// the longest pauses, so a small dynamic-programming alignment maps every sentence break to
// the pause nearest its expected position. Sentences then get real start/end times, and
// subtitle cues inside a sentence share its time by character count.

const ABBREVIATIONS = new Set(('mr mrs ms dr st mt no vs jr sr prof gen col capt lt sgt rev ' +
  'jan feb mar apr jun jul aug sep sept oct nov dec approx est fig etc inc ltd co').split(' '));

// Split text into sentences, keeping abbreviations ("Mr.", "St.") and initials ("J. R.") intact.
function splitSentences(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const sentences = [];
  let current = '';
  const parts = source.split(/(?<=[.!?…]["'”’)\]]?)\s+(?=["'“‘(\[]?[A-Z0-9])/);
  for (const [index, part] of parts.entries()) {
    current = current ? `${current} ${part}` : part;
    const lastWord = (current.match(/([A-Za-z.]+)[.]["'”’)\]]?$/) || [])[1] || '';
    const bare = lastWord.replace(/\./g, '').toLowerCase();
    const next = parts[index + 1] || '';
    // "No." is only an abbreviation before a number ("No. 7"); otherwise it ends a sentence.
    const known = bare === 'no' ? /^\d/.test(next) : ABBREVIATIONS.has(bare);
    const isAbbreviation = known || /^[A-Za-z]$/.test(bare) || /^([A-Za-z]\.){2,}$/.test(lastWord);
    if (!isAbbreviation) {
      sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences;
}

// Pack ordered paragraphs ({label, text}) into TTS chunks of at most maxWords, never splitting
// a sentence. A chunk keeps the label of every sentence so chapters and visuals stay in sync.
function chunkParagraphs(paragraphs, maxWords = 260) {
  const chunks = [];
  let current = null;
  const words = text => text.split(/\s+/).filter(Boolean).length;
  for (const paragraph of paragraphs) {
    const sentences = splitSentences(paragraph.text);
    sentences.forEach((sentence, index) => {
      const count = words(sentence);
      if (!current || (current.words + count > maxWords && current.words > 0)) {
        current = { sentences: [], words: 0 };
        chunks.push(current);
      }
      current.sentences.push({ text: sentence, label: paragraph.label, paragraphStart: index === 0 });
      current.words += count;
    });
  }
  return chunks.map(chunk => ({
    ...chunk,
    // Paragraph breaks become blank lines, which TTS voices read as a longer, natural pause.
    text: chunk.sentences.map((s, i) => (i > 0 && s.paragraphStart ? '\n\n' : (i > 0 ? ' ' : '')) + s.text).join('')
  }));
}

// Parse FFmpeg silencedetect output into [{start, end}] (seconds).
function parseSilences(stderr) {
  const silences = [];
  let start = null;
  for (const line of String(stderr || '').split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) { start = Math.max(0, Number(s[1])); continue; }
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && start !== null) {
      silences.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  if (start !== null) silences.push({ start, end: Infinity });
  return silences;
}

// Map the boundaries between sentences to detected pauses. Returns [{text, start, end}] with
// times relative to the chunk. Unmatched boundaries are interpolated by character count.
function alignSentences(sentences, silences, duration, options = {}) {
  const texts = sentences.map(s => (typeof s === 'string' ? s : s.text));
  const total = Number(duration) || 0;
  if (!texts.length) return [];
  const closed = silences.map(s => ({ start: s.start, end: Math.min(Number.isFinite(s.end) ? s.end : total, total) }));
  // Leading and trailing silence frame the speech; interior pauses are boundary candidates.
  const lead = closed.find(s => s.start <= 0.05);
  const tail = [...closed].reverse().find(s => s.end >= total - 0.05 && s.start > (lead ? lead.end : 0));
  const speechStart = lead ? lead.end : 0;
  const speechEnd = tail ? tail.start : total;
  const pauses = closed.filter(s => s !== lead && s !== tail && s.start > speechStart && s.end < speechEnd);

  const lengths = texts.map(t => Math.max(1, t.length));
  const totalChars = lengths.reduce((a, b) => a + b, 0);
  const span = Math.max(0.1, speechEnd - speechStart);
  const expected = [];
  let acc = 0;
  for (let i = 0; i < texts.length - 1; i++) {
    acc += lengths[i];
    expected.push(speechStart + (acc / totalChars) * span);
  }

  const B = expected.length;
  const M = pauses.length;
  const skipPenalty = options.skipPenalty ?? 2.5;
  const pauseBonus = options.pauseBonus ?? 2.0;
  const matchCost = (i, j) => {
    const p = pauses[j];
    const mid = (p.start + p.end) / 2;
    return Math.abs(mid - expected[i]) - pauseBonus * Math.min(1, p.end - p.start);
  };
  // dp[i][j]: best cost placing the first i boundaries using the first j pauses.
  const dp = Array.from({ length: B + 1 }, () => new Array(M + 1).fill(Infinity));
  const back = Array.from({ length: B + 1 }, () => new Array(M + 1).fill(null));
  for (let j = 0; j <= M; j++) dp[0][j] = 0;
  for (let i = 1; i <= B; i++) {
    dp[i][0] = dp[i - 1][0] + skipPenalty;
    back[i][0] = 'unmatched';
    for (let j = 1; j <= M; j++) {
      const options3 = [
        [dp[i][j - 1], 'skipPause'],
        [dp[i - 1][j - 1] + matchCost(i - 1, j - 1), 'match'],
        [dp[i - 1][j] + skipPenalty, 'unmatched']
      ];
      const [cost, move] = options3.reduce((best, item) => (item[0] < best[0] ? item : best));
      dp[i][j] = cost;
      back[i][j] = move;
    }
  }
  const matched = new Array(B).fill(null);
  for (let i = B, j = M; i > 0;) {
    const move = back[i][j];
    if (move === 'match') { matched[i - 1] = pauses[j - 1]; i--; j--; }
    else if (move === 'skipPause') j--;
    else i--;
  }

  // Boundary times: pause start ends the sentence, pause end starts the next one.
  const anchors = [{ index: -1, time: speechStart }];
  matched.forEach((pause, i) => { if (pause) anchors.push({ index: i, time: (pause.start + pause.end) / 2 }); });
  anchors.push({ index: B, time: speechEnd });
  const cumulative = [0];
  lengths.forEach(len => cumulative.push(cumulative[cumulative.length - 1] + len));
  const boundaries = matched.map((pause, i) => {
    if (pause) return { end: pause.start, start: pause.end };
    const before = [...anchors].reverse().find(a => a.index < i);
    const after = anchors.find(a => a.index > i);
    const charsAt = index => cumulative[index + 1];
    const fraction = (charsAt(i) - charsAt(before.index)) / Math.max(1, charsAt(after.index) - charsAt(before.index));
    const t = before.time + fraction * (after.time - before.time);
    return { end: t, start: t };
  });

  return texts.map((text, i) => ({
    text,
    start: Number((i === 0 ? speechStart : boundaries[i - 1].start).toFixed(3)),
    end: Number((i === texts.length - 1 ? speechEnd : boundaries[i].end).toFixed(3))
  }));
}

// Split one sentence into subtitle cues of at most two lines (maxLine chars each),
// preferring breaks at punctuation, then at word boundaries.
function splitCue(sentence, maxLine = 42) {
  const text = String(sentence || '').replace(/\s+/g, ' ').trim();
  const maxCue = maxLine * 2;
  if (text.length <= maxCue) return [wrapLines(text, maxLine)];
  const pieces = Math.ceil(text.length / maxCue);
  const target = text.length / pieces;
  const words = text.split(' ');
  const cues = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    const atPunctuation = /[,;:—–-]$/.test(current) && current.length >= target * 0.6;
    if (current && (next.length > maxCue || current.length >= target * 1.15 || atPunctuation)) {
      cues.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) cues.push(current);
  // Fold a very short tail back into the previous cue when it still fits.
  if (cues.length > 1 && cues[cues.length - 1].length < 14 && (cues[cues.length - 2].length + cues[cues.length - 1].length + 1) <= maxCue) {
    cues[cues.length - 2] += ` ${cues.pop()}`;
  }
  return cues.map(cue => wrapLines(cue, maxLine));
}

// Break a cue into at most two balanced lines.
function wrapLines(text, maxLine = 42) {
  if (text.length <= maxLine) return text;
  const middle = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' && (best < 0 || Math.abs(i - middle) < Math.abs(best - middle))) best = i;
  }
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

// Sentence timings -> subtitle cues [{start, end, text}] (text may hold one "\n").
function buildCues(sentenceTimings, options = {}) {
  const cues = [];
  for (const sentence of sentenceTimings) {
    const pieces = splitCue(sentence.text, options.maxLine || 42);
    const chars = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
    const span = Math.max(0.2, sentence.end - sentence.start);
    let t = sentence.start;
    for (const piece of pieces) {
      const length = (piece.length / chars) * span;
      cues.push({ start: t, end: t + length, text: piece });
      t += length;
    }
  }
  // Bridge short gaps so text does not flicker off between sentences, and keep cues readable.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    if (next && next.start - cues[i].end < 0.6) cues[i].end = next.start;
    if (cues[i].end - cues[i].start < 0.8) cues[i].end = next ? Math.min(next.start, cues[i].start + 0.8) : cues[i].start + 0.8;
  }
  return cues.map(cue => ({ start: Number(cue.start.toFixed(3)), end: Number(cue.end.toFixed(3)), text: cue.text }));
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}

function toSRT(cues) {
  return cues.map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join('\n');
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

// Styled burned-in subtitles: clean white sans with a soft dark outline, lower third of a 1080p frame.
function toASS(cues, style = {}) {
  const font = style.font || 'Arial';
  const size = style.size || 54;
  const escape = text => String(text).replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, '\\N');
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${size},&H00FFFFFF,&H00FFFFFF,&H00101010,&H96000000,-1,0,0,0,100,100,0.5,0,1,3.2,1.5,2,160,160,${style.marginV || 64},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map(cue => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,{\\fad(120,120)}${escape(cue.text)}`)
  ].join('\n') + '\n';
}

module.exports = {
  splitSentences, chunkParagraphs, parseSilences, alignSentences, splitCue, wrapLines, buildCues, toSRT, toASS, srtTime
};
