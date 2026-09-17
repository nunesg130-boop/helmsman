import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  escapeOperationsHtml,
  incidentNextStep,
  normalizeInfrastructureSnapshot,
  normalizeOperationsSnapshot,
  proxmoxBrandLinkMarkup,
  renderInfrastructureOverview,
  renderOperationsOverview,
  renderOperationsReports,
  serviceIconMarkup,
  workloadIconMarkup
} from "../src/ui/operations-views.js";

const serviceIconAssets = Object.freeze({
  jellyfin: Object.freeze({ file: "jellyfin.svg", width: 512, height: 512, hash: "7f53cf083dbb3119ec8c5acbd8049c5033227617e461540f70591ac109124306", format: "svg", viewBox: "0 0 512 512" }),
  seerr: Object.freeze({ file: "seerr.jpg", width: 554, height: 554, hash: "0e0aa1aa038915e519b6b23e00565406b04f4974a1d33ba86ae3088aba41989b", format: "jpeg" }),
  radarr: Object.freeze({ file: "radarr.png", width: 256, height: 256, hash: "d06702d34fcc05888239e553fab68f01c5f3f9b4fd64f8a7c407f4f9bfb8cf1e", format: "png" }),
  sonarr: Object.freeze({ file: "sonarr.png", width: 554, height: 554, hash: "3922f07d78c566446945bbca3bf6e5e012607d65e9f35ba63c297136da778418", format: "png" }),
  prowlarr: Object.freeze({ file: "prowlarr.png", width: 460, height: 460, hash: "fe75eafc608e288c9736b740afe1c30c715eaf56dc284fec1926491d245fea52", format: "png" }),
  qbittorrent: Object.freeze({ file: "qbittorrent.svg", width: 1024, height: 1024, hash: "f96f40f70830e245cc184291d1173aa705b68b0865970b44aa1ee63350bcb9c2", format: "svg", viewBox: "0 0 1024 1024" }),
  bazarr: Object.freeze({ file: "bazarr.png", width: 200, height: 200, hash: "aefd3aac28d67fd4d48b24dd2ae33b3b0a9f26e7950c2e1d34bef98cecf18876", format: "png", lightPlate: true }),
  proxmox: Object.freeze({ file: "proxmox.png", width: 595, height: 516, hash: "c8dca83af2f6519f025aad6325cc702ad491b19727bae42b9b87b6d20fa13440", format: "png" }),
  portainer: Object.freeze({ file: "portainer.svg", width: 168, height: 219, hash: "5d1e07021683d15ea67225c60975729f4ee0ed380f3a0fb21ffb2ad00eb6e85b", format: "svg", viewBox: "0.72 0 168.18 218.62", lightPlate: true })
});

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

const retroCss = await readFile(new URL("../src/ui/retro.css", import.meta.url), "utf8");
const operationsCss = await readFile(new URL("../src/ui/operations.css", import.meta.url), "utf8");
const shellCss = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const application = await readFile(new URL("../src/app-v5.js", import.meta.url), "utf8");
const shellHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifest.webmanifest", import.meta.url), "utf8"));

function flatMediaBody(css, minWidth, maxWidth, label) {
  const query = new RegExp(
    `@media\\s*\\(min-width:\\s*${minWidth}px\\)\\s+and\\s+\\(max-width:\\s*${maxWidth}px\\)\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`,
    "u"
  );
  const match = css.match(query);
  assert.ok(match, `${label} must define the ${minWidth}-${maxWidth}px media block`);
  return match[1];
}

function ruleBody(css, selector, label) {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "u"));
  assert.ok(match, `${label} must define ${selector}`);
  return match[1];
}

for (const [name, css] of [["base", shellCss], ["retro", retroCss]]) {
  assert.match(
    css,
    /@media\s*\(min-width:\s*761px\)\s*and\s*\(max-width:\s*1440px\)\s*\{\s*\.request-list\s*\{[^}]*\}\s*\.request-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/su,
    `${name} styles must switch request rows to the compact two-column layout from 761px through 1440px`
  );
}

for (const [name, css] of [["base", shellCss], ["retro", retroCss]]) {
  const compactDownloadCss = flatMediaBody(css, 761, 1320, `${name} styles`);
  const downloadListCss = ruleBody(compactDownloadCss, "\\.download-list", `${name} compact download styles`);
  const downloadRowCss = ruleBody(compactDownloadCss, "\\.download-row", `${name} compact download styles`);
  const hiddenMetadataCss = ruleBody(
    compactDownloadCss,
    "\\.download-stage\\s*,\\s*\\.download-stat",
    `${name} compact download styles`
  );
  const downloadProgressCss = ruleBody(compactDownloadCss, "\\.download-progress", `${name} compact download styles`);
  const downloadActionsCss = ruleBody(compactDownloadCss, "\\.download-actions", `${name} compact download styles`);

  assert.match(downloadListCss, /border:\s*0;/u, `${name} compact download list must drop its outer border`);
  assert.match(downloadListCss, /background:\s*transparent;/u, `${name} compact download list must drop its outer background`);
  assert.match(
    downloadRowCss,
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/u,
    `${name} download rows must use two columns from 761px through 1320px`
  );
  assert.match(hiddenMetadataCss, /display:\s*none;/u, `${name} compact download rows must hide stage and stat metadata`);
  assert.match(downloadProgressCss, /grid-column:\s*1\s*\/\s*-1;/u, `${name} compact download progress must span both columns`);
  assert.match(downloadProgressCss, /grid-row:\s*2;/u, `${name} compact download progress must occupy the second row`);
  assert.match(downloadActionsCss, /grid-column:\s*2;/u, `${name} compact download actions must occupy the second column`);
  assert.match(downloadActionsCss, /grid-row:\s*1;/u, `${name} compact download actions must stay in the first row`);
}

assert.match(
  retroCss,
  /\.main-content\s*>\s*\.media-desktop-page\s*\{[^}]*width:\s*min\(1660px,\s*100%\)[^}]*margin-right:\s*auto[^}]*margin-left:\s*auto/su,
  "wide media pages must center inside the post-sidebar content column without overflowing it"
);
assert.match(
  retroCss,
  /\.main-content\s*>\s*\.media-home-page\s*\{[^}]*width:\s*auto[^}]*max-width:\s*none[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*margin-right:\s*0[^}]*margin-left:\s*0/su,
  "the ultrawide Media Home dashboard must use one constrained full-width post-sidebar track"
);
assert.match(
  retroCss,
  /\.media-home-page\s*>\s*\*\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/su,
  "intrinsically wide poster rails must not enlarge the Media Home grid"
);
assert.match(
  retroCss,
  /\.brand\s*\{[^}]*height:\s*var\(--topbar-height\)[^}]*flex:\s*0\s+0\s+var\(--topbar-height\)[^}]*border-bottom:\s*3px\s+double\s+var\(--retro-rule\)/su,
  "the sidebar brand cell and topbar must share one height and divider treatment"
);
assert.match(
  retroCss,
  /\.infrastructure-node-card[\s\S]*?:is\(:hover,\s*:focus-visible\)[^{]*\{[^}]*color:\s*var\(--text\)/u,
  "node and service hover/focus states must retain readable light text"
);
assert.doesNotMatch(retroCss, /color:\s*var\(--bg\)/u, "hover styles must not invert copy to near-black on dark cards");
assert.match(
  retroCss,
  /\.modal-card--portainer\s*>\s*form\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto[^}]*overflow:\s*hidden/su,
  "the Portainer form must keep its action footer outside the scrolling body"
);
assert.match(shellHtml, /<meta name="theme-color" content="#0d1719"\s*\/>/u);
assert.equal(manifest.background_color, "#081012");
assert.equal(manifest.theme_color, "#0d1719");

for (const [label, href, accessibleName] of [
  ["Source", "https://github.com/nunesg130-boop/helmsman", "Source code"],
  ["AGPL-3.0 License", "https://github.com/nunesg130-boop/helmsman/blob/main/LICENSE", "AGPL-3.0 license"],
  ["Third-party icon notices", "https://github.com/nunesg130-boop/helmsman/blob/main/assets/services/THIRD_PARTY_NOTICES.md", "Third-party icon notices"]
]) {
  const escapedHref = href.replaceAll(".", "[.]").replaceAll("/", "\\/");
  assert.match(
    application,
    new RegExp(`<a class="button button--compact" href="${escapedHref}" target="_blank" rel="noopener noreferrer" aria-label="${accessibleName} \\(opens in a new tab\\)">${label}<\\/a>`, "u"),
    `${label} must be a fixed, accessible external link in Settings`
  );
}
assert.match(application, /<nav class="button-row app-version-v5__links" aria-label="Helmsman project resources">/u, "About links need a labelled navigation landmark");

for (const [id, asset] of Object.entries(serviceIconAssets)) {
  const markup = serviceIconMarkup(id, id.slice(0, 1));
  const expectedClasses = `service-brand-icon service-brand-icon--${id}${asset.lightPlate ? " service-brand-icon--light-plate" : ""}`;
  assert.match(markup, new RegExp(`<img class="${expectedClasses}"`, "u"), `${id} must use its reviewed presentation classes`);
  assert.match(markup, new RegExp(`src="[.]\\/assets\\/services\\/${asset.file.replaceAll(".", "[.]")}"`, "u"), `${id} must use its fixed local asset path`);
  assert.match(markup, new RegExp(`width="${asset.width}" height="${asset.height}" alt="" aria-hidden="true" decoding="async"`, "u"), `${id} must expose pinned dimensions and decorative semantics`);
  assert.doesNotMatch(markup, /https?:|data:|blob:|service-brand-icon__fallback/iu, `${id} must use only its reviewed local connector icon`);

  const contents = await readFile(new URL(`../assets/services/${asset.file}`, import.meta.url));
  const digest = createHash("sha256").update(contents).digest("hex");
  assert.equal(digest, asset.hash, `${id} must remain the exact reviewed user-supplied asset`);
  if (asset.format === "png") {
    assert.ok(contents.subarray(0, 8).equals(pngSignature), `${asset.file} must remain a PNG`);
    assert.equal(contents.readUInt32BE(16), asset.width, `${asset.file} width must remain pinned`);
    assert.equal(contents.readUInt32BE(20), asset.height, `${asset.file} height must remain pinned`);
  } else if (asset.format === "jpeg") {
    assert.deepEqual(jpegDimensions(contents), { width: asset.width, height: asset.height }, `${asset.file} must remain the pinned JPEG`);
  } else {
    const svg = contents.toString("utf8");
    assert.match(svg, /^<svg\b/u, `${asset.file} must remain an SVG document`);
    assert.match(svg, new RegExp(`viewBox="${asset.viewBox.replaceAll(".", "[.]")}"`, "u"), `${asset.file} viewBox must remain pinned`);
    assert.doesNotMatch(
      svg,
      /<!DOCTYPE|<!ENTITY|<(?:script|foreignObject|iframe|object|embed|image|audio|video)\b|\son[a-z][a-z0-9_-]*\s*=|(?:href|src)\s*=\s*["'](?!#)|@import\b|url\(\s*["']?(?!#)/iu,
      `${asset.file} must remain inert and self-contained`
    );
    if (id === "jellyfin") {
      assert.match(svg, /\sstyle\s*=/u, "only the hash-pinned Jellyfin artwork may retain its audited presentation-only inline styles");
    } else {
      assert.doesNotMatch(svg, /\sstyle\s*=/iu, `${asset.file} must not gain inline styles`);
    }
  }
}

assert.match(serviceIconMarkup("proxmox-environment-id", "P"), /assets\/services\/proxmox[.]png/u, "Proxmox instance ids use the fixed Proxmox icon");
assert.match(serviceIconMarkup("portainer-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "P"), /assets\/services\/portainer[.]svg/u, "Portainer instance ids use the fixed Portainer icon");
assert.doesNotMatch(serviceIconMarkup("prowlarr-unreviewed", "P"), /<img|assets\/services/u, "unreviewed lookalike ids cannot select a bundled connector icon");
const proxmoxBrandLink = proxmoxBrandLinkMarkup();
assert.match(proxmoxBrandLink, /^<a class="service-brand-link service-brand-link--proxmox"/u);
assert.match(proxmoxBrandLink, /href="https:\/\/www[.]proxmox[.]com\/"/u);
assert.match(proxmoxBrandLink, /target="_blank" rel="noopener noreferrer"/u);
assert.match(proxmoxBrandLink, /aria-label="Visit the Proxmox website \(opens in a new tab\)"/u);
assert.match(proxmoxBrandLink, /<img[^>]+assets\/services\/proxmox[.]png[^>]*><\/a>$/u);
assert.doesNotMatch(proxmoxBrandLink, /<button\b/u, "the Proxmox website link must never contain a Helmsman action button");
assert.match(
  operationsCss,
  /[.]service-brand-icon--proxmox\s*\{[^}]*filter:\s*none;/su,
  "the Proxmox mark must not receive a presentation effect"
);
const hostileIcon = serviceIconMarkup('unknown"><script>alert(1)</script>', '<img src=x onerror="alert(1)">');
assert.doesNotMatch(hostileIcon, /<img|<script|onerror=/u, "unknown service ids cannot become image paths or active markup");
assert.match(hostileIcon, /&lt;/u, "unknown service fallbacks are escaped");
assert.match(hostileIcon, /^<span class="service-brand-icon__fallback" aria-hidden="true">/u, "only unknown ids use the escaped generic fallback");

for (const [type, filename] of [["qemu", "vm.svg"], ["lxc", "container.svg"]]) {
  assert.match(workloadIconMarkup(type), new RegExp(`assets/workloads/${filename.replace(".", "\\.")}`, "u"));
  const svg = await readFile(new URL(`../assets/workloads/${filename}`, import.meta.url), "utf8");
  assert.match(svg, /^<svg\b/u, `${filename} must be an SVG document`);
  assert.doesNotMatch(svg, /<(?:script|foreignObject|iframe|object|embed|image)\b|\son[a-z]+\s*=|(?:href|src)\s*=/iu, `${filename} must remain inert`);
}
assert.match(workloadIconMarkup('lxc"><script>'), /assets\/workloads\/vm\.svg/u, "untrusted workload types cannot become asset paths");
assert.match(
  application,
  /portainer-container-mark[^\n]*workloadIconMarkup\("lxc"\)/u,
  "Portainer container rows must use the project-owned local container artwork"
);
assert.match(
  retroCss,
  /\.portainer-container-row\s+\.portainer-container-mark\s*\{[^}]*background:\s*#d7e1df/u,
  "the dark container artwork must retain a readable light plate in the retro theme"
);

const snapshot = {
  version: 1,
  generatedAt: "2026-09-12T21:09:14.000Z",
  overall: {
    state: "degraded",
    activeIncidentCount: 2,
    affectedServiceCount: 2
  },
  services: [
    {
      id: "seerr",
      state: "limited",
      connectionState: "connected",
      lastCheckedAt: "2026-09-12T21:09:14.000Z",
      activeIncidentCount: 1,
      capabilities: [
        { name: "status", state: "healthy", latencyMs: 30 },
        { name: "trending", state: "limited", impact: "optional", code: "HTTP_ERROR", status: 500 }
      ]
    },
    {
      id: "qbittorrent",
      state: "degraded",
      activeIncidentCount: 1,
      capabilities: [{ name: "torrents", state: "degraded", code: "TIMEOUT" }]
    }
  ],
  incidents: [
    {
      id: "seerr:trending",
      service: "seerr",
      capability: "Trending discovery",
      state: "limited",
      impact: "optional",
      code: "HTTP_ERROR",
      status: 500,
      summary: "Seerr discovery is limited",
      firstSeen: "2026-09-12T20:00:00.000Z",
      lastSeen: "2026-09-12T21:09:14.000Z",
      occurrenceCount: 47
    },
    {
      id: "qbit:torrents",
      service: "qbittorrent",
      capability: "Download queue",
      state: "degraded",
      code: "TIMEOUT",
      summary: "Download state cannot be confirmed",
      occurrenceCount: 3
    }
  ],
  recentRecoveries: [
    {
      id: "radarr:queue",
      service: "radarr",
      capability: "Queue",
      previousState: "degraded",
      firstSeen: "2026-09-12T20:00:00.000Z",
      recoveredAt: "2026-09-12T20:10:00.000Z",
      occurrenceCount: 4
    }
  ],
  pipeline: [
    { id: "request", state: "healthy", detail: "Requests accepted", count: 1 },
    { id: "search", state: "healthy", detail: "Indexers available" },
    { id: "download", state: "degraded", detail: "Queue state unavailable", count: 2 },
    { id: "library", state: "healthy", detail: "Jellyfin current" }
  ],
  workload: {
    pendingRequests: 1,
    downloading: 2,
    importing: 1,
    stalled: 1
  }
};

const normalized = normalizeOperationsSnapshot(snapshot);
assert.equal(normalized.overall.state, "degraded");
assert.equal(normalized.incidents[0].service, "qbittorrent", "higher-impact incidents sort first");
assert.equal(normalized.services[0].failedCapabilities[0].name, "trending");
assert.equal(normalized.pipeline.length, 4);
assert.deepEqual(normalized.workload.map(({ label }) => label), ["Pending requests", "Downloading", "Importing", "Stalled"]);

const rendered = renderOperationsOverview(snapshot);
assert.match(rendered, /Stack assessment/u);
assert.match(rendered, /Part of your media pipeline needs attention/u);
assert.match(rendered, /Needs attention/u);
assert.match(rendered, /Seerr discovery is limited/u);
assert.match(rendered, /HTTP 500/u);
assert.match(rendered, /Observed 47 times/u);
assert.match(rendered, /Media pipeline/u);
assert.match(rendered, /Service health/u);
assert.match(rendered, /aria-label="Seerr connection health: Connected"/u);
assert.match(rendered, /aria-label="Seerr service health: Limited"/u);
assert.match(rendered, /aria-label="Open Seerr connection details\. Connection health: Connected\. Service health: Limited\."/u);
assert.match(rendered, /Connection health[\s\S]*is-success[\s\S]*Connected/u);
assert.match(rendered, /Service health[\s\S]*is-warning[\s\S]*Limited/u);
assert.match(rendered, /Current workload/u);
assert.match(rendered, /Recent recoveries/u);
assert.match(rendered, /data-action="refresh-live"/u);
assert.match(rendered, /data-action="open-service"[^>]*data-service-id="seerr"/u);
assert.match(rendered, /data-service-id="seerr"/u);
assert.match(rendered, /href="#\/logs"/u);

const healthy = renderOperationsOverview({
  generatedAt: "2026-09-12T21:09:14.000Z",
  overall: { state: "healthy" },
  services: [{ id: "jellyfin", state: "healthy", capabilities: [{ name: "system", state: "healthy" }] }],
  incidents: []
});
assert.match(healthy, /Everything is working/u);
assert.match(healthy, /No active incidents/u);

const v2Shape = normalizeOperationsSnapshot({
  overall: { state: "limited", headline: "Discovery is limited" },
  services: [{ id: "seerr", state: "limited", connectionState: "connected", checks: [{ name: "trending", state: "limited" }] }],
  incidents: {
    open: [{ service: "seerr", capability: "trending", state: "limited" }],
    recent: [{ service: "radarr", capability: "queue", previousState: "degraded", recoveredAt: "2026-09-12T21:00:00.000Z" }]
  },
  pipeline: [{ id: "request", state: "healthy", summary: "Accepting requests" }]
});
assert.equal(v2Shape.incidents.length, 1, "v2 incident collections expose open incidents");
assert.equal(v2Shape.recentRecoveries.length, 1, "v2 incident collections expose recent recoveries");
assert.equal(v2Shape.services[0].capabilities.length, 1, "v2 service checks map to capabilities");
assert.equal(v2Shape.services[0].connectionState, "connected", "connection state remains separate from operational health");
assert.equal(v2Shape.pipeline[0].detail, "Accepting requests");

const monitorShape = normalizeOperationsSnapshot({
  generatedAt: "2026-09-12T21:09:14.000Z",
  overall: { state: "auth_required", openIncidentCount: 1, affectedServiceCount: 1 },
  services: [{
    id: "seerr",
    label: "Seerr",
    state: "auth_required",
    checkedAt: "2026-09-12T21:09:14.000Z",
    checks: [{ id: "request_status", state: "auth_required", httpStatus: 401, checkedAt: "2026-09-12T21:09:14.000Z" }]
  }],
  pipeline: { state: "auth_required", stages: [{ id: "requests", label: "Requests", state: "auth_required", serviceCount: 1, failingCheckCount: 1 }] },
  incidents: { open: [{ service: "seerr", capability: "request_status", state: "auth_required", code: "UNAUTHORIZED", httpStatus: 401 }], recent: [] }
});
assert.equal(monitorShape.overall.state, "authentication-required");
assert.equal(monitorShape.overall.activeIncidentCount, 1);
assert.equal(monitorShape.services[0].name, "Seerr");
assert.equal(monitorShape.services[0].capabilities[0].name, "Request status");
assert.equal(monitorShape.services[0].capabilities[0].status, 401);
assert.equal(monitorShape.incidents[0].status, 401);
assert.equal(monitorShape.pipeline[0].hint, "Seerr");

const arrReports = Array.from({ length: 14 }, (_value, index) => ({
  severity: index === 1 ? "notice" : "warning",
  source: index === 0
    ? 'DownloadClientCheck </small><img src=x onerror="report-source-xss">'
    : `RadarrHealthCheck${index + 1}`,
  message: index === 0
    ? "Download client uses a root folder. <script>report-message-xss</script>"
    : `Upstream health message ${index + 1}`
}));

const arrWarningSnapshot = {
  overall: { state: "limited", openIncidentCount: 1, affectedServiceCount: 1 },
  services: [{
    id: "radarr",
    state: "limited",
    connectionState: "connected",
    checks: [{
      id: "health",
      state: "limited",
      code: "HEALTH_WARNING",
      httpStatus: null,
      metrics: { healthWarnings: 2, healthErrors: 0, healthNotices: 0 },
      reports: arrReports
    }]
  }],
  incidents: {
    open: [{
      service: "radarr",
      capability: "health",
      state: "limited",
      code: "HEALTH_WARNING",
      httpStatus: null,
      occurrenceCount: 8
    }],
    recent: []
  }
};
const normalizedArrWarning = normalizeOperationsSnapshot(arrWarningSnapshot);
assert.equal(normalizedArrWarning.services[0].capabilities[0].status, null);
assert.equal(normalizedArrWarning.incidents[0].status, null, "an absent HTTP status must remain absent");
assert.equal(normalizedArrWarning.incidents[0].currentCount, 2);
assert.equal(normalizedArrWarning.incidents[0].summary, "Radarr reports 2 current application health warnings.");
assert.equal(normalizedArrWarning.services[0].capabilities[0].reports.length, 12, "service reports are bounded to twelve entries");
assert.deepEqual(
  normalizedArrWarning.incidents[0].reports,
  normalizedArrWarning.services[0].capabilities[0].reports,
  "an incident receives reports only from its current service capability"
);
const renderedArrWarning = renderOperationsOverview(arrWarningSnapshot);
assert.doesNotMatch(renderedArrWarning, /HTTP 100/u, "a missing HTTP status must not be rendered as HTTP 100");
assert.doesNotMatch(renderedArrWarning, /health is unavailable/u, "a reported Arr warning is not an unavailable health endpoint");
assert.match(renderedArrWarning, /Observed 8 times/u, "poll observations must not be confused with warning count");
assert.match(renderedArrWarning, /Review Radarr System → Status/u);
assert.match(renderedArrWarning, /Reported by Radarr/u);
assert.match(renderedArrWarning, /Download client uses a root folder\./u);
assert.match(renderedArrWarning, /DownloadClientCheck &lt;\/small&gt;&lt;img src=x onerror=&quot;report-source-xss&quot;&gt;/u);
assert.match(renderedArrWarning, /&lt;script&gt;report-message-xss&lt;\/script&gt;/u);
assert.doesNotMatch(renderedArrWarning, /<script>report-message-xss<\/script>|<img src=x onerror="report-source-xss">/u);
assert.equal((renderedArrWarning.match(/class="operations-report is-/gu) || []).length, 12, "rendering cannot exceed the report contract bound");

const hostile = renderOperationsOverview({
  overall: { state: "degraded", headline: '<img src=x onerror="alert(1)">' },
  incidents: [{
    service: "seerr",
    capability: "Trending </h3><script>alert(1)</script>",
    state: "limited",
    summary: "Failure <svg onload=alert(1)>",
    nextStep: "Inspect </p><iframe src=x>"
  }],
  workload: { items: [{ id: "stalled", value: 1, href: "javascript:alert(1)" }] }
});
assert.equal(hostile.includes("<img src=x"), false);
assert.equal(hostile.includes("<script>alert(1)</script>"), false);
assert.equal(hostile.includes("javascript:alert(1)"), false);
assert.match(hostile, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/u);
assert.match(hostile, /href="#\/pipeline"/u, "untrusted workload routes fall back to an internal route");
assert.equal(escapeOperationsHtml("<>&\"'"), "&lt;&gt;&amp;&quot;&#039;");

const explicitFailure = normalizeOperationsSnapshot({
  services: [{ id: "example", state: "degraded" }],
  incidents: [{
    service: "example",
    capability: "task-history",
    state: "degraded",
    code: "HTTP_ERROR",
    status: 400
  }]
});
assert.equal(
  explicitFailure.incidents[0].summary,
  "Example task history returned HTTP 400.",
  "specific HTTP evidence must take precedence over a generic degraded summary"
);
const explicitCodeFailure = normalizeOperationsSnapshot({
  services: [{ id: "example", state: "limited" }],
  incidents: [{
    service: "example",
    capability: "backup-history",
    state: "limited",
    code: "TASK_QUERY_REJECTED"
  }]
});
assert.equal(
  explicitCodeFailure.incidents[0].summary,
  "Example backup history reported task query rejected.",
  "specific failure codes must take precedence over a generic limited summary"
);

assert.match(
  incidentNextStep({
    scope: "infrastructure",
    capability: "Recent failed tasks",
    code: "TASK_HISTORY_UNAVAILABLE",
    status: null,
    nextStep: ""
  }),
  /affected nodes named in the sanitized report.*node reachability.*Sys\.Audit.*retest/iu,
  "unavailable node history must remain actionable when no single HTTP status represents every node"
);
assert.match(
  incidentNextStep({
    scope: "infrastructure",
    capability: "Backup freshness",
    code: "BACKUP_HISTORY_PARTIAL",
    status: null,
    nextStep: ""
  }),
  /affected nodes named in the sanitized report.*Sys\.Audit.*retest/iu,
  "partial backup history must direct the operator to the scoped node reports"
);
assert.match(
  incidentNextStep({
    scope: "infrastructure",
    capability: "Recent failed tasks",
    code: "TASK_HISTORY_UNAVAILABLE",
    status: 400,
    nextStep: ""
  }),
  /base URL.*PVE API compatibility.*node-scoped.*retest/iu,
  "HTTP 400 task history must suggest checking the configured base URL and PVE compatibility"
);
const forbiddenHistoryNextStep = incidentNextStep({
  scope: "infrastructure",
  capability: "Backup freshness",
  code: "BACKUP_HISTORY_UNAVAILABLE",
  status: 403,
  nextStep: ""
});
assert.match(forbiddenHistoryNextStep, /propagated Sys\.Audit.*\/nodes\/\{node\}.*retest/iu);
assert.doesNotMatch(forbiddenHistoryNextStep, /Datastore\.Audit/iu, "task history does not require Datastore.Audit");

const proxmoxDiagnosticSecret = "pve-root@pam!helmsman=credential-secret";
const proxmoxUpstreamBody = "upstream response body must remain server-side";
const renderedProxmoxDiagnostic = renderOperationsReports([{
  severity: "warning",
  source: "Recent failed tasks · Node pve-a",
  message: "GET /api2/json/nodes/pve-a/tasks?source=archive&limit=100 failed. Proxmox rejected the node-scoped task request with HTTP 400. Verify Proxmox API compatibility and the configured base URL, then retry.",
  tokenSecret: proxmoxDiagnosticSecret,
  upstreamBody: proxmoxUpstreamBody
}], "Lab Cluster");
assert.match(renderedProxmoxDiagnostic, /Recent failed tasks · Node pve-a/u, "the affected node must remain visible");
assert.match(renderedProxmoxDiagnostic, /GET \/api2\/json\/nodes\/pve-a\/tasks\?source=archive&amp;limit=100 failed\./u, "the safe operation and endpoint scope must remain visible");
assert.match(renderedProxmoxDiagnostic, /HTTP 400/u, "the safe upstream status must remain visible");
assert.match(renderedProxmoxDiagnostic, /Verify Proxmox API compatibility.*configured base URL.*retry/iu, "the suggested action must remain visible");
assert.doesNotMatch(renderedProxmoxDiagnostic, new RegExp(`${proxmoxDiagnosticSecret}|${proxmoxUpstreamBody}`, "u"), "unknown credential and raw upstream fields must not render");

const proxmoxTargetId = "33333333-3333-4333-8333-333333333333";
const proxmoxConfiguration = [{
  id: proxmoxTargetId,
  type: "proxmox",
  displayName: "Lab Cluster",
  url: "https://10.44.0.11:8006",
  enabled: true,
  monitoringEnabled: true,
  tlsMode: "pinned",
  certificateFingerprint: "a".repeat(64),
  credentialConfigured: true
}];
const proxmoxSnapshot = {
  generatedAt: "2026-09-13T12:00:00.000Z",
  infrastructure: {
    state: "limited",
    targetCount: 1,
    affectedTargetCount: 1,
    code: "RECENT_TASK_FAILURES",
    targets: [{
      id: proxmoxTargetId,
      type: "proxmox",
      displayName: "Lab Cluster",
      state: "limited",
      connectionState: "connected",
      latencyMs: 18,
      checkedAt: "2026-09-13T12:00:00.000Z",
      version: "8.3.5",
      metrics: {
        nodeTotal: 3,
        nodeOnline: 2,
        nodeOffline: 1,
        nodeCpuUsagePercent: 64.2,
        nodeMemoryUsedBytes: 34_359_738_368,
        nodeMemoryTotalBytes: 68_719_476_736,
        nodeDiskUsedBytes: 120_000_000_000,
        nodeDiskTotalBytes: 240_000_000_000,
        guestTotal: 12,
        guestRunning: 9,
        guestStopped: 3,
        virtualMachineTotal: 8,
        containerTotal: 4,
        storageTotal: 4,
        storageAvailable: 3,
        storageUnavailable: 1,
        storageUsedBytes: 800_000_000_000,
        storageTotalBytes: 1_000_000_000_000,
        storageUsagePercent: 80,
        failedTasks24h: 2,
        backupFailures24h: 1,
        lastBackupSuccessAgeSeconds: 3_600
      },
      capabilities: [
        { id: "identity", label: "API authorization", state: "healthy", ok: true, latencyMs: 8 },
        { id: "version", label: "Proxmox version", state: "healthy", ok: true, latencyMs: 9 },
        { id: "nodes", label: "Node availability", state: "degraded", ok: false, code: "NODES_OFFLINE", latencyMs: 10 },
        { id: "node-resources", label: "Node resources", state: "healthy", ok: true, latencyMs: 11 },
        { id: "guests", label: "Virtual guests", state: "healthy", ok: true, latencyMs: 12 },
        {
          id: "storage",
          label: "Storage availability",
          state: "degraded",
          ok: false,
          code: "STORAGE_UNAVAILABLE",
          reports: [{
            severity: "warning",
            source: "StorageCheck",
            message: 'Local-ZFS is unavailable <img src=x onerror="proxmox-report-xss">'
          }]
        },
        { id: "tasks", label: "Recent failed tasks", state: "limited", ok: false, code: "RECENT_TASK_FAILURES" },
        { id: "backups", label: "Backup freshness", state: "limited", ok: false, code: "LATEST_BACKUP_FAILED" }
      ]
    }]
  },
  incidents: {
    open: [{
      service: `proxmox-${proxmoxTargetId}`,
      capability: "storage",
      state: "degraded",
      code: "STORAGE_UNAVAILABLE",
      occurrenceCount: 2
    }],
    recent: []
  }
};

const normalizedInfrastructure = normalizeInfrastructureSnapshot(proxmoxSnapshot, proxmoxConfiguration);
assert.equal(normalizedInfrastructure.overall.state, "limited");
assert.equal(normalizedInfrastructure.targets[0].connectionState, "connected");
assert.equal(normalizedInfrastructure.metrics.nodesOnline, 2, "the exact monitor nodeOnline field must be consumed");
assert.equal(normalizedInfrastructure.metrics.guestsRunning, 9, "the exact monitor guestRunning field must be consumed");
assert.equal(normalizedInfrastructure.metrics.storagePercent, 80, "the exact monitor storageUsagePercent field must be consumed");
assert.equal(normalizedInfrastructure.metrics.storageWarnings, 1, "storageUnavailable must surface as an actionable warning");
assert.equal(normalizedInfrastructure.metrics.failedTasks, 2, "failedTasks24h must be consumed");
assert.equal(normalizedInfrastructure.metrics.backupIssues, 1, "backupFailures24h must be consumed");
assert.equal(normalizedInfrastructure.metrics.nodeMemoryTotalBytes, 68_719_476_736, "byte metrics must not be clipped by display bounds");
const snapshotOnlyInfrastructure = normalizeInfrastructureSnapshot(proxmoxSnapshot);
assert.equal(snapshotOnlyInfrastructure.targets[0].displayName, "Lab Cluster", "snapshot-only targets must be normalized when configuration metadata is unavailable");
assert.equal(snapshotOnlyInfrastructure.metrics.nodesOnline, 2, "snapshot-only targets must retain exact monitor metrics");
assert.ok(snapshotOnlyInfrastructure.targets[0].displayName.length <= 80, "snapshot-only target text remains bounded");
const boundedSnapshotOnlyTarget = normalizeInfrastructureSnapshot({
  infrastructure: {
    targets: [{
      id: proxmoxTargetId,
      displayName: "X".repeat(500),
      state: "healthy",
      metrics: { nodeOnline: 1 }
    }]
  }
});
assert.equal(boundedSnapshotOnlyTarget.targets[0].displayName.length, 80, "unmatched snapshot metadata must pass through the same text bounds as configured targets");

const renderedInfrastructure = renderInfrastructureOverview(proxmoxSnapshot, proxmoxConfiguration, { configuredOnly: true });
assert.match(renderedInfrastructure, /Infrastructure assessment/u);
assert.match(renderedInfrastructure, /Lab Cluster/u);
assert.match(renderedInfrastructure, /2 \/ 3/u);
assert.match(renderedInfrastructure, /64\.2%/u);
assert.match(renderedInfrastructure, /50%/u);
assert.match(renderedInfrastructure, /1 unavailable storage entry/u);
assert.match(renderedInfrastructure, /data-action="open-infrastructure-environment-detail"/u);
assert.doesNotMatch(renderedInfrastructure, /data-action="open-infrastructure-target"|Connect and discover|Connect Portainer/u, "Infrastructure Overview must not expose connector setup actions");
const emptyInfrastructureOverview = renderInfrastructureOverview({ infrastructure: { targets: [] } }, [], { configuredOnly: true });
assert.match(emptyInfrastructureOverview, /No infrastructure connections yet/u);
assert.match(emptyInfrastructureOverview, /href="#\/connectors">Open Connectors/u);
assert.doesNotMatch(emptyInfrastructureOverview, /Connect and discover|Connect Portainer|Infrastructure signals/u, "an empty Overview must remain provider-neutral");

const disabledInfrastructure = normalizeInfrastructureSnapshot({
  infrastructure: { state: "stale", targets: [] }
}, [{ ...proxmoxConfiguration[0], monitoringEnabled: false }]);
assert.equal(disabledInfrastructure.overall.state, "disabled", "no enabled, monitored target must override the backend's empty stale state");
assert.equal(disabledInfrastructure.targets[0].state, "disabled");
const disabledTarget = normalizeInfrastructureSnapshot({
  infrastructure: { state: "stale", targets: [{ id: proxmoxTargetId, state: "healthy", enabled: false }] }
});
assert.equal(disabledTarget.overall.state, "disabled", "a disabled health-only target must not make Infrastructure stale");
assert.equal(disabledTarget.targets[0].state, "disabled");

const globalIncidentSnapshot = normalizeOperationsSnapshot(proxmoxSnapshot, proxmoxConfiguration);
assert.equal(globalIncidentSnapshot.incidents[0].serviceName, "Lab Cluster", "global incidents must use the configured Proxmox display name");
assert.equal(globalIncidentSnapshot.incidents[0].reports.length, 1, "global incidents must join current Proxmox capability reports");
assert.equal(globalIncidentSnapshot.incidents[0].reports[0].message, 'Local-ZFS is unavailable <img src=x onerror="proxmox-report-xss">');
assert.doesNotMatch(renderOperationsOverview(proxmoxSnapshot, proxmoxConfiguration), /Lab Cluster/u, "the media overview must not absorb global infrastructure incidents");

const portainerServiceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const portainerReport = 'reverse-proxy is unhealthy <img src=x onerror="portainer-report-xss">';
const portainerSnapshot = {
  generatedAt: "2026-09-13T13:00:00.000Z",
  overall: { state: "healthy", serviceCount: 0, affectedServiceCount: 0, openIncidentCount: 0 },
  services: [],
  infrastructure: {
    state: "degraded",
    targets: [],
    services: [{
      id: portainerServiceId,
      type: "portainer",
      displayName: "Container Control",
      state: "degraded",
      connectionState: "connected",
      capabilities: [{
        id: "environment-1",
        label: "Docker environment",
        state: "degraded",
        code: "CONTAINERS_UNHEALTHY",
        reports: [{ severity: "error", source: "Docker environment", message: portainerReport }]
      }]
    }]
  },
  incidents: {
    open: [{
      service: `portainer-${portainerServiceId}`,
      capability: "environment-1",
      state: "degraded",
      code: "CONTAINERS_UNHEALTHY",
      occurrenceCount: 3
    }],
    recent: [{
      service: `portainer-${portainerServiceId}`,
      capability: "identity",
      previousState: "authentication-required",
      recoveredAt: "2026-09-13T12:55:00.000Z"
    }]
  }
};
const normalizedPortainerIncident = normalizeOperationsSnapshot(portainerSnapshot);
assert.equal(normalizedPortainerIncident.incidents[0].scope, "infrastructure");
assert.equal(normalizedPortainerIncident.incidents[0].serviceName, "Container Control");
assert.equal(normalizedPortainerIncident.incidents[0].reports[0].message, portainerReport);
assert.equal(normalizedPortainerIncident.recentRecoveries[0].scope, "infrastructure");
assert.equal(normalizedPortainerIncident.recentRecoveries[0].serviceName, "Container Control");
assert.match(incidentNextStep(normalizedPortainerIncident.incidents[0]), /Portainer inventory.*unhealthy, dead, or restarting container/iu);
const renderedPortainerMedia = renderOperationsOverview(portainerSnapshot);
assert.doesNotMatch(renderedPortainerMedia, /Container Control|reverse-proxy|CONTAINERS_UNHEALTHY/u, "the Media overview must never absorb Portainer infrastructure incidents");
assert.doesNotMatch(renderedPortainerMedia, /<img src=x onerror="portainer-report-xss">/u);
const portainerOverview = renderInfrastructureOverview(portainerSnapshot, [], {
  configuredOnly: true,
  overallState: "degraded",
  lastCheckedAt: "2026-09-13T13:00:00.000Z",
  portainerServices: [{
    id: portainerServiceId,
    displayName: 'Container Control <img src=x onerror="portainer-overview-xss">',
    url: "https://portainer.example.internal:9443",
    state: "degraded",
    connectionState: "connected",
    version: "2.45.0",
    credentialConfigured: true,
    metrics: {
      environmentTotal: 2,
      environmentOnline: 2,
      containerTotal: 17,
      containerRunning: 16,
      stackTotal: 4
    },
    accessToken: "must-not-render"
  }]
});
assert.match(portainerOverview, /Portainer servers/u);
assert.match(portainerOverview, /data-action="open-portainer-overview" data-portainer-overview-id=/u, "a Portainer Overview row must open its own filtered inventory");
assert.match(portainerOverview, /Container Control &lt;img src=x onerror=&quot;portainer-overview-xss&quot;&gt;/u);
assert.match(portainerOverview, /16\/17 containers running/u);
assert.doesNotMatch(portainerOverview, /Proxmox environments|Infrastructure signals|Connect Portainer|Connect and discover|must-not-render|<img src=x/u, "a Portainer-only Overview must show only configured, escaped current state");
const mixedInfrastructureOverview = renderInfrastructureOverview({
  ...proxmoxSnapshot,
  infrastructure: {
    ...proxmoxSnapshot.infrastructure,
    overall: {
      state: "healthy",
      headline: "Proxmox-specific healthy headline",
      summary: "Proxmox-specific healthy summary"
    }
  }
}, proxmoxConfiguration, {
  configuredOnly: true,
  overallState: "down",
  portainerServices: [{
    id: portainerServiceId,
    displayName: "Unavailable Portainer",
    state: "down",
    connectionState: "down",
    credentialConfigured: true
  }]
});
assert.match(mixedInfrastructureOverview, /An infrastructure connection is unavailable/u, "mixed providers must use copy for their combined health state");
assert.doesNotMatch(mixedInfrastructureOverview, /Proxmox-specific healthy/u, "healthy Proxmox copy must not contradict a failed Portainer connection");

console.log("Operations view contract passed: media and configured-only infrastructure health, incidents, reports, actions, and escaping.");
