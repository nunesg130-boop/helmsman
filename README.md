# Helmsman v0.10.0-beta.8

Helmsman is a self-hosted operations center for a homelab's media services and infrastructure. It runs as one portable Linux container on Docker Desktop, Linux, macOS, compatible NAS platforms, AMD64, and ARM64.

Version 0.10 adds read-only Portainer monitoring under Infrastructure and refreshes the authenticated application as an original retro-web operations console while preserving the v0.9 media workflow and cluster-aware Proxmox model:

- Media and Infrastructure are separate workspaces inside the same authenticated application, and only the selected workspace's navigation is shown;
- the desktop shell uses one full-bleed divider across the sidebar brand and topbar, and Media Home is bounded to the post-sidebar viewport so its hero, metrics, and horizontal poster rails cannot widen the page or run beneath the viewport edge;
- the Media workspace has dedicated **Home**, **Discover**, **Library**, **Requests**, **Activity**, **Calendar**, **Health**, and **Connections** views;
- Jellyfin, Seerr, Radarr, Sonarr, qBittorrent, and Bazarr records are correlated by TMDb, TVDb, IMDb, download, and service identifiers rather than title matching;
- Home combines current Jellyfin playback, continue-watching items, pending requests, active downloads, blocked imports, upcoming releases, recently added titles, missing media, and subtitle backlog; episode resumes use their series poster rather than an episode frame;
- Activity combines qBittorrent transfer progress, speed, and ETA with Sonarr/Radarr queue and import state, including the current bounded service-reported error when one is available;
- Requests keep Seerr approval separate from acquisition state, use exact **Awaiting approval**, **In progress**, **Available**, **Needs attention**, and **Closed** buckets, preserve the exact season/4K scope, and never treat older episodes from the same series as proof that a new request is available;
- request rows missing presentation metadata are enriched through Seerr's fixed movie/TV detail routes with revision-scoped caching and a fair three-worker background queue; the short dashboard wait no longer cancels slow TV lookups, and visible unresolved rows can resolve their cover through the same typed route on demand;
- normalized media detail retains the read-only lifecycle **Requested → Monitored → Downloading → Imported → Available** only when those stages are actually observed;
- artwork is served only through an authenticated opaque Helmsman URL, uses revisioned 342 px Jellyfin/Seerr thumbnails and fixed 250 px, 500 px, then original Radarr/Sonarr covers, safely resolves Sonarr's TV metadata through a typed Seerr lookup when its local cover is unavailable, coalesces duplicate misses, and bounds cold artwork to three concurrent upstream fetches with 64 queued requests;
- unreleased Radarr movies remain **Upcoming** and are not counted as missing, Sonarr calendar episodes inherit their parent-series poster, and calendar-only episode rows are excluded from Library;
- unchanged artwork keeps a stable browser URL with a one-day private cache, while image revisions produce a new opaque URL, cold proxy fetches receive an eight-second artwork-only budget, and temporary failures receive two bounded browser retries without cache-busting;
- locally bundled Jellyfin, Seerr, Radarr, Sonarr, Prowlarr, qBittorrent, Bazarr, Proxmox, and Portainer marks identify services without a runtime icon CDN, while dedicated VM and LXC marks identify workloads;
- media management remains read-only: v0.10 cannot approve requests, add titles, pause transfers, alter monitoring, or delete media/data;
- each standalone Proxmox server or multi-node cluster is one environment, separate from its physical nodes and VM/LXC workloads;
- **Connect and discover** verifies authentication, certificate trust, environment identity, cluster name, and visible nodes before an environment can be saved;
- an environment can have up to four explicitly approved API endpoints, each with its own URL, TLS trust, encrypted API token, and availability state;
- cluster-wide inventory is collected once per monitoring cycle through one healthy endpoint, so nodes, workloads, storage, tasks, backups, and incidents are not duplicated;
- endpoint reachability and actual Proxmox node health remain separate—loss of one endpoint can make an environment Limited while another endpoint keeps its inventory available;
- dedicated **Proxmox Environments**, **Nodes**, and **Workloads** views provide read-only topology, capacity, uptime, backup, warning, and current-state detail;
- stopped guests remain informational and do not make an environment unhealthy;
- Portainer servers are configured and monitored only in Infrastructure, independently from media connections and Proxmox environments;
- each Portainer connection verifies its API version and authenticated user, then reads bounded environment, stack, and Docker/Podman container inventories through fixed routes;
- stopped Portainer containers remain informational, while unreachable environments and genuinely unhealthy, dead, or restarting containers report their specific failure;
- infrastructure remains read-only—there are no VM, LXC, node, storage, backup, migration, console, power, container, stack, or environment control actions;
- container-side checks continue when every browser is closed;
- repeated failures become deduplicated incidents after two matching results;
- service, capability, and end-to-end pipeline health are shown separately;
- queue, request, download, import, schedule, missing-media, and subtitle-backlog views are derived without writing a media catalog or artwork cache to disk;
- current structured health reports from supported service APIs can be shown only to authenticated browsers after bounding, redaction, and escaping;
- the supplied Helmsman helmet is the sidebar, mobile, browser, and installable-app identity, and the interface uses its charcoal, slate, and muted sea-green palette in a hard-framed retro-web control-room treatment;
- credentials are encrypted in the container and are write-only through the interface;
- private-network access defaults to exact per-connection host approvals, with manual CIDR ranges available as an advanced boundary;
- browsers use revocable HttpOnly sessions, with no vault or vault passphrase;
- Caddy, Authentik, and any other compatible HTTPS/MFA edge remain optional and do not replace credentials for the upstream systems.

## Deploy the published container

Helmsman is distributed as a Linux AMD64/ARM64 image in GitHub Container Registry. A `v0.10.0-beta.8` Git tag runs the contracts and architecture smoke tests, publishes the version, beta, and full-commit image tags, and creates a GitHub Release containing ready-to-use `compose.yaml`, `container.env.example`, and `SHA256SUMS` assets. The release deployment files replace the source tree's `ghcr.io/OWNER/REPOSITORY:0.10.0-beta.8` placeholder with the real lowercase image path pinned to the exact multi-architecture manifest digest (`@sha256:...`).

Download those three files from the GitHub Release into one directory, verify the two deployment files against `SHA256SUMS`, open a terminal there, and make sure Docker Desktop or Docker Engine is running. No source checkout, Dockerfile, Node.js installation, or server-side image build is required. Private repositories can download the assets with `gh release download`; public repositories can also use a browser or `curl`.

Windows PowerShell:

```powershell
Copy-Item .\container.env.example .\.env
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

Linux or macOS:

```sh
cp container.env.example .env
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

If the GHCR package is public, Docker pulls it anonymously. If it remains private, authenticate once on the Docker host with a GitHub personal access token (classic) that has `read:packages` and access to the package:

```bash
read -rsp "GitHub package token: " GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username GITHUB_USER --password-stdin
unset GHCR_TOKEN
```

Do not store the token in `.env`, Compose YAML, the repository, or shell history. Publishing the GHCR package publicly removes this login requirement; changing package visibility does not change the digest-pinned release files. Repository and package visibility are separate settings, and changing a GHCR package to public cannot be undone.

Open `http://127.0.0.1:4180`. Paste the newest one-time setup token from the container log and name the browser. The default **Exact service addresses** network mode needs no CIDR list: when you register a private media service, Proxmox endpoint, or Portainer server, Helmsman stores only its currently resolved safe private addresses as `/32` or `/128` approvals for that connection. Manual private CIDRs remain available as an advanced, intentionally broader registration boundary. Service and endpoint URLs and credentials are entered in the interface, not `.env`.

If Docker reports that `dockerDesktopLinuxEngine` or its named pipe cannot be found, start Docker Desktop, wait until it says the engine is running, select Linux containers, and run the commands again.

The concise first-publish checklist is in [GITHUB.md](GITHUB.md). Detailed installation, update, rollback, source-build, and release instructions are in [deploy/DOCKER.md](deploy/DOCKER.md).

## Privacy and storage

There is no vendor cloud, hosted account, telemetry, analytics, advertising, tracking pixel, remote font, or runtime CDN dependency. The local container is technically a backend, but it belongs entirely to the operator and makes no outbound request except to explicitly registered media-service and infrastructure APIs.

| Location | Stored data |
|---|---|
| Browser | A revocable HttpOnly session cookie and non-secret presentation state |
| `/data/state.json` | Instance, network policy, media connections, Proxmox environments and endpoints, Portainer service records, discovered identities, exact URLs, and per-connection private-host approvals |
| `/data/sessions.json` | Browser-session hashes; never bearer tokens |
| `/data/credentials.json` | AES-256-GCM ciphertext and authenticated metadata |
| `/data/credentials.key` | Auto-generated local encryption key, unless the environment-sourced Docker secret is enabled |
| In-memory operations snapshot | Bounded normalized media records, current activity, states, safe codes, latency, counters, incidents, and recent transitions; never raw responses |

Saved credentials cannot be read back through the API. Each credential is bound to its connection's exact canonical destination; changing that URL requires a fresh credential, and offline URL tampering cannot redirect the old one. Replacing a credential overwrites it; removing a connection removes its encrypted credential. Proxmox token IDs and token secrets and Portainer access tokens are write-only just like media credentials. The monitor parses every response at a strict boundary and discards raw response bodies, headers, usernames, URLs, credentials, and unbounded error text. The authenticated UI receives only the normalized media fields needed for the desktop workflow, including bounded titles, provider identifiers, current states, progress, dates, and sanitized queue errors. Jellyfin Now Playing reads only the bounded current media item and play state; user, device, client, network, and stream-session metadata are discarded. These records and the bounded artwork cache remain in memory and are not added to `state.json`.

An authenticated browser may also receive the current live health reports built only from allowlisted `source`, `type`, and `message` fields in supported structured service health responses. Helmsman bounds their count and length, normalizes and redacts secret-like values, and the interface escapes them again before display. These reports are transient evidence in the current operations snapshot only: they are never copied into incidents, events, history, application logs, or persistent files. Raw response bodies and raw error bodies are never exposed. Service-authored reports can still contain non-secret operational details such as paths or hostnames, so treat access to the authenticated interface as sensitive.

The easy local mode keeps its generated encryption key beside ciphertext in the protected Docker volume. That protects against accidental disclosure and ciphertext-only copies, but it is not a separate trust boundary if an attacker steals the entire volume or controls the host. For encrypted backups or external deployments, use the optional Docker-secret key described below.

## Security boundary

Helmsman is not a general-purpose proxy. Every outbound request must pass all of these checks:

- the media service, Proxmox endpoint, or Portainer server has an exact registered destination;
- the connector allows that exact read-only method, API path, and query shape;
- in the default mode, every current private A and AAAA result matches the connection's saved exact `/32` or `/128` approvals; manual CIDRs can instead authorize a deliberately broader private range;
- loopback, link-local/cloud metadata, multicast, unspecified, reserved, broadcast, and mixed-policy DNS results are always rejected, regardless of mode;
- public HTTP is always rejected; public HTTPS requires the operator to enable it explicitly;
- the outbound socket is pinned to a validated address while preserving the TLS hostname;
- redirects, HTML API responses, unsupported content types, oversized bodies, excessive concurrency, and timeouts fail closed;
- browser mutations require an origin-bound HttpOnly session plus a per-session CSRF value.

The image runs as UID/GID 10001 with a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, bounded memory/PIDs/CPU, no Docker socket, and no host network. Adding Proxmox or Portainer monitoring does not grant Helmsman SSH, shell, hypervisor-console, Docker-socket, container-control, or host-filesystem access.

## Media and Infrastructure workspaces

Use the workspace switcher to keep media activity separate from host, virtualization, and container-platform health. Media navigation contains **Home**, **Discover**, **Library**, **Requests**, **Activity**, **Calendar**, **Health**, and **Connections**. Logs and Settings remain global. Search and filters operate only on the bounded records already returned by configured services; v0.10 does not send free-form discovery searches or management commands upstream.

Home keeps existing data visible while a refresh is in flight and patches volatile progress, speed, ETA, state, counts, and timestamps in place. Its Now Playing signal comes from one fixed, bounded Jellyfin sessions query and omits session identity metadata. Initial loads may use placeholders, but polling does not deliberately replace the whole page or reset stable artwork URLs. Discover presents Seerr's read-only discovery feed; items without a request are labeled **Not requested** rather than exposing an internal unknown state, and only Jellyfin evidence can label a title available in Helmsman's library. Library correlates Jellyfin availability with Radarr/Sonarr monitoring and import state. Requests preserve separate request IDs, approval state, acquisition state, requested seasons, and 4K scope; completed workflow rows become **Available** from Seerr's media availability, an exact Jellyfin movie match, or—when a series request is season-scoped—the matching Seerr media-season availability rather than the request-season workflow status. Activity and Calendar expose current read-only workflow state, while Health contains pipeline/service incidents and Connections owns service enrollment.

Each media record uses provider and service identifiers to join evidence from multiple systems. Its lifecycle indicates which of Requested, Monitored, Downloading, Imported, and Available have been observed. qBittorrent transfers are correlated to Sonarr/Radarr queue rows by download identifiers; a bounded sanitized queue error is displayed when the service supplies one. Titles, identifiers, progress, and errors exist only in the current in-memory snapshot.

Artwork descriptors never reach the browser. The browser receives an opaque same-origin `/api/v2/media/artwork/<key>` URL, and the authenticated broker tries only fixed service-owned artwork routes in this order: Jellyfin, Radarr/Sonarr, then Seerr. Grid requests use a revisioned 342 px Jellyfin or Seerr thumbnail and try fixed 250 px, 500 px, then original Radarr/Sonarr covers. When Sonarr exposes only TVDB remote artwork, Helmsman uses the series' validated TMDb identifier for a typed Seerr metadata lookup and then requests only Seerr's fixed TMDb image-proxy route; it never follows the remote artwork URL. Duplicate misses are coalesced, and a bounded scheduler permits at most three upstream artwork fetches at once with 64 pending requests. Successful images are cached in memory for up to 24 hours. General failures are cached for 15 minutes, versioned Arr cover misses for 30 seconds, and unrevisioned Arr misses are not negative-cached, allowing newly generated covers to appear promptly without continuous retry. The cache is limited to 512 entries, 64 MiB total, and 4 MiB per accepted image, and accepts only bounded raster image types. Browser responses use an ETag, a one-day private cache lifetime, and one-week stale revalidation/error windows; media artwork is never written to the data volume.

Infrastructure navigation contains **Overview**, **Proxmox Environments**, **Nodes**, **Workloads**, **Portainer**, and **Incidents**. Helmsman supports up to 25 Proxmox environments and 25 total endpoints, with no more than four endpoints in one environment. An environment is either a standalone server or one multi-node cluster. Its detail view presents Summary, API endpoints, Nodes, Workloads, Storage, Recent Activity, and current sanitized warnings.

To add Proxmox, open **Infrastructure**, choose **Connect and discover**, and enter:

- a display name;
- the full HTTPS URL reachable from inside the container, normally `https://host-or-ip:8006`;
- **System trust** for a publicly or privately trusted certificate, or **Pinned SHA-256 fingerprint** for a self-signed/local certificate;
- the full API token ID and generated token secret;
- whether the environment should be monitored continuously.

There is no insecure “ignore certificate errors” mode. A pinned fingerprint authorizes only that exact certificate and must be reviewed after a legitimate certificate replacement. **Discover environment** checks the endpoint without saving it, identifies it as standalone or clustered, and lists the visible nodes for confirmation. Helmsman refuses to save a connection whose identity cannot be established. Changing the URL, TLS identity, token, or discovered environment requires a fresh successful discovery.

For a self-signed certificate, run `pvenode cert info` directly on the Proxmox host console and copy the SHA-256 fingerprint for the certificate served by `pveproxy`. Verify it through that trusted console; do not accept a fingerprint learned only through the same network connection you are enrolling.

After saving an environment, additional cluster-node endpoints can be registered as failover paths. Every alternate URL, certificate trust choice, and token must be entered and verified explicitly. The endpoint must report the same stable cluster or standalone identity as the environment; discovered IP addresses are never trusted automatically. Helmsman does not automatically combine existing configurations, even if they later appear to describe the same cluster.

Each monitoring cycle tests endpoint availability, selects one healthy matching endpoint, and collects the cluster-wide inventory once. The snapshot contains a bounded node, VM/LXC, storage, recent-task, and recent-backup inventory alongside derived health metrics and sanitized reports. Recent tasks and backup history are collected through each visible node's fixed read-only task route, then merged once with node identity retained; raw UPIDs, command-bearing status text, and raw Proxmox responses are not exposed. If one API certificate or route fails but the cluster remains queryable through another approved endpoint, the failed endpoint is shown as unavailable while the actual node state continues to come from the cluster inventory; the environment is Limited rather than Down.

### Portainer under Infrastructure

Portainer is a separate Infrastructure service, not a Media connection. Open **Infrastructure → Portainer** to register up to eight independent Portainer servers. For each server, enter:

- a display name;
- its full HTTPS base URL, normally `https://host-or-ip:9443`;
- **System trust** for a publicly or privately trusted certificate, or **Pinned SHA-256 fingerprint** for a self-signed/local certificate;
- a durable Portainer access token; and
- whether continuous monitoring is enabled.

Helmsman sends the token in Portainer's `X-API-Key` request header and never returns it to the browser. The connection test verifies the Portainer status API and the token with the authenticated-user endpoint before anything is saved. Portainer 3.x is detected through `/api/system/status`; Helmsman falls back to the legacy `/api/status` route only when the newer route returns HTTP 404.

Monitoring uses fixed GET-only routes for environments, stacks, and Docker-compatible container inventories. Helmsman can list multiple Docker or Podman environments behind one Portainer server; Kubernetes and Azure environments can appear in the environment inventory but are not queried through the Docker container route. The normalized snapshot discards endpoint addresses, credentials, raw labels, raw stack definitions, and raw responses. There is no general Portainer or Docker API proxy, and Helmsman never mounts the Docker socket.

The Portainer page reports online/offline environments, running/stopped/restarting/unhealthy container counts, stacks, and bounded per-environment errors. A deliberately stopped container is informational and does not degrade health. Each server probe has a 45-second monitoring deadline and leaves request capacity available for the rest of Helmsman; if it expires, completed data remains visible and `PORTAINER_INVENTORY_PARTIAL` explains that unfinished coverage will be retried next cycle. Portainer access tokens inherit the permissions of their Portainer user, so create a dedicated least-privilege Portainer user or team where your edition supports it and do not reuse an administrator token. Helmsman itself remains read-only even if a broader token is supplied.

## Credentials

Use dedicated, least-privilege credentials where the service supports them:

| Service | Helmsman credential |
|---|---|
| Jellyfin | Dashboard API key, user access token, or one-time username/password exchange |
| Seerr | Global API key, or one-time local account email/password exchange |
| Radarr, Sonarr, Prowlarr, Bazarr | API key |
| qBittorrent | `qbt_` API key from qBittorrent 5.2 or newer |
| Proxmox VE | Dedicated API token ID and token secret for a least-privilege audit user |
| Portainer | Durable access token for a dedicated least-privilege user, sent as `X-API-Key` |

Passwords are not retained. For Jellyfin, enter a Dashboard API key or existing user access token directly, or let Helmsman exchange a username and password once; it discards the password and encrypts only the resulting access token. For Seerr, enter the global API key from Settings > General, or use a native local account email and password for a one-time exchange; Seerr local authentication must be enabled, and Helmsman discards the password and encrypts only the resulting session. Older qBittorrent password/SID mode is deliberately not used for unattended monitoring.

For Proxmox, create a dedicated user with the minimum read-only permissions needed for the selected resources, then create an API token for that user. Enter the complete token ID in the form `user@realm!token-name` and its generated secret. Helmsman encrypts both fields and never returns either value to the browser. Each approved endpoint keeps destination-bound encrypted credentials, so one endpoint cannot silently reuse another endpoint's credential against a changed host. Do not use `root@pam`, a password, a root API token, or a token with administrative/control permissions. Proxmox environments are configured in the Infrastructure workspace; do not place their URLs or credentials in `.env`.

For Portainer, generate an access token for a dedicated user whose visible environments are limited to what Helmsman should monitor. Enter the token once in the Portainer connection form; Helmsman encrypts it, binds it to that server's exact destination and TLS identity, and exposes only whether a credential is configured. Do not place the Portainer URL or token in `.env`. Portainer Community Edition access tokens inherit their user's permissions; Helmsman's fixed GET-only connector reduces its own request surface but cannot make an overprivileged Portainer account least-privilege.

## Browser access and recovery

The first claim creates one browser session. From Settings, an authorized browser can create a ten-minute, single-use invite for another browser. Sessions are bound to the exact scheme, host, and port and can be revoked.

Recovery must use the same Compose file stack that owns the running installation. If an optional override was used to deploy, add it to **every** `stop`, `run`, `up`, and `logs` command below:

| Installation | Compose command prefix |
|---|---|
| Fresh local install | `docker compose` |
| Upgrade using the v0.5 volume | `docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml` |
| Fresh install with external key | `docker compose -f compose.yaml -f deploy/compose.hardened.yaml` |
| v0.5 volume and external key | `docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml` |

For either hardened row, export the same `HELMSMAN_MASTER_KEY` before running any command and unset it afterward. Substituting a different key cannot recover the stored credentials.

There is no vault password to forget. If all browser sessions are lost, reset only access from the Docker host:

```sh
docker compose stop helmsman
docker compose run --rm --no-deps helmsman reset-access --confirm
docker compose up -d
docker compose logs helmsman
```

The reset revokes browser sessions but preserves service URLs, the network policy, and encrypted credentials. The next start prints a new one-time setup token. If `sessions.json` is malformed, this same command moves it to a timestamped `sessions.json.corrupt-*` quarantine file and creates clean session state; it does not discard service configuration or credentials.

If the credential encryption key is lost or the configured key no longer matches, the ciphertext cannot be recovered. Stop the service and reset only the credential store, using the same command prefix selected above:

```sh
docker compose stop helmsman
docker compose run --rm --no-deps helmsman reset-credentials --confirm
docker compose up -d
```

This preserves the instance, network policy, registered service targets, and browser sessions. It moves `credentials.json` and, in easy local mode, `credentials.key` to timestamped `*.unrecoverable-*` quarantine files. An externally managed master-key file is never modified. For a hardened deployment, export a valid replacement key and retain `-f deploy/compose.hardened.yaml` on all three commands; otherwise the service could restart in the wrong key mode. Then enter replacement service credentials in the interface and rotate the old credentials at their source. Quarantine files remain sensitive recovery material; keep them private and remove them only after the replacement configuration is verified.

Do not use `docker compose down -v` unless you intentionally want to erase all configuration and encrypted credentials.

## Optional stronger key separation

For normal same-computer use, no extra setup is required. To keep the master key outside the data volume, store a 64-character hex key outside the project and `.env`, export it only when Compose creates or recreates the container, and use the optional override.

This option requires a Docker Compose release that supports top-level secrets sourced from an environment variable. Run `docker compose config` before deployment; if it rejects `environment:` under `secrets:`, update Docker Compose. Compose materializes the value as a rootless-readable, mode `0400` file inside the container—the key is not placed in the container environment.

Linux or macOS:

```sh
helmsman_key_directory="${XDG_CONFIG_HOME:-$HOME/.config}/helmsman"
helmsman_key_file="$helmsman_key_directory/master-key.hex"
install -d -m 700 "$helmsman_key_directory"
if [ ! -e "$helmsman_key_file" ]; then
  (umask 077 && openssl rand -hex 32 > "$helmsman_key_file")
fi
chmod 600 "$helmsman_key_file"
export HELMSMAN_MASTER_KEY="$(tr -d '\r\n' < "$helmsman_key_file")"
test "${#HELMSMAN_MASTER_KEY}" -eq 64
docker compose -f compose.yaml -f deploy/compose.hardened.yaml config
docker compose -f compose.yaml -f deploy/compose.hardened.yaml pull
docker compose -f compose.yaml -f deploy/compose.hardened.yaml up -d
unset HELMSMAN_MASTER_KEY
```

PowerShell:

```powershell
$helmsmanKeyDirectory = Join-Path $env:LOCALAPPDATA 'Helmsman'
$helmsmanKeyFile = Join-Path $helmsmanKeyDirectory 'master-key.hex'
New-Item -ItemType Directory -Force $helmsmanKeyDirectory | Out-Null
if (-not (Test-Path -LiteralPath $helmsmanKeyFile)) {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    $generator.GetBytes($bytes)
    $generator.Dispose()
    $helmsmanKey = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    [IO.File]::WriteAllText($helmsmanKeyFile, $helmsmanKey)
}
$env:HELMSMAN_MASTER_KEY = (Get-Content $helmsmanKeyFile -Raw).Trim()
if ($env:HELMSMAN_MASTER_KEY.Length -ne 64) { throw 'Master key must be 64 hexadecimal characters.' }
docker compose -f compose.yaml -f deploy/compose.hardened.yaml config
docker compose -f compose.yaml -f deploy/compose.hardened.yaml pull
docker compose -f compose.yaml -f deploy/compose.hardened.yaml up -d
Remove-Item Env:\HELMSMAN_MASTER_KEY
Remove-Variable bytes, helmsmanKey -ErrorAction SilentlyContinue
```

Protect and back up that external key file separately. Export the exact same key for every redeploy, container recreation, migration, and restore. Do not enable the override after credentials already exist unless the same key that encrypted them is supplied; a wrong or missing key intentionally prevents startup. Never put the key in `.env`, Compose YAML, shell history, or the release directory.

## Caddy and Authentik are optional

- `http://127.0.0.1:4180` on the Docker host needs neither Caddy nor Authentik.
- Remote browser access needs trusted HTTPS, but the gateway can be Caddy, Traefik, Nginx, a VPN HTTPS feature, or another correctly configured reverse proxy.
- Authentik is an optional access/MFA layer. It protects entry through the edge; it does not encrypt the volume, protect backups, or help if the inner container port remains directly reachable.

Edge authentication protects browser access only. It does not authenticate Helmsman to Jellyfin, Seerr, Proxmox, Portainer, or another monitored system, so each upstream system still requires its own supported credential.

For external use, publish the container only on an address reachable by the edge, proxy every path unchanged, and firewall port 4180 so clients cannot bypass the HTTPS/Authentik route. Example Caddy configurations are in `deploy/`.

## Upgrade an existing Helmsman beta

Keep the existing Helmsman project directory, `.env`, and the same Compose file stack so Compose reuses the current `helmsman-data` volume. Back up that volume, download the new GitHub Release deployment assets, replace the tracked deployment files without replacing your `.env`, and copy the new digest-pinned `HELMSMAN_IMAGE` value from `container.env.example` into the existing `.env`. Then run these commands from that same directory in PowerShell, Command Prompt, or a Unix shell:

```sh
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

If the installation uses an override, include it in every command. These commands recreate the application container while preserving `/data`; do not run `docker compose down -v` during an update. Keep one known-good older digest-pinned image reference recorded before upgrading.

The production Compose file fixes the project name as `helmsman`, so fresh deployments consistently use the Docker volume `helmsman_helmsman-data` regardless of directory name. Before upgrading an older beta that was launched under a different Compose project name, run `docker volume ls`; set `COMPOSE_PROJECT_NAME` in `.env` to that previous project prefix before the first new `docker compose up`, or migrate the old volume deliberately. Do not continue with an unexpectedly empty instance.

To roll back application code, restore the previous digest-pinned `HELMSMAN_IMAGE` reference and repeat `docker compose pull` and `docker compose up -d`. Do not roll an already migrated `/data` volume back into an older image unless that release explicitly documents schema compatibility; restore the matching pre-update volume backup instead.

v0.10 advances the state schema to 4 by adding an empty, bounded Infrastructure-services collection. Existing media connections, destination-bound encrypted credentials, browser sessions, network approvals, and Proxmox environments/endpoints remain in place; nothing is converted into or automatically combined with a Portainer connection. The unified media catalog, artwork cache, and Portainer inventory are rebuilt in memory from current read-only service responses and do not require a data migration. Installations coming directly from an older schema still use the existing in-place migrations, including the rule that separate Proxmox targets are never merged automatically. Back up the volume before upgrading, and do not attempt to run an older image against state after it has been migrated.

## Upgrade from Jellofin Command v0.4 or v0.5

Back up the named volume and make sure the service credentials can be recovered or regenerated. First, from the old Jellofin Command directory, stop the old stack without `-v`:

```sh
docker compose down
```

Then open the extracted Helmsman directory, copy the environment example, and set `HELMSMAN_DATA_VOLUME` to the **exact existing** volume reported by `docker volume ls`. The standard v0.5 name is shown here, but inspect it before continuing:

```sh
cp container.env.example .env
# Edit .env and uncomment this upgrade-only setting:
# HELMSMAN_DATA_VOLUME=jellofin-command_jellofin-command-data
docker volume inspect jellofin-command_jellofin-command-data
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml config
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml pull
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml up -d
```

On PowerShell, replace the `cp` line with `Copy-Item .\container.env.example .\.env`. The upgrade override declares the old volume as external, so a misspelled or missing name fails instead of creating an empty volume. Fresh installs do not use this override and receive their own Compose-project-scoped volume.

If the v0.5 deployment used the hardened external key, export that exact key first and append `-f deploy/compose.hardened.yaml` to every `config`, `pull`, `up`, recovery, and operations command. For example, the first start must use all three files:

```sh
export HELMSMAN_MASTER_KEY="$(tr -d '\r\n' < /path/to/the/existing/master-key.hex)"
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml config
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml pull
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml up -d
unset HELMSMAN_MASTER_KEY
```

The server also accepts legacy `JELLOFIN_COMMAND_*` runtime variables for this transition release, but new deployments should use `HELMSMAN_*`. Do not change or regenerate an external master key during the rename. If you also change the browser-facing hostname, existing sessions will not follow because they are intentionally bound to the exact scheme, host, and port; use the access-reset sequence after confirming the old volume is mounted.

Upgrading directly from v0.4 preserves registered service URLs. Its credentials were browser-only, so they must be entered once into the server-side encrypted store. Keep the old archive/browser profile until every connection has been verified.

The v0.4 browser vault is not loaded by Helmsman. Helmsman does not request a vault passphrase or store new service secrets in the browser.

## Health and verification

`/healthz` checks the local process; upstream outages appear as incidents and do not cause a container restart loop.

Probe compatibility treats Radarr, Sonarr, and Prowlarr `Notice` health entries as informational rather than failures. Prowlarr's blocked-indexer endpoint and Seerr's current status, authenticated-identity, and request-count routes are handled explicitly. Absent HTTP statuses remain absent rather than displaying a fabricated `HTTP 100`, and Arr application warnings show their current sanitized count. Proxmox checks use a separate, fixed allowlist of read-only API routes, verify environment identity, report endpoint availability independently from node state, and collect only one cluster-wide inventory per environment and cycle. Portainer checks use their own fixed GET-only route allowlist, distinguish token authorization from environment or container failures, and keep intentionally stopped containers informational.

```sh
docker compose ps
docker compose logs --tail=100 helmsman
npm test
```

The tests cover the network boundary, encrypted credential store, session/CSRF model, state migration, environment discovery and identity matching, endpoint failover without duplicate inventory, media, Proxmox, and Portainer API contracts, service probes, incident debounce and recovery, monitor coalescing, hostile UI content, PWA shell, and container hardening.
