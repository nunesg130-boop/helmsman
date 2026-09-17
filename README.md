# Helmsman v1.0.5

Helmsman is a self-hosted operations center for a homelab's media services and infrastructure. It runs as one portable Linux container on Docker Desktop, Linux, macOS, compatible NAS platforms, AMD64, and ARM64.

[Releases](https://github.com/nunesg130-boop/helmsman/releases) · [Container package](https://github.com/users/nunesg130-boop/packages/container/package/helmsman) · [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md)

> [!WARNING]
> Back up the `/data` volume before every update and use the newest published
> release. Helmsman is a single-instance application owned by one exact
> Jellyfin administrator; it has no separate Helmsman accounts, roles, or audit
> attribution. Do not scale multiple containers against one data volume, and
> use a trusted HTTPS edge for remote browser access.

This Helmsman is the media and infrastructure dashboard in this repository. It
is not affiliated with or derived from the existing Kubernetes project also
named [Helmsman](https://github.com/mkubaczyk/helmsman).

## v1.0.5

This interface maintenance release centers and simplifies Jellyfin sign-in,
separates browser-to-service connection health from upstream application
health in the shared Media advisory, aligns shared panel actions and inventory
counts, and applies Infrastructure hover feedback to each complete target
card. Monitor summary updates now patch their existing DOM in place while
preserving the active workspace and accessible status labeling.

## v1.0.4

This maintenance release hardens Discovery and drawer-based Seerr season
requests. Helmsman now accepts Seerr's documented `201 Created`
acknowledgement when optional echoed relations are absent or filtered, warns
when Seerr reports no TVDB mapping for Sonarr routing, explains unreadable
gateway failures, and treats every mutation HTTP 5xx as an uncertain outcome
that must be refreshed before another write is allowed.

## License and project identity

Helmsman's project-owned source code is licensed under the
[GNU Affero General Public License v3.0 only](LICENSE). If you modify Helmsman
and let users interact with that modified version over a network, review
section 13's Corresponding Source requirement. This summary does not replace
the license text.

The Helmsman name and helmet logo identify this project. The AGPL is a
copyright license and does not grant trademark rights. Service names identify
compatible products; their names and trademarks remain the property of their
respective owners. Helmsman bundles reviewed, hash-pinned local icons only to
identify the nine supported service integrations, plus original generic
VM/container workload drawings. See
[the asset notices](assets/services/THIRD_PARTY_NOTICES.md).

Helmsman v1.0.5 combines Portainer monitoring and a small, fixed set of confirmed recovery actions under Infrastructure with targeted media recovery actions and Helmsman's cluster-aware Proxmox model:

- Media and Infrastructure are separate workspaces inside the same authenticated application, and only the selected workspace's navigation is shown;
- the desktop sidebar collapses to an icon rail, remembers that preference, keeps its navigation scrollable at high browser zoom, and places its 44 px collapse control on the content-side edge below the shared header rule;
- Infrastructure **Overview** contains only already-configured Proxmox and Portainer connections plus their current read-only signals, while the always-available categorized **Connectors** view owns supported-provider discovery, setup, and editing;
- the Media workspace has dedicated **Home**, **Discover**, **Library**, **Requests**, **Activity**, **Calendar**, **Health**, and **Connections** views;
- Media **Connections** groups every supported integration by purpose: media server, requests, media management, indexers, download clients, and subtitles;
- Jellyfin, Seerr, Radarr, Sonarr, qBittorrent, and Bazarr records are correlated by TMDb, TVDb, IMDb, download, and service identifiers rather than title matching;
- Home combines current Jellyfin playback, continue-watching items, pending requests, active downloads, blocked imports, upcoming releases, recently added titles, missing media, and subtitle backlog; episode resumes use their series poster rather than an episode frame, and short poster rails retain the same bounded card size as full rails;
- Activity combines qBittorrent transfer progress, speed, and ETA with Sonarr/Radarr queue and import state, including the current bounded service-reported error when one is available;
- Requests keep Seerr approval separate from acquisition state, use exact **Awaiting approval**, **In progress**, **Available**, **Needs attention**, and **Closed** buckets, preserve the exact season/4K scope, and never treat older episodes from the same series as proof that a new request is available;
- request rows missing presentation metadata are enriched through Seerr's fixed movie/TV detail routes with revision-scoped caching and a fair three-worker background queue; the short dashboard wait no longer cancels slow TV lookups, and visible unresolved rows can resolve their cover through the same typed route on demand;
- series and parent-resolved episode drawers load current season state on demand, warn when Seerr reports no TVDB mapping for an auto-approved Sonarr handoff, and can submit one confirmed, standard-quality Seerr request for the exact selected requestable seasons;
- normalized media detail retains the read-only lifecycle **Requested → Monitored → Downloading → Imported → Available** only when those stages are actually observed;
- artwork is served only through an authenticated opaque Helmsman URL, uses revisioned 342 px Jellyfin/Seerr thumbnails and fixed 250 px, 500 px, then original Radarr/Sonarr covers, safely resolves Sonarr's TV metadata through a typed Seerr lookup when its local cover is unavailable, coalesces duplicate misses, and bounds cold artwork to three concurrent upstream fetches with 64 queued requests;
- unreleased Radarr movies remain **Upcoming** and are not counted as missing, Sonarr calendar episodes inherit their parent-series poster, and calendar-only episode rows are excluded from Library;
- unchanged artwork keeps a stable browser URL with a one-day private cache, while image revisions produce a new opaque URL, cold proxy fetches receive an eight-second artwork-only budget, and temporary failures receive two bounded browser retries without cache-busting;
- reviewed, hash-pinned icons for all nine supported service integrations are bundled locally without a runtime icon CDN, while original generic VM and container SVGs identify workloads;
- media monitoring remains read-only by default; the only media writes are a Seerr failed-request retry, a selected standard-season request for one exact current series through Seerr, a targeted Radarr/Sonarr search when Helmsman can resolve one exact current record, and a fixed blocked-queue recovery for one exact current errored Sonarr/Radarr queue item, and each opens Helmsman's own confirmation dialog before it runs;
- each standalone Proxmox server or multi-node cluster is one environment, separate from its physical nodes and VM/LXC workloads;
- **Connect and discover** verifies authentication, certificate trust, environment identity, cluster name, and visible nodes before an environment can be saved;
- an environment can have up to four explicitly approved API endpoints, each with its own URL, TLS trust, encrypted API token, and availability state;
- cluster-wide inventory is collected once per monitoring cycle through one healthy endpoint, so nodes, workloads, storage, tasks, backups, and incidents are not duplicated;
- endpoint reachability and actual Proxmox node health remain separate—loss of one endpoint can make an environment Limited while another endpoint keeps its inventory available;
- one dedicated **Proxmox** view combines environments, physical nodes, and node-scoped storage capacity; **Workloads** remains a focused VM/LXC inventory view;
- stopped guests remain informational and do not make an environment unhealthy;
- Portainer servers are configured and monitored only in Infrastructure, independently from media connections and Proxmox environments;
- each Portainer connection verifies its API version and authenticated user, then reads bounded environment, stack, and Docker/Podman container inventories through fixed routes;
- the Portainer inventory groups containers by server and environment, keeps identity, stack, runtime, unique reported ports, and controls visually separate, marks internal-only ports explicitly, and adapts from compact desktop rows to mobile cards without a wide table;
- stopped Portainer containers remain informational, while unreachable environments and genuinely unhealthy, dead, or restarting containers report their specific failure;
- infrastructure monitoring remains read-only; controls are limited to Portainer container start, restart, and graceful stop plus Proxmox QEMU/LXC start, reboot, and graceful shutdown, and every command uses Helmsman's accessible in-app confirmation instead of a browser-native prompt;
- Helmsman has no delete, remove, force-stop, reset, kill, migration, backup, restore, reconfiguration, bulk-action, shell, SSH, console, Docker-socket, or host-mount capability;
- container-side checks continue when every browser is closed;
- repeated failures become deduplicated incidents after two matching results, with aligned open and recovered panels;
- the top assessment summary opens Media Health or Infrastructure Incidents for the active workspace;
- service, capability, and end-to-end pipeline health are shown separately;
- queue, request, download, import, schedule, missing-media, and subtitle-backlog views are derived without writing a media catalog or artwork cache to disk;
- current structured health reports from supported service APIs can be shown only to authenticated browsers after bounding, redaction, and escaping;
- the supplied Helmsman helmet is the sidebar, mobile, browser, and installable-app identity, and the interface uses its charcoal, slate, and muted sea-green palette in a hard-framed retro-web control-room treatment;
- credentials are encrypted in the container and are write-only through the interface;
- private-network access defaults to exact per-connection host approvals, with manual CIDR ranges available as an advanced boundary;
- the exact enrolled Jellyfin administrator signs in with a username and password to receive a revocable, 30-day, origin-bound HttpOnly session; passwords and internal Jellyfin identity IDs never reach browser storage, and each resulting Jellyfin token is encrypted server-side per session;
- Caddy, Authentik, and any other compatible HTTPS/MFA edge remain optional and do not replace credentials for the upstream systems.

## Deploy the published container

Helmsman is distributed as the public Linux AMD64/ARM64 image `ghcr.io/nunesg130-boop/helmsman`. The `v1.0.5` Git tag runs the contracts and architecture smoke tests, publishes the version, `latest`, and full-commit image tags, and creates a GitHub Release containing ready-to-use `compose.yaml`, `container.env.example`, and `SHA256SUMS` assets. The release deployment files pin `ghcr.io/nunesg130-boop/helmsman` to the exact multi-architecture manifest digest (`@sha256:...`).

Download those three files from the matching [GitHub Release](https://github.com/nunesg130-boop/helmsman/releases) into one directory, verify the two deployment files against `SHA256SUMS`, open a terminal there, and make sure Docker Desktop or Docker Engine is running. No source checkout, Dockerfile, Node.js installation, or server-side image build is required.

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
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

Linux or macOS:

```sh
sha256sum --strict --check SHA256SUMS
cp container.env.example .env
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

The canonical GHCR package is public, so Docker pulls it anonymously. A private
fork may require its own registry authentication; never place a registry token
in `.env`, Compose YAML, the repository, or shell history. Repository and GHCR
package visibility are separate GitHub settings.

On the Docker host, open `http://127.0.0.1:4180`. From another computer,
keep the default loopback bind and create an SSH tunnel first:

```sh
ssh -L 4180:127.0.0.1:4180 user@your-helmsman-host
```

Then open `http://127.0.0.1:4180` locally. For permanent remote access, put
Helmsman behind a trusted HTTPS reverse proxy and firewall the inner port to
that proxy; the first claim is rejected over untrusted remote HTTP. Paste the
newest one-time setup token from the container log and complete the claim to
open the setup session; Helmsman derives the browser name automatically. Add
and verify the Jellyfin connection under Media **Connections**, then enroll its
exact administrator under Settings by entering only the Jellyfin username and
password. Helmsman
obtains the stable server and user IDs itself and never asks for or displays
them. Subsequent browsers sign in with that same Jellyfin account and receive
their own 30-day HttpOnly sessions. The default **Exact service addresses** network mode
needs no CIDR list: when you register a private media service, Proxmox endpoint,
or Portainer server, Helmsman stores only its currently resolved safe private
addresses as `/32` or `/128` approvals for that connection. Manual private
CIDRs remain available as an advanced, intentionally broader registration
boundary. Service and endpoint URLs and credentials are entered in the
interface, not `.env`.

If Docker reports that `dockerDesktopLinuxEngine` or its named pipe cannot be found, start Docker Desktop, wait until it says the engine is running, select Linux containers, and run the commands again.

The guarded future-release workflow is in [GITHUB.md](GITHUB.md). Detailed installation, update, rollback, source-build, and release instructions are in [deploy/DOCKER.md](deploy/DOCKER.md).

## Maintainers: publish future versions

This section is for maintainers of the canonical repository, not for normal
installation. Operators should use the signed, checksum-listed release assets
above.

Use local source builds while a version is still experimental, then publish
each version that is intended for a deployment host. The same launcher works
for every future prerelease or stable version and on any Windows computer; it
does not contain a release-number-specific path or command.

Every full source archive includes `Publish-Helmsman.cmd` and
`Publish-Helmsman.ps1` at its root. Extract the archive, then double-click
`Publish-Helmsman.cmd`. The launcher detects the release version from that
source's `package.json` and uses it for the entire publication. To start it
from PowerShell instead:

```powershell
Set-Location "C:\path\to\the\extracted\helmsman"
.\Publish-Helmsman.ps1
```

Do not manually copy release files into `helmsman-github`; the launcher safely
prepares and synchronizes the selected source for you.

On a new computer the launcher checks or installs Git, requires GitHub CLI
2.57.0 or newer, opens the GitHub sign-in when necessary, verifies the exact active account, confirms write
access to the canonical `nunesg130-boop/helmsman` repository, and requires both
the `repo` and `workflow` permissions. It then verifies noninteractive HTTPS
Git access and rejects SSH or Git URL rewrites before creating or validating
the persistent `%USERPROFILE%\Downloads\helmsman-github` clone and configuring
the repository-local Git author. If that managed clone is incomplete, dirty, on a
different branch, uses a noncanonical remote, or contains the clean unpublished
commit from an interrupted release, the launcher preserves it and uses
`%USERPROFILE%\Downloads\helmsman-github-recovery` as the persistent clone.
An incompatible occupied recovery path is also preserved; the launcher safely
advances to `helmsman-github-recovery-2`, then a bounded numeric suffix when
necessary. A verified clean HTTPS recovery clone is reused on later
runs. Extract the complete release with Windows before
starting the publisher. Prefer a normal local folder such as
`C:\Helmsman-Releases`; if OneDrive marks the extracted tree as a cloud
placeholder or reparse point, move or re-extract it there. A standalone
launcher copy kept outside both the source and persistent clone prompts for
that extracted release folder. You may
select either the outer version folder that contains `helmsman` or the inner
`helmsman` source folder itself. From PowerShell, `-SourcePath` accepts either
folder form as well. Do not run the root launcher from `helmsman-github`: it
intentionally refuses the publishing clone so it cannot overwrite itself. It
safely prepares the source before publishing and never copies credentials,
`.env`, or runtime state into the repository.

The launcher verifies the extracted release's guarded publisher against its
bound SHA-256 identity, then gives it the validated source and independently
verified clean clone. That publisher performs static source validation, stages
the source, shows the review summary, and asks once for the exact
`PUBLISH <detected-version>` confirmation. After confirmation it pushes
`main`, requires the workflow for that exact commit to pass, publishes the
version tag, requires the tag workflow to pass, and verifies the GitHub Release
assets. It downloads the verified digest-pinned `compose.yaml`,
`container.env.example`, and `SHA256SUMS` into a new local deployment-assets
directory beside the source folder.

The publisher deliberately does not execute candidate source while maintainer
GitHub credentials are available. The mandatory hosted `main` and version-tag
workflows run the release tests in GitHub Actions before the publisher advances
to the next boundary.

Three prompts remain intentionally human-controlled:

- Windows installation or UAC approval if Git or GitHub CLI is missing;
- browser-based GitHub authentication once on each computer, and again if the
  saved authorization expires; and
- the exact `PUBLISH <detected-version>` release confirmation.

The launcher is part of the full source tree and source archive. It is not an
additional GitHub Release deployment asset; releases continue to publish the
same three digest-verified deployment files.

It never logs into or changes a deployment host. After publication it only
prints the PowerShell `scp` commands and manual `/opt/helmsman` update block.
That block verifies the transferred checksums, backs up both Compose and the
existing `.env`, installs the verified digest-pinned Compose file, preserves
all existing `.env` settings except canonicalizing `HELMSMAN_IMAGE`, creates a
mode-`0600` `.env` from the verified example when none exists, unsets shell
image and Compose-selector overrides, fixes the Compose file/env inputs, and
refuses to deploy unless Compose resolves the exact verified digest. Rollback restores both
Compose and `.env`. Cancellation before
the commit leaves the reviewed changes staged and makes no GitHub change; see
[GITHUB.md](GITHUB.md) for inspection, recovery, transfer commands, and the
advanced manual publisher fallback.

## Privacy and storage

There is no vendor cloud, hosted account, telemetry, analytics, advertising, tracking pixel, remote font, or runtime CDN dependency. The local container is technically a backend, but it belongs entirely to the operator and makes no outbound request except to explicitly registered media-service and infrastructure APIs.

| Location | Stored data |
|---|---|
| Browser | A revocable, 30-day, origin-bound HttpOnly session cookie, a per-session CSRF value, and non-secret presentation state; never the Jellyfin password or token |
| `/data/state.json` | Instance, network policy, media connections, Proxmox environments and endpoints, Portainer service records, discovered identities, exact URLs, and per-connection private-host approvals |
| `/data/sessions.json` | The enrolled owner's bounded Jellyfin identity binding and browser-session hashes, authenticated with the credential master key; never the password or bearer token. A beta.2 access-key verifier can exist only until owner enrollment finishes |
| `/data/credentials.json` | AES-256-GCM ciphertext and authenticated metadata, including destination-bound connector credentials and separate per-session Jellyfin login tokens |
| `/data/credentials.key` | Auto-generated local encryption key, unless the environment-sourced Docker secret is enabled |
| In-memory operations snapshot | Bounded normalized media records, current activity, states, safe codes, latency, counters, incidents, and recent transitions; never raw responses |

Saved credentials cannot be read back through the API. Each credential is bound to its connection's exact canonical destination; changing that URL requires a fresh credential, and offline URL tampering cannot redirect the old one. Replacing a credential overwrites it; removing a connection removes its encrypted credential. Proxmox token IDs and token secrets and Portainer access tokens are write-only just like media credentials. The monitor parses every response at a strict boundary and discards raw response bodies, headers, usernames, URLs, credentials, and unbounded error text. The authenticated UI receives only the normalized media fields needed for the desktop workflow, including bounded titles, provider identifiers, current states, progress, dates, and sanitized queue errors. Jellyfin Now Playing reads only the bounded current media item and play state; user, device, client, network, and stream-session metadata are discarded. These records and the bounded artwork cache remain in memory and are not added to `state.json`.

An authenticated browser may also receive the current live health reports built only from allowlisted `source`, `type`, and `message` fields in supported structured service health responses. Helmsman bounds their count and length, normalizes and redacts secret-like values, and the interface escapes them again before display. These reports are transient evidence in the current operations snapshot only: they are never copied into incidents, events, history, application logs, or persistent files. Raw response bodies and raw error bodies are never exposed. Service-authored reports can still contain non-secret operational details such as paths or hostnames, so treat access to the authenticated interface as sensitive.

The easy local mode keeps its generated encryption key beside ciphertext in the protected Docker volume. That protects against accidental disclosure and ciphertext-only copies, but it is not a separate trust boundary if an attacker steals the entire volume or controls the host. For encrypted backups or external deployments, use the optional Docker-secret key described below.

Protect backup history like the live volume. Authorization-state integrity detects forged edits but is not a hardware-backed monotonic counter, so replaying an older complete, valid backup rolls access state back to that snapshot. After intentionally restoring a backup that predates an owner or browser-access change, run `reset-access --confirm` and enroll the intended owner again.

## Security boundary

Helmsman is not a general-purpose proxy. Every outbound request must pass all of these checks:

- the media service, Proxmox endpoint, or Portainer server has an exact registered destination;
- the connector allows that exact method, API path, query shape, and, for an action, fixed request-body template;
- in the default mode, every current private A and AAAA result matches the connection's saved exact `/32` or `/128` approvals; manual CIDRs can instead authorize a deliberately broader private range;
- loopback, link-local/cloud metadata, multicast, unspecified, reserved, broadcast, and mixed-policy DNS results are always rejected, regardless of mode;
- public HTTP is always rejected; public HTTPS requires the operator to enable it explicitly;
- the outbound socket is pinned to a validated address while preserving the TLS hostname;
- redirects, HTML API responses, unsupported content types, oversized bodies, excessive concurrency, and timeouts fail closed;
- browser mutations require an origin-bound HttpOnly session plus a per-session CSRF value.

The image runs as UID/GID 10001 with a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, bounded memory/PIDs/CPU, no Docker socket, and no host network. The fixed action routes use only saved upstream API credentials and do not grant Helmsman SSH, a shell, a hypervisor console, a generic Docker API, or host-filesystem access.

Monitoring and probes remain fixed read-only GET routes. Actions are separate requests built from fixed method, path, query, and body templates and gated by an accessible Helmsman confirmation dialog. The target and current revision are checked again after approval before dispatch. The browser selects only a supported action and a current normalized record; it cannot supply an arbitrary upstream path or request body. Helmsman exposes no general media-service, Proxmox, Portainer, or Docker API proxy and no generic delete, remove, force-stop, reset, kill, or bulk action. Its sole removal path is the exact confirmed blocked-queue recovery described below.

## Media and Infrastructure workspaces

Use the workspace switcher to keep media activity separate from host, virtualization, and container-platform health. Media navigation contains **Home**, **Discover**, **Library**, **Requests**, **Activity**, **Calendar**, **Health**, and **Connections**. Logs and Settings remain global. Search and filters operate only on the bounded records already returned by configured services; Helmsman does not send free-form discovery searches or arbitrary management commands upstream.

Home keeps existing data visible while a refresh is in flight and patches volatile progress, speed, ETA, state, counts, and timestamps in place. Its Now Playing signal comes from one fixed, bounded Jellyfin sessions query and omits session identity metadata. Initial loads may use placeholders, but polling does not deliberately replace the whole page or reset stable artwork URLs. Discover presents Seerr's read-only discovery feed; items without a request are labeled **Not requested** rather than exposing an internal unknown state, and only Jellyfin evidence can label a title available in Helmsman's library. Library correlates Jellyfin availability with Radarr/Sonarr monitoring and import state. Requests preserve separate request IDs, approval state, acquisition state, requested seasons, and 4K scope; completed workflow rows become **Available** from Seerr's media availability, an exact Jellyfin movie match, or—when a series request is season-scoped—the matching Seerr media-season availability rather than the request-season workflow status. Activity and Calendar expose current read-only workflow state, while Health contains pipeline/service incidents and Connections owns service enrollment.

The only Media writes are a Helmsman-confirmed Seerr failed-request retry, a selected standard-season request for one exact current series through Seerr, a targeted Radarr/Sonarr search when Helmsman can resolve one exact current record, and **Block release & search again** for one exact current errored Sonarr/Radarr queue item. The blocked-queue action warns that it removes the download and its data from the download client, blocklists that release, and allows Sonarr/Radarr to seek a replacement according to its settings. It appears only from fresh, connected, revision-matched error evidence and is revalidated after its explicit danger confirmation. Series and parent-resolved episode drawers load a bounded current season catalog from Seerr on demand. The operator can select requestable standard seasons, review the exact selection in Helmsman's confirmation dialog, and submit one standard-quality request. Specials, 4K selection, arbitrary Seerr users, servers, profiles, root folders, and request bodies are not exposed. Helmsman revalidates the current record, target revision, and action-specific detail immediately before dispatch. Each action uses a Helmsman-styled confirmation dialog; browser-native confirmation prompts are not used. Helmsman cannot approve requests or delete requests, request movies or 4K/Specials, choose Seerr routing/profile fields, change monitoring, pause downloads, remove healthy or arbitrary downloads, alter any other files, or run a free-form search.

Each media record uses provider and service identifiers to join evidence from multiple systems. Its lifecycle indicates which of Requested, Monitored, Downloading, Imported, and Available have been observed. qBittorrent transfers are correlated to Sonarr/Radarr queue rows by download identifiers; a bounded sanitized queue error is displayed when the service supplies one. Titles, identifiers, progress, and errors exist only in the current in-memory snapshot.

Artwork descriptors never reach the browser. The browser receives an opaque same-origin `/api/v2/media/artwork/<key>` URL, and the authenticated broker tries only fixed service-owned artwork routes in this order: Jellyfin, Radarr/Sonarr, then Seerr. Grid requests use a revisioned 342 px Jellyfin or Seerr thumbnail and try fixed 250 px, 500 px, then original Radarr/Sonarr covers. When Sonarr exposes only TVDB remote artwork, Helmsman uses the series' validated TMDb identifier for a typed Seerr metadata lookup and then requests only Seerr's fixed TMDb image-proxy route; it never follows the remote artwork URL. Duplicate misses are coalesced, and a bounded scheduler permits at most three upstream artwork fetches at once with 64 pending requests. Successful images are cached in memory for up to 24 hours. General failures are cached for 15 minutes, versioned Arr cover misses for 30 seconds, and unrevisioned Arr misses are not negative-cached, allowing newly generated covers to appear promptly without continuous retry. The cache is limited to 512 entries, 64 MiB total, and 4 MiB per accepted image, and accepts only bounded raster image types. Browser responses use an ETag, a one-day private cache lifetime, and one-week stale revalidation/error windows; media artwork is never written to the data volume.

Infrastructure navigation contains **Overview**, **Connectors**, **Proxmox**, **Workloads**, **Portainer**, and **Incidents**. Overview shows only connections that are already configured and their current read-only status; the always-available categorized Connectors view lists every supported provider and owns setup and connection editing. Proxmox and Workloads appear only after a Proxmox environment is configured, while Portainer appears only after a Portainer connection is configured. Helmsman supports up to 25 Proxmox environments and 25 total endpoints, with no more than four endpoints in one environment. An environment is either a standalone server or one multi-node cluster. The combined Proxmox view presents environments, nodes, and a dedicated storage section with current sanitized status and capacity information.

To add Proxmox, open **Infrastructure → Connectors**, select **Proxmox VE**, and enter:

- a display name;
- the full HTTPS URL reachable from inside the container, normally `https://host-or-ip:8006`;
- **System trust** for a publicly or privately trusted certificate, or **Pinned SHA-256 fingerprint** for a self-signed/local certificate;
- the full API token ID and generated token secret;
- whether the environment should be monitored continuously.

There is no insecure “ignore certificate errors” mode. A pinned fingerprint authorizes only that exact certificate and must be reviewed after a legitimate certificate replacement. **Discover environment** checks the endpoint without saving it, identifies it as standalone or clustered, and lists the visible nodes for confirmation. Helmsman refuses to save a connection whose identity cannot be established. Changing the URL, TLS identity, token, or discovered environment requires a fresh successful discovery.

For a self-signed certificate, run `pvenode cert info` directly on the Proxmox host console and copy the SHA-256 fingerprint for the certificate served by `pveproxy`. Verify it through that trusted console; do not accept a fingerprint learned only through the same network connection you are enrolling.

After saving an environment, additional cluster-node endpoints can be registered as failover paths. Every alternate URL, certificate trust choice, and token must be entered and verified explicitly. The endpoint must report the same stable cluster or standalone identity as the environment; discovered IP addresses are never trusted automatically. Helmsman does not automatically combine existing configurations, even if they later appear to describe the same cluster.

Each monitoring cycle tests endpoint availability, selects one healthy matching endpoint, and collects the cluster-wide inventory once. The snapshot contains a bounded node, VM/LXC, storage, recent-task, and recent-backup inventory alongside derived health metrics and sanitized reports. Recent tasks and backup history are collected through each visible node's fixed read-only task route, then merged once with node identity retained; raw UPIDs, command-bearing status text, and raw Proxmox responses are not exposed. If one API certificate or route fails but the cluster remains queryable through another approved endpoint, the failed endpoint is shown as unavailable while the actual node state continues to come from the cluster inventory; the environment is Limited rather than Down. A confirmed workload action can start, reboot, or gracefully shut down one current QEMU VM or LXC through the selected environment's fixed API route. Node, storage, backup, migration, restore, configuration, console, and forced power operations are not available.

### Portainer under Infrastructure

Portainer is a separate Infrastructure service, not a Media connection. Open **Infrastructure → Connectors**, select **Portainer**, and register up to eight independent servers. After the first connection is saved, the dedicated Portainer inventory view becomes available in the sidebar. For each server, enter:

- a display name;
- its full HTTPS base URL, normally `https://host-or-ip:9443`;
- **System trust** for a publicly or privately trusted certificate, or **Pinned SHA-256 fingerprint** for a self-signed/local certificate;
- a durable Portainer access token; and
- whether continuous monitoring is enabled.

Helmsman sends the token in Portainer's `X-API-Key` request header and never returns it to the browser. The connection test verifies the Portainer status API and the token with the authenticated-user endpoint before anything is saved. Portainer 3.x is detected through `/api/system/status`; Helmsman falls back to the legacy `/api/status` route only when the newer route returns HTTP 404.

Monitoring uses fixed read-only GET routes for environments, stacks, and Docker-compatible container inventories. Helmsman can list multiple Docker or Podman environments behind one Portainer server; Kubernetes and Azure environments can appear in the environment inventory but are not queried through the Docker container route. Containers are grouped by server and environment in responsive rows that keep identity, stack, runtime, deduplicated port chips, and actions separate; a private-only port is labeled internal instead of being presented as published. The normalized snapshot discards endpoint addresses, credentials, raw labels, raw stack definitions, and raw responses. A confirmed action may start, restart, or gracefully stop one current Docker-compatible container. There is no general Portainer or Docker API proxy, and Helmsman never mounts the Docker socket.

The Portainer page reports online/offline environments, running/stopped/restarting/unhealthy container counts, stacks, and bounded per-environment errors. A deliberately stopped container is informational and does not degrade health. Each server probe has a 45-second monitoring deadline and leaves request capacity available for the rest of Helmsman; if it expires, completed data remains visible and `PORTAINER_INVENTORY_PARTIAL` explains that unfinished coverage will be retried next cycle. Portainer access tokens inherit the permissions of their Portainer user, so create a dedicated least-privilege Portainer user or team limited to the visible environments and the required container lifecycle actions; do not reuse an administrator token.

## Credentials

Use dedicated, least-privilege credentials where the service supports them:

| Service | Helmsman credential |
|---|---|
| Jellyfin | Dashboard API key, user access token, or one-time username/password exchange |
| Seerr | Global API key, or one-time local account email/password exchange |
| Radarr, Sonarr, Prowlarr, Bazarr | API key |
| qBittorrent | `qbt_` API key from qBittorrent 5.2 or newer |
| Proxmox VE | Dedicated API token ID and token secret scoped to inventory plus the selected guest power actions |
| Portainer | Durable access token for a dedicated user scoped to visible environments and allowed container lifecycle actions, sent as `X-API-Key` |

Passwords are not retained. The Jellyfin credential saved with the Media connection is the monitoring connector credential: enter a Dashboard API key or existing user access token directly, or let Helmsman exchange a username and password once. Browser authentication is deliberately separate. The enrolled Jellyfin administrator enters a username and password for each new browser session; Helmsman discards the password immediately and encrypts the resulting user token server-side for only that session. It never substitutes the monitoring connector credential for the owner login. For Seerr, enter the global API key from Settings > General, or use a native local account email and password for a one-time exchange; Seerr local authentication must be enabled, and Helmsman discards the password and encrypts only the resulting session. Older qBittorrent password/SID mode is deliberately not used for unattended monitoring.

For Proxmox, create a dedicated user and API token with only the inventory privileges needed for the selected resources plus `VM.PowerMgmt` on the specific guests or pool Helmsman may control. Enter the complete token ID in the form `user@realm!token-name` and its generated secret. Helmsman encrypts both fields and never returns either value to the browser. Each approved endpoint keeps destination-bound encrypted credentials, so one endpoint cannot silently reuse another endpoint's credential against a changed host. Do not use `root@pam`, a password, a root API token, or an administrator token, and do not grant power-management privileges outside the intended guests. Proxmox environments are configured in the Infrastructure workspace; do not place their URLs or credentials in `.env`.

For Portainer, generate an access token for a dedicated user whose visible environments and container lifecycle permissions are limited to what Helmsman should monitor and control. Enter the token once in the Portainer connection form; Helmsman encrypts it, binds it to that server's exact destination and TLS identity, and exposes only whether a credential is configured. Do not place the Portainer URL or token in `.env`. Portainer access tokens inherit their user's permissions; Helmsman's fixed monitoring and action routes reduce its own request surface but cannot make an overprivileged Portainer account least-privilege.

## Browser access and recovery

Fresh setup uses the one-time setup token only to claim the instance and open the setup session. Configure and verify one Jellyfin connection, then use Settings to enroll its exact enabled administrator with a username and password. Helmsman learns and binds the stable Jellyfin server ID and user ID internally; neither ID is requested from or displayed to the operator. Another Jellyfin user—including another administrator—cannot sign in as the Helmsman owner.

Every subsequent browser shows only Jellyfin username and password fields. The unauthenticated status and login screen do not disclose the enrolled username. A successful login creates a revocable 30-day session bound to the exact scheme, host, and port. The browser receives an HttpOnly, `SameSite=Strict` session cookie and a per-session CSRF value, never the Jellyfin token. Helmsman immediately discards the submitted password and stores the resulting Jellyfin access token as server-side AES-256-GCM ciphertext scoped to that session. The ciphertext authentication data binds the token to the browser-cookie verifier and immutable session claims as well as the exact Jellyfin URL, target revision, approved address pins, and network policy. The owner binding and authorization-critical session index are also authenticated with a key derived from the credential master key, so offline edits fail closed. A changed Jellyfin authorization boundary atomically revokes every browser session locally before any old token can be decrypted or sent elsewhere; the initiating browser returns to sign-in. Logout or ordinary session revocation erases that token and makes a best-effort Jellyfin logout request only when the original boundary remains current.

Helmsman forwards that one-time username/password exchange to the configured Jellyfin URL. Prefer Jellyfin HTTPS. A private `http://` Jellyfin URL remains supported for common homelab deployments, but it does not encrypt the password on the Docker/LAN hop; use it only when every host and network segment on that path is trusted.

The configured Jellyfin connection is required for enrollment, login, and identity validation, but its monitoring credential stays distinct from every browser-authentication token. Helmsman periodically validates the exact owner and requires the account to remain enabled and administrative. Explicit rejection, revocation, identity mismatch, disablement, or administrator demotion revokes the local session. When Jellyfin is unreachable, new logins fail; a recently validated session may retain bounded read-only access during a transient outage, while state-changing actions require fresh validation and fail closed.

Authentik remains an optional external identity and MFA layer. Jellyfin's username/password exchange itself does not perform an Authentik challenge, so externally reachable deployments should keep Authentik or an equivalent MFA-capable edge in front of every Helmsman path and prevent direct access to port 4180.

Recovery must use the same Compose file stack that owns the running installation. If an optional override was used to deploy, add it to **every** `stop`, `run`, `up`, and `logs` command below:

| Installation | Compose command prefix |
|---|---|
| Fresh local install | `docker compose` |
| Upgrade using the v0.5 volume | `docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml` |
| Fresh install with external key | `docker compose -f compose.yaml -f deploy/compose.hardened.yaml` |
| v0.5 volume and external key | `docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml` |

For either hardened row, export the same `HELMSMAN_MASTER_KEY` before running any command and unset it afterward. Substituting a different key cannot recover the stored credentials.

If the enrolled Jellyfin owner can no longer authenticate and no browser session can repair the connection or enrollment, reset browser access from the Docker host:

```sh
docker compose stop helmsman
docker compose run --rm --no-deps helmsman reset-access --confirm
docker compose up -d
```

This is the sole break-glass path. It removes the owner binding, revokes every Helmsman browser session, and destroys Helmsman's encrypted copies of the browser-authentication tokens while preserving service URLs, the instance and network policy, registered targets, and encrypted monitoring credentials. Because this recovery command runs with the broker stopped, it cannot send Jellyfin logout requests; if a token may have been copied outside Helmsman's encrypted store, use Jellyfin's administration controls to invalidate that upstream session too. The next start emits a new one-time setup token so the operator can claim the instance and enroll an enabled Jellyfin administrator again. It does not create, print, or restore a reusable access key. The main service must stay stopped while the one-off container writes the shared `/data` volume.

When upgrading from v1.0.0-beta.2, its reusable access key is accepted only as a temporary migration credential. Use an existing browser session or that legacy key to open Settings, make sure the Jellyfin connection is configured, and enroll the owner. Successful enrollment atomically removes the access-key verifier and revokes every legacy browser session; v1.0.5 cannot create, reveal, or rotate another key. If no beta.2 session or key remains usable, use `reset-access --confirm` as described above.

If the credential encryption key is lost or the configured key no longer matches, the ciphertext cannot be recovered. Stop the service and reset the credential store and browser-access seal, using the same command prefix selected above:

```sh
docker compose stop helmsman
docker compose run --rm --no-deps helmsman reset-credentials --confirm
docker compose run --rm --no-deps helmsman reset-access --confirm
docker compose up -d
```

This preserves the instance, network policy, and registered service targets. It moves `credentials.json` and, in easy local mode, `credentials.key` to timestamped `*.unrecoverable-*` quarantine files. Because the same master key authenticates the owner/session authorization state, the required `reset-access` step removes the no-longer-verifiable owner binding and browser sessions; after restart, claim the instance and enroll the Jellyfin owner again. An externally managed master-key file is never modified. For a hardened deployment, export the valid replacement key and retain `-f deploy/compose.hardened.yaml` on every command; otherwise the service could restart in the wrong key mode. Then enter replacement service credentials in the interface and rotate the old credentials at their source. Quarantine files remain sensitive recovery material; keep them private and remove them only after the replacement configuration is verified.

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

Jellyfin-backed browser login does not replace a Cloudflare Tunnel, Caddy, or Authentik deployment. Those layers continue to admit and proxy the browser first; after that, Helmsman authenticates the exact enrolled Jellyfin owner and issues its own origin-bound session. Authentik still owns external MFA, while upstream monitoring continues directly from the container with the separate saved connector credentials.

For external use, publish the container only on an address reachable by the edge, proxy every path unchanged, and firewall port 4180 so clients cannot bypass the HTTPS/Authentik route. Example Caddy configurations are in `deploy/`.

## Upgrade an existing Helmsman installation

Keep the existing Helmsman project directory and Compose file stack so Compose
reuses the current `helmsman-data` volume. Back up that volume, then use the
publisher's printed transfer and server blocks. They reverify the release
assets, back up both `compose.yaml` and the existing `.env`, preserve all
server-specific environment settings while replacing old `HELMSMAN_IMAGE`
assignments with one verified digest, and create `.env` from the verified
example if it was absent. They also unset a shell-level image override and
require Compose to resolve the exact release digest before these lifecycle
commands run:

```sh
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

If the installation uses an override, include it in every command. These commands recreate the application container while preserving `/data`; do not run `docker compose down -v` during an update. Keep one known-good older digest-pinned image reference recorded before upgrading.

The production Compose file fixes the project name as `helmsman`, so fresh deployments consistently use the Docker volume `helmsman_helmsman-data` regardless of directory name. Before upgrading an older beta that was launched under a different Compose project name, run `docker volume ls`; set `COMPOSE_PROJECT_NAME` in `.env` to that previous project prefix before the first new `docker compose up`, or migrate the old volume deliberately. Do not continue with an unexpectedly empty instance.

To roll back application code, restore both
`compose.yaml.before-<version>` and `.env.before-<version>`, or remove the new
`.env` when none existed before the update. Unset `HELMSMAN_IMAGE`, inspect
`docker compose config --images`, and then repeat `docker compose pull` and
`docker compose up -d`. Do not roll an already migrated `/data` volume back
into an older image unless that release explicitly documents schema
compatibility; restore the matching pre-update volume backup instead.

v0.10 advances the state schema to 4 by adding an empty, bounded Infrastructure-services collection. Existing media connections, destination-bound encrypted credentials, browser sessions, network approvals, and Proxmox environments/endpoints remain in place; nothing is converted into or automatically combined with a Portainer connection. The unified media catalog, artwork cache, and Portainer inventory are rebuilt in memory from current read-only service responses and do not require a data migration. Installations coming directly from an older schema still use the existing in-place migrations, including the rule that separate Proxmox targets are never merged automatically. Back up the volume before upgrading, and do not attempt to run an older image against state after it has been migrated.

For v0.10.0-beta.8 specifically, an existing browser session can be used to configure Jellyfin and enroll the exact administrator under Settings. If no prior session remains usable, run the `reset-access --confirm` sequence under **Browser access and recovery**; it preserves configuration and encrypted monitoring credentials, and the next start supplies a new one-time setup token.

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

The server also accepts legacy `JELLOFIN_COMMAND_*` runtime variables for this transition release, but new deployments should use `HELMSMAN_*`. Do not change or regenerate an external master key during the rename. If you also change the browser-facing hostname, existing sessions will not follow because they are intentionally bound to the exact scheme, host, and port; after confirming the old volume is mounted, sign in on the new origin with the enrolled Jellyfin owner's username and password.

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
