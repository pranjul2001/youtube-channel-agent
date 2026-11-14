// Unattended runs must survive "model busy" replies. Retries the configured text model with
// backoff, then moves through backup models (each has its own free quota).
const DEFAULT_FALLBACKS = 'gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-3.8-flash,gemini-2.5-flash';
const TEMPORARY = /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|high demand|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|timeout/i;

async function generateTextWithRetry(aiText, prompt, options = {}) {
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const fallbacks = String(process.env.TEXT_MODEL_FALLBACKS ?? DEFAULT_FALLBACKS).split(',').map(m => m.trim()).filter(Boolean);
  // Backup models only apply to Gemini; other providers retry their own model.
  const models = [aiText.model, ...(aiText.gemini ? fallbacks.filter(model => model !== aiText.model) : [])];
  const triesPerModel = options.triesPerModel || 3;
  let lastError = null;
  for (const model of models) {
    for (let attempt = 1; attempt <= triesPerModel; attempt++) {
      try {
        // A stalled connection must not hang an unattended run: give each call a deadline.
        const deadline = options.timeoutMs || 240000;
        let timer;
        const text = await Promise.race([
          aiText.generateText(prompt, { ...options, model }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`AI text timeout after ${deadline / 1000}s`)), deadline); })
        ]).finally(() => clearTimeout(timer));
        if (String(text || '').trim()) return text;
        lastError = new Error('empty AI response');
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error);
        if (!TEMPORARY.test(message)) throw error;
        if (/per day|PerDay/i.test(message)) break; // daily quota: next model now
      }
      if (attempt < triesPerModel) await sleep(Math.min(60000, 6000 * attempt * attempt));
    }
    options.logger?.warn?.(`Text model ${model} unavailable (${String(lastError?.message || '').replace(/\s+/g, ' ').slice(0, 100)}); trying the next one`);
  }
  throw lastError || new Error('AI text generation failed');
}

module.exports = { generateTextWithRetry, DEFAULT_FALLBACKS };
