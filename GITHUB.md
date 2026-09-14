# Publish Helmsman through GitHub

This repository is prepared so the exact tag `v0.10.0-beta.9` tests the
application, builds Linux AMD64 and ARM64 images, publishes them to GitHub
Container Registry, and creates deployable GitHub Release assets.

Start with a private repository and private container package until a source
license is chosen and redistribution rights for every bundled third-party mark
have been confirmed.

## Create the repository

From the extracted `helmsman` directory in PowerShell, Command Prompt, or a
Unix shell:

```sh
git init
git branch -M main
git add .
git commit -m "Release Helmsman v0.10.0-beta.9"
gh auth login
gh repo create OWNER/REPOSITORY --private --source . --remote origin --push
```

Replace `OWNER/REPOSITORY` with the GitHub account or organization and the new
repository name. If the empty repository was created in the GitHub website
instead, replace the last two commands with:

```sh
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

Do not add `.env`, state files, credential stores, master keys, logs, or volume
backups. The supplied `.gitignore` excludes their normal names, but review
`git status` before every commit.

## Publish beta.9

Wait for the **Container** workflow on `main` to pass, then create the exact
annotated release tag:

```sh
git tag -a v0.10.0-beta.9 -m "Helmsman v0.10.0-beta.9"
git push origin v0.10.0-beta.9
```

The tagged workflow refuses a tag that does not match `package.json`. A
successful run publishes the exact version tag, the moving `beta` tag, and a
full commit-SHA tag. It does not publish `latest` for a prerelease. It also
creates a GitHub prerelease containing:

- `compose.yaml`
- `container.env.example`
- `SHA256SUMS`

The workflow replaces the source placeholder with the repository's lowercase
GHCR path. The published Compose and environment assets are pinned to the
multi-architecture manifest digest produced by that workflow.

## Deploy or update a server

Download all three assets from the matching GitHub Release, verify them, copy
`container.env.example` to `.env`, and edit only the bind address or port if
needed. Then run:

```sh
sha256sum -c SHA256SUMS
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

A public GHCR package can be pulled anonymously. A private package requires a
one-time Docker login on each server using a personal access token (classic)
with `read:packages` and access to the package. Never place that token in
`.env` or Compose YAML.

See `deploy/DOCKER.md` for private-release downloads, volume preservation,
backups, rollbacks, reusable access-key recovery, the optional external
encryption key, and reverse-proxy examples. The access key is created by the
running application, never by GitHub Actions, Compose, or `.env`.
