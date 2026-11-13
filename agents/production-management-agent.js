const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('../utils/logger');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { SceneRepairService } = require('../utils/scene-repair-service');
const { applyCreditsToDescription, chaptersFromScenes } = require('../utils/description-credits');
const { splitSentences, buildCues, toSRT } = require('../utils/narration-timing');

class ProductionManagementAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ProductionManagement');
    this.pipeline = [];
    this.assets = new Map();
    this.aiVideoGenerator = new AIVideoGenerator(credentials, { db });
    this.sceneRepair = new SceneRepairService(db, this.aiVideoGenerator, { logger: this.logger });
  }

  async initialize() {
    this.logger.info('Initializing Production Management Agent...');
    await this.setupDirectories();
    await this.loadPipeline();
    return true;
  }

  async setupDirectories() {
    const dirs = [
      'data/production',
      'data/assets',
      'data/videos',
      'data/audio',
      'data/scripts',
      'temp/processing'
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(__dirname, '..', dir), { recursive: true });
    }
  }

  async loadPipeline() {
    try {
      const pipeline = await this.db.getProductionPipeline();
      this.pipeline = pipeline || [];
    } catch (error) {
      this.logger.warn('No existing pipeline found, starting fresh');
    }
  }

  async processContent(contentData) {
    try {
      this.logger.info('Processing content for production...');
      
      const { strategy, script, thumbnail, seo, jobId = null } = contentData;
      
      // Create production entry
      const productionId = this.generateProductionId();
      
      const productionData = {
        id: productionId,
        strategy,
        script,
        thumbnail,
        seo,
        status: 'processing',
        assets: {
          script: await this.processScript(script),
          thumbnail: await this.processThumbnail(thumbnail, script),
          audio: null, // Will be generated later
          video: null, // Will be generated later
          captions: null // Will be generated later
        },
        timeline: {
          created: new Date().toISOString(),
          scriptReady: new Date().toISOString(),
          thumbnailReady: new Date().toISOString(),
          audioGenerated: null,
          videoGenerated: null,
          captionsGenerated: null,
          readyForUpload: null
        },
        scheduledPublishTime: this.calculatePublishTime(strategy),
        priority: this.calculatePriority(strategy),
        estimatedDuration: script.duration,
        createdAt: new Date().toISOString()
      };
      productionData.jobId = jobId;
      
      // Add to pipeline
      this.pipeline.push(productionData);
      
      // Save to database
      await this.db.saveProductionData(productionData);
      
      // Generate video content
      await this.generateVideoContent(productionData);
      
      // Generate audio narration
      await this.generateAudioNarration(productionData);
      
      // Generate captions
      await this.generateCaptions(productionData);
      
      // Final assembly
      await this.assembleVideo(productionData);

      // Persist a scene-addressable production manifest for selective review and repair.
      await this.sceneRepair.initializeProduction(productionData, this.aiVideoGenerator.lastVideoResult || {});

      // Mark as ready — or simulated, when no real video could be produced
      const simulated = Boolean(productionData.assets.finalVideo?.simulated);
      if (simulated) {
        productionData.status = 'simulated';
        this.logger.warn(`Content ${productionId} produced PLACEHOLDER assets only — it will NOT be uploaded. Check your AI provider keys and FFmpeg installation.`);
      } else {
        productionData.status = 'ready';
        productionData.timeline.readyForUpload = new Date().toISOString();
      }

      await this.db.updateProductionData(productionData);

      this.logger.info(`Content processing complete: ${productionId} (status: ${productionData.status})`);
      return productionData;
    } catch (error) {
      this.logger.error('Failed to process content:', error);
      throw error;
    }
  }

  generateProductionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extra = Math.random().toString(36).substring(2, 15);
    return `prod_${timestamp}_${random}_${extra}`;
  }

  async processScript(script) {
    const scriptPath = path.join(__dirname, '..', 'data', 'scripts', `${Date.now()}_script.json`);
    
    // Create formatted script for TTS
    const ttsScript = this.formatScriptForTTS(script);
    
    // Save script files
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    await fs.writeFile(
      scriptPath.replace('.json', '_tts.txt'), 
      ttsScript
    );
    
    return {
      originalPath: scriptPath,
      ttsPath: scriptPath.replace('.json', '_tts.txt'),
      duration: script.duration,
      sections: script.mainContent.sections.length
    };
  }

  formatScriptForTTS(script) {
    let ttsText = '';
    
    // Add hook
    if (script.hook) {
      ttsText += `${script.hook.text}\n\n`;
    }
    
    // Add introduction
    if (script.introduction) {
      ttsText += `${script.introduction.greeting}\n`;
      ttsText += `${script.introduction.topicIntro}\n`;
      ttsText += `${script.introduction.valueProposition}\n`;
      ttsText += `${script.introduction.credibility}\n\n`;
    }
    
    // Add main content
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        // Section titles are scene labels, not narration: reading "Section 1: ..." aloud
        // makes every video sound templated (channel bible: never look mass-produced).
        if (section.speakTitle === true) ttsText += `${section.title}.\n`;
        
        if (Array.isArray(section.content)) {
          section.content.forEach(line => {
            if (typeof line === 'string' && !line.startsWith('[')) {
              ttsText += `${line}\n`;
            }
          });
        } else if (section.steps) {
          section.steps.forEach(step => {
            ttsText += `${step.title}. ${step.description}\n`;
            ttsText += `${step.tip}\n`;
          });
        } else if (section.items) {
          section.items.forEach(item => {
            ttsText += `Number ${item.number}: ${item.title}. ${item.description}\n`;
          });
        } else if (typeof section.content === 'string') {
          ttsText += `${section.content}\n`;
        }
        
        ttsText += '\n';
      });
    }
    
    // Add conclusion
    if (script.conclusion) {
      (script.conclusion.recap || []).forEach(line => {
        if (typeof line === 'string') {
          ttsText += `${line}\n`;
        }
      });
      if (script.conclusion.finalThought) ttsText += `\n${script.conclusion.finalThought}\n\n`;
    }
    
    // Add CTA
    if (script.callToAction) {
      for (const line of [script.callToAction.subscribe, script.callToAction.like, script.callToAction.comment]) {
        if (typeof line === 'string' && line.trim()) ttsText += `${line}\n`;
      }
    }
    
    return ttsText;
  }

  // The same narration as formatScriptForTTS, as ordered paragraphs tagged with their section,
  // so timed narration can drive chapters, subtitles and sentence-synced visuals.
  narrationParagraphs(script = {}) {
    const paragraphs = [];
    const add = (label, text) => {
      if (typeof text === 'string' && text.trim() && !text.trim().startsWith('[')) paragraphs.push({ label, text: text.trim() });
    };
    add('Hook', script.hook?.text);
    if (script.introduction) {
      add('Hook', [script.introduction.greeting, script.introduction.topicIntro, script.introduction.valueProposition, script.introduction.credibility]
        .filter(line => typeof line === 'string' && line.trim()).join(' '));
    }
    for (const section of script.mainContent?.sections || []) {
      const label = section.title || 'Scene';
      if (section.speakTitle === true) add(label, `${section.title}.`);
      if (Array.isArray(section.content)) section.content.forEach(line => add(label, line));
      else if (section.steps) section.steps.forEach(step => add(label, [`${step.title}. ${step.description}`, step.tip].filter(Boolean).join(' ')));
      else if (section.items) section.items.forEach(item => add(label, `Number ${item.number}: ${item.title}. ${item.description}`));
      else add(label, section.content);
    }
    (script.conclusion?.recap || []).forEach(line => add('Conclusion', line));
    add('Conclusion', script.conclusion?.finalThought);
    for (const line of [script.callToAction?.subscribe, script.callToAction?.like, script.callToAction?.comment]) add('Conclusion', line);
    return paragraphs;
  }

  async processThumbnail(thumbnail, script) {
    try {
      // Try to generate AI thumbnail first
      const thumbnailScript = thumbnail.script || script || { title: thumbnail.title || 'Untitled Video' };
      const aiThumbnail = await this.aiVideoGenerator.generateThumbnail(thumbnailScript, 'ethereal');

      // generateThumbnail returns a simulated placeholder instead of throwing when
      // no image provider works; the designer's real image beats that placeholder.
      if (!aiThumbnail.simulated) {
        return {
          path: aiThumbnail.path,
          originalPath: thumbnail.path,
          dimensions: aiThumbnail.dimensions,
          fileSize: aiThumbnail.fileSize,
          generatedWith: 'AI'
        };
      }
    } catch (error) {
      this.logger.error('AI thumbnail generation failed:', error);
    }

    // Fallback to original processing
    const productionThumbnailPath = path.join(
      __dirname, '..', 'data', 'assets',
      `thumbnail_${Date.now()}.jpg`
    );

    if (thumbnail.path && await fs.access(thumbnail.path).then(() => true).catch(() => false)) {
      const originalBuffer = await fs.readFile(thumbnail.path);
      await fs.mkdir(path.dirname(productionThumbnailPath), { recursive: true });
      await fs.writeFile(productionThumbnailPath, originalBuffer);
      return {
        path: productionThumbnailPath,
        originalPath: thumbnail.path,
        dimensions: thumbnail.dimensions || { width: 1792, height: 1024 },
        fileSize: thumbnail.fileSize || 0
      };
    }

    // Create placeholder
    await fs.mkdir(path.dirname(productionThumbnailPath), { recursive: true });
    await fs.writeFile(productionThumbnailPath + '.placeholder', 'Thumbnail placeholder');
    return {
      path: productionThumbnailPath + '.placeholder',
      originalPath: thumbnail.path,
      dimensions: thumbnail.dimensions || { width: 1792, height: 1024 },
      fileSize: 0,
      simulated: true
    };
  }

  calculatePublishTime(strategy) {
    // Use strategy's recommended time or calculate optimal time
    if (strategy.bestPublishTime) {
      return strategy.bestPublishTime;
    }
    
    // Default: next optimal publishing window
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(14, 0, 0, 0); // 2 PM default
    
    return tomorrow.toISOString();
  }

  calculatePriority(strategy) {
    let priority = 50; // Base priority
    
    // Adjust based on estimated views
    if (strategy.estimatedViews > 100000) priority += 30;
    else if (strategy.estimatedViews > 50000) priority += 20;
    else if (strategy.estimatedViews > 10000) priority += 10;
    
    // Adjust based on trend score
    if (strategy.competitorAnalysis && strategy.competitorAnalysis.length > 0) {
      priority += 10;
    }
    
    // Time sensitivity
    const hoursUntilPublish = (new Date(strategy.bestPublishTime) - new Date()) / (1000 * 60 * 60);
    if (hoursUntilPublish < 24) priority += 20;
    else if (hoursUntilPublish < 48) priority += 10;
    
    return Math.min(100, priority);
  }

  async generateVideoContent(productionData) {
    this.logger.info('Generating AI video content...');
    
    try {
      const { script } = productionData;
      
      // Generate visual assets using DALL-E
      const visualPrompts = this.createVisualPromptsFromScript(script);
      const visualAssets = [];
      const profile = await this.db.getChannelProfile?.() || {};
      const visualStyle = profile.visual_style || 'ethereal';

      // AI scene images may be billed by the provider. Cap them per video; when unset the
      // upstream behaviour (one per prompt) is kept. 0 = rely on stock footage only.
      const settings = await this.db.getAllSettings?.() || {};
      const rawCap = process.env.AI_SCENE_IMAGES_MAX ?? settings.ai_scene_images_max;
      const imageCap = rawCap === undefined || rawCap === null || rawCap === ''
        ? visualPrompts.length
        : Math.max(0, Math.floor(Number(rawCap)) || 0);
      if (imageCap < visualPrompts.length) {
        this.logger.info(`AI scene images capped at ${imageCap} of ${visualPrompts.length} (ai_scene_images_max)`);
      }

      for (const prompt of visualPrompts.slice(0, imageCap)) {
        const assets = await this.aiVideoGenerator.generateVisualAssets(prompt, visualStyle, 1);
        visualAssets.push(...assets);
      }
      
      productionData.assets.video = {
        visualAssets: visualAssets,
        duration: productionData.estimatedDuration,
        format: 'mp4',
        resolution: '1920x1080',
        fps: 30,
        generatedWith: 'AI'
      };
      
      productionData.timeline.videoGenerated = new Date().toISOString();
      
      return visualAssets;
    } catch (error) {
      this.logger.error('AI video content generation failed:', error);
      // Fallback to placeholder
      return await this.createVideoElements(productionData);
    }
  }

  async createVideoElements(productionData) {
    const { script } = productionData;
    const elements = [];
    
    // Title slide
    elements.push({
      type: 'title_slide',
      content: script.title,
      duration: 3,
      style: 'modern',
      animation: 'fade_in'
    });
    
    // Content sections
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section) => {
        // Section title
        elements.push({
          type: 'section_title',
          content: section.title,
          duration: 2,
          style: 'minimal',
          animation: 'slide_in'
        });
        
        // Content visuals
        if (section.type === 'list_items' && section.items) {
          section.items.forEach(item => {
            elements.push({
              type: 'list_item',
              content: {
                number: item.number,
                title: item.title,
                description: item.description
              },
              duration: 15,
              style: 'countdown',
              animation: 'zoom_in'
            });
          });
        } else if (section.type === 'solution_steps' && section.steps) {
          section.steps.forEach(step => {
            elements.push({
              type: 'step',
              content: {
                number: step.number,
                title: step.title,
                description: step.description
              },
              duration: 20,
              style: 'tutorial',
              animation: 'step_by_step'
            });
          });
        } else {
          // Generic content slide
          elements.push({
            type: 'content_slide',
            content: section.title,
            duration: section.duration || 30,
            style: 'informative',
            animation: 'fade_transition'
          });
        }
      });
    }
    
    // Conclusion slide
    elements.push({
      type: 'conclusion',
      content: 'Key Takeaways',
      duration: 5,
      style: 'summary',
      animation: 'reveal'
    });
    
    // Subscribe reminder
    elements.push({
      type: 'subscribe_reminder',
      content: 'Subscribe for More!',
      duration: 3,
      style: 'call_to_action',
      animation: 'bounce'
    });
    
    return elements;
  }

  async generateAudioNarration(productionData) {
    this.logger.info('Generating AI audio narration...');
    const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
    await fs.mkdir(path.dirname(audioPath), { recursive: true });

    // Preferred: narration with real sentence timings (accurate subtitles, synced visuals).
    const paragraphs = this.narrationParagraphs(productionData.script);
    if (paragraphs.length && typeof this.aiVideoGenerator.generateTimedNarration === 'function') {
      try {
        const timed = await this.aiVideoGenerator.generateTimedNarration(paragraphs, audioPath);
        const timingPath = audioPath.replace(/\.mp3$/, '_timing.json');
        await fs.writeFile(timingPath, JSON.stringify({ sentences: timed.sentences, cues: timed.cues }, null, 2));
        productionData.assets.audio = {
          path: timed.path,
          duration: Number(timed.duration.toFixed(2)),
          format: 'mp3',
          generatedWith: 'AI',
          quality: 'high',
          status: 'ready',
          simulated: false,
          provider: timed.model ? 'gemini' : (process.env.TTS_PROVIDER || 'auto'),
          model: timed.model || null,
          voice: timed.voice || null,
          externalTaskId: null,
          generatedAt: new Date().toISOString(),
          cost: { provider: 'gemini', amount: null, currency: null, invoiceRequired: false },
          error: null,
          intentionalSilence: false,
          timingPath,
          timing: { sentences: timed.sentences, cues: timed.cues }
        };
        productionData.timeline.audioGenerated = new Date().toISOString();
        return timed.path;
      } catch (error) {
        this.logger.warn(`Timed narration failed (${error.message}); trying single-pass narration`);
      }
    }

    try {
      // Read the TTS script
      const ttsText = await fs.readFile(productionData.assets.script.ttsPath, 'utf8');
      
      // Generate audio using AI TTS and retain the provider evidence returned by the generator.
      const generatedPath = await this.aiVideoGenerator.generateTTSAudio(ttsText, audioPath);
      const evidence = this.aiVideoGenerator.lastNarrationResult || {};
      const usable = await this.aiVideoGenerator.isUsableAudioFile(generatedPath);

      productionData.assets.audio = {
        path: generatedPath,
        duration: productionData.estimatedDuration,
        format: 'mp3',
        generatedWith: 'AI',
        quality: usable ? 'high' : null,
        status: usable ? 'ready' : 'unavailable',
        simulated: !usable,
        provider: evidence.provider || null,
        model: evidence.model || null,
        externalTaskId: evidence.externalTaskId || null,
        generatedAt: evidence.generatedAt || new Date().toISOString(),
        cost: evidence.cost || {},
        error: usable ? null : 'No live narration provider returned usable audio',
        intentionalSilence: false
      };

      if (usable) productionData.timeline.audioGenerated = new Date().toISOString();
      return generatedPath;
    } catch (error) {
      this.logger.error('AI audio generation failed:', error);
      return await this.simulateAudioGeneration(productionData, error);
    }
  }

  async generateCaptions(productionData) {
    this.logger.info('Generating captions...');
    
    const captionsPath = path.join(__dirname, '..', 'data', 'captions', `${productionData.id}_captions.srt`);
    
    // Generate SRT captions based on script timing
    const captions = await this.createSRTCaptions(productionData);
    
    await fs.mkdir(path.dirname(captionsPath), { recursive: true });
    await fs.writeFile(captionsPath, captions);
    
    productionData.assets.captions = {
      path: captionsPath,
      format: 'srt',
      language: 'en',
      autoGenerated: true,
      timed: Boolean(productionData.assets?.audio?.timing?.cues?.length)
    };
    
    productionData.timeline.captionsGenerated = new Date().toISOString();
    
    return captionsPath;
  }

  // Captions that match the spoken audio. With timed narration every cue uses the measured
  // sentence times. Without it, sentences share the measured narration length by character
  // count (never fixed guesses: the old 0.5-second chunks put the whole hook in 2.5 seconds).
  async createSRTCaptions(productionData) {
    const timing = productionData.assets?.audio?.timing;
    if (timing?.cues?.length) return toSRT(timing.cues);

    const paragraphs = this.narrationParagraphs(productionData.script);
    const sentences = paragraphs.flatMap(paragraph => splitSentences(paragraph.text));
    if (!sentences.length) return '';
    let total = null;
    try {
      total = await this.aiVideoGenerator.getMediaDuration(productionData.assets?.audio?.path);
    } catch (_error) { total = null; }
    if (!Number.isFinite(total) || total <= 0) {
      const words = sentences.join(' ').split(/\s+/).length;
      total = (words / 150) * 60;
    }
    const chars = sentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1;
    let t = 0;
    const timed = sentences.map(text => {
      const span = (text.length / chars) * total;
      const item = { text, start: t, end: t + span };
      t += span;
      return item;
    });
    return toSRT(buildCues(timed));
  }

  async assembleVideo(productionData) {
    this.logger.info('Assembling final AI-generated video...');
    
    try {
      const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
      const narrationReady = await this.aiVideoGenerator.isUsableAudioFile(productionData.assets.audio?.path);
      if (!narrationReady && productionData.assets.audio?.intentionalSilence !== true) {
        this.logger.warn('Final assembly is blocked until narration succeeds or the operator explicitly confirms an intentional silent video.');
        return await this.simulateVideoAssembly(productionData, 'Narration is missing');
      }

      // Use AI Video Generator to create the final video
      const producedPath = await this.aiVideoGenerator.generateVideo(
        productionData.script,
        productionData.assets.video.visualAssets || [],
        productionData.assets.audio.path,
        finalVideoPath,
        {
          jobId: productionData.jobId,
          productionId: productionData.id,
          estimatedDuration: productionData.estimatedDuration,
          timing: productionData.assets.audio?.timing || null
        }
      );

      // The generator falls back to a placeholder .info file when it cannot render
      if (!producedPath || path.extname(producedPath).toLowerCase() !== '.mp4') {
        return await this.simulateVideoAssembly(productionData);
      }

      // Get file stats
      const stats = await fs.stat(finalVideoPath);
      
      productionData.assets.finalVideo = {
        path: finalVideoPath,
        fileSize: stats.size,
        duration: productionData.estimatedDuration,
        generatedWith: 'AI',
        resolution: '1920x1080',
        format: 'mp4',
        provider: this.aiVideoGenerator.lastVideoResult || { actualProvider: 'slideshow', model: 'local-ffmpeg' }
      };
      // Generative video providers produce synthetic media; real stock footage (Pexels) does not.
      // The reviewer still confirms or changes this flag at the approval gate.
      const videoResult = this.aiVideoGenerator.lastVideoResult || {};
      productionData.containsSyntheticMedia = Boolean(
        videoResult.actualProvider &&
        videoResult.realFootage !== true &&
        !['slideshow', 'simulation'].includes(videoResult.actualProvider)
      );

      // Channel bible: credit stock videographers and disclose AI-assisted narration.
      const narrationProvider = productionData.assets.audio?.provider;
      if (productionData.seo) {
        productionData.seo.description = applyCreditsToDescription(productionData.seo.description, {
          credits: videoResult.credits || [],
          aiNarration: Boolean(narrationProvider && narrationProvider !== 'simulation'),
          // Real chapters from the rendered timeline replace any AI-guessed timestamps.
          chapters: chaptersFromScenes(videoResult.scenes || []),
          sources: productionData.strategy?.researchSources || []
        });
      }
      
      this.logger.info('AI video assembly complete');
      return finalVideoPath;
    } catch (error) {
      this.logger.error('AI video assembly failed:', error);
      // Fallback to simulation
      return await this.simulateVideoAssembly(productionData);
    }
  }

  async getPipelineStatus() {
    return this.pipeline.map(item => ({
      id: item.id,
      title: item.script?.title || 'Untitled',
      status: item.status,
      priority: item.priority,
      scheduledPublishTime: item.scheduledPublishTime,
      progress: this.calculateProgress(item)
    }));
  }

  calculateProgress(productionData) {
    const milestones = [
      'scriptReady',
      'thumbnailReady',
      'audioGenerated',
      'videoGenerated',
      'captionsGenerated',
      'readyForUpload'
    ];
    
    const completed = milestones.filter(milestone => 
      productionData.timeline[milestone] !== null
    ).length;
    
    return Math.round((completed / milestones.length) * 100);
  }

  async getNextReadyContent() {
    const ready = this.pipeline
      .filter(item => item.status === 'ready')
      .sort((a, b) => b.priority - a.priority);
    
    return ready[0] || null;
  }

  // Helper method to create visual prompts from script content
  createVisualPromptsFromScript(script) {
    const prompts = [];
    
    // Title prompt
    prompts.push(`${script.title}, clear visual storytelling`);
    
    // Content-based prompts
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (section.title) {
          prompts.push(`${section.title}, relevant explanatory visual`);
        }
      });
    }
    
    // Ensure we have at least 3 prompts
    while (prompts.length < 3) {
      prompts.push(`${script.title || 'Video topic'}, supporting explanatory visual`);
    }
    
    return prompts.slice(0, 5); // Limit to 5 for cost control
  }

  // Fallback simulation methods
  async simulateAudioGeneration(productionData, failure = null) {
    const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
    
    await fs.writeFile(audioPath + '.info', JSON.stringify({
      message: 'AI TTS audio would be generated here',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    productionData.assets.audio = {
      path: audioPath + '.info',
      duration: productionData.estimatedDuration,
      format: 'mp3',
      status: 'unavailable',
      simulated: true,
      provider: this.aiVideoGenerator.lastNarrationResult?.provider || 'simulation',
      model: this.aiVideoGenerator.lastNarrationResult?.model || null,
      externalTaskId: this.aiVideoGenerator.lastNarrationResult?.externalTaskId || null,
      generatedAt: this.aiVideoGenerator.lastNarrationResult?.generatedAt || new Date().toISOString(),
      cost: this.aiVideoGenerator.lastNarrationResult?.cost || { billed: false },
      error: failure?.message || this.aiVideoGenerator.lastNarrationResult?.error || 'No live narration provider is configured',
      intentionalSilence: false
    };
    
    return audioPath + '.info';
  }

  async simulateVideoAssembly(productionData, reason = null) {
    const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
    
    const assemblyInstructions = {
      message: 'AI video would be assembled here',
      blockedReason: reason,
      assets: productionData.assets,
      timestamp: new Date().toISOString()
    };
    
    await fs.writeFile(
      finalVideoPath + '.assembly.json',
      JSON.stringify(assemblyInstructions, null, 2)
    );
    
    productionData.assets.finalVideo = {
      path: finalVideoPath + '.assembly.json',
      fileSize: 0,
      duration: productionData.estimatedDuration,
      simulated: true,
      blockedReason: reason
    };
    
    return finalVideoPath + '.assembly.json';
  }
}

module.exports = { ProductionManagementAgent };
