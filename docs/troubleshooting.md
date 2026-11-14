# Troubleshooting

Most problems show up in the startup capability check (the `🔎 Capability check:` block when you run `npm start`) or in the job's error in the dashboard. Start there.

| Problem | Fix |
| --- | --- |
| `Missing credentials for: an AI provider` | Configure any one text provider with `npm run walkthrough` or `npm run credentials:setup`. OpenAI isn't required. |
| Google sign-in shows `Error 403: access_denied` | Add your Google account as a test user under **Google Auth Platform → Audience**. While the app is in Testing mode, Google expires the sign-in after 7 days. |
| No video is produced, or it's marked simulated | Read the ✗ lines in the startup capability check. Make sure you ran `npx playwright install chromium` and that FFmpeg is available (`npm install` fetches it, or set `FFMPEG_PATH`). |
| Images or thumbnails are missing | Image generation needs OpenAI, or Gemini with billing enabled. The content review panel shows the provider's exact error. |
| Narration failed (for example, ElevenLabs HTTP 400) | Check the key, its credits, and that `ELEVENLABS_VOICE_ID` is a voice in your account, then use **Regenerate narration only**. |
| `Error loading sharp module` on Android/Termux | Update to the latest `master`, then run `rm -rf node_modules && npm install --cpu=wasm32`. |
| The publishing queue runs but nothing publishes | Approved videos publish at their scheduled time (default: the next day at 2 PM). |
| YouTube API quota exceeded | Check quotas in Google Cloud Console and reduce posting frequency. |
| Content generation failed | Check your keys and credits, the job's error in the dashboard, and `logs/`. |
| The dashboard is unreachable from another device | It listens on `127.0.0.1` by default. Set `HOST=0.0.0.0` and an `API_KEY` in `.env`. See [environment variables](providers.md#environment-variables). |
| Gemini voice `429 ... per day` | The free voice quota is 10 requests a day per model. Narration moves to the next model in `narration_models`; it resets at midnight Pacific time (about 1:30 pm IST). |
| Gemini text `503 high demand` | Temporary. Calls retry, then use backup models (`TEXT_MODEL_FALLBACKS`). |
| Daily GitHub run fails with a YouTube/OAuth error | The weekly sign-in expired (OAuth app in Testing). Run `node modern-auth.js`, then `gh secret set TOKENS_JSON -R pranjul2001/youtube-channel-agent < config/tokens.json`. |
| Daily GitHub run: "Missing secrets" | Set `ENV_FILE`, `CREDENTIALS_JSON` and `TOKENS_JSON` with `gh secret set NAME < file`. |
| The daily video on the Mac did not start | The Mac must be awake and plugged in; the service catches up when it wakes. Check *Make one video every day* on the Topics page. |
| A topic stays "generating" | Restart the app; it recovers finished or interrupted builds automatically. |
| Off-topic stock clips | Add the clip ids to the `stock_blocklist` setting and adjust `stock_mood`. |

## Debug logging

```bash
LOG_LEVEL=debug NODE_ENV=development npm start
```

Logs are written to `logs/`.

## Getting help

Questions and setup help go in [Discussions](https://github.com/darkzOGx/youtube-automation-agent/discussions). Issues are for bugs; the bug report template asks for the capability check block, which diagnoses most problems instantly.
