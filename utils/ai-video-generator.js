const OpenAI = require('openai');
const { progress } = require('./progress-tracker');
const Replicate = require('replicate');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { Logger } = require('./logger');
const { runFFmpeg, getMediaDuration, checkFFmpeg, ffmpegInstallHint } = require('./ffmpeg');
const { MediaGenerationService } = require('./media-generation-service');

const OPENAI_IMAGE_MODEL = 'gpt-image-2';

// Spoken-style direction for Gemini narration (channel voice: calm, gentle, clear).
const DEFAULT_NARRATION_STYLE = 'Narrate the following for a documentary, as a calm, gentle male storyteller speaking to one listener. ' +
  'Unhurried, warm and very clear, with natural pauses at full stops and a slightly longer pause between paragraphs. ' +
  'Relaxed and human, never dramatic, never robotic. Read exactly this text and nothing else:';

// Turns an image provider SDK error into one readable line that leads with the
// fix when the cause is recognisable. @google/genai puts the raw JSON error
// body in error.message, which is unreadable on a console.
function describeImageProviderError(provider, model, error) {
  const raw = String(error?.message || error || 'Unknown error');
  let status = Number(error?.status) || null;
  let code = String(error?.code || '');
  let detail = raw;
  try {
    const body = JSON.parse(raw.slice(raw.indexOf('{')));
    if (body?.error) {
      status = status || Number(body.error.code) || null;
      code = body.error.status || code;
      detail = body.error.message || raw;
    }
  } catch (_error) { /* not a JSON error body */ }

  const text = `${code} ${detail}`;
  let fix = null;
  if (provider === 'Gemini') {
    if (/limit:\s*0\b/i.test(text) || (status === 429 && /free.?tier/i.test(text))) {
      fix = `this key has no quota for ${model}. Gemini image models are not on the free tier: turn on billing for the Google Cloud project that owns this API key (AI Studio → API keys → Set up billing). A paid account does not help if the key belongs to a different project.`;
    } else if (status === 429 || /RESOURCE_EXHAUSTED/i.test(code)) {
      fix = 'Gemini rate-limited this key. Wait a minute and retry, or raise the project quota.';
    } else if (/API key not valid|API key expired|API_KEY_INVALID/i.test(text)) {
      fix = 'the Gemini API key was rejected. Create a new key in Google AI Studio and save it in Settings.';
    } else if (/location is not supported|user location/i.test(text)) {
      fix = 'Gemini image generation is not available in your region for this key.';
    } else if (status === 404 || /NOT_FOUND|not supported for generateContent/i.test(text)) {
      fix = `${model} is not available to this key. Set GEMINI_IMAGE_MODEL to an image model your key can use (for example gemini-3.1-flash-image).`;
    } else if (status === 403 || /PERMISSION_DENIED|SERVICE_DISABLED/i.test(text)) {
      fix = "this key's Google Cloud project cannot call the Gemini API. Enable the Generative Language API for that project, or create the key in Google AI Studio.";
    }
  } else if (provider === 'OpenAI') {
    if (status === 401 || /invalid_api_key|Incorrect API key/i.test(text)) {
      fix = 'the OpenAI API key was rejected. Check the key in Settings.';
    } else if (/insufficient_quota|billing/i.test(text)) {
      fix = 'the OpenAI account has no remaining credit. Add billing at platform.openai.com.';
    } else if (status === 403 && /verif/i.test(text)) {
      fix = `${model} requires a verified OpenAI organization (platform.openai.com → Settings → Organization → Verify).`;
    } else if (status === 429) {
      fix = 'OpenAI rate-limited this key. Wait a minute and retry.';
    }
  }

  const label = [status, code && code !== String(status) ? code : null].filter(Boolean).join(' ');
  const summary = `${provider} image generation (${model}) failed${label ? ` [${label}]` : ''}.`;
  const shortDetail = detail.replace(/\s+/g, ' ').trim().slice(0, 220);
  return fix ? `${summary} Fix: ${fix} Details: ${shortDetail}` : `${summary} ${shortDetail}`;
}

class AIVideoGenerator {
  constructor(credentials, options = {}) {
    this.logger = new Logger('AIVideoGenerator');
    const resolvedCredentials = credentials?.credentials || credentials || {};
    this.db = options.db || null;
    this.getMediaDuration = options.getMediaDuration || getMediaDuration;
    this.lastVideoResult = null;
    this.lastNarrationResult = null;
    
    // Initialize AI services with graceful fallback
    const openaiKey = resolvedCredentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    const replicateKey = resolvedCredentials.replicate?.apiKey || process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
    
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.info('OpenAI service initialized');
    } else {
      this.logger.warn('OpenAI API key not found - AI features will be simulated');
    }
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }

    // Gemini media generation (images + native TTS) — free-tier alternative to OpenAI
    const geminiKey = resolvedCredentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.gemini = new GoogleGenAI({ apiKey: geminiKey });
        this.logger.info('Gemini media service initialized (images + TTS)');
      } catch (error) {
        this.logger.warn('Failed to initialize Gemini media service:', error.message);
      }
    }
    
    // ElevenLabs configuration
    this.elevenLabsApiKey = resolvedCredentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = resolvedCredentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;
    this.elevenLabsModel = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v3';
    
    // Azure Speech configuration
    this.azureSpeechKey = resolvedCredentials.azure?.speechKey || process.env.AZURE_SPEECH_KEY;
    this.azureSpeechRegion = resolvedCredentials.azure?.speechRegion || process.env.AZURE_SPEECH_REGION;
    this.mediaGeneration = options.mediaGeneration || (this.db
      ? new MediaGenerationService(this.db, resolvedCredentials, { logger: this.logger })
      : null);
  }

  async generateTTSAudio(text, outputPath) {
    this.logger.info('Generating TTS audio...');
    this.lastNarrationResult = null;
    let provider = 'simulation';
    let model = null;

    try {
      let generatedPath;
      // TTS_PROVIDER pins the narration voice (gemini | elevenlabs | openai). Unset or "auto"
      // keeps the original order: ElevenLabs, then OpenAI, then Gemini.
      const preferred = String(process.env.TTS_PROVIDER || 'auto').trim().toLowerCase();
      const can = {
        elevenlabs: Boolean(this.elevenLabsApiKey && this.elevenLabsVoiceId),
        openai: Boolean(this.openai),
        gemini: Boolean(this.gemini)
      };
      if (preferred !== 'auto' && !(preferred in can)) {
        throw new Error(`TTS_PROVIDER "${preferred}" is not supported; use gemini, elevenlabs, openai or auto`);
      }
      if (preferred !== 'auto' && !can[preferred]) {
        throw new Error(`TTS_PROVIDER is ${preferred} but its API key${preferred === 'elevenlabs' ? ' or voice ID' : ''} is not configured`);
      }
      const use = id => preferred === id || (preferred === 'auto' && can[id] &&
        !Object.keys(can).slice(0, Object.keys(can).indexOf(id)).some(earlier => can[earlier]));
      if (use('elevenlabs')) {
        provider = 'elevenlabs';
        model = this.elevenLabsModel;
        generatedPath = await this.generateElevenLabsTTS(text, outputPath);
      } else if (use('openai')) {
        provider = 'openai';
        model = 'gpt-4o-mini-tts';
        generatedPath = await this.generateOpenAITTS(text, outputPath);
      } else if (use('gemini')) {
        provider = 'gemini';
        model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
        generatedPath = await this.generateGeminiTTS(text, outputPath);
      } else {
        generatedPath = await this.simulateTTSGeneration(text, outputPath);
      }

      const usable = await this.isUsableAudioFile(generatedPath);
      this.lastNarrationResult = {
        status: usable ? 'ready' : 'unavailable',
        path: generatedPath,
        provider,
        model,
        externalTaskId: null,
        generatedAt: new Date().toISOString(),
        simulated: !usable,
        cost: { provider, amount: null, currency: null, invoiceRequired: provider !== 'simulation' }
      };
      return generatedPath;
    } catch (error) {
      this.lastNarrationResult = {
        status: 'failed', path: null, provider, model, externalTaskId: null,
        generatedAt: new Date().toISOString(), simulated: false, error: error.message,
        cost: { provider, amount: null, currency: null, invoiceRequired: provider !== 'simulation' }
      };
      this.logger.error('TTS generation failed:', error);
      throw error;
    }
  }

  async generateElevenLabsTTS(text, outputPath) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;
    
    const data = {
      text: text,
      model_id: this.elevenLabsModel,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const response = await axios({
      method: 'POST',
      url: url,
      data: data,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey
      },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        this.logger.info('ElevenLabs TTS generation complete');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  }

  async generateOpenAITTS(text, outputPath) {
    const response = await this.openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  async generateGeminiTTS(text, outputPath, options = {}) {
    const model = options.model || process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
    const voiceName = options.voice || process.env.GEMINI_TTS_VOICE || 'Kore';
    // Gemini TTS follows a spoken-style direction placed before the text to read.
    const prompt = options.style ? `${options.style.trim()}\n\n${text}` : text;

    const response = await this.gemini.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    });

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error('Gemini TTS returned no audio data');
    }

    // Gemini returns raw PCM (24kHz, mono, 16-bit); encode to the requested container via FFmpeg
    const pcmPath = outputPath + '.pcm';
    await fs.writeFile(pcmPath, Buffer.from(audioData, 'base64'));
    await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, outputPath]);
    await fs.unlink(pcmPath).catch(() => {});

    this.logger.info(`Gemini TTS generation complete (${model}, ${voiceName})`);
    return outputPath;
  }

  // Video style settings (DB settings, overridable by env): video_style documentary|stock,
  // burn_subtitles, archive_allow_share_alike, channel_name.
  async videoStyleSettings() {
    const stored = this.db?.getAllSettings ? await this.db.getAllSettings().catch(() => ({})) : {};
    const flag = (value, fallback) => value === undefined || value === null || value === '' ? fallback : !/^(false|0|no|off)$/i.test(String(value));
    return {
      style: String(process.env.VIDEO_STYLE || stored.video_style || 'stock').toLowerCase(),
      burnSubtitles: flag(process.env.BURN_SUBTITLES ?? stored.burn_subtitles, true),
      allowShareAlike: flag(process.env.ARCHIVE_ALLOW_SHARE_ALIKE ?? stored.archive_allow_share_alike, false),
      channelName: stored.channel_name || 'The Unknown Archive'
    };
  }

  // Narration settings: Gemini voice, spoken-style direction and the model fallback order.
  // Each Gemini TTS model has its own free daily request quota, so a list keeps narration
  // working when one model is used up.
  async narrationSettings() {
    const stored = this.db?.getAllSettings ? await this.db.getAllSettings().catch(() => ({})) : {};
    const models = String(process.env.GEMINI_TTS_MODELS || stored.narration_models || process.env.GEMINI_TTS_MODEL ||
      'gemini-3.1-flash-tts-preview,gemini-3.8-flash-tts,gemini-2.5-flash-preview-tts,gemini-2.5-pro-preview-tts')
      .split(',').map(value => value.trim()).filter(Boolean);
    return {
      voice: process.env.GEMINI_TTS_VOICE || stored.narration_voice || 'Iapetus',
      style: process.env.NARRATION_STYLE || stored.narration_style || DEFAULT_NARRATION_STYLE,
      models,
      chunkWords: Math.min(400, Math.max(80, Number(process.env.NARRATION_CHUNK_WORDS || stored.narration_chunk_words || 230))),
      paragraphPause: 0.55,
      chunkPause: 0.85
    };
  }

  // Narration with real sentence timings, used for accurate subtitles and sentence-synced
  // visuals. paragraphs: [{label, text}] in reading order. Writes a mastered MP3 to outputPath
  // and returns {path, duration, sentences:[{text,label,start,end}], cues:[{start,end,text}]}.
  async generateTimedNarration(paragraphs, outputPath, options = {}) {
    const { chunkParagraphs, parseSilences, alignSentences, buildCues } = require('./narration-timing');
    const settings = { ...(await this.narrationSettings()), ...options };
    const chunks = chunkParagraphs(paragraphs.filter(p => p && String(p.text || '').trim()), settings.chunkWords);
    if (!chunks.length) throw new Error('Narration has no text');
    const workDir = `${outputPath}.parts`;
    await fs.mkdir(workDir, { recursive: true });
    const preferred = String(process.env.TTS_PROVIDER || 'auto').trim().toLowerCase();
    const useGemini = Boolean(this.gemini) && (preferred === 'gemini' || (preferred === 'auto' && !this.elevenLabsApiKey && !this.openai));

    // Synthesize every chunk with one model so the voice stays identical across the video;
    // if a model fails for good (daily quota), start over on the next model.
    let rendered = null;
    let lastError = null;
    const models = useGemini ? settings.models : [null];
    for (const model of models) {
      try {
        rendered = [];
        for (const [index, chunk] of chunks.entries()) {
          progress.update('video', { step: 'voice', fraction: index / chunks.length, detail: `Recording part ${index + 1} of ${chunks.length}` });
          const wav = path.join(workDir, `chunk_${String(index).padStart(3, '0')}.wav`);
          await this.synthesizeNarrationChunk(chunk, wav, { ...settings, model, useGemini });
          rendered.push(wav);
        }
        this.lastNarrationModel = model;
        break;
      } catch (error) {
        lastError = error;
        rendered = null;
        if (useGemini) this.logger.warn(`Narration with ${model} failed (${this.shortError(error)}); trying the next voice model`);
      }
    }
    if (!rendered) throw lastError || new Error('Narration failed');

    // Time every sentence inside its chunk, then lay chunks end to end with a short pause.
    const sentences = [];
    const concatList = [];
    let offset = 0;
    for (const [index, wav] of rendered.entries()) {
      const duration = await this.getMediaDuration(wav);
      const { stderr } = await runFFmpeg(['-hide_banner', '-i', wav, '-af', 'silencedetect=noise=-38dB:d=0.18', '-f', 'null', '-']);
      const timed = alignSentences(chunks[index].sentences, parseSilences(stderr), duration);
      timed.forEach((item, i) => sentences.push({
        text: item.text, label: chunks[index].sentences[i].label,
        start: Number((item.start + offset).toFixed(3)), end: Number((item.end + offset).toFixed(3))
      }));
      concatList.push(wav);
      offset += duration;
      if (index < rendered.length - 1) {
        const gap = path.join(workDir, `gap_${index}.wav`);
        await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(settings.chunkPause), gap]);
        concatList.push(gap);
        offset += settings.chunkPause;
      }
    }

    // Master: gentle high-pass, light compression and broadcast loudness (-16 LUFS), 48 kHz.
    // None of these filters change timing, so the sentence times above stay exact.
    progress.update('video', { step: 'voice', fraction: 0.95, detail: 'Timing subtitles and mastering audio' });
    const listPath = path.join(workDir, 'concat.txt');
    await fs.writeFile(listPath, concatList.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
    await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-af', 'highpass=f=70,acompressor=threshold=-20dB:ratio=2.5:attack=15:release=200,loudnorm=I=-16:TP=-1.5:LRA=11',
      '-ar', '48000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '192k', outputPath]);
    const duration = await this.getMediaDuration(outputPath);
    const cues = buildCues(sentences);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    this.logger.info(`Timed narration ready: ${sentences.length} sentences, ${cues.length} subtitle cues, ${duration.toFixed(1)}s`);
    return { path: outputPath, duration, sentences, cues, model: this.lastNarrationModel, voice: useGemini ? settings.voice : null };
  }

  // One chunk to a 48 kHz mono WAV. A result far shorter or longer than the text implies
  // (voice skipped lines, or read the direction aloud) is retried once.
  async synthesizeNarrationChunk(chunk, wavPath, settings) {
    const words = chunk.words || chunk.text.split(/\s+/).length;
    const raw = wavPath.replace(/\.wav$/, settings.useGemini ? '_raw.wav' : '_raw.mp3');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (settings.useGemini) {
          await this.withTTSRetry(() => this.generateGeminiTTS(chunk.text, raw, { model: settings.model, voice: settings.voice, style: settings.style }));
        } else {
          await this.generateTTSAudio(chunk.text, raw);
        }
        await runFFmpeg(['-y', '-i', raw, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]);
        await fs.unlink(raw).catch(() => {});
        const seconds = await this.getMediaDuration(wavPath);
        const wordsPerSecond = words / Math.max(0.1, seconds);
        if (wordsPerSecond < 1.0 || wordsPerSecond > 4.2) {
          throw Object.assign(new Error(`chunk pace ${wordsPerSecond.toFixed(2)} words/s looks wrong (${words} words in ${seconds.toFixed(1)}s)`), { retryable: true });
        }
        return wavPath;
      } catch (error) {
        if (error.retryable !== true || attempt === 3) throw error;
        this.logger.warn(`Narration chunk retry: ${error.message}`);
      }
    }
    return wavPath;
  }

  // Retries temporary TTS failures (server busy, per-minute limits). A per-day quota error is
  // final for this model and is thrown at once so the caller can move to the next model.
  async withTTSRetry(run, attempts = 4) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        const text = String(error?.message || error);
        const daily = /per day|PerDay/i.test(text);
        // An empty audio reply is a known transient Gemini TTS hiccup: retry the same model.
        const temporary = /\b(429|500|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|high demand|ECONNRESET|ETIMEDOUT|socket hang up|returned no audio data|fetch failed/i.test(text);
        if (daily || !temporary || attempt >= attempts) throw error;
        const hinted = Number((text.match(/retry in ([\d.]+)s/i) || [])[1]);
        const wait = Math.min(75, Number.isFinite(hinted) && hinted > 0 ? hinted + 1 : 8 * attempt);
        this.logger.warn(`TTS busy (${this.shortError(error)}); retrying in ${Math.round(wait)}s`);
        await new Promise(resolve => setTimeout(resolve, wait * 1000));
      }
    }
  }

  shortError(error) {
    const text = String(error?.message || error);
    const m = text.match(/"message":"([^"]{0,140})/);
    return (m ? m[1] : text).replace(/\s+/g, ' ').slice(0, 140);
  }

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    this.logger.info(`Generating ${count} visual assets with style: ${style}`);

    try {
      if (!this.openai && !this.gemini) {
        return await this.simulateVisualAssets(prompt, style, count);
      }

      const enhancedPrompt = this.enhanceVisualPrompt(prompt, style);
      const localPaths = [];

      for (let i = 0; i < count; i++) {
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${i}.png`);
        await this.generateImage(enhancedPrompt, imagePath);
        localPaths.push(imagePath);
      }

      this.logger.info(`Generated ${localPaths.length} visual assets`);
      return localPaths;
    } catch (error) {
      this.logger.error('Visual asset generation failed:', error);
      return await this.simulateVisualAssets(prompt, style, count);
    }
  }

  async generateImage(prompt, imagePath) {
    await fs.mkdir(path.dirname(imagePath), { recursive: true });

    const providers = [];
    if (this.openai) {
      providers.push({ name: 'OpenAI', model: OPENAI_IMAGE_MODEL, run: () => this.generateOpenAIImage(prompt, imagePath) });
    }
    if (this.gemini) {
      providers.push({ name: 'Gemini', model: this.geminiImageModel(), run: () => this.generateGeminiImage(prompt, imagePath) });
    }
    if (!providers.length) {
      throw new Error('No image generation provider configured');
    }

    // Try every configured provider before giving up, so a broken OpenAI key
    // does not hide a working Gemini key (or the reverse).
    const failures = [];
    for (const [index, provider] of providers.entries()) {
      try {
        return await provider.run();
      } catch (error) {
        const description = describeImageProviderError(provider.name, provider.model, error);
        failures.push(description);
        if (index < providers.length - 1) {
          this.logger.warn(`${description} Trying ${providers[index + 1].name} instead.`);
        }
      }
    }

    const error = new Error(failures.join(' | '));
    error.providerFailures = failures;
    throw error;
  }

  geminiImageModel() {
    return process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  }

  async generateOpenAIImage(prompt, imagePath) {
    const response = await this.openai.images.generate({
      model: OPENAI_IMAGE_MODEL,
      prompt: prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
    });

    if (response.data[0].b64_json) {
      const buffer = Buffer.from(response.data[0].b64_json, 'base64');
      await fs.writeFile(imagePath, buffer);
    } else {
      await this.downloadImage(response.data[0].url, imagePath);
    }

    return imagePath;
  }

  async generateGeminiImage(prompt, imagePath) {
    const model = this.geminiImageModel();

    const response = await this.gemini.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: '16:9',
          imageSize: '1K'
        }
      }
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imageParts = parts.filter(part =>
      part.inlineData?.data && (!part.inlineData.mimeType || part.inlineData.mimeType.startsWith('image/'))
    );
    const renderedImages = imageParts.filter(part => part.thought !== true);
    const imagePart = (renderedImages.length ? renderedImages : imageParts).at(-1);
    if (!imagePart) {
      throw new Error('Gemini image generation returned no image data');
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Gemini image generation returned an invalid image asset');
    }

    const extension = path.extname(imagePath).toLowerCase();
    const output = sharp(imageBuffer, { failOn: 'error' });
    if (extension === '.jpg' || extension === '.jpeg') {
      await output.jpeg({ quality: 92 }).toFile(imagePath);
    } else if (extension === '.webp') {
      await output.webp({ quality: 92 }).toFile(imagePath);
    } else {
      await output.png().toFile(imagePath);
    }
    return imagePath;
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      ethereal: "ethereal, dreamy, mystical, soft lighting, floating particles, cosmic background",
      modern: "modern, clean, minimalist, professional, sleek design, contemporary",
      animated: "animated style, cartoon, vibrant colors, expressive, dynamic",
      cinematic: "cinematic lighting, dramatic, movie poster style, high contrast",
      abstract: "abstract art, geometric shapes, gradient colors, artistic composition"
    };

    const normalizedStyle = String(style || '').trim().toLowerCase();
    const enhancement = styleEnhancements[normalizedStyle] || String(style || '').trim() || styleEnhancements.ethereal;
    return `${prompt}, ${enhancement}, high quality, 16:9 aspect ratio, digital art`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async generateVideo(script, visualAssets, audioPath, outputPath, options = {}) {
    this.logger.info('Generating video from assets...');
    this.lastVideoResult = null;
    try {
      // Motion-documentary style: visuals cut on the narration's real sentence timings, with
      // maps, archive images, cards and burned-in subtitles. Needs timed narration.
      const style = await this.videoStyleSettings();
      // Animated-illustration style: each narration sentence becomes a drawn scene (map, stat,
      // portrait, timeline, fireball, explosion, ...) timed to that sentence. Needs timed narration.
      if (style.style === 'animation' && options.timing?.sentences?.length) {
        const result = await this.renderAnimationVideo(script, audioPath, outputPath, options);
        this.lastVideoResult = {
          requestedProvider: 'animation', actualProvider: 'animation', model: 'local-ffmpeg', mode: 'animation',
          realFootage: false, credits: [], generatedSeconds: 0, stockSeconds: 0, subtitlesBurned: true,
          visualCounts: { scenes: result.scenes.length }, tasks: [], scenes: result.scenes
        };
        return result.path;
      }
      if (style.style === 'documentary' && options.timing?.sentences?.length && this.mediaGeneration) {
        const { DocumentaryRenderer } = require('./documentary-renderer');
        const renderer = new DocumentaryRenderer({ aiText: this.mediaGeneration.aiText, mediaGeneration: this.mediaGeneration, logger: this.logger });
        const stockSettings = await this.mediaGeneration.settings();
        const result = await renderer.render({
          productionId: options.productionId, script, timing: options.timing, audioPath, outputPath,
          settings: { ...style, mood: stockSettings.stockMood }
        });
        this.lastVideoResult = {
          requestedProvider: 'documentary', actualProvider: 'documentary', model: 'local-ffmpeg', mode: 'documentary',
          realFootage: true, credits: result.credits, generatedSeconds: 0, stockSeconds: result.stockSeconds,
          subtitlesBurned: style.burnSubtitles !== false, visualCounts: result.counts,
          tasks: result.scenes.map(scene => ({ scene: scene.index, taskId: scene.taskId, provider: scene.provider, model: scene.model })),
          scenes: result.scenes
        };
        return result.path;
      }

      if (this.mediaGeneration && options.productionId) {
        // Size the visuals to the real narration when we can measure it.
        let narrationSeconds = null;
        try {
          narrationSeconds = audioPath ? await this.getMediaDuration(audioPath) : null;
        } catch (_error) { narrationSeconds = null; }
        const targetDuration = narrationSeconds || this.parseDurationSeconds(options.estimatedDuration) ||
          this.parseDurationSeconds(this.calculateScriptDuration(script));
        const generated = await this.mediaGeneration.generateClips({
          jobId: options.jobId || null,
          productionId: options.productionId,
          script,
          visualAssets,
          outputDir: path.dirname(outputPath),
          targetDuration
        });
        if (generated.clips.length) {
          const produced = await this.generateHybridVideo(
            generated.clips,
            visualAssets,
            audioPath,
            outputPath,
            targetDuration
          );
          const realFootage = generated.realFootage === true;
          this.lastVideoResult = {
            requestedProvider: generated.requestedProvider,
            actualProvider: generated.actualProvider,
            model: generated.model,
            mode: generated.settings.mode,
            realFootage,
            credits: generated.credits || [],
            // Paid-cap accounting counts generative seconds only; stock footage is free.
            generatedSeconds: realFootage ? 0 : generated.clips.reduce((total, clip) => total + clip.duration, 0),
            stockSeconds: realFootage ? generated.clips.reduce((total, clip) => total + clip.duration, 0) : 0,
            tasks: generated.clips.map(clip => ({ scene: clip.index, taskId: clip.taskId, provider: clip.provider, model: clip.model })),
            scenes: generated.clips.map(clip => ({
              index: clip.index, label: clip.label, prompt: clip.prompt, duration: clip.duration,
              path: clip.path, taskId: clip.taskId, provider: clip.provider, model: clip.model,
              attribution: clip.attribution || null
            }))
          };
          return produced;
        }
      }

      const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
      this.lastVideoResult = { requestedProvider: 'slideshow', actualProvider: 'slideshow', model: 'local-ffmpeg', mode: 'slideshow', generatedSeconds: 0, tasks: [], scenes: [] };
      return produced;
    } catch (error) {
      // The Logger's console line only shows the message string, so put the real
      // reason inline. Previously the stack alone went to the file transport and
      // the console printed "Video generation failed:" with no detail.
      const reason = error && error.message ? error.message : String(error);
      this.logger.error(`Video provider generation failed; using the local slideshow: ${reason}`, error);
      try {
        const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
        this.lastVideoResult = {
          requestedProvider: this.lastVideoResult?.requestedProvider || 'configured-provider',
          actualProvider: 'slideshow', model: 'local-ffmpeg', mode: 'fallback', generatedSeconds: 0,
          fallbackReason: reason, tasks: [], scenes: []
        };
        return produced;
      } catch (fallbackError) {
        this.logger.error(`Local slideshow fallback failed: ${fallbackError.message}`, fallbackError);
        const produced = await this.simulateVideoGeneration(script, visualAssets, audioPath, outputPath);
        this.lastVideoResult = {
          requestedProvider: 'configured-provider', actualProvider: 'simulation', model: null,
          mode: 'simulation', generatedSeconds: 0, fallbackReason: `${reason}; ${fallbackError.message}`, tasks: [], scenes: []
        };
        return produced;
      }
    }
  }

  // Render the animated-illustration style: storyboard each narration sentence into a drawn scene,
  // time the scenes to the sentences, and mux the already-generated narration audio.
  async renderAnimationVideo(script, audioPath, outputPath, options = {}) {
    const { buildStoryboard, validateBoard, STORYBOARD_PROMPT } = require('./animation/storyboard');
    const { AnimationRenderer } = require('./animation/renderer');
    const sentences = options.timing.sentences;
    const title = options.title || (script && script.title) || 'Curious Files';
    const sbScript = {
      title, subtitle: options.subtitle || '', sourceNote: options.sourceNote || '',
      loc: options.loc || null, beats: sentences.map(s => (typeof s === 'string' ? s : s.text))
    };
    // The deterministic storyboard is the reliable baseline; an AI director can refine it when
    // available, but any invalid reply falls back per-beat so a render never breaks.
    let board = buildStoryboard(sbScript);
    if (options.useAiDirector && this.mediaGeneration?.aiText?.generate) {
      try {
        const reply = await this.mediaGeneration.aiText.generate(`${STORYBOARD_PROMPT}\n\nTitle: ${title}\nScript: ${JSON.stringify(sbScript.beats)}\n\nReturn only the JSON array.`);
        const json = JSON.parse(String(reply).replace(/^[^\[]*/, '').replace(/[^\]]*$/, ''));
        board = validateBoard(json, sbScript);
      } catch (error) { this.logger.warn(`AI storyboard director failed, using the heuristic: ${error.message}`); }
    }
    // Time each scene to its sentence, tiling the whole narration timeline (no gaps).
    let audioDur = null;
    try { audioDur = audioPath ? await this.getMediaDuration(audioPath) : null; } catch (_e) { audioDur = null; }
    const end = audioDur || (sentences[sentences.length - 1] && sentences[sentences.length - 1].end) || sentences.length * 4;
    const bounds = sentences.map((s, i) => (i === 0 ? 0 : (typeof s === 'string' ? i * 4 : s.start)));
    bounds.push(end);
    const beatSeconds = sentences.map((_s, i) => Math.max(0.6, bounds[i + 1] - bounds[i]));
    const renderer = new AnimationRenderer({
      logger: this.logger,
      onProgress: (p) => { if (p >= 0.999 || Math.round(p * 100) % 25 === 0) this.logger.info(`Animating ${Math.round(p * 100)}%`); }
    });
    const res = await renderer.render(board, {
      outputPath, audioPath, beatSeconds,
      workDir: path.join(path.dirname(outputPath), `anim-${path.basename(outputPath, '.mp4')}`)
    });
    return { path: res.outputPath, scenes: board.map((b, i) => ({ index: i, label: b.tpl, duration: beatSeconds[i] })) };
  }

  async generateHybridVideo(clips, visualAssets, audioPath, outputPath, totalDuration) {
    if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());
    const validImages = await this.filterLocalImageAssets(visualAssets);
    const segments = clips.map(clip => ({ type: 'video', path: clip.path, duration: clip.duration }));
    const generatedDuration = segments.reduce((sum, item) => sum + item.duration, 0);
    const remaining = Math.max(0, this.parseDurationSeconds(totalDuration) - generatedDuration);
    if (remaining && validImages.length) {
      const perImage = Math.max(2, remaining / validImages.length);
      for (const imagePath of validImages) segments.push({ type: 'image', path: imagePath, duration: perImage });
    }
    if (!segments.length) throw new Error('No usable provider clips or still images were generated');

    const visualPath = outputPath.replace(/\.mp4$/i, '_hybrid_visual.mp4');
    await this.renderMediaTimeline(segments, visualPath);
    await this.addAudioToVideo(visualPath, audioPath, outputPath, { loopVideo: true });
    await fs.unlink(visualPath).catch(() => {});
    return outputPath;
  }

  async renderMediaTimeline(segments, outputPath) {
    const args = ['-y'];
    for (const segment of segments) {
      const duration = Number(segment.duration).toFixed(2);
      if (segment.type === 'image') args.push('-loop', '1', '-t', duration, '-framerate', '30', '-i', segment.path);
      // Loop short clips to fill their slot, but bound the input: an unbounded
      // -stream_loop keeps FFmpeg decoding long after trim has what it needs.
      else args.push('-stream_loop', '-1', '-t', duration, '-i', segment.path);
    }
    const filters = segments.map((segment, index) =>
      `[${index}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p,trim=duration=${Number(segment.duration).toFixed(2)},setpts=PTS-STARTPTS[v${index}]`
    );
    filters.push(`${segments.map((_, index) => `[v${index}]`).join('')}concat=n=${segments.length}:v=1:a=0[vout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath);
    await runFFmpeg(args);
    return outputPath;
  }

  async filterLocalImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];
    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) continue;
      try {
        await fs.access(asset);
        images.push(asset);
      } catch (_error) { /* ignore missing assets */ }
    }
    return images;
  }

  parseDurationSeconds(value) {
    if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
    const parts = String(value || '').split(':').map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 60 + parts[1]);
    if (parts.length === 3 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    return 0;
  }

  async generateReplicateVideo(script, visualAssets, audioPath, outputPath) {
    const output = await this.replicate.run(
      "wan-video/wan-2.7-i2v",
      {
        input: {
          image: visualAssets[0],
          prompt: script.title || "smooth cinematic motion",
          duration: 5,
          resolution: "720p"
        }
      }
    );

    // Download the generated video
    if (output && output.length > 0) {
      await this.downloadVideo(output[0], outputPath);
      
      // Add audio track
      await this.addAudioToVideo(outputPath, audioPath, outputPath);
    }

    return outputPath;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Creating slideshow video...');

    if (!(await checkFFmpeg())) {
      throw new Error(ffmpegInstallHint());
    }

    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const slidesDir = path.join(path.dirname(outputPath), 'slides');

    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1920, height: 1080 });

      // Create HTML for slideshow (only real image files can be embedded)
      const imageAssets = await this.filterImageAssets(visualAssets);
      await page.setContent(this.createSlideshowHTML(script, imageAssets));

      // Freeze CSS transitions/animations so each still is captured fully rendered
      await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
      await page.waitForTimeout(1000); // Wait for assets to load

      // Capture ONE still per slide instead of screenshotting at 30fps —
      // FFmpeg turns the stills into a crossfaded video in seconds.
      const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
      await fs.mkdir(slidesDir, { recursive: true });

      const stills = [];
      for (let i = 0; i < slideCount; i++) {
        await page.evaluate((index) => {
          document.querySelectorAll('.slide').forEach((slide, s) => {
            slide.classList.toggle('active', s === index);
          });
        }, i);

        const stillPath = path.join(slidesDir, `slide_${String(i).padStart(3, '0')}.png`);
        await page.screenshot({ path: stillPath });
        stills.push(stillPath);
      }

      const videoPath = outputPath.replace('.mp4', '_visual.mp4');
      const duration = await this.resolveSlideshowDuration(script, audioPath);
      await this.renderSlidesToVideo(stills, duration, videoPath);

      // Add audio
      await this.addAudioToVideo(videoPath, audioPath, outputPath);

      return outputPath;
    } finally {
      await browser.close().catch(() => {});
      await this.cleanupDirectory(slidesDir);
    }
  }

  async resolveSlideshowDuration(script, audioPath) {
    try {
      return (await this.getMediaDuration(audioPath)) + 0.5;
    } catch (error) {
      this.logger.warn(`Could not read narration duration, falling back to word-count estimate: ${error.message}`);
      return this.calculateScriptDuration(script);
    }
  }

  async renderSlidesToVideo(stills, totalDuration, videoPath) {
    if (stills.length === 0) {
      throw new Error('No slides to render');
    }

    const fade = 0.5;
    const overlapDuration = fade * Math.max(0, stills.length - 1);
    const perSlide = Math.max(2, (totalDuration + overlapDuration) / stills.length);

    const args = ['-y'];
    for (const still of stills) {
      args.push('-loop', '1', '-t', perSlide.toFixed(2), '-framerate', '30', '-i', still);
    }

    if (stills.length === 1) {
      args.push('-vf', 'format=yuv420p', '-c:v', 'libx264', videoPath);
      await runFFmpeg(args);
      return videoPath;
    }

    // Chain crossfades: transition k starts fade seconds before slide k ends
    const filters = [];
    let prev = '[0:v]';
    for (let i = 1; i < stills.length; i++) {
      const out = `[v${i}]`;
      const offset = (i * (perSlide - fade)).toFixed(2);
      filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
      prev = out;
    }
    filters.push(`${prev}format=yuv420p[vfinal]`);

    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vfinal]',
      '-c:v', 'libx264',
      '-r', '30',
      videoPath
    );

    await runFFmpeg(args);
    return videoPath;
  }

  async filterImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const mimeTypes = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp'
    };
    const images = [];

    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) {
        continue;
      }

      try {
        const imageBuffer = await fs.readFile(asset);
        const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
        const mimeType = mimeTypes[metadata.format];
        if (mimeType && metadata.width && metadata.height) {
          images.push(`data:${mimeType};base64,${imageBuffer.toString('base64')}`);
        }
      } catch (_error) {
        // Skip missing or invalid image files
      }
    }

    return images;
  }

  createSlideshowHTML(script, visualAssets) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1920px;
            height: 1080px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }
        
        .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }
        
        .slide.active {
            opacity: 1;
        }
        
        .content {
            position: relative;
            z-index: 2;
            text-align: center;
            color: white;
            max-width: 80%;
        }
        
        h1 {
            font-size: 72px;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        h2 {
            font-size: 48px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        p {
            font-size: 36px;
            line-height: 1.4;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .background-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            z-index: 0;
        }

        /* Darkens the image just enough to keep the slide text readable */
        .scrim {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.6) 100%);
            z-index: 1;
        }

        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            z-index: -1;
        }
        
        .particle {
            position: absolute;
            background: rgba(255,255,255,0.8);
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>
    
    <!-- Title Slide -->
    <div class="slide active">
        ${visualAssets[0] ? `<img class="background-image" src="${visualAssets[0]}" /><div class="scrim"></div>` : ''}
        <div class="content">
            <h1>${script.title}</h1>
        </div>
    </div>

    ${this.generateContentSlides(script, visualAssets).join('')}

    <!-- Subscribe Slide -->
    <div class="slide">
        <div class="content">
            <h2>Thanks for watching</h2>
            <p>Subscribe for more videos like this</p>
        </div>
    </div>
    
    <script>
        // Create floating particles
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 4 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 6 + 's';
                container.appendChild(particle);
            }
        }
        
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }
        
        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        const assetIndex = Math.min(index + 1, visualAssets.length - 1);
        
        slides.push(`
        <div class="slide">
            ${visualAssets[assetIndex] ? `<img class="background-image" src="${visualAssets[assetIndex]}" /><div class="scrim"></div>` : ''}
            <div class="content">
                <h2>${section.title}</h2>
                ${this.formatSectionContent(section)}
            </div>
        </div>`);
      });
    }
    
    return slides;
  }

  formatSectionContent(section) {
    if (section.items && Array.isArray(section.items)) {
      return section.items.slice(0, 3).map(item => 
        `<p>${item.number}. ${item.title}</p>`
      ).join('');
    }
    
    if (section.steps && Array.isArray(section.steps)) {
      return section.steps.slice(0, 3).map(step => 
        `<p>${step.title}</p>`
      ).join('');
    }
    
    // Script writers store spoken lines as an array of strings
    if (Array.isArray(section.content)) {
      return section.content
        .filter(line => typeof line === 'string' && line.trim())
        .slice(0, 3)
        .map(line => `<p>${line.slice(0, 120)}${line.length > 120 ? '...' : ''}</p>`)
        .join('');
    }

    if (typeof section.content === 'string') {
      return `<p>${section.content.slice(0, 200)}${section.content.length > 200 ? '...' : ''}</p>`;
    }

    return '';
  }

  calculateScriptDuration(script) {
    // Estimate duration based on word count (average 150 words per minute)
    let totalWords = 0;
    
    if (script.hook) totalWords += script.hook.text.split(' ').length;
    if (script.introduction) {
      totalWords += (script.introduction.greeting || '').split(' ').length;
      totalWords += (script.introduction.topicIntro || '').split(' ').length;
    }
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (typeof section.content === 'string') {
          totalWords += section.content.split(' ').length;
        }
        if (section.items) {
          section.items.forEach(item => {
            totalWords += (item.title + ' ' + item.description).split(' ').length;
          });
        }
        if (section.steps) {
          section.steps.forEach(step => {
            totalWords += (step.title + ' ' + step.description).split(' ').length;
          });
        }
      });
    }
    
    if (script.conclusion) {
      totalWords += script.conclusion.finalThought.split(' ').length;
    }
    
    // Convert to duration (150 words per minute)
    return Math.max(30, Math.ceil((totalWords / 150) * 60));
  }

  async addAudioToVideo(videoPath, audioPath, outputPath, options = {}) {
    const hasRealAudio = await this.isUsableAudioFile(audioPath);

    if (!hasRealAudio) {
      if (options.allowSilent === true) {
        this.logger.warn('Creating an intentionally silent video from an operator-confirmed override.');
        if (videoPath !== outputPath) await fs.copyFile(videoPath, outputPath);
        return outputPath;
      }
      const error = new Error('Narration audio is required. Regenerate narration or explicitly confirm an intentional silent video.');
      error.code = 'NARRATION_REQUIRED';
      throw error;
    }

    // FFmpeg cannot write to its own input, so mux to a temp file when paths collide
    const muxPath = outputPath === videoPath
      ? outputPath.replace(/\.mp4$/i, '_muxed.mp4')
      : outputPath;

    // With -c:v copy, -shortest does not stop an infinitely looped video input: FFmpeg kept
    // writing until the disk filled (375 GB in one run). Always bound the output explicitly:
    // -t at the narration length, and -fs as a hard size ceiling. If the narration length
    // cannot be measured, do not loop at all.
    let narrationSeconds = null;
    try {
      narrationSeconds = await this.getMediaDuration(audioPath);
    } catch (_error) { narrationSeconds = null; }
    const canLoop = options.loopVideo && Number.isFinite(narrationSeconds) && narrationSeconds > 0;
    const videoInput = canLoop ? ['-stream_loop', '-1', '-i', videoPath] : ['-i', videoPath];
    const bound = Number.isFinite(narrationSeconds) && narrationSeconds > 0 ? ['-t', narrationSeconds.toFixed(3)] : [];
    const maxBytes = String(Number(process.env.FFMPEG_MAX_OUTPUT_BYTES) || 8 * 1024 * 1024 * 1024);
    await runFFmpeg(['-y', ...videoInput, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
      '-shortest', ...bound, '-fs', maxBytes, muxPath]);

    if (muxPath !== outputPath) {
      await fs.rename(muxPath, outputPath);
    }

    this.logger.info('Audio added to video successfully');
    return outputPath;
  }

  async isUsableAudioFile(audioPath) {
    if (typeof audioPath !== 'string' || audioPath.endsWith('.info')) {
      return false;
    }

    try {
      const stats = await fs.stat(audioPath);
      return stats.isFile() && stats.size > 0;
    } catch (error) {
      return false;
    }
  }

  async downloadVideo(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  async generateThumbnail(script, style = "ethereal") {
    this.logger.info('Generating custom thumbnail...');

    try {
      // Animated style: draw a hero scene + bold title in code (free, on-brand, honest).
      const vstyle = await this.videoStyleSettings();
      if (vstyle.style === 'animation') {
        const { renderThumbnail } = require('./animation/thumbnail');
        const dir = path.join(__dirname, '..', 'uploads', 'thumbnails');
        await fs.mkdir(dir, { recursive: true });
        const out = path.join(dir, `anim_thumb_${Date.now()}.png`);
        await renderThumbnail({ title: script.title || 'Curious Files', hint: `${script.title || ''} ${script.summary || script.angle || ''}`, outputPath: out });
        const metadata = await sharp(out).metadata();
        return { path: out, dimensions: { width: metadata.width, height: metadata.height }, fileSize: await this.getFileSize(out) };
      }
      if (!this.openai && !this.gemini) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const prompt = `YouTube thumbnail for "${script.title}", ${style} style, eye-catching, high contrast text, professional design, clickable, engaging`;
      const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${Date.now()}.png`);

      await this.generateImage(prompt, thumbnailPath);
      const metadata = await sharp(thumbnailPath).metadata();

      return {
        path: thumbnailPath,
        dimensions: { width: metadata.width, height: metadata.height },
        fileSize: await this.getFileSize(thumbnailPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      return await this.simulateThumbnailGeneration(script, style);
    }
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateVisualAssets(prompt, style, count) {
    this.logger.info(`Simulating ${count} visual assets...`);
    
    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(__dirname, '..', 'data', 'assets', `visual_sim_${Date.now()}_${i}.info`);
      
      await fs.writeFile(assetPath, JSON.stringify({
        message: 'AI visual asset would be generated here',
        prompt: prompt,
        style: style,
        timestamp: new Date().toISOString()
      }, null, 2));
      
      paths.push(assetPath);
    }
    
    return paths;
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Simulating video generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI video would be generated here',
      script: script.title,
      visualAssets: visualAssets.length,
      audioPath: audioPath,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator, describeImageProviderError };
