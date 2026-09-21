# Deployment files

The supported Helmsman v1.2.0 deployment uses the GitHub Release
`compose.yaml` and environment example to pull the exact multi-architecture
image digest published by GitHub Container Registry. It does not build
application source on the Docker host. Back up the `/data` volume before every
update and use the newest published release.
Full installation, update, rollback, maintainer publication, and source-build
instructions are in [DOCKER.md](DOCKER.md).

## Published deployment

Pushing the Git tag `v1.2.0` runs the Node contracts and Linux AMD64/ARM64 smoke
tests. A successful tagged workflow publishes version, `latest`, and
full-commit tags with provenance and an SBOM, then creates a GitHub Release
containing `compose.yaml`, `container.env.example`, and `SHA256SUMS`. The
workflow replaces the source tree's tagged placeholder with the canonical
lowercase GHCR image path and exact manifest digest, then checksums both
deployment files before publishing the release and all three assets together.

After downloading those three files into one directory and verifying `sha256sum -c SHA256SUMS`:

```sh
cp container.env.example .env
docker compose config
docker compose pull
docker compose up -d
docker compose ps
```

PowerShell uses `Copy-Item .\container.env.example .\.env` for the first command. A public GHCR package can be pulled anonymously. A private package requires a one-time `docker login ghcr.io` using a GitHub personal access token (classic) with `read:packages` and package access. Repository and package visibility are separate; making the package public removes pull authentication and cannot be undone.

The Compose project has the stable name `helmsman`; its `helmsman-data` volume preserves configuration, the enrolled Jellyfin-owner binding, encrypted connector and per-session login tokens, browser sessions, network approvals, and the easy-mode encryption key when the image is updated. Never use `docker compose down -v` for an ordinary update.

Updates use the same `docker compose pull` and `docker compose up -d` commands after changing `HELMSMAN_IMAGE` to the next release's digest-pinned reference. Back up the volume first. An older image digest is a safe application rollback only when its documented state schema remains compatible; otherwise restore the volume backup made for that older image.

v1.0.6 migrates state schema 4 to schema 5 so Loki connections can be stored as bounded Infrastructure observability services while preserving existing Portainer records. Do not start v1.0.5 against a volume already migrated to schema 5. A rollback to v1.0.5 requires the `/data` backup taken before the v1.0.6 upgrade.

## v1.2.0 persistent cache release

v1.2.0 restores the last successful normalized dashboard state after a
container restart and marks it **Cached data** until the first live health
cycle completes. Restored state is read-only and cannot authorize Media,
Proxmox, or Portainer controls. Successful validated raster artwork uses a
private bounded persistent tier under `/data/cache/artwork`; raw service
responses, credentials, headers, Jellyfin session identities, and Loki results
are never cached. The persistent artwork cache is limited to 2,048 entries,
512 MiB total, 4 MiB per image, and 30 days. Shared toast notifications also
use their full width so short status text no longer collapses into a narrow
column.

## v1.1.2 maintenance release

v1.1.2 fixes Infrastructure Overview text collisions on desktop and stacks the
assessment refresh action beneath its heading on narrow screens. Media
Calendar now requests a bounded one-day lookback and 35-day forward window
from Sonarr and Radarr, accepts their supported date-only release fields, and
keeps the seven-day schedule separate from **Beyond this week**.

## v1.1.1 interface refinement

v1.1.1 makes Media **Overview** the canonical landing page and redirects the
legacy `#/home` route to `#/overview`. Its visual hierarchy, spacing, labels,
and supporting copy more closely follow the approved dashboard reference while
preserving Helmsman's palette, normalized service data, and action boundaries.

The Overview uses a compact, separate presentation for connection and service
health, combines current requests with service warnings, and reports the
evidence-backed five-stage **Requested → Monitored → Downloading → Imported →
Available** lifecycle. Continue Watching leads when current Jellyfin resume
data exists; otherwise Downloads & Imports moves into that space. The bundled
local Radarr, Seerr, and Sonarr SVG marks are refreshed from the user-supplied
artwork. The visual reference guides presentation only; live normalized data
and the existing bounded actions remain authoritative.

## v1.1.0 interface release

v1.1.0 introduces the modern rounded bento presentation while retaining the
slate-and-teal palette and every existing data source and action. Its sidebar
uses the helmet and **HELMSMAN** wordmark without a subtitle; Media Home leads
with Continue Watching when data exists and otherwise promotes Downloads &
Imports into that space. Connection health and service health stay separate,
and Infrastructure Overview receives the same redesigned hierarchy without
changing its monitoring or control boundaries.

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

Caddy and Authentik are not installed or started in the application container.
Localhost use requires neither. For first claim from another computer, keep the
loopback bind and tunnel it with
`ssh -L 4180:127.0.0.1:4180 user@your-helmsman-host`, then open
`http://127.0.0.1:4180`; for permanent remote access, use a trusted HTTPS proxy
and firewall the inner port to it. Another trusted edge such as Cloudflare
Tunnel may be used. External authentication and MFA protect browser access
only; they do not replace the credentials Helmsman needs for Jellyfin, Seerr,
Proxmox, Portainer, or another upstream system. Helmsman's Jellyfin-backed
browser session does not change those edge configurations or the container's
direct upstream connections; Authentik remains the external MFA layer.

A fresh claim opens a setup session. Configure and verify Jellyfin first, then enroll one exact enabled Jellyfin administrator under Settings with only its username and password. Helmsman learns the server/user IDs internally and never requests or displays them, and public status does not disclose the enrolled username. Each browser login immediately discards the password, encrypts the resulting Jellyfin token server-side for that session, cookie verifier, immutable claims, and exact network boundary, and issues a revocable 30-day, origin-bound HttpOnly cookie plus CSRF protection. The owner/session authorization index is authenticated with the credential master key. Changing that Jellyfin boundary signs every browser out locally. Prefer a Jellyfin HTTPS URL; private HTTP is supported only for a trusted container/LAN path because it does not encrypt the password on that hop. The saved Jellyfin monitoring credential remains distinct. New logins fail during a Jellyfin outage; recently validated sessions may retain bounded read-only access, but writes require fresh validation. Operators locked out of every session can stop the service and run `docker compose run --rm --no-deps helmsman reset-access --confirm`; the next start emits a new setup token without deleting registered services or encrypted monitoring credentials.

When upgrading from v1.0.0-beta.2, its access key is a temporary migration credential only. Use it or an existing browser session to enroll the Jellyfin owner. Successful enrollment removes the verifier permanently and revokes all legacy sessions; v1.0.6 and later cannot create or rotate another browser key.

Media and Infrastructure are separate workspaces in the same container. Infrastructure models standalone Proxmox servers and clusters as environments, with separately approved API endpoints, physical nodes, and VM/LXC workloads. It also holds up to eight independent Portainer servers using HTTPS with system or pinned certificate trust and encrypted write-only `X-API-Key` access tokens. The responsive Portainer inventory groups containers by server and environment and keeps identity, stack, runtime, unique reported ports, and controls separate while labeling private-only ports as internal. Monitoring and probes remain fixed read-only GET routes. Separate actions use Helmsman's accessible in-app confirmation, revalidate the current record after approval, and use fixed method, path, query, and body templates for Portainer container start/restart/graceful stop and Proxmox QEMU/LXC start/reboot/graceful shutdown. The browser cannot supply an arbitrary upstream path or request body. The image exposes no general Proxmox, Portainer, or Docker API proxy and has no SSH credential, shell, console, Docker socket, host mount, delete/remove, force-stop, reset, kill, or bulk action. Stopped Portainer containers remain informational.

v1.0.6 includes a persistent sanitized Helmsman event journal under `/data/logs` and an optional Loki connection under **Infrastructure → Connectors → Observability**. The dedicated Loki Explorer performs bounded read-only queries; returned external log entries remain transient and are not copied into the built-in journal. Grafana is optional.

The v1.2.0 Media workspace monitors through fixed read-only GET routes. Its only media writes are a Helmsman-confirmed Seerr failed-request retry, a selected standard-season request for one exact current series through Seerr, a targeted Radarr/Sonarr search when one exact current record can be resolved, and **Block release & search again** for one exact current errored Sonarr/Radarr queue item. The last action requires a danger confirmation plus fresh, connected, revision-matched blocked/error evidence; it removes the download and its data from the client, blocklists that release, and allows normal replacement handling under the Arr service's settings. Helmsman cannot approve or delete requests, request movies or 4K/Specials, choose Seerr routing/profile fields, change monitoring, pause downloads, remove healthy or arbitrary downloads, or run free-form searches. Series and parent-resolved episode drawers load a bounded current season catalog on demand, warn when Seerr reports no TVDB mapping for an auto-approved Sonarr handoff, confirm the exact requestable standard seasons, and revalidate the current record, target, detail revision, and selection before dispatch. Contract-valid Seerr acknowledgements may omit optional echoed fields, while unreadable or HTTP 5xx mutation responses remain an uncertain outcome and require a separate refresh before another write. Helmsman correlates bounded Jellyfin, Seerr, Radarr, Sonarr, qBittorrent, and Bazarr records by provider/download identifiers, exposes current lifecycle and activity state, and serves artwork only through an authenticated opaque Helmsman URL. A fixed Jellyfin Now Playing check retains media/play-state fields while discarding session identity metadata. Its normalized dashboard snapshot and successful artwork can be restored from the bounded private persistent cache, while negative artwork results remain memory-only. Reviewed, hash-pinned icons for all nine supported service integrations are bundled locally and require no runtime icon CDN; the user-supplied Radarr, Seerr, and Sonarr SVG refreshes are included, original generic workload SVGs are also local, and compatible-service names and trademarks remain their owners' property. The authenticated shell uses a reference-aligned rounded bento-style operations dashboard while retaining the Helmsman slate-and-teal palette.
