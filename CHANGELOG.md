# Changelog

## Curious Files fork

Changes on branch `channel`, newest first. Upstream entries follow below.

- **Migrated to a dedicated channel account** (2026-11-22): the channel now runs on a new, separate Google account — channel **The Unknown Archive** (`@TheUnknownArchive27`), kept apart from the owner's personal Gmail. New Google Cloud project + OAuth client; `CREDENTIALS_JSON` and `TOKENS_JSON` secrets swapped to the new account; `settings.channel_name` renamed to "The Unknown Archive"; `state/history.json` reset (the 9 earlier videos live on the old personal channel). From the next run on, uploads go to the new channel.
- **Animated-illustration video style** (2026-11-16, [ADR 0005](docs/adr/0005-animated-illustration-video-style.md)): a new `animation` video style that draws an illustrated explainer in code — ~15 scene templates (`utils/animation/scenes.js`), a storyboard "brain" that maps each narration sentence to a scene (`utils/animation/storyboard.js`), a renderer that times scenes to the narration and uses the free cloud voice (`utils/animation/renderer.js`), and a code-drawn thumbnail (`utils/animation/thumbnail.js`). Every scene depicts its line — no random filler. Wired into `ai-video-generator.generateVideo()` behind `video_style=animation`, so stock/documentary are untouched. Video length raised to ~10–12 minutes (1600–1900 words). Validated end-to-end with the real Gemini voice; covered by `testAnimationSceneKit` (65/65 offline tests pass).
- **Ready by 10 AM, dependably** (2026-11-16, [ADR 0004](docs/adr/0004-reliable-morning-trigger.md)): GitHub's free `schedule:` cron proved unreliable (06:00 run was 6.5 h late on 2026-11-15; every slot was skipped on 2026-11-16). The dependable trigger is now an external scheduler calling the workflow via `workflow_dispatch` at 08:00 IST; GitHub's own crons are trimmed to 05:30 and 07:00 as best-effort early tries. Owner-facing text and `OWNER-GUIDE.md` updated to the 10 AM target.
- **Ticked pick now survives the weekly list refresh** (2026-11-16): when the Sunday list refresh carried an unmade topic to the new issue, it dropped the owner's tick, silently resetting the next video's topic. Carried-over topics now keep their ticked state (and a ticked pick is kept even past the carry-over limit). Extracted `mergeTopics` with a regression test.
- **Owner timeline** (2026-11-15):
  - Tick by 11:59 PM; otherwise the best available topic is made.
  - Start at 06:00 IST, with backup starts at 07:30, 09:00 and 10:30 because GitHub can start runs hours late.
  - Private upload by noon.
- **Clearer thumbnail text:** a natural 2–4 word phrase that names the subject ("A Diner Trillion Dollar Rise" would now be rejected).
- **First cloud run (2026-11-14):** made and privately uploaded "From Ranch Chores to Arena Glory: The Evolution of Rodeo" (7:24). The save step now rebases before pushing, so commits made during a run no longer block it.
- **Daily video on GitHub Actions** ([ADR 0003](docs/adr/0003-daily-video-on-github-actions.md)):
  - a weekly trending-topic issue the owner ticks
  - a 06:00 IST build that uploads as private and comments with the Studio link, script and facts to check
  - secrets from GitHub Secrets; channel settings from `config/channel-seed.json`
- **Topics page and daily video** on the local dashboard:
  - `TopicCurator` (Google Trends, Wikipedia most-read, YouTube trending; series or Wildcard tags; bible filter; verified articles)
  - `DocumentaryScriptWriter` (Wikipedia research; claim, number and copied-wording checks)
  - `DailyVideoService` (nightly pick, catch-up after sleep, restart recovery)
- **Live progress panel** for topic refresh, video builds (script → voice → visuals → finishing) and YouTube uploads (MB uploaded).
- **Reliability:**
  - `npm run e2e` end-to-end check
  - retries for empty Gemini TTS replies and stock searches
  - backup Gemini text models with per-call deadlines
  - the voice readiness probe uses the channel's own voice models
- **Honest thumbnails** from a real video frame with script-grounded text. Template and placeholder thumbnails are never uploaded.
- **Clip vetting:** stock clips are filtered by tags (people, food, tropical, AI-generated) and by an AI look at the preview frame. Archive images must name the beat's subject.
- **Motion-documentary renderer** ([ADR 0002](docs/adr/0002-timed-narration-and-motion-documentary.md)):
  - sentence-timed beats
  - Natural Earth locator maps
  - Commons and NASA images (no share-alike by default)
  - date and figure cards, chapter cards
  - burned-in ASS subtitles
- **Timed narration:** chunked Gemini TTS with a calm-male style direction (voice Iapetus), pause-based sentence alignment, accurate SRT captions and mastered 48 kHz audio.
- **Stock footage** from Pixabay and Pexels ([ADR 0001](docs/adr/0001-pexels-stock-footage.md)), with videographer credits, real chapters and sources in descriptions, blocklist and visual mood settings.
- **Fixes:**
  - a looped FFmpeg mux that could fill the disk (375 GB)
  - the Pixabay key leaking in errors
  - narration reading "Section N" aloud
  - AI-invented chapter timestamps
  - "U.S." splitting sentences

## Unreleased

- Refreshed provider defaults and selectors: OpenAI GPT-6.1 Sol (with GPT-6 Astra and Luna), Gemini 3.8 Flash (with Gemini 4 Argon), MiMo V2.6, GLM-5.3 Flash, Claude Fable 5.1, and the current OpenRouter catalog
- Added DeepSeek (`DEEPSEEK_API_KEY`) and MiniMax M3 text (`MINIMAX_TEXT_API_KEY`) as text providers; the existing `MINIMAX_API_KEY` still only enables MiniMax H3 video
- Moved Gemini Omni video to `gemini-omni-1.1-flash` and Gemini narration to `gemini-3.8-flash-tts` ahead of Google's shutdown of the preview models
- Gemini 4 models no longer receive the ignored `temperature` parameter
- Fixed slideshow videos showing a hard-coded "Ethereal Dreamscript" subtitle, a "New content daily at 2:00 PM" end card, and "Content coming soon..." on every chapter; chapter slides now show the script's lines, and generated images are shown at full strength under a light scrim instead of 30% opacity
- When AI thumbnail generation falls back to a placeholder, productions now keep the designer's real thumbnail; a remaining placeholder no longer passes the thumbnail check or appears as a broken image in Review Studio
- Upgraded sharp to 0.34 so its WebAssembly build loads on platforms without a native binary, such as Android/Termux (requires Node.js 18.17+)
- Corrected the README's provider list: there is no generic OpenAI-compatible endpoint or Ollama setting, and Claude is available through OpenRouter

## v2.11.0 — 2026-10-13

- Fixed the readiness text probe failing on thinking Gemini models (`gemini-3.7-flash`, `gemini-3.1-pro-preview`): the probe budget now leaves room for thoughts, and a Gemini response that runs out of tokens before writing text is retried once with a larger budget (#63)
- Image generation failures now show the provider's actual error and a concrete fix (billing, invalid key, unavailable model, region) instead of a bare "failed:" line, including when `NODE_ENV=production` (#65)
- Image generation now falls back to Gemini when OpenAI image generation fails (and the other way round) instead of dropping straight to simulated visuals (#65)
- Added a whole-channel YouTube snapshot to Analytics (lifetime subscribers, views, and videos, plus 28-day views, watch hours, and subscriber change) that covers videos published outside Lumen and reports a disabled YouTube Analytics API instead of showing zeroes (#66)
- The dashboard server now listens on `127.0.0.1` by default; set `HOST=0.0.0.0` (with `API_KEY`) for network access (#66)
- Credential and OAuth token files are now written owner-only (`0600`), and FFmpeg inputs for looped provider clips are bounded to their timeline slot (#66)
- Bundled the DarkzSEO-compatible content audit so the preflight no longer depends on the unpublished 1.4 Python package; external 1.4+ checkouts remain opt-in through `DARKZSEO_PATH`
- Fixed regenerated narration timing, CTA metadata and template-placeholder speech leaks, configured visual-style propagation, and null manual strategy contexts
- Added explicit reschedule, publish-now, and delete-schedule controls while keeping generated content when a schedule is removed
- Fixed YouTube OAuth to use the configured loopback redirect URI instead of generating a mismatched callback

## v2.10.0 — 2026-08-24

- Added a versioned DarkzSEO discoverability preflight over a shell-free Python stdin/stdout adapter, with explicit unavailable and schema-mismatch states
- Added durable discoverability audits and findings, reviewer keep/dismiss decisions with required false-positive reasons, and review evidence carry-forward across matching audits
- Added an advisory Review Studio panel and API controls; discoverability findings never rewrite content or block publication in this release
- Added a Controlled Growth Experiments Studio that turns approved-learning title and thumbnail variants into durable post-publication test plans
- Added separate plan approval, live-start confirmation, bounded arm rotation, control restoration, and winner-adoption gates; no experiment can silently adopt a live change
- Added real YouTube evidence samples for each arm using interval deltas for impressions, estimated clicks, CTR, views, watch time, retention, engagement, subscribers, and revenue
- Added minimum-exposure, 95% evidence, retention-regression, and traffic-mix guardrails with an explicit inconclusive result when the evidence is weak or confounded
- Added four-hour experiment refresh scheduling, restart-safe SQLite state, dashboard controls, read/mutation APIs, and approved-winner handoff into future channel planning
- Added a structured channel-outcome contract with primary KPI, numeric target, measurement window, monthly production budget, and currency while retaining free-text outcome context
- Added independent YouTube subscriber and monetization collection so unavailable revenue never converts otherwise-real analytics into simulated data or false zeroes
- Extended real performance snapshots with net subscribers, watch hours, subscriber and revenue efficiency, known production cost, net revenue, and ROI evidence
- Added an Outcome & ROI Studio dashboard with target progress, evidence coverage, channel economics, and pillar, format, and provider comparisons
- Added approval-gated outcome-allocation recommendations; pending or rejected recommendations cannot change autonomous planning
- Added `GET /api/outcomes`, structured strategy validation, content-pillar propagation, database migrations, and regression coverage for goal alignment and non-monetized channels
- Established a platform-targeted audit contract for future TikTok and Instagram/Reels publishing and analytics adapters; those adapters are not included in v2.10.0

## v2.9.0 — 2026-08-23

- Added a persistent Audience Engagement Studio: tapered read-only comment sync for recent videos with a strict no-simulated-comments policy
- Added AI comment classification into themes, sentiment, and flags, with spam/scam/toxic quarantine (flag-only; no moderation actions) and a weak non-AI fallback that never invents insights
- Added approval-only reply drafting and posting with an explicit confirmation, a youtube.force-ssl re-consent gate, posting evidence, and a daily reply cap
- Added audience-demand idea mining (3+ repeated asks) into the existing approval-gated recommendations pipeline, feeding approved requests into autonomous planning
- Added an Engagement dashboard view, five /api/engagement endpoints, and a four-hour engagement sync automation slot
- Added persistent scene-aware audience-retention snapshots using YouTube's granular elapsed-time curve, with separate long-form and Shorts evidence
- Mapped retention points onto durable production scenes and classified scene-level drop-off, rewatch, strong-hold, and steady signals
- Added an accessible dashboard retention curve, scene evidence cards, manual read-only refresh, and stored-evidence API
- Added approval-gated scene-retention recommendations; missing, sparse, and simulated curves remain excluded and published videos are never edited automatically
- Added a persistent Shorts Repurposing Studio that proposes source-scene-backed vertical excerpts from an existing production without new provider calls
- Added local 9:16 FFmpeg rendering with blurred-canvas, center-crop, and stacked-focus layouts plus mobile-safe burned captions and SRT output
- Added independent Short review, evidence inheritance, scheduling, publishing-state reconciliation, and Shorts-specific analytics context
- Made narration fail-closed across production assembly, quality review, scheduling, and publishing; missing TTS can no longer silently become an approvable video
- Added narration-only scene recovery with persistent provider, model, task, generation-time, cost, and failure evidence
- Added a reasoned, reversible intentional-silence override and scene-aware silent-segment mixing for explicitly silent productions
- Added a persistent Scene Repair Studio with scene-level narration, prompts, timing, provider/task evidence, asset origin, rights state, source links, locks, and revision history
- Added selective scene editing, reordering, paid regeneration confirmation, licensed image/video replacement, narration invalidation, and scene-aware caption rebuilding
- Final scene rebuilds now create a new MP4 while preserving the previous artifact; incomplete, stale, unlicensed, or unrepaired scenes block approval
- Added a durable video-provider layer for Seedance 2.5, MiniMax H3, Gemini Omni Flash, Kling 3.0 Omni, and Wan 2.7
- Added capability-aware automatic routing with local slideshow as the no-cost default and final fallback
- Added persistent external media task IDs, provider/model evidence, cancellation handoff where supported, and restart-safe reuse of known provider tasks
- Added hybrid long-form assembly, per-production paid-seconds caps, truthful fallback metadata, and automatic synthetic-media review handoff
- Added dashboard provider controls and a separately opted-in paid AI-video readiness probe

## v2.8.0 — 2026-08-21

- Added a persistent Research & Provenance Desk with source metadata, claim-to-source links, reviewer status, notes, and evidence summaries
- Preserved exact YouTube trend and competitor source URLs through autonomous planning and into script generation
- Added AI-declared factual claims that may reference only sources supplied by the research stage
- Made unresolved claims blocking; supported claims require verified evidence and claim waivers require reviewer notes
- Added Review Studio controls for adding and reviewing sources and claims, including official, article, video, dataset, asset-license, and other evidence types
- Added realistic altered or synthetic media disclosure and passed the reviewed value into YouTube upload metadata

## v2.7.0 — 2026-08-21

- Added persistent per-stage generation checkpoints with artifact validation, bounded retry-safe backoff, and resume-from-first-incomplete behavior
- Added dashboard controls to resume failed or interrupted jobs from a selected stage while showing saved and reused stages
- Added Autonomous Channel Operator recovery from stored research, editorial plans, ideas, and interrupted generation jobs
- Preserved the actual generation stage across application restarts instead of replacing it with a generic interrupted stage
- Made scheduling idempotent per production and added YouTube upload reconciliation so recorded or uncertain uploads cannot be duplicated automatically
- Added API endpoints for individual-job and operator-run recovery plus regression coverage for restart, reuse, transient retry, and duplicate-upload safety

## v2.6.0 — 2026-08-20

- Added a user-triggered Production Readiness Gate with live text, narration, YouTube-access, local audio/video MP4, and queued-metadata probes; paid image verification is explicit opt-in
- Added persistent readiness evidence and a dashboard remediation panel; recorded blocking failures now stop autonomous runs and publishing until a later check clears them
- Added YouTube metadata normalization and fail-fast upload validation to prevent malformed AI-generated tags from reaching the upload API
- Added an approval-gated Channel Learning Engine that captures real 24-hour and 7-day performance snapshots, derives channel-relative baselines, and feeds only approved recommendations into future autonomous plans
- Added a dashboard learning review with evidence, confidence, approve/reject controls, and operator-selected title/thumbnail variants for approved packaging experiments; simulated analytics are explicitly excluded from learning
- Added a persistent Autonomous Channel Operator that turns a channel objective, audience, pillars, cadence, and guardrails into researched editorial plans and sequential end-to-end production runs
- Added dashboard strategy controls, operator-run progress and cancellation, scheduled strategy execution, and approval-gated publishing handoff
- Added local-only activation milestones for setup, first real MP4, approval, publication, and repeat generation
- Added an explicit opt-in anonymous milestone reporter with no default endpoint
- Added reproducible GitHub growth baselines and public fork census reports
- Reworked the README around product outcomes and moved release history here
- Refreshed active provider defaults and selectors for Gemini 3.7 Flash, Claude Fable 5, and the current OpenRouter catalog

## v2.5

- **Operator-first dashboard** — live jobs, content pipeline, review queue, calendar, idea backlog, analytics, and channel setup in one responsive console
- **Asynchronous generation** — generation returns immediately with a persistent job ID; progress, errors, cancellation, and restart interruptions are visible
- **Approval-first publishing** — generated content must pass quality checks, factual review, media-rights confirmation, and human approval before it can be scheduled by default
- **Review studio** — preview real video and thumbnail assets, edit title/description/tags/privacy/schedule, reject, retry, or approve
- **Brand guardrails** — channel goal, audience, voice, CTA, visual direction, timezone, and blocked-topic policy guide generation and quality review
- **Actionable operations** — pause/resume automation, webhook-ready notifications, real activity history, and warning-free linting

## v2.4

- **Guided walkthrough for first-time setup** — `npm run walkthrough` explains each choice, opens provider pages, tests keys, guides Google Cloud setup, and saves progress
- **`.env` loading fixed** — runtime and setup tools now load local environment settings
- **Safer example environment** — placeholder credentials are commented out
- **Browser OAuth opens automatically** — YouTube authorization opens in the default browser

## v2.3

- **Gemini media pipeline** — Gemini image generation (`gemini-3.1-flash-image`) and narration (`gemini-3.1-flash-tts-preview`) are supported. Text and TTS currently have free tiers; AI image generation requires Gemini paid-tier access. Gradient visuals remain the no-image-provider fallback.
- **Faster slideshow rendering** — the renderer captures one still per slide and uses FFmpeg for video and crossfades
- **Better template topics** — template mode uses curated evergreen topics and rejects malformed trend fragments
- **Model catalog correction** — removed the nonexistent `gemini-3.5-pro` entry in favor of supported Gemini models

## v2.2

- Any configured AI text provider can satisfy startup credential validation
- FFmpeg is bundled through `ffmpeg-static`
- Successful production reaches the publish queue
- Silent real MP4 output is supported when TTS is not configured
- Startup reports real versus simulated capabilities
- Missing credentials and FFmpeg produce actionable warnings
- Publish-queue logging reports queue state and timing

## v2.1

- Real AI generation for strategy, scripts, and SEO
- Optional API-key protection for mutating routes
- Private-by-default publishing and placeholder upload protection
- Scheduler, dependency, database, and publish-queue fixes
- Template scripts no longer fabricate statistics
- ESLint and GitHub Actions CI

## v2.0

- Provider and media model refresh
- OpenAI SDK v6, `@google/genai` v2.9, `replicate` v1.4, and `googleapis` v173
- Revamped setup wizard and TTS selection
- Deprecated OpenAI SDK call patterns removed
- Dynamic year handling in content strategy
- Developer-focused README and Mermaid architecture diagrams
