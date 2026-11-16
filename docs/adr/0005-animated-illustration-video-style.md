# 5. Animated-illustration video style

Date: 2026-11-16

## Status

Accepted

## Context

The owner wants the channel's videos to look like an **animated explainer** (illustrated scenes that
depict the story), not the stock-footage documentary style, and not photoreal/cinematic AI video.
They liked the 3D "incident reconstruction" look of some reference channels, but that is hand-built
in Blender per video — it cannot be automated, which breaks the channel's core requirement (the
owner only approves; the system produces). Full AI video generation is paid and scales with length,
so it is far over budget for daily long-form videos. The agreed direction ("Option A") is an
**illustrated animation drawn in code**: free, automatable, and consistent, where **every scene
depicts what its narration line says** (no random filler).

## Decision

Add an `animation` video style, selected by the `video_style` setting, alongside `documentary`/`stock`.

- **Scene kit** (`utils/animation/scenes.js`): ~15 parametric SVG scene templates (opening, closing,
  stat, map, seaScene, portrait, timeline, skyEvent, explosion, cityscape, document, machine,
  crowd, landscape, statement) + a per-frame assembler. Pure string builders, unit-tested.
- **Storyboard brain** (`utils/animation/storyboard.js`): maps each narration sentence to a scene
  template + params. A deterministic heuristic is the reliable baseline and safe fallback; an AI
  director can refine it, and any invalid reply falls back per-beat so a render never breaks.
- **Renderer** (`utils/animation/renderer.js`): rasterises frames with `sharp`, encodes with
  `ffmpeg`. In the pipeline it times each scene to the narration sentences and muxes the pipeline's
  own narration audio — so it uses the **free cloud voice** (Gemini TTS) with no extra dependency.
  A local `say` mode exists for dev.
- **Thumbnail** (`utils/animation/thumbnail.js`): a code-drawn hero scene + bold title (free, honest,
  no AI image), used automatically when the style is `animation`.
- **Length**: the script writer targets 1600–1900 words (~10–12 minutes).
- Wired into `ai-video-generator.generateVideo()` behind `style === 'animation'`, so the existing
  stock/documentary paths are untouched until the setting is switched.

## Consequences

- Fully automated, hands-off, and free (no paid image/video APIs); the look is code-drawn vector
  illustration, not hand-built 3D.
- Best for spatial/event stories; abstract lines fall back to an atmospheric `statement` card, so the
  scene kit grows over time to cover more subjects.
- A 10–12 minute video is ~15k frames (~10–15 min render, within the Actions timeout) and ~8 TTS
  chunks — close to Gemini's free daily voice limit, which remains an open constraint.
- Validated end-to-end locally with the real Gemini voice (no upload). Going live still needs the
  code deployed, the reliable morning trigger ([ADR 0004](0004-reliable-morning-trigger.md)), and a
  current YouTube sign-in.
