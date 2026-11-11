// Launchpad page (v2). launchpad.yaml on the server is the single source of
// truth; this controller shows it and, with launchpad-editor.js attached,
// edits it one small operation at a time.
//
// Like network-map.js, the controller owns everything inside its root
// element: app-v5.js renders an empty `[data-launchpad-root]` and calls
// mount / refreshLive / unmount as the route and monitor data change.
// Tile positions are set through the CSSOM (element.style), which the
// shell's `style-src 'self'` CSP allows, rather than in style attributes.
// Theme tokens, tile accents and the owner's CSS arrive as one generated
// same-origin stylesheet, /api/v2/launchpad/theme.css.

import { breakpointForWidth, effectiveRects } from "./launchpad-grid.js";
import { resolveManaged } from "./launchpad-managed.js";

const POLL_MS = 5000;
const IFRAME_TIMEOUT_MS = 8000;
const THEME_LINK_ID = "launchpad-theme-stylesheet";

export function iconUrl(ref) {
  return `/api/v2/launchpad/icons/${encodeURIComponent(ref)}`;
}

function safeHref(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function hostLabel(href) {
  try {
    const url = new URL(href);
    return `${url.host}${url.pathname !== "/" ? url.pathname.replace(/\/$/u, "") : ""}`;
  } catch {
    return href;
  }
}

/** All tiles of a model with their page and group, in file order. */
export function launchpadTiles(model) {
  const tiles = [];
  for (const page of model?.pages || []) {
    for (const group of page.groups || []) {
      for (const tile of group.tiles || []) tiles.push({ page, group, tile });
    }
  }
  return tiles;
}

export function createLaunchpadController(deps) {
  const { setMarkup, escapeHtml, icon, toast, api, live, serviceIconMarkup, statusLabel, renderInline, controlState } = deps;

  const view = {
    model: null,
    revision: -1,
    error: null,
    loaded: false,
    loadError: "",
    activePageId: null,
    breakpoint: "desktop",
    filter: "",
    openMenuTileId: null,
    openFolderTileId: null,
    collapsed: new Set(),
    editing: false
  };
  let root = null;
  let pollTimer = null;
  let resizeObserver = null;
  let loading = null;
  let editor = null;
  const iframeTimers = new Map();

  // ---- data -------------------------------------------------------------

  function adopt(payload) {
    if (!payload || typeof payload.revision !== "number" || !payload.model) return;
    view.model = payload.model;
    view.revision = payload.revision;
    view.error = payload.error ?? null;
    view.loaded = true;
    view.loadError = "";
    const pages = view.model.pages || [];
    if (!pages.some((page) => page.id === view.activePageId)) view.activePageId = pages[0]?.id ?? null;
    syncThemeStylesheet();
  }

  function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        adopt(await api("/api/v2/launchpad"));
      } catch (error) {
        view.loadError = error?.message || "The launchpad could not be loaded.";
        view.loaded = true;
      } finally {
        loading = null;
      }
      // Don't repaint over a drag or a field the owner is typing in.
      if (!editor?.isBusy?.()) render();
    })();
    return loading;
  }

  async function poll() {
    if (!root || globalThis.document?.visibilityState === "hidden" || editor?.isBusy?.()) return;
    try {
      const current = await api("/api/v2/launchpad/revision");
      const errorChanged = JSON.stringify(current?.error ?? null) !== JSON.stringify(view.error ?? null);
      if (current?.revision !== view.revision || errorChanged) await load();
    } catch {
      // A failed poll is retried on the next tick.
    }
  }

  function syncThemeStylesheet() {
    const head = globalThis.document?.head;
    if (!head) return;
    let link = globalThis.document.getElementById(THEME_LINK_ID);
    if (!link) {
      link = globalThis.document.createElement("link");
      link.id = THEME_LINK_ID;
      link.rel = "stylesheet";
      head.append(link);
    }
    const href = `/api/v2/launchpad/theme.css?r=${Math.max(0, view.revision)}`;
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  }

  // ---- markup -----------------------------------------------------------

  function badge(title) {
    const letter = String(title || "?").trim().slice(0, 1).toUpperCase() || "?";
    return `<span class="lp-tile__badge" aria-hidden="true">${escapeHtml(letter)}</span>`;
  }

  function tileIcon(tile, resolved) {
    const ref = tile.icon;
    if (typeof ref === "string" && ref.startsWith("emoji:")) {
      return `<span class="lp-tile__icon lp-tile__icon--emoji" aria-hidden="true">${escapeHtml(ref.slice(6))}</span>`;
    }
    if (typeof ref === "string" && ref) {
      return `<span class="lp-tile__icon"><img class="lp-tile__img" src="${escapeHtml(iconUrl(ref))}" alt="" loading="lazy" decoding="async" data-lp-fallback="${escapeHtml(String(tile.title || tile.id).slice(0, 1).toUpperCase())}" /></span>`;
    }
    if (tile.managed?.kind === "media") {
      return `<span class="lp-tile__icon" aria-hidden="true">${serviceIconMarkup(tile.managed.id, String(tile.title || "?").slice(0, 1))}</span>`;
    }
    if (tile.managed?.kind === "service") {
      return `<span class="lp-tile__icon" aria-hidden="true">${serviceIconMarkup("portainer", String(tile.title || "?").slice(0, 1))}</span>`;
    }
    if (tile.managed?.kind === "container") {
      // A container named like a known service gets that service's icon.
      return `<span class="lp-tile__icon" aria-hidden="true">${serviceIconMarkup(tile.managed.name.toLowerCase(), String(tile.title || "?").slice(0, 1))}</span>`;
    }
    return `<span class="lp-tile__icon">${badge(tile.title || tile.id)}</span>`;
  }

  function healthMarkup(resolved) {
    if (!resolved) return "";
    if (!resolved.found) return `<span class="lp-tile__health is-missing" title="Linked service not found">${icon("link")}<span>Linked service not found</span></span>`;
    return `<span class="lp-tile__health is-${escapeHtml(resolved.state)}" title="${escapeHtml(resolved.label)}"><i class="health-dot is-${escapeHtml(resolved.state)}" aria-hidden="true"></i><span>${escapeHtml(statusLabel(resolved.state))}</span></span>`;
  }

  function actionButton(tile, resolved, action) {
    const target = resolved.actionTarget;
    const isContainer = tile.managed.kind === "container";
    const key = isContainer ? `portainer:${target.containerKey}:${action.operation}` : `proxmox:${target.workloadId}:${action.operation}`;
    const { busy, awaiting, disabled } = controlState(key);
    const attributes = isContainer
      ? `data-action="run-portainer-control" data-portainer-container-key="${escapeHtml(target.containerKey)}"`
      : `data-action="run-proxmox-control" data-infrastructure-workload-id="${escapeHtml(target.workloadId)}"`;
    const tone = action.tone === "danger" ? " button--danger" : action.tone === "primary" ? " button--primary" : "";
    const label = awaiting ? "Refresh required" : busy ? "Working…" : action.label;
    return `<button class="button button--compact${tone}" type="button" role="menuitem" ${attributes} data-control-operation="${escapeHtml(action.operation)}" data-control-key="${escapeHtml(key)}"${disabled ? " disabled" : ""}${busy && !awaiting ? " aria-busy=\"true\"" : ""}>${escapeHtml(label)}</button>`;
  }

  function menuMarkup(tile, resolved, href) {
    const open = view.openMenuTileId === tile.id;
    const actions = resolved?.found ? resolved.actions : [];
    if (!actions.length && !href) return "";
    const items = [
      ...actions.map((action) => actionButton(tile, resolved, action)),
      href ? `<a class="button button--compact" role="menuitem" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${icon("external")} Open in new tab</a>` : ""
    ].join("");
    return `<button class="icon-button lp-tile__menu-toggle" type="button" data-lp-action="toggle-menu" data-lp-tile="${escapeHtml(tile.id)}" aria-haspopup="menu" aria-expanded="${open}" aria-label="More for ${escapeHtml(tile.title || tile.id)}">${icon("more")}</button>
      <div class="lp-tile__menu" role="menu"${open ? "" : " hidden"}>${resolved?.found ? `<p class="lp-tile__menu-label">${escapeHtml(resolved.label)}</p>` : ""}${items}</div>`;
  }

  function noteMarkup(markdown) {
    const blocks = String(markdown || "").split(/\n{2,}/u);
    return blocks.map((block) => {
      const lines = block.split("\n");
      if (lines.every((line) => /^\s*[-*]\s+/u.test(line))) {
        return `<ul>${lines.map((line) => `<li>${renderInline(line.replace(/^\s*[-*]\s+/u, ""))}</li>`).join("")}</ul>`;
      }
      const heading = block.match(/^#{1,4}\s+(.+)$/u);
      if (heading && lines.length === 1) return `<p><strong>${renderInline(heading[1])}</strong></p>`;
      return `<p>${lines.map((line) => renderInline(line)).join("<br />")}</p>`;
    }).join("");
  }

  function searchText(tile) {
    return [tile.title, tile.url, tile.markdown, ...(tile.links || []).map((link) => `${link.title} ${link.url}`)]
      .filter(Boolean).join(" ").toLowerCase();
  }

  function tileBody(tile, resolved) {
    const title = tile.title || "";
    const label = tile.style?.hideLabel ? "" : `<strong class="lp-tile__title">${escapeHtml(title)}</strong>`;
    if (tile.type === "link") {
      const href = safeHref(tile.url);
      const target = tile.open === "sameTab" ? "" : ` target="_blank" rel="noopener noreferrer"`;
      return `<a class="lp-tile__surface" href="${escapeHtml(href)}"${target} aria-label="Open ${escapeHtml(title)}${tile.open === "sameTab" ? "" : " (opens in a new tab)"}">
          ${tileIcon(tile, resolved)}${label}<small class="lp-tile__host">${escapeHtml(hostLabel(href))}</small>${healthMarkup(resolved)}
        </a>`;
    }
    if (tile.type === "folder") {
      const open = view.openFolderTileId === tile.id;
      return `<button class="lp-tile__surface" type="button" data-lp-action="toggle-folder" data-lp-tile="${escapeHtml(tile.id)}" aria-expanded="${open}">
          ${tileIcon(tile)}${label}<small class="lp-tile__host">${tile.links.length} link${tile.links.length === 1 ? "" : "s"}</small>
        </button>
        <ul class="lp-folder" role="list"${open ? "" : " hidden"}>${tile.links.map((link) => {
          const href = safeHref(link.url);
          return `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.title)}<small>${escapeHtml(hostLabel(href))}</small></a></li>`;
        }).join("")}</ul>`;
    }
    if (tile.type === "note") {
      return `<div class="lp-tile__surface lp-tile__surface--note">${title && !tile.style?.hideLabel ? label : ""}<div class="lp-note">${noteMarkup(tile.markdown)}</div></div>`;
    }
    if (tile.type === "search") {
      const local = tile.engine === "tiles";
      return `<form class="lp-tile__surface lp-tile__surface--search" data-lp-search-form data-lp-tile="${escapeHtml(tile.id)}" role="search">
          ${icon("search")}<label class="sr-only" for="lp-search-${escapeHtml(tile.id)}">${escapeHtml(title || (local ? "Find a tile" : "Search the web"))}</label>
          <input id="lp-search-${escapeHtml(tile.id)}" type="search" autocomplete="off" spellcheck="false" maxlength="200" placeholder="${escapeHtml(title || (local ? "Find a tile" : "Search the web"))}" ${local ? `data-lp-filter value="${escapeHtml(view.filter)}"` : "data-lp-engine-input"} />
        </form>`;
    }
    if (tile.type === "iframe") {
      const href = safeHref(tile.url);
      return `<div class="lp-tile__surface lp-tile__surface--iframe">
          <iframe src="${escapeHtml(href)}" title="${escapeHtml(title || hostLabel(href))}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" data-lp-iframe="${escapeHtml(tile.id)}"></iframe>
          <p class="lp-iframe-blocked" hidden>This site refuses to be embedded. <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open it in a new tab</a>.</p>
        </div>`;
    }
    return "";
  }

  function tileMarkup(tile, liveData) {
    const resolved = tile.managed ? resolveManaged(tile.managed, liveData) : null;
    const text = searchText(tile);
    const hidden = view.filter && tile.type !== "search" && !text.includes(view.filter.toLowerCase());
    const href = tile.type === "link" || tile.type === "iframe" ? safeHref(tile.url) : "";
    const classes = ["lp-tile", `lp-tile--${tile.type}`, `lp-bg-${tile.style?.background || "glass"}`];
    if (tile.style?.accent) classes.push("has-accent");
    if (editor && view.editing && editor.selectedTileId?.() === tile.id) classes.push("is-selected");
    return `<li class="${classes.join(" ")}" data-id="${escapeHtml(tile.id)}" data-type="${escapeHtml(tile.type)}" data-lp-text="${escapeHtml(text)}"${hidden ? " hidden" : ""}${view.editing ? ` tabindex="0" aria-label="${escapeHtml(tile.title || tile.id)}, ${escapeHtml(tile.type)} tile"` : ""}>
        ${tileBody(tile, resolved)}
        ${view.editing ? editor.tileChrome(tile) : menuMarkup(tile, resolved, href)}
      </li>`;
  }

  function groupMarkup(page, group, liveData) {
    const collapsed = view.collapsed.has(`${page.id}/${group.id}`) || (group.collapsed && !view.collapsed.has(`!${page.id}/${group.id}`));
    return `<section class="lp-group" data-lp-group="${escapeHtml(group.id)}" aria-labelledby="lp-group-${escapeHtml(page.id)}-${escapeHtml(group.id)}">
        <header class="lp-group__header">
          <button class="lp-group__toggle" type="button" data-lp-action="toggle-group" data-lp-page="${escapeHtml(page.id)}" data-lp-group-id="${escapeHtml(group.id)}" aria-expanded="${!collapsed}">${icon("chevron")}<h3 id="lp-group-${escapeHtml(page.id)}-${escapeHtml(group.id)}">${escapeHtml(group.title)}</h3><span class="lp-count">${group.tiles.length}</span></button>
          ${view.editing ? editor.groupChrome(page, group) : ""}
        </header>
        <ul class="lp-grid" data-lp-grid="${escapeHtml(group.id)}"${collapsed ? " hidden" : ""}>${group.tiles.map((tile) => tileMarkup(tile, liveData)).join("")}</ul>
      </section>`;
  }

  function pageTabs(pages) {
    if (pages.length < 2 && !view.editing) return "";
    return `<nav class="lp-tabs" aria-label="Launchpad pages"><div role="tablist">${pages.map((page) => {
      const active = page.id === view.activePageId;
      const pageIcon = typeof page.icon === "string" && page.icon.startsWith("emoji:")
        ? `<span aria-hidden="true">${escapeHtml(page.icon.slice(6))}</span>`
        : page.icon ? `<img src="${escapeHtml(iconUrl(page.icon))}" alt="" class="lp-tabs__icon" data-lp-fallback="" />` : "";
      return `<button type="button" role="tab" class="lp-tabs__tab${active ? " is-active" : ""}" aria-selected="${active}" data-lp-action="select-page" data-lp-page="${escapeHtml(page.id)}">${pageIcon}${escapeHtml(page.title)}</button>`;
    }).join("")}</div>${view.editing ? editor.pageChrome(pages) : ""}</nav>`;
  }

  function markup() {
    if (!view.loaded) return `<div class="page lp-page"><section class="lp-empty"><p>Loading the launchpad…</p></section></div>`;
    if (!view.model) {
      return `<div class="page lp-page"><section class="lp-empty">${icon("launchpad")}<h3>The launchpad is unavailable</h3><p>${escapeHtml(view.loadError)}</p></section></div>`;
    }
    const pages = view.model.pages || [];
    const page = pages.find((candidate) => candidate.id === view.activePageId) || null;
    const liveData = live();
    const density = view.model.theme?.tokens?.density || "comfortable";
    const editToggle = editor
      ? `<button class="button${view.editing ? " button--primary" : ""}" type="button" data-lp-action="toggle-edit"${view.error ? " disabled title=\"Fix launchpad.yaml before editing here\"" : ""} aria-pressed="${view.editing}">${icon(view.editing ? "check" : "edit")} ${view.editing ? "Done" : "Edit layout"}</button>`
      : "";
    const banner = view.error
      ? `<p class="lp-banner" role="alert"><strong>launchpad.yaml has an error${view.error.line ? ` on line ${view.error.line}` : ""}.</strong> ${escapeHtml(view.error.message)} Helmsman keeps showing the last good layout until the file is fixed.</p>`
      : "";
    const body = !pages.length
      ? `<section class="lp-empty">${icon("launchpad")}<h3>Your launchpad is empty</h3><p>Add pages, groups and tiles for anything you want to open, managed by Helmsman or not.</p>${editor && !view.editing ? `<button class="button button--primary" type="button" data-lp-action="toggle-edit"${view.error ? " disabled" : ""}>${icon("edit")} Edit layout</button>` : ""}</section>`
      : page
        ? page.groups.length
          ? page.groups.map((group) => groupMarkup(page, group, liveData)).join("")
          : `<section class="lp-empty"><h3>This page has no groups yet</h3>${view.editing ? "" : "<p>Choose Edit layout to add one.</p>"}</section>`
        : "";
    const editorPanel = view.editing ? editor.panel() : "";
    return `<div class="page lp-page lp-root${view.editing ? " is-editing" : ""}${editorPanel ? " has-panel" : ""}" data-density="${escapeHtml(density)}" data-breakpoint="${escapeHtml(view.editing && editor.previewBreakpoint?.() ? editor.previewBreakpoint() : view.breakpoint)}">
        <section class="page-intro lp-intro">
          <div><span class="section-kicker">Launchpad</span><h2>${escapeHtml(page?.title || "Launchpad")}</h2></div>
          <div class="lp-intro__actions">${editToggle}</div>
        </section>
        ${banner}
        ${view.editing ? editor.toolbar() : ""}
        ${pageTabs(pages)}
        <div class="lp-groups">${body}</div>
        ${editorPanel}
      </div>`;
  }

  // ---- layout -------------------------------------------------------------

  function activeBreakpoint() {
    return view.editing && editor?.previewBreakpoint?.() ? editor.previewBreakpoint() : view.breakpoint;
  }

  function applyLayout() {
    if (!root || !view.model) return;
    const page = (view.model.pages || []).find((candidate) => candidate.id === view.activePageId);
    if (!page) return;
    const breakpoint = activeBreakpoint();
    for (const group of page.groups) {
      const grid = root.querySelector(`[data-lp-grid="${group.id}"]`);
      if (!grid) continue;
      const rects = editor?.overrideRects?.(group) || effectiveRects(group.tiles, breakpoint);
      for (const element of grid.children) {
        const rect = rects.get(element.dataset.id);
        if (!rect) continue;
        element.style.gridColumn = `${rect.x + 1} / span ${rect.w}`;
        element.style.gridRow = `${rect.y + 1} / span ${rect.h}`;
      }
    }
  }

  function render() {
    if (!root) return;
    const active = globalThis.document?.activeElement;
    const focusedId = active?.id;
    const focusedTileId = !focusedId && active?.classList?.contains("lp-tile") ? active.dataset.id : null;
    setMarkup(root, markup());
    applyLayout();
    watchIframes();
    if (focusedTileId) root.querySelector(`.lp-tile[data-id="${focusedTileId}"]`)?.focus({ preventScroll: true });
    if (focusedId) {
      const again = globalThis.document.getElementById(focusedId);
      if (again && root.contains(again)) {
        again.focus({ preventScroll: true });
        if (typeof again.value === "string" && again.setSelectionRange) again.setSelectionRange(again.value.length, again.value.length);
      }
    }
  }

  function watchIframes() {
    for (const timer of iframeTimers.values()) clearTimeout(timer);
    iframeTimers.clear();
    for (const frame of root?.querySelectorAll?.("iframe[data-lp-iframe]") || []) {
      const id = frame.dataset.lpIframe;
      iframeTimers.set(id, setTimeout(() => {
        frame.hidden = true;
        frame.parentElement?.querySelector(".lp-iframe-blocked")?.removeAttribute("hidden");
      }, IFRAME_TIMEOUT_MS));
    }
  }

  // ---- events ---------------------------------------------------------------

  function applyFilter() {
    const filter = view.filter.toLowerCase();
    for (const tile of root?.querySelectorAll?.(".lp-tile") || []) {
      if (tile.dataset.type === "search") continue;
      tile.hidden = Boolean(filter) && !String(tile.dataset.lpText || "").includes(filter);
    }
  }

  function onClick(event) {
    const target = event.target?.closest?.("[data-lp-action]");
    if (editor && view.editing && editor.handleClick(event)) return;
    if (!target || !root.contains(target)) {
      if (view.openMenuTileId || view.openFolderTileId) {
        if (!event.target?.closest?.(".lp-tile__menu, .lp-folder")) {
          view.openMenuTileId = null;
          view.openFolderTileId = null;
          render();
        }
      }
      return;
    }
    const action = target.dataset.lpAction;
    if (action === "toggle-menu") {
      view.openMenuTileId = view.openMenuTileId === target.dataset.lpTile ? null : target.dataset.lpTile;
      view.openFolderTileId = null;
      render();
    } else if (action === "toggle-folder") {
      view.openFolderTileId = view.openFolderTileId === target.dataset.lpTile ? null : target.dataset.lpTile;
      view.openMenuTileId = null;
      render();
    } else if (action === "toggle-group") {
      const key = `${target.dataset.lpPage}/${target.dataset.lpGroupId}`;
      const group = view.model?.pages?.find((page) => page.id === target.dataset.lpPage)?.groups?.find((entry) => entry.id === target.dataset.lpGroupId);
      const collapsedNow = view.collapsed.has(key) || (group?.collapsed && !view.collapsed.has(`!${key}`));
      view.collapsed.delete(key);
      view.collapsed.delete(`!${key}`);
      if (!collapsedNow) view.collapsed.add(key);
      else if (group?.collapsed) view.collapsed.add(`!${key}`);
      render();
    } else if (action === "select-page") {
      view.activePageId = target.dataset.lpPage;
      view.filter = "";
      render();
    } else if (action === "toggle-edit" && editor) {
      if (view.error) return;
      view.editing = !view.editing;
      view.openMenuTileId = null;
      view.openFolderTileId = null;
      if (view.editing) editor.enter();
      else editor.exit();
      render();
    }
  }

  function onInput(event) {
    if (editor && view.editing && editor.handleInput(event)) return;
    if (event.target?.matches?.("[data-lp-filter]")) {
      view.filter = String(event.target.value || "").slice(0, 200);
      applyFilter();
    }
  }

  function onSubmit(event) {
    const form = event.target?.closest?.("[data-lp-search-form]");
    if (!form) {
      if (editor && view.editing) editor.handleSubmit?.(event);
      return;
    }
    event.preventDefault();
    const tile = launchpadTiles(view.model).find(({ tile: candidate }) => candidate.id === form.dataset.lpTile)?.tile;
    const input = form.querySelector("input");
    const query = String(input?.value || "").trim();
    if (!tile || !query || tile.engine === "tiles") return;
    globalThis.open?.(tile.engine.replace("{query}", encodeURIComponent(query)), "_blank", "noopener,noreferrer");
  }

  function onKeyDown(event) {
    if (editor && view.editing && editor.handleKeyDown(event)) return;
    if (event.key === "Escape" && (view.openMenuTileId || view.openFolderTileId)) {
      view.openMenuTileId = null;
      view.openFolderTileId = null;
      render();
    }
  }

  function onFocusOut(event) {
    if (editor && view.editing) editor.handleFocusOut?.(event);
  }

  function onPointerDown(event) {
    if (editor && view.editing) editor.handlePointerDown(event);
  }

  // Image and frame events don't bubble, so they are caught on the way down.
  function onError(event) {
    const image = event.target;
    if (image?.tagName === "IMG" && image.dataset?.lpFallback !== undefined) {
      const span = globalThis.document.createElement("span");
      span.className = "lp-tile__badge";
      span.setAttribute("aria-hidden", "true");
      span.textContent = image.dataset.lpFallback || "";
      image.replaceWith(span);
    }
  }

  function onLoad(event) {
    const frame = event.target;
    if (frame?.tagName === "IFRAME" && frame.dataset?.lpIframe) {
      clearTimeout(iframeTimers.get(frame.dataset.lpIframe));
      iframeTimers.delete(frame.dataset.lpIframe);
    }
  }

  function onResize(entries) {
    const width = entries?.[0]?.contentRect?.width ?? root?.clientWidth ?? 1200;
    const next = breakpointForWidth(width);
    if (next !== view.breakpoint) {
      view.breakpoint = next;
      if (root?.firstElementChild) root.firstElementChild.dataset.breakpoint = activeBreakpoint();
      applyLayout();
    }
  }

  const listeners = [
    ["click", onClick, false],
    ["input", onInput, false],
    ["submit", onSubmit, false],
    ["keydown", onKeyDown, false],
    ["pointerdown", onPointerDown, false],
    ["focusout", onFocusOut, false],
    ["error", onError, true],
    ["load", onLoad, true]
  ];

  // ---- public -----------------------------------------------------------

  const controller = {
    view,

    mount(element) {
      if (root === element) return;
      controller.unmount();
      root = element;
      for (const [type, handler, capture] of listeners) root.addEventListener(type, handler, capture);
      if (typeof ResizeObserver === "function") {
        resizeObserver = new ResizeObserver(onResize);
        resizeObserver.observe(root);
      }
      view.breakpoint = breakpointForWidth(root.clientWidth || 1200);
      pollTimer = setInterval(poll, POLL_MS);
      if (view.loaded && view.model) render();
      else render();
      load();
    },

    isMountedOn(element) {
      return root === element && Boolean(element?.isConnected ?? true);
    },

    refreshLive() {
      if (root && view.model && !editor?.isBusy?.()) render();
    },

    unmount() {
      if (!root) return;
      for (const [type, handler, capture] of listeners) root.removeEventListener(type, handler, capture);
      resizeObserver?.disconnect();
      resizeObserver = null;
      clearInterval(pollTimer);
      pollTimer = null;
      for (const timer of iframeTimers.values()) clearTimeout(timer);
      iframeTimers.clear();
      if (view.editing) {
        view.editing = false;
        editor?.exit();
      }
      root = null;
    },

    attachEditor(factory, extra = {}) {
      editor = factory({
        ...extra,
        view,
        api,
        toast,
        escapeHtml,
        icon,
        live,
        root: () => root,
        render,
        applyLayout,
        adopt,
        reload: load,
        activeBreakpoint,
        syncThemeStylesheet
      });
      return editor;
    },

    reload: load,
    render
  };
  return controller;
}
