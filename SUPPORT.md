# Support

Helmsman v1.0 is volunteer-maintained beta software. Breaking changes remain
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

Helmsman currently uses one shared access key and has no per-user roles or
audit attribution. Support cannot determine which person performed an action
or recover a lost plaintext access key; use the documented offline rotation
procedure and protect the host and volume backups.
