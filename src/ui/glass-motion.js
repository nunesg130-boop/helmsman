// Motion for the glass themes: light that follows the pointer across a
// pane, a scene that drifts as the page scrolls, views that materialize,
// and (in Chromium) glass that bends what is behind it.
//
// Nothing here runs in the Default theme, under "reduce motion", or with
// reduced transparency. It only draws: it never handles a click, changes
// a route or touches application state.

const PANES = [
  ".media-home-card", ".operations-overall", ".operations-panel", ".infrastructure-overview-card",
  ".infrastructure-assessment-card", ".glass-panel", ".settings-card-v5", ".connection-category",
  ".pipeline-panel", ".activity-panel", ".calendar-upcoming", ".request-list", ".download-list",
  ".service-table", ".logging-source-card", ".logging-results", ".portainer-panel", ".proxmox-section",
  ".infrastructure-workload-panel", ".service-card-v5", ".environment-card", ".infrastructure-node-card",
  ".infrastructure-target", ".portainer-environment-card", ".portainer-stack-card", ".system-overview-hero",
  ".system-overview-card", ".lp-tile__surface", ".sidebar", ".topbar", ".modal-card", ".standard-modal",
  ".drawer-body", ".agent-helper__panel", ".theme-option"
].join(",");
const SVG_NS = "http://www.w3.org/2000/svg";
const root = document.documentElement;
const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
const reducedTransparency = globalThis.matchMedia?.("(prefers-reduced-transparency: reduce)");

let sheen = null;
let pane = null;
let pointer = null;
let frame = 0;
let scrollFrame = 0;
let entryTimer = 0;

function active() {
  return (root.dataset.theme || "").startsWith("glass-")
    && !reducedMotion?.matches
    && !reducedTransparency?.matches
    && root.dataset.transparency !== "reduced";
}

// The displacement map for the lens: red bends left and right, green bends
// up and down, strongest at the rim and flat (mid-grey) across the middle.
function lensMap() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 100 100" preserveAspectRatio="none">`
    + `<defs><linearGradient id="x" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset=".1" stop-color="#800000"/><stop offset=".9" stop-color="#800000"/><stop offset="1" stop-color="#000000"/></linearGradient>`
    + `<linearGradient id="y" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#00ff00"/><stop offset=".1" stop-color="#008000"/><stop offset=".9" stop-color="#008000"/><stop offset="1" stop-color="#000000"/></linearGradient></defs>`
    + `<rect width="100" height="100" fill="url(#x)"/><rect width="100" height="100" fill="url(#y)" style="mix-blend-mode:screen"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// Only Chromium draws an SVG filter as a backdrop. Elsewhere the same CSS
// would drop the blur altogether, so the lens is switched on by name.
function supportsLens() {
  const brands = globalThis.navigator?.userAgentData?.brands;
  return Array.isArray(brands) && brands.some(({ brand }) => brand === "Chromium");
}

function ensureLens() {
  if (document.getElementById("glass-lens-filter") || !supportsLens()) return;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "glass-lens-defs");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  const filter = document.createElementNS(SVG_NS, "filter");
  filter.id = "glass-lens-filter";
  filter.setAttribute("x", "0");
  filter.setAttribute("y", "0");
  filter.setAttribute("width", "1");
  filter.setAttribute("height", "1");
  filter.setAttribute("primitiveUnits", "objectBoundingBox");
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const image = document.createElementNS(SVG_NS, "feImage");
  image.setAttribute("href", lensMap());
  image.setAttribute("x", "0");
  image.setAttribute("y", "0");
  image.setAttribute("width", "1");
  image.setAttribute("height", "1");
  image.setAttribute("preserveAspectRatio", "none");
  image.setAttribute("result", "map");
  const bend = document.createElementNS(SVG_NS, "feDisplacementMap");
  bend.setAttribute("in", "SourceGraphic");
  bend.setAttribute("in2", "map");
  bend.setAttribute("scale", "0.09");
  bend.setAttribute("xChannelSelector", "R");
  bend.setAttribute("yChannelSelector", "G");
  filter.append(image, bend);
  svg.append(filter);
  document.body.append(svg);
}

function ensureSheen() {
  if (sheen?.isConnected) return sheen;
  sheen = document.createElement("div");
  sheen.className = "glass-sheen";
  sheen.setAttribute("aria-hidden", "true");
  document.body.append(sheen);
  return sheen;
}

function hideSheen() {
  pane = null;
  sheen?.classList.remove("is-lit");
}

function drawSheen() {
  frame = 0;
  if (!active() || !pointer) {
    hideSheen();
    return;
  }
  const target = document.elementFromPoint(pointer.x, pointer.y)?.closest?.(PANES);
  if (!target) {
    hideSheen();
    return;
  }
  const box = target.getBoundingClientRect();
  const layer = ensureSheen();
  if (target !== pane) {
    pane = target;
    layer.style.setProperty("--sheen-radius", getComputedStyle(target).borderRadius || "0px");
  }
  layer.style.setProperty("--sheen-left", `${box.left}px`);
  layer.style.setProperty("--sheen-top", `${box.top}px`);
  layer.style.setProperty("--sheen-width", `${box.width}px`);
  layer.style.setProperty("--sheen-height", `${box.height}px`);
  layer.style.setProperty("--sheen-x", `${pointer.x - box.left}px`);
  layer.style.setProperty("--sheen-y", `${pointer.y - box.top}px`);
  layer.classList.add("is-lit");
}

function onPointer(event) {
  if (event.pointerType === "touch") return;
  pointer = { x: event.clientX, y: event.clientY };
  if (!frame) frame = requestAnimationFrame(drawSheen);
}

function onScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (!active()) return;
    const offset = Math.max(globalThis.scrollY || 0, document.querySelector(".main-content")?.scrollTop || 0);
    root.style.setProperty("--glass-drift", `${Math.min(offset, 4000)}px`);
    if (!frame) frame = requestAnimationFrame(drawSheen);
  });
}

// A view "materializes" once when the route changes, not on every refresh.
function onRoute() {
  if (!active()) return;
  root.classList.remove("glass-entering");
  void root.offsetWidth;
  root.classList.add("glass-entering");
  clearTimeout(entryTimer);
  entryTimer = setTimeout(() => root.classList.remove("glass-entering"), 700);
}

function sync() {
  if (active()) {
    ensureLens();
    if (document.getElementById("glass-lens-filter")) root.dataset.glassLens = "on";
    root.dataset.glassMotion = "on";
  } else {
    delete root.dataset.glassLens;
    delete root.dataset.glassMotion;
    root.classList.remove("glass-entering");
    root.style.removeProperty("--glass-drift");
    hideSheen();
  }
}

document.addEventListener("pointermove", onPointer, { passive: true });
document.addEventListener("pointerleave", hideSheen, { passive: true });
document.addEventListener("scroll", onScroll, { passive: true, capture: true });
globalThis.addEventListener("hashchange", onRoute);
globalThis.addEventListener("blur", hideSheen);
reducedMotion?.addEventListener?.("change", sync);
reducedTransparency?.addEventListener?.("change", sync);
new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme", "data-transparency"] });
sync();
