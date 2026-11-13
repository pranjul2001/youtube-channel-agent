# ADR 0001: Real stock footage from Pexels instead of AI-image slideshows

- Status: accepted
- Date: 2026-11-13

## Context

The upstream default video is a slideshow of AI images under AI narration. YouTube's
inauthentic / mass-produced content policy targets that style, and AI scene images may be
billed by the image provider. The channel needs real footage, free by default, with
photographer credits (the Pexels licence asks for attribution) and no spending without
the owner's approval.

## Decision

- Add `PexelsProvider` (`utils/video-providers.js`) as a stock-footage source, selected with
  the `video_provider=pexels` setting and a `PEXELS_API_KEY`.
- `MediaGenerationService.generateStockClips` covers the whole narration: scene time is
  proportional to narration words, each scene gets several distinct clips
  (`stock_clip_seconds`, default 8), and Gemini turns scene text into short search phrases
  that favour places and objects over people (channel bible: no footage that could read as
  a real victim). A keyword fallback is used when AI text is unavailable.
- Stock seconds do not count toward `video_max_generated_seconds`, the paid generative cap
  (set to 0, so paid video providers are never used until the owner raises it).
- `ai_scene_images_max` caps billed AI scene images per video (set to 0 for this channel).
- `utils/description-credits.js` appends one idempotent "Credits & disclosure" block:
  AI-assisted narration plus a line per Pexels videographer, within 5,000 characters.
- Stock footage does not set `containsSyntheticMedia`; generative providers still do. The
  reviewer confirms the flag at the approval gate.
- `TTS_PROVIDER` pins the narration voice (gemini now; elevenlabs later is a one-word change).

## Consequences

- Videos are real footage edited to narration; still images are only a fallback when a
  scene finds no footage.
- About 60-70 short clip downloads per 9-minute video at 720p; Pexels' 200 searches/hour
  limit is far above the ~10 searches a video needs.
- Stock clips are generic visuals, not footage of the actual event; scripts must not imply
  otherwise.
