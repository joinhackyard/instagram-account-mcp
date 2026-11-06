# Contributing

Thanks for helping make Instagram Account MCP better. Bug reports, docs fixes, new tools and client integrations are all welcome.

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/joinhackyard/instagram-account-mcp/issues/new/choose) first, so we can agree on the approach before you write code.
- **Questions:** use [Discussions](https://github.com/joinhackyard/instagram-account-mcp/discussions).
- **Security problems:** never open a public issue. Follow [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js 22.13 or newer.

```bash
git clone https://github.com/joinhackyard/instagram-account-mcp.git
cd instagram-account-mcp
npm ci
npm test            # builds with tsc, then runs the node:test suite
npm run format      # Prettier
```

Run your local build in an AI app with `node dist/src/cli.js install --node`, or point a client at `node /path/to/dist/src/cli.js`.

To try it against a real account you need your own Meta app (see the README). Use a test Instagram professional account while developing: trial reels and stories are good low-visibility test posts.

## Project layout

| Path                                   | What lives there                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `src/cli.ts`                           | CLI: `setup`, `connect`, `media`, `install`, `status`, `doctor`, stdio server   |
| `src/mcp/server.ts`, `src/mcp/tools/*` | MCP server and tools (one file per area)                                        |
| `src/mcp/helpers.ts`                   | Result helpers and the confirmation gate                                        |
| `src/meta/*`                           | Graph API client (retries, usage headers, error classification) and OAuth       |
| `src/publish/*`                        | Persistent publishing jobs, containers, resumable upload, scheduling            |
| `src/media/*`                          | ffmpeg preparation to Instagram specs; media hosts (tunnel, S3, Azure)          |
| `src/clients.ts`                       | Config writers for Claude Desktop, Claude Code, Cursor, Windsurf, Codex, Hermes |
| `test/*`                               | `node:test` suites; network calls are faked, nothing hits Meta                  |

## Guidelines

- **Official APIs only.** No browser automation, scraping or cookies.
- **Ask before anything public or destructive.** New tools that publish, post, change what viewers see, or delete must go through `confirmGate` and set the right `annotations`.
- **Respect Meta's limits.** Never loop on rate limits (codes 4, 17, 32, 613, 80002) or the publishing limit (2207042); back off and tell the user.
- **Never log secrets.** Tokens belong in the vault (`src/vault.ts`), never in files, logs or tool output.
- **Tests:** add or update tests for behaviour changes. Tests must not need network or Meta credentials.
- **Style:** TypeScript strict mode and Prettier. Keep tool descriptions short and concrete; they are prompts for the AI.

## Pull requests

1. Fork, then branch from `main`.
2. Keep each PR to one change, and update the README and `CHANGELOG.md` (under _Unreleased_) when behaviour changes.
3. Make sure `npm test` and `npm run format:check` pass. CI runs on Linux, macOS and Windows with Node 22 and 24.
4. Write the PR description as what changed and why, with how you tested it.

## Releases (maintainers)

Releases are published by GitHub Actions with npm trusted publishing. No tokens are involved.

1. Move the _Unreleased_ notes in `CHANGELOG.md` under a new version heading.
2. Bump `version` in `package.json` and `src/config.ts`.
3. Commit, then `git tag vX.Y.Z && git push origin main --tags`.

The release workflow tests, publishes to npm with provenance, and creates the GitHub Release from the changelog.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
