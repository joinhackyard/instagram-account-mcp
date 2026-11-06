# Instagram Account MCP

[![npm](https://img.shields.io/npm/v/@joinhackyard/instagram-account-mcp?color=2b5ce4)](https://www.npmjs.com/package/@joinhackyard/instagram-account-mcp)
[![CI](https://github.com/joinhackyard/instagram-account-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/joinhackyard/instagram-account-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2b5ce4)](LICENSE)
[![Node](https://img.shields.io/node/v/@joinhackyard/instagram-account-mcp?color=2b5ce4)](https://nodejs.org)

Run and grow an Instagram professional account from Claude, Hermes, Cursor, Codex, Windsurf or any MCP client. Publish and schedule reels, carousels, photos and stories, A/B test reels with trial reels, answer comments and DMs, read insights, find outliers and the best time to post, research hashtags and competitors, and turn long videos into reels.

> “Post `~/Desktop/launch.mp4` as a reel on Friday at 6 pm with a caption in my Hackyard template.”
> “Which of my last 30 posts got the most saves per reach, and why?”
> “Reply to the unanswered questions on yesterday's reel.”

It runs on your own computer, talks only to **Meta's official Instagram API**, and keeps your tokens in your **OS keychain**. No browser automation, no passwords, no third-party server.

```bash
npx @joinhackyard/instagram-account-mcp setup
```

Setup takes about ten minutes the first time: it walks you through creating your own Meta app, picks how files reach Meta, connects your account and adds itself to the AI apps on your machine.

## What it covers

| Area            |                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Publishing**  | Photos, reels, carousels (2–20 images and videos), stories and trial reels from local files or URLs. Captions, first comment, collaborators, user tags, location, alt text, cover image or frame, AI-content label. Files are converted to Instagram's specs with ffmpeg. |
| **Scheduling**  | `publish_at` up to 75 days ahead. Instagram has no API scheduling, so a persistent local queue (and an optional background service) publishes on time, survives restarts, and waits out the daily publishing limit instead of failing.                                    |
| **Reliability** | Every post is a checkpointed job: resumable video upload (Facebook Login), container polling with backoff, re-hosting when Meta cannot fetch a file, no double publishing after a crash, per-job leases so several AI apps can share one queue.                           |
| **Engagement**  | Comments with replies, reply, comment, hide, delete, private replies to commenters, mentions and tags, DM conversations and replies inside the 24-hour window, AI comment triage.                                                                                         |
| **Insights**    | Per-post metrics (views, reach, saves, shares, watch time, skip rate, story navigation…), account metrics with breakdowns, follower and engaged-audience demographics, CSV export.                                                                                        |
| **Growth**      | Post diagnosis against your own baseline, outliers, best publish time from your history, hashtag research with the 7-day budget tracked, competitor benchmarks through Business Discovery, content ideas.                                                                 |
| **A/B testing** | 2–4 reel variants published as trial reels to non-followers, compared on views, reach, shares, saves, engagement or watch time with a significance test, then shared by you in the app or republished automatically.                                                      |
| **AI**          | Captions, hashtags, carousel outlines, cover critique, translations, reels cut from long videos, comment triage. Bring Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq or Ollama, or let your AI app write from the brief.                                         |

## Install

Requirements: **Node.js 22.13+** and an **Instagram Business or Creator account** (switching is free in the Instagram app). Recommended: **ffmpeg** (media conversion, transcription, reels from long videos).

```bash
npx @joinhackyard/instagram-account-mcp setup
```

Setup walks through six steps:

1. **Your Meta app** (one time). Meta only lets tools post through an app you own. Choose a login type:

   |                                             | Facebook Login (recommended)                | Instagram Login                  |
   | ------------------------------------------- | ------------------------------------------- | -------------------------------- |
   | Needs                                       | Instagram account linked to a Facebook Page | Just the Instagram account       |
   | Token                                       | Page token, does not expire                 | 60 days, refreshed automatically |
   | Local videos                                | Uploaded straight to Meta (resumable)       | Through the media host           |
   | Delete posts, hashtag research, competitors | ✓                                           | Not offered by Meta              |

   **Facebook Login:** [create an app](https://developers.facebook.com/apps/creation/) (use case _Other_, type _Business_), add the products **Instagram → API setup with Facebook login** and **Facebook Login for Business**, add `http://localhost:8765/callback` under _Valid OAuth Redirect URIs_, and copy the App ID and secret from _App settings → Basic_.

   **Instagram Login:** [create an app](https://developers.facebook.com/apps/creation/) with the use case _Manage messaging & content on Instagram_, open **API setup with Instagram business login**, add `http://localhost:8765/callback` as a redirect URI, copy the **Instagram** app ID and secret, and add your account as an _Instagram Tester_ under _App roles_ (accept the invite in Instagram).

   Your own app needs no App Review to manage accounts you own or manage (Meta's _Standard Access_). If Meta insists on an `https` redirect, register `https://localhost:8765/callback` instead: after signing in, the page will not load, and you paste its address back (setup and `complete_connect` handle that).

2. **Media host.** Meta downloads images (and, with Instagram Login, videos) from a public link. Pick one:
   - **Tunnel** (default, zero setup): a Cloudflare quick tunnel serves the one file being published from this computer, under a random link, only until Meta has fetched it. Setup downloads `cloudflared` for you. This computer must be online when a post publishes.
   - **S3-compatible bucket** (AWS S3, Cloudflare R2, Backblaze B2, MinIO): best for scheduling. Files get short-lived presigned links and are deleted after publishing.
   - **Azure Blob Storage**: account name and key (each file gets a read-only link), or a container SAS URL.

3. **Connect.** Your browser opens the Meta sign-in. With Facebook Login, select the Page your Instagram is linked to; every Instagram account behind the selected Pages is connected.
4. **AI providers** (optional): add Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq, Ollama or a custom endpoint, and pick a model per job.
5. **Add to your AI apps.** It detects and configures **Claude Desktop, Claude Code, Cursor, Windsurf, Codex and Hermes Agent**, keeping your original config as `*.before-instagram-account-mcp.bak`. Restart the app afterwards.
6. **Background service** (recommended): publishes scheduled posts, finishes A/B tests and keeps sign-ins fresh when no AI app is open (launchd on macOS, systemd on Linux, Task Scheduler on Windows).

Prefer a global install? `npm i -g @joinhackyard/instagram-account-mcp && instagram-account-mcp setup`.

### Manual configuration

`npx @joinhackyard/instagram-account-mcp config` prints snippets for your machine. The general shape:

```json
{
  "mcpServers": {
    "instagram-account": {
      "command": "npx",
      "args": ["-y", "@joinhackyard/instagram-account-mcp@latest"]
    }
  }
}
```

Hermes Agent (`~/.hermes/config.yaml`), where tools appear as `mcp_instagram_account_*`:

```yaml
mcp_servers:
  instagram-account:
    command: "npx"
    args: ["-y", "@joinhackyard/instagram-account-mcp@latest"]
    timeout: 180
```

Claude Code: `claude mcp add instagram-account --scope user -- npx -y @joinhackyard/instagram-account-mcp@latest`

## Try it

- “Check my Instagram connection.”
- “Post ~/Pictures/team.jpg with a short caption about demo day and tag @the.hackyard as collaborator.”
- “Turn these 8 photos in ~/Pictures/build2026 into a carousel, write the caption with my build2026 template and schedule it for Saturday 7 pm IST.”
- “Make a reel from ~/Videos/talk.mp4: find the three strongest 30-second moments, cut them vertical, and show me captions before posting the best one.”
- “A/B test these two hooks as trial reels for 48 hours and tell me which wins on shares.”
- “How did my reels do this month compared with last month? Which three posts were outliers and why?”
- “When are my followers most responsive? Plan next week's posting times.”
- “List comments from the last 5 posts I haven't answered, and draft replies.”
- “DM everyone who commented ‘guide’ on my last reel with the link.” (private replies, one per comment, within 7 days)
- “Research #buildinpublic and #indiehackers and benchmark @someaccount against us.”
- “Export insights for every post this quarter to a CSV.”

## Tools

| Area        | Tools                                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account     | `auth_status`, `connect_account`, `complete_connect`, `list_accounts`, `get_profile`, `set_default_account`, `disconnect_account`                                                                                                                               |
| Publish     | `publish_photo`, `publish_reel`, `publish_carousel`, `publish_story`, `publish_trial_reel`, `get_publish_status`, `list_scheduled`, `reschedule`, `cancel_scheduled`, `resume_publish`, `prepare_media`, `publish_budget`, `media_host_status`, `find_location` |
| Library     | `list_media`, `get_media`, `list_stories`, `list_tagged`, `toggle_comments`, `delete_media`                                                                                                                                                                     |
| Engage      | `list_comments`, `reply_to_comment`, `comment_on_media`, `hide_comment`, `delete_comment`, `private_reply`, `list_mentions`, `list_conversations`, `get_conversation`, `send_dm`, `triage_comments`                                                             |
| Insights    | `get_media_insights`, `get_account_insights`, `get_audience`, `export_insights`                                                                                                                                                                                 |
| Grow        | `analyze_post`, `find_outliers`, `best_publish_time`, `hashtag_research`, `hashtag_budget`, `benchmark_competitor`, `content_ideas`, `caption_check`                                                                                                            |
| A/B testing | `create_ab_test`, `get_ab_test`, `list_ab_tests`, `stop_ab_test`                                                                                                                                                                                                |
| Create      | `generate_caption`, `generate_hashtags`, `suggest_carousel`, `critique_cover`, `translate_caption`, `repurpose_video`                                                                                                                                           |
| Setup       | `ai_status`, `set_ai_models`, `list_templates`, `save_template`, `delete_template`                                                                                                                                                                              |

## A/B testing with trial reels

Trial reels are shown to non-followers first, so variants do not compete in your followers' feeds. `create_ab_test` publishes 2–4 variants (different video, hook, caption or cover) at the same time, snapshots their insights at 6 hours, 24 hours and the decision time (default 48 hours), and compares them:

- views and reach with a Poisson rate test; shares, saves and engagement as rates per reach with a two-proportion test; both one-sided with a Bonferroni correction;
- a winner needs at least 90% confidence and a 5% lift, and each variant at least 100 accounts reached, otherwise the result is “inconclusive”;
- average watch time can only produce a “likely winner” (Meta reports the average, not the distribution).

Meta's API cannot share a trial reel with your followers. Share the winner yourself in the Instagram app, let Instagram decide (`SS_PERFORMANCE` graduation), or set `share_winner: "republish"` to post the winning variant as a normal reel.

## AI providers

Connect any mix in a terminal with `npx @joinhackyard/instagram-account-mcp ai`. Keys go to your OS keychain and are never sent through chat.

| Provider                  | Writing & analysis            | Vision | Images            | Transcription             |
| ------------------------- | ----------------------------- | ------ | ----------------- | ------------------------- |
| Anthropic Claude          | ✓ (default `claude-opus-5-5`) | ✓      |                   |                           |
| OpenAI                    | ✓                             | ✓      | ✓ (`gpt-image-2`) | ✓ (`whisper-1`)           |
| Azure OpenAI / AI Foundry | ✓                             | ✓      | ✓                 | ✓ (your deployment names) |
| Google Gemini             | ✓                             | ✓      | ✓                 | ✓                         |
| OpenRouter                | ✓                             | ✓      |                   |                           |
| Groq                      | ✓                             |        |                   | ✓ (`whisper-large-v3`)    |
| Ollama (local)            | ✓                             | ✓      |                   |                           |
| Other OpenAI-compatible   | ✓                             | ✓      | ✓                 | ✓                         |

Without a provider, the AI tools return the data they gathered plus a brief, and your AI app writes the result. They never publish anything themselves.

## Approvals

Reading is free. Anything other people will see or that cannot be undone needs your approval: publishing and scheduling, A/B tests, replies, comments, private replies and DMs, hiding or deleting comments, turning comments off, deleting posts, and disconnecting accounts. Checks that Meta would refuse anyway (login type, the DM window, caption limits) run before you are asked.

- In clients that support MCP elicitation, you get a confirm dialog.
- Otherwise the tool returns `CONFIRMATION REQUIRED` with a summary and a single-use token tied to those exact arguments. If the arguments change, the token is rejected. This relies on the AI following instructions, so prefer clients with elicitation, or `IG_CONFIRM=always`, when the AI reads untrusted text such as comments and DMs.

Set `IG_CONFIRM=always` to confirm every write, or `never` for unattended pipelines.

## Templates

Templates are JSON files in `~/.instagram-account-mcp/templates/` (or ask your AI to call `save_template`):

```json
{
  "name": "launch",
  "description": "Product launch posts",
  "caption_footer": "Link in bio.",
  "hashtags": ["buildinpublic", "startup"],
  "hashtags_in": "first_comment",
  "mentions": ["cofounder"],
  "collaborators": ["partnerbrand"],
  "guidance": "First line is the outcome in under 12 words. No emoji strings."
}
```

`extends` inherits another template; hashtags, mentions and collaborators are merged, and `guidance` is passed to your AI when it writes captions. See [`examples/templates`](examples/templates).

## Things Meta decides (worth knowing)

- **Professional accounts only.** Personal accounts cannot use the API. Switching to Business or Creator is free and reversible.
- **Daily publishing limit.** Each account can publish a fixed number of posts through the API per rolling 24 hours (Meta's docs say 50 in one place and 100 in another; `publish_budget` reads the live number). Carousels count once. Posts over the limit wait in the queue.
- **Not possible through the API:** licensed music from Instagram's library, filters, story stickers and link stickers, shopping tags, editing a caption after publishing, and graduating a trial reel. Delete, hashtag search and Business Discovery need Facebook Login.
- **Messaging windows.** You can DM someone within 24 hours of their last message to you, and send one private reply to a comment within 7 days.
- **Hashtag search budget.** 30 different hashtags per account per rolling 7 days.
- **Story insights** disappear after 24 hours and are hidden below 5 viewers.
- **Instagram Login tokens** expire after 60 days without a refresh. The server refreshes them in the background; if it was off for two months, reconnect.

## Configuration

Everything works without these. Environment variables override what setup stored.

| Variable                                                                                                                    | Default                                   |                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `IG_MCP_APP_ID` / `IG_MCP_APP_SECRET`                                                                                       | from keychain                             | Your Meta app (Instagram app ID/secret for Instagram Login)  |
| `IG_AUTH_MODE`                                                                                                              | `facebook`                                | `facebook` or `instagram`                                    |
| `IG_MCP_CONFIG_ID`                                                                                                          |                                           | Facebook Login for Business configuration ID (optional)      |
| `IG_REDIRECT_PORT` / `IG_REDIRECT_URI`                                                                                      | `8765` / `http://localhost:8765/callback` | Must match the redirect URI registered in the app            |
| `IG_GRAPH_VERSION`                                                                                                          | `v27.0`                                   | Graph API version                                            |
| `IG_MCP_HOME`                                                                                                               | `~/.instagram-account-mcp`                | Data folder (state database, templates, exports, temp media) |
| `IG_CONFIRM`                                                                                                                | `public`                                  | `public`, `always` or `never`                                |
| `IG_MEDIA_HOST`                                                                                                             | `auto`                                    | `tunnel`, `s3`, `azure`; `auto` prefers a configured bucket  |
| `IG_S3_ENDPOINT`, `IG_S3_REGION`, `IG_S3_BUCKET`, `IG_S3_ACCESS_KEY_ID`, `IG_S3_SECRET_ACCESS_KEY`, `IG_S3_PUBLIC_BASE_URL` |                                           | S3-compatible media host                                     |
| `IG_AZURE_STORAGE_ACCOUNT`, `IG_AZURE_STORAGE_KEY`, `IG_AZURE_CONTAINER` or `IG_AZURE_CONTAINER_SAS_URL`                    |                                           | Azure Blob media host                                        |
| `IG_MEDIA_TTL_HOURS`                                                                                                        | `48`                                      | How long hosted links stay valid at most                     |
| `IG_CLOUDFLARED`                                                                                                            | auto                                      | Path to `cloudflared`                                        |
| `IG_DAILY_POST_LIMIT`                                                                                                       | `100`                                     | Fallback when Meta's live limit cannot be read               |
| `IG_MCP_VAULT`                                                                                                              | auto                                      | `file` to use the encrypted file instead of the OS keychain  |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`                               | from keychain                             | AI provider keys                                             |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_API_VERSION`                                               | from `ai`                                 | Azure OpenAI resource                                        |
| `IG_AI_TEXT_MODEL`, `IG_AI_VISION_MODEL`, `IG_AI_IMAGE_MODEL`, `IG_AI_TRANSCRIBE_MODEL`                                     | from `ai`                                 | `provider:model` per job                                     |

## Security

- Meta tokens, the app secret and storage keys are stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service), or an AES-256-GCM encrypted file where there is none.
- Sign-in uses a random state and a one-shot loopback server on `127.0.0.1`.
- The tunnel host only answers for the file being published, under a random 192-bit path, and stops when idle. Bucket hosts hand Meta short-lived read-only links. Hosted files are deleted after publishing.
- URL sources refuse private and internal addresses.
- Logs redact tokens and signed URLs. An audit log of posts and changes is kept in the local database.
- `disconnect_account revoke=true` removes the app's permissions (Facebook Login).

## CLI

```
instagram-account-mcp setup              guided setup (safe to re-run)
instagram-account-mcp connect            connect or reconnect accounts
instagram-account-mcp media [kind|test]  choose and test the media host (tunnel, s3, azure)
instagram-account-mcp status             accounts, scheduled and recent posts
instagram-account-mcp doctor             check everything, explain fixes
instagram-account-mcp install [ids|all]  claude-desktop, claude-code, cursor, windsurf, codex, hermes
instagram-account-mcp uninstall [ids]
instagram-account-mcp config             print config snippets
instagram-account-mcp ai                 connect AI providers and choose models
instagram-account-mcp service install    keep scheduled posts and A/B tests running in the background
instagram-account-mcp daemon             run background work in the foreground
```

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

- Questions and setup help: [Discussions](https://github.com/joinhackyard/instagram-account-mcp/discussions), see also [SUPPORT.md](SUPPORT.md)
- Bugs and ideas: [Issues](https://github.com/joinhackyard/instagram-account-mcp/issues/new/choose)
- Security problems: report privately, see [SECURITY.md](SECURITY.md)
- Release notes: [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE). Built and maintained by [Hackyard](https://hackyard.org). Not affiliated with, or endorsed by, Instagram or Meta. Instagram is a trademark of Meta Platforms, Inc.
