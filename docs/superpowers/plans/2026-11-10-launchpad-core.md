# Launchpad Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Helmsman's auto-listed Launchpad with a manually curated, fully customizable launchpad whose single source of truth is `/data/launchpad.yaml`, kept in two-way live sync with a drag-drop editor.

**Architecture:** Pure server modules (schema, ops, theme) sit under an I/O store that owns the YAML file, its revision counter and a watcher. Thin control-plane routes expose the model and accept one small operation per edit. The browser gets a new `src/ui/launchpad.js` view/editor with its grid math in a pure, unit-tested `src/ui/launchpad-grid.js`.

**Tech Stack:** Node 24 ESM, `node:test`, vendored `yaml` 2.9.1 (server-only), vanilla JS UI under Trusted Types + strict CSP.

**Spec:** `docs/superpowers/specs/2026-11-10-launchpad-core-design.md`

## Global Constraints

- Node `>=24.19.0 <25`; no npm dependencies. The only new third-party code is `yaml` 2.9.1, vendored under `server/vendor/yaml/` with its ISC LICENSE.
- Every `/api/v2/launchpad*` route requires a session; every non-GET requires CSRF + origin and runs `recheckMutationSession` (existing pattern in `server/control-plane.mjs` `launchpadApi`).
- Every file write follows the existing hardened pattern: `O_NOFOLLOW` read, size cap, temp file `O_CREAT|O_EXCL`, fsync, chmod 0600, rename.
- URL rule everywhere (tile `url`, folder links): the existing `canonicalLaunchUrl` — http(s) only, no userinfo, no control chars, ≤ 500 chars. Search engine templates: https only, exactly one `{query}`.
- Limits: 20 pages, 50 groups, 500 tiles, 24 links per folder, note ≤ 4 KB, `theme.css` input ≤ 32 KB, file ≤ 512 KB, icon upload ≤ 512 KB, tile `h` ≤ 8.
- Grid columns: desktop 12, tablet 6, phone 2.
- Slug pattern for every `id`: `^[a-z0-9][a-z0-9-]{0,47}$`.
- `visibility` accepts only `owner`. The `widget` key on a tile is reserved and rejected.
- `style-src 'self'` is not loosened; all custom styling comes from the generated same-origin `theme.css`. `frame-src` is built only from origins of valid `iframe` tiles, `'none'` when there are none.
- All DOM writes go through the existing `helmsman-render` Trusted Types policy (`setMarkup` in `src/app-v5.js`).
- Release version: `1.19.0`.

## Review Focus

- An editor that saves by writing a temp file and renaming it (vim, VS Code, `sed -i`) replaces the inode → the change must still be picked up. Test in Task 4.
- Two browser tabs editing at once → the later save gets 409 and reloads; neither edit is silently lost. Test in Task 4.
- The owner empties or deletes `launchpad.yaml` while Helmsman runs → treated as an empty valid launchpad, not an error banner. Test in Task 4.
- A linked Portainer container is recreated by an image update (new 64-hex ID, same name) → the tile still resolves and still offers actions. Test in Task 9.
- A hand-written YAML with anchors/aliases (including an alias bomb) → rejected with a line-numbered error, never expanded. Test in Task 2.

---

### Task 1: Vendor `yaml` 2.9.1

**Files:**
- Create: `server/vendor/yaml/` (contents of the package's `browser/dist/` ESM build), `server/vendor/yaml/LICENSE`, `server/vendor/yaml/VERSION` (text `2.9.1`)
- Create: `server/yaml.mjs`
- Modify: `scripts/container-contract.mjs` (required-file list), `scripts/public-release-contract.mjs` if it scans for third-party code without a license
- Test: `tests/yaml-vendor.test.mjs`

**Interfaces:**
- Produces: `server/yaml.mjs` exports `parseLaunchpadYaml(text: string) → yaml.Document` (calls `parseDocument(text, { prettyErrors: true, uniqueKeys: true, maxAliasCount: 0, version: "1.2" })`), `stringifyDocument(doc) → string`, and re-exports `isMap`, `isSeq`, `isScalar`, `isAlias`, `YAMLMap`, `YAMLSeq`. No other module imports from `server/vendor/` directly.

- [ ] **Step 1:** `npm pack yaml@2.9.1` into a scratch dir outside the repo, verify the tarball's `package.json` version, then copy `package/browser/dist/**` and `package/LICENSE` into `server/vendor/yaml/`.
- [ ] **Step 2: Write the failing test** `tests/yaml-vendor.test.mjs`:
  - `"round-trips comments"`: parse `"# top\na: 1 # one\nb: [x, y]\n"`, `doc.setIn(["a"], 2)`, assert `stringifyDocument(doc) === "# top\na: 2 # one\nb: [ x, y ]\n"` (adjust only the flow-seq spacing to what the library emits, keep both comments).
  - `"reports line numbers"`: `parseLaunchpadYaml("a: [\n").errors[0].linePos[0].line === 1` or 2 — assert it is a positive integer.
  - `"rejects duplicate keys"`: `parseLaunchpadYaml("a: 1\na: 2\n").errors.length > 0`.
- [ ] **Step 3:** Run `node --test tests/yaml-vendor.test.mjs` → FAIL (module missing).
- [ ] **Step 4:** Implement `server/yaml.mjs`.
- [ ] **Step 5:** Run the test → PASS. Run `node scripts/container-contract.mjs` → PASS (add `server/yaml.mjs` and `server/vendor/yaml/LICENSE` to its required list).
- [ ] **Step 6:** Add `tests/yaml-vendor.test.mjs` to `check:security` in `package.json`; commit `feat(launchpad): vendor yaml 2.9.1 for server-side YAML`.

---

### Task 2: Schema — `server/launchpad-schema.mjs`

**Files:**
- Create: `server/launchpad-schema.mjs`
- Test: `tests/launchpad-schema.test.mjs`

**Interfaces:**
- Consumes: `parseLaunchpadYaml`, `isAlias` from `server/yaml.mjs`.
- Produces:
  - `canonicalLaunchUrl(value) → string | null` and `launchpadKey(kind, id) → string | null` — moved verbatim from `server/launchpad.mjs`.
  - `LAUNCHPAD_LIMITS` frozen object with the Global Constraints numbers, plus `COLUMNS = { desktop: 12, tablet: 6, phone: 2 }`.
  - `validateLaunchpad(doc: yaml.Document) → { model: LaunchpadModel | null, errors: Array<{ message: string, path: string, line: number, column: number }> }`. `model` is null whenever `errors` is non-empty.
  - `emptyLaunchpadModel() → LaunchpadModel` = `{ version: 2, theme: { tokens: {}, css: "" }, pages: [] }`.
  - `LaunchpadModel`: plain frozen JSON — `{ version, theme: { tokens, css }, pages: [{ id, title, icon, visibility, groups: [{ id, title, collapsed, tiles: [Tile] }] }] }`; `Tile` = `{ id, type, title, icon, style, visibility, layout: { desktop, tablet?, phone? }, ...typeFields }` with defaults filled (`open: "newTab"`, `collapsed: false`, `visibility: "owner"`, `style: { background: "glass", hideLabel: false }`).
  - `managed` normalized shapes exactly as spec §2 (amended): `media|environment|service` → `{ kind, id }`; `container` → `{ kind, service, environment, name }`; `workload` → `{ kind, environment, vmid }`.

- [ ] **Step 1: Write the failing tests** (one `test()` each):
  - `"spec example validates"`: the full YAML block from spec §2 → `errors` empty, `model.pages[0].groups[0].tiles.length === 5`, Jellyfin tile `layout.phone` present, Grafana tile has no `tablet`/`phone`.
  - `"empty document is an empty launchpad"`: `""` and `"version: 2\n"` both → `model` deep-equals `emptyLaunchpadModel()`.
  - `"unknown key has path and line"`: tile with `colour: red` on line 9 → one error, `path === "pages[0].groups[0].tiles[0].colour"`, `line === 9`.
  - `"aliases rejected"`: `"a: &x 1\nb: *x\n"` → error message contains `"anchors and aliases are not supported"`; alias-bomb fixture (9 levels of `[*a,*a,...]`) → errors, returns in < 100 ms.
  - `"url rules"`: each value from the existing rejection list in `tests/launchpad.test.mjs` as a tile `url` → an error at that path; folder link `url` likewise.
  - `"search engine"`: `tiles` ok; `https://x/?q={query}` ok; `http://x/?q={query}`, `https://x/?q=`, `https://x/{query}{query}` → errors.
  - `"ids"`: duplicate tile id across groups → error; `"Bad_ID"` → error.
  - `"layout"`: missing `desktop` → error; `w: 13` on desktop → error; `w: 3` on phone → error; `h: 9` → error.
  - `"limits"`: 21 pages → error; folder with 25 links → error; 4097-byte note → error.
  - `"managed"`: each of the five kinds validates; `container` with non-UUID `service` → error; `workload` with `vmid: -1` → error; `managed` on an `iframe` tile → error.
  - `"reserved"`: `visibility: viewers` → error; tile with `widget: {}` → error containing `"reserved"`.
  - `"theme"`: `radius: 33` → error; `density: huge` → error; css > 32 KB → error.
- [ ] **Step 2:** `node --test tests/launchpad-schema.test.mjs` → FAIL.
- [ ] **Step 3:** Implement. Walk the Document's node tree (not `doc.toJS()`) so each error carries `node.range[0]` → `doc`'s `LineCounter` line/column; any `isAlias` node or node with `anchor` → error. Validation is a table of per-key validators per object kind so unknown keys fall out naturally.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Add to `check:security`; commit `feat(launchpad): YAML schema and validation`.

---

### Task 3: Operations — `server/launchpad-ops.mjs`

**Files:**
- Create: `server/launchpad-ops.mjs`
- Test: `tests/launchpad-ops.test.mjs`

**Interfaces:**
- Consumes: `validateLaunchpad`, `COLUMNS` (Task 2); `YAMLMap`, `YAMLSeq`, `isMap`, `isSeq` (Task 1).
- Produces:
  - `applyLaunchpadOp(doc: yaml.Document, op: Op) → void` — mutates `doc` in place; throws `LaunchpadOpError { code: "INVALID_OP" | "NOT_FOUND" | "LIMIT", message }`. Does **not** validate the whole document (the store does).
  - `Op` union, each with exact keys (extra keys → `INVALID_OP`):
    `{ op: "addPage", page }`, `{ op: "updatePage", pageId, patch }`, `{ op: "movePage", pageId, index }`, `{ op: "removePage", pageId }`,
    `{ op: "addGroup", pageId, group }`, `{ op: "updateGroup", pageId, groupId, patch }`, `{ op: "moveGroup", pageId, groupId, index }`, `{ op: "removeGroup", pageId, groupId }`,
    `{ op: "addTile", pageId, groupId, tile }`, `{ op: "updateTile", tileId, patch }`, `{ op: "moveTile", tileId, toPageId, toGroupId, index }`, `{ op: "setLayout", tileId, breakpoint, rect: { x, y, w, h } }`, `{ op: "setLayouts", breakpoint, rects: { [tileId]: rect } }` (one save for a drag that pushes neighbors), `{ op: "resetBreakpoint", pageId, breakpoint }` (removes `tablet`/`phone` from every tile on the page), `{ op: "removeTile", tileId }`, `{ op: "updateTheme", patch }`.
  - `patch` semantics: keys present are set; a key set to `null` is deleted; `id`, `type` and `layout` cannot be patched (`INVALID_OP`).

- [ ] **Step 1: Write the failing tests:**
  - `"comments survive every op"`: fixture with a comment above each page/group/tile and trailing comments; for each op type apply one representative op, stringify, and assert every original comment line that belongs to an unremoved node is still present.
  - `"updateTile patch"`: `{ title: "X", icon: null }` sets title, deletes icon; `{ id: "y" }` throws `INVALID_OP`.
  - `"moveTile across groups keeps the tile's comment"`.
  - `"setLayouts writes several rects in one op"`.
  - `"resetBreakpoint removes phone only"` — desktop untouched, phone keys gone, tablet kept.
  - `"unknown ids"` → `NOT_FOUND`; `"extra op keys"` → `INVALID_OP`.
  - `"addTile beyond 500"` → `LIMIT`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (locate nodes by walking `doc.contents`; never rebuild the document from JS). **Step 4:** Run → PASS.
- [ ] **Step 5:** Add to `check:security`; commit `feat(launchpad): comment-preserving edit operations`.

---

### Task 4: Store — `server/launchpad-store.mjs`

**Files:**
- Create: `server/launchpad-store.mjs`
- Test: `tests/launchpad-store.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `createLaunchpadDocumentStore({ dataDir, guard?, clock?, pollMs = 2000, debounceMs = 300 }) → Promise<Store>` where:
  - `store.snapshot() → { revision: number, model: LaunchpadModel, error: null | { message, line, column } }` — `model` is the last good model; `error` is set while the file on disk is invalid.
  - `store.apply(revision: number, op: Op) → Promise<{ revision, model }>`; throws `LaunchpadStoreError` with `code` `"LAUNCHPAD_CHANGED"` (stale revision), `"LAUNCHPAD_INVALID"` (file currently invalid), `"INVALID_OP" | "NOT_FOUND" | "LIMIT"` (from ops), `"LAUNCHPAD_SCHEMA"` (op produced an invalid document; nothing written; `errors` attached).
  - `store.onChange(listener: (snapshot) => void) → unsubscribe`.
  - `store.reloadNow() → Promise<void>` (tests and post-migration use).
  - `store.close() → Promise<void>`.
  - File name `launchpad.yaml`, size cap 512 KB. Writes are serialized through one promise chain (same pattern as today's `persist()`).

- [ ] **Step 1: Write the failing tests** (use a temp dir and `pollMs: 50, debounceMs: 10`):
  - `"missing file is an empty launchpad at revision 0"`.
  - `"apply writes the file atomically, mode 0600, and bumps revision"`.
  - `"stale revision is LAUNCHPAD_CHANGED and writes nothing"`.
  - `"two tabs: second save with the old revision gets LAUNCHPAD_CHANGED"` (Review Focus).
  - `"hand edit via writeFile is picked up"` → revision increments, `onChange` fires once.
  - `"hand edit via write-temp-then-rename is picked up"` (Review Focus).
  - `"invalid hand edit keeps last good model and sets error with line"`; `apply` then throws `LAUNCHPAD_INVALID`; fixing the file clears `error`.
  - `"emptied file and deleted file both become an empty launchpad without error"` (Review Focus).
  - `"own writes do not fire a second change"` — after `apply`, wait 3× poll; `onChange` count stays 1.
  - `"symlinked launchpad.yaml is refused"` → `error` set, nothing followed.
  - `"oversized file is refused"` → `error` set.
  - `"op that breaks the schema is LAUNCHPAD_SCHEMA and nothing is written"`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Watch the **directory** with `fs.watch` filtered to `launchpad.yaml` (survives rename-replace) plus a `stat` poll comparing `mtimeMs`/`size`/`ino`; on change, debounce, read, hash (sha256); if the hash equals the last self-written hash, ignore. Keep the parsed `yaml.Document` of the current good file in memory; `apply` clones it via `doc.clone()`, applies the op, validates, writes, then swaps.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Add to `check:security`; commit `feat(launchpad): YAML store with revisions and live reload`.

---

### Task 5: Migration — `server/launchpad-migrate.mjs`

**Files:**
- Create: `server/launchpad-migrate.mjs`
- Test: `tests/launchpad-migrate.test.mjs`

**Interfaces:**
- Consumes: `canonicalLaunchUrl`, `launchpadKey` (Task 2); `stringifyDocument` (Task 1).
- Produces: `migrateLegacyLaunchpad({ dataDir, connected: Array<{ kind, id, name, url }> }) → Promise<"migrated" | "skipped">`. `connected` is the list the v1.18.3 page shows, in its order (media services in `SERVICE_ORDER`, then enabled Proxmox environments, then enabled Portainer services) — the broker builds it from state (Task 8).
  - Skips when `launchpad.yaml` exists **or** `launchpad.json.migrated` exists.
  - Output: page `home` "Home"; group `media` "Media" (kind `media`), group `infrastructure` "Infrastructure" (others); one `link` tile per entry: `id` = slug of name (deduplicated with `-2`, `-3`), `url` = saved external address from `launchpad.json` else entry `url`, `managed: { kind, id }`, desktop layout 2×1 placed left-to-right, 6 per row. Entries with neither a valid saved nor a valid connection URL are skipped.
  - Writes atomically, then renames `launchpad.json` → `launchpad.json.migrated` if it exists.

- [ ] **Step 1: Write the failing tests:** fixture `launchpad.json` (sonarr external address) + 3 connected entries → YAML validates with `validateLaunchpad`, Sonarr tile uses the external URL, others the connection URL; `launchpad.json.migrated` exists; second call returns `"skipped"` and leaves the file byte-identical; with existing `launchpad.yaml` returns `"skipped"`; duplicate names → `-2` suffix.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Add to `check:security`; commit `feat(launchpad): one-time import of the v1.18 Launchpad`.

---

### Task 6: Theme stylesheet — `server/launchpad-theme.mjs`

**Files:**
- Create: `server/launchpad-theme.mjs`
- Test: `tests/launchpad-theme.test.mjs`

**Interfaces:**
- Consumes: `LaunchpadModel` (Task 2).
- Produces: `buildLaunchpadCss(model) → string` and `sanitizeCustomCss(css: string) → string`.
  - Tokens → `.lp-root { --lp-accent: …; --lp-radius: …px; }` plus `.lp-root[data-density="…"]` is set by the UI, not here.
  - Each tile with `style.accent` → `.lp-tile[data-id="<id>"] { --lp-tile-accent: <color>; }` (ids are slugs, colors are validated hex, so no escaping beyond that).
  - Custom CSS appended last, after `sanitizeCustomCss`: removes `@import` rules, any `url(...)` whose argument is not `data:` or a same-origin relative path, `expression(`, and `</`; wraps nothing else.

- [ ] **Step 1: Write the failing tests:** accent output for a tile; tokens output; `@import url(https://x)` removed; `background:url(https://evil/x.png)` removed; `url(/api/v2/launchpad/icons/x)` kept; `url(data:image/png;base64,AA==)` kept; `</style>` neutralized; output for the spec example snapshot-matches an inline expected string.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Add to `check:security`; commit `feat(launchpad): generated theme stylesheet`.

---

### Task 7: Icons — `server/launchpad-icons.mjs`

**Files:**
- Create: `server/launchpad-icons.mjs`
- Test: `tests/launchpad-icons.test.mjs`

**Interfaces:**
- Produces: `createLaunchpadIconStore({ dataDir, fetchImpl = fetch, guard?, timeoutMs = 8000 }) → Promise<IconStore>`:
  - `get(ref: string) → Promise<{ bytes: Buffer, contentType: string } | null>` for `ref` = `dashboard-icons:<slug>`, `mdi:<slug>` or `upload:<name>`.
  - `saveUpload(bytes: Buffer) → Promise<string /* "upload:<sha256-16>.<ext>" */>`; throws `{ code: "ICON_TOO_LARGE" | "ICON_TYPE" }`.
  - Constants: `DASHBOARD_ICONS_BASE = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons"`; fetch `${BASE}/svg/<slug>.svg`, falling back to `${BASE}/png/<slug>.png`. `mdi:<slug>` fetches `https://cdn.jsdelivr.net/npm/@mdi/svg@7.4.47/svg/<slug>.svg` (same host, pinned version). Slug `^[a-z0-9][a-z0-9-]{0,63}$`. Max 512 KB. Cache in `/data/icons/dashboard-icons/`, uploads in `/data/icons/uploads/`. Type by magic bytes (PNG, JPEG, WebP; SVG = text starting with `<svg` or `<?xml` after whitespace).
  - A failed fetch is cached as a miss for 1 hour so a broken tile doesn't hammer the CDN.

- [ ] **Step 1: Write the failing tests** with a fake `fetchImpl`: fetches only the fixed host (assert requested URL for both a dashboard-icons and an `mdi:` ref); second `get` served from disk (fetch count 1); `dashboard-icons:../x` → null without fetching; oversize response → null; HTML response → null; svg 404 → png fallback; miss cached; upload PNG ok; upload 600 KB → `ICON_TOO_LARGE`; upload `.exe` bytes → `ICON_TYPE`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Add to `check:security`; commit `feat(launchpad): icon fetch cache and uploads`.

---

### Task 8: Routes, wiring, CSP; remove the v1 store

**Files:**
- Modify: `server/control-plane.mjs` (replace `launchpadApi`, `currentLaunchpadLinks`, `launchpadTargetExists`, the `launchpadMatch` routing near line 5554, the `launchpadStore` option near line 1162)
- Modify: `server/broker.mjs` (store creation near line 1628; migration call; `SHELL_CSP` at line 112 / header at line 1561 becomes `shellCsp(frameOrigins)`)
- Delete: `server/launchpad.mjs`
- Modify: `sw.js` only if it caches `/api/v2/launchpad` (it currently does not — confirm and leave)
- Test: rewrite `tests/launchpad.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces (HTTP, JSON unless noted; errors use the existing `{ code, message }` shape):
  - `GET /api/v2/launchpad` → `{ revision, model, error }`.
  - `GET /api/v2/launchpad/revision` → `{ revision, error }`.
  - `POST /api/v2/launchpad/ops` body `{ revision, op }` (exact keys; body cap = existing `MAX_JSON_BODY_BYTES`) → `200 { revision, model }`; `409 LAUNCHPAD_CHANGED`; `423 LAUNCHPAD_INVALID`; `400 INVALID_OP | LAUNCHPAD_SCHEMA` (with `errors`); `404 NOT_FOUND`; `409 LAUNCHPAD_LIMIT`.
  - `GET /api/v2/launchpad/theme.css` → `text/css; charset=utf-8`, `ETag: "<revision>"`, honors `If-None-Match` → 304.
  - `GET /api/v2/launchpad/icons/<ref>` (`ref` URL-encoded) → image bytes, `Cache-Control: private, max-age=86400`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`; 404 when null.
  - `POST /api/v2/launchpad/icons` raw body (`Content-Type` ignored; magic bytes decide), cap 512 KB → `201 { ref }`.
  - `shellCsp(frameOrigins: string[]) → string` in `server/broker.mjs`: `SHELL_CSP` + `; frame-src <origins joined by space>` or `; frame-src 'none'`. Origins come from `model` iframe tiles via `new URL(url).origin`, deduplicated.
  - Startup order in broker: build `connected` from state (same filters as `launchpadEntries()` in `src/app-v5.js`), `await migrateLegacyLaunchpad(...)`, then `createLaunchpadDocumentStore(...)`. Failure to create the store logs and the routes return `503 LAUNCHPAD_UNAVAILABLE` (existing pattern).

- [ ] **Step 1: Write the failing tests** in `tests/launchpad.test.mjs` (keep the existing `request`/`start`/`claim` helpers; `start()` now passes the new store and icon store):
  - `"anonymous gets 401 on every route"`.
  - `"ops need CSRF and origin"` → 403 without.
  - `"GET returns empty model at revision 0"`; `"addPage then GET shows it at revision 1"`.
  - `"stale revision → 409 LAUNCHPAD_CHANGED"`; `"invalid file on disk → GET has error, ops → 423"`.
  - `"theme.css has the tile accent and 304s on matching ETag"`.
  - `"shell CSP frame-src lists only configured iframe origins"`; with none → `frame-src 'none'`.
  - `"icon route sets sandbox CSP and nosniff"`; `"bad icon ref → 404"`.
  - `"upload over 512 KB → 413"`.
  - Keep the `canonicalLaunchUrl` / `launchpadKey` unit test, importing from `server/launchpad-schema.mjs`.
- [ ] **Step 2:** Run `node --test tests/launchpad.test.mjs` → FAIL.
- [ ] **Step 3:** Implement routes, wiring, CSP; delete `server/launchpad.mjs`; update imports.
- [ ] **Step 4:** Run `npm run check:security` → PASS (all prior tests too). Run `npm run check:container` → PASS.
- [ ] **Step 5:** Commit `feat(launchpad): v2 API, migration on startup, iframe-aware CSP`.

---

### Task 9: UI view mode

**Files:**
- Create: `src/ui/launchpad.js`, `src/ui/launchpad.css`, `src/ui/launchpad-managed.js`
- Modify: `src/app-v5.js` — remove `LAUNCHPAD_KINDS`, `safeLaunchHref`, `launchHostLabel`, `savedLaunchAddress`, `launchpadEntries`, `renderLaunchpadTile`, `renderLaunchpadGroup`, `renderLaunchpadPage`, `applyLaunchpadFilter`, `loadLaunchpadLinks` and the `edit-launch-address` action; route `launchpad` to the new module.
- Modify: `index.html` (add `<link rel="stylesheet" href="./src/ui/launchpad.css" />` and `<link rel="stylesheet" href="/api/v2/launchpad/theme.css" />`), `Dockerfile` line 34 (add the three new files), `scripts/container-contract.mjs`, `scripts/operations-view-contract.mjs`
- Test: `tests/launchpad-managed.test.mjs`

**Interfaces:**
- Consumes: routes from Task 8; from `src/app-v5.js` the existing `setMarkup`, `escapeHtml`, `icon`, `serviceIconMarkup`, `statusClass`, `statusLabel`, the operations snapshot accessors used by the old `launchpadEntries()`, and the existing confirm-and-run helpers behind `/api/v2/actions/portainer/container` (≈ line 11545) and `/api/v2/actions/proxmox/workload` (≈ line 11610); `renderManualInline` / sanitizer from `src/ui/manual-markdown.js` for notes. Pass these in rather than importing `app-v5.js` (avoid a cycle).
- Produces:
  - `src/ui/launchpad-managed.js` (pure): `resolveManaged(managed, snapshot) → { found: boolean, state: string, actions: Array<"start"|"restart"|"stop"|"reboot"|"shutdown">, actionTarget: object | null, label: string }`. `container` matches by `service` + `environment` + `name` and yields `actionTarget` with the **current** `containerId` and the service's `targetRevision`; `workload` matches by `environment` + `vmid` and yields the current `node`/`type`. Action availability mirrors the server rules (start only when `created|exited`; restart/stop only when `running`; Proxmox start when stopped, reboot/shutdown when running; templates have none).
  - `src/ui/launchpad.js`: `createLaunchpadController(deps) → { render(main: HTMLElement): void, unmount(): void }`. Polls `/api/v2/launchpad/revision` every 5000 ms while `document.visibilityState === "visible"` and the route is active; on change refetches the model and re-renders; also reloads `theme.css` by swapping the `<link>` `href` with `?r=<revision>`.
  - DOM contract: root `.lp-root[data-density]`; page tabs; `.lp-group` (collapsible); `.lp-grid` (CSS Grid, `--lp-cols` 12/6/2 by container-width breakpoint ≥ 1100 / ≥ 640 / else); `.lp-tile[data-id][data-type]` placed with `grid-column`/`grid-row` set via CSSOM (`element.style.gridColumn = …`), never `style=""` markup. Auto-reflow when a breakpoint has no override: tiles in desktop reading order (y, then x), widths clamped to column count.
  - Icons: `dashboard-icons:`/`mdi:`/`upload:` → `<img src="/api/v2/launchpad/icons/<encoded ref>">` with letter-badge fallback on `error`; `emoji:` → text; none → `serviceIconMarkup` for linked tiles else letter badge. Tile behavior per type: `link` (anchor, `rel="noopener noreferrer"`, `target` from `open`); `folder` (button → popover list); `note` (sanitized Markdown); `search` (`tiles` filters tiles live like today's search; engine → `window.open(template.replace("{query}", encodeURIComponent(q)), "_blank", "noopener")`); `iframe` (`<iframe sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer" loading="lazy">` with a load timeout of 8 s → "This site refuses to be embedded" + open-in-new-tab link).
  - Linked tiles: health dot from `resolveManaged`; ⋯ menu listing `actions`, each going through the existing confirmation dialog and action helper with `actionTarget`. Not found → "linked service not found" note, tile still opens its URL.
  - Invalid-file banner when `error` is set: message + "line N".
  - Empty state (no pages): "Your launchpad is empty" + "Edit layout" button.

- [ ] **Step 1: Write the failing tests** `tests/launchpad-managed.test.mjs`:
  - `"container resolves by name after recreate"` (Review Focus): snapshot with container `{ id: "a"*64, name: "sonarr", state: "running" }` → resolves; replace with `{ id: "b"*64, name: "sonarr" }` → resolves, `actionTarget.containerId === "b"*64`, `actions` = `["restart","stop"]`.
  - `"exited container offers start only"`; `"workload follows node migration"`; `"template workload has no actions"`; `"connection kinds have no actions"`; `"missing target → found false"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `launchpad-managed.js`, then `launchpad.js`/`.css` and the `app-v5.js` removals. **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Run `npm run check` → PASS (update `operations-view-contract.mjs` / `container-contract.mjs` expectations for the new files and removed functions).
- [ ] **Step 6:** Manual: `npm run demo`, open Launchpad: migrated tiles appear; hand-edit the demo's `launchpad.yaml` title → page updates within ~5 s; break the YAML → banner with line, last layout still shown.
- [ ] **Step 7:** Commit `feat(launchpad): v2 view mode with linked-tile health and actions`.

---

### Task 10: UI edit mode

**Files:**
- Create: `src/ui/launchpad-grid.js`, `src/ui/launchpad-editor.js`
- Modify: `src/ui/launchpad.js`, `src/ui/launchpad.css`, `index.html` (no change if loaded as modules from `launchpad.js`), `Dockerfile` line 34, `scripts/container-contract.mjs`
- Test: `tests/launchpad-grid.test.mjs`

**Interfaces:**
- Consumes: `POST /api/v2/launchpad/ops` and `POST /api/v2/launchpad/icons` (Task 8); `Op` shapes (Task 3); controller from Task 9.
- Produces:
  - `src/ui/launchpad-grid.js` (pure, importable by Node tests):
    - `reflow(tiles: Array<{ id, layout }>, breakpoint: "tablet"|"phone") → Map<id, rect>` — desktop reading order, width clamped to `COLUMNS[breakpoint]`, first-fit packing.
    - `effectiveRects(tiles, breakpoint) → Map<id, rect>` — the breakpoint's own rects if **any** tile in the group has one, else `reflow`.
    - `placeWithPushDown(rects: Map<id, rect>, movedId, rect, columns) → Map<id, rect>` — clamp to columns, then push colliding tiles down repeatedly until no overlaps; returns only rects that changed (including the moved one).
    - `pointerToCell({ clientX, clientY }, gridBox: DOMRect, columns, rowHeight, gap) → { x, y }`.
  - `src/ui/launchpad-editor.js`: `createLaunchpadEditor({ controller, sendOp, uploadIcon, connectedTargets }) → { enter(), exit() }`:
    - "Edit layout" toggle in the page header; disabled with tooltip while `error` is set.
    - Drag by `.lp-tile__handle`, resize by `.lp-tile__resize` using Pointer Events + `setPointerCapture`; live preview with `placeWithPushDown`; on drop send one `setLayouts` op with the changed rects; drop on another group sends `moveTile` then `setLayout`.
    - Keyboard: focused tile + arrows move one cell, Shift+arrows resize, Enter opens the panel, Delete asks then sends `removeTile`.
    - Side panel: fields per tile type; `managed` select built from `connectedTargets` (connections, Portainer containers by name, Proxmox guests by vmid) — sends `updateTile` on change (debounced 400 ms for text inputs).
    - Breakpoint switcher (Desktop / Tablet / Phone): editing tablet/phone with no override shows "This breakpoint follows desktop. Customize?" → first save sends `setLayouts` for every tile in the group with the current `reflow` rects; "Reset to auto" sends `resetBreakpoint`.
    - Page and group bars: add / rename / reorder / remove / collapse (`addPage`, `updatePage`, `movePage`, …).
    - Theme panel: accent, radius, density, custom CSS `<textarea>` → `updateTheme`; preview by reloading `theme.css` after the save.
    - Optimistic update; on error roll back and toast the server `message`; on `409` toast "launchpad.yaml was edited outside the UI — reloaded." and refetch.

- [ ] **Step 1: Write the failing tests** `tests/launchpad-grid.test.mjs`:
  - `"reflow to phone stacks in desktop reading order"`: three 4×1 desktop tiles in one row → phone rects `(0,0,2,1)`, `(0,1,2,1)`, `(0,2,2,1)`.
  - `"effectiveRects prefers overrides"`.
  - `"push-down resolves chained collisions"`: drop a 2×2 onto a column of three 2×1 tiles → no overlaps; only moved tiles returned.
  - `"clamp keeps rects inside columns"`: `x: 11, w: 3` on desktop → `x: 9`.
  - `"pointerToCell"` with a known box/gap → exact cell.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `launchpad-grid.js`, then the editor. **Step 4:** Run → PASS; `npm run check` → PASS.
- [ ] **Step 5:** Manual in the demo: drag, resize, cross-group move, phone customize + reset, theme CSS, keyboard move; after each, `launchpad.yaml` keeps its hand-written comments.
- [ ] **Step 6:** Commit `feat(launchpad): drag-drop editor with breakpoints and theming`.

---

### Task 11: Demo, docs, release

**Files:**
- Modify: `scripts/demo.mjs` (seed a demo `launchpad.yaml` showing every tile type, one linked container, one iframe), `tests/demo.test.mjs` (assert the demo launchpad validates)
- Create: `docs/LAUNCHPAD-FORMAT.md` (schema reference = spec §2 rules, written for users, with the spec example)
- Modify: `README.md` (Launchpad section → link to the format doc), `package.json` version `1.19.0`, `SECURITY.md` (one paragraph: icon fetch host, iframe `frame-src`, custom CSS sanitizing)

- [ ] **Step 1:** Add the demo assertion to `tests/demo.test.mjs`; run → FAIL. **Step 2:** Seed the demo file; run → PASS.
- [ ] **Step 3:** Write the docs and bump the version.
- [ ] **Step 4:** `npm run check` → PASS; `npm run check:visual` → PASS (or update its snapshots for the Launchpad page only, and say so in the commit).
- [ ] **Step 5:** Commit `docs(launchpad): format reference, demo launchpad, v1.19.0`.
