# Curious Files: owner's guide

How the channel's videos get made, what happens automatically, and the few things you do. Plain English, no code.

## The daily process

| When (India time) | What happens automatically | What you do |
| --- | --- | --- |
| **Sunday, 7:30 pm** | GitHub finds what is trending (Google Trends, Wikipedia's most-read pages, YouTube trending) and posts a list of 10–14 video topics on the repo's **Issues** page. Topics you haven't used carry over. | Nothing |
| **Each night** | — | **Tick one topic** for the next morning. Optional: if nothing is ticked, the top unused topic is made. |
| **Overnight, from 3:00 am** (GitHub sometimes starts a few hours late) | GitHub researches the topic on Wikipedia, writes the script, checks every fact and number against the sources, records the voice, builds the video, and **uploads it to YouTube as PRIVATE**. The video has subtitles, maps, date cards, archive or NASA images, stock footage and a thumbnail. | Nothing |
| **When it's done, usually by morning** | GitHub comments on the topic list, which sends you an email or app notification. The comment links to the video in YouTube Studio and to the script and fact check, and lists any facts you should check. | — |
| **Whenever you like** | — | Watch the video and read the flagged facts. If you are happy, set it to **Public** (or schedule it) in YouTube Studio. If not, leave it private or delete it. |

**Nothing is ever made public automatically.** Publishing is always your click in YouTube Studio.

## Where to find things

| What | Where |
| --- | --- |
| **Topic list** (tick boxes) | GitHub → repo **youtube-channel-agent** → **Issues** → "🎬 Topics: week of …". On a phone, use the GitHub app: Profile → Repositories → youtube-channel-agent → Issues. |
| **Finished videos** | YouTube Studio → **Content**. New ones are **Private**. |
| **Scripts and fact checks** | The link in each morning's comment. All scripts are also kept in the repo folder `docs/scripts/auto`. |
| **Run history** | GitHub → repo → **Actions** tab. A green tick means it worked, a red cross means it failed. |
| **Hand-written scripts** | `docs/scripts` (Flannan Isles, Apophis, Moon). |

## Your jobs

1. **Tick a topic each night.** Optional.
2. **Review and publish** in YouTube Studio. This step is required: nothing goes public without you.
3. **Re-do the YouTube sign-in once a week.** This lasts until the Google app is moved out of "Testing" mode. Google expires the sign-in every 7 days. On the Mac, run `node modern-auth.js` in the project folder, then ask Claude to update the GitHub secret `TOKENS_JSON`.

## Making a video now (not waiting for the morning)

GitHub → repo → **Actions** → **Daily video** → **Run workflow**. To make a second video on the same day, tick "Make another video even if one was made today". The same works for **Weekly topics**, to get a fresh list now.

## If something goes wrong

- **A morning run fails:** GitHub comments on the topic list with the reason. The topic stays on the list and is tried again the next morning. The usual cause is Google's free AI being busy, which fixes itself.
- **"Uploading failed" or a YouTube error:** the weekly sign-in has probably expired. Re-do the sign-in (job 3 above).
- **The voice sounds different one day:** Google's free voice limit is 10 requests a day per voice model, and a video uses about 5. When the main model is used up, a backup model with the same voice name is used.

## Rules the system follows (channel bible)

- Every fact in a script must be found in its sources. Unmatched facts and numbers are flagged for you, never marked as checked.
- Script text is written in its own words (at most 8% may match the source wording).
- No gore, no medical or financial advice, no realistic recreations of real people, no topics centred on victims or children.
- Titles and thumbnails must match the video: no "MUST WATCH" or similar hype.
- Every description has the sources, credits for stock footage and images, and a note that the narration is AI-assisted.
- Searches for footage reject people, food, tropical scenes and AI-generated clips. Archive photos must name the subject. On-screen text must repeat the narration.

## Costs

Everything runs on free tiers: GitHub Actions (about 30–45 of 2,000 free minutes a month per video), Gemini (free text and voice), Pixabay, Wikipedia, NASA, Natural Earth. Paid tools (better voice, AI images or AI video) are optional upgrades for later, within the ₹2,600 a month you set aside.

## The local dashboard (optional)

The Mac version still works: in the project folder run `npm start`, then open http://127.0.0.1:3456.

- **Topics** page: the same topic list, with a "Make one video every day" switch.
- **Progress** panel: live bars while a video is being made or uploaded.
- **Pipeline:** review, fact-check desk, approve and publish.
- `npm run e2e` checks the whole process with a 30-second test video. It never uploads.

The Mac must be awake and plugged in for its daily build. The GitHub version does not need the Mac.
