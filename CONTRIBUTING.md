# Contributing to Helmsman

Thanks for helping improve Helmsman. Bug fixes, tests, documentation, and
focused feature proposals are welcome.

## Before opening an issue

- Search existing issues and test against the newest release.
- Use the bug or feature template and keep one problem or proposal per issue.
- Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md),
  never in a public issue.
- Replace live topology, hostnames, addresses, media titles, account names,
  credentials, tokens, cookies, and raw service responses with synthetic data.

## Development workflow

1. Fork the repository and create a focused branch from current `main`.
2. Use Node.js `>=24.19.0 <25`.
3. Make the smallest cohesive change and add or update tests for behavior.
4. Run the required checks:

   ```sh
   npm test
   ```

5. When a UI change affects geometry or responsive behavior, also run
   `npm run check:visual` in an environment with the expected Chromium
   headless shell.
6. Open a pull request with the problem, design, security impact, test results,
   and screenshots for meaningful visual changes.

The repository intentionally has no general upstream API proxy, shell, Docker
socket, host mount, arbitrary request body, or destructive action surface.
Changes that add an integration or action must preserve fixed routes and
bounded inputs, least-privilege credentials, destination validation, response
normalization, redaction, revalidation before writes, and explicit tests for
denied paths and failure states.

Do not commit generated runtime state, `.env`, credentials, master keys,
deployment logs, real API responses, data-volume backups, or release archives.
Do not add a service logo without documenting its source, permitted use, and
applicable trademark or brand requirements.

## Pull-request expectations

- Keep unrelated formatting or refactors out of the change.
- Describe compatibility or migration effects.
- Update user and deployment documentation when behavior changes.
- Do not modify generated release assets by hand.
- Expect review feedback before merge; approval is not guaranteed.

By submitting a contribution, you agree that it may be distributed under the
repository's [AGPL-3.0-only license](LICENSE). The AGPL does not grant rights
to third-party marks or project trademarks.
