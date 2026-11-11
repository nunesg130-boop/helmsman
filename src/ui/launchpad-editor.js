// Launchpad editor. Attached to the controller in launchpad.js, it adds
// edit mode: drag and resize on the grid, keyboard moves, per-breakpoint
// layouts, and a side panel for pages, groups, tiles and the theme.
//
// Every change is one small operation sent to POST /api/v2/launchpad/ops
// with the revision this page last saw. Operations are queued so they reach
// the server in order. A 409 means launchpad.yaml was edited outside
// Helmsman: the page reloads it instead of overwriting the hand edit.

import { COLUMNS, effectiveRects, followsDesktop, placeWithPushDown, pointerToCell } from "./launchpad-grid.js";
import { launchpadTiles } from "./launchpad.js";

const TEXT_DEBOUNCE_MS = 400;
const KEY_COMMIT_MS = 350;
const BREAKPOINT_LABELS = { desktop: "Desktop", tablet: "Tablet", phone: "Phone" };
const TYPE_LABELS = { link: "Link", folder: "Folder", note: "Note", search: "Search", iframe: "Embed" };

function slugify(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
}

export function uniqueId(base, taken, fallback = "item") {
  const root = slugify(base) || fallback;
  let candidate = root;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${root}-${suffix}`;
  return candidate;
}

/** Parses folder links written one per line as "Title | https://address". */
export function parseFolderLines(text) {
  return String(text || "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const bar = line.indexOf("|");
    if (bar < 0) return { title: line.replace(/^https?:\/\//u, "").slice(0, 80), url: line };
    return { title: line.slice(0, bar).trim().slice(0, 80), url: line.slice(bar + 1).trim() };
  });
}

export function createLaunchpadEditor(ctx) {
  const { view, api, toast, escapeHtml, icon, live, uploadIcon } = ctx;

  let selection = null; // { kind: "tile" | "group" | "page" | "theme" | "new-tile", ... }
  let previewBreakpoint = null;
  let drag = null;
  let keyPreview = null; // { groupId, rects }
  let keyTimer = null;
  let pendingDelete = null;
  let queue = Promise.resolve();
  let pending = 0;
  // Bumped on a conflict: changes queued before it were computed from the
  // old layout, so they are dropped rather than applied to the newer file.
  let generation = 0;
  let renderDeferred = false;
  const textTimers = new Map();

  // While the owner is typing in the panel, a repaint would replace the
  // field under the cursor. Repaints wait until focus leaves the panel.
  function panelHasFocus() {
    const active = globalThis.document?.activeElement;
    return Boolean(active?.closest?.(".lp-panel"));
  }

  function repaint() {
    if (panelHasFocus()) {
      renderDeferred = true;
      return;
    }
    renderDeferred = false;
    ctx.render();
  }

  // ---- model helpers --------------------------------------------------

  function activePage() {
    return view.model?.pages?.find((page) => page.id === view.activePageId) || null;
  }

  function findTile(tileId) {
    return launchpadTiles(view.model).find(({ tile }) => tile.id === tileId) || null;
  }

  function breakpoint() {
    return previewBreakpoint || view.breakpoint;
  }

  function takenIds(kind) {
    if (kind === "page") return new Set((view.model?.pages || []).map((page) => page.id));
    if (kind === "group") return new Set((activePage()?.groups || []).map((group) => group.id));
    return new Set(launchpadTiles(view.model).map(({ tile }) => tile.id));
  }

  // ---- sending --------------------------------------------------------

  function send(op, { quiet = false } = {}) {
    pending += 1;
    const queuedIn = generation;
    const run = queue.then(async () => {
      try {
        if (queuedIn !== generation) return false;
        const result = await api("/api/v2/launchpad/ops", { method: "POST", body: { revision: view.revision, op } });
        ctx.adopt({ ...result, error: null });
        return true;
      } catch (error) {
        if (error?.code === "LAUNCHPAD_CHANGED") {
          generation += 1;
          toast("The launchpad changed elsewhere, so the latest version was loaded", "info");
          await ctx.reload();
        } else if (error?.code === "LAUNCHPAD_INVALID") {
          toast("Fix launchpad.yaml before editing here", "danger");
          await ctx.reload();
        } else if (!quiet) {
          toast(error?.message || "That change could not be saved", "danger");
        }
        return false;
      } finally {
        pending -= 1;
      }
    });
    queue = run.catch(() => false);
    return run.then((ok) => {
      if (!drag) repaint();
      return ok;
    });
  }

  // ---- markup ---------------------------------------------------------

  function segmented(name, options, current) {
    return `<div class="lp-segmented" role="group" aria-label="${escapeHtml(name)}">${options.map(([value, label]) => (
      `<button type="button" class="lp-segmented__option${value === current ? " is-active" : ""}" aria-pressed="${value === current}" data-lp-edit="breakpoint" data-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`
    )).join("")}</div>`;
  }

  function toolbar() {
    const page = activePage();
    const current = breakpoint();
    const follows = page && current !== "desktop" && page.groups.every((group) => followsDesktop(group.tiles, current));
    const layoutNote = !page || current === "desktop"
      ? ""
      : follows
        ? `<span class="lp-toolbar__note">${escapeHtml(BREAKPOINT_LABELS[current])} follows the desktop layout.</span><button class="button button--compact" type="button" data-lp-edit="customize">Customize ${escapeHtml(BREAKPOINT_LABELS[current].toLowerCase())}</button>`
        : `<span class="lp-toolbar__note">${escapeHtml(BREAKPOINT_LABELS[current])} has its own layout.</span><button class="button button--compact" type="button" data-lp-edit="reset-breakpoint">Reset to auto</button>`;
    return `<section class="lp-toolbar" aria-label="Edit layout">
        ${segmented("Layout to edit", Object.entries(BREAKPOINT_LABELS), current)}
        <div class="lp-toolbar__layout">${layoutNote}</div>
        <div class="lp-toolbar__actions">
          <button class="button button--compact" type="button" data-lp-edit="open-theme">${icon("settings")} Theme</button>
          <button class="button button--compact" type="button" data-lp-edit="add-page">${icon("plus")} Page</button>
          ${page ? `<button class="button button--compact" type="button" data-lp-edit="add-group">${icon("plus")} Group</button>` : ""}
        </div>
      </section>`;
  }

  function pageChrome() {
    const page = activePage();
    if (!page) return "";
    return `<button class="icon-button" type="button" data-lp-edit="open-page" aria-label="Page settings for ${escapeHtml(page.title)}">${icon("edit")}</button>`;
  }

  function groupChrome(page, group) {
    return `<div class="lp-group__edit">
        <button class="button button--compact" type="button" data-lp-edit="new-tile" data-lp-group-id="${escapeHtml(group.id)}">${icon("plus")} Tile</button>
        <button class="icon-button" type="button" data-lp-edit="open-group" data-lp-group-id="${escapeHtml(group.id)}" aria-label="Group settings for ${escapeHtml(group.title)}">${icon("edit")}</button>
      </div>`;
  }

  function tileChrome(tile) {
    const label = escapeHtml(tile.title || tile.id);
    return `<button class="lp-tile__handle" type="button" data-lp-drag="move" aria-label="Move ${label}" title="Drag to move">${icon("more")}</button>
      <button class="lp-tile__resize" type="button" data-lp-drag="resize" aria-label="Resize ${label}" title="Drag to resize"></button>`;
  }

  function field(label, control, hint = "") {
    return `<label class="lp-field"><span>${escapeHtml(label)}</span>${control}${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</label>`;
  }

  function textInput(name, value, attributes = "") {
    return `<input type="text" id="lp-field-${escapeHtml(name)}" data-lp-field="${escapeHtml(name)}" value="${escapeHtml(value ?? "")}" autocomplete="off" spellcheck="false" ${attributes} />`;
  }

  function select(name, options, current) {
    return `<select data-lp-field="${escapeHtml(name)}">${options.map(([value, label]) => (
      `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`
    )).join("")}</select>`;
  }

  function managedOptions() {
    const data = live();
    const options = [["", "Not linked"]];
    for (const entry of data.connections || []) {
      options.push([JSON.stringify({ kind: entry.kind, id: entry.id }), `${entry.name} · ${entry.role}`]);
    }
    for (const container of data.containers || []) {
      options.push([
        JSON.stringify({ kind: "container", service: container.serverId, environment: container.environmentId, name: container.name }),
        `Container ${container.name} · ${container.environmentName || "Portainer"}`
      ]);
    }
    for (const workload of data.workloads || []) {
      if (!Number.isInteger(workload.vmid) || !workload.environmentId) continue;
      options.push([
        JSON.stringify({ kind: "workload", environment: workload.environmentId, vmid: workload.vmid }),
        `${workload.kind || "Guest"} ${workload.vmid} ${workload.name} · ${workload.environmentName || "Proxmox"}`
      ]);
    }
    return options;
  }

  function managedValue(managed) {
    if (!managed) return "";
    if (managed.kind === "container") return JSON.stringify({ kind: "container", service: managed.service, environment: managed.environment, name: managed.name });
    if (managed.kind === "workload") return JSON.stringify({ kind: "workload", environment: managed.environment, vmid: managed.vmid });
    return JSON.stringify({ kind: managed.kind, id: managed.id });
  }

  function iconField(value) {
    return field("Icon", `<div class="lp-field__row">${textInput("icon", value, 'placeholder="dashboard-icons:jellyfin"')}<label class="button button--compact lp-upload">Upload<input class="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-lp-upload /></label></div>`,
      "dashboard-icons:<name>, mdi:<name>, or upload an image up to 512 KB");
  }

  function deleteButton(kind, label) {
    const armed = pendingDelete === kind;
    return `<button class="button button--compact button--danger" type="button" data-lp-edit="delete" data-kind="${escapeHtml(kind)}">${armed ? `Confirm: delete ${escapeHtml(label)}` : `Delete ${escapeHtml(label)}`}</button>`;
  }

  function tilePanel(tile) {
    const fields = [field("Title", textInput("title", tile.title, 'maxlength="80"'))];
    if (tile.type === "link" || tile.type === "iframe") fields.push(field("Address", textInput("url", tile.url, 'inputmode="url" maxlength="500"')));
    if (tile.type === "link") {
      fields.push(field("Opens in", select("open", [["newTab", "New tab"], ["sameTab", "This tab"]], tile.open || "newTab")));
      fields.push(field("Linked service", select("managed", managedOptions(), managedValue(tile.managed)), "Shows its health and offers its start, stop and restart controls"));
    }
    if (tile.type === "folder") {
      fields.push(field("Links", `<textarea data-lp-field="links" rows="6" spellcheck="false">${escapeHtml((tile.links || []).map((link) => `${link.title} | ${link.url}`).join("\n"))}</textarea>`, "One per line: Title | https://address"));
    }
    if (tile.type === "note") fields.push(field("Note", `<textarea data-lp-field="markdown" rows="6">${escapeHtml(tile.markdown || "")}</textarea>`, "Markdown: **bold**, lists and links"));
    if (tile.type === "search") {
      fields.push(field("Searches", textInput("engine", tile.engine, 'maxlength="500"'), "tiles to filter this page, or an https address containing {query}"));
    }
    fields.push(iconField(tile.icon));
    fields.push(field("Accent", `<div class="lp-field__row"><input type="color" data-lp-field="accent" value="${escapeHtml(tile.style?.accent && tile.style.accent.length === 7 ? tile.style.accent : "#7f8088")}" /><button class="button button--compact" type="button" data-lp-edit="clear-accent"${tile.style?.accent ? "" : " disabled"}>Clear</button></div>`));
    fields.push(field("Background", select("background", [["glass", "Glass"], ["solid", "Solid"], ["none", "None"]], tile.style?.background || "glass")));
    fields.push(`<label class="lp-check"><input type="checkbox" data-lp-field="hideLabel"${tile.style?.hideLabel ? " checked" : ""} /><span>Hide the title on the tile</span></label>`);
    return `<header class="lp-panel__header"><div><span class="section-kicker">${escapeHtml(TYPE_LABELS[tile.type])} tile</span><h3>${escapeHtml(tile.title || tile.id)}</h3></div>${closeButton()}</header>
      <div class="lp-panel__body">${fields.join("")}</div>
      <footer class="lp-panel__footer">${deleteButton("tile", "tile")}</footer>`;
  }

  function newTilePanel() {
    const type = selection.type || "link";
    const needsUrl = type === "link" || type === "iframe";
    return `<header class="lp-panel__header"><div><span class="section-kicker">New tile</span><h3>Add a tile</h3></div>${closeButton()}</header>
      <form class="lp-panel__body" data-lp-new-tile>
        ${field("Type", select("new-type", Object.entries(TYPE_LABELS), type))}
        ${field("Title", `<input type="text" name="title" maxlength="80" autocomplete="off" ${type === "link" || type === "folder" ? "required" : ""} />`)}
        ${needsUrl ? field("Address", '<input type="url" name="url" maxlength="500" required inputmode="url" placeholder="https://" />') : ""}
        ${type === "folder" ? field("Links", '<textarea name="links" rows="5" required spellcheck="false"></textarea>', "One per line: Title | https://address") : ""}
        ${type === "note" ? field("Note", '<textarea name="markdown" rows="5" required></textarea>') : ""}
        ${type === "search" ? field("Searches", '<input type="text" name="engine" value="tiles" maxlength="500" required />', "tiles to filter this page, or an https address containing {query}") : ""}
        <button class="button button--primary" type="submit">Add tile</button>
      </form>`;
  }

  function groupPanel(group) {
    return `<header class="lp-panel__header"><div><span class="section-kicker">Group</span><h3>${escapeHtml(group.title)}</h3></div>${closeButton()}</header>
      <div class="lp-panel__body">
        ${field("Title", textInput("group-title", group.title, 'maxlength="80"'))}
        <label class="lp-check"><input type="checkbox" data-lp-field="group-collapsed"${group.collapsed ? " checked" : ""} /><span>Start collapsed</span></label>
        <div class="lp-field__row"><button class="button button--compact" type="button" data-lp-edit="move-group" data-step="-1">Move up</button><button class="button button--compact" type="button" data-lp-edit="move-group" data-step="1">Move down</button></div>
      </div>
      <footer class="lp-panel__footer">${deleteButton("group", "group and its tiles")}</footer>`;
  }

  function pagePanel(page) {
    return `<header class="lp-panel__header"><div><span class="section-kicker">Page</span><h3>${escapeHtml(page.title)}</h3></div>${closeButton()}</header>
      <div class="lp-panel__body">
        ${field("Title", textInput("page-title", page.title, 'maxlength="80"'))}
        ${field("Icon", textInput("page-icon", page.icon, 'placeholder="mdi:home"'), "Optional: dashboard-icons:<name> or mdi:<name>")}
        <div class="lp-field__row"><button class="button button--compact" type="button" data-lp-edit="move-page" data-step="-1">Move left</button><button class="button button--compact" type="button" data-lp-edit="move-page" data-step="1">Move right</button></div>
      </div>
      <footer class="lp-panel__footer">${deleteButton("page", "page and everything on it")}</footer>`;
  }

  function themePanel() {
    const tokens = view.model?.theme?.tokens || {};
    return `<header class="lp-panel__header"><div><span class="section-kicker">Theme</span><h3>Launchpad theme</h3></div>${closeButton()}</header>
      <div class="lp-panel__body">
        ${field("Accent", `<div class="lp-field__row"><input type="color" data-lp-field="theme-accent" value="${escapeHtml(tokens.accent && tokens.accent.length === 7 ? tokens.accent : "#7f8088")}" /><button class="button button--compact" type="button" data-lp-edit="clear-theme-accent"${tokens.accent ? "" : " disabled"}>Clear</button></div>`, "Marks the selected page tab")}
        ${field("Corner radius", `<input type="number" min="0" max="32" step="1" data-lp-field="theme-radius" value="${escapeHtml(tokens.radius ?? 8)}" />`, "0 to 32 pixels")}
        ${field("Density", select("theme-density", [["compact", "Compact"], ["comfortable", "Comfortable"], ["spacious", "Spacious"]], tokens.density || "comfortable"))}
        ${field("Custom CSS", `<textarea data-lp-field="theme-css" rows="10" spellcheck="false" class="lp-code">${escapeHtml(view.model?.theme?.css || "")}</textarea>`, "Target tiles with .lp-tile[data-id=\"…\"]. Remote url() and @import are removed.")}
      </div>`;
  }

  function closeButton() {
    return `<button class="icon-button" type="button" data-lp-edit="close-panel" aria-label="Close panel">${icon("x")}</button>`;
  }

  function panel() {
    if (!selection) return "";
    let body = "";
    if (selection.kind === "tile") {
      const entry = findTile(selection.tileId);
      if (!entry) return "";
      body = tilePanel(entry.tile);
    } else if (selection.kind === "new-tile") {
      body = newTilePanel();
    } else if (selection.kind === "group") {
      const group = activePage()?.groups.find((candidate) => candidate.id === selection.groupId);
      if (!group) return "";
      body = groupPanel(group);
    } else if (selection.kind === "page") {
      const page = activePage();
      if (!page) return "";
      body = pagePanel(page);
    } else if (selection.kind === "theme") {
      body = themePanel();
    }
    return `<aside class="lp-panel" aria-label="Launchpad editor panel">${body}</aside>`;
  }

  // ---- layout ---------------------------------------------------------

  function overrideRects(group) {
    if (drag?.groupId === group.id && drag.preview) return drag.preview;
    if (keyPreview?.groupId === group.id) return keyPreview.rects;
    return null;
  }

  function groupRects(group) {
    return effectiveRects(group.tiles, breakpoint());
  }

  // Sends a group's new rects. A tablet or phone layout that still follows
  // desktop is written out whole on its first edit, so it becomes its own.
  function commitRects(group, changed, merged) {
    const current = breakpoint();
    const rects = current !== "desktop" && followsDesktop(group.tiles, current) ? merged : changed;
    if (!rects.size) return Promise.resolve(true);
    return send({ op: "setLayouts", breakpoint: current, rects: Object.fromEntries(rects) });
  }

  // The grid's own box includes its side padding; cells start inside it.
  function gridMetrics(grid) {
    const style = globalThis.getComputedStyle(grid);
    const outer = grid.getBoundingClientRect();
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    return {
      box: { left: outer.left + paddingLeft, top: outer.top, width: outer.width - paddingLeft - paddingRight, height: outer.height },
      rowHeight: Number.parseFloat(style.gridAutoRows) || 112,
      gap: Number.parseFloat(style.columnGap) || 12
    };
  }

  // ---- events ---------------------------------------------------------

  function select_(next) {
    selection = next;
    pendingDelete = null;
    ctx.render();
  }

  async function addTileFromForm(form) {
    const group = activePage()?.groups.find((candidate) => candidate.id === selection.groupId);
    if (!group) return;
    const data = new FormData(form);
    const type = selection.type || "link";
    const title = String(data.get("title") || "").trim();
    const tile = { id: uniqueId(title || type, takenIds("tile"), type), type };
    if (title) tile.title = title;
    if (type === "link" || type === "iframe") tile.url = String(data.get("url") || "").trim();
    if (type === "folder") tile.links = parseFolderLines(data.get("links"));
    if (type === "note") tile.markdown = String(data.get("markdown") || "");
    if (type === "search") tile.engine = String(data.get("engine") || "tiles").trim();
    const ok = await send({ op: "addTile", pageId: view.activePageId, groupId: group.id, tile });
    if (ok) {
      selection = { kind: "tile", tileId: tile.id };
      ctx.render();
      toast("Tile added", "success");
    }
  }

  async function deleteSelection(kind) {
    if (pendingDelete !== kind) {
      pendingDelete = kind;
      ctx.render();
      return;
    }
    pendingDelete = null;
    let op = null;
    if (kind === "tile") op = { op: "removeTile", tileId: selection.tileId };
    if (kind === "group") op = { op: "removeGroup", pageId: view.activePageId, groupId: selection.groupId };
    if (kind === "page") op = { op: "removePage", pageId: view.activePageId };
    selection = null;
    if (op && await send(op)) toast(`${kind[0].toUpperCase()}${kind.slice(1)} deleted`, "success");
  }

  function move(kind, step) {
    const page = activePage();
    if (!page) return;
    if (kind === "page") {
      const index = view.model.pages.findIndex((entry) => entry.id === page.id) + step;
      if (index >= 0 && index < view.model.pages.length) send({ op: "movePage", pageId: page.id, index });
    } else {
      const index = page.groups.findIndex((entry) => entry.id === selection.groupId) + step;
      if (index >= 0 && index < page.groups.length) send({ op: "moveGroup", pageId: page.id, groupId: selection.groupId, index });
    }
  }

  function handleClick(event) {
    const control = event.target?.closest?.("[data-lp-edit]");
    if (control) {
      event.preventDefault();
      const action = control.dataset.lpEdit;
      const page = activePage();
      if (action === "breakpoint") {
        previewBreakpoint = control.dataset.value === view.breakpoint ? null : control.dataset.value;
        ctx.render();
      } else if (action === "customize" && page) {
        const current = breakpoint();
        for (const group of page.groups) {
          if (group.tiles.length) send({ op: "setLayouts", breakpoint: current, rects: Object.fromEntries(groupRects(group)) });
        }
      } else if (action === "reset-breakpoint" && page) {
        send({ op: "resetBreakpoint", pageId: page.id, breakpoint: breakpoint() });
      } else if (action === "open-theme") select_({ kind: "theme" });
      else if (action === "open-page") select_({ kind: "page" });
      else if (action === "open-group") select_({ kind: "group", groupId: control.dataset.lpGroupId });
      else if (action === "new-tile") select_({ kind: "new-tile", groupId: control.dataset.lpGroupId, type: "link" });
      else if (action === "close-panel") select_(null);
      else if (action === "add-page") {
        const id = uniqueId("page", takenIds("page"), "page");
        send({ op: "addPage", page: { id, title: "New page", groups: [] } }).then((ok) => {
          if (ok) {
            view.activePageId = id;
            select_({ kind: "page" });
          }
        });
      } else if (action === "add-group" && page) {
        const id = uniqueId("group", takenIds("group"), "group");
        send({ op: "addGroup", pageId: page.id, group: { id, title: "New group", tiles: [] } }).then((ok) => {
          if (ok) select_({ kind: "group", groupId: id });
        });
      } else if (action === "delete") deleteSelection(control.dataset.kind);
      else if (action === "move-page") move("page", Number(control.dataset.step));
      else if (action === "move-group") move("group", Number(control.dataset.step));
      else if (action === "clear-accent" && selection?.kind === "tile") {
        const entry = findTile(selection.tileId);
        if (entry) send({ op: "updateTile", tileId: entry.tile.id, patch: { style: { ...entry.tile.style, accent: undefined } } });
      } else if (action === "clear-theme-accent") send({ op: "updateTheme", patch: { tokens: { accent: null } } });
      return true;
    }
    if (event.target?.closest?.(".lp-panel, .lp-toolbar, [data-lp-drag]")) return Boolean(event.target.closest("[data-lp-drag]"));
    const tile = event.target?.closest?.(".lp-tile");
    if (tile) {
      // In edit mode a tile is selected, never opened.
      event.preventDefault();
      if (!event.target.closest("input")) select_({ kind: "tile", tileId: tile.dataset.id });
      return true;
    }
    return false;
  }

  function scheduleText(key, fn) {
    clearTimeout(textTimers.get(key)?.timer);
    textTimers.set(key, {
      fn,
      timer: setTimeout(() => {
        textTimers.delete(key);
        fn();
      }, TEXT_DEBOUNCE_MS)
    });
  }

  // Saves text still waiting for its debounce, e.g. when edit mode closes.
  function flushText() {
    for (const [key, { timer, fn }] of textTimers) {
      clearTimeout(timer);
      textTimers.delete(key);
      fn();
    }
  }

  function tilePatchFor(name, element, tile) {
    const value = element.type === "checkbox" ? element.checked : element.value;
    if (name === "managed") return { managed: value ? JSON.parse(value) : null };
    if (name === "links") return { links: parseFolderLines(value) };
    if (name === "accent" || name === "background" || name === "hideLabel") {
      return { style: { ...tile.style, [name]: value } };
    }
    const text = String(value).trim();
    // Links and folders must keep a title; wait until there is one to save.
    if (name === "title" && !text && (tile.type === "link" || tile.type === "folder")) return null;
    return { [name]: text === "" && ["title", "icon"].includes(name) ? null : name === "markdown" ? String(value) : text };
  }

  function handleInput(event) {
    const element = event.target;
    if (element?.matches?.("[data-lp-upload]")) {
      const file = element.files?.[0];
      if (!file || selection?.kind !== "tile") return true;
      uploadIcon(file).then((ref) => {
        send({ op: "updateTile", tileId: selection.tileId, patch: { icon: ref } });
      }).catch((error) => toast(error?.message || "That image could not be uploaded", "danger"));
      return true;
    }
    const name = element?.dataset?.lpField;
    if (!name) return Boolean(element?.closest?.(".lp-panel"));
    const immediate = element.tagName === "SELECT" || element.type === "checkbox" || element.type === "color";

    if (name === "new-type") {
      selection = { ...selection, type: element.value };
      ctx.render();
      return true;
    }
    if (selection?.kind === "tile") {
      const tileId = selection.tileId;
      const apply = () => {
        const entry = findTile(tileId);
        const patch = entry ? tilePatchFor(name, element, entry.tile) : null;
        if (patch) send({ op: "updateTile", tileId, patch });
      };
      if (immediate) apply();
      else scheduleText(`tile:${tileId}:${name}`, apply);
      return true;
    }
    if (selection?.kind === "group") {
      const groupId = selection.groupId;
      const patch = name === "group-title" ? { title: element.value.trim() } : { collapsed: element.checked };
      const apply = () => send({ op: "updateGroup", pageId: view.activePageId, groupId, patch });
      if (immediate) apply();
      else scheduleText(`group:${groupId}`, apply);
      return true;
    }
    if (selection?.kind === "page") {
      const pageId = view.activePageId;
      const patch = name === "page-title" ? { title: element.value.trim() } : { icon: element.value.trim() || null };
      scheduleText(`page:${pageId}:${name}`, () => send({ op: "updatePage", pageId, patch }));
      return true;
    }
    if (selection?.kind === "theme") {
      const apply = () => {
        if (name === "theme-css") return send({ op: "updateTheme", patch: { css: element.value } });
        const token = { "theme-accent": "accent", "theme-radius": "radius", "theme-density": "density" }[name];
        const value = token === "radius" ? Number(element.value) : element.value;
        return send({ op: "updateTheme", patch: { tokens: { [token]: value } } });
      };
      if (immediate) apply();
      else scheduleText(`theme:${name}`, apply);
      return true;
    }
    return false;
  }

  function handleSubmit(event) {
    const form = event.target?.closest?.("[data-lp-new-tile]");
    if (!form) return;
    event.preventDefault();
    if (form.reportValidity?.() === false) return;
    addTileFromForm(form);
  }

  function handleKeyDown(event) {
    const tileElement = event.target?.closest?.(".lp-tile");
    if (!tileElement || event.target !== tileElement) {
      if (event.key === "Escape" && selection) {
        select_(null);
        return true;
      }
      return false;
    }
    const tileId = tileElement.dataset.id;
    if (event.key === "Enter") {
      event.preventDefault();
      select_({ kind: "tile", tileId });
      return true;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      selection = { kind: "tile", tileId };
      pendingDelete = "tile";
      ctx.render();
      return true;
    }
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!step) return false;
    event.preventDefault();
    const entry = findTile(tileId);
    if (!entry) return true;
    const group = entry.group;
    const columns = COLUMNS[breakpoint()];
    const base = keyPreview?.groupId === group.id ? keyPreview.rects : groupRects(group);
    const rect = base.get(tileId);
    const next = event.shiftKey
      ? { ...rect, w: Math.max(1, rect.w + step[0]), h: Math.max(1, rect.h + step[1]) }
      : { ...rect, x: Math.max(0, rect.x + step[0]), y: Math.max(0, rect.y + step[1]) };
    const changed = placeWithPushDown(base, tileId, next, columns);
    const merged = new Map([...base, ...changed]);
    const original = groupRects(group);
    keyPreview = { groupId: group.id, rects: merged };
    ctx.applyLayout();
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => {
      const preview = keyPreview;
      keyPreview = null;
      const diff = new Map([...preview.rects].filter(([id, value]) => JSON.stringify(original.get(id)) !== JSON.stringify(value)));
      commitRects(group, diff, preview.rects);
    }, KEY_COMMIT_MS);
    return true;
  }

  function handlePointerDown(event) {
    const handle = event.target?.closest?.("[data-lp-drag]");
    if (!handle || event.button !== 0) return;
    const tileElement = handle.closest(".lp-tile");
    const grid = handle.closest("[data-lp-grid]");
    const entry = findTile(tileElement?.dataset.id);
    if (!entry || !grid) return;
    event.preventDefault();
    const columns = COLUMNS[breakpoint()];
    const metrics = gridMetrics(grid);
    const rects = groupRects(entry.group);
    drag = {
      mode: handle.dataset.lpDrag,
      tileId: entry.tile.id,
      groupId: entry.group.id,
      columns,
      metrics,
      rects,
      start: pointerToCell(event, metrics.box, columns, metrics.rowHeight, metrics.gap),
      startRect: rects.get(entry.tile.id),
      preview: null,
      targetGroupId: entry.group.id,
      // Group boxes as they were when the drag began, so the source grid
      // growing under the preview can't hide the group being dropped on.
      groupBoxes: [...ctx.root().querySelectorAll("[data-lp-grid]")].map((element) => ({ id: element.dataset.lpGrid, box: element.getBoundingClientRect() }))
    };
    tileElement.classList.add("is-dragging");
    const root = ctx.root();
    root.setPointerCapture?.(event.pointerId);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerup", onPointerUp, { once: true });
    root.addEventListener("pointercancel", onPointerCancel, { once: true });
  }

  function groupUnderPointer(event) {
    const hit = drag.groupBoxes.find(({ box }) => (
      event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
    ));
    return hit?.id || drag.groupId;
  }

  function onPointerMove(event) {
    if (!drag) return;
    drag.targetGroupId = drag.mode === "move" ? groupUnderPointer(event) : drag.groupId;
    const root = ctx.root();
    for (const grid of root?.querySelectorAll?.("[data-lp-grid]") || []) {
      grid.classList.toggle("is-drop-target", drag.targetGroupId !== drag.groupId && grid.dataset.lpGrid === drag.targetGroupId);
    }
    if (drag.targetGroupId !== drag.groupId) {
      // Over another group: leave the source layout as it was.
      drag.preview = null;
      drag.changed = null;
      ctx.applyLayout();
      return;
    }
    const cell = pointerToCell(event, drag.metrics.box, drag.columns, drag.metrics.rowHeight, drag.metrics.gap);
    const dx = cell.x - drag.start.x;
    const dy = cell.y - drag.start.y;
    const rect = drag.mode === "resize"
      ? { ...drag.startRect, w: Math.max(1, drag.startRect.w + dx), h: Math.max(1, drag.startRect.h + dy) }
      : { ...drag.startRect, x: Math.max(0, drag.startRect.x + dx), y: Math.max(0, drag.startRect.y + dy) };
    const changed = placeWithPushDown(drag.rects, drag.tileId, rect, drag.columns);
    drag.changed = changed;
    drag.preview = new Map([...drag.rects, ...changed]);
    ctx.applyLayout();
  }

  function finishDrag() {
    const root = ctx.root();
    root?.removeEventListener("pointermove", onPointerMove);
    root?.querySelector(".lp-tile.is-dragging")?.classList.remove("is-dragging");
    root?.querySelectorAll?.(".is-drop-target").forEach((grid) => grid.classList.remove("is-drop-target"));
    const finished = drag;
    drag = null;
    return finished;
  }

  function onPointerUp(event) {
    const finished = finishDrag();
    if (!finished) return;
    const page = activePage();
    const group = page?.groups.find((candidate) => candidate.id === finished.groupId);
    if (finished.targetGroupId !== finished.groupId && page) {
      const target = page.groups.find((candidate) => candidate.id === finished.targetGroupId);
      const grid = ctx.root()?.querySelector(`[data-lp-grid="${finished.targetGroupId}"]`);
      if (target && grid) {
        const metrics = gridMetrics(grid);
        const cell = pointerToCell(event, metrics.box, finished.columns, metrics.rowHeight, metrics.gap);
        const rect = { ...finished.startRect, x: Math.min(cell.x, finished.columns - finished.startRect.w), y: cell.y };
        // Move first, then place it in the new group, pushing that group's
        // tiles down so nothing overlaps.
        send({ op: "moveTile", tileId: finished.tileId, toPageId: page.id, toGroupId: target.id, index: target.tiles.length })
          .then((ok) => {
            if (!ok) return false;
            const moved = activePage()?.groups.find((candidate) => candidate.id === target.id);
            if (!moved) return false;
            const rects = groupRects(moved);
            const changed = placeWithPushDown(rects, finished.tileId, rect, finished.columns);
            return commitRects(moved, changed, new Map([...rects, ...changed]));
          });
        return;
      }
    }
    if (!group || !finished.changed?.size) {
      ctx.render();
      return;
    }
    commitRects(group, finished.changed, finished.preview);
  }

  function onPointerCancel() {
    finishDrag();
    ctx.render();
  }

  return {
    enter() {
      selection = null;
      previewBreakpoint = null;
    },
    exit() {
      flushText();
      selection = null;
      previewBreakpoint = null;
    },
    isBusy: () => Boolean(drag || keyPreview || pending > 0 || textTimers.size || panelHasFocus() || selection?.kind === "new-tile"),
    handleFocusOut(event) {
      const leaving = event.target?.closest?.(".lp-panel");
      const into = event.relatedTarget;
      if (leaving && renderDeferred && !into?.closest?.(".lp-panel")) {
        // Let a pending debounced save start first, then repaint.
        setTimeout(() => {
          if (!panelHasFocus() && renderDeferred) repaint();
        }, TEXT_DEBOUNCE_MS + 50);
      }
    },
    selectedTileId: () => (selection?.kind === "tile" ? selection.tileId : null),
    previewBreakpoint: () => previewBreakpoint,
    overrideRects,
    toolbar,
    pageChrome,
    groupChrome,
    tileChrome,
    panel,
    handleClick,
    handleInput,
    handleSubmit,
    handleKeyDown,
    handlePointerDown
  };
}
