'use strict';
// Animated-style thumbnail: a dramatic hero scene from the kit + the title in bold, drawn in code
// (free, on-brand, honest — no AI image). 1280x720 PNG via sharp.
const path = require('path');
const { TEMPLATES, defs, wrap } = require('./scenes');

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Pick a hero scene that fits the subject; default to something with impact.
function pickScene(hint) {
  const h = String(hint || '').toLowerCase();
  if (/fireball|meteor|comet|asteroid/.test(h)) return { s: 'skyEvent', p: {}, storm: true };
  if (/explos|blast|bomb|eruption|nuclear/.test(h)) return { s: 'explosion', p: {}, storm: true };
  if (/ship|sea|ocean|wreck|sank|sail|naval|titanic|lighthouse|coast/.test(h)) return { s: 'seaScene', p: { storm: true }, storm: true };
  if (/city|company|empire|urban|wall street|market/.test(h)) return { s: 'cityscape', p: {}, storm: false };
  if (/machine|engine|industr|factory|invention/.test(h)) return { s: 'machine', p: {}, storm: false };
  if (/people|population|army|crowd|society/.test(h)) return { s: 'crowd', p: {}, storm: false };
  if (/mountain|forest|desert|valley|land|nature/.test(h)) return { s: 'landscape', p: {}, storm: false };
  return { s: 'seaScene', p: { storm: true }, storm: true };
}

async function renderThumbnail({ title, outputPath, hint }) {
  const sharp = require('sharp');
  const pick = pickScene(hint || title);
  const ctx = { tAbs: 2600, tIn: 1200, beatMs: 5000, W: 1280, H: 720 };
  const body = TEMPLATES[pick.s](pick.p, ctx);
  const lines = wrap(String(title || 'Curious Files').toUpperCase(), 18).slice(0, 3);
  const fsz = lines.length >= 3 ? 20 : 25;
  const baseY = 210 - (lines.length - 1) * (fsz + 2);
  const titleSvg = lines.map((l, i) => `<text x="22" y="${baseY + i * (fsz + 2)}" font-family="Georgia, 'Times New Roman', serif" font-weight="bold" font-size="${fsz}" fill="#ffffff" paint-order="stroke" stroke="#05080d" stroke-width="4" stroke-opacity="0.65">${xml(l)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 400 225">`
    + defs(pick.storm)
    + body
    + `<rect x="0" y="96" width="400" height="129" fill="url(#capband)"/>`
    + `<rect x="22" y="${baseY - fsz - 10}" width="46" height="3" fill="#ffcf33"/>`
    + `<text x="22" y="${baseY - fsz - 1}" font-family="Helvetica Neue, Helvetica, Arial" font-weight="bold" font-size="8" letter-spacing="3" fill="#ffcf33">CURIOUS FILES</text>`
    + titleSvg
    + `</svg>`;
  const out = outputPath || path.join(__dirname, '..', '..', 'uploads', 'thumbnails', `anim_thumb_${Date.now()}.png`);
  await sharp(Buffer.from(svg)).png().toFile(out);
  return out;
}

module.exports = { renderThumbnail, pickScene };
