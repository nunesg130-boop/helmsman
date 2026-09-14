# Helmsman Docker deployment — v0.10.0-beta.9

The supported image contains one non-root Node.js process. It serves the Media and Infrastructure workspaces, owns the encrypted credential store and browser sessions, and runs safe background health checks. It does not contain Caddy, Authentik, a database, or a Docker socket, and it has no infrastructure control actions.

## 1. Prepare

The GitHub Release for `v0.10.0-beta.9` publishes three deployment assets:

- `compose.yaml` — the pull-only production service definition pinned to the released multi-architecture image digest;
- `container.env.example` — the same digest-pinned image reference plus non-secret bind-address and port settings;
- `SHA256SUMS` — SHA-256 checksums for both deployment files.

The release workflow replaces `ghcr.io/OWNER/REPOSITORY:0.10.0-beta.9` in the tagged source files with the repository's actual lowercase GHCR path and exact multi-architecture manifest digest (`ghcr.io/owner/repository@sha256:...`) before publishing them. Do not deploy the placeholder-bearing files directly from a source checkout unless you first set `HELMSMAN_IMAGE` to a published image reference.

The three release assets are the complete base deployment. Optional Caddy examples, migration overrides, the external-key override, and `compose.dev.yaml` remain available from the repository at the matching Git tag and should be downloaded only when that deployment mode is needed.

For a public GitHub repository, download and verify the assets on Linux:

```sh
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 /opt/helmsman
cd /opt/helmsman
curl -fLO https://github.com/OWNER/REPOSITORY/releases/download/v0.10.0-beta.9/compose.yaml
curl -fLO https://github.com/OWNER/REPOSITORY/releases/download/v0.10.0-beta.9/container.env.example
curl -fLO https://github.com/OWNER/REPOSITORY/releases/download/v0.10.0-beta.9/SHA256SUMS
sha256sum -c SHA256SUMS
```

For a private repository, authenticate GitHub CLI and download the same release assets:

```sh
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 /opt/helmsman
cd /opt/helmsman
gh auth login
gh release download v0.10.0-beta.9 --repo OWNER/REPOSITORY \
  --pattern compose.yaml \
  --pattern container.env.example \
  --pattern SHA256SUMS
sha256sum -c SHA256SUMS
```

Windows users can download those same three assets from the GitHub Release page or use `gh release download`, then compare their SHA-256 hashes with `SHA256SUMS`. Open a terminal in the directory containing the downloaded files.

Windows PowerShell:

```powershell
Copy-Item .\container.env.example .\.env
```

Linux or macOS:

```sh
cp container.env.example .env
```

The default file is enough for same-computer use:

```dotenv
HELMSMAN_IMAGE=ghcr.io/owner/repository@sha256:<release-manifest-digest>
HELMSMAN_BIND_IP=127.0.0.1
HELMSMAN_PORT=4180
```

Fresh installs receive a Compose-project-scoped `helmsman-data` volume. Do not add media, Proxmox, or Portainer URLs, API keys, passwords, token IDs, token secrets, access tokens, Helmsman access keys, cookies, setup tokens, or Authentik secrets to `.env`. `HELMSMAN_DATA_VOLUME` is only for the explicit v0.5 migration procedure near the end of this guide.

## 2. Pull and start

If the GHCR package is public, no registry login is required. If it remains private, authenticate once on each Docker host using a GitHub personal access token (classic) with `read:packages` and access to the package:

```bash
read -rsp "GitHub package token: " GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username GITHUB_USER --password-stdin
unset GHCR_TOKEN
```

Do not use a GitHub Actions `GITHUB_TOKEN` on the server, and do not save the personal access token in `.env`, Compose YAML, the repository, or shell history. A public package can be pulled anonymously even when the source repository remains private, although a private repository's release assets still require repository access. Repository and package visibility are separate settings.

```sh
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

Production deployment is image-only. It requires neither the source tree nor a Dockerfile on the server.

If Windows reports that `//./pipe/dockerDesktopLinuxEngine` cannot be found, Docker Desktop is not ready. Start it, wait for the engine to report Running, make sure Linux containers are selected, then retry.

The container runs as UID/GID 10001. Its root filesystem and `/app` are read-only; `/data` is its only persistent write location. It has no Linux capabilities, no new privileges, no host network, and no access to the Docker API.

Do not scale this service. One instance owns one state volume and one data-directory lock.

## 3. First-time claim

An unclaimed start prints a fresh 256-bit setup token once:

```text
Helmsman setup token: <one-time value>
```

Only its SHA-256 digest is stored. Restarting before claim invalidates the previous value. This setup token is distinct from the reusable access key created during the claim.

Open `http://127.0.0.1:4180`. Enter:

1. the setup token;
2. a name for this browser session;
3. the default exact-service network mode, or optional manual private CIDRs as an advanced boundary;
4. optionally, permission for explicitly registered public HTTPS services.

Claim is accepted only on loopback HTTP or a trusted HTTPS origin. A successful fresh claim atomically creates a random reusable 256-bit Helmsman access key and a browser session. The claim response displays the plaintext key once; save it in a password manager before leaving the page. Helmsman stores only its SHA-256 verifier. It never reads the access key from `.env` or a URL, writes it to browser storage, or records it in application logs.

Any browser can enter the same universal key at the same Helmsman address to receive its own one-year session. The browser credential is placed in an HttpOnly, `SameSite=Strict` cookie, bound to the exact scheme, host, and port, and stored server-side only as a hash. A client or public IP change does not require a new access key. Mutations also require a per-session CSRF value.

The default mode needs no CIDR entries. Each time a private service is explicitly registered, Helmsman resolves it and stores only those safe private addresses as connection-specific `/32` (IPv4) or `/128` (IPv6) approvals. Later checks must resolve entirely inside those exact approvals; a changed private address must be reviewed and saved again. Manual CIDRs are available when an operator intentionally needs a broader private registration boundary. In either mode, immutable SSRF deny ranges remain blocked, mixed-policy DNS fails closed, and public HTTP is never allowed. Public HTTPS still requires the separate explicit setting.

## 4. Add services

Select the Media workspace to configure Jellyfin, Seerr, Radarr, Sonarr, Prowlarr, qBittorrent, or Bazarr. Select Infrastructure to connect one or more Proxmox environments or Portainer servers. A Proxmox environment is either one standalone server or one multi-node cluster; API endpoints, physical nodes, and VM/LXC workloads remain separate records. Portainer is a separate Infrastructure service and never appears in Media. Enter each full URL and credential in the interface. The container registers the exact URL after validating it against the current network policy. It encrypts each credential independently with AES-256-GCM, a fresh 96-bit nonce, and authenticated instance/connection/field/revision metadata.

Media is read-only in v0.10. Home summarizes current Jellyfin playback, continue-watching items, requests, downloads, blocked imports, releases, recently added and missing media, and subtitle backlog. Continue Watching resolves an episode to its series poster instead of displaying the episode's resume frame. The fixed Now Playing query retains only bounded media and play-state fields and discards user, device, client, network, and stream-session metadata. Discover displays the bounded Seerr discovery feed and labels ordinary unmatched titles **Not requested** instead of exposing an internal unknown state; only Jellyfin evidence can label an item available in Helmsman's library. Library joins Jellyfin availability with Radarr/Sonarr monitoring and import evidence. Requests preserve separate request IDs, Seerr approval state, acquisition state, exact season scope, and 4K scope. Availability comes from Seerr's media record, an exact provider-ID match to a Jellyfin movie, or the matching requested-season availability records—not the separate request-workflow season status—so completed media no longer remains labeled **Awaiting Jellyfin**, while an older Jellyfin series record still cannot falsely fulfill a new season request. Activity correlates qBittorrent download identifiers with Sonarr/Radarr queue entries and can display their bounded sanitized status error. Calendar keeps episodes distinct and shows episode coordinates without repeating series titles. Health retains service and pipeline monitoring, while Connections owns service enrollment. Helmsman cannot approve requests, add titles, change monitoring, pause transfers, or delete media/data.

Media records are joined by TMDb, TVDb, IMDb, download, and service identifiers rather than titles. The lifecycle is **Requested → Monitored → Downloading → Imported → Available**. Normalized titles, identifiers, progress, dates, and status errors live only in the current in-memory operations snapshot; they are not written to `state.json` or another catalog.

The browser receives only opaque same-origin artwork URLs. The authenticated broker tries Jellyfin first, fixed 250 px, 500 px, and original Radarr/Sonarr covers second, and Seerr last. If Sonarr supplies only a TVDB remote poster, Helmsman performs a typed Seerr TV lookup with Sonarr's validated TMDb ID and then requests only Seerr's fixed TMDb image-proxy route; it never follows the remote URL. It requests revisioned 342 px Jellyfin/Seerr thumbnails, accepts only bounded raster responses, and never returns upstream URLs or credentials. Duplicate misses are coalesced, and at most three upstream artwork requests run concurrently with 64 pending requests. Positive results are cached in memory for up to 24 hours. General failures are cached for 15 minutes, versioned Arr cover misses for 30 seconds, and unrevisioned Arr misses are not negative-cached. The cache remains bounded to 512 entries, 64 MiB total, and 4 MiB per image. Browser responses use ETags, a one-day private cache lifetime, and one-week stale revalidation/error windows. Artwork is not stored in the Docker volume. Service and workload marks are bundled locally under `assets/services` and `assets/workloads`, carry source/trademark notices, and require no icon CDN.

The encrypted credential is also bound to that canonical destination. Changing a service URL requires entering a fresh credential; editing or restoring state with a different URL makes the old credential unavailable rather than forwarding it to the new host.

The browser receives only these facts:

- whether a credential is configured;
- its last update time;
- the non-secret service URL and monitor state.

It cannot request the saved credential, ciphertext, nonce, authentication tag, or master key.

A Jellyfin connection requires a Dashboard API key, a user access token, or a one-time username/password exchange. In exchange mode Helmsman immediately discards the password and encrypts only the access token returned by Jellyfin. A Seerr connection requires either the global API key from Settings > General or a one-time native local account email/password exchange. Seerr local authentication must be enabled for the exchange; Helmsman discards the password and encrypts only the returned session. Use service API keys for Radarr, Sonarr, Prowlarr, and Bazarr, and a qBittorrent 5.2+ `qbt_` API key. Password-based qBittorrent sessions are not suitable for an unattended monitor and are not used in this beta.

Each Proxmox endpoint uses a dedicated API token ID in the form `user@realm!token-name` and its generated token secret. Both fields are write-only in the browser and encrypted at rest. Use a dedicated least-privilege audit user and token; do not enter a Proxmox username/password, `root@pam`, a root token, or an administrative token. One Helmsman instance accepts at most 25 environments and 25 total endpoints, with up to four explicitly approved endpoints in one environment.

Use **System trust** when the Proxmox certificate chains to a CA trusted by the container. For a self-signed or local certificate, select **Pinned SHA-256 fingerprint** and enter the exact certificate fingerprint. Helmsman has no global or per-endpoint “ignore TLS errors” option. A certificate replacement therefore requires an explicit fingerprint review instead of silently weakening HTTPS.

Obtain a self-signed certificate fingerprint out of band: run `pvenode cert info` directly on the Proxmox host console, identify the certificate served by `pveproxy`, and copy its SHA-256 fingerprint. Do not trust a fingerprint discovered only through the same network path being enrolled.

**Connect and discover** authenticates to the entered endpoint, establishes whether it reports a standalone server or cluster, and shows the cluster name and visible node names before anything is saved. An environment cannot be saved without a stable discovered identity. Changing the endpoint URL, TLS identity, or credential requires discovery to succeed again.

After the environment is saved, its detail view can register additional endpoints for failover. Every alternate endpoint requires an operator-entered URL, explicit TLS verification, its own encrypted write-only token, and a successful identity match. Helmsman never trusts discovered IP addresses or certificates automatically. It also never combines existing environment configurations automatically, even if two endpoints later report the same cluster.

The Proxmox connector permits only its fixed read-only API routes. It does not expose a generic Proxmox proxy and cannot start, stop, reset, migrate, back up, restore, reconfigure, or open a console for any node, VM, LXC, or storage resource. Helmsman also has no SSH credential and no Docker socket.

The v0.10.0-beta.9 snapshot exposes a bounded read-only inventory to the authenticated UI: each node, VM, LXC, storage entry, and recent activity/backup result is normalized and sanitized. Cluster-wide inventory is collected only once per environment and monitoring cycle through one healthy, identity-matched endpoint, which prevents duplicate workloads and incidents. Recent tasks and backup tasks are queried through each visible node's fixed read-only route and merged with their node identity retained; raw UPIDs and command-bearing task status text are discarded. Endpoint health is reported separately from actual node health; losing a primary endpoint can leave the environment Limited and inventory available through an approved alternate.

### Proxmox token preparation

Create a dedicated Proxmox user and an API token with privilege separation enabled. Grant the token a read-only audit role only over the resources Helmsman should see. For complete cluster-level visibility, an operator may assign Proxmox's built-in `PVEAuditor` role at `/` with propagation; a narrower ACL is safer when complete visibility is unnecessary, but unavailable resources will remain absent or Limited in Helmsman. Copy the generated token secret when Proxmox displays it and store it directly through the Helmsman form.

### Portainer access-token preparation

Open **Infrastructure → Portainer** to add up to eight independent Portainer servers. For each one, enter its display name, full HTTPS URL (normally `https://host-or-ip:9443`), TLS trust mode, durable access token, and monitoring choice. Use **System trust** for a certificate chaining to a CA trusted by the container. For a self-signed or local certificate, use **Pinned SHA-256 fingerprint** and verify that fingerprint out of band. Plaintext Portainer URLs and “ignore TLS errors” behavior are not supported.

Generate the access token for a dedicated least-privilege Portainer user whose visible environments are limited to what Helmsman should monitor. Access tokens inherit their Portainer user's permissions. Helmsman sends the token only as `X-API-Key`, stores it encrypted and write-only, and binds it to that exact URL and TLS identity. Do not use an administrator token and do not put the URL or token in `.env`.

The test verifies a Portainer status route and `/api/users/me` before saving. Monitoring then uses fixed GET-only calls for paged environments, stacks, and Docker-compatible container inventories. Multiple Docker or Podman environments can be reported by one server. Kubernetes and Azure environments may be listed, but Helmsman does not send them through the Docker container route. Stopped containers are informational; unavailable environments and unhealthy, dead, or restarting containers report bounded specific errors. There is no general Portainer or Docker API proxy. There are no Portainer write operations, container or stack controls, Docker socket, or host mount.

## Container-to-target addressing

An address working in the host browser may not mean the same thing inside a container:

- use a routable LAN address for a service on another host;
- Docker Desktop normally provides `host.docker.internal` for a service on the Docker host;
- on Linux, an explicit `extra_hosts: ["host.docker.internal:host-gateway"]` mapping may be added if needed;
- services in another Compose project may share an intentionally created Docker network.

The entered address must resolve from inside Helmsman and pass the selected boundary: its exact per-connection approval in the default mode, or an operator-supplied CIDR in manual mode. For Proxmox, use an HTTPS address reachable from the container, normally the management hostname or IP and port `8006`. For Portainer, use its reachable HTTPS base URL, normally on port `9443`. Plaintext HTTP is rejected for both Infrastructure integrations. Do not mount `/var/run/docker.sock` to discover services or infrastructure.

## Monitoring behavior

The container polls enabled media services, Proxmox environments, and Portainer servers on bounded schedules. Every connector has an explicit read-only probe plan; one failed capability does not erase successful evidence from another. For a Proxmox environment, endpoint probes select one healthy identity-matched route and the full cluster inventory runs once. Each Portainer service is probed independently, so a failure on one server does not erase another server's inventory. A Portainer server gets a 45-second probe deadline; completed inventory remains visible and `PORTAINER_INVENTORY_PARTIAL` identifies unfinished coverage for retry during the next cycle. Poll cycles never overlap, responses are bounded, and simultaneous refresh requests coalesce.

Two identical consecutive failures open one incident. Later failures increment its occurrence count. A successful check closes it and records a recovery. States mean:

| State | Meaning |
|---|---|
| Healthy | Every checked capability responded normally |
| Limited | An optional feature failed but core flow remains available |
| Degraded | An important feature or part of the pipeline failed |
| Down | No core capability can be confirmed |
| Authentication required | A service returned 401/403 or rejected the credential |
| Stale | No recent trustworthy result is available |

Only bounded normalized media fields, derived status, safe codes, timing, version, counters, incidents, and transitions reach the UI. Raw response bodies, headers, upstream URLs, usernames, credentials, unbounded error text, and search terms are discarded. Media titles, provider identifiers, current progress, dates, and sanitized queue errors appear only in the authenticated in-memory snapshot. Proxmox and Portainer follow the same rule: only each connector's allowlisted, bounded health and inventory facts are retained.

Authenticated browsers may also receive current live health reports built only from allowlisted `source`, `type`, and `message` fields in supported structured service health responses. Their count and length are bounded, secret-like values are redacted, and the browser escapes every field before display. Reports remain only in the current operations snapshot; they are never copied into incidents, events, history, application logs, or persistent files. Raw response bodies and raw error bodies are never exposed. Because service-authored reports can include non-secret paths or hostnames, keep the interface private or protect every route with trusted HTTPS and appropriate access control.

For probe compatibility, Radarr, Sonarr, and Prowlarr `Notice` health entries remain informational rather than making a service Limited. Helmsman handles Prowlarr's blocked-indexer endpoint and Seerr's current status, authenticated-identity, and request-count routes explicitly. Proxmox and Portainer use separate fixed route allowlists; neither accepts an API path supplied by the browser. Portainer 3.x status is checked first, and the legacy status route is used only when the newer route returns HTTP 404.

## Browser access-key rotation and recovery

Use the reusable access key to unlock Helmsman from another browser; no approval from a previously authorized browser is required. Settings can create the first key for an upgraded installation or rotate the current key. The new plaintext value is displayed once. Rotation revokes all prior browser sessions and gives the browser performing it a replacement one-year session, but it does not change the instance, registered services, network policy, or encrypted upstream credentials.

Use the same Compose file stack for every lifecycle and recovery command:

| Installation | Compose command prefix |
|---|---|
| Fresh local install | `docker compose` |
| Upgrade using the v0.5 volume | `docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml` |
| Fresh install with external key | `docker compose -f compose.yaml -f deploy/compose.hardened.yaml` |
| v0.5 volume and external key | `docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml` |

For a hardened deployment, export the exact same `HELMSMAN_MASTER_KEY` before any of these commands and unset it afterward. The examples below show the fresh local prefix; substitute the appropriate full prefix on every line.

If the access key is lost, or no signed-in browser remains to create one after an upgrade:

```sh
docker compose stop helmsman
docker compose run --rm --no-deps helmsman rotate-access-key --confirm
docker compose up -d
```

The CLI writes the new access key once to its own standard output; copy it immediately. The key is not placed in subsequent application logs. The rotation revokes all browser sessions and preserves the instance ID, network policy, registered targets, and encrypted credentials. The main service must be stopped so two processes cannot write `/data` concurrently.

## Data and backups

The named volume contains:

- `state.json` — instance, claim state, policy, and service destinations;
- `sessions.json` — the access-key SHA-256 verifier and browser-session hashes, never the plaintext access key;
- `credentials.json` — authenticated ciphertext;
- `credentials.key` — the automatically generated master key in easy local mode;
- a process lock while the container is running.

The unified media snapshot, artwork cache, and current Portainer inventory are intentionally absent from this list: all are rebuilt in memory from current service responses and are not persisted in `/data`.

Treat the entire volume as sensitive. Back it up with the Docker/NAS mechanism appropriate to your host. Never use `docker compose down -v` during an ordinary update.

If `credentials.key` is lost, credentials cannot be decrypted or recovered. A wrong key causes startup to fail closed without modifying ciphertext. To keep the network policy, registered targets, and existing browser sessions while replacing only unrecoverable credentials:

```sh
docker compose stop helmsman
docker compose run --rm --no-deps helmsman reset-credentials --confirm
docker compose up -d
```

The reset moves `credentials.json` and the easy-mode `credentials.key`, when present, to timestamped `*.unrecoverable-*` files instead of deleting them. The next start creates an empty encrypted store, after which each service credential must be re-entered and the old credential should be rotated at its source. Treat the quarantine files as sensitive; remove them only after the replacement is working.

With `deploy/compose.hardened.yaml`, the externally managed key is never changed by the command. If that key was lost, generate and export a replacement key first, then retain the hardened override for the reset and restart commands. If the key merely changed by mistake, restore the original key instead of resetting; that retains the existing encrypted credentials.

```sh
docker compose -f compose.yaml -f deploy/compose.hardened.yaml stop helmsman
docker compose -f compose.yaml -f deploy/compose.hardened.yaml run --rm --no-deps helmsman reset-credentials --confirm
docker compose -f compose.yaml -f deploy/compose.hardened.yaml up -d
```

Keep `HELMSMAN_MASTER_KEY` exported for those commands, then unset it as shown below.

If the installation also uses the v0.5 migration volume, include `-f deploy/compose.upgrade-v0.5.yaml` before the hardened override on every line. Omitting either override can select the wrong volume or key mode.

## Optional external master key

The local default avoids another setup secret, but the key and ciphertext share one volume. For better backup and external-deployment separation, store a 64-character hex key outside the project and `.env`, export it only when Compose creates or recreates the container, and use `deploy/compose.hardened.yaml`.

This option requires a Docker Compose release that supports top-level secrets sourced from an environment variable. Run `docker compose config` before deployment; if it rejects `environment:` under `secrets:`, update Docker Compose. Compose materializes the value as a UID/GID 10001, mode `0400` file inside the container. Only the file path—not the key—is present in the container environment.

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

Windows PowerShell:

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

Protect and back up the external key file separately. Export the exact same key for every redeploy, container recreation, migration, and restore. Start with this mode before saving credentials; do not switch an existing encrypted store to a different key. A missing or wrong key fails closed without changing ciphertext. Never put the key in `.env`, Compose YAML, shell history, or the release directory.

## Access modes

| Use | Published address | Browser origin | HTTPS edge | Authentik |
|---|---|---|---:|---:|
| Same computer | `127.0.0.1:4180` | `http://127.0.0.1:4180` | No | No |
| SSH/VPN loopback tunnel | `127.0.0.1:4180` | Local forwarded loopback | Usually no | No |
| Remote LAN | Exact host interface | Trusted HTTPS name | Yes | Optional |
| Internet | Edge-reachable interface only | Trusted HTTPS name | Yes | Strongly recommended |

Remote plaintext HTTP is intentionally rejected for browser enrollment. HTTPS does not specifically require Caddy; Traefik, Nginx, a VPN HTTPS feature, or another trusted gateway works.

## Optional Caddy and Authentik

The files in `deploy/` are examples only:

- `Caddyfile.container-edge.lan.example` provides a private-network HTTPS edge.
- `Caddyfile.container-edge.authentik.example` adds Authentik forward authentication.

Replace every example name/address. Proxy the shell and every `/api` path unchanged. Preserve the original Host. When the edge is on another machine, set `HELMSMAN_BIND_IP` to one exact interface address and firewall TCP 4180 so only the edge can reach it.

Authentik is optional. If enabled, bind only intended users/groups and enforce MFA. It protects access through that edge; it does not protect the data volume, backups, a compromised host, or a directly reachable inner port. Do not let port 4180 become an MFA bypass.

Authentik or another external MFA edge authenticates browser users only. It never replaces the API key, access token, or encrypted session that Helmsman needs to authenticate to each upstream service.

The reusable Helmsman access key requires no Cloudflare Tunnel, Caddy, or Authentik configuration change. An external access layer still authenticates and proxies the browser first; Helmsman's own universal key and origin-bound session operate behind that edge. The container continues contacting registered upstream services directly, so access-key creation or rotation does not alter those connections.

The Authentik example removes `JFC_SESSION` and known legacy upstream session cookies from each authentication subrequest, so the control-plane session is never disclosed to Authentik. It preserves Authentik's own login cookie, then forwards the browser's `JFC_SESSION` cookie to Helmsman only after Authentik admits the request. The `JFC_` cookie namespace remains intentionally stable for upgrade compatibility. Stripping the entire `Cookie` header would normally break Authentik's browser session.

## Update an existing Helmsman beta

Keep the existing project directory, `.env`, and Compose file stack so the installation continues to use the same `helmsman-data` volume. Back up the volume, download and verify the new GitHub Release deployment files, replace the tracked deployment files without replacing `.env`, and copy the new digest-pinned `HELMSMAN_IMAGE` value from `container.env.example` into the existing `.env`. Do not replace `.env` with the example if it contains a custom binding or upgrade-volume setting.

The following commands work unchanged in Windows PowerShell, Command Prompt, and Unix shells:

```sh
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

These commands recreate the application container and preserve `/data`. Do not use `docker compose down -v` for an update. If the installation uses an override, include the same `-f` files in every command; if it uses an external master key, export that same key before Compose recreates the container.

The production Compose file fixes the project name as `helmsman`, so fresh deployments consistently use the Docker volume `helmsman_helmsman-data` regardless of directory name. Before upgrading an earlier beta deployed under a different Compose project name, run `docker volume ls`. Set `COMPOSE_PROJECT_NAME` in `.env` to the old volume's project prefix before the first new `docker compose up`, or migrate that volume deliberately. Stop if Helmsman unexpectedly appears unclaimed or empty; do not configure a second instance over the wrong volume.

Record the previous digest-pinned image reference and take a volume backup before updating. To roll back application code, restore the previous `HELMSMAN_IMAGE` digest and repeat `docker compose pull` and `docker compose up -d`. Do not run an older image against state already migrated by a newer release unless that release explicitly documents backward schema compatibility; restore the matching pre-update volume backup instead.

v0.10 advances the state schema to 4 by adding an empty bounded Infrastructure-services collection. Existing media connections, destination-bound encrypted credentials, browser sessions, network approvals, and Proxmox environments/endpoints are retained; nothing is automatically converted into or combined with a Portainer connection. The unified media model, artwork cache, and Portainer inventory are rebuilt in memory and require no catalog migration. Installations coming directly from an older schema still run the existing migrations, including keeping every prior Proxmox target separate rather than merging matching clusters automatically. Back up the volume before upgrading, and do not roll migrated state back into an older image.

When upgrading from v0.10.0-beta.8, its existing browser sessions migrate and remain valid, but the migrated session store has no reusable access key. Before the current session expires, open Settings and create the first access key, then copy the value shown once to a password manager. If no beta.8 browser session is still usable, stop the service and run `docker compose run --rm --no-deps helmsman rotate-access-key --confirm` using the same Compose file stack; the command prints the new key once and preserves all configuration and encrypted credentials.

## Upgrade from Jellofin Command v0.4 or v0.5

From the old Jellofin Command directory, stop the old deployment without deleting its volume:

```sh
docker compose down
```

Then run `docker volume ls`, identify the exact volume containing the existing `state.json`, and inspect it. The standard v0.5 name is `jellofin-command_jellofin-command-data`, but do not assume that name if the old Compose project was customized.

Extract Helmsman, open its directory, create `.env`, and uncomment the upgrade-only `HELMSMAN_DATA_VOLUME` line with that exact inspected name:

```sh
cp container.env.example .env
# Edit .env:
# HELMSMAN_DATA_VOLUME=jellofin-command_jellofin-command-data
docker volume inspect jellofin-command_jellofin-command-data
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml config
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml pull
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml up -d
```

On PowerShell, use `Copy-Item .\container.env.example .\.env`. The upgrade override declares the named volume as external. Docker therefore fails on a typo or missing volume instead of silently creating an empty one. Keep using the same upgrade override for later `run`, `up`, `restart`, recovery, and removal commands. Fresh installations must not use it.

If v0.5 used an externally managed hardened key, export the exact same key and use all three files from the first Helmsman start onward:

```sh
export HELMSMAN_MASTER_KEY="$(tr -d '\r\n' < /path/to/the/existing/master-key.hex)"
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml config
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml pull
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml up -d
unset HELMSMAN_MASTER_KEY
```

Registered service URLs, v0.5 browser sessions, and v0.5 encrypted credentials remain valid when the same volume, external key, and browser origin are retained. A migrated browser session can create the first reusable access key under Settings; if no migrated session remains usable, follow the `rotate-access-key --confirm` recovery procedure above. The server accepts legacy `JELLOFIN_COMMAND_*` runtime variables during this transition, but `HELMSMAN_*` takes precedence. Users of the hardened key must reuse the exact old key; copy its bytes to the new Helmsman key path or continue reading the old file rather than generating a replacement.

v0.4 credentials lived only in the browser vault and cannot be taken by the container automatically; enter them once in Helmsman. If the instance is claimed but no current session exists, use `rotate-access-key --confirm`; it preserves connections and policy while printing a new access key once.

Keep the v0.4 archive and original browser profile until every service reports a successful Helmsman check. The old browser vault is not loaded by Helmsman.

## Operations

```sh
docker compose ps
docker compose logs --tail=100 helmsman
docker compose restart helmsman
docker compose down
```

`/healthz` confirms only that the local process and state are available. Upstream outages belong in the incident UI and intentionally do not create a restart loop.

## Publish through GitHub

The repository workflow is the supported release path. Pull requests and pushes to `main` run the contracts and Linux AMD64/ARM64 runtime smoke tests without publishing a release image. Pushing the exact version tag publishes the multi-architecture image under version, beta, and full-commit tags, then atomically creates the matching GitHub prerelease with deployment files pinned to that manifest's immutable digest:

```sh
git tag -a v0.10.0-beta.9 -m "Helmsman v0.10.0-beta.9"
git push origin v0.10.0-beta.9
```

After the **Container** workflow succeeds, verify that:

- `ghcr.io/OWNER/REPOSITORY:0.10.0-beta.9` contains Linux AMD64 and ARM64 manifests;
- the GitHub Release is marked as a prerelease;
- `compose.yaml`, `container.env.example`, and `SHA256SUMS` are attached;
- both downloaded deployment files contain the same lowercase `ghcr.io/owner/repository@sha256:...` manifest reference and no `OWNER/REPOSITORY` placeholder; and
- `sha256sum -c SHA256SUMS` succeeds beside the two downloaded deployment files.

New GHCR packages are private unless their visibility is changed. Keep the package private for authenticated pulls, or change the package—not merely the repository—to public to permit the anonymous `docker compose pull` experience. GitHub treats that public visibility change as irreversible, so it must be a deliberate publication decision.

## Build from source

The production `compose.yaml` intentionally has no `build:` section. Developers with a source checkout can add the local build definition without changing the production file:

```sh
docker compose -f compose.yaml -f compose.dev.yaml build --pull
docker compose -f compose.yaml -f compose.dev.yaml up -d
docker compose -f compose.yaml -f compose.dev.yaml logs --tail=100 helmsman
```

Use that same pair of Compose files for later source-build lifecycle and recovery commands. Do not distribute `compose.dev.yaml` as the normal server deployment path.
