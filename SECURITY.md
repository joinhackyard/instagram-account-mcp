# Security Policy

## Supported versions

Security fixes go into the latest release. Please upgrade to it: `npx @joinhackyard/instagram-account-mcp@latest`.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately instead:

- **Preferred:** [Report a vulnerability](https://github.com/joinhackyard/instagram-account-mcp/security/advisories/new) through GitHub's private advisory form.
- **Or email:** hello@hackyard.org, with "SECURITY" in the subject.

Include the version, your OS and MCP client, steps to reproduce, and the impact you see. We acknowledge reports within 3 working days and aim to ship a fix within 30 days, sooner for serious issues. We'll credit you in the advisory unless you'd rather stay anonymous.

## Scope

In scope:

- Leaking Meta access tokens, app secrets or storage keys.
- Bypassing the confirmation gate for public or destructive actions.
- SSRF through URL sources.
- Files exposed by the tunnel media host beyond the registered file, or after publishing.
- Path traversal.
- Config writers corrupting or exposing other tools' settings.
- Supply-chain issues in the published package.

Out of scope:

- Problems in Instagram's or Meta's own services.
- Issues that need an already-compromised machine.
- An AI client ignoring the server's instructions. Elicitation-capable clients or `IG_CONFIRM=always` reduce that risk.

## How we protect users

- Tokens are stored in the OS keychain, or in an AES-256-GCM encrypted file where there is no keychain.
- Meta sign-in uses a random state and a one-shot loopback server on 127.0.0.1 (Meta's OAuth for this flow needs the app secret and has no PKCE).
- The tunnel host serves only registered files under random 192-bit paths, and the S3/Azure hosts hand Meta short-lived read-only links; files are removed after publishing.
- URL downloads are pinned to an address that passed a private-network check.
- npm releases are built and published from GitHub Actions with trusted publishing and provenance.
