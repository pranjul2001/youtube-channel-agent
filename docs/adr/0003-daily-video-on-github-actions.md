# ADR 0003: Daily video from a trending-topic shortlist, run on GitHub Actions

- Status: accepted
- Date: 2026-11-14

## Context

The owner wants one finished video ready every day, made from a topic they pick the night before from a weekly list of trending topics. The list should be wide (anything trending), with each topic tagged as fitting one of the three series or as a Wildcard. Nothing may publish without the owner. It must not depend on the owner's Mac being awake: a timer on the Mac missed its build when the laptop slept on battery.

Hosting options considered:

- **Oracle Cloud Always Free (Ampere A1):** the first choice, but the free tier returned "Out of capacity" in the owner's region, and the fix (Pay As You Go) needs a card-backed account.
- **Hetzner (~€4.5/month):** reliable, but costs money.
- **GitHub Actions:** free (2,000 minutes a month on private repos; a video takes about 30–45 minutes), already connected, no server to maintain. It has no always-on dashboard.

## Decision

- **Topics:** `TopicCurator` builds a weekly shortlist from Google Trends RSS (US/GB/IN), Wikipedia's most-read pages, and YouTube most-popular when signed in. The AI proposes topics, and code enforces the rules:
  - a bible filter (no gore, crime against victims, medical or financial advice)
  - one verified, substantial Wikipedia article per topic
  - "trending" only when the trend really is the topic's subject
  - Wildcard as the default tag
- **Scripts:** `DocumentaryScriptWriter` writes only from fetched Wikipedia text. Each claim's numbers and key words must appear in the cited article, and every number spoken must appear in the sources. At most 8% of 6-word runs may be copied. Problems are sent back to the AI (three drafts at most). What still fails is flagged "NEEDS YOUR CHECK" and is never marked supported.
- **Daily build:** `DailyVideoService` reuses the hand-written-script path (`importScript` → resume job), so automatic and approved scripts produce videos the same way. It never publishes.
- **Runner:** GitHub Actions.
  - `weekly-topics.yml` posts the list as a tick-box issue.
  - `daily-video.yml` makes the ticked topic (or the top one) from 03:00 IST (moved from 06:00 because scheduled runs often start hours late) and uploads it to YouTube as **private** only.
  - It then comments with the Studio link, the script link and the facts to check, and commits the script and `state/history.json`.
  - The owner reviews and publishes in YouTube Studio. Uploading private is not publishing: the bible says "uploads stay private until approved".
- **Secrets:** `ENV_FILE`, `CREDENTIALS_JSON` and `TOKENS_JSON` are set with `gh secret set` straight from local files, so values never appear in chat or logs. They are written to disk only during a run and then deleted.
- **Settings:** non-secret channel settings, profile and strategy are exported to `config/channel-seed.json` by `scripts/ci/export-seed.js`. Run it again after changing settings locally.

## Consequences

- No dashboard review step in the cloud: the owner reviews in YouTube Studio and reads the script through the issue comment. The local dashboard keeps working for manual use.
- The YouTube refresh token expires every 7 days while the Google OAuth app is in Testing mode. Until the app is moved to Production (needs a homepage and privacy-policy page), the owner re-signs in weekly and `TOKENS_JSON` is updated.
- Scheduled GitHub runs can start late when GitHub is busy. The issue comment and Actions tab show when a video is ready.
- Sources are Wikipedia only: Gemini search grounding is not free. Scripts from the free model run about 700–850 words.
