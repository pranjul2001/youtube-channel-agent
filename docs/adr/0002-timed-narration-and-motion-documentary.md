# ADR 0002: Timed narration, burned-in subtitles and motion-documentary visuals

- Status: accepted
- Date: 2026-11-14

## Context

Owner feedback on the pilot: no subtitles (the uploaded track used fixed 0.5-second guesses and
was badly out of sync), the voice sounded synthetic and unclear, and stock clips felt random.
The owner chose free tools only: a calm, gentle male Gemini voice and a motion-documentary
style instead of paid AI video.

## Decision

- **Timed narration** (`AIVideoGenerator.generateTimedNarration`, `utils/narration-timing.js`):
  narration is synthesized in chunks of about 230 words with a spoken-style direction
  (`narration_style`) and voice (`narration_voice`, default Iapetus). FFmpeg `silencedetect`
  finds pauses; a dynamic-programming alignment maps sentence breaks to the nearest long
  pauses, giving every sentence real start/end times without a speech-recognition model.
  Audio is mastered (high-pass, light compression, -16 LUFS, 48 kHz).
- Each Gemini TTS model has its own free daily request quota (10/day observed), so
  `narration_models` is an ordered fallback list. A whole narration is always voiced by one
  model, so the voice does not change mid-video.
- **Subtitles**: cues (at most two lines of 42 characters) come from the sentence timings.
  They are burned into the picture (ASS via libass, `burn_subtitles`) and uploaded as an SRT
  track.
- **Motion documentary** (`utils/documentary-renderer.js`, `video_style=documentary`):
  sentences are grouped into beats of about 4–10 seconds. An AI picture editor picks stock
  footage, a free archive image (Wikimedia Commons, NASA), an animated locator map (Natural
  Earth outlines, OpenStreetMap Nominatim geocoding) or a date/figure card for each beat. Chapter
  cards open each section. Rules enforced in code, not only in the prompt:
  - On-screen text must be grounded in the narration (numbers must match; most words must appear).
  - No people words in searches.
  - Archive images must name the beat's subject.
  - Licences are limited to public domain, CC0 and CC BY. CC BY-SA is opt-in
    (`archive_allow_share_alike`) and is the owner's decision.
  - NASA illustrations are labelled "Artist's concept".
- All new credits (images, map data) go into the description's credits block.

## Consequences

- Subtitle timing is accurate to the pause detection (about ±0.15 s in tests). Words inside one
  sentence are timed by character share.
- Videos about places with only share-alike photos (e.g. the Flannan Isles) fall back to footage,
  maps and cards. Space and science topics get NASA imagery.
- A video costs about 4 TTS requests. Re-rendering visuals reuses the saved narration and timing
  (`data/audio/<id>_narration_timing.json`) and spends no voice quota.
