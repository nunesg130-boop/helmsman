# Helmsman Docker deployment — v1.3.1

> [!WARNING]
> Back up the `/data` volume before every update, run only the newest published
> release, and do not scale multiple instances against one volume. Browser
> access belongs to one exact Jellyfin administrator; Helmsman has no separate
> per-user roles or audit attribution.

The supported image contains one non-root Node.js process. It serves the Media and Infrastructure workspaces, owns the encrypted credential store and browser sessions, runs safe background health checks, and exposes only the bounded actions documented below. It does not contain Caddy, Authentik, a database, a Docker socket, SSH, a shell, a hypervisor console, or host mounts.

v1.3.1 retains Media **Overview** as the canonical landing page and redirects legacy
`#/home` links to `#/overview`. The reference-aligned visual and copy refresh
keeps connection health distinct from service health, mixes current requests
and service warnings in one attention card, reports the evidence-backed
five-stage media lifecycle, and promotes Downloads & Imports when Continue
Watching has no current Jellyfin data. Radarr, Seerr, and Sonarr use the
refreshed bundled user-supplied SVG artwork. The visual reference changes the
presentation, not the normalized data or supported action surface. It also
restores the last successful normalized snapshot as visibly marked read-only
**Cached data** while the first live health cycle runs. Successful raster
artwork uses a bounded private persistent cache under `/data/cache/artwork`;
credentials, headers, raw service responses, Jellyfin session identities, and
Loki results are never cached. Cached evidence cannot authorize any action.

The v1.3.1 Obsidian Glass overhaul changes presentation only. It applies the
selected near-black, compact glass-console styling across the shell, cards,
forms, dialogs, logging, and responsive navigation without copying the
reference image's charts or sample metrics. Existing normalized data, routes,
health semantics, cached-state rules, and action boundaries remain
authoritative.

## 1. Prepare

The GitHub Release for `v1.3.1` publishes three deployment assets:

- `compose.yaml` — the pull-only production service definition pinned to the released multi-architecture image digest;
- `container.env.example` — the same digest-pinned image reference plus non-secret bind-address and port settings;
- `SHA256SUMS` — SHA-256 checksums for both deployment files.

The release workflow replaces the source checkout's image placeholder with
`ghcr.io/nunesg130-boop/helmsman` and the exact multi-architecture manifest
digest (`@sha256:...`) before publishing the assets. Do not deploy the
placeholder-bearing files directly from a source checkout; use the matching
GitHub Release assets.

The three release assets are the complete base deployment. Optional Caddy examples, migration overrides, the external-key override, and `compose.dev.yaml` remain available from the repository at the matching Git tag and should be downloaded only when that deployment mode is needed.

Download and verify the public release assets on Linux:

```sh
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 /opt/helmsman
cd /opt/helmsman
curl -fLO https://github.com/nunesg130-boop/helmsman/releases/download/v1.3.1/compose.yaml
curl -fLO https://github.com/nunesg130-boop/helmsman/releases/download/v1.3.1/container.env.example
curl -fLO https://github.com/nunesg130-boop/helmsman/releases/download/v1.3.1/SHA256SUMS
sha256sum --strict --check SHA256SUMS
```

On macOS, use the same downloads and verify them with:

```sh
shasum -a 256 -c SHA256SUMS
```

Windows users can download the same three files from the GitHub Release page.
Open PowerShell in that directory and verify both payloads before creating
`.env`:

Windows PowerShell:

```powershell
$Expected = @{}
Get-Content .\SHA256SUMS | ForEach-Object {
  if ($_ -notmatch '^([0-9a-fA-F]{64})  (compose\.yaml|container\.env\.example)$') { throw "Invalid SHA256SUMS entry: $_" }
  $Expected[$Matches[2]] = $Matches[1].ToLowerInvariant()
}
foreach ($File in 'compose.yaml','container.env.example') {
  if ((Get-FileHash -Algorithm SHA256 $File).Hash.ToLowerInvariant() -ne $Expected[$File]) { throw "Checksum mismatch: $File" }
}
Copy-Item .\container.env.example .\.env
```

Linux or macOS:

```sh
cp container.env.example .env
```

The default file is enough for same-computer use:

```dotenv
HELMSMAN_IMAGE=ghcr.io/nunesg130-boop/helmsman@sha256:<release-manifest-digest>
HELMSMAN_BIND_IP=127.0.0.1
HELMSMAN_PORT=4180
```

Fresh installs receive a Compose-project-scoped `helmsman-data` volume. Do not add media, Proxmox, or Portainer URLs, API keys, passwords, token IDs, token secrets, access tokens, Helmsman access keys, cookies, setup tokens, or Authentik secrets to `.env`. `HELMSMAN_DATA_VOLUME` is only for the explicit v0.5 migration procedure near the end of this guide.

## 2. Pull and start

The canonical GHCR package is public and requires no registry login. Private
forks must manage their own registry authentication; never save a registry
token in `.env`, Compose YAML, the repository, or shell history.

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

Only its SHA-256 digest is stored. Restarting before claim invalidates the previous value. This token is only for first claim or offline access recovery; it is not a reusable browser credential.

On the Docker host, open `http://127.0.0.1:4180`. From another computer, keep
the default loopback bind and start an SSH tunnel:

```sh
ssh -L 4180:127.0.0.1:4180 user@your-helmsman-host
```

Then open `http://127.0.0.1:4180` in the local browser. For permanent remote
access, configure a trusted HTTPS reverse proxy and firewall port 4180 so only
that proxy can reach it. Do not expose the loopback-oriented HTTP deployment
directly; Helmsman rejects first claim from an untrusted remote HTTP origin.

Enter:

1. the setup token;
2. a name for this browser session;
3. the default exact-service network mode, or optional manual private CIDRs as an advanced boundary;
4. optionally, permission for explicitly registered public HTTPS services.

Claim is accepted only on loopback HTTP or a trusted HTTPS origin. A successful fresh claim opens the browser's setup session; it does not create or reveal a reusable access key. Next, select Media **Connections**, add and verify the Jellyfin connection, then open Settings and enroll one exact enabled Jellyfin administrator by entering only its username and password. Helmsman obtains the stable Jellyfin server ID and user ID itself. Those internal IDs are never requested from or displayed to the operator.

Enrollment binds that exact administrator as Helmsman's sole owner. Another user—including another Jellyfin administrator—cannot substitute for it. Every browser subsequently signs in with the owner's Jellyfin username and password and receives its own revocable 30-day session. The browser credential is an HttpOnly, `SameSite=Strict` cookie bound to the exact scheme, host, and port; mutations also require the matching per-session CSRF value. Helmsman immediately discards the password and encrypts the resulting Jellyfin access token server-side for only that session, cookie verifier, immutable claims, and exact network boundary. It authenticates the owner/session authorization index with the credential master key, so offline edits fail closed. Neither the password nor the Jellyfin token is placed in `.env`, a URL, browser storage, or application logs.

The configured Jellyfin connection is required for enrollment, sign-in, and ongoing owner validation. Its saved monitoring credential remains destination-bound and separate from browser-authentication tokens. Explicit authentication rejection, token revocation, identity mismatch, account disablement, or administrator demotion revokes the local session. When Jellyfin is unreachable, new sign-ins fail. A recently validated session may retain bounded read-only access during a transient outage, but state-changing actions require fresh Jellyfin validation and fail closed.

The default mode needs no CIDR entries. Each time a private service is explicitly registered, Helmsman resolves it and stores only those safe private addresses as connection-specific `/32` (IPv4) or `/128` (IPv6) approvals. Later checks must resolve entirely inside those exact approvals; a changed private address must be reviewed and saved again. Manual CIDRs are available when an operator intentionally needs a broader private registration boundary. In either mode, immutable SSRF deny ranges remain blocked, mixed-policy DNS fails closed, and public HTTP is never allowed. Public HTTPS still requires the separate explicit setting.

## 4. Add services

Select Media **Connections** to configure Jellyfin, Seerr, Radarr, Sonarr, Prowlarr, qBittorrent, or Bazarr in their purpose-based categories. Select Infrastructure **Connectors** to connect one or more Proxmox environments or Portainer servers, or to register Loki under **Observability**. Infrastructure **Overview** shows configured Proxmox and Portainer connections; the global **Logs** overview shows the built-in journal and configured Loki sources. A Proxmox environment is either one standalone server or one multi-node cluster; API endpoints, physical nodes, and VM/LXC workloads remain separate records. Portainer and Loki are Infrastructure services and never appear in Media. Enter each full URL and credential in the interface. The container registers the exact URL after validating it against the current network policy. It encrypts each credential independently with AES-256-GCM, a fresh 96-bit nonce, and authenticated instance/connection/field/revision metadata.

Media monitoring remains read-only by default. Overview summarizes Continue Watching, service health, active downloads and imports, requests and warnings, an evidence-backed media lifecycle, and recently added titles. Its compact health rows keep connection and service health separate, and its attention card mixes current requests with service warnings. Continue Watching resolves an episode to its series poster instead of displaying the episode's resume frame; when no current resume data exists, Downloads & Imports is promoted into its lead position, while additional resume items remain available in a compact poster rail. The fixed Now Playing query retains only bounded media and play-state fields and discards user, device, client, network, and stream-session metadata. Discover displays the bounded Seerr discovery feed and labels ordinary unmatched titles **Not requested** instead of exposing an internal unknown state; only Jellyfin evidence can label an item available in Helmsman's library. Library joins Jellyfin availability with Radarr/Sonarr monitoring and import evidence. Requests preserve separate request IDs, Seerr approval state, acquisition state, exact season scope, and 4K scope. Availability comes from Seerr's media record, an exact provider-ID match to a Jellyfin movie, or the matching requested-season availability records—not the separate request-workflow season status—so completed media no longer remains labeled **Awaiting Jellyfin**, while an older Jellyfin series record still cannot falsely fulfill a new season request. Activity correlates qBittorrent download identifiers with Sonarr/Radarr queue entries and can display their bounded sanitized status error. Calendar keeps episodes distinct and shows episode coordinates without repeating series titles. Health retains service and pipeline monitoring, while Connections owns service enrollment. The only Media writes are a Helmsman-confirmed Seerr failed-request retry, a selected standard-season request for one exact current series through Seerr, a targeted Radarr/Sonarr search when Helmsman can resolve one exact current record, and **Block release & search again** for one exact current errored Sonarr/Radarr queue item. That danger-confirmed recovery removes the download and its data from the download client, blocklists the release, and allows Sonarr/Radarr to seek a replacement according to its settings; it requires fresh, connected, revision-matched blocked/error evidence and is revalidated before dispatch. Series and parent-resolved episode drawers load a bounded current season catalog from Seerr on demand. The operator can select requestable standard seasons, review the exact selection in Helmsman's accessible in-app confirmation instead of a browser-native prompt, and submit one standard-quality request. Specials, 4K selection, arbitrary Seerr users, servers, profiles, root folders, and request bodies are not exposed. Helmsman revalidates the current record, target revision, and action-specific detail immediately before dispatch. Helmsman cannot approve requests or delete requests, request movies or 4K/Specials, choose Seerr routing/profile fields, change monitoring, pause downloads, remove healthy or arbitrary downloads, alter any other files, or run free-form searches. It exposes no generic delete, remove, force-stop, reset, kill, or bulk action and no general upstream API proxy.

Media records are joined by TMDb, TVDb, IMDb, download, and service identifiers rather than titles. The five-stage lifecycle is **Requested → Monitored → Downloading → Imported → Available**, and a stage is reported only when current service evidence supports it. The last successful normalized snapshot may be retained under `/data/cache` so the dashboard can recover after a restart; it is never written to `state.json`, is visibly marked **Cached data**, and cannot authorize actions. Raw responses, credentials, headers, service-authored reports, Jellyfin session identity, and Loki results are excluded.

The browser receives only opaque same-origin artwork URLs. The authenticated broker tries Jellyfin first, fixed 250 px, 500 px, and original Radarr/Sonarr covers second, and Seerr last. If Sonarr supplies only a TVDB remote poster, Helmsman performs a typed Seerr TV lookup with Sonarr's validated TMDb ID and then requests only Seerr's fixed TMDb image-proxy route; it never follows the remote URL. It requests revisioned 342 px Jellyfin/Seerr thumbnails, accepts only bounded raster responses, and never returns upstream URLs or credentials. Duplicate misses are coalesced, and at most three upstream artwork requests run concurrently with 64 pending requests. Positive results are cached in memory for up to 24 hours and in the private persistent tier for up to 30 days. General failures remain memory-only for 15 minutes, versioned Arr cover misses for 30 seconds, and unrevisioned Arr misses are not negative-cached. The memory tier is bounded to 512 entries and 64 MiB; the persistent tier is bounded to 2,048 entries and 512 MiB; both accept no more than 4 MiB per image. Persistent entries are content-verified, connector-revision scoped, protected against link traversal, and written atomically. Browser responses use ETags, a one-day private cache lifetime, and one-week stale revalidation/error windows. Reviewed, hash-pinned icons for the nine existing media and infrastructure integrations are bundled locally, require no icon CDN, and are governed by the included asset notices; Loki uses Helmsman's project-owned logging mark, and original generic workload SVGs are also bundled locally.

The encrypted credential is also bound to that canonical destination. Changing a service URL requires entering a fresh credential; editing or restoring state with a different URL makes the old credential unavailable rather than forwarding it to the new host.

The browser receives only these facts:

- whether a credential is configured;
- its last update time;
- the non-secret service URL and monitor state.

It cannot request the saved credential, ciphertext, nonce, authentication tag, or master key.

A Jellyfin connection requires a Dashboard API key, a user access token, or a one-time username/password exchange. In exchange mode Helmsman immediately discards the password and encrypts only the access token returned by Jellyfin. This is the long-lived monitoring connector credential; it remains distinct from the owner login and per-browser Jellyfin tokens described above. A Seerr connection requires either the global API key from Settings > General or a one-time native local account email/password exchange. Seerr local authentication must be enabled for the exchange; Helmsman discards the password and encrypts only the returned session. Use service API keys for Radarr, Sonarr, Prowlarr, and Bazarr, and a qBittorrent 5.2+ `qbt_` API key. Password-based qBittorrent sessions are not suitable for an unattended monitor and are not used.

Each Proxmox endpoint uses a dedicated API token ID in the form `user@realm!token-name` and its generated token secret. Both fields are write-only in the browser and encrypted at rest. Use a dedicated least-privilege user and token scoped to the required inventory plus power-management access for only the guests Helmsman may control; do not enter a Proxmox username/password, `root@pam`, a root token, or an administrative token. One Helmsman instance accepts at most 25 environments and 25 total endpoints, with up to four explicitly approved endpoints in one environment.

Use **System trust** when the Proxmox certificate chains to a CA trusted by the container. For a self-signed or local certificate, select **Pinned SHA-256 fingerprint** and enter the exact certificate fingerprint. Helmsman has no global or per-endpoint “ignore TLS errors” option. A certificate replacement therefore requires an explicit fingerprint review instead of silently weakening HTTPS.

Obtain a self-signed certificate fingerprint out of band: run `pvenode cert info` directly on the Proxmox host console, identify the certificate served by `pveproxy`, and copy its SHA-256 fingerprint. Do not trust a fingerprint discovered only through the same network path being enrolled.

**Connect and discover** authenticates to the entered endpoint, establishes whether it reports a standalone server or cluster, and shows the cluster name and visible node names before anything is saved. An environment cannot be saved without a stable discovered identity. Changing the endpoint URL, TLS identity, or credential requires discovery to succeed again.

After the environment is saved, its detail view can register additional endpoints for failover. Every alternate endpoint requires an operator-entered URL, explicit TLS verification, its own encrypted write-only token, and a successful identity match. Helmsman never trusts discovered IP addresses or certificates automatically. It also never combines existing environment configurations automatically, even if two endpoints later report the same cluster.

Proxmox monitoring and probes use fixed read-only GET routes. Separate actions use Helmsman's accessible in-app confirmation, revalidate the current workload after approval, and use fixed method, path, query, and body templates to start, reboot, or gracefully shut down one current QEMU VM or LXC. The browser selects a supported action and normalized workload record; it cannot supply an arbitrary upstream path or request body. Helmsman exposes no general Proxmox API proxy and cannot force-stop, reset, kill, delete, remove, migrate, back up, restore, reconfigure, open a console, or perform a bulk action. It also has no SSH credential, shell, Docker socket, or host mount.

Helmsman exposes a bounded read-only inventory to the authenticated UI: each node, VM, LXC, storage entry, and recent activity/backup result is normalized and sanitized. Cluster-wide inventory is collected only once per environment and monitoring cycle through one healthy, identity-matched endpoint, which prevents duplicate workloads and incidents. Recent tasks and backup tasks are queried through each visible node's fixed read-only route and merged with their node identity retained; raw UPIDs and command-bearing task status text are discarded. Endpoint health is reported separately from actual node health; losing a primary endpoint can leave the environment Limited and inventory available through an approved alternate.

### Proxmox token preparation

Create a dedicated Proxmox user and an API token with privilege separation enabled. Grant only the inventory privileges needed for resources Helmsman should see plus `VM.PowerMgmt` on the specific guests or pool it may control. For complete cluster-level visibility, an operator may assign Proxmox's built-in `PVEAuditor` role at `/` with propagation while assigning the power-management role at a narrower guest or pool path; narrower visibility is safer when complete inventory is unnecessary, but unavailable resources will remain absent or Limited in Helmsman. Do not grant administrator, node-control, storage-allocation, migration, backup, console, or configuration privileges. Copy the generated token secret when Proxmox displays it and store it directly through the Helmsman form.

### Portainer access-token preparation

Open **Infrastructure → Connectors** and select **Portainer** to add up to eight independent Portainer servers. After the first connection is saved, the dedicated Portainer inventory view becomes available in the sidebar. For each one, enter its display name, full HTTPS URL (normally `https://host-or-ip:9443`), TLS trust mode, durable access token, and monitoring choice. Use **System trust** for a certificate chaining to a CA trusted by the container. For a self-signed or local certificate, use **Pinned SHA-256 fingerprint** and verify that fingerprint out of band. Plaintext Portainer URLs and “ignore TLS errors” behavior are not supported.

Generate the access token for a dedicated least-privilege Portainer user whose visible environments and container lifecycle permissions are limited to what Helmsman should monitor and control. Access tokens inherit their Portainer user's permissions. Helmsman sends the token only as `X-API-Key`, stores it encrypted and write-only, and binds it to that exact URL and TLS identity. Do not use an administrator token and do not put the URL or token in `.env`.

The test verifies a Portainer status route and `/api/users/me` before saving. Monitoring and probes then use fixed read-only GET routes for paged environments, stacks, and Docker-compatible container inventories. Multiple Docker or Podman environments can be reported by one server. Kubernetes and Azure environments may be listed, but Helmsman does not send them through the Docker container route. The responsive inventory groups containers by server and environment and separates identity, stack, runtime, deduplicated ports, and actions; private-only ports are labeled internal. Stopped containers are informational; unavailable environments and unhealthy, dead, or restarting containers report bounded specific errors. Separate actions use Helmsman's accessible in-app confirmation, revalidate the current container after approval, and use fixed method, path, query, and body templates to start, restart, or gracefully stop one current Docker-compatible container. The browser cannot supply an arbitrary upstream path or request body. There is no general Portainer or Docker API proxy and no stack control, delete, remove, force-stop, reset, kill, or bulk action. Helmsman has no Docker socket or host mount.

### Loki log-source preparation

Open **Infrastructure → Connectors → Observability** and select **Grafana
Loki**. Enter a display name and the full Loki base URL reachable from the
Helmsman container. Grafana is not required; Helmsman connects directly to
Loki's HTTP API, while Grafana remains an optional companion for dashboards,
alerts, and broader exploration.

Choose one authentication mode:

- **None** sends no authorization header;
- **Basic** stores a write-only username and password; or
- **Bearer** stores one write-only access token.

An optional tenant ID is sent as `X-Scope-OrgID`. Basic and bearer credentials
require HTTPS and are encrypted and bound to the exact destination and TLS
identity. For HTTPS, choose **System trust** or enter an explicitly verified
**Pinned SHA-256 fingerprint**. Helmsman has no ignore-certificate-errors mode.
Plain HTTP is accepted only with **None**, and only for a target authorized by
the private-network policy; public HTTP remains blocked.

The connection test and monitor use only fixed GET routes for readiness,
build information, and the label list. The global
**Logs → Loki Explorer** uses only the read-only `query_range` endpoint. It
does not expose push, delete, ruler, configuration, administrative, live-tail,
or arbitrary caller-selected routes. Returned lines and labels are bounded and
shown transiently; Helmsman does not copy them into its persistent journal.

## Container-to-target addressing

An address working in the host browser may not mean the same thing inside a container:

- use a routable LAN address for a service on another host;
- Docker Desktop normally provides `host.docker.internal` for a service on the Docker host;
- on Linux, an explicit `extra_hosts: ["host.docker.internal:host-gateway"]` mapping may be added if needed;
- services in another Compose project may share an intentionally created Docker network.

The entered address must resolve from inside Helmsman and pass the selected boundary: its exact per-connection approval in the default mode, or an operator-supplied CIDR in manual mode. For Proxmox, use an HTTPS address reachable from the container, normally the management hostname or IP and port `8006`. For Portainer, use its reachable HTTPS base URL, normally on port `9443`. Plaintext HTTP is rejected for Proxmox and Portainer. Loki may use plaintext HTTP only with no authentication and only across an authorized private-network path; use HTTPS for Basic or bearer authentication and whenever the network is not fully trusted. Do not mount `/var/run/docker.sock` to discover services or infrastructure.

## Monitoring behavior

The container polls enabled media services, Proxmox environments, Portainer servers, and Loki connections on bounded schedules. Every connector has an explicit read-only probe plan; one failed capability does not erase successful evidence from another. For a Proxmox environment, endpoint probes select one healthy identity-matched route and the full cluster inventory runs once. Each Portainer and Loki service is probed independently, so one failed connection does not erase another service's evidence. A Portainer server gets a 45-second probe deadline; completed inventory remains visible and `PORTAINER_INVENTORY_PARTIAL` identifies unfinished coverage for retry during the next cycle. Loki checks connection/authentication, readiness, build identity, and bounded query access separately so a reachable service warning is not misreported as a network failure. Poll cycles never overlap, responses are bounded, and simultaneous refresh requests coalesce.

Two identical consecutive failures open one incident. Later failures increment its occurrence count. A successful check closes it and records a recovery. States mean:

| State | Meaning |
|---|---|
| Healthy | Every checked capability responded normally |
| Limited | An optional feature failed but core flow remains available |
| Degraded | An important feature or part of the pipeline failed |
| Down | No core capability can be confirmed |
| Authentication required | A service returned 401/403 or rejected the credential |
| Stale | No recent trustworthy result is available |

Only bounded normalized media fields, derived status, safe codes, timing, version, counters, incidents, and transitions reach the UI. Raw response bodies, headers, upstream URLs, usernames, credentials, unbounded error text, and search terms are discarded. The last successful bounded normalized snapshot may be restored from the private persistent cache and is then marked read-only until live monitoring replaces it. Proxmox, Portainer, and Loki monitoring follow the same normalization rule. Interactive Loki results are a separate transient source and may contain sensitive text from the systems that produced those logs; they are never copied into the cache.

Authenticated browsers may also receive current live health reports built only from allowlisted `source`, `type`, and `message` fields in supported structured service health responses. Their count and length are bounded, secret-like values are redacted, and the browser escapes every field before display. Reports remain only in the current operations snapshot; they are never copied into incidents, events, history, application logs, or persistent files. Raw response bodies and raw error bodies are never exposed. Because service-authored reports can include non-secret paths or hostnames, keep the interface private or protect every route with trusted HTTPS and appropriate access control.

For probe compatibility, Radarr, Sonarr, and Prowlarr `Notice` health entries remain informational rather than making a service Limited. Helmsman handles Prowlarr's blocked-indexer endpoint and Seerr's current status, authenticated-identity, and request-count routes explicitly. Proxmox, Portainer, and Loki use separate fixed route allowlists; none accepts an API path supplied by the browser. Portainer 3.x status is checked first, and the legacy status route is used only when the newer route returns HTTP 404.

## Built-in logging

Helmsman's operational event journal is enabled by default and needs no
external service. **Logs → Helmsman logs** reads bounded, allowlisted events
from private JSONL segments under `/data/logs`. The default retention limits
are 14 days and 20 MiB total; older segments are pruned when either boundary is
exceeded. The journal uses private directory and file permissions inside the
container data volume.

The event schema records operational facts such as time, severity, category,
outcome, service/capability identifiers, action names, and safe status codes.
It excludes credentials, cookies, authorization headers, request bodies,
upstream response bodies, raw LogQL, and returned Loki lines. Live structured
health-report messages remain transient; only a derived transition and safe
code may be journaled. This is an operational history, not a raw debug stream
or a multi-user audit trail.

Protect `/data/logs` with the rest of the data volume. Although entries are
sanitized before storage, identifiers, timing, service names, and failure codes
can still describe the deployment. Review entries before attaching them to a
public issue. The ordinary `docker compose logs` stream is separate and still
contains process startup output, including the one-time setup token while an
unclaimed instance is being initialized.

## Browser access and recovery

Each browser signs in with the exact enrolled Jellyfin administrator's username and password. Helmsman does not ask for or display a Jellyfin server ID or user ID, and unauthenticated status does not disclose the enrolled username. It issues an origin-bound 30-day HttpOnly session and CSRF value, and it stores the resulting Jellyfin token only as server-side ciphertext authenticated against that session and exact Jellyfin network boundary. A changed URL, target revision, address pin, or policy revokes every browser session locally before old-token use and returns the initiating browser to sign-in. Logout and ordinary session revocation erase that token and make a best-effort Jellyfin logout request when the original boundary remains current. Prefer a Jellyfin HTTPS URL; private HTTP is supported only on a trusted container/LAN path because it does not encrypt the password on that hop.

Use the same Compose file stack for every lifecycle and recovery command:

| Installation | Compose command prefix |
|---|---|
| Fresh local install | `docker compose` |
| Upgrade using the v0.5 volume | `docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml` |
| Fresh install with external key | `docker compose -f compose.yaml -f deploy/compose.hardened.yaml` |
| v0.5 volume and external key | `docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml` |

For a hardened deployment, export the exact same `HELMSMAN_MASTER_KEY` before any of these commands and unset it afterward. The examples below show the fresh local prefix; substitute the appropriate full prefix on every line.

If the enrolled owner can no longer authenticate and no signed-in browser can repair the Jellyfin connection or enrollment:

```sh
docker compose stop helmsman
docker compose run --rm --no-deps helmsman reset-access --confirm
docker compose up -d
```

This is the sole break-glass command. It removes the owner binding, revokes all browser sessions in Helmsman, and destroys Helmsman's encrypted copies of their Jellyfin tokens while preserving the instance ID, network policy, registered targets, and encrypted monitoring credentials. Because the broker is stopped, the command cannot send Jellyfin logout requests; if a token may have been copied elsewhere, invalidate that upstream session in Jellyfin too. The next broker start writes a new one-time setup token to standard output. Claim the instance, confirm the saved Jellyfin connection, and enroll an enabled Jellyfin administrator again. The reset never creates or prints a reusable browser key. The main service must be stopped so two processes cannot write `/data` concurrently.

For an upgrade from v1.0.0-beta.2, its access key exists only as a temporary migration credential. Use a current browser session or that legacy key to open Settings and enroll the owner. Successful enrollment atomically removes the access-key verifier and revokes all legacy browser sessions; v1.0.6 and later cannot create, reveal, or rotate another key. If neither a beta.2 session nor its key is usable, run the reset sequence above.

## Data and backups

The named volume contains:

- `state.json` — instance, claim state, policy, and service destinations;
- `sessions.json` — the master-key-authenticated Jellyfin-owner binding and browser-session hashes, never a password or bearer token; a beta.2 access-key verifier can remain only until enrollment completes;
- `credentials.json` — authenticated ciphertext for destination-bound connector credentials and separate per-session Jellyfin login tokens;
- `credentials.key` — the automatically generated master key in easy local mode;
- `logs/helmsman-events-*.jsonl` — the sanitized operational journal, with default 14-day and 20 MiB retention boundaries;
- `cache/operations-v1.json` — the checksummed last successful normalized snapshot, retained for at most 30 days with transient service-authored reports removed;
- `cache/artwork/*.art` — content-verified successful raster artwork, bounded to 2,048 entries, 512 MiB total, 4 MiB per image, and 30 days; and
- a process lock while the container is running.

Raw upstream responses, credentials, authorization headers, passwords, Jellyfin session identity, service-authored reports, negative artwork results, and returned Loki query lines are intentionally absent from the cache. Cached normalized state is only a startup view and cannot authorize a control action.

Treat the entire volume and its backup history as sensitive. Back it up with the Docker/NAS mechanism appropriate to your host. Authorization-state integrity detects forged edits but is not a hardware-backed monotonic counter, so replaying an older complete, valid backup rolls access state back to that snapshot. After intentionally restoring a backup that predates an owner or browser-access change, run `reset-access --confirm` and enroll the intended owner again. Never use `docker compose down -v` during an ordinary update.

If `credentials.key` is lost, credentials and the authorization-state integrity seal cannot be recovered. A wrong key causes startup to fail closed without modifying ciphertext. To keep the network policy and registered targets while replacing unrecoverable credentials:

```sh
docker compose stop helmsman
docker compose run --rm --no-deps helmsman reset-credentials --confirm
docker compose run --rm --no-deps helmsman reset-access --confirm
docker compose up -d
```

The credential store also contains each browser session's encrypted Jellyfin token and the key authenticates the owner/session index. The required `reset-access` step therefore removes the old owner binding and browser sessions. After restart, claim the preserved instance and enroll the Jellyfin owner again.

The reset moves `credentials.json` and the easy-mode `credentials.key`, when present, to timestamped `*.unrecoverable-*` files instead of deleting them. The next start creates an empty encrypted store, after which each service credential must be re-entered and the old credential should be rotated at its source. Treat the quarantine files as sensitive; remove them only after the replacement is working.

With `deploy/compose.hardened.yaml`, the externally managed key is never changed by the command. If that key was lost, generate and export a replacement key first, then retain the hardened override for the reset and restart commands. If the key merely changed by mistake, restore the original key instead of resetting; that retains the existing encrypted credentials.

```sh
docker compose -f compose.yaml -f deploy/compose.hardened.yaml stop helmsman
docker compose -f compose.yaml -f deploy/compose.hardened.yaml run --rm --no-deps helmsman reset-credentials --confirm
docker compose -f compose.yaml -f deploy/compose.hardened.yaml run --rm --no-deps helmsman reset-access --confirm
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

Authentik or another external MFA edge authenticates browser users before they reach Helmsman. It never replaces the exact Jellyfin-owner login, the monitoring connector credential, or any credential Helmsman needs for another upstream service. Jellyfin's username/password exchange does not perform an Authentik challenge, so keep the edge in front of every path and prevent direct access to port 4180 when external MFA is required.

Jellyfin-backed browser authentication requires no Cloudflare Tunnel, Caddy, or Authentik protocol change. The external layer authenticates and proxies the browser first; Helmsman then verifies the exact enrolled Jellyfin owner and operates through its own origin-bound session. The container continues contacting registered upstream services directly with separate saved connector credentials.

The Authentik example removes `JFC_SESSION` and known legacy upstream session cookies from each authentication subrequest, so the control-plane session is never disclosed to Authentik. It preserves Authentik's own login cookie, then forwards the browser's `JFC_SESSION` cookie to Helmsman only after Authentik admits the request. The `JFC_` cookie namespace remains intentionally stable for upgrade compatibility. Stripping the entire `Cookie` header would normally break Authentik's browser session.

## Update an existing Helmsman installation

Keep the existing `/opt/helmsman` directory and Compose file stack so the
installation continues to use the same `helmsman-data` volume. The guarded
publisher downloads the release assets on the Windows publishing computer,
checks their SHA-256 values and common image digest, and prints the exact `scp`
commands needed to transfer all three into
`/opt/helmsman/releases/<version-tag>`.

Run the printed server block rather than editing the image tag by hand. Before
installation it rechecks `SHA256SUMS` with `--strict`, backs up both
`compose.yaml` and the existing `.env`, and unsets a shell-level
`HELMSMAN_IMAGE` that could take precedence over the file. It builds a new
`.env` in the same directory, preserving all existing settings except removing
every old `HELMSMAN_IMAGE` assignment and appending one canonical
digest-pinned value. The temporary file is atomically renamed into place and
retains the previous `.env` owner and mode. If `.env` did not exist, the
verified `container.env.example` supplies the safe defaults and the new file
receives mode `0600`.

The verified release `compose.yaml` is then installed. Before any pull or
recreation, `docker compose config --images` must equal the exact verified
`ghcr.io/nunesg130-boop/helmsman@sha256:...` reference. This prevents an old
`.env` line or exported shell variable from silently selecting another image.
When a newly created `.env` needs a non-loopback bind for the HTTPS edge,
review `HELMSMAN_BIND_IP` before starting the service.

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

Take a volume backup before updating. The printed deployment block records the
previous files as `compose.yaml.before-<version>` and
`.env.before-<version>` when `.env` existed. Rollback must restore both inputs,
not only the image line:

```sh
set -euo pipefail
cd /opt/helmsman
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
```

The missing `.env` backup means that no `.env` existed before that update, so
removing the newly created file restores the previous configuration shape. Do
not run an older image against state already migrated by a newer release unless
that release explicitly documents backward schema compatibility; restore the
matching pre-update volume backup instead.

v0.10 advances the state schema to 4 by adding an empty bounded Infrastructure-services collection. Existing media connections, destination-bound encrypted credentials, browser sessions, network approvals, and Proxmox environments/endpoints are retained; nothing is automatically converted into or combined with a Portainer connection. Its original unified media model and Portainer inventory required no catalog migration. v1.2.0 adds a separate disposable `/data/cache` without changing the state schema; Helmsman can rebuild it from current read-only service responses. Installations coming directly from an older schema still run the existing migrations, including keeping every prior Proxmox target separate rather than merging matching clusters automatically. Back up the volume before upgrading, and do not roll migrated state back into an older image.

v1.0.6 advances the state schema from 4 to 5 so Loki connections can be stored as bounded Infrastructure observability services while preserving existing Portainer records exactly. Existing media connections, Proxmox environments, browser sessions, network approvals, and destination-bound encrypted credentials remain in place. Do not run v1.0.5 against state already migrated to schema 5. To roll back to v1.0.5, restore both the deployment inputs and the `/data` volume backup taken before the v1.0.6 update.

When upgrading from v0.10.0-beta.8, use an existing browser session to configure Jellyfin and enroll the exact administrator under Settings. If no beta.8 browser session is still usable, stop the service and run `docker compose run --rm --no-deps helmsman reset-access --confirm` using the same Compose file stack. The next start emits a new one-time setup token while preserving configuration and encrypted monitoring credentials.

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

Registered service URLs, v0.5 browser sessions, and v0.5 encrypted credentials remain valid when the same volume, external key, and browser origin are retained. Use a migrated browser session to configure Jellyfin and enroll the exact administrator under Settings; if no migrated session remains usable, follow the `reset-access --confirm` recovery procedure above. The server accepts legacy `JELLOFIN_COMMAND_*` runtime variables during this transition, but `HELMSMAN_*` takes precedence. Users of the hardened key must reuse the exact old key; copy its bytes to the new Helmsman key path or continue reading the old file rather than generating a replacement.

v0.4 credentials lived only in the browser vault and cannot be taken by the container automatically; enter them once in Helmsman. If the instance is claimed but no current session exists, use `reset-access --confirm`; it preserves connections and policy, and the next start prints a one-time setup token.

Keep the v0.4 archive and original browser profile until every service reports a successful Helmsman check. The old browser vault is not loaded by Helmsman.

## Operations

```sh
docker compose ps
docker compose logs --tail=100 helmsman
docker compose restart helmsman
docker compose down
```

`/healthz` confirms only that the local process and state are available. Upstream outages belong in the incident UI and intentionally do not create a restart loop.

## Maintainers: publish through GitHub

Use local source builds for intermediate development, but publish each version
that will actually run on a deployment host. This section is for maintainers
of the canonical repository; normal operators should install the checksum-
verified GitHub Release assets from section 1. Publishing each deployed version keeps its image
identifiable and gives it a fixed rollback tag without turning every experiment
into a public release.

The normal publishing interface is version-independent. Extract any full
Helmsman source archive on a Windows computer and double-click the root
`Publish-Helmsman.cmd`; the adjacent `Publish-Helmsman.ps1` reads the version
from `package.json`, so no release-specific path or command needs editing. It
checks or installs Git, requires GitHub CLI 2.57.0 or newer, and authenticates
the expected active GitHub user,
verifies `repo` and `workflow` permissions plus write access to the canonical
repository, proves noninteractive HTTPS Git access without SSH or URL rewriting,
and creates or validates the persistent
`%USERPROFILE%\Downloads\helmsman-github` clone, configures its local author,
and validates the extracted source folder before handing both that source and
the verified clone to the SHA-256-bound guarded publisher. If a managed clone
is incomplete, dirty, on another branch, has a noncanonical effective remote,
or contains a clean unpublished commit that cannot fast-forward, it is
preserved and `%USERPROFILE%\Downloads\helmsman-github-recovery` becomes the
persistent publishing clone. An incompatible recovery directory is left intact
and the launcher advances to a bounded `-2`, `-3`, or later suffix; only a
verified clean HTTPS recovery clone is reused. If the standalone launcher is used, its folder picker accepts
either the outer version folder that contains `helmsman` or the inner
`helmsman` source folder itself. Extract the full release ZIP with Windows
before starting either launcher. Prefer a normal local folder such as
`C:\Helmsman-Releases`; if OneDrive marks the extracted tree as a cloud
placeholder or reparse point, move or re-extract it there.

To start the launcher from PowerShell instead:

```powershell
Set-Location "C:\path\to\the\extracted\helmsman"
.\Publish-Helmsman.ps1
```

The same launcher works on another computer and for every future prerelease or
stable version. Missing prerequisites may require Windows installation or UAC
approval, GitHub authentication opens in a browser once per computer, and the
operator must still type the exact `PUBLISH <detected-version>` confirmation.
The launchers ship in the source archive, not as extra GitHub Release assets.
Do not run the root launcher from the persistent `helmsman-github` clone; it
intentionally refuses that location to prevent self-overwrite.

For troubleshooting, the guarded Windows PowerShell 5.1 publisher remains at
`scripts\Publish-HelmsmanRelease.ps1` in both the extracted source and the
persistent clone. It expects the clone and extracted source release to be
separate, non-nested directories, independently validates the selected clone,
the exact active GitHub identity and HTTPS credential path, and is intentionally
bound to the `nunesg130-boop/helmsman` repository and
`.github/workflows/container.yml` (shown as **Container** in GitHub). See
[GITHUB.md](../GITHUB.md) for its advanced direct command and recovery flow.

The script requires a clean `main` synchronized with the exact expected
`origin`, validates the source and new SemVer version, scans prohibited paths
and common embedded-secret forms, stages the synchronized release, and shows
the staged file list and statistics. It makes no commit
or GitHub change until the operator types the single exact confirmation
`PUBLISH <version>`.

After confirmation, the script commits and pushes `main`. It finds and watches
the **Container** run for that exact commit and `main` ref; only a successful
gate allows it to create the annotated version tag. It then watches the run for
that exact commit and tag, and requires the resulting GitHub Release to have
exactly `compose.yaml`, `container.env.example`, and `SHA256SUMS`. It downloads
those assets into a new `helmsman-<version>-deployment-assets` directory beside
the source folder, verifies both checksums, rejects placeholders, and requires
the two configuration files to contain the same expected digest-pinned image.
For v1.3.1, the workflow publishes Linux AMD64 and ARM64 images under the
version, `latest`, and full-commit tags.

The publisher deliberately does not execute candidate source while maintainer
GitHub credentials are available. Both GitHub Actions gates are mandatory: the
hosted `main` workflow must pass for the exact pushed commit before a tag is
created, and the hosted tag workflow must pass before release assets are
accepted.

If the process stops before confirmation, nothing was committed, tagged, or
pushed, but the synchronized changes remain staged for review. Inspect them
with `git status --short`, `git diff --cached --name-status`, and
`git diff --cached --check`. Do not rerun the publisher until the clone is
clean. If the `main` workflow fails after the push, the script does not create
the tag; correct the problem and publish the tag manually only after the exact
replacement commit passes. Never move or force-push a published version tag.
The complete recovery and manual command sequence is in [GITHUB.md](../GITHUB.md).

After a successful release, verify that:

- `ghcr.io/nunesg130-boop/helmsman:<version>` contains Linux AMD64 and ARM64 manifests;
- the GitHub Release is stable for v1.3.1;
- `compose.yaml`, `container.env.example`, and `SHA256SUMS` are attached;
- both downloaded deployment files contain the same
  `ghcr.io/nunesg130-boop/helmsman@sha256:...` manifest reference and no source
  placeholder; and
- `sha256sum -c SHA256SUMS` succeeds beside the two downloaded deployment files.

Publishing and deployment deliberately remain separate. By default, the
publisher never connects to a deployment host, changes an installation, or
restarts a service. If a maintainer supplies all three optional
`-DeploymentHost`, `-DeploymentUser`, and `-DeploymentRoot` values, it prints
matching Windows `ssh`/`scp` transfer commands and a server command block only
after the assets are downloaded and verified; it still does not execute those
commands. The operator runs them manually during the chosen deployment window.
If a backup for that version
already exists, the block stops before mutation so it cannot erase the original
rollback point; inspect or resume that attempt manually. The server block rechecks the
transferred checksum file, backs up Compose and `.env`, atomically preserves the
existing environment while canonicalizing only `HELMSMAN_IMAGE`, installs the
verified Compose file, unsets shell image and Compose-selector overrides, fixes
the Compose file/env inputs, and refuses to deploy
unless the resolved image exactly matches the verified release digest. This
boundary keeps a successful GitHub release from automatically replacing a
healthy server container. See [GITHUB.md](../GITHUB.md) for the transfer shape,
server sequence, and two-file rollback.

New GHCR packages are private unless their visibility is changed. Keep the
package private for authenticated pulls, or change the package—not merely the
repository—to public to permit anonymous `docker compose pull`. Treat the
public visibility change as a deliberate publication decision.

## Build from source

The production `compose.yaml` intentionally has no `build:` section. Developers with a source checkout can add the local build definition without changing the production file:

```sh
docker compose -f compose.yaml -f compose.dev.yaml build --pull
docker compose -f compose.yaml -f compose.dev.yaml up -d
docker compose -f compose.yaml -f compose.dev.yaml logs --tail=100 helmsman
```

Use that same pair of Compose files for later source-build lifecycle and recovery commands. Do not distribute `compose.dev.yaml` as the normal server deployment path.
