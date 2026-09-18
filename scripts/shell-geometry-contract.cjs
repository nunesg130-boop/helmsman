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

function homeFixture({ continueWatching = true } = {}) {
  const cards = Array.from({ length: 16 }, (_, index) => `
    <button class="poster-card" type="button">
      <span class="poster-art"></span>
      <span class="poster-copy"><strong>Title ${index + 1}</strong><span>2026 · Available</span></span>
    </button>`).join("");
  const metric = (label) => `<a href="#"><strong>1</strong><span>${label}</span><small>Fixture metric</small></a>`;
  const downloadRows = Array.from({ length: 2 }, (_, index) => `<button class="pipeline-row" type="button">
    <span class="pipeline-art"></span><span class="pipeline-main"><span class="pipeline-title"><strong>Download ${index + 1}</strong><em class="status-pill status-active"><i></i>Downloading</em></span><span class="pipeline-subtitle">Fixture transfer via qBittorrent</span><progress value="${64 + index * 12}" max="100">${64 + index * 12}%</progress></span><span class="pipeline-aside"><strong>42 MB/s</strong><small>12m</small></span><svg></svg>
  </button>`).join("");
  const downloads = `<section class="pipeline-panel media-home-card media-home-card--downloads${continueWatching ? "" : " is-promoted"}" data-home-slot="downloads"${continueWatching ? "" : " data-home-promoted=\"true\""}>
    <header class="panel-heading media-home-card__heading"><div><span class="eyebrow">Activity</span><h2>Downloads and imports</h2><p>Fixture activity summary.</p></div><a class="text-link" href="#/activity">All activity <svg></svg></a></header><div class="pipeline-list">${downloadRows}</div>
  </section>`;
  const continueCard = `<section class="cinema-hero media-home-card media-home-card--continue" data-home-slot="continue-watching">
    <div class="hero-shade"></div><div class="hero-content"><span class="eyebrow"><i></i>Continue watching</span><h2>The Expanse</h2><div class="hero-meta"><span>Series</span><span>2026</span><span>Available</span></div><p>A deliberately long fixture summary verifies that the featured card can wrap without widening its grid track.</p><div class="hero-actions"><button class="primary-button" type="button">View details</button><a class="secondary-button" href="#/library">Browse library</a></div><div class="hero-progress"><progress value="64" max="100" aria-label="The Expanse watched">64%</progress><span>64% watched</span></div></div>
  </section>`;
  const serviceRows = ["Jellyfin", "Sonarr", "Radarr", "Seerr", "Prowlarr", "qBittorrent"].map((name) => `<li><button class="operations-service" type="button" aria-label="Open ${name} connection details"><span class="operations-service__mark">${name.slice(0, 1)}</span><span class="operations-service__copy"><strong>${name}</strong><small>Fixture capability summary</small></span><span class="operations-service__states"><span class="operations-service__health"><small>Connection health</small><span class="operations-service__state"><i class="is-success"></i>Connected</span></span><span class="operations-service__health"><small>Service health</small><span class="operations-service__state"><i class="is-success"></i>Healthy</span></span></span><svg></svg></button></li>`).join("");
  const serviceHealth = `<section class="operations-panel operations-services media-home-card media-home-card--services" data-home-slot="service-health" aria-labelledby="fixture-services-title"><header class="operations-section-heading media-home-card__heading"><div><span class="operations-kicker">Connected stack</span><h2 id="fixture-services-title">Service health</h2><p>Connection and application health remain separate signals.</p></div><a class="operations-text-link" href="#/health">Open health <svg></svg></a></header><ul class="operations-services__list">${serviceRows}</ul></section>`;
  const attention = `<section class="activity-panel media-home-card media-home-card--attention" data-home-slot="requests-and-warnings"><header class="panel-heading media-home-card__heading"><div><span class="eyebrow">Attention</span><h2>Requests and warnings</h2><p>Current service-reported conditions.</p></div><a class="text-link" href="#/requests">All requests <svg></svg></a></header><div class="activity-list"><button class="activity-event" type="button"><i class="event-marker tone-danger"></i><span><strong>Import failed</strong><small>Fixture warning</small></span><time>Current</time></button></div></section>`;
  const pipelineStages = ["Requested", "Monitored", "Downloading", "Imported", "Available"].map((label, index) => `<li class="operations-pipeline__stage is-${index === 2 ? "limited" : "healthy"}"><span class="operations-pipeline__marker"><svg></svg></span><div><span>Fixture</span><strong>${label}</strong><small>Current pipeline evidence</small></div><em aria-label="${index + 1} items">${index + 1}</em></li>`).join("");
  const pipeline = `<section class="operations-panel operations-pipeline media-home-card media-home-card--pipeline" data-home-slot="media-pipeline" aria-labelledby="fixture-pipeline-title"><header class="operations-section-heading media-home-card__heading"><div><span class="operations-kicker">End-to-end signal</span><h2 id="fixture-pipeline-title">Media pipeline</h2><p>Requests moving toward playback.</p></div><a class="operations-text-link" href="#/health">Open pipeline <svg></svg></a></header><ol class="operations-pipeline__list">${pipelineStages}</ol></section>`;
  return `<div class="page media-desktop-page media-home-page operations-page">
    <form class="media-home-search" role="search"><label><svg></svg><span><strong>Search</strong><small>Fixture</small></span><input type="search" aria-label="Search media"></label><button type="button">Search</button></form>
    <section class="media-home-metrics" aria-label="Media workload summary">${["Library", "Requests", "Downloads", "Missing", "Subtitles"].map(metric).join("")}</section>
    <div class="media-home-bento ${continueWatching ? "has-continue-watching" : "has-promoted-downloads"}">
      ${continueWatching ? continueCard : downloads}
      ${serviceHealth}
      ${continueWatching ? downloads : ""}
      ${attention}
      ${pipeline}
    </div>
    <section class="media-section"><header class="section-heading"><div><h2>Recently added</h2></div></header><div class="poster-rail">${cards}</div></section>
  </div>`;
}

function requestFixture() {
  const steps = ["Requested", "Monitored", "Downloading", "Imported", "Available"]
    .map((label, index) => `<span class="journey-step${index < 2 ? " is-done" : index === 2 ? " is-current" : ""}"><i>${index + 1}</i><small>${label}</small></span>`)
    .join("");
  return `<div class="page media-desktop-page">
    <section class="request-list">
      <article class="request-row">
        <button class="request-title" type="button"><span class="request-art"></span><span><strong>Compact request fixture</strong><small>Season 1 · 4K</small></span></button>
        <span class="request-owner"><span>Request state</span><strong>Approved</strong><small>Fixture owner</small></span>
        <span class="request-journey">${steps}</span>
        <span class="request-actions"><span class="status-pill status-partial"><i></i>Awaiting approval</span><button class="icon-button" type="button" aria-label="Open fixture details"><svg></svg></button></span>
      </article>
    </section>
  </div>`;
}

function downloadFixture() {
  return `<div class="page media-desktop-page">
    <section class="download-list">
      <article class="download-row media-filter-item">
        <button class="download-identity" type="button"><span class="download-art"></span><span><strong>Activity download fixture with a deliberately long media title</strong><small>Episode 08 · qBittorrent activity</small></span></button>
        <span class="download-stage"><span class="status-pill status-active"><i></i>Downloading</span><small>qBittorrent</small></span>
        <span class="download-progress"><span><strong>64%</strong><span>Progress</span></span><progress value="64" max="100">64%</progress></span>
        <span class="download-stat"><span>Speed</span><strong>42.3 MB/s</strong></span>
        <span class="download-stat"><span>ETA</span><strong>12 minutes</strong></span>
        <span class="download-actions"><button class="icon-button" type="button" aria-label="Open fixture details"><svg></svg></button></span>
      </article>
    </section>
  </div>`;
}

function instrumentedShell(root, fixture = homeFixture()) {
  const cssFiles = ["styles.css", "src/ui/operations.css", "src/ui/control.css", "src/ui/logging.css", "src/ui/retro.css"];
  const css = cssFiles.map((file) => readFileSync(path.join(root, file), "utf8")).join("\n");
  let html = readFileSync(path.join(root, "index.html"), "utf8");
  html = html
    .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/u, "")
    .replace(/<link\s+rel="stylesheet"[^>]*>/gu, "")
    .replace(/<script\s+type="module"[^>]*><\/script>/gu, "")
    .replace("</head>", `<style>${css}\nhtml, body { overflow-x: visible !important; }</style></head>`)
    .replace('<main class="main-content" id="main-content" tabindex="-1"></main>', `<main class="main-content" id="main-content" tabindex="-1">${fixture}</main>`);
  return html;
}

function near(actual, expected, message, tolerance = 1) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, received ${actual}`);
}

async function readHomeGeometry(page) {
  return page.evaluate(() => {
    const rectFor = (element) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
        width: value.width,
        height: value.height
      };
    };
    const rect = (selector) => rectFor(document.querySelector(selector));
    const home = document.querySelector(".media-home-page");
    const bento = home.querySelector(".media-home-bento");
    const homeStyle = getComputedStyle(home);
    const topLevelBlocks = [...home.querySelectorAll(":scope > .media-home-search, :scope > .media-home-metrics, :scope > .media-home-bento, :scope > .media-section")]
      .map((element) => ({ className: element.className, ...rectFor(element) }));
    const cards = [...bento.querySelectorAll(":scope > .media-home-card")].map((element) => ({
      slot: element.dataset.homeSlot || "",
      promoted: element.dataset.homePromoted === "true",
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      ...rectFor(element)
    }));
    const rail = home.querySelector(".poster-rail");
    const activityLink = home.querySelector('[data-home-slot="downloads"] .text-link');
    const activityHeader = activityLink.closest(".media-home-card__heading");
    const activityLinkStyle = getComputedStyle(activityLink);
    const sidebarToggle = document.querySelector(".sidebar-toggle");
    const toggleRect = sidebarToggle.getBoundingClientRect();
    const mobileNav = document.querySelector(".mobile-nav");
    return {
      viewport: document.documentElement.clientWidth,
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      sidebar: { ...rect(".sidebar"), display: getComputedStyle(document.querySelector(".sidebar")).display },
      brand: rect(".brand"),
      topbar: rect(".topbar"),
      toggle: {
        ...rect(".sidebar-toggle"),
        hit: document.elementFromPoint(toggleRect.left + toggleRect.width / 2, toggleRect.top + toggleRect.height / 2)?.closest(".sidebar-toggle") === sidebarToggle
      },
      main: rect(".main-content"),
      home: rect(".media-home-page"),
      paddingLeft: parseFloat(homeStyle.paddingLeft),
      paddingRight: parseFloat(homeStyle.paddingRight),
      topLevelBlocks,
      bento: {
        ...rectFor(bento),
        className: bento.className,
        gridColumns: getComputedStyle(bento).gridTemplateColumns.trim().split(/\s+/u).filter(Boolean).length,
        sourceSlots: [...bento.children].map((element) => element.dataset.homeSlot || "")
      },
      cards,
      continueCount: bento.querySelectorAll('[data-home-slot="continue-watching"]').length,
      downloadsCount: bento.querySelectorAll('[data-home-slot="downloads"]').length,
      promotedDownloadsCount: bento.querySelectorAll('[data-home-slot="downloads"][data-home-promoted="true"]').length,
      rail: {
        ...rectFor(rail),
        clientWidth: rail.clientWidth,
        scrollWidth: rail.scrollWidth,
        overflowX: getComputedStyle(rail).overflowX,
        posterWidths: [...rail.querySelectorAll(".poster-card")].map((card) => card.getBoundingClientRect().width)
      },
      activityHeader: rectFor(activityHeader),
      activityLink: {
        ...rectFor(activityLink),
        alignItems: activityLinkStyle.alignItems,
        justifyContent: activityLinkStyle.justifyContent,
        paddingLeft: parseFloat(activityLinkStyle.paddingLeft),
        paddingRight: parseFloat(activityLinkStyle.paddingRight),
        whiteSpace: activityLinkStyle.whiteSpace
      },
      mobileNav: { ...rectFor(mobileNav), display: getComputedStyle(mobileNav).display },
      mainTabIndex: document.querySelector("#main-content").getAttribute("tabindex"),
      skipLinkTarget: document.querySelector(".skip-link")?.getAttribute("href") || ""
    };
  });
}

(async () => {
  const root = path.resolve(__dirname, "..");
  const { chromium } = loadPlaywright();
  const executablePath = installedBrowserPath(chromium);
  assert.ok(executablePath, "A preinstalled Chrome, Edge, or Chromium executable is required; this contract never downloads a browser.");
  const browser = await chromium.launch({ headless: true, executablePath });
  const continueHomeHtml = instrumentedShell(root, homeFixture({ continueWatching: true }));
  const promotedDownloadsHtml = instrumentedShell(root, homeFixture({ continueWatching: false }));
  const html = continueHomeHtml;
  const requestHtml = instrumentedShell(root, requestFixture());
  const downloadHtml = instrumentedShell(root, downloadFixture());

  try {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
      { width: 2048, height: 1125 },
      { width: 2560, height: 1406 }
    ]) {
      const variants = [
        { label: "continue watching", html: continueHomeHtml, continueWatching: true },
        { label: "promoted downloads", html: promotedDownloadsHtml, continueWatching: false }
      ];
      const variantGeometries = new Map();

      for (const variant of variants) {
        const page = await browser.newPage({ viewport, colorScheme: "dark", reducedMotion: "reduce" });
        await page.setContent(variant.html, { waitUntil: "load" });
        const geometry = await readHomeGeometry(page);
        variantGeometries.set(variant.label, geometry);

        assert.ok(geometry.documentWidth <= geometry.viewport + 1, `${viewport.width}px ${variant.label} shell overflows horizontally by ${geometry.documentWidth - geometry.viewport}px`);
        assert.equal(geometry.mainTabIndex, "-1", `${viewport.width}px ${variant.label} main content must remain programmatically focusable`);
        assert.equal(geometry.skipLinkTarget, "#main-content", `${viewport.width}px ${variant.label} skip link must retain its main-content target`);
        assert.ok(geometry.home.left >= geometry.main.left - 1, `${viewport.width}px ${variant.label} Home starts outside main`);
        assert.ok(geometry.home.right <= geometry.main.right + 1, `${viewport.width}px ${variant.label} Home ends outside main`);

        const expectedLeft = geometry.home.left + geometry.paddingLeft;
        const expectedRight = geometry.home.right - geometry.paddingRight;
        for (const block of geometry.topLevelBlocks) {
          near(block.left, expectedLeft, `${viewport.width}px ${variant.label} ${block.className} left inset`);
          near(block.right, expectedRight, `${viewport.width}px ${variant.label} ${block.className} right inset`);
        }
        for (const card of geometry.cards) {
          assert.ok(card.left >= geometry.bento.left - 1 && card.right <= geometry.bento.right + 1, `${viewport.width}px ${variant.label} ${card.slot} card must stay inside the bento grid`);
          assert.ok(card.scrollWidth <= card.clientWidth + 1, `${viewport.width}px ${variant.label} ${card.slot} card must not clip horizontal content`);
        }

        assert.equal(geometry.downloadsCount, 1, `${viewport.width}px ${variant.label} must render exactly one Downloads & Imports card`);
        assert.equal(geometry.bento.sourceSlots[0], variant.continueWatching ? "continue-watching" : "downloads", `${viewport.width}px ${variant.label} primary card must be first in reading and tab order`);
        if (variant.continueWatching) {
          assert.equal(geometry.continueCount, 1, `${viewport.width}px Continue Watching must render when data exists`);
          assert.equal(geometry.promotedDownloadsCount, 0, `${viewport.width}px ordinary Downloads must not claim the promoted slot`);
          assert.match(geometry.bento.className, /\bhas-continue-watching\b/u);
        } else {
          assert.equal(geometry.continueCount, 0, `${viewport.width}px empty Continue Watching must be omitted rather than hidden`);
          assert.equal(geometry.promotedDownloadsCount, 1, `${viewport.width}px Downloads must be marked as promoted when Continue Watching is empty`);
          assert.match(geometry.bento.className, /\bhas-promoted-downloads\b/u);
        }

        if (viewport.width <= 760) {
          assert.equal(geometry.bento.gridColumns, 1, `${viewport.width}px ${variant.label} bento must collapse to one mobile column`);
          geometry.cards.slice(1).forEach((card, index) => {
            assert.ok(card.top >= geometry.cards[index].bottom - 1, `${viewport.width}px ${variant.label} cards must follow one vertical mobile reading order`);
          });
        } else if (viewport.width <= 1320) {
          assert.equal(geometry.bento.gridColumns, 2, `${viewport.width}px ${variant.label} bento must use the two-column tablet layout`);
          assert.ok(geometry.cards[1].top >= geometry.cards[0].bottom - 1, `${viewport.width}px ${variant.label} primary card must occupy the full first tablet row`);
          near(geometry.cards[1].top, geometry.cards[2].top, `${viewport.width}px ${variant.label} second-row card pair must align on tablet`, 2);
          if (variant.continueWatching) {
            near(geometry.cards[3].top, geometry.cards[4].top, `${viewport.width}px Continue Watching attention and pipeline cards must align on the third tablet row`, 2);
          } else {
            assert.ok(geometry.cards[3].top >= Math.max(geometry.cards[1].bottom, geometry.cards[2].bottom) - 1, `${viewport.width}px promoted Downloads pipeline must occupy the final full tablet row`);
          }
        } else {
          assert.equal(geometry.bento.gridColumns, 12, `${viewport.width}px ${variant.label} bento must retain its 12-track desktop grid`);
          near(geometry.cards[0].top, geometry.cards[1].top, `${viewport.width}px ${variant.label} primary and service-health cards must align on the first desktop row`, 2);
          if (variant.continueWatching) {
            near(geometry.cards[2].top, geometry.cards[3].top, `${viewport.width}px Continue Watching Downloads and attention cards must align on the second desktop row`, 2);
            near(geometry.cards[3].top, geometry.cards[4].top, `${viewport.width}px Continue Watching attention and pipeline cards must align on the second desktop row`, 2);
          } else {
            near(geometry.cards[2].top, geometry.cards[3].top, `${viewport.width}px promoted Downloads attention and pipeline cards must align on the second desktop row`, 2);
          }
        }

        near(geometry.rail.left, expectedLeft, `${viewport.width}px ${variant.label} poster rail left containment`);
        near(geometry.rail.right, expectedRight, `${viewport.width}px ${variant.label} poster rail right containment`);
        assert.equal(geometry.rail.overflowX, "auto");
        assert.ok(geometry.rail.scrollWidth > geometry.rail.clientWidth, `${viewport.width}px ${variant.label} fixture must exercise internal poster scrolling`);
        const expectedPosterWidth = viewport.width <= 760
          ? 132
          : viewport.width >= 1500 ? 176 : Math.min(176, Math.max(140, viewport.width * 0.11));
        assert.ok(geometry.rail.posterWidths.length > 1, `${viewport.width}px ${variant.label} fixture must render multiple poster cards`);
        near(geometry.rail.posterWidths[0], expectedPosterWidth, `${viewport.width}px ${variant.label} standardized poster width`);
        assert.ok(geometry.rail.posterWidths.every((width) => Math.abs(width - geometry.rail.posterWidths[0]) <= 0.5), `${viewport.width}px ${variant.label} poster cards must use one consistent rail width`);
        assert.ok(geometry.rail.posterWidths.every((width) => width <= 176.5), `${viewport.width}px ${variant.label} poster cards must not grow into oversized fluid columns`);

        assert.ok(geometry.activityLink.left >= geometry.activityHeader.left - 1 && geometry.activityLink.right <= geometry.activityHeader.right + 1, `${viewport.width}px ${variant.label} All activity link must stay inside its card heading`);
        assert.ok(geometry.activityLink.paddingLeft >= 13.5 && geometry.activityLink.paddingRight >= 13.5, `${viewport.width}px ${variant.label} All activity text must have balanced horizontal inset`);
        assert.equal(geometry.activityLink.alignItems, "center", `${viewport.width}px ${variant.label} All activity content must be vertically centered`);
        assert.equal(geometry.activityLink.justifyContent, "center", `${viewport.width}px ${variant.label} All activity content must be horizontally centered`);
        assert.equal(geometry.activityLink.whiteSpace, "nowrap", `${viewport.width}px ${variant.label} All activity label must remain on one line`);

        await page.locator('.media-home-bento :is(a, button)').first().focus();
        const focusedControl = await page.evaluate(() => {
          const element = document.activeElement;
          const style = getComputedStyle(element);
          const value = element.getBoundingClientRect();
          return { tagName: element.tagName, outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), width: value.width, height: value.height };
        });
        assert.match(focusedControl.tagName, /^(?:A|BUTTON)$/u, `${viewport.width}px ${variant.label} first bento action must use native interactive semantics`);
        assert.notEqual(focusedControl.outlineStyle, "none", `${viewport.width}px ${variant.label} focused bento action must retain a visible outline`);
        assert.ok(focusedControl.outlineWidth >= 2, `${viewport.width}px ${variant.label} focus outline must remain at least 2px`);
        assert.ok(focusedControl.height >= 44, `${viewport.width}px ${variant.label} first bento action must retain a 44px target`);

        if (viewport.width <= 760) {
          assert.equal(geometry.sidebar.display, "none", `${viewport.width}px ${variant.label} desktop sidebar must be hidden on mobile`);
          assert.notEqual(geometry.mobileNav.display, "none", `${viewport.width}px ${variant.label} mobile navigation must remain available`);
          assert.ok(geometry.topbar.left >= 0 && geometry.topbar.right <= geometry.viewport + 1, `${viewport.width}px ${variant.label} mobile topbar must stay inside the viewport`);
        } else {
          near(geometry.sidebar.right + geometry.sidebar.left, geometry.main.left, `${viewport.width}px ${variant.label} sidebar/main gutter`);
          assert.ok(geometry.topbar.left >= geometry.main.left, `${viewport.width}px ${variant.label} topbar must stay inside the main grid column`);
          assert.ok(geometry.topbar.right <= geometry.viewport + 1, `${viewport.width}px ${variant.label} topbar must stay inside the viewport`);
          assert.ok(geometry.brand.left >= geometry.sidebar.left && geometry.brand.right <= geometry.sidebar.right, `${viewport.width}px ${variant.label} brand must stay inside the sidebar`);
          near(geometry.toggle.left, geometry.sidebar.right, `${viewport.width}px ${variant.label} sidebar toggle edge placement`, 3);
          near(geometry.toggle.top, geometry.topbar.bottom + 16, `${viewport.width}px ${variant.label} sidebar toggle vertical placement`, 2);
          near(geometry.toggle.width, 44, `${viewport.width}px ${variant.label} sidebar toggle width`);
          near(geometry.toggle.height, 44, `${viewport.width}px ${variant.label} sidebar toggle height`);
          assert.equal(geometry.toggle.hit, true, `${viewport.width}px ${variant.label} sidebar toggle must remain clickable outside the sidebar`);
          assert.ok(geometry.toggle.right <= geometry.topLevelBlocks[0].left || geometry.toggle.bottom <= geometry.topLevelBlocks[0].top || geometry.toggle.top >= geometry.topLevelBlocks[0].bottom, `${viewport.width}px ${variant.label} sidebar toggle must not overlap the first content panel`);

          await page.evaluate(() => document.querySelector("#app").classList.add("is-sidebar-collapsed"));
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const collapsed = await readHomeGeometry(page);
          assert.ok(collapsed.documentWidth <= collapsed.viewport + 1, `${viewport.width}px ${variant.label} collapsed shell must not overflow horizontally`);
          near(collapsed.main.left, 102, `${viewport.width}px ${variant.label} collapsed main-column offset`);
          near(collapsed.sidebar.width, 102, `${viewport.width}px ${variant.label} collapsed sidebar width`);
          near(collapsed.sidebar.right + collapsed.sidebar.left, collapsed.main.left, `${viewport.width}px ${variant.label} collapsed sidebar/main gutter`);
          assert.ok(collapsed.topbar.left >= collapsed.main.left, `${viewport.width}px ${variant.label} collapsed topbar must stay inside the main grid column`);
          assert.ok(collapsed.brand.width <= collapsed.sidebar.width, `${viewport.width}px ${variant.label} collapsed brand must stay inside the sidebar`);
          near(collapsed.toggle.left, collapsed.sidebar.right, `${viewport.width}px ${variant.label} collapsed sidebar toggle edge placement`, 3);
          near(collapsed.toggle.top, collapsed.topbar.bottom + 16, `${viewport.width}px ${variant.label} collapsed sidebar toggle vertical placement`, 2);
          assert.equal(collapsed.toggle.hit, true, `${viewport.width}px ${variant.label} collapsed sidebar toggle must remain clickable`);
          assert.ok(collapsed.toggle.right <= collapsed.topLevelBlocks[0].left || collapsed.toggle.bottom <= collapsed.topLevelBlocks[0].top || collapsed.toggle.top >= collapsed.topLevelBlocks[0].bottom, `${viewport.width}px ${variant.label} collapsed toggle must not overlap the first content panel`);
          const collapsedLabels = await page.evaluate(() => ({
            navigation: getComputedStyle(document.querySelector(".nav-item > span")).display,
            workspace: getComputedStyle(document.querySelector(".world-option__label")).display
          }));
          assert.equal(collapsedLabels.navigation, "none", `${viewport.width}px ${variant.label} collapsed navigation labels must be hidden`);
          assert.equal(collapsedLabels.workspace, "none", `${viewport.width}px ${variant.label} collapsed workspace labels must be hidden`);
        }
        await page.close();
      }

      const continued = variantGeometries.get("continue watching");
      const promoted = variantGeometries.get("promoted downloads");
      near(promoted.cards[0].left, continued.cards[0].left, `${viewport.width}px promoted Downloads must inherit the Continue Watching left edge`, 2);
      near(promoted.cards[0].top, continued.cards[0].top, `${viewport.width}px promoted Downloads must inherit the Continue Watching top edge`, 2);
      near(promoted.cards[0].width, continued.cards[0].width, `${viewport.width}px promoted Downloads must inherit the Continue Watching grid width`, 2);
    }

    for (const viewport of [
      { width: 861, height: 800 },
      { width: 1240, height: 800 },
      { width: 1241, height: 800 },
      { width: 1320, height: 800 },
      { width: 1321, height: 800 }
    ]) {
      const page = await browser.newPage({ viewport, colorScheme: "dark", reducedMotion: "reduce" });
      await page.setContent(downloadHtml, { waitUntil: "load" });

      for (const collapsed of [false, true]) {
        await page.evaluate((value) => {
          document.querySelector("#app").classList.toggle("is-sidebar-collapsed", value);
        }, collapsed);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = await page.evaluate(() => {
          const rect = (selector) => {
            const value = document.querySelector(selector).getBoundingClientRect();
            return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width };
          };
          const list = document.querySelector(".download-list");
          const row = document.querySelector(".download-row");
          return {
            viewport: document.documentElement.clientWidth,
            documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            list: { ...rect(".download-list"), clientWidth: list.clientWidth, scrollWidth: list.scrollWidth },
            row: { ...rect(".download-row"), clientWidth: row.clientWidth, scrollWidth: row.scrollWidth },
            identity: rect(".download-identity"),
            progress: rect(".download-progress"),
            actions: rect(".download-actions"),
            gridTrackCount: getComputedStyle(row).gridTemplateColumns.trim().split(/\s+/u).length,
            stageDisplay: getComputedStyle(document.querySelector(".download-stage")).display,
            statDisplays: [...document.querySelectorAll(".download-stat")].map((stat) => getComputedStyle(stat).display)
          };
        });
        const state = collapsed ? "collapsed" : "expanded";

        assert.ok(geometry.documentWidth <= geometry.viewport + 1, `${viewport.width}px ${state} download shell must not overflow horizontally`);
        assert.ok(geometry.list.scrollWidth <= geometry.list.clientWidth + 1, `${viewport.width}px ${state} download list contents must not be clipped`);
        assert.ok(geometry.row.left >= geometry.list.left - 1 && geometry.row.right <= geometry.list.right + 1, `${viewport.width}px ${state} download row must stay inside its list`);
        assert.ok(geometry.row.scrollWidth <= geometry.row.clientWidth + 1, `${viewport.width}px ${state} download row contents must not be clipped`);
        assert.ok(geometry.identity.left >= geometry.row.left - 1 && geometry.identity.right <= geometry.row.right + 1, `${viewport.width}px ${state} download identity must stay inside its row`);
        assert.ok(geometry.progress.left >= geometry.row.left - 1 && geometry.progress.right <= geometry.row.right + 1, `${viewport.width}px ${state} download progress must stay inside its row`);
        assert.ok(geometry.actions.left >= geometry.row.left - 1 && geometry.actions.right <= geometry.row.right + 1, `${viewport.width}px ${state} download actions must stay inside their row`);

        if (viewport.width <= 1320) {
          assert.equal(geometry.gridTrackCount, 2, `${viewport.width}px ${state} download row must use two grid columns`);
          assert.equal(geometry.stageDisplay, "none", `${viewport.width}px ${state} compact download stage must be hidden`);
          assert.ok(geometry.statDisplays.every((display) => display === "none"), `${viewport.width}px ${state} compact download stats must be hidden`);
          assert.ok(geometry.progress.top >= Math.max(geometry.identity.bottom, geometry.actions.bottom) - 1, `${viewport.width}px ${state} download progress must occupy the second row`);
        } else {
          assert.equal(geometry.gridTrackCount, 6, `${viewport.width}px ${state} download row must return to six columns`);
          assert.notEqual(geometry.stageDisplay, "none", `${viewport.width}px ${state} download stage must return in the wide layout`);
          assert.ok(geometry.statDisplays.every((display) => display !== "none"), `${viewport.width}px ${state} download stats must return in the wide layout`);
        }
      }
      await page.close();
    }

    for (const viewport of [
      { width: 761, height: 800 },
      { width: 940, height: 800 },
      { width: 941, height: 800 },
      { width: 1240, height: 800 },
      { width: 1241, height: 800 },
      { width: 1440, height: 900 },
      { width: 1441, height: 900 }
    ]) {
      const page = await browser.newPage({ viewport, colorScheme: "dark", reducedMotion: "reduce" });
      await page.setContent(requestHtml, { waitUntil: "load" });

      for (const collapsed of [false, true]) {
        await page.evaluate((value) => {
          document.querySelector("#app").classList.toggle("is-sidebar-collapsed", value);
        }, collapsed);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = await page.evaluate(() => {
          const rect = (selector) => {
            const value = document.querySelector(selector).getBoundingClientRect();
            return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width };
          };
          const row = document.querySelector(".request-row");
          const sidebar = document.querySelector(".sidebar");
          const sidebarToggle = document.querySelector(".sidebar-toggle");
          const toggleRect = sidebarToggle.getBoundingClientRect();
          return {
            viewport: document.documentElement.clientWidth,
            documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            list: rect(".request-list"),
            row: { ...rect(".request-row"), clientWidth: row.clientWidth, scrollWidth: row.scrollWidth },
            title: rect(".request-title"),
            journey: rect(".request-journey"),
            actions: rect(".request-actions"),
            sidebar: rect(".sidebar"),
            toggle: { ...rect(".sidebar-toggle"), hit: document.elementFromPoint(toggleRect.left + toggleRect.width / 2, toggleRect.top + toggleRect.height / 2)?.closest(".sidebar-toggle") === sidebarToggle },
            gridTrackCount: getComputedStyle(row).gridTemplateColumns.trim().split(/\s+/u).length,
            ownerDisplay: getComputedStyle(document.querySelector(".request-owner")).display
          };
        });
        const state = collapsed ? "collapsed" : "expanded";

        assert.ok(geometry.documentWidth <= geometry.viewport + 1, `${viewport.width}px ${state} compact request shell must not overflow horizontally`);
        near(geometry.toggle.left, geometry.sidebar.right, `${viewport.width}px ${state} compact sidebar toggle edge`, 3);
        assert.equal(geometry.toggle.hit, true, `${viewport.width}px ${state} compact sidebar toggle must be clickable`);
        assert.ok(
          geometry.toggle.right <= geometry.list.left
            || geometry.toggle.bottom <= geometry.list.top
            || geometry.toggle.top >= geometry.list.bottom,
          `${viewport.width}px ${state} compact sidebar toggle must not overlap the first content panel`
        );
        if (viewport.width <= 1440) {
          assert.equal(geometry.gridTrackCount, 2, `${viewport.width}px ${state} request row must use two grid columns`);
          assert.equal(geometry.ownerDisplay, "none", `${viewport.width}px ${state} compact request owner must be hidden`);
        } else {
          assert.equal(geometry.gridTrackCount, 4, `${viewport.width}px ${state} request row must return to four columns`);
          assert.notEqual(geometry.ownerDisplay, "none", `${viewport.width}px ${state} request owner must return in the wide layout`);
        }
        assert.ok(geometry.row.left >= geometry.list.left - 1 && geometry.row.right <= geometry.list.right + 1, `${viewport.width}px ${state} request row must stay inside its list`);
        assert.ok(geometry.row.scrollWidth <= geometry.row.clientWidth + 1, `${viewport.width}px ${state} request row contents must not be clipped`);
        assert.ok(geometry.title.left >= geometry.row.left - 1, `${viewport.width}px ${state} request title must stay inside its row`);
        assert.ok(geometry.actions.right <= geometry.row.right + 1, `${viewport.width}px ${state} request actions must stay inside their row`);
        assert.ok(geometry.journey.left >= geometry.row.left - 1 && geometry.journey.right <= geometry.row.right + 1, `${viewport.width}px ${state} request journey must stay inside its row`);
        if (viewport.width <= 1440) {
          assert.ok(geometry.journey.top >= Math.max(geometry.title.bottom, geometry.actions.bottom) - 1, `${viewport.width}px ${state} request journey must occupy the second row`);
        }
      }
      await page.close();
    }

    for (const viewport of [
      { width: 800, height: 420 },
      { width: 1024, height: 480 },
      { width: 1440, height: 540 }
    ]) {
      const page = await browser.newPage({ viewport, colorScheme: "dark", reducedMotion: "reduce" });
      await page.setContent(html, { waitUntil: "load" });
      const sidebarOverflow = await page.evaluate(() => {
        const sidebar = document.querySelector(".sidebar");
        const scrollRegion = document.querySelector(".sidebar-scroll-region");
        const footer = document.querySelector(".sidebar-footer");
        const privacyCard = document.querySelector(".privacy-card");
        const sidebarToggle = document.querySelector(".sidebar-toggle");

        scrollRegion.scrollTop = scrollRegion.scrollHeight;

        const sidebarRect = sidebar.getBoundingClientRect();
        const scrollRect = scrollRegion.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        const privacyRect = privacyCard.getBoundingClientRect();
        const toggleRect = sidebarToggle.getBoundingClientRect();
        return {
          viewport: document.documentElement.clientWidth,
          documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          sidebar: { top: sidebarRect.top, right: sidebarRect.right, bottom: sidebarRect.bottom },
          scrollRegion: {
            top: scrollRect.top,
            bottom: scrollRect.bottom,
            clientHeight: scrollRegion.clientHeight,
            scrollHeight: scrollRegion.scrollHeight,
            scrollTop: scrollRegion.scrollTop,
            overflowY: getComputedStyle(scrollRegion).overflowY
          },
          footer: { top: footerRect.top, bottom: footerRect.bottom, height: footerRect.height },
          privacyCard: { top: privacyRect.top, bottom: privacyRect.bottom },
          toggle: { top: toggleRect.top, right: toggleRect.right, bottom: toggleRect.bottom, left: toggleRect.left }
        };
      });

      assert.ok(sidebarOverflow.documentWidth <= sidebarOverflow.viewport + 1, `${viewport.width}x${viewport.height} short shell must not overflow horizontally`);
      near(sidebarOverflow.sidebar.top, 0, `${viewport.width}x${viewport.height} sidebar top`);
      near(sidebarOverflow.sidebar.bottom, viewport.height, `${viewport.width}x${viewport.height} sidebar bottom`);
      assert.equal(sidebarOverflow.scrollRegion.overflowY, "auto", `${viewport.width}x${viewport.height} sidebar content must scroll vertically`);
      assert.ok(
        sidebarOverflow.scrollRegion.scrollHeight > sidebarOverflow.scrollRegion.clientHeight,
        `${viewport.width}x${viewport.height} fixture must exercise sidebar overflow`
      );
      near(
        sidebarOverflow.scrollRegion.scrollTop,
        sidebarOverflow.scrollRegion.scrollHeight - sidebarOverflow.scrollRegion.clientHeight,
        `${viewport.width}x${viewport.height} sidebar must reach its final content`,
        1.5
      );
      assert.ok(
        sidebarOverflow.privacyCard.top >= sidebarOverflow.scrollRegion.top - 1
          && sidebarOverflow.privacyCard.bottom <= sidebarOverflow.scrollRegion.bottom + 1,
        `${viewport.width}x${viewport.height} final scrollable sidebar card must be reachable`
      );
      assert.ok(sidebarOverflow.footer.height > 0, `${viewport.width}x${viewport.height} fixed sidebar footer must remain rendered`);
      assert.ok(
        sidebarOverflow.footer.top >= sidebarOverflow.scrollRegion.bottom - 1
          && sidebarOverflow.footer.bottom <= sidebarOverflow.sidebar.bottom + 1,
        `${viewport.width}x${viewport.height} settings footer must remain inside the sidebar below the scroll region`
      );
      assert.ok(
        sidebarOverflow.toggle.top >= sidebarOverflow.sidebar.top
          && sidebarOverflow.toggle.bottom <= sidebarOverflow.sidebar.bottom,
        `${viewport.width}x${viewport.height} sidebar toggle must remain reachable`
      );
      near(sidebarOverflow.toggle.left, sidebarOverflow.sidebar.right, `${viewport.width}x${viewport.height} sidebar toggle edge placement`, 3);
      await page.close();
    }
    console.log("Shell geometry contract passed for both Home bento states, responsive containment, fixed poster rails, compact requests and downloads, collapsed navigation, and short-height sidebar scrolling.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
