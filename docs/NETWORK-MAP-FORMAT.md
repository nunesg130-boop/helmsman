# Network map format guide

The **Network** page draws your network in 3D from a map you own. You can build
it in the editor, start from **Build from inventory**, or write it as JSON and
load it with **Import JSON**. This guide describes exactly what the JSON
accepts, so you can write a map by hand or ask an AI assistant to write one.

Helmsman ships with an empty map. Your map is stored only in
`network-map.json` in your own `/data` volume. It is **not encrypted**. It
never holds credentials, and Helmsman never contacts the addresses in it, but
keep passwords, API keys and tokens out of the notes anyway.

Importing replaces the editor draft. Nothing is saved until you choose
**Save map**, and saving checks every rule below.

## Shape

A map is one JSON object with three lists:

```json
{
  "zones": [],
  "items": [],
  "links": []
}
```

The output of **Export JSON** is in this shape, so an export from one Helmsman
imports into another.

## Zones

A zone is a labelled area of the map, such as *Internet*, *Network edge*,
*Servers* or *Cameras*. Zones are laid out in rows from the top of the map.

```json
{ "id": "edge", "title": "Network edge", "row": 0, "order": 0 }
```

| Field | Required | Rules |
|---|---|---|
| `id` | Yes | 1–48 characters: lower-case letters, digits and `-`, starting with a letter or digit. Unique among zones. |
| `title` | Yes | Up to 64 characters, one line. |
| `row` | Yes | Whole number 0–19. Zones with the same `row` sit side by side. `0` is the top. |
| `order` | Yes | Whole number 0–99. Left-to-right position within a row. |

Up to 40 zones.

## Items

An item is one thing on the map: a router, a host, a VM, a service.

```json
{
  "id": "core-switch",
  "name": "Core switch",
  "kind": "switch",
  "zone": "edge",
  "col": 1,
  "row": 0,
  "address": "10.20.0.3",
  "role": "Managed layer-2 switch",
  "notes": "Port 8 is the uplink to the router.",
  "state": "online"
}
```

| Field | Required | Rules |
|---|---|---|
| `id` | Yes | Same rules as a zone `id`. Unique among items. Links refer to it. |
| `name` | Yes | Up to 64 characters, one line. |
| `kind` | Yes | One of the kinds below. |
| `zone` | Yes | The `id` of a zone in the same map. |
| `col` | Recommended | Whole number 0–23. Column inside the zone. |
| `row` | Recommended | Whole number 0–39. Row inside the zone. |
| `address` | No | Up to 120 characters. Shown as text only; Helmsman never connects to it. |
| `role` | No | Up to 80 characters, one line. |
| `notes` | No | Up to 600 characters. Line breaks are allowed. |
| `state` | No | One of the states below. Defaults to `unknown`. Ignored while a live source supplies the state. |
| `source` | No | A live source, described below. |

**Two items in the same zone can't share a `col` and `row`.** When you import,
an item with no cell, a cell outside the grid, or a cell another item already
holds is moved to the next free cell in its zone, and the import message says
how many moved. Items that do give a free cell keep it. To control the layout
yourself, give every item in a zone its own cell, for example by counting `col`
up from 0 and starting a new `row` every four to six items.

Up to 400 items.

### Kinds

| `kind` | Shown as |
|---|---|
| `internet` | Internet |
| `cloud` | Cloud service |
| `modem` | Modem |
| `router` | Router |
| `firewall` | Firewall |
| `switch` | Switch |
| `access-point` | Access point |
| `wireless` | Wireless clients |
| `camera` | Camera |
| `iot` | IoT device |
| `device` | Device |
| `laptop` | Laptop or PC |
| `server` | Server |
| `host` | Proxmox or Docker host |
| `vm` | Virtual machine |
| `lxc` | LXC container |
| `container` | Container |
| `service` | Service |
| `storage` | Storage |
| `other` | Other |

### States

`online`, `offline`, `degraded`, `stopped` (shown as *Powered off*), `planned`,
`retired`, `unknown`.

Use `planned` for hardware or networks you intend to add but haven't, and
`retired` for things kept on the map for reference.

### Live sources

An item can follow something Helmsman already monitors. Its state then comes
from that source instead of the `state` field.

| Source | JSON | Matches |
|---|---|---|
| Proxmox node | `{ "type": "node", "name": "pve1" }` | A Proxmox node by its node name |
| Proxmox guest | `{ "type": "guest", "vmid": 105 }` | A VM or LXC by its VMID |
| Portainer container | `{ "type": "container", "name": "jellyfin" }` | A container by its name |
| Connected service | `{ "type": "service", "id": "jellyfin" }` | A media service connection |

- Service `id` is one of `jellyfin`, `seerr`, `radarr`, `sonarr`, `prowlarr`,
  `bazarr`, `qbittorrent`.
- `node`, `guest` and `container` sources may also carry an `environment`, and
  a container may carry a `server`, when the same name or VMID exists in more
  than one place. These are Helmsman's internal identifiers. When writing a map
  by hand, leave them out and pick the source in the editor afterwards if a
  match is ambiguous.
- A source that no longer matches anything shows as unknown; the item stays on
  the map.

## Links

A link is a line between two items.

```json
{ "id": "router-switch", "from": "router", "to": "core-switch", "kind": "wired", "label": "1 GbE" }
```

| Field | Required | Rules |
|---|---|---|
| `id` | Yes | Same rules as a zone `id`. Unique among links. |
| `from` | Yes | An item `id`. |
| `to` | Yes | A different item `id`. |
| `kind` | Yes | `wired`, `wan` (WAN uplink), `wifi`, `tunnel`, or `flow` (service flow, such as a reverse proxy to an app). |
| `label` | No | Up to 80 characters, one line. |

- Direction is for reading only; `from` and `to` draw the same line.
- Two links between the same pair of items need different kinds.

## What import fixes and what it skips

Import loads as much of the JSON as it can and tells you what it changed:

- Items without a usable grid cell are moved to a free cell.
- An unknown item `kind` becomes `other`, an unknown `state` becomes
  `unknown`, and an unknown link `kind` becomes `wired`.
- Text longer than its limit is shortened.
- These are skipped and counted: a zone, item or link with a missing, invalid
  or repeated `id`; an item in a zone that doesn't exist; a link to an item
  that doesn't exist, from an item to itself, or repeating another link's pair
  and kind; anything past the map's size limits.

A live `source` is checked when you save. If it isn't valid, the save message
names the item so you can fix or remove it in the editor.

Up to 1,000 links.

## A complete small example

```json
{
  "zones": [
    { "id": "internet", "title": "Internet", "row": 0, "order": 0 },
    { "id": "edge", "title": "Network edge", "row": 1, "order": 0 },
    { "id": "servers", "title": "Servers", "row": 2, "order": 0 },
    { "id": "apps", "title": "Services", "row": 2, "order": 1 }
  ],
  "items": [
    { "id": "isp", "name": "ISP", "kind": "internet", "zone": "internet", "col": 0, "row": 0, "state": "online" },
    { "id": "router", "name": "Router", "kind": "router", "zone": "edge", "col": 0, "row": 0, "address": "10.20.0.1", "state": "online" },
    { "id": "core-switch", "name": "Core switch", "kind": "switch", "zone": "edge", "col": 1, "row": 0, "address": "10.20.0.3", "state": "online" },
    { "id": "wifi-ap", "name": "Living room AP", "kind": "access-point", "zone": "edge", "col": 2, "row": 0, "state": "online" },
    { "id": "pve1", "name": "pve1", "kind": "host", "zone": "servers", "col": 0, "row": 0, "address": "10.20.0.4", "source": { "type": "node", "name": "pve1" } },
    { "id": "media-vm", "name": "media", "kind": "vm", "zone": "servers", "col": 1, "row": 0, "address": "10.20.0.10", "source": { "type": "guest", "vmid": 100 } },
    { "id": "nas", "name": "Backup NAS", "kind": "storage", "zone": "servers", "col": 2, "row": 0, "address": "10.20.0.30", "state": "planned" },
    { "id": "jellyfin", "name": "Jellyfin", "kind": "service", "zone": "apps", "col": 0, "row": 0, "role": "Media server", "source": { "type": "service", "id": "jellyfin" } }
  ],
  "links": [
    { "id": "isp-router", "from": "isp", "to": "router", "kind": "wan", "label": "1 Gbps" },
    { "id": "router-switch", "from": "router", "to": "core-switch", "kind": "wired" },
    { "id": "switch-ap", "from": "core-switch", "to": "wifi-ap", "kind": "wired" },
    { "id": "switch-pve1", "from": "core-switch", "to": "pve1", "kind": "wired", "label": "2.5 GbE" },
    { "id": "switch-nas", "from": "core-switch", "to": "nas", "kind": "wired" },
    { "id": "pve1-media", "from": "pve1", "to": "media-vm", "kind": "wired", "label": "vmbr0" },
    { "id": "media-jellyfin", "from": "media-vm", "to": "jellyfin", "kind": "flow" }
  ]
}
```

## Writing it by hand

1. List your zones first. A common layout is *Internet* (row 0), *Network edge*
   (row 1), then *Servers*, *Services*, *Clients* and *Cameras/IoT* side by
   side in later rows.
2. List every item with a zone. Number `col` and `row` inside each zone if you
   want a particular layout; otherwise leave them out and import places them.
3. Add links last, using the item `id` values.
4. Import, look at the result, move things in the editor, then **Save map**.

If Helmsman already monitors your Proxmox or Portainer, **Build from
inventory** places hosts, guests and containers for you. Export that, add your
router, switches, access points and devices to the JSON, and import it back.

## Writing it with an AI assistant

Gather what the assistant needs, with secrets removed: your device list (from
the router's DHCP or client page), a short description of how things are wired,
and optionally an **Export JSON** of the current map. Then use this prompt:

> Write a Helmsman network map as JSON following the format guide below.
>
> - Output only the JSON object with `zones`, `items` and `links`.
> - Use only lower-case letters, digits and hyphens for every `id`.
> - Every item's `zone` must be the `id` of a zone in the map.
> - Give each item its own `col` and `row` within its zone, numbering left
>   to right and starting a new row every 5 items.
> - Use only the `kind`, `state` and link `kind` values listed in the guide.
> - Keep `name` to 64 characters, `role` to 80 and `notes` to 600.
> - Use `source` only for Proxmox nodes, VMIDs, container names or media
>   services I name explicitly. Leave out `environment` and `server`.
> - Use `planned` for anything I say I haven't installed yet.
> - Never put passwords, keys or tokens anywhere in the map.
> - Don't invent devices or addresses. If something is unclear, leave the field
>   out and list your questions after the JSON.
>
> [paste this guide]
> [paste device list, wiring description, and existing export if any]

Paste the JSON into **Import JSON**. The import message says if anything was
moved or skipped. If saving reports a problem, the message names the zone,
item or connection to fix.
