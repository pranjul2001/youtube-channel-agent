# CLAUDE.md

Curious Files fork of YouTube Automation Agent: a source-first documentary channel. The owner is not a developer. They approve and publish; the code does the rest. The owner's view is in `OWNER-GUIDE.md`, design in `ARCHITECTURE.md`, decisions in `docs/adr/`.

## Commands

- `npm start`: app and dashboard on http://127.0.0.1:3456
- `npm run test:offline`: full test suite with keys blanked and a temp DB (run before every commit)
- `npm run e2e`: live end-to-end check (30-second test video, never uploads); needs the app running
- `node scripts/import-approved-script.js <script.md>`: hand-written script → resumable job
- `node scripts/ci/export-seed.js`: refresh `config/channel-seed.json` after changing settings locally
- `node modern-auth.js`: YouTube re-sign-in (weekly while the OAuth app is in Testing), then `gh secret set TOKENS_JSON -R pranjul2001/youtube-channel-agent < config/tokens.json`

## Structure

- `agents/`: upstream pipeline agents. Production now uses timed narration and the documentary renderer.
- `utils/`: `narration-timing`, `documentary-renderer`, `documentary-thumbnail`, `topic-curator`, `documentary-script-writer`, `daily-video-service`, `progress-tracker`, `ai-retry`, `description-credits`.
- `scripts/ci/`: GitHub Actions entry points. `.github/workflows/daily-video.yml` and `weekly-topics.yml`.
- `docs/scripts/`: approved hand-written scripts; `docs/scripts/auto/`: scripts made by the daily run.
- `state/history.json`: videos made by the cloud runs (committed by the workflow).

## Conventions

- Branch `channel` (default, pushed to the private repo `origin`). Conventional commits.
- Channel bible rules are enforced in code, not only in prompts: grounded on-screen text, people filters, claim and number checks, honest thumbnails.
- Settings live in the DB `settings` table (`video_style`, `narration_voice`, `narration_models`, `burn_subtitles`, `daily_video_enabled`, `daily_build_time`, `stock_mood`, `stock_blocklist`, `archive_allow_share_alike`, …). Env vars override them.
- Every new behaviour gets a test in `test.js`.

## Never

- Publish or set a video public. Uploads are always `private`; the owner publishes in YouTube Studio.
- Put keys in chat, logs, the seed file or git. Use `.env` (gitignored) and GitHub Secrets via `gh secret set < file`.
- Spend money or enable paid providers (image or video billing, ElevenLabs) without the owner's explicit yes.
- Weaken approval gates or mark unmatched facts as supported.

## Gotchas

- Gemini TTS free tier: 10 requests a day **per model**; `narration_models` is the fallback order.
- Gemini text models return 503 often; use `generateTextWithRetry` (backups plus deadline).
- Wikimedia and Wikipedia rate-limit fast clients: keep the pauses, send a User-Agent, never include the owner's email.
- macOS timers stop while the laptop sleeps; the daily service polls the clock and catches up.
- `ffmpeg-static` has no ffprobe; durations come from `utils/ffmpeg.getMediaDuration`.
- Commons photos of many places are CC BY-SA only; share-alike is off by default (owner decision).
