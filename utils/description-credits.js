// Appends the channel's required disclosure and stock-footage credits to a YouTube
// description. Re-applying replaces the previous block instead of stacking copies.
const MAX_DESCRIPTION_LENGTH = 5000;
const MARKER = '── Credits & disclosure ──';

const clean = value => String(value || '').replace(/[<>]/g, '').trim();

function creditLine(credit) {
  const name = clean(credit.photographer) || 'Unknown';
  const page = clean(credit.videoUrl);
  return `• Video by ${name} on ${clean(credit.source) || 'Pexels'}${page ? `: ${page}` : ''}`;
}

function buildFooter({ credits = [], aiNarration = false }, maxLength = Infinity) {
  const head = [MARKER];
  if (aiNarration) head.push('Narration is AI-assisted (synthetic voice). Script and facts are human-reviewed against the sources listed.');
  if (!credits.length) return head.length > 1 ? head.join('\n') : '';

  const sources = [...new Set(credits.map(credit => clean(credit.source) || 'Pexels'))];
  head.push(`Stock footage: ${sources.join(' and ')}. Thank you to these videographers:`);
  const lines = [...head];
  for (const [index, credit] of credits.entries()) {
    const line = creditLine(credit);
    const remaining = credits.length - index;
    const overflow = `• …and ${remaining} more videographers on ${sources.join(' and ')}`;
    if ([...lines, line].join('\n').length > maxLength) {
      lines.push(overflow);
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function applyCreditsToDescription(description, options = {}) {
  const body = String(description || '').split(`\n\n${MARKER}`)[0].split(MARKER)[0].trimEnd();
  const budget = MAX_DESCRIPTION_LENGTH - body.length - 2;
  const footer = buildFooter(options, Math.max(0, budget - 60));
  if (!footer) return body;
  const combined = body ? `${body}\n\n${footer}` : footer;
  return combined.slice(0, MAX_DESCRIPTION_LENGTH);
}

module.exports = { applyCreditsToDescription, buildFooter, CREDITS_MARKER: MARKER };
