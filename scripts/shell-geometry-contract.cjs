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
    <div class="focus-layout"><section class="pipeline-panel"><header class="panel-heading"><div><span class="eyebrow">Activity</span><h2>Downloads and imports</h2><p>Fixture activity summary.</p></div><a class="text-link" href="#/activity">All activity <svg></svg></a></header></section><section class="activity-panel">Attention</section></div>
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

(async () => {
  const root = path.resolve(__dirname, "..");
  const { chromium } = loadPlaywright();
  const executablePath = installedBrowserPath(chromium);
  assert.ok(executablePath, "A preinstalled Chrome, Edge, or Chromium executable is required; this contract never downloads a browser.");
  const browser = await chromium.launch({ headless: true, executablePath });
  const html = instrumentedShell(root);
  const requestHtml = instrumentedShell(root, requestFixture());
  const downloadHtml = instrumentedShell(root, downloadFixture());

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
          return {
            left: value.left,
            right: value.right,
            top: value.top,
            bottom: value.bottom,
            width: value.width,
            height: value.height
          };
        };
        const home = document.querySelector(".media-home-page");
        const homeStyle = getComputedStyle(home);
        const blockSelectors = [".cinema-hero", ".media-home-search", ".media-home-metrics", ".media-section", ".focus-layout"];
        const blocks = blockSelectors.flatMap((selector) => [...home.querySelectorAll(`:scope > ${selector}`)].map((element) => {
          const value = element.getBoundingClientRect();
          return { selector, left: value.left, right: value.right, top: value.top, bottom: value.bottom };
        }));
        const rail = document.querySelector(".poster-rail");
        const sidebarToggle = document.querySelector(".sidebar-toggle");
        const toggleRect = sidebarToggle.getBoundingClientRect();
        const activityLink = document.querySelector(".pipeline-panel .text-link");
        const activityLinkStyle = getComputedStyle(activityLink);
        const posterWidths = [...rail.querySelectorAll(".poster-card")]
          .map((card) => card.getBoundingClientRect().width);
        return {
          viewport: document.documentElement.clientWidth,
          documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          sidebar: rect(".sidebar"),
          brand: rect(".brand"),
          topbar: rect(".topbar"),
          toggle: { ...rect(".sidebar-toggle"), hit: document.elementFromPoint(toggleRect.left + toggleRect.width / 2, toggleRect.top + toggleRect.height / 2)?.closest(".sidebar-toggle") === sidebarToggle },
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
            overflowX: getComputedStyle(rail).overflowX,
            posterWidths
          },
          activityHeader: rect(".pipeline-panel .panel-heading"),
          activityLink: {
            ...rect(".pipeline-panel .text-link"),
            alignItems: activityLinkStyle.alignItems,
            justifyContent: activityLinkStyle.justifyContent,
            paddingLeft: parseFloat(activityLinkStyle.paddingLeft),
            paddingRight: parseFloat(activityLinkStyle.paddingRight),
            whiteSpace: activityLinkStyle.whiteSpace
          }
        };
      });

      assert.ok(geometry.documentWidth <= geometry.viewport + 1, `${viewport.width}px shell overflows horizontally by ${geometry.documentWidth - geometry.viewport}px`);
      near(geometry.sidebar.right + geometry.sidebar.left, geometry.main.left, `${viewport.width}px sidebar/main gutter`);
      assert.ok(geometry.topbar.left >= geometry.main.left, `${viewport.width}px topbar must stay inside the main grid column`);
      assert.ok(geometry.topbar.right <= geometry.viewport + 1, `${viewport.width}px topbar must stay inside the viewport`);
      assert.ok(geometry.brand.left >= geometry.sidebar.left && geometry.brand.right <= geometry.sidebar.right, `${viewport.width}px brand must stay inside the sidebar`);
      near(geometry.toggle.left, geometry.sidebar.right, `${viewport.width}px sidebar toggle edge placement`, 3);
      near(geometry.toggle.top, geometry.topbar.bottom + 16, `${viewport.width}px sidebar toggle vertical placement`, 2);
      near(geometry.toggle.width, 44, `${viewport.width}px sidebar toggle width`);
      near(geometry.toggle.height, 44, `${viewport.width}px sidebar toggle height`);
      assert.equal(geometry.toggle.hit, true, `${viewport.width}px sidebar toggle must remain clickable outside the sidebar`);
      assert.ok(
        geometry.toggle.right <= geometry.blocks[0].left
          || geometry.toggle.bottom <= geometry.blocks[0].top
          || geometry.toggle.top >= geometry.blocks[0].bottom,
        `${viewport.width}px sidebar toggle must not overlap the first content panel`
      );
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

      const expectedPosterWidth = viewport.width >= 1500
        ? 176
        : Math.min(176, Math.max(140, viewport.width * 0.11));
      assert.ok(geometry.rail.posterWidths.length > 1, `${viewport.width}px fixture must render multiple poster cards`);
      near(geometry.rail.posterWidths[0], expectedPosterWidth, `${viewport.width}px standardized poster width`);
      assert.ok(
        geometry.rail.posterWidths.every((width) => Math.abs(width - geometry.rail.posterWidths[0]) <= 0.5),
        `${viewport.width}px poster cards must use one consistent rail width`
      );
      assert.ok(
        geometry.rail.posterWidths.every((width) => width <= 176.5),
        `${viewport.width}px poster cards must not grow into oversized fluid columns`
      );
      assert.ok(
        geometry.activityLink.left >= geometry.activityHeader.left - 1
          && geometry.activityLink.right <= geometry.activityHeader.right + 1,
        `${viewport.width}px All activity link must stay inside its panel heading`
      );
      assert.ok(
        geometry.activityLink.paddingLeft >= 13.5 && geometry.activityLink.paddingRight >= 13.5,
        `${viewport.width}px All activity text must have balanced horizontal inset`
      );
      assert.equal(geometry.activityLink.alignItems, "center", `${viewport.width}px All activity content must be vertically centered`);
      assert.equal(geometry.activityLink.justifyContent, "center", `${viewport.width}px All activity content must be horizontally centered`);
      assert.equal(geometry.activityLink.whiteSpace, "nowrap", `${viewport.width}px All activity label must remain on one line`);

      await page.evaluate(() => {
        document.querySelector("#app").classList.add("is-sidebar-collapsed");
      });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const collapsed = await page.evaluate(() => {
        const rect = (selector) => {
          const value = document.querySelector(selector).getBoundingClientRect();
          return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
        };
        const sidebarToggle = document.querySelector(".sidebar-toggle");
        const toggleRect = sidebarToggle.getBoundingClientRect();
        return {
          viewport: document.documentElement.clientWidth,
          documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          sidebar: rect(".sidebar"),
          brand: rect(".brand"),
          topbar: rect(".topbar"),
          main: rect(".main-content"),
          home: rect(".media-home-page"),
          firstBlock: rect(".cinema-hero"),
          toggle: { ...rect(".sidebar-toggle"), hit: document.elementFromPoint(toggleRect.left + toggleRect.width / 2, toggleRect.top + toggleRect.height / 2)?.closest(".sidebar-toggle") === sidebarToggle },
          navigationLabelDisplay: getComputedStyle(document.querySelector(".nav-item > span")).display,
          workspaceLabelDisplay: getComputedStyle(document.querySelector(".world-option__label")).display
        };
      });

      assert.ok(collapsed.documentWidth <= collapsed.viewport + 1, `${viewport.width}px collapsed shell must not overflow horizontally`);
      near(collapsed.main.left, 102, `${viewport.width}px collapsed main-column offset`);
      near(collapsed.sidebar.width, 102, `${viewport.width}px collapsed sidebar width`);
      near(collapsed.sidebar.right + collapsed.sidebar.left, collapsed.main.left, `${viewport.width}px collapsed sidebar/main gutter`);
      assert.ok(collapsed.topbar.left >= collapsed.main.left, `${viewport.width}px collapsed topbar must stay inside the main grid column`);
      assert.ok(collapsed.brand.width <= collapsed.sidebar.width, `${viewport.width}px collapsed brand must stay inside the sidebar`);
      near(collapsed.toggle.left, collapsed.sidebar.right, `${viewport.width}px collapsed sidebar toggle edge placement`, 3);
      near(collapsed.toggle.top, collapsed.topbar.bottom + 16, `${viewport.width}px collapsed sidebar toggle vertical placement`, 2);
      near(collapsed.toggle.width, 44, `${viewport.width}px collapsed sidebar toggle width`);
      near(collapsed.toggle.height, 44, `${viewport.width}px collapsed sidebar toggle height`);
      assert.equal(collapsed.toggle.hit, true, `${viewport.width}px collapsed sidebar toggle must remain clickable`);
      assert.ok(
        collapsed.toggle.right <= collapsed.firstBlock.left
          || collapsed.toggle.bottom <= collapsed.firstBlock.top
          || collapsed.toggle.top >= collapsed.firstBlock.bottom,
        `${viewport.width}px collapsed sidebar toggle must not overlap the first content panel`
      );
      assert.equal(collapsed.navigationLabelDisplay, "none", `${viewport.width}px collapsed navigation labels must be hidden`);
      assert.equal(collapsed.workspaceLabelDisplay, "none", `${viewport.width}px collapsed workspace labels must be hidden`);
      await page.close();
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
    console.log("Shell geometry contract passed for fixed poster rails, compact requests and downloads, collapsed navigation, and short-height sidebar scrolling.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
