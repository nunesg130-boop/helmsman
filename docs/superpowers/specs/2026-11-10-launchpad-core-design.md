# Launchpad Core — Design

Date: 2026-11-10
Status: Approved in brainstorming; awaiting written-spec review
Scope: Sub-project 1 of 3 (Launchpad core). Sub-project 2 (widget engine) and sub-project 3 (viewer accounts + pluggable auth) get their own specs.

## 1. Goal

Rebuild Helmsman's existing Launchpad (v1.18.3: auto-listed connected services with an optional external address) into an ultra-customizable launchpad where any service — managed by Helmsman or not — can be added, arranged and styled, and where the whole configuration lives in a hand-editable `launchpad.yaml` kept in two-way live sync with the UI.

### Success criteria

- The owner can rebuild today's Launchpad, plus services Helmsman does not manage, entirely in the UI **or** entirely in YAML; each side reflects the other within a few seconds.
- Nothing that works today is lost on upgrade (one-time import).
- Hand-written YAML comments and ordering survive UI saves.
- An invalid hand edit never blanks the launchpad.

### Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Tile population | Manual only. No auto-discovery after the one-time import. |
| Managed services | A tile may link to a managed media service / Proxmox environment / Portainer service; linked tiles show managed health and offer start/stop/restart via the existing confirm + fresh-evidence flow. |
| Customization | Drag-drop + resize grid; pages and collapsible groups; per-tile styling; owner custom CSS and theme tokens. |
| Tile types | `link`, `folder` (bookmark list), `note` (Markdown), `search`, `iframe`. No custom HTML. |
| Config | `/data/launchpad.yaml` is the single source of truth, two-way live sync with the UI. |
| YAML library | Vendor the `yaml` package (ISC) in `server/vendor/yaml` (server-only), pinned, using its Document API to preserve comments. |
| Responsive | Desktop layout required; tablet/phone auto-reflow until the owner customizes them. |
| Conflicts | Hand edit wins; a stale UI save gets 409 and reloads. |
| Icons | dashboard-icons fetched from one fixed host and cached; uploads; emoji; mdi; existing built-in service icons. |
| Unmanaged status | Out of scope here — belongs to the widget engine (sub-project 2). |
| Visibility | `visibility` field on pages and tiles, always `owner` until sub-project 3. |
| Approach | A: hand-built CSS Grid + pointer-event editor, YAML as single truth. |

### Out of scope

Widget data fetching, unmanaged health pings, credentials in config, viewer accounts, non-owner visibility, auto-discovery.

## 2. Data model — `launchpad.yaml`

```yaml
version: 2
theme:
  tokens: { accent: "#7c5cff", radius: 14, density: comfortable }
  css: |
    .lp-tile[data-id="jellyfin"] { backdrop-filter: blur(20px); }
pages:
  - id: home
    title: Home
    icon: mdi:home
    visibility: owner
    groups:
      - id: media
        title: Media
        collapsed: false
        tiles:
          - id: jellyfin
            type: link
            title: Jellyfin
            url: https://jellyfin.example.com
            icon: dashboard-icons:jellyfin
            style: { accent: "#00a4dc", background: glass, hideLabel: false }
            open: newTab
            managed: { kind: media, id: jellyfin }
            visibility: owner
            layout:
              desktop: { x: 0, y: 0, w: 2, h: 1 }
              phone:   { x: 0, y: 0, w: 2, h: 1 }
          - id: router
            type: folder
            title: Network
            links:
              - { title: ER605, url: http://192.168.0.1 }
          - id: todo
            type: note
            markdown: "**Swap UPS battery** before December"
          - id: web
            type: search
            engine: "https://duckduckgo.com/?q={query}"   # or the literal `tiles`
          - id: grafana-embed
            type: iframe
            url: http://192.168.0.213:3000/d/abc
            layout: { desktop: { x: 0, y: 1, w: 6, h: 4 } }
```

### Rules

- Hierarchy: pages → groups → tiles. Layout is per tile, relative to its group's grid.
- `id`: slug `^[a-z0-9][a-z0-9-]{0,47}$`, unique within its scope (pages globally, groups within page, tiles globally). Generated from the title by the UI when absent; required in the file.
- `layout.desktop` is required. `tablet` / `phone` present ⇒ customized; absent ⇒ auto-reflow from desktop order. Grid columns: desktop 12, tablet 6, phone 2. `w`/`h` are positive integers bounded by column count and a max height of 8.
- `type`-specific fields:
  - `link`: `url` (required), `open` (`newTab` | `sameTab`, default `newTab`), optional `managed`.
  - `folder`: `links[]` of `{ title, url }`, max 24.
  - `note`: `markdown`, max 4 KB, rendered with the Manual's existing sanitized Markdown renderer.
  - `search`: `engine` is either the literal `tiles` or an https URL template containing exactly one `{query}`.
  - `iframe`: `url` (required). Optional `managed` not allowed.
- `managed` (amended 2026-11-10 during planning — actions exist only for containers and guests, not connections):
  - `{ kind: media, id }` / `{ kind: environment, id }` / `{ kind: service, id }` — a connection (existing `launchpadKey` rules). Health only; no actions.
  - `{ kind: container, service: <portainer uuid>, environment: <int>, name: <container name> }` — matched by container **name** in the current Portainer inventory (IDs change on recreate). Actions: start / restart / stop.
  - `{ kind: workload, environment: <proxmox uuid>, vmid: <int> }` — node resolved from the current inventory (survives migration). Actions: start / reboot / shutdown.
  - If the target no longer exists, the tile stays and renders as a plain link with a "linked service not found" note.
  - Health and action targets are resolved in the browser from the operations snapshot it already loads; actions call the existing action routes, which re-verify everything server-side.
- URLs (`url`, folder links, search engine): today's `canonicalLaunchUrl` rules — http(s) only, no userinfo, no control characters, ≤ 500 chars.
- `icon`: `dashboard-icons:<slug>`, `upload:<filename>`, `emoji:<single emoji>`, `mdi:<slug>`, or absent (built-in service icon for linked tiles, else first-letter badge).
- `style`: `accent` / any color as `#rgb` or `#rrggbb`; `background` ∈ `glass | solid | none`; `hideLabel` boolean.
- `theme.tokens`: closed set (`accent`, `radius` 0–32, `density` ∈ `compact | comfortable | spacious`). `theme.css` ≤ 32 KB.
- `visibility`: only `owner` accepted in this sub-project.
- Unknown keys are rejected with path and line number.
- Limits: 20 pages, 50 groups, 500 tiles, file ≤ 512 KB.

## 3. Server

### Modules (replace `server/launchpad.mjs`)

| Module | Responsibility |
|---|---|
| `server/launchpad-schema.mjs` | Pure: validate a parsed `yaml` Document, return normalized model or line-numbered errors. No I/O. |
| `server/launchpad-store.mjs` | Owns `/data/launchpad.yaml`: hardened read (`O_NOFOLLOW`, size cap), atomic write (temp + rename, mode 0600), revision counter, watcher, last-good model, apply operations. |
| `server/launchpad-ops.mjs` | Pure: apply one UI operation to a `yaml` Document (preserving comments/order). |
| `server/launchpad-migrate.mjs` | One-time import from `launchpad.json` + connected services. |
| `server/launchpad-icons.mjs` | dashboard-icons fetch/cache from the fixed host; upload storage and serving. |
| `server/launchpad-theme.mjs` | Generate `theme.css` from tokens, tile styles and custom CSS. |
| `server/vendor/yaml/` | Vendored, pinned `yaml` 2.9.1 (ESM build) + LICENSE. Server-only, so it is never served to browsers. Anchors/aliases are rejected. |

`control-plane.mjs` routes call the store; session, CSRF and origin enforcement are reused unchanged.

### Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v2/launchpad` | Normalized model + revision + current error (if file invalid). |
| GET | `/api/v2/launchpad/revision` | `{ revision, error? }` — cheap poll target. |
| POST | `/api/v2/launchpad/ops` | `{ revision, op }` → apply one operation; 409 `LAUNCHPAD_CHANGED` if stale; 423 `LAUNCHPAD_INVALID` if file currently invalid. |
| GET | `/api/v2/launchpad/theme.css` | Generated stylesheet (ETag = revision). |
| GET | `/api/v2/launchpad/icons/:name` | Cached dashboard-icon or uploaded icon. |
| POST | `/api/v2/launchpad/icons` | Upload icon (≤ 512 KB; PNG/JPEG/WebP/SVG by magic bytes). |

Linked-tile actions use the **existing** action routes; no new action path.

Operations: `addPage`, `updatePage`, `movePage`, `removePage`, `addGroup`, `updateGroup`, `moveGroup`, `removeGroup`, `addTile`, `updateTile`, `moveTile` (group + position), `setLayout` (tile, breakpoint, rect), `resetBreakpoint` (page, breakpoint), `removeTile`, `updateTheme`. Each is validated against the schema after application; a failing result is not written.

### Sync behavior

- **UI save:** check revision → apply op to the Document → validate → atomic write → revision++ → return new model.
- **Hand edit:** `fs.watch` plus a 2 s stat poll fallback (bind mounts); 300 ms debounce; ignore events whose content hash matches the last self-write. Valid ⇒ new revision. Invalid ⇒ keep serving last-good model, expose `error { message, line, column }`, refuse ops (423) until fixed.
- **Missing file after migration:** treated as an empty valid launchpad; the next UI op recreates it.

### Migration

On startup, if `launchpad.yaml` is absent and the migration marker is absent: build a document with one page "Home", groups "Media" and "Infrastructure", one linked `link` tile per entry the v1.18.3 Launchpad currently shows (saved external address → `url`, else the connection address), auto-placed in 2×1 tiles. Write it, then rename `launchpad.json` → `launchpad.json.migrated`. Runs at most once.

### Security

- No credentials in the file in this sub-project.
- CSP: the shell CSP gains `frame-src` built only from origins of currently valid `iframe` tiles (absent ⇒ `'none'`). `style-src 'self'` is kept; all custom styling comes from the generated same-origin `theme.css`.
- Custom CSS: served as `text/css` only; strip `@import` and `url()` pointing off-origin so CSS cannot exfiltrate or load remote content.
- dashboard-icons fetch: one fixed HTTPS host, slug-validated names, size cap, timeout, content-type check; cached in `/data/icons/`. Failure ⇒ letter badge.
- Uploads: served with `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`; rendered only via `<img>`.
- Note Markdown uses the existing sanitizer; search templates must be https.

## 4. UI

- New `src/ui/launchpad.js` + `src/ui/launchpad.css`; `app-v5.js` keeps only the route hook; old launchpad render code removed. All DOM output goes through the existing `helmsman-render` trusted-types policy.
- **View mode** (default): tiles, working search tile, health dots on linked tiles, ⋯ / right-click menu with start/stop/restart using the existing confirmation dialog. Folder tiles open a popover list. Iframe tiles show "This site refuses to be embedded" when framing fails.
- **Edit mode** ("Edit layout" toggle): drag handle, corner resize, cross-group drag; pointer events (mouse + touch); snap-to-grid with push-down collision; side panel for tile fields including a `managed` dropdown of connected services; page/group add/rename/reorder; "+ Add tile" per group; breakpoint switcher with "Customize?" / "Reset to auto"; Theme panel (tokens, CSS editor, live preview).
- **Saving:** each change sends one op immediately; optimistic update rolled back with a toast on failure; 409 ⇒ "launchpad.yaml was edited outside the UI — reloaded."
- **Polling:** `GET /revision` every 5 s while the page is visible; refetch on change.
- **Invalid file:** last-good layout read-only + banner with message and line; edit mode disabled.
- **Accessibility:** keyboard move (arrows) and resize (Shift+arrows) in edit mode; existing tile search retained.

## 5. Testing

- `tests/launchpad-schema.test.mjs`: valid/invalid docs, line-numbered errors, URL rules (today's rejection list), limits, unknown keys, breakpoint reflow rule, type-specific fields.
- `tests/launchpad-store.test.mjs`: op preserves comments/order (byte compare of untouched regions), stale revision ⇒ 409, hand edit detected, invalid hand edit keeps last-good, self-write ignored, atomic write, symlink refused.
- `tests/launchpad-migrate.test.mjs`: fixture `launchpad.json` + connections ⇒ expected YAML; rename; idempotent.
- `tests/launchpad.test.mjs` (extended): session/CSRF/origin on every route, linked actions through the existing action control plane, `theme.css` generation and sanitizing, `frame-src` only from iframe tiles, icon name validation and fixed host.
- Add new tests to `check:security`; extend `operations-view-contract` / visual contracts for the launchpad page; manual check in the demo container (demo data gets a sample `launchpad.yaml`).

## 6. Forward compatibility

- Sub-project 2 adds a `widget` block on tiles (and a secrets store / inline credentials); the schema reserves the key and rejects it until then.
- Sub-project 3 widens `visibility` beyond `owner`.
