import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const passes = [];

function record(condition, label, detail = "") {
  if (condition) passes.push(label);
  else failures.push(detail ? `${label}: ${detail}` : label);
}

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

const requiredFiles = [
  "Dockerfile",
  "compose.yaml",
  "compose.dev.yaml",
  ".dockerignore",
  ".gitattributes",
  ".gitignore",
  "SECURITY.md",
  "container.env.example",
  "GITHUB.md",
  "package.json",
  "server/index.mjs",
  "server/broker.mjs",
  "server/control-plane.mjs",
  "server/health-engine.mjs",
  "server/lock.mjs",
  "server/media-artwork.mjs",
  "server/media-model.mjs",
  "server/monitor.mjs",
  "server/network.mjs",
  "server/portainer-model.mjs",
  "server/portainer-probes.mjs",
  "server/proxmox-probes.mjs",
  "server/routes.mjs",
  "server/secrets.mjs",
  "server/service-probes.mjs",
  "server/session-auth.mjs",
  "server/state.mjs",
  "tests/state-infrastructure-targets.test.mjs",
  "tests/infrastructure-control-plane.test.mjs",
  "tests/proxmox-probes.test.mjs",
  "tests/proxmox-monitor.test.mjs",
  "tests/proxmox-transport.test.mjs",
  "tests/infrastructure-service-control-plane.test.mjs",
  "tests/portainer-backend.test.mjs",
  "tests/portainer-monitor.test.mjs",
  "tests/portainer-transport.test.mjs",
  "tests/helpers/self-signed-tls.mjs",
  "tests/media-model.test.mjs",
  "tests/media-artwork.test.mjs",
  "tests/media-artwork-control-plane.test.mjs",
  "src/app-v5.js",
  "src/ui/control.css",
  "src/ui/operations.css",
  "src/ui/operations-views.js",
  "src/ui/retro.css",
  "assets/helmsman-logo.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/icon-maskable-512.png",
  "assets/services/jellyfin.svg",
  "assets/services/seerr.png",
  "assets/services/radarr.png",
  "assets/services/sonarr.png",
  "assets/services/prowlarr.png",
  "assets/services/qbittorrent.svg",
  "assets/services/bazarr.svg",
  "assets/services/proxmox.png",
  "assets/services/portainer.svg",
  "assets/services/THIRD_PARTY_NOTICES.md",
  "assets/workloads/vm.png",
  "assets/workloads/lxc.svg",
  ".github/dependabot.yml",
  ".github/workflows/container.yml",
  "deploy/DOCKER.md",
  "deploy/README.md",
  "deploy/compose.hardened.yaml",
  "deploy/compose.upgrade-v0.5.yaml",
  "deploy/Caddyfile.container-edge.lan.example",
  "deploy/Caddyfile.container-edge.authentik.example"
];
const missing = requiredFiles.filter((path) => !existsSync(join(root, path)));
record(
  missing.length === 0,
  "Helmsman v0.10 includes its unified read-only media model, Proxmox and Portainer infrastructure monitors, encrypted store, retro operations UI, and deployment contracts",
  missing.join(", ")
);

const exactNodeImage = "node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995";
const forbiddenServiceEnvironment = /(?:^|\s)(?:JELLYFIN|SEERR|RADARR|SONARR|PROWLARR|BAZARR|QBITTORRENT|QBIT|PROXMOX|PVE|PORTAINER)_[A-Z0-9_]+\s*(?:=|:)/imu;
const forbiddenSecretEnvironment = /(?:^|\s)[A-Z0-9_]*(?:API_?KEY|PASSWORD|PASSPHRASE|TOKEN|SECRET|COOKIE)[A-Z0-9_]*\s*(?:=|:)/imu;
const privateServiceAddress = /(?:^|[^\d])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?/u;

if (existsSync(join(root, "Dockerfile"))) {
  const dockerfile = read("Dockerfile");
  const fromLines = dockerfile.match(/^FROM[ \t]+\S+[ \t]*$/gmu) || [];
  record(
    fromLines.length === 1
      && fromLines[0] === `FROM ${exactNodeImage}`
      && !/:latest(?:@|\s|$)/u.test(fromLines[0]),
    "Dockerfile pins the exact reviewed Node image",
    fromLines.join(", ")
  );

  record(
    /^ARG HELMSMAN_VERSION=0\.10\.0-beta\.9$/mu.test(dockerfile)
      && /^ARG HELMSMAN_REVISION=unknown$/mu.test(dockerfile)
      && /org\.opencontainers\.image\.title="Helmsman"/u.test(dockerfile)
      && !/org\.opencontainers\.image\.title="Jellofin Command"/u.test(dockerfile),
    "image metadata carries the Helmsman v0.10 identity"
  );

  record(
    /addgroup\s+-S\s+-g\s+10001\s+helmsman/u.test(dockerfile)
      && /adduser\s+-S\s+-D\s+-H\s+-u\s+10001\s+-G\s+helmsman\s+helmsman/u.test(dockerfile)
      && /^USER\s+10001:10001\s*$/mu.test(dockerfile)
      && /chown root:root \/app/u.test(dockerfile)
      && /chmod 0555 \/app/u.test(dockerfile)
      && /chown 10001:10001 \/data/u.test(dockerfile)
      && /chmod 0700 \/data/u.test(dockerfile),
    "image runs as UID/GID 10001 with immutable code and a private data directory"
  );

  const copyLines = dockerfile.match(/^COPY\s+[^\n]+$/gmu) || [];
  const expectedCopies = [
    "COPY --chown=0:0 index.html styles.css manifest.webmanifest sw.js ./",
    "COPY --chown=0:0 assets/helmsman-logo.png assets/icon-192.png assets/icon-512.png assets/icon-maskable-512.png ./assets/",
    "COPY --chown=0:0 assets/services/jellyfin.svg assets/services/seerr.png assets/services/radarr.png assets/services/sonarr.png assets/services/prowlarr.png assets/services/qbittorrent.svg assets/services/bazarr.svg assets/services/proxmox.png assets/services/portainer.svg assets/services/THIRD_PARTY_NOTICES.md ./assets/services/",
    "COPY --chown=0:0 assets/workloads/vm.png assets/workloads/lxc.svg ./assets/workloads/",
    "COPY --chown=0:0 src/app-v5.js ./src/app-v5.js",
    "COPY --chown=0:0 src/ui/operations-views.js src/ui/operations.css src/ui/control.css src/ui/retro.css ./src/ui/",
    "COPY --chown=0:0 server ./server",
    "COPY --chown=0:0 package.json ./package.json"
  ];
  record(
    copyLines.length === expectedCopies.length
      && expectedCopies.every((line) => copyLines.includes(line))
      && !copyLines.some((line) => /(?:^|\s)\.(?:\s|$)/u.test(line.slice("COPY ".length)))
      && !copyLines.some((line) => /(?:Caddyfile|container-entrypoint|start-caddy)/iu.test(line)),
    "image copies only the explicit frontend, broker, and package allowlist",
    copyLines.join("; ")
  );

  record(
    /HELMSMAN_HOST=0\.0\.0\.0/u.test(dockerfile)
      && /HELMSMAN_VERSION=\$\{HELMSMAN_VERSION\}/u.test(dockerfile)
      && /HELMSMAN_PORT=8080/u.test(dockerfile)
      && /HELMSMAN_DATA_DIR=\/data/u.test(dockerfile)
      && !forbiddenServiceEnvironment.test(dockerfile)
      && !forbiddenSecretEnvironment.test(dockerfile)
      && !privateServiceAddress.test(dockerfile),
    "image defaults contain process settings only, without service topology or secrets"
  );

  record(
    /^VOLUME\s+\["\/data"\]\s*$/mu.test(dockerfile)
      && /HEALTHCHECK[\s\S]*?CMD \["node", "server\/index\.mjs", "healthcheck"\]/u.test(dockerfile)
      && /^ENTRYPOINT \["node", "server\/index\.mjs"\]\s*$/mu.test(dockerfile)
      && /^CMD \["serve"\]\s*$/mu.test(dockerfile)
      && !/^FROM\s+caddy/imu.test(dockerfile)
      && !/(?:caddy|nginx)\s+(?:run|start)/iu.test(dockerfile),
    "image starts one Node broker process with a broker healthcheck and /data volume"
  );
}

if (existsSync(join(root, "server/broker.mjs"))) {
  const broker = read("server/broker.mjs");
  record(
    /const DEFAULT_VERSION = "0\.10\.0-beta\.9"/u.test(broker)
      && /process\.env\.HELMSMAN_VERSION/u.test(broker)
      && /\^\[0-9A-Za-z\]\[0-9A-Za-z\.\+-\]\{0,63\}\$/u.test(broker),
    "runtime version follows the validated immutable v0.10 image metadata"
  );
}

if (existsSync(join(root, "server/index.mjs"))
  && existsSync(join(root, "server/session-auth.mjs"))
  && existsSync(join(root, "server/control-plane.mjs"))) {
  const index = read("server/index.mjs");
  const sessionAuth = read("server/session-auth.mjs");
  const controlPlane = read("server/control-plane.mjs");
  record(
    /const SESSION_STATE_VERSION = 2;/u.test(sessionAuth)
      && /const ACCESS_KEY_BYTES = 32;/u.test(sessionAuth)
      && /const DEFAULT_TTL_MS = 365 \* 24 \* 60 \* 60 \* 1_000;/u.test(sessionAuth)
      && /accessKeyHash: null/u.test(sessionAuth)
      && /async claimAccess\(options\)/u.test(sessionAuth)
      && /async login\(options\)/u.test(sessionAuth)
      && /async rotateAccessKeyAndIssue\(options\)/u.test(sessionAuth)
      && /async rotateAccessKey\(\)/u.test(sessionAuth),
    "access control persists only a 256-bit key verifier and issues one-year origin-bound browser sessions"
  );
  record(
    /url[.]pathname === "\/api\/v2\/access\/login"/u.test(controlPlane)
      && /url[.]pathname === "\/api\/v2\/access\/rotate"/u.test(controlPlane)
      && /accessKey: issued[.]accessKey/u.test(controlPlane)
      && /First-time setup completed, and reusable access was configured[.]/u.test(controlPlane)
      && !/log\([^\n]*accessKey/iu.test(controlPlane),
    "claim, universal-key login, and authenticated rotation expose the key only in direct responses"
  );
  record(
    /command === "rotate-access-key"/u.test(index)
      && /process[.]argv[.]length !== 4 \|\| process[.]argv\[3\] !== "--confirm"/u.test(index)
      && /accessKey = await sessions[.]rotateAccessKey\(\)/u.test(index)
      && /Helmsman access key: \$\{accessKey\}/u.test(index)
      && /All existing browser sessions were revoked[.] Saved services, network policy, and encrypted credentials were preserved[.]/u.test(index),
    "the confirmed offline access-key CLI prints its replacement once and preserves application configuration"
  );
}

if (existsSync(join(root, "server/media-model.mjs"))
  && existsSync(join(root, "server/media-artwork.mjs"))) {
  const mediaModel = read("server/media-model.mjs");
  const mediaArtwork = read("server/media-artwork.mjs");
  record(
    /export const MEDIA_SCHEMA = 1;/u.test(mediaModel)
      && /export function buildMediaSnapshot/u.test(mediaModel)
      && /LIFECYCLE_STEPS = Object\.freeze\(\["requested", "monitored", "downloading", "imported", "available"\]\)/u.test(mediaModel)
      && /\/api\/v2\/media\/artwork\/\$\{token\}/u.test(mediaModel)
      && /MAX_LIBRARY_ITEMS = 500/u.test(mediaModel)
      && /MAX_COLLECTION_ITEMS = 200/u.test(mediaModel),
    "v0.9 builds one bounded read-only media model matched by provider identifiers with opaque artwork URLs"
  );
  record(
    /DEFAULT_POSITIVE_TTL_MS = 24 \* 60 \* 60 \* 1_000/u.test(mediaArtwork)
      && /DEFAULT_NEGATIVE_TTL_MS = 15 \* 60 \* 1_000/u.test(mediaArtwork)
      && /DEFAULT_MAX_ENTRIES = 512/u.test(mediaArtwork)
      && /DEFAULT_MAX_BYTES = 64 \* 1024 \* 1024/u.test(mediaArtwork)
      && /DEFAULT_MAX_CONCURRENT_FETCHES = 3/u.test(mediaArtwork)
      && /DEFAULT_MAX_PENDING_FETCHES = 64/u.test(mediaArtwork)
      && /MAX_ARTWORK_BYTES = 4 \* 1024 \* 1024/u.test(mediaArtwork)
      && /const cache = new Map\(\)/u.test(mediaArtwork)
      && /const inFlight = new Map\(\)/u.test(mediaArtwork)
      && /const pendingFetches = \[\]/u.test(mediaArtwork)
      && !/node:fs/u.test(mediaArtwork),
    "media artwork uses bounded in-memory caching, miss coalescing, and fetch scheduling without writing catalog or image data to disk"
  );
}

if (existsSync(join(root, "compose.yaml"))) {
  const compose = read("compose.yaml");
  record(
    /^name:\s*helmsman\s*$/mu.test(compose)
      && /^services:\s*\n\s{2}helmsman:\s*$/mu.test(compose)
      && compose.includes('${HELMSMAN_IMAGE:-ghcr.io/OWNER/REPOSITORY:0.10.0-beta.9}')
      && !/^\s{4}build:/mu.test(compose),
    "production Compose has a stable project name and pulls the versioned GHCR image without a local build"
  );
  record(
    compose.includes('"${HELMSMAN_BIND_IP:-${JELLOFIN_COMMAND_BIND_IP:-127.0.0.1}}:${HELMSMAN_PORT:-${JELLOFIN_COMMAND_PORT:-4180}}:8080/tcp"')
      && !/(?:docker\.sock|network_mode:\s*host|privileged:\s*true)/iu.test(compose),
    "Compose publishes the broker on loopback by default without host control access"
  );

  record(
    /user:\s*["']10001:10001["']/u.test(compose)
      && /read_only:\s*true/u.test(compose)
      && /\/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777/u.test(compose)
      && /cap_drop:\s*\n\s*- ALL/u.test(compose)
      && /no-new-privileges:true/u.test(compose)
      && /pids_limit:\s*64/u.test(compose)
      && /mem_limit:\s*256m/u.test(compose)
      && /cpus:\s*["']0\.50["']/u.test(compose),
    "Compose applies the non-root read-only resource and privilege limits"
  );

  const environmentBlock = compose.match(/^\s{4}environment:\s*\n((?:^\s{6}[A-Z0-9_]+:[^\n]*\n?)*)/mu)?.[1] || "";
  const environmentKeys = [...environmentBlock.matchAll(/^\s+([A-Z0-9_]+):/gmu)].map((match) => match[1]);
  const expectedEnvironmentKeys = [
    "HELMSMAN_HOST",
    "HELMSMAN_PORT",
    "HELMSMAN_DATA_DIR"
  ];
  record(
    environmentKeys.length === expectedEnvironmentKeys.length
      && expectedEnvironmentKeys.every((key) => environmentKeys.includes(key))
      && !forbiddenServiceEnvironment.test(environmentBlock)
      && !forbiddenSecretEnvironment.test(environmentBlock),
    "Compose environment contains only broker process settings",
    environmentKeys.join(", ")
  );

  const serviceVolumes = compose.match(/^\s{4}volumes:\s*\n((?:^\s{6}-[^\n]*\n?)*)/mu)?.[1] || "";
  const mounts = [...serviceVolumes.matchAll(/^\s+-\s+([^\s]+)\s*$/gmu)].map((match) => match[1]);
  record(
    mounts.length === 1
      && mounts[0] === "helmsman-data:/data"
      && /^volumes:\s*\n\s{2}helmsman-data:\s*$/mu.test(compose)
      && !/^\s{4}(?:name|external):/mu.test(compose)
      && !/HELMSMAN_DATA_VOLUME/u.test(compose)
      && /test:\s*\["CMD",\s*"node",\s*"server\/index\.mjs",\s*"healthcheck"\]/u.test(compose),
    "fresh Compose uses one project-scoped data volume and the broker CLI healthcheck",
    mounts.join(", ")
  );
}

if (existsSync(join(root, "compose.dev.yaml"))) {
  const developmentCompose = read("compose.dev.yaml");
  record(
    /^services:\s*\n\s{2}helmsman:\s*$/mu.test(developmentCompose)
      && /^\s{4}build:\s*$/mu.test(developmentCompose)
      && /^\s{6}context:\s*[.]\s*$/mu.test(developmentCompose)
      && /^\s{6}dockerfile:\s*Dockerfile\s*$/mu.test(developmentCompose)
      && /HELMSMAN_VERSION:\s*["']0\.10\.0-beta\.9["']/u.test(developmentCompose)
      && /HELMSMAN_REVISION:\s*["']local["']/u.test(developmentCompose)
      && /image:\s*["']helmsman:0\.10\.0-beta\.9["']/u.test(developmentCompose),
    "developer Compose override keeps source builds separate from the production pull contract"
  );
}

if (existsSync(join(root, "server/index.mjs")) && existsSync(join(root, "server/broker.mjs"))) {
  const entrypoint = read("server/index.mjs");
  const broker = read("server/broker.mjs");
  record(
    /process\.env\.HELMSMAN_PORT\s*\|\|\s*process\.env\.JELLOFIN_COMMAND_PORT/u.test(entrypoint)
      && /process\.env\.HELMSMAN_HOST\s*\|\|\s*process\.env\.JELLOFIN_COMMAND_HOST/u.test(entrypoint)
      && /process\.env\.HELMSMAN_DATA_DIR\s*\|\|\s*process\.env\.JELLOFIN_COMMAND_DATA_DIR/u.test(entrypoint)
      && /process\.env\.HELMSMAN_MASTER_KEY_FILE[\s\S]{0,100}process\.env\.JELLOFIN_COMMAND_MASTER_KEY_FILE/u.test(broker),
    "Helmsman runtime variables take precedence while legacy deployment variables remain compatible"
  );
}

if (existsSync(join(root, "server/state.mjs"))
  && existsSync(join(root, "server/control-plane.mjs"))
  && existsSync(join(root, "server/routes.mjs"))
  && existsSync(join(root, "server/proxmox-probes.mjs"))) {
  const state = read("server/state.mjs");
  const controlPlane = read("server/control-plane.mjs");
  const routes = read("server/routes.mjs");
  const proxmoxProbes = read("server/proxmox-probes.mjs");
  const proxmoxRouteBlock = routes.match(/const PROXMOX_ROUTES = Object\.freeze\(\{[\s\S]*?\n\}\);/u)?.[0] || "";
  record(
    /const STATE_VERSION = 4;/u.test(state)
      && /infrastructureTargets:\s*\{\}/u.test(state)
      && /infrastructureServices:\s*\{\}/u.test(state)
      && /value\.version === 1/u.test(state)
      && /value\.infrastructureTargets = \{\}/u.test(state)
      && /value\.version === 3/u.test(state)
      && /value\.infrastructureServices = \{\}/u.test(state)
      && /MAX_INFRASTRUCTURE_TARGETS = 25/u.test(state)
      && /MAX_INFRASTRUCTURE_SERVICES = 8/u.test(state)
      && /INFRASTRUCTURE_TYPES = new Set\(\["proxmox"\]\)/u.test(state)
      && /INFRASTRUCTURE_SERVICE_TYPES = new Set\(\["portainer"\]\)/u.test(state),
    "v0.10 state migration adds bounded Portainer infrastructure services without replacing media or Proxmox state"
  );
  record(
    /export const PROXMOX_ROUTE_IDS/u.test(routes)
      && /export function authorizeProxmoxRoute/u.test(routes)
      && /method !== "GET"/u.test(routes)
      && /internalOnly:\s*true/u.test(routes)
      && proxmoxRouteBlock.length > 0
      && !/\b(?:POST|PUT|PATCH|DELETE)\b/u.test(proxmoxRouteBlock),
    "Proxmox upstream access uses opaque internal route IDs and a GET-only allowlist"
  );
  record(
    /export function buildProxmoxProbePlan/u.test(proxmoxProbes)
      && /export async function probeProxmox/u.test(proxmoxProbes)
      && /method:\s*"GET"/u.test(proxmoxProbes)
      && /MAX_ITEMS\s*=\s*5_000/u.test(proxmoxProbes)
      && /MAX_REPORTS\s*=\s*12/u.test(proxmoxProbes)
      && /REPORT_REDACTION\s*=\s*"\[REDACTED\]"/u.test(proxmoxProbes),
    "Proxmox probes expose bounded derived health data with redacted reports"
  );
  record(
    /\/api\/v2\/infrastructure\/targets/u.test(controlPlane)
      && /Pinned certificate trust requires a SHA-256 fingerprint/u.test(controlPlane)
      && /Proxmox infrastructure targets must use HTTPS/u.test(controlPlane)
      && /tokenId/u.test(controlPlane)
      && /tokenSecret/u.test(controlPlane)
      && /credentialConfigured/u.test(controlPlane),
    "authenticated infrastructure APIs keep Proxmox destinations HTTPS-only and credentials write-only"
  );
}

if (existsSync(join(root, "server/control-plane.mjs"))
  && existsSync(join(root, "server/routes.mjs"))
  && existsSync(join(root, "server/portainer-model.mjs"))
  && existsSync(join(root, "server/portainer-probes.mjs"))) {
  const controlPlane = read("server/control-plane.mjs");
  const routes = read("server/routes.mjs");
  const portainerModel = read("server/portainer-model.mjs");
  const portainerProbes = read("server/portainer-probes.mjs");
  const portainerRouteBlock = routes.match(/const PORTAINER_ROUTES = Object\.freeze\(\{[\s\S]*?\n\}\);/u)?.[0] || "";
  record(
    /export const PORTAINER_ROUTE_IDS/u.test(routes)
      && /export function authorizePortainerRoute/u.test(routes)
      && /method !== "GET"/u.test(routes)
      && /\/api\/endpoints\?start=\$\{start\}&limit=100&sort=Name&order=asc&excludeSnapshots=true/u.test(routes)
      && /\/api\/endpoints\/\$\{endpointId\}\/docker\/containers\/json\?all=true/u.test(routes)
      && /internalOnly:\s*true/u.test(routes)
      && portainerRouteBlock.length > 0
      && !/\b(?:POST|PUT|PATCH|DELETE)\b/u.test(portainerRouteBlock),
    "Portainer upstream access uses opaque internal route IDs and a fixed GET-only allowlist"
  );
  record(
    /export function environmentsFromPortainer/u.test(portainerModel)
      && /export function containersFromPortainer/u.test(portainerModel)
      && /export function stacksFromPortainer/u.test(portainerModel)
      && /export function normalizePortainerInventory/u.test(portainerModel)
      && /MAX_ENVIRONMENTS = 500/u.test(portainerModel)
      && /MAX_CONTAINERS = 5_000/u.test(portainerModel)
      && /MAX_STACKS = 1_000/u.test(portainerModel)
      && /"informational"/u.test(portainerModel),
    "Portainer responses are normalized into bounded environment, container, and stack inventories with stopped containers informational"
  );
  record(
    /export async function probePortainer/u.test(portainerProbes)
      && /method:\s*"GET"/u.test(portainerProbes)
      && /statusObservation\.status === 404/u.test(portainerProbes)
      && /MAX_CONTAINER_ENVIRONMENTS = 25/u.test(portainerProbes)
      && /MAX_ENVIRONMENT_PAGES = 5/u.test(portainerProbes)
      && /CONTAINERS_UNHEALTHY/u.test(portainerProbes),
    "Portainer probes use bounded read-only pagination, version fallback, and precise container health evidence"
  );
  record(
    /\/api\/v2\/infrastructure\/services/u.test(controlPlane)
      && /Portainer infrastructure services must use HTTPS/u.test(controlPlane)
      && /Pinned certificate trust requires a SHA-256 fingerprint/u.test(controlPlane)
      && /credentialFields:\s*Object\.freeze\(\["accessToken"\]\)/u.test(controlPlane)
      && /credentialConfigured/u.test(controlPlane),
    "authenticated Infrastructure APIs keep Portainer HTTPS-only with destination-bound write-only access tokens"
  );
}

if (existsSync(join(root, "container.env.example"))) {
  const environment = read("container.env.example");
  const assignments = environment.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z0-9_]+=/u.test(line));
  const keys = assignments.map((line) => line.slice(0, line.indexOf("=")));
  const allowed = new Set(["HELMSMAN_IMAGE", "HELMSMAN_BIND_IP", "HELMSMAN_PORT"]);
  const unexpected = keys.filter((key) => !allowed.has(key));
  record(
    assignments.includes("HELMSMAN_IMAGE=ghcr.io/OWNER/REPOSITORY:0.10.0-beta.9")
      && assignments.includes("HELMSMAN_BIND_IP=127.0.0.1")
      && assignments.includes("HELMSMAN_PORT=4180")
      && !assignments.some((line) => line.startsWith("HELMSMAN_DATA_VOLUME="))
      && /# HELMSMAN_DATA_VOLUME=jellofin-command_jellofin-command-data/u.test(environment)
      && /Upgrade only/iu.test(environment)
      && unexpected.length === 0
      && !forbiddenServiceEnvironment.test(assignments.join("\n"))
      && !forbiddenSecretEnvironment.test(assignments.join("\n"))
      && !privateServiceAddress.test(assignments.join("\n")),
    "fresh example environment is loopback-safe and leaves the legacy volume override unset",
    unexpected.join(", ")
  );
}

if (existsSync(join(root, "deploy/compose.upgrade-v0.5.yaml"))) {
  const upgrade = read("deploy/compose.upgrade-v0.5.yaml");
  record(
    /^volumes:\s*\n\s{2}helmsman-data:\s*$/mu.test(upgrade)
      && /^\s{4}external:\s*true\s*$/mu.test(upgrade)
      && /^\s{4}name:\s*["']\$\{HELMSMAN_DATA_VOLUME:\?[^}]+\}["']\s*$/mu.test(upgrade)
      && !/\$\{HELMSMAN_DATA_VOLUME:-/u.test(upgrade)
      && !/jellofin-command_jellofin-command-data/u.test(upgrade),
    "v0.5 upgrade override requires an explicit existing external volume with no fallback name"
  );
}

if (existsSync(join(root, ".dockerignore"))) {
  const dockerignore = read(".dockerignore");
  const lines = dockerignore.split(/\r?\n/u);
  const requiredAllowlist = [
    "!Dockerfile",
    "!package.json",
    "!index.html",
    "!styles.css",
    "!manifest.webmanifest",
    "!sw.js",
    "!assets",
    "!assets/helmsman-logo.png",
    "!assets/icon-192.png",
    "!assets/icon-512.png",
    "!assets/icon-maskable-512.png",
    "!assets/services",
    "!assets/services/jellyfin.svg",
    "!assets/services/seerr.png",
    "!assets/services/radarr.png",
    "!assets/services/sonarr.png",
    "!assets/services/prowlarr.png",
    "!assets/services/qbittorrent.svg",
    "!assets/services/bazarr.svg",
    "!assets/services/proxmox.png",
    "!assets/services/portainer.svg",
    "!assets/services/THIRD_PARTY_NOTICES.md",
    "!assets/workloads",
    "!assets/workloads/vm.png",
    "!assets/workloads/lxc.svg",
    "!src/app-v5.js",
    "!src/ui/operations-views.js",
    "!src/ui/operations.css",
    "!src/ui/control.css",
    "!src/ui/retro.css",
    "!server/broker.mjs",
    "!server/control-plane.mjs",
    "!server/health-engine.mjs",
    "!server/index.mjs",
    "!server/lock.mjs",
    "!server/media-artwork.mjs",
    "!server/media-model.mjs",
    "!server/monitor.mjs",
    "!server/network.mjs",
    "!server/portainer-model.mjs",
    "!server/portainer-probes.mjs",
    "!server/proxmox-probes.mjs",
    "!server/routes.mjs",
    "!server/secrets.mjs",
    "!server/seerr-request-metadata.mjs",
    "!server/service-probes.mjs",
    "!server/session-auth.mjs",
    "!server/state.mjs"
  ];
  record(
    lines[0] === "*"
      && requiredAllowlist.every((line) => lines.includes(line))
      && !lines.includes("!server/**")
      && !lines.includes("!assets/**")
      && !lines.some((line) => /^!\.?env(?:\.|$)/u.test(line))
      && !lines.some((line) => /^!deploy(?:\/|$)/u.test(line)),
    "Docker context is deny-by-default and excludes environment and legacy deployment files"
  );
}

if (existsSync(join(root, "manifest.webmanifest"))) {
  try {
    const manifest = JSON.parse(read("manifest.webmanifest"));
    record(
      manifest.name === "Helmsman"
        && manifest.start_url === "./#/home"
        && manifest.display === "standalone"
        && Array.isArray(manifest.icons)
        && manifest.icons.some(({ src, sizes }) => src === "./assets/icon-192.png" && sizes === "192x192")
        && manifest.icons.some(({ src, sizes, purpose }) => src === "./assets/icon-512.png" && sizes === "512x512" && purpose === "any")
        && manifest.icons.some(({ src, sizes, purpose }) => src === "./assets/icon-maskable-512.png" && sizes === "512x512" && purpose === "maskable"),
      "the v0.10 installed-app manifest opens Media Home and retains dedicated local application icons"
    );
  } catch (error) {
    record(false, "the v0.10 installed-app manifest opens Media Home and retains dedicated local application icons", error.message);
  }
}

if (existsSync(join(root, "sw.js"))) {
  const serviceWorker = read("sw.js");
  record(
    /addEventListener\("install"/u.test(serviceWorker)
      && /skipWaiting\(\)/u.test(serviceWorker)
      && /addEventListener\("activate"/u.test(serviceWorker)
      && /caches\.keys\(\)/u.test(serviceWorker)
      && /caches\.delete\(key\)/u.test(serviceWorker)
      && /clients\.claim\(\)/u.test(serviceWorker)
      && !/addEventListener\(["']fetch["']/u.test(serviceWorker)
      && !/caches\.(?:open|match)\(/u.test(serviceWorker)
      && !/\.(?:add|addAll|put)\(/u.test(serviceWorker),
    "the PWA worker clears legacy caches without intercepting or persisting authenticated application traffic"
  );
}

const localMarkPaths = [
  "assets/services/jellyfin.svg",
  "assets/services/seerr.png",
  "assets/services/radarr.png",
  "assets/services/sonarr.png",
  "assets/services/prowlarr.png",
  "assets/services/qbittorrent.svg",
  "assets/services/bazarr.svg",
  "assets/services/proxmox.png",
  "assets/services/portainer.svg",
  "assets/workloads/vm.png",
  "assets/workloads/lxc.svg"
];
if (localMarkPaths.every((iconPath) => existsSync(join(root, iconPath)))) {
  const unsafeSvg = /<(?:script|foreignObject|iframe|object|embed|image)\b|\son[a-z]+\s*=|\sstyle\s*=|(?:href|src)\s*=\s*["'](?!#)/iu;
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const invalidIcons = localMarkPaths.filter((iconPath) => {
    const contents = readFileSync(join(root, iconPath));
    if (iconPath.endsWith(".svg")) {
      const svg = contents.toString("utf8");
      return !/^<svg\s/iu.test(svg)
        || !/viewBox=/u.test(svg)
        || contents.byteLength > 64 * 1024
        || unsafeSvg.test(svg);
    }
    const width = contents.byteLength >= 24 ? contents.readUInt32BE(16) : 0;
    const height = contents.byteLength >= 24 ? contents.readUInt32BE(20) : 0;
    return !contents.subarray(0, 8).equals(pngSignature)
      || contents.byteLength > 512 * 1024
      || width < 1
      || height < 1
      || width > 512
      || height > 512;
  });
  const notices = existsSync(join(root, "assets/services/THIRD_PARTY_NOTICES.md"))
    ? read("assets/services/THIRD_PARTY_NOTICES.md")
    : "";
  const markNames = ["Jellyfin", "Seerr", "Radarr", "Sonarr", "Prowlarr", "qBittorrent", "Bazarr", "Proxmox", "Portainer", "VM", "LXC"];
  record(
    invalidIcons.length === 0
      && /make no network requests/iu.test(notices)
      && /does not imply sponsorship,\s*affiliation, or endorsement/iu.test(notices)
      && markNames.every((name) => notices.includes(name)),
    "locally bundled service and workload marks are bounded inert assets with source and trademark notices",
    invalidIcons.join(", ")
  );
}

if (existsSync(join(root, "server/broker.mjs"))) {
  const broker = read("server/broker.mjs");
  record(
    /relative\.startsWith\("assets\/services\/"\).*relative\.startsWith\("assets\/workloads\/"\)/su.test(broker)
      && /Cache-Control", "private, max-age=86400"/u.test(broker)
      && /response\.setHeader\("ETag", etag\)/u.test(broker),
    "local service and workload icons use deterministic private ETags without a runtime CDN"
  );
}

if (existsSync(join(root, "index.html"))) {
  const shell = read("index.html");
  const shellStyles = read("styles.css");
  record(
    /<script\s+type="module"\s+src="[.]\/src\/app-v5[.]js"><\/script>/u.test(shell)
      && /<link\s+rel="stylesheet"\s+href="[.]\/src\/ui\/operations[.]css"\s*\/?>/u.test(shell)
      && /<link\s+rel="stylesheet"\s+href="[.]\/src\/ui\/control[.]css"\s*\/?>/u.test(shell)
      && /<link\s+rel="stylesheet"\s+href="[.]\/src\/ui\/retro[.]css"\s*\/?>/u.test(shell)
      && /href="#\/home"\s+data-route="home"/u.test(shell)
      && !/<script[^>]+src="[.]\/app[.]js"/u.test(shell),
    "container shell loads the Helmsman session client and operations styles instead of the legacy browser client"
  );
  record(
    (shell.match(/[.]\/assets\/helmsman-logo[.]png/gu) || []).length === 2
      && /class="brand-lockup"/u.test(shell)
      && /class="mobile-brand"/u.test(shell),
    "expanded and compact navigation surfaces use the supplied Helmsman identity"
  );
  record(
    /data-action="switch-workspace"\s+data-workspace="media"/u.test(shell)
      && /data-action="switch-workspace"\s+data-workspace="infrastructure"/u.test(shell)
      && /aria-pressed="true"/u.test(shell)
      && /aria-pressed="false"/u.test(shell),
    "desktop and compact navigation expose semantic Media and Infrastructure workspace controls"
  );
  const workspaceRouteCount = (workspace, route) => (
    shell.match(new RegExp(`<a[^>]*class="[^"]*workspace-${workspace}-only[^"]*"[^>]*data-route="${route}"[^>]*>`, "gu")) || []
  ).length;
  const sharedRouteCount = (route) => (
    shell.match(new RegExp(`<a(?=[^>]*data-route="${route}")(?![^>]*workspace-(?:media|infrastructure)-only)[^>]*>`, "gu")) || []
  ).length;
  record(
    ["home", "discover", "library", "requests", "activity", "calendar", "health", "connections"]
      .every((route) => workspaceRouteCount("media", route) === 2)
      && ["overview", "environments", "nodes", "workloads", "portainer", "incidents"]
        .every((route) => workspaceRouteCount("infrastructure", route) === 2)
      && ["logs", "settings"].every((route) => sharedRouteCount(route) === 2)
      && /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/u.test(shellStyles),
    "desktop and mobile navigation isolate workspace routes while retaining shared Logs and Settings"
  );
}

if (existsSync(join(root, "src/app-v5.js")) && existsSync(join(root, "src/ui/operations-views.js"))) {
  const application = read("src/app-v5.js");
  const operationsViews = read("src/ui/operations-views.js");
  record(
    /id="infrastructure-environments"/u.test(application)
      && /data-action="open-infrastructure-target"/u.test(application)
      && /data-action="open-infrastructure-environment-detail"/u.test(application)
      && /data-action="open-infrastructure-node"/u.test(application)
      && /data-action="open-infrastructure-workload"/u.test(application)
      && /renderInfrastructureOverview/u.test(application)
      && /export function normalizeInfrastructureSnapshot/u.test(operationsViews)
      && /export function renderInfrastructureOverview/u.test(operationsViews),
    "the authenticated client renders separate Proxmox configuration and infrastructure health views"
  );
  record(
    /function renderPortainerPage/u.test(application)
      && /state\.route === "portainer"/u.test(application)
      && /\/api\/v2\/infrastructure\/services/u.test(application)
      && /open-portainer-service/u.test(application)
      && /assets\/services\/portainer\.svg/u.test(operationsViews)
      && /startsWith\("portainer-"\)/u.test(operationsViews),
    "the authenticated Infrastructure client renders Portainer servers and inventory without adding Portainer to Media"
  );
}

if (existsSync(join(root, "package.json"))) {
  try {
    const packageJson = JSON.parse(read("package.json"));
    record(
      packageJson.name === "helmsman"
        && packageJson.version === "0.10.0-beta.9"
        && packageJson.scripts?.serve === "node server/index.mjs serve"
        && packageJson.scripts?.["check:broker"] === "node --test tests/control-plane.test.mjs"
        && /tests\/secrets[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/session-auth[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/rename-compatibility[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/monitor[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/state-infrastructure-targets[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/infrastructure-control-plane[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/proxmox-environment-failover[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/proxmox-probes[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/proxmox-monitor[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/proxmox-transport[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/infrastructure-service-control-plane[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/portainer-backend[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/portainer-monitor[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/portainer-transport[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/media-model[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/media-artwork[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/media-artwork-control-plane[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /operations-view-contract[.]mjs/u.test(packageJson.scripts?.["check:operations"] || "")
        && /runtime-v5-smoke[.]mjs/u.test(packageJson.scripts?.["check:operations"] || ""),
      "package identity and checks cover the Helmsman media/infrastructure control plane, sessions, monitor, probes, and operations UI"
    );
  } catch (error) {
    record(false, "package identity and checks cover the Helmsman media/infrastructure control plane, sessions, monitor, probes, and operations UI", error.message);
  }
}

if (existsSync(join(root, "deploy/compose.hardened.yaml"))) {
  const compose = existsSync(join(root, "compose.yaml")) ? read("compose.yaml") : "";
  const hardened = read("deploy/compose.hardened.yaml");
  record(
    !/HELMSMAN_MASTER_KEY_FILE/iu.test(compose)
      && /HELMSMAN_MASTER_KEY_FILE:\s*\/run\/secrets\/helmsman_master_key/u.test(hardened)
      && /secrets:\s*\n\s*- source:\s*helmsman_master_key/u.test(hardened)
      && /target:\s*helmsman_master_key/u.test(hardened)
      && /uid:\s*["']10001["']/u.test(hardened)
      && /gid:\s*["']10001["']/u.test(hardened)
      && /mode:\s*0?400/u.test(hardened)
      && /^secrets:\s*\n\s{2}helmsman_master_key:\s*\n\s{4}environment:\s*HELMSMAN_MASTER_KEY\s*$/mu.test(hardened)
      && !/^\s*file:/mu.test(hardened)
      && !forbiddenServiceEnvironment.test(hardened)
      && !privateServiceAddress.test(hardened),
    "optional hardened override materializes an environment-sourced key as a non-root-readable secret"
  );
}

if (existsSync(join(root, "README.md")) && existsSync(join(root, "deploy/DOCKER.md"))) {
  const keyGuides = [read("README.md"), read("deploy/DOCKER.md")];
  record(
    keyGuides.every((guide) => /64-character hex key/iu.test(guide))
      && keyGuides.every((guide) => /outside the project and `[.]env`/iu.test(guide))
      && keyGuides.every((guide) => /top-level secrets sourced from an environment variable/iu.test(guide))
      && keyGuides.every((guide) => /openssl rand -hex 32/u.test(guide))
      && keyGuides.every((guide) => /export HELMSMAN_MASTER_KEY=/u.test(guide))
      && keyGuides.every((guide) => /\$env:HELMSMAN_MASTER_KEY\s*=/u.test(guide))
      && keyGuides.every((guide) => /exact same key for every redeploy, container recreation, migration, and restore/iu.test(guide))
      && keyGuides.every((guide) => /Never put the key in `[.]env`, Compose YAML, shell history, or the release directory/iu.test(guide))
      && keyGuides.every((guide) => !/openssl rand 32 >\s+secrets\/command-master[.]key/u.test(guide)),
    "operator guides create, export, preserve, and restore the environment-sourced master key safely"
  );
  record(
    keyGuides.every((guide) => /authenticated browsers?/iu.test(guide))
      && keyGuides.every((guide) => /allowlisted `source`, `type`, and `message` fields/iu.test(guide))
      && keyGuides.every((guide) => /(?:bounds? (?:their )?count and length|count and length are bounded)/iu.test(guide))
      && keyGuides.every((guide) => /redact/iu.test(guide))
      && keyGuides.every((guide) => /escapes? (?:them|every field) (?:again )?before display/iu.test(guide))
      && keyGuides.every((guide) => /never copied into incidents, events, history, application logs, or persistent files/iu.test(guide))
      && keyGuides.every((guide) => /Raw response bodies and raw error bodies are never exposed/iu.test(guide)),
    "operator guides define the bounded transient live-health report boundary"
  );
  record(
    keyGuides.every((guide) => /Media and Infrastructure/iu.test(guide))
      && keyGuides.every((guide) => /Proxmox/iu.test(guide))
      && keyGuides.every((guide) => /read-only/iu.test(guide))
      && keyGuides.every((guide) => /API token ID/iu.test(guide))
      && keyGuides.every((guide) => /token secret/iu.test(guide))
      && keyGuides.every((guide) => /write-only/iu.test(guide))
      && keyGuides.every((guide) => /Pinned SHA-256 fingerprint/iu.test(guide))
      && keyGuides.every((guide) => /no (?:Docker socket|infrastructure control actions)|no Docker socket/iu.test(guide))
      && keyGuides.every((guide) => /(?:do not place|Do not add)[^.\n]*[.]env/iu.test(guide)),
    "operator guides define the multi-instance read-only Proxmox boundary without environment secrets or host control"
  );
  record(
    keyGuides.every((guide) => ["Home", "Discover", "Library", "Requests", "Activity", "Calendar", "Health", "Connections"]
      .every((section) => new RegExp(`\\b${section}\\b`, "iu").test(guide)))
      && keyGuides.every((guide) => /Requested[^\n]{0,40}Monitored[^\n]{0,40}Downloading[^\n]{0,40}Imported[^\n]{0,40}Available/iu.test(guide))
      && keyGuides.every((guide) => /opaque[^.\n]*(?:artwork|Helmsman URL)|artwork[^.\n]*opaque/iu.test(guide))
      && keyGuides.every((guide) => /(?:artwork cache|cache)[^.\n]*in memory|in-memory[^.\n]*(?:artwork|cache)/iu.test(guide))
      && keyGuides.every((guide) => /cannot approve requests/iu.test(guide))
      && keyGuides.every((guide) => /(?:service marks|marks)[^.\n]*(?:bundled locally|icon CDN|runtime icon CDN)/iu.test(guide))
      && keyGuides.every((guide) => /state schema(?: to)? [34]/iu.test(guide))
      && /state schema(?: to)? 4/iu.test(keyGuides[0])
      && keyGuides.every((guide) => /(?:each visible node|node's fixed read-only task route)/iu.test(guide))
      && keyGuides.every((guide) => /raw UPIDs/iu.test(guide)),
    "operator guides document the read-only desktop media lifecycle, opaque in-memory artwork, local marks, schema compatibility, and per-node Proxmox activity"
  );
  record(
    keyGuides.every((guide) => /Portainer/iu.test(guide))
      && keyGuides.every((guide) => /Infrastructure/iu.test(guide))
      && keyGuides.every((guide) => /System trust/iu.test(guide))
      && keyGuides.every((guide) => /Pinned SHA-256 fingerprint/iu.test(guide))
      && keyGuides.every((guide) => /X-API-Key/iu.test(guide))
      && keyGuides.every((guide) => /stopped (?:Portainer )?containers? (?:remain|are) informational/iu.test(guide))
      && keyGuides.every((guide) => /no (?:general )?(?:Portainer or Docker|Portainer write operations|Docker) API proxy|There is no general Portainer or Docker API proxy/iu.test(guide))
      && keyGuides.every((guide) => /(?:do not put|Do not place)[^\n]*Portainer[^\n]*[.]env|Do not add[^\n]*Portainer[^\n]*[.]env/iu.test(guide)),
    "operator guides keep Portainer HTTPS-only, read-only, Infrastructure-scoped, and free of environment credentials"
  );
}

if (existsSync(join(root, ".github/workflows/container.yml"))) {
  const workflow = read(".github/workflows/container.yml");
  const usesLines = workflow.match(/^\s*uses:\s+[^\s#]+(?:\s+#.*)?$/gmu) || [];
  record(
    usesLines.length === 11
      && usesLines.every((line) => /@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/u.test(line)),
    "container workflow pins every external action to a full commit with a release comment",
    usesLines.join("; ")
  );
  record(
    /version="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/u.test(workflow)
      && /expected="v\$\{version\}"/u.test(workflow)
      && /--build-arg HELMSMAN_VERSION="\$\{\{ needs\.test\.outputs\.version \}\}"/u.test(workflow)
      && !/HELMSMAN_VERSION=0\.6\./u.test(workflow),
    "container workflow validates the tag against package metadata and smoke tests that exact version"
  );
  record(
    /repository="\$\{GITHUB_REPOSITORY,,\}"/u.test(workflow)
      && /images:\s*\$\{\{ env\.REGISTRY \}\}\/\$\{\{ needs\.test\.outputs\.repository \}\}/u.test(workflow)
      && /flavor: latest=false/u.test(workflow)
      && /type=semver,pattern=\{\{version\}\}/u.test(workflow)
      && /type=raw,value=beta,enable=\$\{\{ needs\.test\.outputs\.is_beta == 'true' \}\}/u.test(workflow)
      && /type=raw,value=latest,enable=\$\{\{ needs\.test\.outputs\.is_prerelease == 'false' \}\}/u.test(workflow)
      && /type=sha,format=long/u.test(workflow)
      && /digest:\s*\$\{\{ steps\.push\.outputs\.digest \}\}/u.test(workflow)
      && /push: true/u.test(workflow),
    "container workflow publishes version, beta, stable-latest, and full-SHA channels and exposes the multi-architecture digest"
  );
  record(
    /repository="\$\{GITHUB_REPOSITORY,,\}"/u.test(workflow)
      && /RELEASE_DIGEST:\s*\$\{\{ needs\.image\.outputs\.digest \}\}/u.test(workflow)
      && /image_ref="ghcr\.io\/\$\{repository\}@\$\{RELEASE_DIGEST\}"/u.test(workflow)
      && /sed -i "s#\$\{tagged_ref\}#\$\{image_ref\}#g"/u.test(workflow)
      && /sha256sum compose\.yaml container\.env\.example > SHA256SUMS/u.test(workflow)
      && /gh release download/u.test(workflow)
      && /cmp --silent/u.test(workflow)
      && /gh release create/u.test(workflow)
      && !/gh release upload/u.test(workflow)
      && !/--clobber/u.test(workflow)
      && /group:\s*container-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/u.test(workflow),
    "tagged workflow atomically publishes digest-pinned lowercase release assets and verifies existing assets without replacement"
  );
}

if (existsSync(join(root, "deploy/DOCKER.md"))) {
  const guide = read("deploy/DOCKER.md");
  const edgePaths = [
    "deploy/Caddyfile.container-edge.lan.example",
    "deploy/Caddyfile.container-edge.authentik.example"
  ];
  const edgeFiles = edgePaths.filter((path) => existsSync(join(root, path))).map(read);
  record(
    /does not contain Caddy, Authentik/iu.test(guide)
      && /does not specifically require Caddy/iu.test(guide)
      && /## Optional Caddy and Authentik/iu.test(guide)
      && /Authentik is optional/iu.test(guide)
      && /Select the Media workspace/iu.test(guide)
      && /Select Infrastructure/iu.test(guide)
      && /Do not add media, Proxmox, or Portainer URLs, API keys, passwords, token IDs, token secrets, access tokens, Helmsman access keys, cookies, setup tokens, or Authentik secrets to `[.]env`/iu.test(guide),
    "deployment guide keeps media and infrastructure setup in the UI and makes Caddy and Authentik optional"
  );
  record(
    edgeFiles.length === edgePaths.length
      && edgeFiles.every((contents) => /Optional Helmsman v0\.10 HTTPS edge/iu.test(contents))
      && edgeFiles.every((contents) => /Proxy every path unchanged|Protect every application path/iu.test(contents))
      && edgeFiles.every((contents) => !forbiddenServiceEnvironment.test(contents)),
    "optional Helmsman edge examples proxy the whole control plane without defining media-service topology"
  );

  const authentikEdge = read("deploy/Caddyfile.container-edge.authentik.example");
  const cookieFilters = authentikEdge.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('header_up Cookie "(?i)'));
  record(
    cookieFilters.length === 2
      && cookieFilters.every((line) => line.includes("JFC_SESSION|JFC_(SEERR|QBIT)_[0-9a-f]{32}"))
      && cookieFilters.every((line) => line.includes("|SID|"))
      && cookieFilters.every((line) => line.includes("QBT_SID(_[0-9]+)?"))
      && cookieFilters.every((line) => line.includes("connect[.]sid"))
      && !/header_up\s+-Cookie/iu.test(authentikEdge)
      && /customized\s+upstream cookie names/iu.test(authentikEdge)
      && /JFC_SESSION[\s\S]{0,160}authentication subrequest/iu.test(guide)
      && /Stripping the entire `Cookie` header/iu.test(guide),
    "Authentik subrequests strip the Helmsman browser session and legacy upstream sessions while preserving its login cookie"
  );

  const recoveryCommands = [
    "docker compose stop helmsman",
    "docker compose run --rm --no-deps helmsman rotate-access-key --confirm",
    "docker compose up -d"
  ];
  const recoverySectionStart = guide.indexOf("If the access key is lost");
  const recoverySection = recoverySectionStart >= 0 ? guide.slice(recoverySectionStart) : "";
  record(
    recoveryCommands.every((command) => recoverySection.includes(command))
      && recoveryCommands.every((command, index) => index === 0 || recoverySection.indexOf(command) > recoverySection.indexOf(recoveryCommands[index - 1]))
      && /preserves the instance ID/iu.test(recoverySection)
      && /network policy/iu.test(recoverySection)
      && /registered targets/iu.test(recoverySection)
      && /encrypted credentials/iu.test(recoverySection)
      && /revokes all browser sessions/iu.test(recoverySection)
      && /standard output/iu.test(recoverySection)
      && /not placed in subsequent application logs/iu.test(recoverySection),
    "access-key recovery stops the broker, prints the replacement once, revokes sessions, and preserves configured services"
  );
  record(
    /reusable 256-bit Helmsman access key/iu.test(guide)
      && /one-year session/iu.test(guide)
      && /bound to the exact scheme, host, and port/iu.test(guide)
      && /stores only its SHA-256 verifier/iu.test(guide)
      && /never reads the access key from `[.]env` or a URL, writes it to browser storage, or records it in application logs/iu.test(guide)
      && /upgrading from v0[.]10[.]0-beta[.]8/iu.test(guide)
      && /existing browser sessions migrate and remain valid/iu.test(guide)
      && /Settings and create the first access key/iu.test(guide),
    "deployment guide documents universal access-key login, one-year origin-bound sessions, secret handling, and beta.8 migration"
  );
  record(
    /Upgrade from Jellofin Command v0\.4 or v0\.5/iu.test(guide)
      && /HELMSMAN_DATA_VOLUME/iu.test(guide)
      && /jellofin-command_jellofin-command-data/u.test(guide)
      && /same volume, external key, and browser origin/iu.test(guide),
    "upgrade guide preserves the v0.5 data, credential, and session trust boundaries"
  );

  const caddyVersion = spawnSync("caddy", ["version"], { encoding: "utf8" });
  if (caddyVersion.error?.code !== "ENOENT") {
    const adaptations = edgePaths.map((path) => ({
      path,
      result: spawnSync("caddy", ["adapt", "--config", join(root, path), "--adapter", "caddyfile", "--validate"], {
        encoding: "utf8"
      })
    }));
    const failedAdaptations = adaptations.filter(({ result }) => result.status !== 0);
    record(
      failedAdaptations.length === 0,
      "installed Caddy adapts and validates both optional edge examples",
      failedAdaptations.map(({ path, result }) => `${path}: ${(result.stderr || result.stdout || "failed").trim()}`).join("; ")
    );
  }
}

if (failures.length) {
  console.error(`Container contract failed with ${failures.length} issue${failures.length === 1 ? "" : "s"}:`);
  failures.forEach((failure) => console.error(`  - ${failure}`));
  console.error(`${passes.length} checks passed.`);
  process.exitCode = 1;
} else {
  console.log(`Container contract passed: ${passes.length} portable, least-privilege checks.`);
}
