# 4. Reliable morning trigger for the daily video

Date: 2026-11-16

## Status

Accepted

## Context

The owner's requirement is a finished, privately-uploaded video ready by **10:00 AM IST** every day.

The daily video runs on GitHub Actions ([ADR 0003](0003-daily-video-on-github-actions.md)) and was triggered only by GitHub's `schedule:` cron (06:00 IST plus backups at 07:30, 09:00, 10:30). GitHub documents scheduled workflows as best-effort: during high load they can start **hours late or be dropped entirely**. Observed:

- 2026-11-15: the 06:00 run started ~12:23 IST (~6.5 h late).
- 2026-11-16: none of the four scheduled slots fired at all by 12:00 noon.

Because every backup rode the same unreliable scheduler, a bad GitHub day missed all of them. A `schedule:`-only design therefore cannot meet a fixed 10:00 AM target.

Key observation: only GitHub's **scheduled** trigger is unreliable. A `workflow_dispatch` (the "Run workflow" button / API) starts within seconds and is dependable.

## Decision

Trigger the run from a **dependable external scheduler** that calls the workflow via `workflow_dispatch` at **08:00 IST** daily. An 08:00 start plus the ~35-minute build leaves comfortable margin before 10:00.

- Primary trigger: external scheduler (a free cron service, e.g. cron-job.org) → `POST /repos/{owner}/{repo}/actions/workflows/daily-video.yml/dispatches` with `{"ref":"channel"}`, authenticated by a fine-grained GitHub token scoped to **Actions: read and write on this repo only**.
- Bonus early tries: GitHub `schedule:` crons kept at 05:30 and 07:00 IST (best-effort). The 09:00/10:30 slots were removed because they risk finishing after 10:00.
- Duplicate protection unchanged: the `daily-video` concurrency group plus the "already made today" check in `state/history.json` means whichever run starts first makes the video and the rest exit.

## Consequences

- The 10:00 AM target no longer depends on GitHub's unreliable scheduler.
- A new external dependency (the cron service) and a stored repo-scoped token must be managed. The token is least-privilege (Actions only, one repo) and lives in the cron service, never in the repo.
- If the external service is ever down, GitHub's best-effort 05:30/07:00 tries remain as a fallback.
- An always-on host (future) running the app's own `DailyVideoService` could replace the external cron and also serve the dashboard; deferred for now to keep costs at zero.
