# Deployment files

The supported Helmsman v0.10 production deployment uses the GitHub Release `compose.yaml` and environment example to pull the exact multi-architecture image digest published by GitHub Container Registry. It does not build application source on the Docker host. Full installation, update, rollback, GitHub publication, and source-build instructions are in [DOCKER.md](DOCKER.md).

## Published deployment

Pushing the Git tag `v0.10.0-beta.9` runs the Node contracts and Linux AMD64/ARM64 smoke tests. A successful tagged workflow publishes version, beta, and full-commit tags with provenance and an SBOM, then creates a GitHub Release containing `compose.yaml`, `container.env.example`, and `SHA256SUMS`. The workflow replaces the source tree's tagged placeholder with the actual lowercase GHCR image path and exact manifest digest, then checksums both deployment files before publishing the release and all three assets together.

After downloading those three files into one directory and verifying `sha256sum -c SHA256SUMS`:

```sh
cp container.env.example .env
docker compose config
docker compose pull
docker compose up -d
docker compose ps
```

PowerShell uses `Copy-Item .\container.env.example .\.env` for the first command. A public GHCR package can be pulled anonymously. A private package requires a one-time `docker login ghcr.io` using a GitHub personal access token (classic) with `read:packages` and package access. Repository and package visibility are separate; making the package public removes pull authentication and cannot be undone.

The Compose project has the stable name `helmsman`; its `helmsman-data` volume preserves configuration, the reusable access-key verifier, encrypted credentials, sessions, network approvals, and the easy-mode encryption key when the image is updated. Never use `docker compose down -v` for an ordinary update.

Updates use the same `docker compose pull` and `docker compose up -d` commands after changing `HELMSMAN_IMAGE` to the next release's digest-pinned reference. Back up the volume first. An older image digest is a safe application rollback only when its documented state schema remains compatible; otherwise restore the volume backup made for that older image.

## Repository deployment helpers

The three GitHub Release assets are the complete base deployment. These additional files remain in the repository at the matching version tag for operators who need an optional deployment mode:

- Root `compose.yaml` is the pull-only production definition.
- Root `compose.dev.yaml` adds the local Docker build and is only for source development.
- `compose.hardened.yaml` optionally materializes an operator-exported key as a UID/GID 10001, mode `0400` Docker secret. Keep the 64-character hex key outside the project and `.env`.
- `compose.upgrade-v0.5.yaml` is an upgrade-only override that reuses one explicitly named existing v0.5 volume. Fresh installs must not use it.
- `Caddyfile.container-edge.lan.example` is an optional private-LAN or VPN HTTPS edge.
- `Caddyfile.container-edge.authentik.example` is an optional HTTPS edge with Authentik forward authentication and MFA.

To build from a source checkout instead of pulling the release image:

```sh
docker compose -f compose.yaml -f compose.dev.yaml build --pull
docker compose -f compose.yaml -f compose.dev.yaml up -d
```

Use the same Compose file set for every command so the same service and volume are selected.

## Security and connectivity

The default network policy needs no allowed CIDRs: it records only the resolved safe private `/32` or `/128` addresses for each registered media connection, Proxmox endpoint, or Portainer server. Manual private CIDRs are an optional advanced boundary; immutable SSRF blocks and the public-HTTP prohibition still apply.

Caddy and Authentik are not installed or started in the application container. Localhost use requires neither, and another trusted HTTPS proxy such as Cloudflare Tunnel may be used. External authentication and MFA protect browser access only; they do not replace the credentials Helmsman needs for Jellyfin, Seerr, Proxmox, Portainer, or another upstream system. The reusable Helmsman access key does not change those edge configurations or the container's direct upstream connections.

A fresh claim creates one reusable 256-bit access key and shows it once. The same key unlocks any browser into its own one-year, origin-bound HttpOnly session. Helmsman stores only the key's SHA-256 verifier: the plaintext value is never configured through `.env`, put in a URL or browser storage, or written to application logs. Settings can create or rotate the key; rotation revokes prior browser sessions, replaces the rotating browser's session, and leaves service configuration and encrypted credentials unchanged. Operators locked out of every session can stop the service and run `docker compose run --rm --no-deps helmsman rotate-access-key --confirm`; that CLI prints the new key once.

Media and Infrastructure are separate workspaces in the same container. Infrastructure models standalone Proxmox servers and clusters as environments, with separately approved API endpoints, physical nodes, and VM/LXC workloads. It also holds up to eight independent Portainer servers using HTTPS with system or pinned certificate trust and encrypted write-only `X-API-Key` access tokens. Both connectors permit only fixed read-only API checks; the image has no Proxmox or Portainer control actions, SSH credentials, Docker socket, or host mount. Stopped Portainer containers remain informational.

The v0.10 Media workspace remains read-only. It correlates bounded Jellyfin, Seerr, Radarr, Sonarr, qBittorrent, and Bazarr records by provider/download identifiers, exposes current lifecycle and activity state, and serves artwork only through an authenticated opaque Helmsman URL. A fixed Jellyfin Now Playing check retains media/play-state fields while discarding session identity metadata. Its normalized catalog and bounded positive/negative artwork cache remain in memory. Locally bundled service marks, including Portainer, require no runtime icon CDN; their source and trademark notice is included beside the assets. The authenticated shell uses an original hard-framed retro-web treatment while retaining the Helmsman slate-and-teal palette.
