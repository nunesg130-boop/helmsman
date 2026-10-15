# Adding a connector

This guide lists every place a new service touches, so you can add one
without hunting through the code. It uses a media service (one that sits
beside Jellyfin, Seerr, Radarr and the rest) as the example, because that is
the most common request. Infrastructure connectors (Proxmox, Portainer, Loki)
follow the same shape and are noted at the end.

Read [CONTRIBUTING.md](../CONTRIBUTING.md) first. Every connector must keep
Helmsman's boundaries: fixed upstream routes, bounded inputs and responses,
least-privilege credentials, destination validation, redaction, and no
generic proxy or shell.

## Before you start

- Run `npm run demo` and click around. It is the real server with fake
  services, and you will extend it with a fake for your service.
- Pick a lower-case service id, such as `lidarr`. It appears in stored state,
  credential namespaces, routes and the UI, and is hard to change later.
- Find the smallest set of **read-only** upstream endpoints that tell you the
  service is up, authenticated and doing its job. Status, identity and one or
  two health or queue endpoints is usually enough.

## Server

| File | What to add |
|---|---|
| `server/state.mjs` | The id in `SERVICE_IDS`, so stored connections of this type are accepted. |
| `server/launchpad.mjs` | The id in `MEDIA_SERVICE_IDS`. |
| `server/control-plane.mjs` | An entry in `SERVICE_DEFINITIONS`: display name, role, `authMode`, credential field and hints, and `authOptions` if more than one sign-in method is offered. Add credential format checks next to the existing qBittorrent check if the service's keys have a fixed shape. |
| `server/routes.mjs` | The bridge allowlist for the service (exact paths and allowed prefixes), next to the existing entries. Only list what the probes and any actions call. |
| `server/broker.mjs` | `monitorCredentialHeaders()` if the service authenticates with anything other than an `X-Api-Key` header. |
| `server/service-probes.mjs` | A probe plan in `PROBE_PLANS` (id, label, path, response type, importance, size cap, pipeline stage), the auth schema in `SERVICE_AUTH_SCHEMA`, and parsing in `parseSuccessfulCheck()`. Reuse `statusVersion`, `healthMetrics` and the other helpers where the response shape matches. |
| `server/media-model.mjs` | Only if the service contributes titles, requests, downloads or calendar entries: a case in `inventoryFromProbeBody()` and a normalizer that matches items by provider ids (TMDb, TVDB, IMDb), never by title. |
| `server/monitor.mjs` | The display name, and the service id in the right pipeline stage (Search, Downloads, Imports and so on). |

The credential store, network policy, session handling and the action
framework need no changes for a read-only connector.

## Browser

| File | What to add |
|---|---|
| `src/app-v5.js` | The id in `SERVICE_ORDER`, an example address in the placeholder map, the check labels, which check is the primary one, and the connection category it belongs to. |
| `src/ui/operations-views.js` | Name and role, the icon entry, and incident guidance if the service has its own failure modes. |
| `styles.css` | A `.source-<id>` colour for the source dot. |

## Icon and licensing

| File | What to add |
|---|---|
| `assets/services/<id>.svg` or `.png` | The service mark. |
| `assets/services/THIRD_PARTY_NOTICES.md` | Where the mark came from, its licence, and the referential-use statement used for the others. |
| `assets/services/licenses/` | The licence text, if it is not already there. |
| `Dockerfile` and `.dockerignore` | The icon file, so it ships in the image. |
| `scripts/container-contract.mjs`, `scripts/public-release-contract.mjs`, `scripts/publisher-contract.mjs`, `scripts/Publish-HelmsmanRelease.ps1` | The icon's path, size and SHA-256, so release checks know about it. |

Do not add a logo without documenting its source and permitted use.

## Demo and tests

| File | What to add |
|---|---|
| `scripts/demo.mjs` | A fake for the service in `MEDIA` (one function from upstream path to response), its host in `HOSTS`, and an entry in `MEDIA_CONNECTIONS`. `tests/demo.test.mjs` then checks it comes up healthy. |
| `tests/service-probes.test.mjs` | Healthy, degraded, auth-failure and malformed-response cases for each probe. |
| `tests/media-model.test.mjs` | If the service contributes media: that its items merge with the same title from other services by provider id. |
| `tests/network-transport-security.test.mjs` | That the bridge allowlist rejects paths outside it and never forwards browser credentials. |

Run `npm test` before opening a pull request. UI changes that affect layout
also need `npm run check:visual`.

## Actions

Adding an action (anything that changes state upstream) is a separate,
smaller pull request after the read-only connector lands. Actions need a fixed
route template in `server/routes.mjs`, an exact current target and revision
check, in-app confirmation, and tests for every denied path. Destructive
actions (delete, force-stop, bulk operations) are outside the product boundary.

## Infrastructure connectors

Proxmox, Portainer and Loki are stored by id in `infrastructureTargets` and
`infrastructureServices`, so several of each can exist. A new infrastructure
connector adds its type to `INFRASTRUCTURE_TYPES` or
`INFRASTRUCTURE_SERVICE_TYPES` in `server/state.mjs`, a definition in
`server/control-plane.mjs`, a route table and `authorize…Route()` in
`server/routes.mjs`, a `probe…()` module like `server/portainer-probes.mjs`, a
`dispatch…` hook in `server/broker.mjs`, and a fake in `scripts/demo.mjs`.
Its count is covered by `HELMSMAN_MAX_INFRASTRUCTURE_SERVICES` or the Proxmox
limits in `server/limits.mjs`.
