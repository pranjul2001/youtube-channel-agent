'use strict';
// AnimationRenderer: turn a storyboard (beats) into an MP4. Two timing/audio modes:
//   • Pipeline mode  — caller passes { audioPath, beatSeconds } (from the project's cloud TTS +
//                      narration cues). Frames are timed to beatSeconds; the given audio is muxed.
//   • Local mode     — no audio given → narration is generated per beat with macOS `say` (dev only).
// Visuals: each frame is an SVG (scenes.frameSVG) rasterised with sharp, then encoded by ffmpeg.
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { frameSVG } = require('./scenes');

function ffmpegBin() { try { return require('ffmpeg-static'); } catch (_e) { return 'ffmpeg'; } }
function run(bin, args) { return new Promise((res, rej) => execFile(bin, args, { maxBuffer: 1 << 26 }, (e, so, se) => e ? rej(new Error((se || e.message || '').slice(0, 500))) : res(so))); }
function durationOf(bin, file) { let e = ''; try { execFileSync(bin, ['-i', file], { encoding: 'utf8' }); } catch (x) { e = x.stderr || ''; } const m = e.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/); if (!m) throw new Error('no duration for ' + file); return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]); }

class AnimationRenderer {
  constructor(opts = {}) {
    this.fps = opts.fps || 24;
    this.ffmpeg = opts.ffmpegPath || ffmpegBin();
    this.logger = opts.logger || { info() {}, warn() {}, error() {} };
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  }

  // board: [{ tpl, params, say, cap }]
  // opts: { outputPath, workDir, audioPath?, beatSeconds?, voice?, rate? }
  async render(board, opts) {
    if (!board || !board.length) throw new Error('empty storyboard');
    const fps = this.fps, out = opts.outputPath;
    const dir = opts.workDir || path.join(path.dirname(out), '.anim-' + path.basename(out, '.mp4'));
    const FR = path.join(dir, 'frames'), AUD = path.join(dir, 'audio');
    for (const d of [FR, AUD]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

    const pipelineMode = Boolean(opts.audioPath && opts.beatSeconds);
    let beatSeconds = opts.beatSeconds ? opts.beatSeconds.slice() : null;
    let audioPath = opts.audioPath || null;

    // ---- local mode: synthesise narration per beat with `say`, measure, concat ----
    if (!pipelineMode) {
      const voice = opts.voice || 'Samantha', rate = opts.rate || 145, PAD = 0.95, ENDPAD = 1.6;
      beatSeconds = [];
      const segs = [];
      for (let i = 0; i < board.length; i++) {
        const aiff = path.join(AUD, `b${i}.aiff`), wav = path.join(AUD, `b${i}.wav`), seg = path.join(AUD, `seg${i}.wav`);
        execFileSync('say', ['-v', voice, '-r', String(rate), '-o', aiff, board[i].say || ' ']);
        await run(this.ffmpeg, ['-y', '-i', aiff, '-ar', '44100', '-ac', '2', wav]);
        const frames = Math.ceil((durationOf(this.ffmpeg, wav) + (i === board.length - 1 ? ENDPAD : PAD)) * fps);
        beatSeconds[i] = frames / fps;
        await run(this.ffmpeg, ['-y', '-i', wav, '-af', 'apad', '-t', String(beatSeconds[i]), '-ar', '44100', '-ac', '2', seg]);
        segs.push(seg);
      }
      const list = path.join(AUD, 'list.txt'); fs.writeFileSync(list, segs.map(s => `file '${s}'`).join('\n'));
      audioPath = path.join(AUD, 'narration.wav');
      await run(this.ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', audioPath]);
    }

    if (beatSeconds.length !== board.length) throw new Error('beatSeconds must match the storyboard length');

    // ---- frames (timed to beatSeconds) ----
    const perBeatFrames = beatSeconds.map(s => Math.max(1, Math.round(s * fps)));
    const totalFrames = perBeatFrames.reduce((a, b) => a + b, 0);
    let gf = 0, startMs = 0;
    for (let b = 0; b < board.length; b++) {
      const beatMs = perBeatFrames[b] / fps * 1000;
      for (let f = 0; f < perBeatFrames[b]; f++) {
        const tIn = f / fps * 1000, tAbs = startMs + tIn;
        const svg = frameSVG(board[b], tIn, tAbs, beatMs);
        await require('sharp')(Buffer.from(svg)).png().toFile(path.join(FR, `f${String(gf).padStart(5, '0')}.png`));
        gf++;
        if (this.onProgress && (gf % 8 === 0 || gf === totalFrames)) this.onProgress(gf / totalFrames, gf, totalFrames);
      }
      startMs += beatMs;
    }

    // ---- encode frames, then mux audio (narration + optional soft music bed) ----
    const silent = path.join(dir, 'silent.mp4');
    await run(this.ffmpeg, ['-y', '-framerate', String(fps), '-i', path.join(FR, 'f%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', silent]);
    const muxNarrationOnly = () => run(this.ffmpeg, ['-y', '-i', silent, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', out]);
    const music = opts.music && opts.music.enabled !== false ? opts.music : null;
    if (music) {
      try {
        const dur = durationOf(this.ffmpeg, audioPath);
        const bed = path.join(AUD, 'bed.wav');
        await this.makeMusicBed(dur, bed, music.theme);
        const vol = typeof music.volume === 'number' ? music.volume : 0.08;
        const fo = Math.max(0, dur - 4).toFixed(2);
        // normalize=0 keeps the narration at full level; the bed is purely additive underneath.
        await run(this.ffmpeg, ['-y', '-i', silent, '-i', audioPath, '-i', bed,
          '-filter_complex', `[2:a]volume=${vol},afade=t=in:st=0:d=3,afade=t=out:st=${fo}:d=4[bed];[1:a][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
          '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', out]);
      } catch (e) {
        this.logger.warn(`Music bed failed, using narration only: ${e.message}`);
        await muxNarrationOnly();
      }
    } else {
      await muxNarrationOnly();
    }

    const seconds = totalFrames / fps;
    this.logger.info(`Animation video ready: ${board.length} scenes, ${totalFrames} frames, ${seconds.toFixed(1)}s -> ${out}`);
    return { outputPath: out, seconds, frames: totalFrames, scenes: board.length };
  }

  // A soft, original ambient pad generated entirely with ffmpeg — no external file, no licensing.
  // A slow three-note drone tinted by theme, low-passed and reverbed so it sits gently under speech.
  async makeMusicBed(durationSec, bedPath, theme) {
    const d = Math.max(1, Math.ceil(durationSec));
    const chords = {
      cosmic: [220, 329.63, 440],   // airy, higher
      haunted: [110, 130.81, 164.81], // low, minor, eerie
      archive: [110, 164.81, 220],
      sea: [110, 164.81, 220]
    };
    const freqs = chords[theme] || chords.sea;
    const inputs = freqs.flatMap(f => ['-f', 'lavfi', '-i', `sine=frequency=${f}:duration=${d}`]);
    const idx = freqs.map((_, i) => `[${i}:a]`).join('');
    const echo = theme === 'cosmic' ? 'aecho=0.8:0.7:220:0.4' : 'aecho=0.8:0.6:140:0.35';
    const lp = theme === 'cosmic' ? 820 : 600;
    const filter = `${idx}amix=inputs=${freqs.length},tremolo=f=0.1:d=0.6,lowpass=f=${lp},${echo},volume=1.6[a]`;
    await run(this.ffmpeg, ['-y', ...inputs, '-filter_complex', filter, '-map', '[a]', '-ar', '44100', '-ac', '2', bedPath]);
  }
}

module.exports = { AnimationRenderer };
