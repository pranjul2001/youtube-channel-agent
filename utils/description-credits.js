// Appends the channel's required blocks to a YouTube description: real chapters (computed
// from the rendered timeline), named sources, AI-narration disclosure and stock credits.
// Re-applying replaces the previous blocks instead of stacking copies.
const MAX_DESCRIPTION_LENGTH = 5000;
const MARKER = '── Credits & disclosure ──';
const CHAPTERS_HEADING = 'Chapters';
const SOURCES_HEADING = 'Sources';
const CHAPTER_LINE = /^\s*\(?\d{1,2}:\d{2}(?::\d{2})?\)?\s*[-–—:]?\s+\S/;

const clean = value => String(value || '').replace(/[<>]/g, '').trim();

function creditLine(credit) {
  if (credit.kind === 'image') {
    const author = clean(credit.author);
    const licence = clean(credit.license);
    return `• Image: ${clean(credit.title) || 'Untitled'}${author ? `, ${author}` : ''}${licence ? ` (${licence})` : ''}, via ${clean(credit.source)}: ${clean(credit.pageUrl)}`;
  }
  if (credit.kind === 'data') {
    return `• ${clean(credit.title)}: ${clean(credit.source)}${credit.license ? ` (${clean(credit.license)})` : ''}: ${clean(credit.pageUrl)}`;
  }
  const name = clean(credit.photographer) || 'Unknown';
  const page = clean(credit.videoUrl);
  return `• Video by ${name} on ${clean(credit.source) || 'Pexels'}${page ? `: ${page}` : ''}`;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Group consecutive timeline scenes by label into chapters. YouTube only shows chapters when
// the first is 0:00, there are at least three, and each lasts at least 10 seconds.
function chaptersFromScenes(scenes = [], names = { Hook: 'Intro', Conclusion: 'Closing' }) {
  const chapters = [];
  let t = 0;
  for (const scene of scenes) {
    const label = clean(names[scene.label] || scene.label) || 'Part';
    const duration = Number(scene.duration) || 0;
    const last = chapters[chapters.length - 1];
    if (last && last.label === label) last.duration += duration;
    else chapters.push({ label, start: t, duration });
    t += duration;
  }
  const merged = [];
  for (const chapter of chapters) {
    const previous = merged[merged.length - 1];
    if (previous && chapter.duration < 10) previous.duration += chapter.duration;
    else merged.push({ ...chapter });
  }
  if (merged.length < 3 || merged.some(chapter => chapter.duration < 10)) return [];
  return merged.map(chapter => `${formatTime(chapter.start)} ${chapter.label}`);
}

function sourceLine(source) {
  const title = clean(source.title) || clean(source.url);
  const publisher = clean(source.publisher);
  return `• ${title}${publisher ? ` (${publisher})` : ''}: ${clean(source.url)}`;
}

function buildFooter({ credits = [], aiNarration = false }, maxLength = Infinity) {
  const head = [MARKER];
  if (aiNarration) head.push('Narration is AI-assisted (synthetic voice). Script and facts are human-reviewed against the sources listed.');
  if (!credits.length) return head.length > 1 ? head.join('\n') : '';

  // Order: maps and data, archive images, then stock videographers (usually the longest list).
  const rank = credit => (credit.kind === 'data' ? 0 : credit.kind === 'image' ? 1 : 2);
  const ordered = [...credits].sort((a, b) => rank(a) - rank(b));
  const videos = ordered.filter(credit => !credit.kind || credit.kind === 'video');
  const sources = [...new Set(videos.map(credit => clean(credit.source) || 'Pexels'))];
  const lines = [...head];
  let videoHeading = false;
  for (const [index, credit] of ordered.entries()) {
    const isVideo = !credit.kind || credit.kind === 'video';
    const extra = [];
    if (isVideo && !videoHeading) extra.push(`Stock footage: ${sources.join(' and ')}. Thank you to these videographers:`);
    const line = creditLine(credit);
    const remaining = ordered.length - index;
    if ([...lines, ...extra, line].join('\n').length > maxLength) {
      const rest = ordered.slice(index);
      const restSources = [...new Set(rest.map(c => clean(c.source) || 'Pexels'))].join(' and ');
      lines.push(rest.every(c => !c.kind || c.kind === 'video')
        ? `• …and ${remaining} more videographers on ${restSources}`
        : `• …and ${remaining} more credits on ${restSources}`);
      break;
    }
    if (extra.length) { lines.push(...extra); videoHeading = true; }
    lines.push(line);
  }
  return lines.join('\n');
}

// Removes blocks this module wrote before, plus AI-invented timestamp lines (they rarely
// match the real edit and YouTube would turn them into misleading chapters).
function stripGenerated(description) {
  let body = String(description || '');
  for (const start of [`\n${CHAPTERS_HEADING}\n0:00`, `${CHAPTERS_HEADING}\n0:00`, `\n${SOURCES_HEADING}\n• `, MARKER]) {
    const at = body.indexOf(start);
    if (at === 0 || at > 0) body = body.slice(0, at);
  }
  return body.split('\n').filter(line => !CHAPTER_LINE.test(line)).join('\n')
    .replace(/\n{3,}/g, '\n\n').trimEnd();
}

function applyCreditsToDescription(description, options = {}) {
  const body = stripGenerated(description);
  const blocks = [body];
  const chapters = Array.isArray(options.chapters) ? options.chapters : [];
  if (chapters.length) blocks.push([CHAPTERS_HEADING, ...chapters].join('\n'));
  const sources = (options.sources || []).filter(source => source && source.url);
  if (sources.length) blocks.push([SOURCES_HEADING, ...sources.map(sourceLine)].join('\n'));
  const used = blocks.filter(Boolean).join('\n\n').length;
  const footer = buildFooter(options, Math.max(0, MAX_DESCRIPTION_LENGTH - used - 62));
  if (footer) blocks.push(footer);
  return blocks.filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION_LENGTH);
}

module.exports = { applyCreditsToDescription, buildFooter, chaptersFromScenes, CREDITS_MARKER: MARKER };
