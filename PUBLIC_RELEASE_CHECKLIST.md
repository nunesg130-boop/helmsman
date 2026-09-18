# Public release checklist

This checklist covers one-time or remote GitHub settings that cannot be
verified from a folder-only source archive. Complete it before changing the
repository to public and recheck it before the first public release.

> [!IMPORTANT]
> Public visibility is blocked until both the complete pre-v1 Git history and
> the remote GitHub settings below have been reviewed. Earlier private history
> may contain maintainer-specific topology, paths, or publisher defaults even
> when the current tree is clean. The safest option is to publish this reviewed
> tree as the first commit of a new public repository. If preserving history,
> rewrite any sensitive objects, rotate affected secrets, and independently
> verify every reachable object before changing visibility. Do not treat this
> folder-only archive as a history audit.

## History and published material

- [ ] Scan the full Git object database, every local and remote branch, and
  every tag for credentials, private keys, tokens, internal hostnames,
  addresses, personal data, and private deployment artifacts. Scanning only
  the current tree is insufficient.
- [ ] Review existing GitHub Actions logs, uploaded artifacts, caches, release
  notes, release assets, issue attachments, and pull-request content for the
  same material.
- [ ] Revoke and rotate any secret that ever entered Git history or another
  published surface; deleting a file from the latest commit is not enough.
- [ ] Confirm the release bundles only the nine reviewed, hash-pinned local
  service icons—including the user-supplied Radarr, Seerr, and Sonarr SVG
  refreshes—and original generic workload SVGs, and includes `LICENSE` plus
  the complete asset notice and preserved Prowlarr/Freepik attribution.
- [ ] Choose and document either a clean public history or a verified rewritten
  history; record the reviewed commit hash before changing repository visibility.

## Visibility and repository controls

- [ ] Review GitHub's current visibility-change warning before confirming.
  Public visibility exposes code, history, Actions history, and repository
  metadata; existing public forks or copies cannot be recalled by making the
  repository private later.
- [ ] Immediately verify or re-enable the `main` ruleset after the visibility
  change: pull-request review, required successful Container workflow, blocked
  force pushes, and blocked deletion.
- [ ] Protect release tags matching `v*` from update, force-push, and deletion.
- [ ] Enable GitHub private vulnerability reporting and verify the link in
  `SECURITY.md` opens a private report form.
- [ ] Enable secret scanning and push protection wherever the repository and
  account plan make them available.
- [ ] Review Actions permissions, pin or approve third-party actions, and keep
  the default workflow token read-only except for the release job permissions
  explicitly declared in the workflow.
- [ ] Do not run workflows from public pull requests on a self-hosted runner.
  Public PR code is untrusted; use GitHub-hosted runners without repository
  secrets or require a trusted maintainer-controlled workflow path.
- [ ] Confirm the repository's public description, homepage, topics, default
  branch, Discussions setting, issue permissions, and fork policy are intentional.

## Container and release visibility

- [ ] Set the `ghcr.io/nunesg130-boop/helmsman` package visibility separately;
  making the repository public does not automatically make GHCR public.
- [ ] Confirm an unauthenticated `docker pull` succeeds for the intended public
  tag and that the release Compose asset resolves the expected
  `ghcr.io/nunesg130-boop/helmsman@sha256:...` digest.
- [ ] Verify the GitHub Release contains only `compose.yaml`,
  `container.env.example`, and `SHA256SUMS`, and that checksums and image
  digests validate before announcing it.

## Final public review

- [ ] Search the public tree for private-repository claims, real deployment
  hosts, credentials, personal email addresses, and operator-specific paths.
- [ ] Confirm issue templates, the pull-request template, support guidance,
  code of conduct, contribution guide, and security policy render correctly.
- [ ] Test installation from release assets as an unauthenticated new user on
  a clean Docker host.
