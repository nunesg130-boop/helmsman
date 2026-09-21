import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

const serviceIconAssets = Object.freeze([
  Object.freeze({ service: "Bazarr", path: "assets/services/bazarr.png", width: 200, height: 200, hash: "aefd3aac28d67fd4d48b24dd2ae33b3b0a9f26e7950c2e1d34bef98cecf18876", format: "png" }),
  Object.freeze({ service: "Jellyfin", path: "assets/services/jellyfin.svg", width: 512, height: 512, hash: "7f53cf083dbb3119ec8c5acbd8049c5033227617e461540f70591ac109124306", format: "svg", viewBox: "0 0 512 512", auditedInlineStyle: true }),
  Object.freeze({ service: "Portainer", path: "assets/services/portainer.svg", width: 168.18, height: 218.62, hash: "5d1e07021683d15ea67225c60975729f4ee0ed380f3a0fb21ffb2ad00eb6e85b", format: "svg", viewBox: "0.72 0 168.18 218.62" }),
  Object.freeze({ service: "Prowlarr", path: "assets/services/prowlarr.png", width: 460, height: 460, hash: "fe75eafc608e288c9736b740afe1c30c715eaf56dc284fec1926491d245fea52", format: "png" }),
  Object.freeze({ service: "Proxmox", path: "assets/services/proxmox.png", width: 595, height: 516, hash: "c8dca83af2f6519f025aad6325cc702ad491b19727bae42b9b87b6d20fa13440", format: "png" }),
  Object.freeze({ service: "qBittorrent", path: "assets/services/qbittorrent.svg", width: 1024, height: 1024, hash: "f96f40f70830e245cc184291d1173aa705b68b0865970b44aa1ee63350bcb9c2", format: "svg", viewBox: "0 0 1024 1024" }),
  Object.freeze({ service: "Radarr", path: "assets/services/radarr.svg", width: 512, height: 512, hash: "4767088c158c5507957232782f491ad1c3a048c013ce04d58da81148158a89b3", format: "svg", viewBox: "0 0 512 512", auditedInlineStyle: true }),
  Object.freeze({ service: "Seerr", path: "assets/services/seerr.svg", width: 96, height: 96, hash: "b12e5dfd641d961cfb68360da33fe28873b95ea9b64c23233d5b87a37cbfa4c4", format: "svg", viewBox: "0 0 96 96", auditedStyleElement: true }),
  Object.freeze({ service: "Sonarr", path: "assets/services/sonarr.svg", width: 512, height: 512, hash: "a5debe565281eb16b746d75b9ce72e22f2fb15c19b4f55428fdf62b84be79306", format: "svg", viewBox: "0 0 512 512", auditedInlineStyle: true })
]);

function jpegDimensions(contents) {
  if (contents.byteLength < 4 || contents[0] !== 0xff || contents[1] !== 0xd8) return null;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < contents.byteLength) {
    if (contents[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < contents.byteLength && contents[offset] === 0xff) offset += 1;
    const marker = contents[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= contents.byteLength) return null;
    const length = contents.readUInt16BE(offset);
    if (length < 2 || offset + length > contents.byteLength) return null;
    if (startOfFrameMarkers.has(marker) && length >= 7) {
      return { height: contents.readUInt16BE(offset + 3), width: contents.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function yamlJobBlock(contents, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const start = contents.search(new RegExp(`^  ${escapedName}:\\s*$`, "mu"));
  if (start < 0) return "";
  const remainder = contents.slice(start + 1);
  const next = remainder.search(/^  [a-z][a-z0-9-]*:\s*$/mu);
  return next < 0 ? contents.slice(start) : contents.slice(start, start + 1 + next);
}

const requiredFiles = [
  "Dockerfile",
  "compose.yaml",
  "compose.dev.yaml",
  ".dockerignore",
  ".gitattributes",
  ".gitignore",
  "LICENSE",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "PUBLIC_RELEASE_CHECKLIST.md",
  "container.env.example",
  "GITHUB.md",
  "package.json",
  "Publish-Helmsman.ps1",
  "Publish-Helmsman.cmd",
  "scripts/Publish-HelmsmanRelease.ps1",
  "scripts/bootstrap-contract.mjs",
  "scripts/publisher-contract.mjs",
  "server/index.mjs",
  "server/broker.mjs",
  "server/control-plane.mjs",
  "server/event-journal.mjs",
  "server/health-engine.mjs",
  "server/lock.mjs",
  "server/loki.mjs",
  "server/loki-probes.mjs",
  "server/loki-transport.mjs",
  "server/media-artwork.mjs",
  "server/media-model.mjs",
  "server/monitor.mjs",
  "server/network.mjs",
  "server/portainer-model.mjs",
  "server/portainer-probes.mjs",
  "server/persistent-cache.mjs",
  "server/proxmox-probes.mjs",
  "server/routes.mjs",
  "server/secrets.mjs",
  "server/seerr-series-seasons.mjs",
  "server/service-probes.mjs",
  "server/session-auth.mjs",
  "server/state.mjs",
  "tests/state-infrastructure-targets.test.mjs",
  "tests/infrastructure-control-plane.test.mjs",
  "tests/action-routes.test.mjs",
  "tests/proxmox-probes.test.mjs",
  "tests/proxmox-monitor.test.mjs",
  "tests/proxmox-transport.test.mjs",
  "tests/infrastructure-service-control-plane.test.mjs",
  "tests/portainer-backend.test.mjs",
  "tests/portainer-monitor.test.mjs",
  "tests/portainer-transport.test.mjs",
  "tests/persistent-cache.test.mjs",
  "tests/event-journal.test.mjs",
  "tests/logging-control-plane.test.mjs",
  "tests/loki-control-plane.test.mjs",
  "tests/loki-model.test.mjs",
  "tests/loki-probes.test.mjs",
  "tests/loki-routes.test.mjs",
  "tests/loki-transport.test.mjs",
  "tests/helpers/self-signed-tls.mjs",
  "tests/media-model.test.mjs",
  "tests/media-artwork.test.mjs",
  "tests/media-artwork-control-plane.test.mjs",
  "tests/seerr-series-seasons.test.mjs",
  "src/app-v5.js",
  "src/ui/control.css",
  "src/ui/logging.css",
  "src/ui/operations.css",
  "src/ui/operations-views.js",
  "src/ui/obsidian-glass.css",
  "src/ui/retro.css",
  "assets/helmsman-logo.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/icon-maskable-512.png",
  "assets/services/THIRD_PARTY_NOTICES.md",
  "assets/services/bazarr.png",
  "assets/services/jellyfin.svg",
  "assets/services/portainer.svg",
  "assets/services/prowlarr.png",
  "assets/services/proxmox.png",
  "assets/services/qbittorrent.svg",
  "assets/services/radarr.svg",
  "assets/services/seerr.svg",
  "assets/services/sonarr.svg",
  "assets/services/licenses/GPL-2.0.txt",
  "assets/services/licenses/GPL-3.0.txt",
  "assets/services/licenses/MIT-Seerr.txt",
  "assets/services/licenses/Zlib-Portainer.txt",
  "assets/workloads/vm.svg",
  "assets/workloads/container.svg",
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
  "Helmsman v1.3.0 includes its unified media model, bounded fixed actions, Proxmox and Portainer infrastructure monitors, encrypted store, persistent cache, Obsidian Glass operations UI, logging, and deployment contracts",
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
    /^ARG HELMSMAN_VERSION=1\.3\.0$/mu.test(dockerfile)
      && /^ARG HELMSMAN_REVISION=unknown$/mu.test(dockerfile)
      && /org\.opencontainers\.image\.title="Helmsman"/u.test(dockerfile)
      && /org\.opencontainers\.image\.licenses="AGPL-3\.0-only"/u.test(dockerfile)
      && !/org\.opencontainers\.image\.title="Jellofin Command"/u.test(dockerfile),
    "image metadata carries the Helmsman v1.3.0 identity and license"
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
    "COPY --chown=0:0 assets/services/THIRD_PARTY_NOTICES.md assets/services/bazarr.png assets/services/jellyfin.svg assets/services/portainer.svg assets/services/prowlarr.png assets/services/proxmox.png assets/services/qbittorrent.svg assets/services/radarr.svg assets/services/seerr.svg assets/services/sonarr.svg ./assets/services/",
    "COPY --chown=0:0 assets/services/licenses/ ./assets/services/licenses/",
    "COPY --chown=0:0 assets/workloads/vm.svg assets/workloads/container.svg ./assets/workloads/",
    "COPY --chown=0:0 src/app-v5.js ./src/app-v5.js",
    "COPY --chown=0:0 src/ui/operations-views.js src/ui/operations.css src/ui/control.css src/ui/logging.css src/ui/retro.css src/ui/obsidian-glass.css ./src/ui/",
    "COPY --chown=0:0 server ./server",
    "COPY --chown=0:0 package.json ./package.json",
    "COPY --chown=0:0 LICENSE ./LICENSE"
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
    /const DEFAULT_VERSION = "1\.3\.0"/u.test(broker)
      && /process\.env\.HELMSMAN_VERSION/u.test(broker)
      && /\^\[0-9A-Za-z\]\[0-9A-Za-z\.\+-\]\{0,63\}\$/u.test(broker),
    "runtime version follows the validated immutable v1.3.0 image metadata"
  );
}

if (existsSync(join(root, "server/index.mjs"))
  && existsSync(join(root, "server/session-auth.mjs"))
  && existsSync(join(root, "server/control-plane.mjs"))
  && existsSync(join(root, "server/broker.mjs"))
  && existsSync(join(root, "server/routes.mjs"))
  && existsSync(join(root, "server/secrets.mjs"))) {
  const index = read("server/index.mjs");
  const sessionAuth = read("server/session-auth.mjs");
  const controlPlane = read("server/control-plane.mjs");
  const broker = read("server/broker.mjs");
  const routes = read("server/routes.mjs");
  const secrets = read("server/secrets.mjs");
  const claimBlock = controlPlane.match(/async function claim\(request, response\)[\s\S]*?\n  async function issueJellyfinBrowserSession/u)?.[0] || "";
  const accessLoginBlock = controlPlane.match(/async function accessLogin\(request, response\)[\s\S]*?\n  async function sessions/u)?.[0] || "";
  record(
    /const SESSION_STATE_VERSION = 4;/u.test(sessionAuth)
      && /const ACCESS_KEY_SESSION_STATE_VERSION = 2;/u.test(sessionAuth)
      && /const DEFAULT_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1_000;/u.test(sessionAuth)
      && /hasExactKeys\(value, \["version", "revision", "accessKeyHash", "owner", "sessions", "integrity"\]\)/u.test(sessionAuth)
      && /hasExactKeys\(owner, \[[\s\S]*?"provider",[\s\S]*?"serverId",[\s\S]*?"userId",[\s\S]*?"username",[\s\S]*?"jellyfinUrl",[\s\S]*?"targetRevision",[\s\S]*?"boundaryHash",[\s\S]*?"enrolledAt"[\s\S]*?\]\)/u.test(sessionAuth)
      && /"id", "name", "origin", "host", "tokenHash", "createdAt", "expiresAt", "principal"/u.test(sessionAuth)
      && /sessionStateIntegrityPayload/u.test(sessionAuth)
      && /stateIntegrityTag/u.test(sessionAuth)
      && /async enrollOwnerAndIssue\(options\)[\s\S]*?next[.]owner = owner;[\s\S]*?next[.]accessKeyHash = null;[\s\S]*?next[.]sessions = \{\};/u.test(sessionAuth)
      && /async loginOwner\(options\)/u.test(sessionAuth)
      && /async markVerified\(sessionId, identity/u.test(sessionAuth),
    "sealed session schema v4 binds one Jellyfin owner and principal-backed 30-day browser sessions while migrating the beta.2 verifier"
  );
  record(
    /sessionStore[.]issue\(\{[\s\S]*?ttlMs: SETUP_SESSION_TTL_MS/u.test(claimBlock)
      && /enroll the Jellyfin owner account to finish browser authentication/u.test(claimBlock)
      && !/claimAccess|accessKey\s*:/u.test(claimBlock)
      && /url[.]pathname === "\/api\/v2\/auth\/jellyfin\/enroll"/u.test(controlPlane)
      && /url[.]pathname === "\/api\/v2\/auth\/jellyfin\/login"/u.test(controlPlane)
      && /requireExactKeys\(body, \["username", "password", "deviceName", "origin"\]\)/u.test(controlPlane)
      && /sessionStore[.]enrollOwnerAndIssue/u.test(controlPlane)
      && /sessionStore[.]loginOwner/u.test(controlPlane),
    "first claim issues a keyless setup session and Jellyfin username/password routes enroll or sign in the exact owner"
  );
  record(
    /const BROWSER_AUTH_NAMESPACE_PREFIX = "browser-auth-";/u.test(controlPlane)
      && /browserAuthNamespace\(sessionId\)/u.test(controlPlane)
      && /browserAuthField\(preparedSession[.]credentialBinding\)/u.test(controlPlane)
      && /credentialStore[.]replaceServiceCredentials\(stagedNamespace, \{[\s\S]*?\[browserAuthField\(preparedSession[.]credentialBinding\)\]: authenticated[.]token/u.test(controlPlane)
      && /credentialStore[.]useCredential\([\s\S]*?browserAuthNamespace\(record[.]id\),[\s\S]*?browserAuthField\(jellyfinSessionCredentialBinding\(record\)\)/u.test(controlPlane)
      && /connectionAuthorizationBoundaryHash/u.test(controlPlane)
      && /sessionStateIntegrityTag/u.test(secrets)
      && /const ALGORITHM = "AES-256-GCM";/u.test(secrets)
      && /const MAX_SERVICES = 192;/u.test(secrets),
    "each Jellyfin browser token uses a bounded browser-auth namespace in the encrypted server-side credential store"
  );
  record(
    /exact: new Set\(\["\/Users\/AuthenticateByName", "\/Sessions\/Logout"\]\)/u.test(routes)
      && /"\/Users\/Me"/u.test(routes)
      && /isJellyfinAuthentication[\s\S]*?internalOnly: isLogin \|\| isJellyfinAuthentication/u.test(routes)
      && /authorizeBridgeRoute\("jellyfin", "GET", "\/bridge\/jellyfin\/Users\/Me"\)/u.test(broker)
      && /authorizeBridgeRoute\("jellyfin", "POST", "\/bridge\/jellyfin\/Sessions\/Logout"\)/u.test(broker),
    "Jellyfin identity validation and logout use fixed internal-only /Users/Me and /Sessions/Logout routes"
  );
  record(
    /url[.]pathname === "\/api\/v2\/access\/login"/u.test(controlPlane)
      && /sessionStore[.]ownerConfigured\(\) \|\| !sessionStore[.]accessKeyConfigured\(\)/u.test(accessLoginBlock)
      && /ACCESS_KEY_UNAVAILABLE/u.test(accessLoginBlock)
      && /legacyAccessKeyAvailable: !owner && sessionStore[.]accessKeyConfigured\(\)/u.test(controlPlane)
      && !/url[.]pathname === "\/api\/v2\/access\/rotate"/u.test(controlPlane)
      && !/command === "rotate-access-key"/u.test(index)
      && !/rotate-access-key --confirm/u.test(index),
    "the beta.2 access-key route is migration-only and v1.3.0 exposes no access-key rotation route or CLI"
  );
  record(
    /command === "reset-access"/u.test(index)
      && /process[.]argv[.]length !== 4 \|\| process[.]argv\[3\] !== "--confirm"/u.test(index)
      && /sessions[.]clearAccess\(\)/u.test(index)
      && /store[.]resetAccess\(\)/u.test(index)
      && /Helmsman access was reset[.] Saved services and encrypted credentials were preserved[.] Start the broker to receive a new setup token[.]/u.test(index)
      && !/Helmsman access key:/u.test(index),
    "the confirmed reset-access CLI revokes browser access and restarts setup without printing a replacement key"
  );
}

if (existsSync(join(root, "server/media-model.mjs"))
  && existsSync(join(root, "server/media-artwork.mjs"))
  && existsSync(join(root, "server/persistent-cache.mjs"))) {
  const mediaModel = read("server/media-model.mjs");
  const mediaArtwork = read("server/media-artwork.mjs");
  const persistentCache = read("server/persistent-cache.mjs");
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
      && !/node:fs/u.test(mediaArtwork)
      && /DEFAULT_MAXIMUM_ARTWORK_BYTES = 512 \* 1024 \* 1024/u.test(persistentCache)
      && /DEFAULT_MAXIMUM_ARTWORK_ENTRIES = 2_048/u.test(persistentCache)
      && /DEFAULT_MAXIMUM_SNAPSHOT_AGE_MS = 30 \* 24 \* 60 \* 60 \* 1_000/u.test(persistentCache)
      && /O_NOFOLLOW/u.test(persistentCache)
      && /atomicWrite/u.test(persistentCache),
    "media artwork uses bounded memory and private persistent tiers, miss coalescing, fixed scheduling, and guarded atomic cache files"
  );
}

if (existsSync(join(root, "compose.yaml"))) {
  const compose = read("compose.yaml");
  record(
    /^name:\s*helmsman\s*$/mu.test(compose)
      && /^services:\s*\n\s{2}helmsman:\s*$/mu.test(compose)
      && compose.includes('${HELMSMAN_IMAGE:-ghcr.io/OWNER/REPOSITORY:1.3.0}')
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
      && /HELMSMAN_VERSION:\s*["']1\.3\.0["']/u.test(developmentCompose)
      && /HELMSMAN_REVISION:\s*["']local["']/u.test(developmentCompose)
      && /image:\s*["']helmsman:1\.3\.0["']/u.test(developmentCompose),
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
    /const STATE_VERSION = 5;/u.test(state)
      && /infrastructureTargets:\s*\{\}/u.test(state)
      && /infrastructureServices:\s*\{\}/u.test(state)
      && /value\.version === 1/u.test(state)
      && /value\.infrastructureTargets = \{\}/u.test(state)
      && /value\.version === 3/u.test(state)
      && /value\.infrastructureServices = \{\}/u.test(state)
      && /value\.version === 4/u.test(state)
      && /value\.version = STATE_VERSION/u.test(state)
      && /MAX_INFRASTRUCTURE_TARGETS = 25/u.test(state)
      && /MAX_INFRASTRUCTURE_SERVICES = 8/u.test(state)
      && /INFRASTRUCTURE_TYPES = new Set\(\["proxmox"\]\)/u.test(state)
      && /INFRASTRUCTURE_SERVICE_TYPES = new Set\(\["portainer", "loki"\]\)/u.test(state),
    "state schema 5 preserves existing records while adding bounded Loki infrastructure services"
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

if (existsSync(join(root, "server/control-plane.mjs"))
  && existsSync(join(root, "server/loki.mjs"))
  && existsSync(join(root, "server/loki-probes.mjs"))
  && existsSync(join(root, "server/loki-transport.mjs"))) {
  const controlPlane = read("server/control-plane.mjs");
  const loki = read("server/loki.mjs");
  const lokiProbes = read("server/loki-probes.mjs");
  const lokiTransport = read("server/loki-transport.mjs");
  record(
    /export const LOKI_ROUTE_IDS/u.test(loki)
      && /"queryRange"/u.test(loki)
      && /method !== "GET"/u.test(loki)
      && /internalOnly:\s*true/u.test(loki)
      && /export function normalizeLokiQueryInput/u.test(loki)
      && /export function normalizeLokiResponse/u.test(loki)
      && /maximumLines:\s*500/u.test(loki)
      && /maximumStreams:\s*100/u.test(loki)
      && /maximumLineCodePoints:\s*4_096/u.test(loki),
    "Loki access is a fixed GET-only capability set with bounded normalized query results"
  );
  record(
    /export async function probeLoki/u.test(lokiProbes)
      && /connectionState:\s*"connected"/u.test(lokiProbes)
      && /AUTHENTICATION_REQUIRED/u.test(lokiProbes)
      && /LOKI_QUERY_UNAVAILABLE/u.test(lokiProbes),
    "Loki probes distinguish transport connectivity from readiness, authentication, and query health"
  );
  record(
    /export async function performLokiUpstreamRequest/u.test(lokiTransport)
      && /MAX_RESPONSE_BYTES = 2 \* 1024 \* 1024/u.test(lokiTransport)
      && /MAX_TIMEOUT_MS = 15_000/u.test(lokiTransport)
      && /UPSTREAM_REDIRECT_REJECTED/u.test(lokiTransport)
      && /"Accept-Encoding": "identity"/u.test(lokiTransport)
      && /UPSTREAM_CONTENT_REJECTED/u.test(lokiTransport)
      && /HTTPS_REQUIRED/u.test(lokiTransport)
      && /X-Scope-OrgID/u.test(lokiTransport),
    "Loki transport pins the authorized destination and rejects credential exposure, redirects, compression, and oversized responses"
  );
  record(
    /loki:\s*Object\.freeze\(\{/u.test(controlPlane)
      && /category:\s*"observability"/u.test(controlPlane)
      && /id:\s*"none"/u.test(controlPlane)
      && /id:\s*"basic"/u.test(controlPlane)
      && /id:\s*"bearer"/u.test(controlPlane)
      && /logging\\\/loki\\\//u.test(controlPlane)
      && /routeId:\s*"queryRange"/u.test(controlPlane),
    "authenticated infrastructure APIs expose Loki as an observability connector with explicit auth modes and one bounded query endpoint"
  );
}

if (existsSync(join(root, "server/event-journal.mjs"))
  && existsSync(join(root, "server/broker.mjs"))
  && existsSync(join(root, "server/control-plane.mjs"))) {
  const eventJournal = read("server/event-journal.mjs");
  const broker = read("server/broker.mjs");
  const controlPlane = read("server/control-plane.mjs");
  record(
    /export const EVENT_JOURNAL_SCHEMA = 1/u.test(eventJournal)
      && /DEFAULT_RETENTION_DAYS = 14/u.test(eventJournal)
      && /DEFAULT_MAXIMUM_BYTES = 20 \* 1024 \* 1024/u.test(eventJournal)
      && /DEFAULT_MAXIMUM_EVENT_BYTES = 2 \* 1024/u.test(eventJournal)
      && /DEFAULT_MAXIMUM_QUERY_LIMIT = 200/u.test(eventJournal)
      && /requireExactKeys\(input, stored \? STORED_KEYS : INPUT_KEYS/u.test(eventJournal)
      && /logsMetadata\.isSymbolicLink\(\)/u.test(eventJournal)
      && /export async function createEventJournal/u.test(eventJournal),
    "the persistent event journal accepts an exact safe schema with bounded retention, event size, queries, and filesystem checks"
  );
  record(
    /createEventJournal\(\{/u.test(broker)
      && /eventJournal\.record\(event\)/u.test(broker)
      && /await eventJournal\.close\(\)/u.test(broker)
      && /url\.pathname === "\/api\/v2\/logs"/u.test(controlPlane)
      && /eventJournal\.query\(eventLogQuery\(url\)\)/u.test(controlPlane),
    "the broker owns the event-journal lifecycle and exposes authenticated read-only log queries"
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
    assignments.includes("HELMSMAN_IMAGE=ghcr.io/OWNER/REPOSITORY:1.3.0")
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
    "!LICENSE",
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
    "!assets/services/THIRD_PARTY_NOTICES.md",
    "!assets/services/bazarr.png",
    "!assets/services/jellyfin.svg",
    "!assets/services/portainer.svg",
    "!assets/services/prowlarr.png",
    "!assets/services/proxmox.png",
    "!assets/services/qbittorrent.svg",
    "!assets/services/radarr.svg",
    "!assets/services/seerr.svg",
    "!assets/services/sonarr.svg",
    "!assets/services/licenses",
    "!assets/services/licenses/GPL-2.0.txt",
    "!assets/services/licenses/GPL-3.0.txt",
    "!assets/services/licenses/MIT-Seerr.txt",
    "!assets/services/licenses/Zlib-Portainer.txt",
    "!assets/workloads",
    "!assets/workloads/vm.svg",
    "!assets/workloads/container.svg",
    "!src/app-v5.js",
    "!src/ui/operations-views.js",
    "!src/ui/operations.css",
    "!src/ui/control.css",
    "!src/ui/logging.css",
    "!src/ui/retro.css",
    "!src/ui/obsidian-glass.css",
    "!server/broker.mjs",
    "!server/control-plane.mjs",
    "!server/event-journal.mjs",
    "!server/health-engine.mjs",
    "!server/index.mjs",
    "!server/lock.mjs",
    "!server/loki.mjs",
    "!server/loki-probes.mjs",
    "!server/loki-transport.mjs",
    "!server/media-artwork.mjs",
    "!server/media-model.mjs",
    "!server/monitor.mjs",
    "!server/network.mjs",
    "!server/portainer-model.mjs",
    "!server/portainer-probes.mjs",
    "!server/persistent-cache.mjs",
    "!server/proxmox-probes.mjs",
    "!server/routes.mjs",
    "!server/secrets.mjs",
    "!server/seerr-request-metadata.mjs",
    "!server/seerr-series-seasons.mjs",
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
        && manifest.start_url === "./#/overview"
        && manifest.display === "standalone"
        && Array.isArray(manifest.icons)
        && manifest.icons.some(({ src, sizes }) => src === "./assets/icon-192.png" && sizes === "192x192")
        && manifest.icons.some(({ src, sizes, purpose }) => src === "./assets/icon-512.png" && sizes === "512x512" && purpose === "any")
        && manifest.icons.some(({ src, sizes, purpose }) => src === "./assets/icon-maskable-512.png" && sizes === "512x512" && purpose === "maskable"),
      "the v1.3.0 installed-app manifest opens canonical Media Overview and retains dedicated local application icons"
    );
  } catch (error) {
    record(false, "the v1.3.0 installed-app manifest opens canonical Media Overview and retains dedicated local application icons", error.message);
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
  ...serviceIconAssets.map(({ path }) => path),
  "assets/workloads/vm.svg",
  "assets/workloads/container.svg"
];
if (localMarkPaths.every((iconPath) => existsSync(join(root, iconPath)))) {
  const unsafeSvg = /<!DOCTYPE|<!ENTITY|<(?:script|foreignObject|iframe|object|embed|image|audio|video)\b|\son[a-z][a-z0-9_-]*\s*=|(?:href|src)\s*=\s*["'](?!#)|@import\b|url\(\s*["']?(?!#)/iu;
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const invalidIcons = [];
  for (const asset of serviceIconAssets) {
    const contents = readFileSync(join(root, asset.path));
    const digest = createHash("sha256").update(contents).digest("hex");
    if (digest !== asset.hash) invalidIcons.push(`${asset.path}: hash`);
    if (asset.format === "png") {
      if (!contents.subarray(0, 8).equals(pngSignature)) invalidIcons.push(`${asset.path}: format`);
      if (contents.byteLength < 24 || contents.readUInt32BE(16) !== asset.width || contents.readUInt32BE(20) !== asset.height) {
        invalidIcons.push(`${asset.path}: dimensions`);
      }
    } else if (asset.format === "jpeg") {
      const dimensions = jpegDimensions(contents);
      if (!dimensions || dimensions.width !== asset.width || dimensions.height !== asset.height) invalidIcons.push(`${asset.path}: format/dimensions`);
    } else {
      const svg = contents.toString("utf8");
      const expectedViewBox = `viewBox="${asset.viewBox}"`;
      if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/iu.test(svg) || !svg.includes(expectedViewBox)) invalidIcons.push(`${asset.path}: format/viewBox`);
      if (unsafeSvg.test(svg)) invalidIcons.push(`${asset.path}: active or external content`);
      const hasInlineStyle = /\sstyle\s*=/iu.test(svg);
      if (hasInlineStyle && !(asset.auditedInlineStyle && digest === asset.hash)) invalidIcons.push(`${asset.path}: inline style`);
      if (asset.auditedInlineStyle && !hasInlineStyle) invalidIcons.push(`${asset.path}: audited style unexpectedly removed`);
      const hasStyleElement = /<style\b/iu.test(svg);
      if (hasStyleElement && !(asset.auditedStyleElement && digest === asset.hash)) invalidIcons.push(`${asset.path}: style element`);
      if (asset.auditedStyleElement && !hasStyleElement) invalidIcons.push(`${asset.path}: audited style element unexpectedly removed`);
    }
  }
  for (const iconPath of ["assets/workloads/vm.svg", "assets/workloads/container.svg"]) {
    const svg = read(iconPath);
    if (!/^<svg\b/iu.test(svg) || !/viewBox=/u.test(svg) || unsafeSvg.test(svg) || /\sstyle\s*=/iu.test(svg)) {
      invalidIcons.push(`${iconPath}: unsafe workload artwork`);
    }
  }
  const notices = existsSync(join(root, "assets/services/THIRD_PARTY_NOTICES.md"))
    ? read("assets/services/THIRD_PARTY_NOTICES.md")
    : "";
  record(
    invalidIcons.length === 0
      && !existsSync(join(root, "assets/workloads/lxc.svg"))
      && serviceIconAssets.every(({ service, path, hash }) => notices.includes(`| ${service} |`) && notices.includes(path) && notices.includes(hash))
      && /Box vector created by Freepik - www[.]freepik[.]com/u.test(notices)
      && /GNU General Public License\s+version 3/iu.test(notices)
      && /4561859c2b3e8edf5ffab994f72ec8f97aca8c53/u.test(notices)
      && /used only for referential identification\s+of the third-party\s+Prowlarr connector/iu.test(notices)
      && /No service owner sponsors, endorses, or is affiliated\s+with Helmsman/iu.test(notices)
      && /https:\/\/www[.]proxmox[.]com\//u.test(notices)
      && /Creative Commons Attribution-ShareAlike 4[.]0/iu.test(notices)
      && /Copyright \(C\)[\s\S]*2014-2017 Mark McDowall, Keivan Beigi, Taloth Saldono and contributors/u.test(notices)
      && /copyright: Provided by HVS <hvs linuxmail org> \(raster first proposal\) and Atif Afzal\(@atfzl github\)/u.test(notices)
      && /has not been established as\s+byte-for-byte identical[\s\S]*does\s+not claim that repository license/iu.test(notices)
      && /GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/u.test(read("assets/services/licenses/GPL-2.0.txt"))
      && /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/u.test(read("assets/services/licenses/GPL-3.0.txt"))
      && /Copyright \(c\) 2020 sct[\s\S]*Permission is hereby granted/u.test(read("assets/services/licenses/MIT-Seerr.txt"))
      && /Copyright \(c\) 2018 Portainer[.]io[\s\S]*This notice may not be removed or altered/u.test(read("assets/services/licenses/Zlib-Portainer.txt"))
      && /original, generic Helmsman drawings/iu.test(notices),
    "public artwork is an exact closed nine-icon set, remains inert, and carries its attribution and trademark boundary",
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
      && /<link\s+rel="stylesheet"\s+href="[.]\/src\/ui\/obsidian-glass[.]css"\s*\/?>/u.test(shell)
      && /href="#\/overview"\s+data-route="overview"[^>]*aria-label="Media overview"/u.test(shell)
      && !/data-route="home"/u.test(shell)
      && !/<script[^>]+src="[.]\/app[.]js"/u.test(shell),
    "container shell loads the Helmsman session client, canonical Media Overview, and operations styles instead of the legacy browser client"
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
  const serviceRouteCount = (route, service) => (
    shell.match(new RegExp(`<a(?=[^>]*data-route="${route}")(?=[^>]*data-service-nav="${service}")[^>]*>`, "gu")) || []
  ).length;
  record(
    ["overview", "discover", "library", "requests", "activity", "calendar", "health", "connections"]
      .every((route) => workspaceRouteCount("media", route) === 2)
      && ["overview", "connectors", "proxmox", "workloads", "portainer", "incidents"]
        .every((route) => workspaceRouteCount("infrastructure", route) === 2)
      && ["environments", "nodes"].every((route) => !new RegExp(`data-route="${route}"`, "u").test(shell))
      && serviceRouteCount("proxmox", "proxmox") === 2
      && serviceRouteCount("workloads", "proxmox") === 2
      && serviceRouteCount("portainer", "portainer") === 2
      && ["logs", "settings"].every((route) => sharedRouteCount(route) === 2)
      && /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/u.test(shellStyles),
    "desktop and mobile navigation expose canonical Overview in both workspaces, one gated Proxmox route, and shared routes"
  );
  record(
    /data-action="toggle-sidebar"[^>]+aria-controls="sidebar-navigation"[^>]+aria-expanded="true"/u.test(shell)
      && /class="sidebar-scroll-region"/u.test(shell)
      && /class="sidebar-footer"/u.test(shell)
      && /<a[^>]+id="monitor-summary"[^>]+href="#\/health"[^>]+aria-label="Open media health"/u.test(shell)
      && /\.sidebar-scroll-region\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/u.test(shellStyles)
      && /\.app-shell\.is-sidebar-collapsed\s*\{\s*--sidebar-width:\s*102px;/u.test(shellStyles)
      && /\.poster-rail\s*\{[\s\S]*?grid-auto-columns:\s*clamp\(140px,\s*11vw,\s*176px\)/u.test(shellStyles),
    "the shell provides a persistent-ready collapsible sidebar, zoom-safe navigation scrolling, dynamic monitor link, and bounded poster rail"
  );
}

if (existsSync(join(root, "src/app-v5.js")) && existsSync(join(root, "src/ui/operations-views.js"))) {
  const application = read("src/app-v5.js");
  const operationsViews = read("src/ui/operations-views.js");
  record(
    /id="infrastructure-proxmox"/u.test(application)
      && /id="proxmox-environments-title"/u.test(application)
      && /id="proxmox-nodes-title"/u.test(application)
      && /id="proxmox-storage-title"/u.test(application)
      && /data-action="open-infrastructure-target"/u.test(application)
      && /data-action="open-infrastructure-environment-detail"/u.test(application)
      && /data-action="open-infrastructure-node"/u.test(application)
      && /data-action="open-infrastructure-workload"/u.test(application)
      && /function renderProxmoxPage/u.test(application)
      && /renderInfrastructureOverview/u.test(application)
      && /export function normalizeInfrastructureSnapshot/u.test(operationsViews)
      && /export function renderInfrastructureOverview/u.test(operationsViews),
    "the authenticated client combines Proxmox environments, nodes, and storage without losing its read-only detail actions"
  );
  record(
    /const INFRASTRUCTURE_ROUTE_ALIASES\s*=\s*Object[.]freeze\(\{[\s\S]*?environments:\s*"proxmox"[\s\S]*?nodes:\s*"proxmox"/u.test(application)
      && /getItem\("helmsman[.]sidebarCollapsed"\)/u.test(application)
      && /setItem\("helmsman[.]sidebarCollapsed",\s*String\(state[.]sidebarCollapsed\)\)/u.test(application)
      && /proxmox:\s*state[.]infrastructure[.]targets[.]length\s*>\s*0/u.test(application)
      && /portainer:\s*normalizedPortainerConfigurations\(\)[.]length\s*>\s*0/u.test(application)
      && /setAttribute\("href",\s*infrastructureWorkspace\s*\?\s*"#\/incidents"\s*:\s*"#\/health"\)/u.test(application),
    "legacy Infrastructure URLs, saved sidebar preference, connection-gated navigation, and workspace-specific monitor targets remain wired"
  );
  const reviewedServiceIconPaths = serviceIconAssets.map(({ path }) => `./${path}`);
  record(
    /function renderPortainerPage/u.test(application)
      && /state\.route === "portainer"/u.test(application)
      && /\/api\/v2\/infrastructure\/services/u.test(application)
      && /open-portainer-service/u.test(application)
      && /const SERVICE_ICON_ASSETS\s*=\s*Object[.]freeze/u.test(operationsViews)
      && reviewedServiceIconPaths.every((path) => operationsViews.includes(`path: "${path}"`))
      && !/SERVICE_BADGE_GLYPHS/u.test(operationsViews)
      && /class="service-brand-icon__fallback"/u.test(operationsViews)
      && /startsWith\("proxmox-"\)/u.test(operationsViews)
      && /startsWith\("portainer-"\)/u.test(operationsViews)
      && /export function proxmoxBrandLinkMarkup/u.test(operationsViews)
      && /href="https:\/\/www[.]proxmox[.]com\/"/u.test(operationsViews)
      && /target="_blank" rel="noopener noreferrer"/u.test(operationsViews)
      && /Visit the Proxmox website \(opens in a new tab\)/u.test(operationsViews)
      && /function renderProxmoxConnectorCard[\s\S]*?return `<article[\s\S]*?proxmoxBrandLinkMarkup\(\)[\s\S]*?<button class="service-card-v5__action"/u.test(application)
      && /function renderInfrastructureEnvironmentGrid[\s\S]*?<article[\s\S]*?proxmoxBrandLinkMarkup\(\)[\s\S]*?<button class="environment-card__main"/u.test(application)
      && /function renderInfrastructureNodeGrid[\s\S]*?<article[\s\S]*?proxmoxBrandLinkMarkup\(\)[\s\S]*?<button class="infrastructure-node-card__main"/u.test(application)
      && /function renderInfrastructureTarget[\s\S]*?<article[\s\S]*?proxmoxBrandLinkMarkup\(\)[\s\S]*?<button class="infrastructure-target__action"/u.test(operationsViews),
    "known integrations render exact local images while Proxmox website links remain siblings of Helmsman action buttons"
  );
}

if (existsSync(join(root, "package.json"))) {
  try {
    const packageJson = JSON.parse(read("package.json"));
    record(
      packageJson.name === "helmsman"
        && packageJson.version === "1.3.0"
        && packageJson.scripts?.serve === "node server/index.mjs serve"
        && packageJson.scripts?.["check:broker"] === "node --test tests/control-plane.test.mjs"
        && /tests\/secrets[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/session-auth[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/rename-compatibility[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/monitor[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/state-infrastructure-targets[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/infrastructure-control-plane[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/action-routes[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/seerr-series-seasons[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/proxmox-environment-failover[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/proxmox-probes[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/proxmox-monitor[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/proxmox-transport[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/infrastructure-service-control-plane[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/portainer-backend[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/portainer-monitor[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/portainer-transport[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/event-journal[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/logging-control-plane[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/loki-control-plane[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/loki-model[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/loki-probes[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/loki-routes[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/loki-transport[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/media-model[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/media-artwork[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/media-artwork-control-plane[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /tests\/persistent-cache[.]test[.]mjs/u.test(packageJson.scripts?.["check:security"] || "")
        && /operations-view-contract[.]mjs/u.test(packageJson.scripts?.["check:operations"] || "")
        && /runtime-v5-smoke[.]mjs/u.test(packageJson.scripts?.["check:operations"] || "")
        && /container-contract[.]mjs/u.test(packageJson.scripts?.["check:container"] || "")
        && /publisher-contract[.]mjs/u.test(packageJson.scripts?.["check:container"] || "")
        && packageJson.scripts?.["check:public"] === "node scripts/public-release-contract.mjs"
        && /check:public/u.test(packageJson.scripts?.check || ""),
      "package identity and checks cover the Helmsman media/infrastructure control plane, persistent event journal, Loki connector, probes, transport, and operations UI"
    );
  } catch (error) {
    record(false, "package identity and checks cover the Helmsman media/infrastructure control plane, persistent event journal, Loki connector, probes, transport, and operations UI", error.message);
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
      && keyGuides.every((guide) => /never copied into incidents, (?:events|the journal), history, application logs, or persistent files/iu.test(guide))
      && keyGuides.every((guide) => /Raw response bodies and raw error bodies are never exposed/iu.test(guide)),
    "operator guides define the bounded transient live-health report boundary"
  );
  record(
    keyGuides.every((guide) => /Media and Infrastructure/iu.test(guide))
      && keyGuides.every((guide) => /Proxmox/iu.test(guide))
      && keyGuides.every((guide) => /(?:monitoring|probes?)[^\.\n]*read-only|read-only[^\.\n]*(?:monitoring|probes?)/iu.test(guide))
      && keyGuides.every((guide) => /API token ID/iu.test(guide))
      && keyGuides.every((guide) => /token secret/iu.test(guide))
      && keyGuides.every((guide) => /write-only/iu.test(guide))
      && keyGuides.every((guide) => /Pinned SHA-256 fingerprint/iu.test(guide))
      && keyGuides.every((guide) => /no Docker socket|never mounts? the Docker socket/iu.test(guide))
      && keyGuides.every((guide) => /(?:do not place|Do not add)[^.\n]*[.]env/iu.test(guide)),
    "operator guides define the multi-instance Proxmox monitoring boundary without environment secrets or direct host access"
  );
  record(
    keyGuides.every((guide) => /only media writes[^.\n]*Seerr failed-request retry[^.\n]*selected standard-season request[^.\n]*exact current series[^.\n]*targeted Radarr\/Sonarr search[^.\n]*one exact current record/iu.test(guide))
      && keyGuides.every((guide) => /Block release & search again[^.\n]*one exact current errored Sonarr\/Radarr queue item/iu.test(guide))
      && keyGuides.every((guide) => /removes? the download[^.\n]*data[^.\n]*blocklists? (?:that|the) release[^.\n]*(?:replacement|seek a replacement)/iu.test(guide))
      && keyGuides.every((guide) => /(?:Portainer container start, restart, and graceful stop|start, restart, or gracefully stop one current Docker-compatible container)/iu.test(guide))
      && keyGuides.every((guide) => /(?:Proxmox QEMU\/LXC start, reboot, and graceful shutdown|start, reboot, or gracefully shut down one current QEMU VM or LXC)/iu.test(guide))
      && keyGuides.every((guide) => /(?:accessible )?(?:Helmsman(?:'s)? )?in-app confirmation|Helmsman confirmation dialog/iu.test(guide))
      && keyGuides.every((guide) => /browser-native (?:confirmation )?prompt/iu.test(guide))
      && keyGuides.every((guide) => /(?:revalidates?|checked again)[^.\n]*(?:record|target|revision|workload|container)|(?:record|target|revision|workload|container)[^.\n]*(?:revalidates?|checked again)/iu.test(guide))
      && keyGuides.every((guide) => /fixed method, path, query, and body templates/iu.test(guide))
      && keyGuides.every((guide) => /browser[^.\n]*(?:cannot|never)[^.\n]*arbitrary upstream path or request body/iu.test(guide))
      && keyGuides.every((guide) => /no (?:general|generic)[^.\n]*(?:API|upstream|Docker)[^.\n]*proxy/iu.test(guide))
      && keyGuides.every((guide) => ["delete", "remove", "force-stop", "reset", "kill", "bulk action"]
        .every((term) => new RegExp(term.replace(" ", "[- ]"), "iu").test(guide))),
    "operator guides limit user-confirmed recovery to fixed action templates and reject generic upstream mutations"
  );
  record(
    keyGuides.every((guide) => ["Overview", "Discover", "Library", "Requests", "Activity", "Calendar", "Health", "Connections"]
      .every((section) => new RegExp(`\\b${section}\\b`, "iu").test(guide)))
      && keyGuides.every((guide) => /Requested[^\n]{0,40}Monitored[^\n]{0,40}Downloading[^\n]{0,40}Imported[^\n]{0,40}Available/iu.test(guide))
      && keyGuides.every((guide) => /opaque[^.\n]*(?:artwork|Helmsman URL)|artwork[^.\n]*opaque/iu.test(guide))
      && keyGuides.every((guide) => /(?:artwork cache|cache)[^.\n]*(?:persistent|data volume)|(?:persistent|data volume)[^.\n]*(?:artwork|cache)/iu.test(guide))
      && keyGuides.every((guide) => /cannot approve requests/iu.test(guide))
      && keyGuides.every((guide) => /(?:service (?:icons|marks|badges)|icons|marks|badges)[^.\n]*(?:bundled locally|icon CDN|runtime icon CDN)/iu.test(guide))
      && keyGuides.every((guide) => /state schema(?: to)? [34]/iu.test(guide))
      && /state schema(?: to)? 4/iu.test(keyGuides[0])
      && keyGuides.every((guide) => /(?:each visible node|node's fixed read-only task route)/iu.test(guide))
      && keyGuides.every((guide) => /raw UPIDs/iu.test(guide)),
    "operator guides document the monitored desktop media lifecycle, opaque persistent artwork, local marks, schema compatibility, and per-node Proxmox activity"
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
    "operator guides keep Portainer HTTPS-only, fixed-route, Infrastructure-scoped, and free of environment credentials"
  );
}

if (existsSync(join(root, ".github/workflows/container.yml"))) {
  const workflow = read(".github/workflows/container.yml");
  const testJob = yamlJobBlock(workflow, "test");
  const publisherSyntaxJob = yamlJobBlock(workflow, "publisher-syntax");
  const imageJob = yamlJobBlock(workflow, "image");
  const releaseJob = yamlJobBlock(workflow, "release");
  const existingReleaseJob = yamlJobBlock(workflow, "verify-existing-release");
  const usesLines = workflow.match(/^\s*uses:\s+[^\s#]+(?:\s+#.*)?$/gmu) || [];
  record(
    usesLines.length === 14
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
    /^\s*runs-on: windows-latest\s*$/mu.test(publisherSyntaxJob)
      && /name: Windows PowerShell 5[.]1 publisher contracts/u.test(publisherSyntaxJob)
      && /shell: powershell/u.test(publisherSyntaxJob)
      && /\$PSVersionTable[.]PSEdition -cne 'Desktop'/u.test(publisherSyntaxJob)
      && /\$PSVersionTable[.]PSVersion[.]Major -ne 5/u.test(publisherSyntaxJob)
      && /[.]\/Publish-Helmsman[.]ps1/u.test(publisherSyntaxJob)
      && /[.]\/scripts\/Publish-HelmsmanRelease[.]ps1/u.test(publisherSyntaxJob)
      && /System[.]Management[.]Automation[.]Language[.]Parser\]::ParseFile\(/u.test(publisherSyntaxJob)
      && /\[ref\]\$tokens/u.test(publisherSyntaxJob)
      && /\[ref\]\$parseErrors/u.test(publisherSyntaxJob)
      && /\$parseErrors[.]Count -ne 0/u.test(publisherSyntaxJob)
      && /powershell[.]exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass/u.test(publisherSyntaxJob)
      && /Publish-Helmsman[.]ps1[^\n]*-SelfTest/u.test(publisherSyntaxJob)
      && /^\s{6}- publisher-syntax\s*$/mu.test(imageJob)
      && /^\s{6}- publisher-syntax\s*$/mu.test(existingReleaseJob),
    "Windows PowerShell 5.1 parses both publishers and exercises the offline bootstrap before either tagged release path can pass"
  );
  record(
    /release_exists:\s*\$\{\{ steps[.]release_state[.]outputs[.]exists \}\}/u.test(testJob)
      && /name: Detect an existing immutable release/u.test(testJob)
      && /GH_HOST: github[.]com/u.test(testJob)
      && /gh release view "\$\{RELEASE_TAG\}" --repo "\$\{GITHUB_REPOSITORY\}"/u.test(testJob)
      && /release not found\|HTTP 404/u.test(testJob)
      && /startsWith\(github[.]ref, 'refs\/tags\/v'\) && needs[.]test[.]outputs[.]release_exists == 'false'/u.test(imageJob)
      && /startsWith\(github[.]ref, 'refs\/tags\/v'\) && needs[.]test[.]outputs[.]release_exists == 'false'/u.test(releaseJob)
      && /startsWith\(github[.]ref, 'refs\/tags\/v'\) && needs[.]test[.]outputs[.]release_exists == 'true'/u.test(existingReleaseJob),
    "tagged runs select exactly one immutable new-release or existing-release verification branch"
  );
  record(
    /name: Refuse to replace an existing version image/u.test(imageJob)
      && /repository="\$\{GITHUB_REPOSITORY,,\}"/u.test(imageJob)
      && /version_ref="ghcr[.]io\/\$\{repository\}:\$\{RELEASE_VERSION\}"/u.test(imageJob)
      && /commit_ref="ghcr[.]io\/\$\{repository\}:sha-\$\{GITHUB_SHA\}"/u.test(imageJob)
      && /trap 'rm -f "\$\{output_file\}" "\$\{error_file\}"' EXIT/u.test(imageJob)
      && /assert_image_ref_absent\(\)/u.test(imageJob)
      && /local image_ref="\$1"/u.test(imageJob)
      && /local image_tag="\$2"/u.test(imageJob)
      && /registry_manifest_path="\/v2\/\$\{repository\}\/manifests\/\$\{image_tag\}"/u.test(imageJob)
      && /docker buildx imagetools inspect/u.test(imageJob)
      && /--format '\{\{json [.]Manifest\}\}'/u.test(imageJob)
      && /already exists without a matching immutable GitHub Release/u.test(imageJob)
      && /grep -Fqi "\$\{image_ref\}: not found"/u.test(imageJob)
      && /manifest unknown\|no such manifest/u.test(imageJob)
      && imageJob.includes("404([[:space:]]+Not[[:space:]]+Found)?")
      && /registry lookup failed ambiguously; refusing to publish/u.test(imageJob)
      && /assert_image_ref_absent "\$\{version_ref\}" "\$\{RELEASE_VERSION\}"/u.test(imageJob)
      && /assert_image_ref_absent "\$\{commit_ref\}" "sha-\$\{GITHUB_SHA\}"/u.test(imageJob)
      && imageJob.indexOf("Refuse to replace an existing version image") < imageJob.indexOf("Build and publish the manifest"),
    "image publication performs fail-closed version and commit-alias registry preflights before any build push"
  );
  record(
    /permissions:\s*\n\s{6}contents: write/u.test(releaseJob)
      && /needs:\s*\n\s{6}- test\s*\n\s{6}- image/u.test(releaseJob)
      && /RELEASE_DIGEST:\s*\$\{\{ needs[.]image[.]outputs[.]digest \}\}/u.test(releaseJob)
      && /\^sha256:\[0-9a-f\]\{64\}\$/u.test(releaseJob)
      && /repos\/\$\{GITHUB_REPOSITORY\}\/contents\/\$\{source_path\}[?]ref=\$\{GITHUB_SHA\}/u.test(releaseJob)
      && /tagged_ref="ghcr[.]io\/OWNER\/REPOSITORY:\$\{RELEASE_VERSION\}"/u.test(releaseJob)
      && /image_ref="ghcr[.]io\/\$\{repository\}@\$\{RELEASE_DIGEST\}"/u.test(releaseJob)
      && /compose_active_count/u.test(releaseJob)
      && /environment_active_count/u.test(releaseJob)
      && releaseJob.includes('tagged_ref_pattern="${tagged_ref//./[.]}"')
      && releaseJob.includes('sed -i "s#${tagged_ref_pattern}#${image_ref}#g"')
      && /sha256sum compose[.]yaml container[.]env[.]example > SHA256SUMS/u.test(releaseJob)
      && /sha256sum --check SHA256SUMS/u.test(releaseJob)
      && /gh release view "\$\{tag\}" --repo "\$\{GITHUB_REPOSITORY\}"/u.test(releaseJob)
      && releaseJob.indexOf('gh release view "${tag}"') < releaseJob.indexOf('gh release create "${create_args[@]}"')
      && /gh release create "\$\{create_args\[@\]\}"/u.test(releaseJob)
      && /"\$\{release_dir\}\/compose[.]yaml"/u.test(releaseJob)
      && /"\$\{release_dir\}\/container[.]env[.]example"/u.test(releaseJob)
      && /"\$\{release_dir\}\/SHA256SUMS"/u.test(releaseJob)
      && !/gh release (?:upload|delete)/u.test(releaseJob)
      && !/--clobber/u.test(releaseJob),
    "new releases render and checksum three digest-pinned assets from the exact tag commit without replacement"
  );
  const existingWriteOperations = [
    /contents: write/u,
    /packages: write/u,
    /gh release (?:create|upload|delete|edit)/u,
    /docker push\b/u,
    /docker build(?:\s|$)/u,
    /docker buildx build\b/u,
    /push:\s*true/u,
    /docker\/build-push-action@/u
  ];
  record(
    /permissions:\s*\n\s{6}contents: read\s*\n\s{6}packages: read/u.test(existingReleaseJob)
      && existingWriteOperations.every((pattern) => !pattern.test(existingReleaseJob))
      && /--json tagName,isDraft,isPrerelease,assets/u.test(existingReleaseJob)
      && /expected_asset_names="\$\(printf '%s\\n' compose[.]yaml container[.]env[.]example SHA256SUMS/u.test(existingReleaseJob)
      && /gh release download/u.test(existingReleaseJob)
      && /sha256sum --strict --check SHA256SUMS/u.test(existingReleaseJob)
      && /asset_references=/u.test(existingReleaseJob)
      && /wc -l/u.test(existingReleaseJob)
      && /expected_prefix="ghcr[.]io\/\$\{repository\}@"/u.test(existingReleaseJob)
      && /version_manifest="\$\(docker buildx imagetools inspect/u.test(existingReleaseJob)
      && /"ghcr[.]io\/\$\{repository\}:\$\{RELEASE_VERSION\}"/u.test(existingReleaseJob)
      && /commit_manifest="\$\(docker buildx imagetools inspect/u.test(existingReleaseJob)
      && /"ghcr[.]io\/\$\{repository\}:sha-\$\{GITHUB_SHA\}"/u.test(existingReleaseJob)
      && /\$\{version_digest\}" != "\$\{asset_digest\}/u.test(existingReleaseJob)
      && /\$\{commit_digest\}" != "\$\{asset_digest\}/u.test(existingReleaseJob)
      && /[?]ref=\$\{GITHUB_SHA\}/u.test(existingReleaseJob)
      && /for asset in compose[.]yaml container[.]env[.]example SHA256SUMS/u.test(existingReleaseJob)
      && /cmp --silent "\$\{expected_dir\}\/\$\{asset\}" "\$\{verify_dir\}\/\$\{asset\}"/u.test(existingReleaseJob),
    "existing releases are read-only reruns that rederive exact assets and verify version and commit-SHA aliases against one digest"
  );
  record(
    /group:\s*container-\$\{\{ github[.]workflow \}\}-\$\{\{ github[.]ref \}\}/u.test(workflow)
      && /cancel-in-progress:\s*\$\{\{ !startsWith\(github[.]ref, 'refs\/tags\/'\) \}\}/u.test(workflow),
    "workflow concurrency never cancels an in-flight immutable tag publication"
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
      && /Select Media \*\*Connections\*\*/iu.test(guide)
      && /Select Infrastructure \*\*Connectors\*\*/iu.test(guide)
      && /Do not add media, Proxmox, or Portainer URLs, API keys, passwords, token IDs, token secrets, access tokens, Helmsman access keys, cookies, setup tokens, or Authentik secrets to `[.]env`/iu.test(guide),
    "deployment guide keeps media and infrastructure setup in the UI and makes Caddy and Authentik optional"
  );
  record(
    edgeFiles.length === edgePaths.length
      && edgeFiles.every((contents) => /Optional Helmsman v1 HTTPS edge/iu.test(contents))
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
    "docker compose run --rm --no-deps helmsman reset-access --confirm",
    "docker compose up -d"
  ];
  const recoverySectionStart = guide.indexOf("If the enrolled owner can no longer authenticate");
  const recoverySection = recoverySectionStart >= 0 ? guide.slice(recoverySectionStart) : "";
  record(
    recoveryCommands.every((command) => recoverySection.includes(command))
      && recoveryCommands.every((command, index) => index === 0 || recoverySection.indexOf(command) > recoverySection.indexOf(recoveryCommands[index - 1]))
      && /preserv(?:es|ing) the instance ID/iu.test(recoverySection)
      && /network policy/iu.test(recoverySection)
      && /registered targets/iu.test(recoverySection)
      && /encrypted monitoring credentials/iu.test(recoverySection)
      && /revokes all browser sessions/iu.test(recoverySection)
      && /standard output/iu.test(recoverySection)
      && /new one-time setup token/iu.test(recoverySection)
      && /never creates or prints a reusable browser key/iu.test(recoverySection)
      && !/rotate-access-key --confirm/u.test(recoverySection),
    "reset-access recovery stops the broker, revokes browser access, preserves configured services, and restarts one-time setup"
  );
  record(
    /exact enabled Jellyfin administrator/iu.test(guide)
      && /username and password/iu.test(guide)
      && /server ID and user ID[\s\S]{0,160}never requested[\s\S]{0,80}displayed/iu.test(guide)
      && /revocable 30-day session/iu.test(guide)
      && /HttpOnly, `SameSite=Strict` cookie/iu.test(guide)
      && /per-session CSRF value/iu.test(guide)
      && /encrypts the resulting Jellyfin access token server-side/iu.test(guide)
      && /monitoring credential[\s\S]{0,120}(?:distinct|separate)/iu.test(guide)
      && /Jellyfin is unreachable[\s\S]{0,160}new sign-ins fail[\s\S]{0,220}state-changing actions require fresh Jellyfin validation and fail closed/iu.test(guide)
      && /upgrade from v1[.]0[.]0-beta[.]2[\s\S]{0,160}temporary migration credential/iu.test(guide)
      && /Successful enrollment[\s\S]{0,160}removes the access-key verifier[\s\S]{0,120}revokes all legacy browser sessions/iu.test(guide)
      && /Authentik[\s\S]{0,220}external MFA/iu.test(guide)
      && !/rotate-access-key --confirm/u.test(guide),
    "deployment guide documents exact-owner Jellyfin login, encrypted 30-day sessions, outage handling, and beta.2 migration"
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
