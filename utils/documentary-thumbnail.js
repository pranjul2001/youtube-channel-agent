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
async function thumbnailText(script, aiText) {
  const fullText = [script.title, script.hook?.text, script.fullScript].filter(Boolean).join(' ');
  const shortTitle = String(script.title || '').split(/[:—–]/)[0].trim();
  const fallback = () => {
    const words = shortTitle.replace(/^the\s+/i, '').split(/\s+/);
    const half = Math.ceil(words.length / 2);
    return { line1: words.slice(0, half).join(' '), line2: words.slice(half).join(' '), sub: '' };
  };
  if (!aiText?.isAvailable?.()) return fallback();
  try {
    const raw = await aiText.generateText(`Write YouTube thumbnail text for a calm, factual documentary.
Title: ${script.title}
Opening: ${String(script.hook?.text || '').slice(0, 600)}
Return ONLY JSON {"line1":"...","line2":"...","sub":"..."}: line1 and line2 together 2 to 4 words that state the core fact or question, using words and numbers from the title or opening; "sub" is a place and/or year from the text (max 4 words). Honest, no hype words, no exclamation marks.`, { maxTokens: 200, temperature: 0.5 });
    const parsed = JSON.parse(String(raw).match(/\{[\s\S]*\}/)[0]);
    const text = `${parsed.line1} ${parsed.line2}`;
    const ok = parsed.line1 && text.split(/\s+/).length <= 5 && !BANNED.test(text) && !/!/.test(text) &&
      isGrounded(text, fullText) && (!parsed.sub || isGrounded(parsed.sub, fullText));
    return ok ? { line1: parsed.line1, line2: parsed.line2 || '', sub: parsed.sub || '' } : fallback();
  } catch (_error) {
    return fallback();
  }
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

module.exports = { createDocumentaryThumbnail, thumbnailText, candidateScenes };
