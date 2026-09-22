# Maintainer release process

Helmsman uses GitHub as the release boundary: a versioned source package is
statically validated, copied into a clean clone, reviewed, and committed to
`main`. Candidate code runs only on hosted GitHub Actions; the version is
tagged only after the exact `main` workflow succeeds. The tag workflow publishes Linux
AMD64 and ARM64 images to GHCR and creates the matching GitHub release.

This guide is for maintainers of the canonical repository. Normal operators
should install the checksum-verified assets documented in
[deploy/DOCKER.md](deploy/DOCKER.md); they do not need the publisher or GitHub
write access.

Use local source builds for experiments. Publish every version that you intend
to deploy on a Helmsman host, so each deployed image has an immutable tag
and an easy rollback point. There is no need to publish every intermediate
local edit.

For the public launch, verify the canonical repository and GHCR package are
both public; GitHub controls their visibility separately. Source code is
released under AGPL-3.0-only. The interface uses reviewed, hash-pinned local
icons only to identify its nine supported service integrations, including the
user-supplied Radarr, Seerr, and Sonarr SVG refreshes in v1.1.1, plus
original generic workload SVGs; compatible-service names and trademarks remain their
owners' property as documented in
`assets/services/THIRD_PARTY_NOTICES.md`. Complete
[PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md) before the first
public release or after a material change to repository security settings.

## Recommended workflow: one launcher on any computer

The release launcher is version-independent. Every full Helmsman source
archive carries these two files at its root:

- `Publish-Helmsman.cmd` — the double-click entry point; and
- `Publish-Helmsman.ps1` — the Windows PowerShell 5.1-compatible launcher.

Extract any future Helmsman source archive and double-click
`Publish-Helmsman.cmd`. There is no release number or source path to edit. The
launcher reads the authoritative SemVer version from that source's
`package.json`, and the same launcher flow works for prereleases, stable
versions, and a different Windows computer.

Do not manually copy release files into the persistent Git clone. The launcher
performs the validated synchronization before the guarded publisher shows the
staged review.

To start the same flow from PowerShell:

```powershell
Set-Location "C:\path\to\the\extracted\helmsman"
.\Publish-Helmsman.ps1
```

When a standalone launcher copy outside both the source and publishing clone is
started, select the manually extracted release folder when prompted. The
folder picker accepts either the outer version folder that contains
`helmsman` or the inner `helmsman` source folder itself. An extracted source
folder can also be supplied explicitly without embedding a version in the
command:

Extract into a normal local folder such as `C:\Helmsman-Releases`. If OneDrive
marks the extracted tree as a cloud placeholder or reparse point, move or
re-extract it there before publishing.

```powershell
.\Publish-Helmsman.ps1 -SourcePath "C:\path\to\the\extracted\release"
```

Do not run the root launcher from
`%USERPROFILE%\Downloads\helmsman-github`. It intentionally refuses to use the
persistent publishing clone as its release source, preventing self-overwrite.
The advanced direct publisher command later in this guide is the only command
that is run from that clone.

The launcher performs the per-computer preparation that previously required a
checklist. It:

1. checks Windows PowerShell, checks or installs Git, and requires GitHub CLI
   2.57.0 or newer;
2. starts browser-based GitHub authentication when needed and verifies the
   exact active `nunesg130-boop` account, the `repo` and `workflow`
   permissions, write access to the canonical repository, and noninteractive
   HTTPS Git access without SSH or URL rewriting;
3. creates or validates the persistent
   `%USERPROFILE%\Downloads\helmsman-github` clone of
   `nunesg130-boop/helmsman`; if that managed clone is incomplete, dirty, on a
   different branch, has a noncanonical effective fetch or push URL, or
   contains a clean local commit that cannot fast-forward to `origin/main`, it
   is preserved and the launcher creates or reuses
   `%USERPROFILE%\Downloads\helmsman-github-recovery` as the persistent
   publishing clone; incompatible occupied recovery paths are preserved and
   skipped with bounded `-2`, `-3`, and later suffixes;
4. configures the repository-local author and GitHub noreply address;
5. resolves the selected outer release folder or inner `helmsman` folder and
   validates the extracted source; and
6. verifies the extracted release's guarded publisher against the SHA-256
   identity bound into its launcher, then calls it with both the validated
   source and the independently verified publishing clone.

The source and persistent clone remain separate and non-nested. The launcher
preserves dirty, redirected, or unexpected managed-clone states rather than
discarding work, then advances to a separate recovery path. A clean ahead or
divergent clone keeps its local files and commit; only its remote-tracking
reference may be refreshed during comparison. The launcher reuses only a
verified clean HTTPS recovery clone on future runs and never deletes an
incompatible recovery path. An explicitly supplied `-RepositoryPath` remains
fail-closed instead of silently changing destinations. It does not
accept a different GitHub account,
repository, or workflow from the command line, and it never reads a token from
the source package.

Only these user approvals remain:

- Windows installation or UAC approval if Git or GitHub CLI is absent;
- browser GitHub authentication once per computer, or after authorization
  expires; and
- the exact `PUBLISH <detected-version>` confirmation before any commit, tag,
  or push.

The root launchers ship in the full source archive and tagged source tree. The
tracked copy in the persistent clone ensures future source archives retain the
launcher, but it is not run there. The launchers are not additional GitHub
Release deployment assets; a release still contains exactly `compose.yaml`,
`container.env.example`, and `SHA256SUMS`.

Do not put `.env`, state files, credential stores, master keys, logs, volume
backups, or a previously built archive inside a source directory. The launcher
and publisher check normal sensitive names and common embedded-secret patterns,
but those checks are not a substitute for reviewing the staged summary.

## What the guarded publisher does

The version in the selected source's `package.json` must be a new SemVer
version whose local tag, remote tag, and GitHub Release do not already exist.
After the launcher finishes its computer and source checks, the guarded
publisher stops unless the clone is the exact repository root, is on a clean
`main`, can fast-forward to `origin/main`, uses the exact effective HTTPS fetch
and push URLs without credential overrides, and the expected active GitHub CLI
account has write access plus `repo` and `workflow` permissions. It then:

1. statically validates the extracted source and release version without
   executing candidate code;
2. synchronizes it into the clone and stages the exact result;
3. shows the staged file list and diff statistics;
4. asks once for the exact confirmation `PUBLISH <version>`;
5. commits and pushes `main`;
6. waits for the successful **Container** workflow for that exact commit on
   `main`;
7. creates and pushes the annotated version tag;
8. waits for the successful tag workflow for the same commit; and
9. downloads the three GitHub Release assets, verifies their checksums and
    common digest-pinned image reference, and saves them in a new local
    `helmsman-<version>-deployment-assets` directory beside the source folder;
10. when deployment details were supplied, prints the exact transfer and
    deployment commands without running them.

Nothing is committed or pushed before the typed confirmation. The tag is not
created if the `main` workflow fails. The publisher deliberately does not run
candidate source on the credential-bearing maintainer workstation. Both hosted
GitHub workflow gates are mandatory, and each is matched to the exact commit
and ref before publication advances.

## Advanced: call the guarded publisher directly

The root launcher is the normal interface. For troubleshooting or an already
prepared publishing computer, the underlying publisher remains available from
the persistent clone. Supply a separate, non-nested extracted source folder:

```powershell
$SourcePath = "C:\path\to\the\extracted\helmsman"
Set-Location "$env:USERPROFILE\Downloads\helmsman-github"
.\scripts\Publish-HelmsmanRelease.ps1 -SourcePath $SourcePath
```

The repaired publisher can also run from the extracted release while targeting
an explicit clean clone:

```powershell
$SourcePath = "C:\path\to\the\extracted\helmsman"
$RepositoryPath = "$env:USERPROFILE\Downloads\helmsman-github-recovery"
& "$SourcePath\scripts\Publish-HelmsmanRelease.ps1" -SourcePath $SourcePath -RepositoryPath $RepositoryPath
```

Both forms independently verify the exact clone root, active GitHub identity,
repository permission, canonical effective HTTPS fetch and push URLs, and Git
credential configuration. They reject ambient `GH_TOKEN`, `GITHUB_TOKEN`,
`GH_HOST`, and `GH_CONFIG_DIR` overrides without displaying their values. Use
the root launcher when browser authentication or authorization refresh is
needed. The effective destination and credential overrides are checked again
immediately before both the `main` and tag pushes.

To make the publisher print deployment-transfer guidance after a successful
release, supply all three generic deployment values to the root launcher:

```powershell
.\Publish-Helmsman.ps1 `
  -DeploymentHost 'helmsman-host.example' `
  -DeploymentUser 'deploy-user' `
  -DeploymentRoot '/srv/apps/helmsman'
```

Omit all three to publish without deployment instructions. The publisher never
opens the SSH connection or runs the printed commands.

## Cancellation and recovery

If local validation or staging fails—or if confirmation is declined—nothing
has been committed, tagged, or pushed. The synchronized changes intentionally
remain staged so they can be inspected:

```powershell
git status --short
git diff --cached --name-status
git diff --cached --check
```

The publisher requires a clean clone at the beginning, so do not immediately
rerun it against that staged state. Either finish the reviewed release with the
manual fallback below or choose a separate clean clone. The normal launcher
automatically preserves a clean non-fast-forward default clone and switches to
the first verified or unused recovery path, beginning with
`helmsman-github-recovery`; it never resets, amends, deletes, or force-pushes
the interrupted commit. Incomplete recovery directories are also preserved and
skipped. Once a clean canonical recovery clone exists, it is reused by future
normal launcher runs.

If the push to `main` succeeds but its workflow fails, no release tag has been
created. Fix the problem in a new commit, wait for that exact `main` workflow to
pass, and then use the manual tag fallback. If the version tag was already
pushed and its workflow fails, do not move, replace, or force-push the tag.
Inspect how far publication progressed before retrying. A transient failure
before the version image is published can be rerun. If GHCR already contains
the version image but the GitHub Release was not created, the immutable-image
guard intentionally rejects every automatic rerun rather than replacing that
tag. Do not delete or move the tag or image; normally correct the problem under
a new version, or perform a carefully verified manual release repair.

## Manual fallback

The manual path remains available when resuming a reviewed staged release or
recovering after a successful `main` push. Confirm the version first, review
the staged diff, and never reuse an existing tag:

```powershell
$Version = ((Get-Content -LiteralPath .\package.json -Raw | ConvertFrom-Json).version).Trim()
$Tag = "v$Version"

git diff --cached --check
git diff --cached --name-status
git commit -m "Release Helmsman $Tag"
git push origin main

$CommitSha = (git rev-parse HEAD).Trim()
gh run list --repo nunesg130-boop/helmsman --workflow container.yml `
  --event push --commit $CommitSha --branch main
```

Wait for the matching `main` run to succeed before publishing the tag:

```powershell
git tag -a $Tag -m "Helmsman $Tag"
git push origin $Tag

gh run list --repo nunesg130-boop/helmsman --workflow container.yml `
  --event push --commit $CommitSha --branch $Tag

gh release view $Tag `
  --repo nunesg130-boop/helmsman `
  --json tagName,isDraft,isPrerelease,url,assets
```

For this stable release, the successful tag workflow publishes the exact
version tag, the moving `latest` tag, and a full commit-SHA tag. The release
deployment files are pinned to the multi-architecture manifest digest created
by that workflow.

## Deployment remains manual

Publishing never connects to, changes, or restarts a deployment host. After
the GitHub Release passes verification, the script keeps the downloaded assets
in a local directory such as:

```text
%USERPROFILE%\Downloads\helmsman-v1.3.1\helmsman-1.3.1-deployment-assets
```

It then prints—but does not execute—the exact `ssh` and `scp` commands that
create the configured release directory and transfer the verified
`compose.yaml`, `container.env.example`, and `SHA256SUMS` files there. Run those
printed commands from the same PowerShell window. Their shape is:

```powershell
$Assets = "$env:USERPROFILE\Downloads\helmsman-v1.3.1\helmsman-1.3.1-deployment-assets"
$DeployHost = "deploy-user@helmsman-host.example"
ssh $DeployHost "mkdir -p /srv/apps/helmsman/releases/v1.3.1"
scp "$Assets\compose.yaml" "${DeployHost}:/srv/apps/helmsman/releases/v1.3.1/"
scp "$Assets\container.env.example" "${DeployHost}:/srv/apps/helmsman/releases/v1.3.1/"
scp "$Assets\SHA256SUMS" "${DeployHost}:/srv/apps/helmsman/releases/v1.3.1/"
ssh $DeployHost
```

After the transfer, enter the printed SSH session and run its server block. The
printed block targets the standard single-file Compose installation. If an installation uses
`deploy/compose.upgrade-v0.5.yaml`, `deploy/compose.hardened.yaml`, or another
override, include that exact override stack in every Compose command instead
of running the printed block unchanged. The standard block first executes:

```sh
set -euo pipefail
cd /srv/apps/helmsman/releases/v1.3.1
sha256sum --strict --check SHA256SUMS
```

Only verified assets proceed to installation. The remaining printed commands:

- stop before changing anything if a backup for that version already exists,
  so a retry cannot overwrite the original rollback point; inspect or resume a
  partially completed attempt manually;
- back up the configured installation's `compose.yaml` and, when present,
  `.env` as `compose.yaml.before-1.3.1` and
  `.env.before-1.3.1`;
- explicitly unset shell-level image and Compose selector variables so they
  cannot override the verified configuration or the project choice retained
  in `.env`;
- preserve every existing `.env` setting except all old
  `HELMSMAN_IMAGE` assignments, then append one canonical assignment containing
  the release's exact `ghcr.io/nunesg130-boop/helmsman@sha256:...` digest;
- build the replacement `.env` in the configured installation directory and atomically rename it into
  place while retaining the old file's ownership and mode;
- use the verified `container.env.example` as the starting `.env` when no
  previous `.env` exists, with mode `0600`;
- install the verified digest-pinned `compose.yaml`;
- explicitly use the verified `compose.yaml` and canonicalized `.env`; the
  existing `.env` project-name choice is retained, with top-level `helmsman` as
  the default;
- require `docker compose config --images` to resolve to exactly that one
  verified digest before pulling or recreating the service; and
- pull, recreate, display status, and show the last 100 log lines.

This preserves server-specific bind, port, project, and volume settings already
in `.env`; it does not copy an environment file from the publishing computer.
For a previously absent `.env`, review the example's safe defaults after it is
created if the server needs a non-loopback bind address.

### Roll back the deployment files

The update backs up both configuration inputs because restoring only the image
line or only Compose can resolve a different image than expected. If the
release supports rolling its data schema back, restore both files and validate
the resolved image before recreating the container:

```sh
set -euo pipefail
cd /srv/apps/helmsman
cp -- compose.yaml.before-1.3.1 compose.yaml
if [ -f .env.before-1.3.1 ]; then
  cp -- .env.before-1.3.1 .env
  helmsman_env_file=.env
else
  rm -f -- .env
  helmsman_env_file=/dev/null
fi
unset HELMSMAN_IMAGE COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME COMPOSE_PROFILES
docker compose --file compose.yaml --env-file "$helmsman_env_file" config
docker compose --file compose.yaml --env-file "$helmsman_env_file" config --images
docker compose --file compose.yaml --env-file "$helmsman_env_file" pull helmsman
docker compose --file compose.yaml --env-file "$helmsman_env_file" up -d --force-recreate helmsman
docker compose --file compose.yaml --env-file "$helmsman_env_file" ps
docker compose --file compose.yaml --env-file "$helmsman_env_file" logs --tail=100 helmsman
```

These commands preserve the named `/data` volume. Never use
`docker compose down -v` for an update or rollback. Do not run an older image
against state migrated by a newer release unless backward compatibility is
explicitly documented; restore the matching pre-update volume backup when it
is not. See `deploy/DOCKER.md` for backup, rollback, optional external-key, and
reverse-proxy details.
