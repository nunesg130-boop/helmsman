# Support

Helmsman v1.0.5 is volunteer-maintained software. Breaking changes remain
possible, community help is best effort, and only the newest published release
is supported. Back up `/data` before an update.

## Where to ask

- Use the bug-report template for reproducible defects.
- Use the feature-request template for a focused proposal and its use case.
- Use [private vulnerability reporting](https://github.com/nunesg130-boop/helmsman/security/advisories/new)
  for security problems.
- Use the installation, update, and rollback guidance in
  [deploy/DOCKER.md](deploy/DOCKER.md) before opening a deployment issue.

Include the Helmsman version, host architecture, Docker and Compose versions,
the smallest reproduction, expected behavior, and sanitized relevant output.
Do not post credentials, access keys, tokens, cookies, internal or public
addresses, real DNS names, raw API responses, `.env`, state files, data
volumes, or unredacted screenshots and logs.

There is no guaranteed response time, individual deployment administration,
or support for modified builds that cannot reproduce against current `main` or
the newest release.

Helmsman browser access is bound to one exact enrolled Jellyfin administrator
owner account and accepts that owner's Jellyfin username and password at
sign-in. Helmsman has no per-user roles or audit attribution, so support cannot
determine which person used the owner account. For browser-authentication
recovery, use the documented offline `reset-access --confirm` procedure, then
protect the Jellyfin credentials, host, and volume backups.
