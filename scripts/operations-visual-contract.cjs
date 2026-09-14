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

const snapshot = {
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

(async () => {
  const root = path.resolve(__dirname, "..");
  const { renderOperationsOverview } = await import(pathToFileURL(path.join(root, "src/ui/operations-views.js")).href);
  const css = `${readFileSync(path.join(root, "styles.css"), "utf8")}\n${readFileSync(path.join(root, "src/ui/operations.css"), "utf8")}`;
  const markup = renderOperationsOverview(snapshot);
  const { chromium } = loadPlaywright();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 800 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, colorScheme: "dark", reducedMotion: "reduce" });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><main>${markup}</main></body></html>`, { waitUntil: "load" });
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      if (dimensions.content - dimensions.viewport > 2) throw new Error(`${viewport.width}px viewport overflows by ${dimensions.content - dimensions.viewport}px`);
      if (errors.length) throw new Error(`${viewport.width}px viewport emitted: ${errors.join(", ")}`);
      if (!(await page.locator("#operations-overall-title").isVisible())) throw new Error(`${viewport.width}px assessment is not visible`);
      if (!(await page.locator("#operations-incidents-title").isVisible())) throw new Error(`${viewport.width}px incidents are not visible`);
      await page.close();
    }
    console.log("Operations visual contract passed at desktop, tablet, and mobile widths.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
