// Free, honest thumbnails: a real frame from the finished video plus a few words taken from
// the script (channel bible: honest titles, no clickbait like "MUST WATCH").
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const { runFFmpeg } = require('./ffmpeg');
const { isGrounded } = require('./documentary-renderer');

const ACCENT = '#e2b35e';
const BANNED = /\b(must watch|shocking|you won'?t believe|insane|crazy|gone wrong|exposed)\b/i;
const PEOPLE = /\b(portraits?|persons?|people|man|men|woman|women|faces?|child(ren)?|hands?|crowd)\b/i;
const xml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Frames worth considering: archive images and stock clips, spread across the video.
function candidateScenes(scenes = [], max = 10) {
  const usable = scenes.filter(scene => ['archive', 'stock'].includes(scene.model) && scene.path && !PEOPLE.test(scene.prompt || ''));
  if (usable.length <= max) return usable;
  const step = usable.length / max;
  return Array.from({ length: max }, (_, i) => usable[Math.floor(i * step)]);
}

// Prefer clear, mid-brightness frames with contrast (not black, not washed out).
async function scoreFrame(file) {
  const stats = await sharp(file).greyscale().stats();
  const channel = stats.channels[0];
  const mean = channel.mean / 255;
  const contrast = channel.stdev / 128;
  return contrast * (1 - Math.min(1, Math.abs(mean - 0.42) * 1.6)) + (stats.sharpness || 0) * 0.02;
}

async function extractFrame(scene, out) {
  if (/\.(png|jpe?g)$/i.test(scene.path)) {
    await sharp(scene.path).resize(1280, 720, { fit: 'cover' }).png().toFile(out);
  } else {
    await runFFmpeg(['-y', '-ss', '2.5', '-i', scene.path, '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720', out]);
  }
  return out;
}

// Two short lines plus a small subtitle, every word grounded in the script.
// Main subject words of a title ("Inside Nvidia: The Rise of..." -> ["Nvidia"]): capitalised
// words that are not common title words. Thumbnail text must name the subject.
const TITLE_WORDS = new Set('The A An And Of In On At For To From With How What Why When Who Is Are Was Inside Rise Fall Story History Last Great Secret Secrets Mystery Real True Behind Untold Making Life Death Era Age New Old'.split(' '));
function subjectOf(title) {
  return String(title || '').split(/[:—–]/)[0].split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}'-]/gu, ''))
    .filter(w => /^[\p{Lu}\d]/u.test(w) && w.length > 1 && !TITLE_WORDS.has(w));
}

// A natural phrase, not a word list: no dangling small words at the end of a line, and not
// a pile of nouns without any linking word when it runs to 4+ words.
function readsNaturally(line1, line2) {
  const text = `${line1} ${line2}`.trim();
  const words = text.split(/\s+/);
  if (/\b(a|an|the|of|at|in|on|to|and|for|with|from)$/i.test(line1.trim()) && !line2) return false;
  if (/\b(a|an|the|of|and|to)$/i.test(text)) return false;
  if (words.length >= 4 && !/\b(of|to|the|a|an|and|that|who|how|why|from|in|on|for|with|by|is|was)\b/i.test(text) && !/\d/.test(text)) return false;
  return true;
}

// Split a phrase into two balanced lines.
function twoLines(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return { line1: words.join(' '), line2: '' };
  let best = 1;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length);
    if (diff < Math.abs(words.slice(0, best).join(' ').length - words.slice(best).join(' ').length)) best = i;
  }
  return { line1: words.slice(0, best).join(' '), line2: words.slice(best).join(' ') };
}

// Two short lines plus a small subtitle, every word grounded in the script, naming the subject.
async function thumbnailText(script, aiText) {
  const fullText = [script.title, script.hook?.text, script.fullScript].filter(Boolean).join(' ');
  const shortTitle = String(script.title || '').split(/[:—–]/)[0].trim();
  const subject = subjectOf(script.title);
  const fallback = () => ({ ...twoLines(shortTitle.replace(/^the\s+/i, '')), sub: '' });
  if (!aiText?.isAvailable?.()) return fallback();
  const valid = parsed => {
    const text = `${parsed.line1 || ''} ${parsed.line2 || ''}`.trim();
    return parsed.line1 && text.split(/\s+/).length >= 2 && text.split(/\s+/).length <= 5 && text.length <= 32 &&
      !BANNED.test(text) && !/!/.test(text) && isGrounded(text, fullText) &&
      (!subject.length || subject.some(word => text.toLowerCase().includes(word.toLowerCase()))) &&
      readsNaturally(parsed.line1, parsed.line2 || '') && (!parsed.sub || isGrounded(parsed.sub, fullText));
  };
  const prompt = `Write the text for a YouTube thumbnail of a calm, factual documentary.
Title: ${script.title}
Opening: ${String(script.hook?.text || '').slice(0, 600)}
Rules:
- One short, natural English phrase of 2 to 4 words that anyone understands at a glance, like a magazine cover line: "Nvidia's Big Bet", "The Fastest Liner Ever", "Lost in a Storm".
- It must name the subject${subject.length ? ` (${subject.join(' ')})` : ''} and use words from the title or opening. No word lists, no hype, no exclamation marks, nothing the video does not show.
- Split the phrase over "line1" and "line2" at a natural break. "sub": a place or year from the text, max 4 words, or "".
Return ONLY JSON {"line1":"...","line2":"...","sub":"..."}.`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await aiText.generateText(prompt + (attempt > 1 ? '\nYour last answer broke a rule. Follow every rule exactly.' : ''), { maxTokens: 200, temperature: 0.5 });
      const parsed = JSON.parse(String(raw).match(/\{[\s\S]*\}/)[0]);
      if (valid(parsed)) return { line1: String(parsed.line1).trim(), line2: String(parsed.line2 || '').trim(), sub: String(parsed.sub || '').trim() };
    } catch (_error) { /* try again or fall back */ }
  }
  return fallback();
}

function overlaySvg({ line1, line2, sub }) {
  const longest = Math.max(line1.length, line2.length);
  const size = longest > 12 ? 74 : longest > 9 ? 84 : 92;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#05080b" stop-opacity="0.9"/><stop offset="0.45" stop-color="#05080b" stop-opacity="0.35"/><stop offset="0.62" stop-color="#05080b" stop-opacity="0"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#g)"/>
<text x="56" y="${line2 ? 290 : 340}" font-family="Helvetica Neue, Helvetica, Arial" font-weight="bold" font-size="${size}" fill="#ffffff">${xml(line1.toUpperCase())}</text>
${line2 ? `<text x="56" y="${290 + size + 10}" font-family="Helvetica Neue, Helvetica, Arial" font-weight="bold" font-size="${size}" fill="${ACCENT}">${xml(line2.toUpperCase())}</text>` : ''}
${sub ? `<rect x="60" y="${line2 ? 300 + size * 2 - 40 : 380}" width="80" height="6" fill="${ACCENT}"/>
<text x="60" y="${line2 ? 300 + size * 2 + 16 : 436}" font-family="Georgia, serif" font-size="40" fill="#f4efe6">${xml(sub)}</text>` : ''}
</svg>`;
}

async function createDocumentaryThumbnail({ scenes, script, outputPath, aiText, logger }) {
  const workDir = `${outputPath}.frames`;
  await fs.mkdir(workDir, { recursive: true });
  let best = null;
  for (const [i, scene] of candidateScenes(scenes).entries()) {
    try {
      const frame = await extractFrame(scene, path.join(workDir, `f${i}.png`));
      const score = await scoreFrame(frame);
      if (!best || score > best.score) best = { frame, score, scene };
    } catch (error) {
      logger?.warn?.(`Thumbnail frame ${i} skipped: ${error.message}`);
    }
  }
  if (!best) {
    await fs.rm(workDir, { recursive: true, force: true });
    throw new Error('No usable frame for a thumbnail');
  }
  const text = await thumbnailText(script, aiText);
  const base = await sharp(best.frame).modulate({ saturation: 0.9 }).toBuffer();
  await sharp(base).composite([{ input: Buffer.from(overlaySvg(text)) }]).jpeg({ quality: 90 }).toFile(outputPath);
  await fs.rm(workDir, { recursive: true, force: true });
  const { size } = await fs.stat(outputPath);
  return { path: outputPath, dimensions: { width: 1280, height: 720 }, fileSize: size, generatedWith: 'documentary-frame', text, frameFrom: best.scene.taskId || best.scene.path };
}

module.exports = { createDocumentaryThumbnail, thumbnailText, candidateScenes, subjectOf, readsNaturally, twoLines };
