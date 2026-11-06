# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-06

First release.

### Added

- Guided `setup`: your own Meta app with Facebook Login or Instagram Login, media host choice, sign-in, AI providers, AI app integration and a background service.
- Media hosts for Meta to fetch local files: Cloudflare quick tunnel (zero setup, `cloudflared` downloaded on request), S3-compatible buckets (AWS S3, R2, B2, MinIO) with presigned links, and Azure Blob Storage with read-only SAS links.
- Publishing: photos, reels, carousels (2-20 items), stories and trial reels from files or URLs, with captions, first comment, collaborators, user tags, location, alt text, covers and AI-content label. ffmpeg conversion to Instagram's specs.
- Scheduling with a persistent, checkpointed job queue: resumable video upload (Facebook Login), container polling, re-hosting on fetch failures, publishing-limit waits, crash-safe publishing.
- Library, comments, private replies, mentions and DMs; media and account insights, demographics and CSV export.
- Growth tools: post diagnosis, outliers, best publish time, hashtag research with the 7-day budget, competitor benchmarks, content ideas.
- A/B testing with trial reels and a significance test.
- AI tools with Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq and Ollama: captions, hashtags, carousel outlines, cover critique, translation, reels from long videos, comment triage.
- Confirmation gate for every public or destructive action.

[Unreleased]: https://github.com/joinhackyard/instagram-account-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/joinhackyard/instagram-account-mcp/releases/tag/v0.1.0
