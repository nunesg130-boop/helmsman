const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

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

function homeFixture() {
  const cards = Array.from({ length: 16 }, (_, index) => `
    <button class="poster-card" type="button">
      <span class="poster-art"></span>
      <span class="poster-copy"><strong>Title ${index + 1}</strong><span>2026 · Available</span></span>
    </button>`).join("");
  const metric = (label) => `<a href="#"><strong>1</strong><span>${label}</span><small>Fixture metric</small></a>`;
  return `<div class="page media-desktop-page media-home-page operations-page">
    <section class="cinema-hero"><div class="hero-content"><h2>Fixture title</h2></div></section>
    <form class="media-home-search"><label><svg></svg><span><strong>Search</strong><small>Fixture</small></span><input></label><button type="button">Search</button></form>
    <section class="media-home-metrics">${["Library", "Requests", "Downloads", "Missing", "Subtitles"].map(metric).join("")}</section>
    <section class="media-section"><header class="section-heading"><div><h2>Continue watching</h2><p>Fixture</p></div></header><div class="poster-rail">${cards}</div></section>
    <div class="focus-layout"><section class="pipeline-panel">Activity</section><section class="activity-panel">Attention</section></div>
    <section class="media-section"><header class="section-heading"><div><h2>Recently added</h2></div></header><div class="poster-rail">${cards}</div></section>
  </div>`;
}

function instrumentedShell(root) {
  const cssFiles = ["styles.css", "src/ui/operations.css", "src/ui/control.css", "src/ui/retro.css"];
  const css = cssFiles.map((file) => readFileSync(path.join(root, file), "utf8")).join("\n");
  let html = readFileSync(path.join(root, "index.html"), "utf8");
  html = html
    .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/u, "")
    .replace(/<link\s+rel="stylesheet"[^>]*>/gu, "")
    .replace(/<script\s+type="module"[^>]*><\/script>/gu, "")
    .replace("</head>", `<style>${css}\nhtml, body { overflow-x: visible !important; }</style></head>`)
    .replace('<main class="main-content" id="main-content" tabindex="-1"></main>', `<main class="main-content" id="main-content" tabindex="-1">${homeFixture()}</main>`);
  return html;
}

function near(actual, expected, message, tolerance = 1) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, received ${actual}`);
}

(async () => {
  const root = path.resolve(__dirname, "..");
  const { chromium } = loadPlaywright();
  const executablePath = installedBrowserPath(chromium);
  assert.ok(executablePath, "A preinstalled Chrome, Edge, or Chromium executable is required; this contract never downloads a browser.");
  const browser = await chromium.launch({ headless: true, executablePath });
  const html = instrumentedShell(root);

  try {
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
      { width: 2048, height: 1125 },
      { width: 2560, height: 1406 }
    ]) {
      const page = await browser.newPage({ viewport, colorScheme: "dark", reducedMotion: "reduce" });
      await page.setContent(html, { waitUntil: "load" });
      const geometry = await page.evaluate(() => {
        const rect = (selector) => {
          const value = document.querySelector(selector).getBoundingClientRect();
          return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width };
        };
        const home = document.querySelector(".media-home-page");
        const homeStyle = getComputedStyle(home);
        const blockSelectors = [".cinema-hero", ".media-home-search", ".media-home-metrics", ".media-section", ".focus-layout"];
        const blocks = blockSelectors.flatMap((selector) => [...home.querySelectorAll(`:scope > ${selector}`)].map((element) => {
          const value = element.getBoundingClientRect();
          return { selector, left: value.left, right: value.right };
        }));
        const rail = document.querySelector(".poster-rail");
        return {
          viewport: document.documentElement.clientWidth,
          documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          sidebar: rect(".sidebar"),
          brand: rect(".brand"),
          topbar: rect(".topbar"),
          main: rect(".main-content"),
          home: rect(".media-home-page"),
          paddingLeft: parseFloat(homeStyle.paddingLeft),
          paddingRight: parseFloat(homeStyle.paddingRight),
          brandBorderBottom: parseFloat(getComputedStyle(document.querySelector(".brand")).borderBottomWidth),
          topbarBorderBottom: parseFloat(getComputedStyle(document.querySelector(".topbar")).borderBottomWidth),
          blocks,
          rail: {
            ...rect(".poster-rail"),
            clientWidth: rail.clientWidth,
            scrollWidth: rail.scrollWidth,
            overflowX: getComputedStyle(rail).overflowX
          }
        };
      });

      assert.ok(geometry.documentWidth <= geometry.viewport + 1, `${viewport.width}px shell overflows horizontally by ${geometry.documentWidth - geometry.viewport}px`);
      near(geometry.sidebar.right, geometry.main.left, `${viewport.width}px sidebar/main seam`);
      near(geometry.sidebar.right, geometry.topbar.left, `${viewport.width}px sidebar/topbar seam`);
      near(geometry.brand.bottom, geometry.topbar.bottom, `${viewport.width}px logo divider/header rule baseline`);
      near(geometry.brandBorderBottom, geometry.topbarBorderBottom, `${viewport.width}px logo/header rule thickness`, 0.1);
      assert.ok(geometry.home.left >= geometry.main.left - 1, `${viewport.width}px Home starts outside main`);
      assert.ok(geometry.home.right <= geometry.main.right + 1, `${viewport.width}px Home ends outside main`);

      const expectedLeft = geometry.home.left + geometry.paddingLeft;
      const expectedRight = geometry.home.right - geometry.paddingRight;
      for (const block of geometry.blocks) {
        near(block.left, expectedLeft, `${viewport.width}px ${block.selector} left inset`);
        near(block.right, expectedRight, `${viewport.width}px ${block.selector} right inset`);
      }
      near(geometry.rail.left, expectedLeft, `${viewport.width}px poster rail left containment`);
      near(geometry.rail.right, expectedRight, `${viewport.width}px poster rail right containment`);
      assert.equal(geometry.rail.overflowX, "auto");
      assert.ok(geometry.rail.scrollWidth > geometry.rail.clientWidth, `${viewport.width}px fixture must exercise internal poster scrolling`);
      await page.close();
    }
    console.log("Shell geometry contract passed at compact and wide desktop widths.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
