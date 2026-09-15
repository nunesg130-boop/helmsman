# Publish Helmsman through GitHub

Helmsman uses GitHub as the release boundary: a versioned source package is
copied into a clean clone, tested, committed to `main`, and then tagged only
after the exact `main` workflow succeeds. The tag workflow publishes Linux
AMD64 and ARM64 images to GHCR and creates the matching GitHub prerelease.

Use local source builds for experiments. Publish every version that you intend
to deploy on the Jellyfin server, so each deployed image has an immutable tag
and an easy rollback point. There is no need to publish every intermediate
local edit.

Start with a private repository and private container package until a source
license is chosen and redistribution rights for every bundled third-party mark
have been confirmed.

## One-time repository setup

The publisher requires Windows PowerShell 5.1 or later, Git, GitHub CLI, and an
authenticated GitHub account. Local tests additionally require Node.js
24.19.x.

From the extracted `helmsman` directory:

```powershell
git init
git branch -M main
git add .
git commit -m "Release Helmsman v0.10.0-beta.9"
gh auth login
gh repo create OWNER/REPOSITORY --private --source . --remote origin --push
```

Replace `OWNER/REPOSITORY` with the GitHub account or organization and the new
repository name. If an empty repository was created on the GitHub website,
use:

```powershell
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

Configure a Git author once if this computer does not already have one:

```powershell
$GitHubLogin = (gh api user --jq ".login").Trim()
$GitHubId = (gh api user --jq ".id").Trim()
git config user.name "YOUR NAME"
git config user.email "$GitHubId+$GitHubLogin@users.noreply.github.com"
```

Do not add `.env`, state files, credential stores, master keys, logs, volume
backups, or a previously built archive. The publisher checks the source and
staged repository for their normal names and common embedded-secret patterns,
but those checks are not a substitute for reviewing the staged summary.

### Install the publisher into an existing beta.9 clone

Adding the publisher, its contract test, and its documentation is a
**tooling-only update** to `main`. It does not change the beta.9 application
image. Review the script before allowing Windows to execute the downloaded
copy, then remove its downloaded-file block:

```powershell
Set-Location "C:\Users\admin\Downloads\helmsman-github"
Get-Content .\scripts\Publish-HelmsmanRelease.ps1
Unblock-File -LiteralPath .\scripts\Publish-HelmsmanRelease.ps1
```

Review `git status` and the staged diff, commit the supplied tooling changes,
and push only `main`. Do **not** create or push another
`v0.10.0-beta.9` tag—the existing release is immutable. The first application
tag created with this helper should be the next new version from a separately
extracted source package. GitHub executes a tag's own workflow snapshot, so the
new immutability checks begin with that next tag and do not retrofit beta.9.

## Normal future release workflow

Keep two separate, non-nested directories:

- the persistent Git clone, such as
  `C:\Users\admin\Downloads\helmsman-github`;
- the newly extracted and tested source release, such as
  `C:\Users\admin\Downloads\helmsman-v0.10.0-beta.10\helmsman`.

Keep the publisher at the tracked path
`scripts\Publish-HelmsmanRelease.ps1` inside that clone. It derives the exact
clone root from its own location and is intentionally bound to
`nunesg130-boop/helmsman` and `.github/workflows/container.yml` (shown as
**Container** in GitHub). It does not accept a different repository or workflow
from the command line.

The version in the source directory's `package.json` is authoritative. It must
be a new SemVer version whose local tag, remote tag, and GitHub Release do not
already exist.

From the existing clone, run:

```powershell
Set-Location "C:\Users\admin\Downloads\helmsman-github"

.\scripts\Publish-HelmsmanRelease.ps1 `
  -SourcePath "C:\Users\admin\Downloads\helmsman-v0.10.0-beta.10\helmsman"
```

The publisher stops unless the clone is the exact repository root, is on a
clean `main`, can fast-forward to `origin/main`, and the GitHub CLI can access
the expected repository. It then:

1. validates the extracted source and release version;
2. synchronizes it into the clone and stages the exact result;
3. runs the local test suite;
4. shows the staged file list and diff statistics;
5. asks once for the exact confirmation `PUBLISH <version>`;
6. commits and pushes `main`;
7. waits for the successful **Container** workflow for that exact commit on
   `main`;
8. creates and pushes the annotated version tag;
9. waits for the successful tag workflow for the same commit; and
10. downloads the three GitHub Release assets, verifies their checksums and
    common digest-pinned image reference, and saves them in a new local
    `helmsman-<version>-deployment-assets` directory beside the source folder;
11. prints the exact transfer and deployment commands without running them.

Nothing is committed or pushed before the typed confirmation. The tag is not
created if the `main` workflow fails.

If Node.js 24.19.x is unavailable on the publishing computer, the local test
step can be skipped explicitly:

```powershell
.\scripts\Publish-HelmsmanRelease.ps1 `
  -SourcePath "C:\Users\admin\Downloads\helmsman-v0.10.0-beta.10\helmsman" `
  -SkipLocalTests
```

`-SkipLocalTests` trades quicker setup for later feedback: both GitHub workflow
gates still run, but a problem that local tests would have caught is discovered
only after the release commit has been pushed to `main`.

## Cancellation and recovery

If validation, staging, or tests fail—or if confirmation is declined—nothing
has been committed, tagged, or pushed. The synchronized changes intentionally
remain staged so they can be inspected:

```powershell
git status --short
git diff --cached --name-status
git diff --cached --check
```

The publisher requires a clean clone at the beginning, so do not immediately
rerun it against that staged state. Either finish the reviewed release with the
manual fallback below, or return the dedicated release clone to a clean state
after preserving anything you want to keep. Re-cloning the repository is the
safest reset when the clone contains no independent work.

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
git diff --cached --check
git diff --cached --name-status
git commit -m "Release Helmsman v0.10.0-beta.10"
git push origin main

$CommitSha = (git rev-parse HEAD).Trim()
gh run list --repo nunesg130-boop/helmsman --workflow container.yml `
  --event push --commit $CommitSha --branch main
```

Wait for the matching `main` run to succeed before publishing the tag:

```powershell
git tag -a v0.10.0-beta.10 -m "Helmsman v0.10.0-beta.10"
git push origin v0.10.0-beta.10

gh run list --repo nunesg130-boop/helmsman --workflow container.yml `
  --event push --commit $CommitSha --branch v0.10.0-beta.10

gh release view v0.10.0-beta.10 `
  --repo nunesg130-boop/helmsman `
  --json tagName,isDraft,isPrerelease,url,assets
```

The successful tag workflow publishes the exact version tag, the moving
`beta` tag, and a full commit-SHA tag. It does not publish `latest` for a
prerelease. The release deployment files are pinned to the multi-architecture
manifest digest created by that workflow.

## Jellyfin server remains manual

Publishing never connects to, changes, or restarts the Jellyfin server. After
the GitHub Release passes verification, the script keeps the downloaded assets
in a local directory such as:

```text
C:\Users\admin\Downloads\helmsman-v0.10.0-beta.10\helmsman-0.10.0-beta.10-deployment-assets
```

It then prints—but does not execute—the exact `ssh` and `scp` commands that
create `/opt/helmsman/releases/v0.10.0-beta.10` and transfer the verified
`compose.yaml`, `container.env.example`, and `SHA256SUMS` files there. Run those
printed commands from the same PowerShell window. Their shape is:

```powershell
$Assets = "C:\Users\admin\Downloads\helmsman-v0.10.0-beta.10\helmsman-0.10.0-beta.10-deployment-assets"
ssh root@192.168.0.7 "mkdir -p /opt/helmsman/releases/v0.10.0-beta.10"
scp "$Assets\compose.yaml" root@192.168.0.7:/opt/helmsman/releases/v0.10.0-beta.10/
scp "$Assets\container.env.example" root@192.168.0.7:/opt/helmsman/releases/v0.10.0-beta.10/
scp "$Assets\SHA256SUMS" root@192.168.0.7:/opt/helmsman/releases/v0.10.0-beta.10/
ssh root@192.168.0.7
```

After the transfer, enter the printed SSH session and run its server block. The
printed block targets the standard single-file Compose installation used on the
current Jellyfin host. If an installation uses
`deploy/compose.upgrade-v0.5.yaml`, `deploy/compose.hardened.yaml`, or another
override, include that exact override stack in every Compose command instead
of running the printed block unchanged. The standard block first executes:

```sh
set -euo pipefail
cd /opt/helmsman/releases/v0.10.0-beta.10
sha256sum --strict --check SHA256SUMS
```

Only verified assets proceed to installation. The remaining printed commands:

- stop before changing anything if a backup for that version already exists,
  so a retry cannot overwrite the original rollback point; inspect or resume a
  partially completed attempt manually;
- back up `/opt/helmsman/compose.yaml` and, when present, `.env` as
  `compose.yaml.before-0.10.0-beta.10` and
  `.env.before-0.10.0-beta.10`;
- explicitly unset shell-level image and Compose selector variables so they
  cannot override the verified configuration or the project choice retained
  in `.env`;
- preserve every existing `.env` setting except all old
  `HELMSMAN_IMAGE` assignments, then append one canonical assignment containing
  the release's exact `ghcr.io/nunesg130-boop/helmsman@sha256:...` digest;
- build the replacement `.env` in `/opt/helmsman` and atomically rename it into
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
cd /opt/helmsman
cp -- compose.yaml.before-0.10.0-beta.10 compose.yaml
if [ -f .env.before-0.10.0-beta.10 ]; then
  cp -- .env.before-0.10.0-beta.10 .env
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
