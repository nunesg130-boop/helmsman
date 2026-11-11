# Launchpad format

The **Launchpad** (Overview workspace) is defined by one file in the data
volume, `/data/launchpad.yaml`. Edit it in Helmsman with **Edit layout**, or by
hand in any text editor. Both stay in sync: a hand edit shows in an open
Launchpad within a few seconds, and a change made in Helmsman keeps the
comments, order and spacing you wrote.

If a hand edit makes the file invalid, Helmsman keeps showing the last good
layout, names the problem and its line number, and refuses edits in Helmsman
until the file is fixed. If the file changes while Helmsman has it open, a
save from Helmsman is refused and the page reloads the file, so a hand edit is
never overwritten.

## Example

```yaml
version: 2
theme:
  tokens: { accent: "#9aa0ff", radius: 8, density: comfortable }
  css: |
    .lp-tile[data-id="jellyfin"] .lp-tile__title { letter-spacing: 0.02em; }
pages:
  - id: home
    title: Home
    groups:
      - id: media
        title: Media
        tiles:
          # A service Helmsman manages, linked to its container
          - id: jellyfin
            type: link
            title: Jellyfin
            url: https://jellyfin.example.com
            icon: dashboard-icons:jellyfin
            managed: { kind: container, service: 4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d, environment: 1, name: jellyfin }
            layout:
              desktop: { x: 0, y: 0, w: 3, h: 1 }
          # A service Helmsman doesn't manage
          - id: router
            type: link
            title: Router
            url: http://192.168.0.1
            style: { accent: "#9aa0ff", background: solid }
          - id: network
            type: folder
            title: Network pages
            links:
              - { title: Switch, url: http://192.168.0.2 }
              - { title: Access point, url: http://192.168.0.3 }
          - id: reminder
            type: note
            markdown: "**Replace the UPS battery** before winter."
          - id: web
            type: search
            engine: "https://duckduckgo.com/?q={query}"
          - id: grafana
            type: iframe
            url: http://192.168.0.213:3000/d/abc
            layout: { desktop: { x: 0, y: 1, w: 6, h: 3 } }
```

## Structure

A launchpad has **pages** (shown as tabs), each page has **groups** (collapsible
sections), and each group has **tiles**. Every page, group and tile has an
`id` of lowercase letters, digits and dashes, up to 48 characters. Page and
tile ids are unique across the file; group ids are unique on their page.

| Key | Where | Meaning |
|---|---|---|
| `version` | top | Always `2`. |
| `theme.tokens.accent` | top | Colour for the selected page tab, `#rgb` or `#rrggbb`. |
| `theme.tokens.radius` | top | Tile corner radius, 0 to 32 pixels. |
| `theme.tokens.density` | top | `compact`, `comfortable` or `spacious`. |
| `theme.css` | top | Your own CSS, up to 32 KB. See **Custom CSS** below. |
| `title` | page, group, tile | Text up to 80 characters. Required for pages, groups, links and folders. |
| `icon` | page, tile | See **Icons** below. |
| `collapsed` | group | `true` to start the group folded. |
| `visibility` | page, group, tile | Only `owner` for now. |

## Tile types

| `type` | Required keys | Optional keys |
|---|---|---|
| `link` | `url` | `title`, `open` (`newTab` or `sameTab`), `managed` |
| `folder` | `title`, `links` (up to 24 `{ title, url }`) | |
| `note` | `markdown` (up to 4 KB) | `title` |
| `search` | `engine`: `tiles` filters this page; or an `https` address containing `{query}` once | `title` |
| `iframe` | `url` | `title` |

Every tile may also have `icon`, `style` and `layout`. Addresses must be plain
`http` or `https`, with no user name or password, up to 500 characters.

An embedded page shows only if the site allows being framed. Many apps don't,
and the tile then says so and offers a link instead.

## Linking a tile to something Helmsman manages

A `link` tile with `managed` shows that thing's health. Containers and
Proxmox guests also get their start, stop and restart controls in the tile's
menu, with the same confirmation as everywhere else in Helmsman.

| `managed` | Matches | Controls |
|---|---|---|
| `{ kind: media, id: sonarr }` | a media connection (`jellyfin`, `seerr`, `radarr`, `sonarr`, `prowlarr`, `bazarr`, `qbittorrent`) | none |
| `{ kind: environment, id: <id> }` | a Proxmox connection | none |
| `{ kind: service, id: <id> }` | a Portainer connection | none |
| `{ kind: container, service: <Portainer id>, environment: <number>, name: <name> }` | a container, by name, so it survives being recreated | Start, Restart, Stop |
| `{ kind: workload, environment: <Proxmox id>, vmid: <number> }` | a VM or LXC, on whichever node it runs | Start, Reboot, Shut down |

The editor's **Linked service** list fills these in for you. If the linked
thing disappears, the tile stays and says **Linked service not found**.

## Layout

Tiles sit on a grid of 12 columns on desktop, 6 on tablet and 2 on phone.
`layout` holds a rectangle per screen size: `{ x, y, w, h }`, where `x` and
`y` start at 0, `w` is columns wide and `h` is rows tall (up to 8).

- A tile with no rectangle for a screen size takes the first free space.
- Tablet and phone follow the desktop layout, reflowed in reading order,
  until you customize them. Once any tile in a group has a `phone`
  rectangle, that group uses its own phone layout. **Reset to auto** in the
  editor removes the `tablet` or `phone` rectangles of a page.

## Icons

| Value | Source |
|---|---|
| `dashboard-icons:<name>` | [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons), fetched once by Helmsman and cached |
| `mdi:<name>` | [Material Design Icons](https://pictogrammers.com/library/mdi/), fetched once and cached |
| `upload:<file>` | An image uploaded in the editor: PNG, JPEG, WebP or SVG, up to 512 KB |
| `emoji:<emoji>` | Shown as text |

Linked media tiles without an icon use Helmsman's own service icons. Other
tiles show their first letter.

## Custom CSS

`theme.css` is added to a stylesheet Helmsman serves from its own address.
Target a tile with `.lp-tile[data-id="<id>"]` and the page with `.lp-root`.
`@import`, `image-set()` and any `url()` pointing to another site are removed.

## Limits

20 pages, 50 groups, 500 tiles, and 512 KB for the whole file. YAML anchors
and aliases (`&name`, `*name`) are not supported.

## Upgrading from v1.18

The first start of v1.19 turns the services the old Launchpad listed into
linked tiles, keeping any external addresses you had saved. `launchpad.json`
is renamed to `launchpad.json.migrated`, so v1.18 still finds its data after a
rollback. The import runs once: deleting `launchpad.yaml` later gives an empty
Launchpad, not a second import.
