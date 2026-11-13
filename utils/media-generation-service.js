const fs = require('fs').promises;
const path = require('path');
const { VideoProviderRegistry, DEFAULT_PROVIDER_ORDER, safeModelError } = require('./video-providers');
const { Logger } = require('./logger');
const { runFFmpeg } = require('./ffmpeg');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

class MediaGenerationService {
  constructor(db, credentials = {}, options = {}) {
    this.db = db;
    this.registry = options.registry || new VideoProviderRegistry(credentials, options.providerOptions);
    this.logger = options.logger || new Logger('MediaGeneration');
    this.pollIntervalMs = Math.max(10, Number(options.pollIntervalMs ?? process.env.VIDEO_PROVIDER_POLL_MS ?? 5000));
    this.maxPollMs = Math.max(1000, Number(options.maxPollMs ?? process.env.VIDEO_PROVIDER_TIMEOUT_MS ?? 60 * 60 * 1000));
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    // Used only to turn scene text into short stock-footage search phrases.
    if (options.aiText !== undefined) {
      this.aiText = options.aiText;
    } else {
      try {
        const { AITextService } = require('./ai-text-service');
        this.aiText = new AITextService(credentials);
      } catch (_error) {
        this.aiText = null;
      }
    }
  }

  async settings() {
    const stored = this.db?.getAllSettings ? await this.db.getAllSettings() : {};
    const provider = process.env.VIDEO_PROVIDER || stored.video_provider || 'slideshow';
    const order = String(process.env.VIDEO_PROVIDER_ORDER || stored.video_provider_order || DEFAULT_PROVIDER_ORDER.join(','))
      .split(',').map(value => value.trim()).filter(Boolean);
    return {
      provider,
      order,
      mode: process.env.VIDEO_GENERATION_MODE || stored.video_generation_mode || 'hybrid',
      clipDuration: Math.max(3, Number(process.env.VIDEO_CLIP_DURATION || stored.video_clip_duration || 8)),
      maxGeneratedSeconds: Math.max(0, Number(process.env.VIDEO_MAX_GENERATED_SECONDS || stored.video_max_generated_seconds || 60)),
      generateAudio: false,
      resolution: process.env.VIDEO_RESOLUTION || stored.video_resolution || '720p',
      aspectRatio: process.env.VIDEO_ASPECT_RATIO || stored.video_aspect_ratio || '16:9',
      // Stock footage is free, so it is not limited by the paid-seconds cap above.
      stockClipSeconds: Math.min(15, Math.max(4, Number(process.env.STOCK_CLIP_SECONDS || stored.stock_clip_seconds || 8)))
    };
  }

  // Ordered narrative scenes with a weight proportional to how much narration they carry.
  sceneTexts(script = {}) {
    const scenes = [];
    if (script.hook?.text || script.title) {
      scenes.push({ label: 'Hook', text: script.hook?.text || script.title });
    }
    for (const section of script.mainContent?.sections || []) {
      const detail = typeof section.content === 'string'
        ? section.content
        : (section.items || section.steps || []).map(item => `${item.title || ''} ${item.description || ''}`).join(' ');
      scenes.push({ label: section.title || 'Scene', text: `${section.title || ''}. ${detail}`.trim() });
    }
    if (script.conclusion?.finalThought) scenes.push({ label: 'Conclusion', text: script.conclusion.finalThought });
    return scenes.map(scene => ({ ...scene, weight: Math.max(1, scene.text.split(/\s+/).length) }));
  }

  // Short stock-library search phrases. Prefers places, objects and nature over people,
  // because the channel bible forbids anything that could read as a real victim.
  async stockQueries(scenes, script = {}) {
    const fallback = scenes.map(scene => this.keywordQuery(`${scene.label} ${scene.text}`));
    if (!this.aiText?.isAvailable?.()) return fallback;
    const prompt = `You choose stock-footage search phrases for a documentary video titled "${script.title || ''}".
For each numbered scene, return ONE search phrase of 2 to 4 plain English words that a stock video library would match.
Rules: describe places, landscapes, weather, objects, documents, maps or atmosphere. Avoid identifiable people, faces,
children, brand names, logos, gore and anything a viewer could mistake for real footage of the actual event.
Return ONLY a JSON array of ${scenes.length} strings, in order.

${scenes.map((scene, index) => `${index + 1}. ${scene.label}: ${scene.text.slice(0, 400)}`).join('\n')}`;
    try {
      const raw = await this.aiText.generateText(prompt, { maxTokens: 600, temperature: 0.4 });
      const match = String(raw || '').match(/\[[\s\S]*\]/);
      const parsed = match ? JSON.parse(match[0]) : [];
      return scenes.map((_, index) => {
        const value = String(parsed[index] || '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
        return value && value.split(' ').length <= 6 ? value : fallback[index];
      });
    } catch (error) {
      this.logger.warn(`Stock query generation failed; using keyword fallback: ${error.message}`);
      return fallback;
    }
  }

  keywordQuery(text) {
    const stop = new Set(('the a an and or of to in on at for with by from as is was were be been it its this that these those ' +
      'there their they them he she his her we you i our your not no but so if then than into over under about after before ' +
      'what which who why how when where while one two three hook scene conclusion video').split(' '));
    const words = String(text).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
      .filter(word => word.length > 3 && !stop.has(word));
    const counts = new Map();
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([word]) => word);
    return top.join(' ') || 'ocean landscape';
  }

  // Fill the whole narration with real stock clips: several distinct clips per scene,
  // scene time proportional to its narration, no clip reused across the video when avoidable.
  async generateStockClips({ provider, script, outputDir, productionId, targetDuration, settings }) {
    const scenes = this.sceneTexts(script);
    if (!scenes.length) return { clips: [], credits: [] };
    const total = Math.max(settings.stockClipSeconds, Number(targetDuration) || 0);
    const totalWeight = scenes.reduce((sum, scene) => sum + scene.weight, 0);
    const queries = await this.stockQueries(scenes, script);
    const targetWidth = /1080/.test(settings.resolution) ? 1920 : 1280;
    const used = new Set();
    const clips = [];
    let index = 0;

    for (const [sceneIndex, scene] of scenes.entries()) {
      const sceneSeconds = (scene.weight / totalWeight) * total;
      const needed = Math.max(1, Math.round(sceneSeconds / settings.stockClipSeconds));
      const slot = sceneSeconds / needed;
      let candidates = [];
      for (const query of [queries[sceneIndex], this.keywordQuery(script.title || ''), 'ocean landscape']) {
        if (candidates.length >= needed) break;
        const found = await provider.search(query, { perPage: Math.min(40, needed + 10), targetWidth });
        candidates.push(...found.filter(item => !used.has(item.id) && !candidates.some(c => c.id === item.id))
          .map(item => ({ ...item, query })));
      }
      if (!candidates.length) {
        this.logger.warn(`No stock footage found for scene "${scene.label}"; it will fall back to stills`);
        continue;
      }
      for (let n = 0; n < needed; n++) {
        const candidate = candidates[n % candidates.length];
        used.add(candidate.id);
        const outputPath = path.join(outputDir, `${productionId}_pexels_${candidate.id}.mp4`);
        try {
          await fs.access(outputPath);
        } catch (_missing) {
          await provider.download(candidate, outputPath);
        }
        if (!await this.isValidVideo(outputPath)) {
          this.logger.warn(`Skipping invalid Pexels clip ${candidate.id}`);
          continue;
        }
        clips.push({
          index: index++,
          label: scene.label,
          prompt: candidate.query,
          duration: Number(slot.toFixed(2)),
          path: outputPath,
          provider: 'pexels',
          model: 'pexels-stock',
          taskId: `pexels:${candidate.id}`,
          attribution: {
            source: 'Pexels',
            videoId: candidate.id,
            videoUrl: candidate.pageUrl,
            photographer: candidate.photographer,
            photographerUrl: candidate.photographerUrl
          }
        });
      }
    }

    const credits = [];
    for (const clip of clips) {
      if (!credits.some(credit => credit.videoId === clip.attribution.videoId)) credits.push(clip.attribution);
    }
    this.logger.info(`Selected ${clips.length} Pexels clips from ${credits.length} videos for ${Math.round(total)}s of narration`);
    return { clips, credits };
  }

  listProviders() { return this.registry.list(); }

  buildScenePlan(script = {}, visualAssets = [], settings = {}) {
    const prompts = [];
    if (script.hook?.text || script.title) {
      prompts.push({
        label: 'Hook',
        prompt: `${script.hook?.text || script.title}. Cinematic opening shot, clear subject, intentional camera movement, no captions or on-screen text.`
      });
    }
    for (const section of script.mainContent?.sections || []) {
      const detail = typeof section.content === 'string'
        ? section.content
        : (section.items || section.steps || []).map(item => `${item.title || ''} ${item.description || ''}`).join(' ');
      prompts.push({
        label: section.title || 'Scene',
        prompt: `${section.title || ''}. ${detail}`.trim() + '. Cinematic explanatory B-roll, natural motion, coherent lighting, no captions or on-screen text.'
      });
    }
    if (script.conclusion?.finalThought) {
      prompts.push({ label: 'Conclusion', prompt: `${script.conclusion.finalThought}. Memorable cinematic closing shot, no captions or on-screen text.` });
    }

    const clipDuration = Number(settings.clipDuration || 8);
    const maxScenes = Math.max(0, Math.floor(Number(settings.maxGeneratedSeconds || 0) / clipDuration));
    return prompts.slice(0, maxScenes).map((scene, index) => ({
      ...scene,
      index,
      duration: clipDuration,
      firstFrame: visualAssets[index % Math.max(1, visualAssets.length)] || null,
      referenceImages: []
    }));
  }

  async generateClips({ jobId, productionId, script, visualAssets = [], outputDir, targetDuration }) {
    const settings = await this.settings();
    const routingRequest = {
      duration: settings.clipDuration,
      firstFrame: visualAssets[0] || null,
      generateAudio: settings.generateAudio
    };
    const provider = this.registry.select(settings.provider, settings.order, routingRequest);
    const providerInfo = provider.describe();
    if (provider.capabilities?.stock && settings.mode !== 'slideshow') {
      const stock = await this.generateStockClips({ provider, script, outputDir, productionId, targetDuration, settings });
      return {
        clips: stock.clips, credits: stock.credits, requestedProvider: settings.provider,
        actualProvider: stock.clips.length ? provider.id : 'slideshow',
        model: stock.clips.length ? providerInfo.model : 'local-ffmpeg', settings, realFootage: true
      };
    }
    if (provider.id === 'slideshow' || settings.mode === 'slideshow' || settings.maxGeneratedSeconds === 0) {
      return { clips: [], requestedProvider: settings.provider, actualProvider: 'slideshow', model: 'local-ffmpeg', settings };
    }

    const normalized = provider.normalizeRequest(routingRequest);
    const effectiveSettings = { ...settings, clipDuration: normalized.duration };
    const scenes = this.buildScenePlan(script, visualAssets, effectiveSettings);
    const clips = [];
    for (const scene of scenes) {
      const outputPath = path.join(outputDir, `${productionId}_${provider.id}_${String(scene.index).padStart(2, '0')}.mp4`);
      const result = await this.generateClip({
        jobId,
        productionId,
        scene,
        provider,
        outputPath,
        request: {
          prompt: scene.prompt,
          duration: scene.duration,
          firstFrame: scene.firstFrame,
          referenceImages: scene.referenceImages,
          resolution: settings.resolution,
          aspectRatio: settings.aspectRatio,
          generateAudio: settings.generateAudio
        }
      });
      clips.push({ ...scene, path: result.outputPath, provider: provider.id, model: result.task.model, taskId: result.task.external_task_id });
    }
    const models = [...new Set(clips.map(clip => clip.model).filter(Boolean))];
    return {
      clips, requestedProvider: settings.provider, actualProvider: provider.id,
      model: models.join(', ') || providerInfo.model, settings: effectiveSettings
    };
  }

  async generateClip({ jobId, productionId, scene, provider, outputPath, request }) {
    let task = this.db?.findMediaGenerationTask
      ? await this.db.findMediaGenerationTask(jobId, scene.index, provider.id)
      : null;

    if (task?.status === 'succeeded' && task.output_path && await this.isValidVideo(task.output_path)) {
      this.logger.info(`Reusing ${provider.id} scene ${scene.index} from ${task.external_task_id}`);
      return { task, outputPath: task.output_path, reused: true };
    }

    if (!task) {
      task = this.db?.createMediaGenerationTask
        ? await this.db.createMediaGenerationTask({
          jobId, productionId, sceneIndex: scene.index, provider: provider.id, model: provider.model,
          status: 'submitting', request: this.safeRequest(request)
        })
        : { id: `media_${Date.now()}_${scene.index}`, status: 'submitting' };
    }

    let remote;
    try {
      if (task.external_task_id && ['queued', 'running', 'submitting'].includes(task.status)) {
        remote = await provider.getTask(task.external_task_id, task.providerData || {});
      } else {
        await this.assertNotCancelled(jobId, provider, task);
        remote = await provider.createTask(request);
      }
      task = await this.updateTask(task, {
        status: remote.status,
        model: remote.model || task.model,
        externalTaskId: remote.externalTaskId,
        providerData: this.providerData(remote),
        error: remote.error || null
      });

      const started = Date.now();
      while (!TERMINAL.has(remote.status)) {
        if (Date.now() - started > this.maxPollMs) {
          const error = new Error(`${provider.id} did not finish within the configured timeout`);
          error.code = 'MEDIA_PROVIDER_TIMEOUT';
          throw error;
        }
        await this.assertNotCancelled(jobId, provider, task);
        await this.sleep(this.pollIntervalMs);
        remote = await provider.getTask(remote.externalTaskId, task.providerData || {});
        task = await this.updateTask(task, {
          status: remote.status,
          providerData: this.providerData(remote),
          error: remote.error || null
        });
      }

      if (remote.status !== 'succeeded') {
        const error = new Error(remote.error || `${provider.id} video generation ${remote.status}`);
        error.code = remote.status === 'cancelled' ? 'JOB_CANCELLED' : 'MEDIA_PROVIDER_FAILED';
        throw error;
      }

      await provider.downloadResult(remote, outputPath);
      if (!await this.isValidVideo(outputPath)) throw new Error(`${provider.id} returned an invalid MP4 asset`);
      task = await this.updateTask(task, {
        status: 'succeeded', outputPath, completedAt: new Date().toISOString(),
        providerData: this.providerData(remote), error: null
      });
      return { task, outputPath, reused: false };
    } catch (error) {
      await this.updateTask(task, {
        status: error.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed',
        error: safeModelError(error), completedAt: new Date().toISOString()
      });
      throw error;
    }
  }

  safeRequest(request) {
    const reference = value => value ? path.basename(String(value)) : null;
    return {
      prompt: String(request.prompt || '').slice(0, 2000),
      duration: request.duration,
      resolution: request.resolution,
      aspectRatio: request.aspectRatio,
      generateAudio: request.generateAudio,
      firstFrame: reference(request.firstFrame),
      lastFrame: reference(request.lastFrame),
      referenceImages: (request.referenceImages || []).map(reference),
      referenceVideos: (request.referenceVideos || []).map(reference),
      referenceAudios: (request.referenceAudios || []).map(reference)
    };
  }

  providerData(remote = {}) {
    return {
      outputUrl: remote.outputUrl || null,
      taskType: remote.taskType || null,
      model: remote.model || null
    };
  }

  async updateTask(task, changes) {
    if (!this.db?.updateMediaGenerationTask) return { ...task, ...changes, external_task_id: changes.externalTaskId || task.external_task_id, providerData: changes.providerData || task.providerData };
    return this.db.updateMediaGenerationTask(task.id, changes);
  }

  async assertNotCancelled(jobId, provider, task) {
    if (!jobId || !this.db?.getGenerationJob) return;
    const job = await this.db.getGenerationJob(jobId);
    if (!job?.cancelRequested) return;
    if (task?.external_task_id && provider.capabilities.cancellation) {
      await provider.cancelTask(task.external_task_id).catch(() => {});
    }
    const error = new Error(job.details?.cancelReason || 'Generation cancelled by operator');
    error.code = 'JOB_CANCELLED';
    throw error;
  }

  async isValidVideo(filePath) {
    try {
      const buffer = await fs.readFile(filePath);
      if (buffer.length < 1000 || !buffer.subarray(4, 32).toString('ascii').includes('ftyp')) return false;
      await runFFmpeg(['-v', 'error', '-i', filePath, '-f', 'null', '-']);
      return true;
    } catch (_error) {
      return false;
    }
  }
}

module.exports = { MediaGenerationService };
