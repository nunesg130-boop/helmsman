const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function loadPlaywright() {
  const runtimeModules = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
  if (runtimeModules) {
    const runtimePlaywright = path.join(runtimeModules, "playwright");
    if (existsSync(runtimePlaywright)) return require(runtimePlaywright);
  }
  return require("playwright");
}

function installedBrowserPath(chromium) {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    chromium.executablePath()
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

const mediaSnapshot = {
  generatedAt: "2026-09-12T21:09:14.000Z",
  overall: { state: "degraded", activeIncidentCount: 2, affectedServiceCount: 2 },
  services: [
    { id: "jellyfin", state: "healthy", latencyMs: 154, version: "10.11.8", checks: [{ name: "Playback", state: "healthy" }] },
    { id: "seerr", state: "limited", latencyMs: 82, checks: [{ name: "Requests", state: "healthy" }, { name: "Trending", state: "limited" }] },
    { id: "radarr", state: "healthy", latencyMs: 116, checks: [{ name: "Queue", state: "healthy" }] },
    { id: "qbittorrent", state: "degraded", checks: [{ name: "Torrent list", state: "degraded" }] }
  ],
  incidents: {
    open: [
      { service: "qbittorrent", capability: "Download queue", state: "degraded", code: "TIMEOUT", summary: "Download state cannot be confirmed", occurrenceCount: 3, firstSeen: "2026-09-12T20:58:00.000Z", lastSeen: "2026-09-12T21:09:14.000Z" },
      { service: "seerr", capability: "Trending discovery", state: "limited", code: "HTTP_ERROR", status: 500, summary: "Seerr discovery is limited", occurrenceCount: 47, firstSeen: "2026-09-12T20:00:00.000Z", lastSeen: "2026-09-12T21:09:14.000Z" }
    ],
    recent: [{ service: "radarr", capability: "Queue", previousState: "degraded", firstSeen: "2026-09-12T20:00:00.000Z", recoveredAt: "2026-09-12T20:10:00.000Z" }]
  },
  pipeline: [
    { id: "request", state: "healthy", summary: "Requests accepted", count: 1 },
    { id: "search", state: "healthy", summary: "Indexers available" },
    { id: "download", state: "degraded", summary: "Queue state unavailable", count: 2 },
    { id: "import", state: "healthy", summary: "Imports current" },
    { id: "library", state: "healthy", summary: "Jellyfin current" }
  ],
  workload: { pendingRequests: 1, queued: 3, downloading: 2, importing: 1, stalled: 1, activeStreams: 2 }
};

const infrastructureTargetId = "lab-cluster";
const infrastructureConfiguration = [{
  id: infrastructureTargetId,
  type: "proxmox",
  displayName: "Lab Cluster",
  url: "https://10.44.0.11:8006",
  enabled: true,
  monitoringEnabled: true,
  tlsMode: "pinned",
  certificateFingerprint: "a".repeat(64),
  credentialConfigured: true
}];
const infrastructureSnapshot = {
  generatedAt: "2026-09-12T21:09:14.000Z",
  overall: { state: "limited", activeIncidentCount: 1, affectedServiceCount: 1 },
  infrastructure: {
    generatedAt: "2026-09-12T21:09:14.000Z",
    overall: { state: "limited" },
    targets: [{
      id: infrastructureTargetId,
      type: "proxmox",
      displayName: "Lab Cluster",
      state: "limited",
      connectionState: "connected",
      latencyMs: 18,
      checkedAt: "2026-09-12T21:09:14.000Z",
      version: "8.3.5",
      discovery: { kind: "cluster", name: "Lab Cluster", clusterName: "homelab", quorate: true },
      capabilities: [
        { id: "nodes", name: "Node inventory", state: "healthy", latencyMs: 18 },
        { id: "tasks", name: "Recent tasks", state: "limited", latencyMs: 17 }
      ],
      metrics: {
        nodeTotal: 2,
        nodeOnline: 2,
        nodeOffline: 0,
        nodeCpuUsagePercent: 34.5,
        nodeMemoryUsedBytes: 51539607552,
        nodeMemoryTotalBytes: 103079215104,
        nodeDiskUsedBytes: 214748364800,
        nodeDiskTotalBytes: 536870912000,
        guestTotal: 5,
        guestRunning: 4,
        guestStopped: 1,
        virtualMachineTotal: 2,
        containerTotal: 3,
        storageUnavailable: 0,
        storageUsedBytes: 429496729600,
        storageTotalBytes: 1073741824000,
        failedTasks24h: 1,
        backupFailures24h: 0,
        lastBackupSuccessAgeSeconds: 3600
      },
      nodes: [{
        name: "Main",
        status: "online",
        local: true,
        cpuPercent: 34.5,
        cpuCores: 24,
        memoryUsedBytes: 51539607552,
        memoryTotalBytes: 103079215104,
        rootDiskUsedBytes: 214748364800,
        rootDiskTotalBytes: 536870912000,
        uptimeSeconds: 637200,
        workloadCount: 5,
        runningWorkloadCount: 4,
        virtualMachineCount: 2,
        containerCount: 3
      }],
      workloads: [
        { type: "qemu", vmid: 100, name: "Jelly-Arr", node: "Main", status: "running", cpuPercent: 12.5, cpuCores: 8, memoryUsedBytes: 12884901888, memoryTotalBytes: 25769803776 },
        { type: "lxc", vmid: 201, name: "Media Automation", node: "Main", status: "running", cpuPercent: 4.2, cpuCores: 4, memoryUsedBytes: 4294967296, memoryTotalBytes: 8589934592 }
      ]
    }]
  },
  incidents: {
    open: [{
      service: `proxmox-${infrastructureTargetId}`,
      capability: "tasks",
      state: "limited",
      code: "RECENT_TASK_FAILURES",
      summary: "A recent infrastructure task needs attention",
      occurrenceCount: 1,
      firstSeen: "2026-09-12T20:58:00.000Z",
      lastSeen: "2026-09-12T21:09:14.000Z"
    }],
    recent: [{
      service: `proxmox-${infrastructureTargetId}`,
      capability: "backups",
      previousState: "degraded",
      firstSeen: "2026-09-12T18:00:00.000Z",
      recoveredAt: "2026-09-12T20:10:00.000Z"
    }]
  }
};
const portainerServices = [{
  id: "container-control",
  displayName: "Container Control",
  url: "https://10.44.0.12:9443",
  enabled: true,
  monitoringEnabled: true,
  state: "healthy",
  connectionState: "connected",
  version: "2.45.0",
  credentialConfigured: true,
  metrics: { environmentTotal: 2, environmentOnline: 2, containerTotal: 17, containerRunning: 16, stackTotal: 4 }
}];

function documentMarkup(css, markup) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}\nhtml, body { overflow-x: visible !important; }</style></head><body><main>${markup}</main></body></html>`;
}

function near(actual, expected, message, tolerance = 2) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, received ${actual}`);
}

async function assertNoPageErrors(page, errors, viewport, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  }));
  assert.ok(dimensions.documentWidth <= dimensions.viewport + 1, `${viewport.width}px ${label} overflows horizontally by ${dimensions.documentWidth - dimensions.viewport}px`);
  assert.deepEqual(errors, [], `${viewport.width}px ${label} emitted page errors`);
}

(async () => {
  const root = path.resolve(__dirname, "..");
  const { renderInfrastructureOverview, renderOperationsOverview } = await import(pathToFileURL(path.join(root, "src/ui/operations-views.js")).href);
  const cssFiles = ["styles.css", "src/ui/operations.css", "src/ui/control.css", "src/ui/logging.css", "src/ui/retro.css"];
  const css = cssFiles.map((file) => readFileSync(path.join(root, file), "utf8")).join("\n");
  const mediaMarkup = renderOperationsOverview(mediaSnapshot);
  const infrastructureMarkup = renderInfrastructureOverview(infrastructureSnapshot, infrastructureConfiguration, {
    configuredOnly: true,
    overallState: "limited",
    lastCheckedAt: infrastructureSnapshot.generatedAt,
    portainerServices
  });
  const { chromium } = loadPlaywright();
  const executablePath = installedBrowserPath(chromium);
  assert.ok(executablePath, "Operations visual contract requires an installed Chromium/Chrome/Edge executable; set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH when it is installed elsewhere.");
  const browser = await chromium.launch({ headless: true, executablePath });

  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
      const mediaPage = await browser.newPage({ viewport, colorScheme: "dark", reducedMotion: "reduce" });
      const mediaErrors = [];
      mediaPage.on("pageerror", (error) => mediaErrors.push(error.message));
      await mediaPage.setContent(documentMarkup(css, mediaMarkup), { waitUntil: "load" });
      await assertNoPageErrors(mediaPage, mediaErrors, viewport, "Media Operations overview");
      assert.equal(await mediaPage.locator("#operations-overall-title").isVisible(), true, `${viewport.width}px Media Operations assessment must remain visible`);
      assert.equal(await mediaPage.locator("#operations-incidents-title").isVisible(), true, `${viewport.width}px Media Operations incidents must remain visible`);
      await mediaPage.close();

      const page = await browser.newPage({ viewport, colorScheme: "dark", reducedMotion: "reduce" });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent(documentMarkup(css, infrastructureMarkup), { waitUntil: "load" });
      await assertNoPageErrors(page, errors, viewport, "Infrastructure Overview");

      for (const selector of [
        "#infrastructure-overall-title",
        "#infrastructure-signals-title",
        "#infrastructure-targets-title",
        "#portainer-connections-title",
        "#infrastructure-workloads-title",
        "#infrastructure-overview-incidents-title"
      ]) {
        assert.equal(await page.locator(selector).isVisible(), true, `${viewport.width}px Infrastructure section ${selector} must remain visible`);
      }

      const geometry = await page.evaluate(() => {
        const rectFor = (element) => {
          const value = element.getBoundingClientRect();
          return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
        };
        const bento = document.querySelector(".infrastructure-bento");
        const cards = [...bento.querySelectorAll(":scope > .infrastructure-overview-card")].map((element) => ({
          classes: element.className,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          ...rectFor(element)
        }));
        const nestedSurfaces = [...bento.querySelectorAll(".infrastructure-signal-row, .infrastructure-target, .infrastructure-overview-workload, .infrastructure-overview-incident")].map((element) => ({
          classes: element.className,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          ...rectFor(element)
        }));
        return {
          bento: {
            ...rectFor(bento),
            clientWidth: bento.clientWidth,
            scrollWidth: bento.scrollWidth,
            gridColumns: getComputedStyle(bento).gridTemplateColumns.trim().split(/\s+/u).filter(Boolean).length
          },
          cards,
          nestedSurfaces
        };
      });

      assert.ok(geometry.bento.scrollWidth <= geometry.bento.clientWidth + 1, `${viewport.width}px Infrastructure bento contents must not be clipped`);
      for (const card of geometry.cards) {
        assert.ok(card.left >= geometry.bento.left - 1 && card.right <= geometry.bento.right + 1, `${viewport.width}px ${card.classes} must stay inside the Infrastructure bento`);
        assert.ok(card.scrollWidth <= card.clientWidth + 1, `${viewport.width}px ${card.classes} must not clip horizontal card content`);
      }
      for (const surface of geometry.nestedSurfaces) {
        assert.ok(surface.left >= geometry.bento.left - 1 && surface.right <= geometry.bento.right + 1, `${viewport.width}px ${surface.classes} must stay inside the Infrastructure bento`);
        assert.ok(surface.scrollWidth <= surface.clientWidth + 1, `${viewport.width}px ${surface.classes} must not clip horizontal content`);
      }

      const card = (token) => geometry.cards.find(({ classes }) => classes.split(/\s+/u).includes(token));
      const assessment = card("infrastructure-assessment-card");
      const signals = card("infrastructure-signals-card");
      const proxmox = card("infrastructure-proxmox-card");
      const portainer = card("infrastructure-portainer-card");
      const workloads = card("infrastructure-workloads-card");
      const incidents = card("infrastructure-incidents-card");
      assert.ok(assessment && signals && proxmox && portainer && workloads && incidents, `${viewport.width}px Infrastructure fixture must render every bento card type`);

      if (viewport.width <= 1320) {
        assert.equal(geometry.bento.gridColumns, 1, `${viewport.width}px Infrastructure bento must collapse to one column`);
        geometry.cards.slice(1).forEach((current, index) => {
          assert.ok(current.top >= geometry.cards[index].bottom - 1, `${viewport.width}px Infrastructure cards must retain their vertical reading order`);
        });
      } else {
        assert.equal(geometry.bento.gridColumns, 2, `${viewport.width}px Infrastructure bento must use two desktop columns`);
        near(assessment.left, geometry.bento.left, `${viewport.width}px Infrastructure assessment left edge`);
        near(assessment.right, geometry.bento.right, `${viewport.width}px Infrastructure assessment right edge`);
        near(signals.left, geometry.bento.left, `${viewport.width}px Infrastructure signals left edge`);
        near(signals.right, geometry.bento.right, `${viewport.width}px Infrastructure signals right edge`);
        near(proxmox.top, portainer.top, `${viewport.width}px provider cards must align on one desktop row`);
        near(proxmox.width, portainer.width, `${viewport.width}px provider cards must use equal desktop tracks`);
        near(workloads.top, incidents.top, `${viewport.width}px workload and incident cards must align on one desktop row`);
        near(workloads.width, incidents.width, `${viewport.width}px workload and incident cards must use equal desktop tracks`);
      }

      const action = page.locator(".infrastructure-overview-heading__action").first();
      await action.focus();
      const focus = await action.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { tagName: element.tagName, outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), width: rect.width, height: rect.height };
      });
      assert.match(focus.tagName, /^(?:A|BUTTON)$/u, `${viewport.width}px Infrastructure heading action must use native semantics`);
      assert.notEqual(focus.outlineStyle, "none", `${viewport.width}px Infrastructure heading action must retain a visible focus outline`);
      assert.ok(focus.outlineWidth >= 2, `${viewport.width}px Infrastructure heading action must retain at least a 2px focus outline`);
      assert.ok(focus.width >= 44 && focus.height >= 44, `${viewport.width}px Infrastructure heading action must retain a 44px target`);

      const target = page.locator(".infrastructure-target").first();
      const beforeHover = await target.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderColor }));
      await target.hover();
      const afterHover = await target.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderColor }));
      assert.notDeepEqual(afterHover, beforeHover, `${viewport.width}px Infrastructure target hover must highlight the whole target card`);

      const reducedMotion = await page.locator(".operations-refresh").evaluate((element) => {
        const style = getComputedStyle(element);
        return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration };
      });
      const durations = `${reducedMotion.animationDuration},${reducedMotion.transitionDuration}`
        .split(",")
        .map((value) => Number.parseFloat(value) || 0);
      assert.ok(durations.every((duration) => duration <= 0.00001), `${viewport.width}px reduced-motion preferences must suppress long control motion`);
      await page.close();
    }
    console.log("Operations visual contract passed for Media Operations and the responsive Infrastructure bento at desktop, laptop, tablet, and mobile widths.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
