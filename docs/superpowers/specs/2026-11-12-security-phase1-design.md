# Helmsman Security — Phase 1 (See everything) — Design

Date: 2026-11-12
Status: Written after brainstorming; awaiting owner approval
Scope: Phase 1 of 5. Phases 2 (vulnerabilities), 3 (detection), 4 (compliance) and 5 (safe remediation) get their own specs.
Background: project brief `homelab-security-ops-platform.md` and research report `homelab-security-platform-foundations-research.md` (both in the owner's claude.ai "Infrastructure Projects" project).

## 1. Intent

The owner wants to **protect their homelab**. The platform must show what is running everywhere and what's wrong with it, and it must never call something safe without evidence. Phase 1 builds the foundation every later phase stands on: a trustworthy inventory, a health picture, and an explicit list of what is *not* known.

The owner has no coding experience. Claude builds and maintains everything, so we favour fewer moving parts, one language, and boring, well-documented components.

### Success criteria
- Every machine and guest in the lab appears in one inventory, with its software, open ports and health, and a "last confirmed" time on every fact.
- Anything not confirmed recently enough shows as **unknown**, with the reason ("agent last seen 3 h ago", "no agent installed", "Proxmox API token rejected"). Unknown is never displayed as healthy.
- The owner can see this in a **Security** tab in Helmsman, including on their phone through the public Helmsman URL, without Helmsman gaining any new privilege.
- Nothing in phase 1 changes any system. Read-only end to end.

### Goals
1. Inventory of hosts, guests, containers and installed software.
2. Health issues: end-of-life OS/software, disk SMART failures, failed backup jobs, clock drift, pending reboots, failed Windows updates, disconnected agents, guests without agents.
3. Coverage ledger: for every (asset, check) pair, when it last succeeded and whether the evidence is fresh.
4. Holds: the owner can mark a software version as deliberately pinned, with a reason and optional expiry.

### Non-goals (phase 1)
CVE matching, exposure reasoning and the posture score (phase 2); intrusion/event detection and push alerts (phase 3); compliance mapping (phase 4); any write or fix (phase 5); 3D topology; separate desktop/Android/in-car apps.

### Anti-goals (a failure even if it "works")
- Any state where missing or stale data looks green.
- Helmsman gaining SSH, shell, WinRM, Docker-socket or any write path to the engine.
- The engine being reachable from the internet.
- An LLM deciding any state, severity or eligibility.

## 2. Constraints
- Helmsman is plain Node.js (`>=24.19 <25`), no npm dependencies, vanilla JS UI, JSON-file state, 160 MB heap, publicly reachable, and its README promises no shell/SSH/Docker-socket/reconfiguration capability. That promise must remain true.
- Hardware: everything security/infra runs on Proxmox node **norco**, which has about **20 GB free RAM**. Main is media only and stays out of this.
- Home power is unstable and there is no UPS. Everything must recover cleanly from sudden power loss.
- Helmsman is meant to be usable by other people: nothing lab-specific is hardcoded. IPs, hostnames and vendors are configuration.
- The lab already runs Pi-hole, Caddy, Authentik, Cloudflare Tunnel, Tailscale, Semaphore, Grafana + Loki and Home Assistant on a flat 192.168.0.0/24 LAN with a TP-Link ER605 router.

## 3. Approaches considered

| Approach | Trade-off | Outcome |
|---|---|---|
| **A. Wazuh agents as sensors + our engine on top** | Wazuh's agent gives continuous, accurate per-host data (software, ports, processes, Windows hotfixes, hardware) and later covers detection and compliance. Costs ~8 GB RAM and an agent per host. Engine holds **no** SSH/WinRM credentials. | **Chosen** by the owner, who prefers agents for accuracy. |
| B. osquery + Fleet | Richest, query-anything inventory, lighter. Weaker detection/compliance; some Fleet features need a paid license. | Rejected: more custom work later. |
| C. Agentless (Vuls/SSH/WinRM) | Lightest, no software on hosts. Snapshot-only accuracy; the engine holds admin logins to every machine. | Rejected: less accurate, larger blast radius. |
| (Earlier) Engine inside Helmsman | Simpler deploy, but it breaks Helmsman's published security boundary on a public URL. | Rejected by the owner: separate LAN-only service. |

## 4. Architecture

```
  [Wazuh agents on hosts/guests] ──▶ Wazuh 5.x (VM on norco) ──▶ Wazuh API
  [Proxmox API (PVEAuditor)] ───────────────────────────────────┐   │
  [Docker API via read-only proxy] ─────────────────────────────┤   │
  [endoflife.date dataset] ─────────────────────────────────────┤   │
                                                                ▼   ▼
                                            helmsman-security engine (LXC on norco, LAN-only)
                                            collectors → evidence store (SQLite) → checks → read-only API
                                                                │  GET only, read-only token
                                                                ▼
                                            Helmsman "Security" connector + Security tab (public UI)
```

### 4.1 Wazuh (sensor layer)
- Wazuh **5.x** all-in-one (manager + indexer + dashboard) in its own **VM** on norco: 4 vCPU, 8 GB RAM, 80 GB disk. A VM rather than an LXC because the indexer (OpenSearch) needs kernel settings (`vm.max_map_count`) that unprivileged LXCs can't set.
- Version: Wazuh 5.0 is at release candidate as of 2026-11-12, and there is no upgrade path from 4.x. **Decision: install 5.0 GA. If GA isn't out when phase 1 reaches this step, use the latest 5.0 RC and treat the Wazuh deployment as rebuildable** (agents re-enroll; no history worth keeping in phase 1).
- Wazuh's optional AI assistant stays off.
- Agents go on: both Proxmox hosts (norco, Main), the QDevice laptop, every long-lived Linux VM/LXC, and two **roaming** personal devices: the owner's laptop (Lenovo Legion, Fedora → Linux agent) and a family MacBook (macOS agent). No Windows machines are in scope, so the Windows-only checks ship as code but read "not applicable" everywhere today.
- **Roaming devices** are a separate asset class. When they're away from home, Wazuh will show the agent as disconnected. That's expected, not an issue: their checks read unknown with "away since …" and they don't count toward issue totals. *(Builder's call)* Agents reach the manager over the LAN only. Reaching it over Tailscale while away is a possible later addition, not phase 1. Appliance guests that can't take an agent (e.g. Home Assistant OS) are listed as "no agent possible" and stay **unknown** for host-level checks, with that reason.
- *(Builder's call)* Configuring the Wazuh deployment we install (enabling inventory modules, Windows event channels) is setup work, not a change to existing systems. "Read-only" in this spec means the **engine** never changes anything.
- Agent enrollment uses a per-group enrollment password. Agent install is a documented copy-paste step for the owner (or a Semaphore playbook later); the engine never installs anything.
- Wazuh dashboard is reachable on the LAN only, via Caddy `tls internal` + Authentik forward auth, matching how the owner already runs LAN-only services.

### 4.2 Engine (`helmsman-security`)
- **Node.js 24, same conventions as Helmsman**: ESM, `node --test`, no npm dependencies where avoidable. Storage uses the built-in `node:sqlite`. One language across the whole system so the owner only depends on one toolchain.
- Own GitHub repo `helmsman-security`, packaged as a container, run in an **unprivileged LXC on norco** (≈1 vCPU, 1 GB RAM, 8 GB disk).
- LAN-only, with no Cloudflare/Tailscale/Caddy public route. *(Builder's call)* It listens on two ports:
  - **API port** (LAN): serves only the GET API in 4.7 over HTTPS with a self-signed certificate. Helmsman connects directly and pins that certificate, the same way the Proxmox connector does. Every request needs the read-only bearer token. This port serves no admin routes at all.
  - **Admin port** (holds, credentials, manual asset links): bound to `127.0.0.1` inside the LXC and reached only through Caddy `tls internal` + Authentik forward auth via a tunnel-free reverse proxy rule. The engine also checks Authentik's forwarded user header against a configured owner, so being on the LAN is never enough to reach admin functions.
- Multi-tenant from the start: every row carries `tenant_id`. A single default tenant in practice. There are tests proving one tenant cannot read another's rows.
- Credentials (Wazuh API user, Wazuh indexer user, Proxmox token) are encrypted at rest with a master key held outside the database. Pattern copied from Helmsman's `server/secrets.mjs`.
- Crash safety: SQLite in WAL mode, and every collector run is a single transaction. After a power loss the engine starts, marks any run left open as failed (so the evidence it would have produced is unknown, not old-and-green) and continues.

### 4.3 Collectors (phase 1)
Each collector declares its **capabilities** (what checks it can feed) and a **staleness limit**. The default schedule is every 15 min. *(Builder's call)* EOL data is fetched once a day from endoflife.date's API over TLS. That host is the only internet destination the engine is allowed to reach (enforced by an egress allowlist). The dataset's fetch time is recorded as evidence, and if it's older than 7 days, every EOL check becomes unknown ("EOL data out of date").

| Collector | Credential | Feeds |
|---|---|---|
| Wazuh server API + Wazuh indexer | Dedicated Wazuh API user with a read-only RBAC role, **and** a read-only indexer user (in 5.x, inventory data lives in the indexer) | Agent list + status + last keep-alive; inventory: OS, packages, hotfixes (Windows), network ports, processes, hardware |
| Proxmox VE API | New token with role **PVEAuditor** (separate from Helmsman's start/stop/restart token) | Nodes, guests (VM/LXC), storage, node time, disk SMART (`/nodes/{n}/disks/list`, `/disks/smart`), backups: scheduled job definitions, vzdump task results on **both** nodes, and backup files present on the backup storage (`/nodes/{n}/storage/{s}/content?content=backup`). Backups are Proxmox scheduled jobs writing to a drive on norco that's shared to Main. |
| Docker Engine API via a read-only socket proxy | None stored. *(Builder's call)* Each Docker host runs a socket proxy (e.g. `tecnativa/docker-socket-proxy`, version-pinned) that allows only `GET` on containers, images, info and version, and only from the engine's IP. Portainer CE was rejected because it can't issue a truly read-only credential. | Containers, images, image digests, published ports |
| endoflife.date | none (public dataset, cached locally) | EOL dates for OS and known products |

The router (ER605) and switches have no phase 1 collector. They appear in inventory as "no collector yet → unknown" so the gap is visible. Their collector lands in phase 2 together with exposure reasoning.

### 4.4 Asset identity
One asset can be seen by several sources (a Proxmox guest, its Wazuh agent, the containers inside it). The engine links them by deterministic rules, in order: (1) Proxmox guest MAC ↔ Wazuh agent MAC, (2) IP + hostname, (3) a manual link set by the owner. An ambiguous match is never auto-linked. It shows in the Unknowns list as "can't tell which agent belongs to guest 109". A guest with no linked agent produces "no agent → host checks unknown".

### 4.5 Evidence model and checks
- Every fact is stored as evidence: `source`, `collected_at`, `stale_after`, raw payload hash, and the normalized value.
- A **check** reads evidence and produces exactly one of `ok` / `issue` / `unknown`, plus `reason` and links to the evidence it used. Checks are pure functions with unit tests. No LLM involvement.
- Rule: if any input evidence is missing, stale, unparseable or from a failed run, the result is `unknown`. A check can never return `ok` without fresh evidence.
- The **coverage ledger** is the table of (asset, check) → last result, last success time and reason. It drives the Unknowns view.

Phase 1 checks:

| Check | Issue when | Unknown when |
|---|---|---|
| Agent connected | Wazuh agent disconnected/never connected | Wazuh API unreachable/stale |
| Agent present | Guest/host has no linked agent and isn't marked "no agent possible" | Asset identity ambiguous |
| OS end-of-life | OS cycle past EOL | OS not identified, or no EOL entry for it |
| Software end-of-life | Package/product past EOL and not on hold | Product not in dataset (listed, not an issue) |
| Disk health | SMART status not PASSED, or Proxmox reports wearout above threshold | SMART unavailable for that disk |
| Backup jobs | Last backup for a guest failed, or no successful backup within N days (configurable) | Backup source unreadable |
| Backup storage | The backup storage (a drive on norco, shared to Main) is offline, missing from a node, or over a configurable fill threshold | Storage status unreadable |
| Clock drift | Node time differs from engine time by more than N s (default 5) | Time not readable |
| Pending reboot | Linux: running kernel ≠ newest installed kernel package. Windows: reported via Wazuh | Data not available from the agent |
| Failed Windows updates | Wazuh reports failed/missing hotfix install events | Not a Windows host → not applicable (not unknown) |

"Not applicable" is a fourth display state, used only when a check structurally can't apply (Windows checks on Linux). It never counts as ok.

### 4.6 Holds
The owner can hold a (asset, product, version), with a reason and optional expiry. A held item doesn't raise EOL issues until its version changes, the hold expires, or (phase 2) a new CVE/KEV appears. Holds are shown, never hidden. Holds are set in the engine's LAN-only UI, not from Helmsman. *(Builder's call)* The same mechanism covers **check exclusions**: for example "guest 152 is intentionally not backed up", with a reason. An excluded check shows as "excluded by owner" and is never counted as ok.

### 4.7 Engine API (for Helmsman)
GET-only, read-only bearer token, bounded responses (paged, size-capped):
- `/api/v1/summary`: counts of ok / issue / unknown / not-applicable, last successful run per collector, engine version.
- `/api/v1/assets`, `/api/v1/assets/{id}`: inventory, software, ports, and per-check results with reasons and timestamps.
- `/api/v1/issues`: open issues.
- `/api/v1/unknowns`: everything unknown, with its reason.
- `/api/v1/health`: engine self-health.

### 4.8 Helmsman changes
- New connector `security` following `docs/ADDING-A-CONNECTOR.md` and the Loki connector pattern: fixed GET routes only, response size caps, redaction, destination approval, token stored write-only and encrypted. No action routes.
- New fourth top-level **Security** workspace beside System, Media and Infrastructure (the owner asked for a "security main tab"), with three pages: **Issues**, **Unknowns** (with reasons) and **Inventory** (assets → detail panel). It uses existing theme components and works in all three themes, with no new visual work.
- If the engine is unreachable or stale, the tab says so plainly ("Security engine not reporting since 14:02. Everything below may be out of date.") and every row shows as unknown. Cached data is never shown as current.
- Demo mode: a fake engine in `scripts/demo.mjs` with mixed ok/issue/unknown data.
- The Helmsman agent may *read* the summary to answer questions. It gets no new actions.
- Helmsman README boundary text stays accurate. Its tests (`npm test`) must pass.

## 5. Quality bar
- Write tests first for every check, the identity-linking rules and the staleness logic. Collector tests run against recorded fixtures, including malformed, empty, auth-failure and timeout responses, all of which must yield `unknown`.
- Power-loss test: kill the engine mid-run and restart; no check may turn `ok` from the interrupted run.
- Tenant-isolation tests.
- Deploy gate (engine repo CI): tests + lint + a smoke run against the demo fixtures. Releases are tagged and the container image is pinned by digest. Every third-party software artifact (Wazuh packages, the socket proxy image, base images) is version-pinned and checksum-verified. The Trivy compromise in March 2026 showed security tools are themselves targets. Live data feeds such as endoflife.date can't be checksummed, so they're tracked by age instead.
- The soak test against a copy of the live database begins in phase 2, once there's a database worth copying. In phase 1 the engine runs read-only against the real lab for at least a week before phase 2 starts.

## 6. Rollout (owner steps are copy-paste, guided)
1. Owner creates the empty GitHub repo `helmsman-security`; Claude attaches it.
2. Create the Wazuh VM on norco, install Wazuh 5.x, put the dashboard behind Caddy + Authentik.
3. Install agents on the hosts and guests (guided per OS).
4. Create read-only credentials: Wazuh API user + role, Wazuh indexer read-only user, Proxmox PVEAuditor token. Deploy the read-only Docker socket proxy on each Docker host.
5. Create the engine LXC, deploy the container, enter credentials in the engine's LAN UI.
6. Update Helmsman (new version) with the Security connector; connect it to the engine with its read-only token.
7. Run for a week, review Unknowns with Claude, fix coverage gaps.

## 7. Left to the builder
Internal module layout, SQLite schema details, exact page sizes and caps, the endoflife.date product matching approach (with unmatched products listed rather than guessed), the UI table layout within existing components, and test fixture formats.

## 8. Open questions (to resolve before planning)
- Is the ER605 in standalone mode or managed by an Omada controller? (Phase 2 dependency; recorded here so it isn't lost.)
