# Helmsman v1.15.0

Helmsman is a self-hosted operations center for a homelab's media services and infrastructure. It runs as one portable Linux container on Docker Desktop, Linux, macOS, compatible NAS platforms, AMD64, and ARM64.

[Releases](https://github.com/nunesg130-boop/helmsman/releases) · [Container package](https://github.com/users/nunesg130-boop/packages/container/package/helmsman) · [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md)

> [!WARNING]
> Back up the `/data` volume before every update and use the newest published
> release. Helmsman is a single-instance application owned by one exact
> Jellyfin administrator; it has no separate Helmsman accounts, roles, or audit
> attribution. Do not scale multiple containers against one data volume, and
> use a trusted HTTPS edge for remote browser access.

This Helmsman is the media and infrastructure dashboard in this repository. It
is not affiliated with or derived from the existing Kubernetes project also
named [Helmsman](https://github.com/mkubaczyk/helmsman).

## v1.15.0

**Training data for your own model.** Settings → Agent has a new **Training data** card. Turn on "Keep conversations for training" and each conversation with the agent is saved with everything the model was shown: its instructions, your question, every tool call and result, and its answer. Secrets are scrubbed before saving, and it is stored only on your server for 90 days or 100 MB. Off by default; "Include reports" also keeps incident notes, recoveries and summaries.
- Every saved answer, in the chat and on reports, gets **Good**, **Bad** and **Fix answer**. A fixed answer is what the model should have said, and it replaces the model's answer in the export.
- **Download good and fixed** saves a JSON Lines file ready for fine-tuning, one example per line with the tool definitions included. Answers rated Bad never export. **Delete all** removes everything.
- While conversations are kept, the chat comes back after a page reload.

**A lost connection is no longer called a restart.** When Helmsman loses contact with a Proxmox node (or with Proxmox itself), the agent now says it lost contact and that it can't tell yet whether the server restarted or the network dropped. When the node is back, its uptime decides: if the uptime started over, it restarted; if it kept counting, the agent reports a network or connection problem, not a restart. The status reads "Holding alerts: node unreachable" until a reboot is actually seen.

## v1.14.5

**The agent knows when a node restarts.** Restarting a Proxmox node used to set off an alert for every service on it, and another for every recovery, as its guests came back one by one. Now, when a node goes offline, Proxmox can't be reached, or a node's uptime shows it just booted, the agent holds alerts. You get one heads-up if a node drops out unexpectedly, and one summary once every node has been up for 10 minutes: either everything is working again, or a list of what is still broken. Automatic restarts and clean-ups wait too, since the guests are starting on their own. A hold never lasts more than 30 minutes. The agent also sees node uptime and any restart in progress when you ask it questions, and its status reads "Holding alerts: restart" meanwhile.

**Inactive storage is labelled.** A Proxmox storage that is defined but not active on a node (for example a disk that moved to another node) showed "0 B used · 0 B free · 0 B total". It now says it is inactive on that node and what to do about it.

## v1.14.4

**The real memory leak is fixed.** With a pinned certificate, every Portainer, Proxmox and Loki request left one encrypted connection open for good. Node ignores a supplied connection when an HTTP agent is also set, so the request went out over a second connection while the checked one stayed open. One Portainer server leaked about 14 connections a minute (1,176 after 80 minutes), and their buffers, not JavaScript objects, filled the 256 MiB container until it was killed. Pinned requests now use exactly the connection whose certificate was checked, close it when they finish, and refuse to send anything if another connection is ever used. The same mistake meant the certificate pin was only checked on the unused connection; the request itself went over one that skipped certificate checks, so pinned mode now really enforces the pin.

If you pinned your Portainer certificate, consider making a new Portainer access token after updating.

**Smoother Helmy.** The 3D helper now uses the model's full detail (every triangle, precise lighting normals and sharper textures) and draws at a higher resolution, so his horns and armour look as smooth as the original model instead of faceted. His fingers move too: they rest loosely curled, drum while he thinks, flutter when he waves, clench into fists when something breaks, spread wide when he celebrates or stretches, and grab at the air while you carry him.

## v1.14.3

**Fixes from a full review.**

- An automatic rule that was skipped because of its cooldown now runs once the cooldown ends, if the problem is still there. Before, a second outage that started inside the cooldown was never handled by the rule, however long it lasted.
- "Summarize now" can no longer wait forever when a chat question arrives while the agent's queue is full; the pushed-out job now reports that the agent is busy.
- A recovery note can no longer be lost when a service doesn't report when it recovered.
- qBittorrent's version no longer shows as "vv5.1.2".
- Media → Health: the Prowlarr Indexers panel now lines up with the cards above it instead of running past them.
- Keyboard focus stays on "Summarize now" while the summary is written.

**Network map.**

- Each row in the Network page's list is now a dropdown: open it to see the item's state, live facts and connections, and to center it in the model. Clicking a block in the model opens its row.
- Cables end at the edges of their blocks instead of running under them, and item names and zone titles sit on solid tags, so lines no longer cut through text. Zone titles moved inside their zones, clear of the cable runs.
- On a phone, one finger now pans the model (before, it could only rotate), two fingers pinch and pan, the toolbar is one scrollable row, and long names wrap onto a second line instead of being cut off.

**No more cut-off text.** Proxmox and Portainer tiles reflow before their values get cut off, the Portainer endpoint gets its own row, card descriptions wrap, request times in Requests & warnings are shorter, poster, calendar and request titles get two or three lines, and the header shows the workspace name ("Infrastructure") instead of a truncated "Infrastructure operations".

**Helmy comes alive.** The floating helper is now drawn live in 3D. He floats and breathes, glances around and stretches now and then, follows your mouse with his head, waves when you hover over him, folds his arms and thinks while the agent writes an answer, flinches when something breaks, celebrates (with a spin) when it recovers or when you approve an action, nods at answers, leans into it when you drag him, and turns toward the chat when it opens. He holds still when your system asks for reduced motion, draws nothing while the tab is hidden, runs at 30 frames a second at most, and falls back to the old picture if 3D can't start. The model's credits are in [assets/helmy/NOTICE.md](assets/helmy/NOTICE.md); three.js (MIT) draws him.

**Visual layout tests in CI.** The two browser layout contracts (`npm run check:visual`) were updated to the current design and now run in CI.

## v1.14.2

**The agent no longer reports your manual as news.** Asked "Anything happen overnight?", it could pull lines from your Manual that happened to contain the word "overnight", such as an old known-issue note or a roadmap item, and describe them as things that had just happened. Questions about a period ("overnight", "today", "this week") are now answered from Helmsman's own history only. Time words no longer select manual lines, and manual excerpts given to the model are labelled as your notes, not events. You can still ask about your notes directly.

## v1.14.1

**Fewer out-of-memory restarts** (the main cause was found in v1.14.4). Helmsman's memory grew slowly for as long as it ran, and with the default 256 MiB container limit it was killed and restarted every few hours. The cause was how each request to your services was given its timeout: Node kept a small record of every one of them for the life of the process. That record is no longer kept, and the in-memory artwork cache is now 32 MiB instead of 64 MiB so Helmsman stays well inside the container limit. The on-disk artwork cache is unchanged.

**Faster recovery after a crash.** If Helmsman is stopped abruptly, it now waits for its old lock to expire and starts on the first try, instead of failing with "The broker data directory is already in use" until Docker's restart loop gets through.

**Radarr and Sonarr indexers load again on newer versions.** When an app doesn't report which indexers are failing, the Indexers panel now still lists them, marked "failure details not reported", instead of showing "Indexers unavailable". The error message in that panel is also no longer squeezed into a narrow column.

## v1.14.0

**The agent answers from real history.** Ask "how has the health been in the past 24 hours?", "anything wrong today?", "how was yesterday?" or "this week", and Helmsman's own code works out what happened from its records: each problem per service with when it started, how long it lasted and whether it is still open, plus actions taken and Helmsman's own restarts. The model only puts that into words, so it no longer describes the current state as if it were history. A new history tool covers follow-up questions.

**It admits what it doesn't know.** The agent is told exactly which services Helmsman monitors, and that it does not watch your internet connection, Wi-Fi, router, network speed or other devices. Asked about those, it says so instead of guessing. It also no longer offers shell commands unless asked.

**Nicknames work.** "restart qbit", "sonar", "radar", "jelly", "overseerr", "pve" and small typos such as "qbitorent" find the right container, VM or service. When a name could mean more than one thing, the agent asks which.

**Approval requests are easier to act on.** A request made in the chat now appears right under the answer, with Approve and Decline buttons, and afterwards shows what happened ("Approved: Restart container qbittorrent. Done." or why it didn't run). Requests from incident reports appear in a strip above the conversation that no longer gets squeezed out of view. Approve is the confirmation for starting and restarting; stopping, shutting down, rebooting and clearing downloads still ask once more.

## v1.13.0

**In-depth logging.** Helmsman's log now records more than milestones:
- **Always:** errors with their full message and where they happened, and a summary of each agent run (which model, which tools, whether it proposed anything).
- **Debug logging**, under Settings → Logging, adds every health check, every request to your services with its route, status and timing, and every model and tool call the agent makes. It stays on for the hours you choose (four by default, at most a day) and switches itself off. Debug entries are capped per minute so a runaway loop can't fill storage.
- **Server output:** Logs → Server output shows what Helmsman has printed since it started (what `docker logs` shows).
- **Download:** Logs → Helmsman logs has a Download button that saves the filtered log as a JSON Lines file.
- **Filters:** the list gains a Kind filter (health checks, service requests, agent, actions, errors and more), and level and kind are filtered on the server so debug entries can't crowd out the rest.

Passwords, API keys, tokens, cookies, request and response bodies, and headers are never logged. Error messages and server output are scrubbed of anything that looks like a key, a password or a credential in a link before they are stored or shown. Log storage grows from 20 MB to 50 MB, still kept for 14 days. If you roll back to an earlier version, it skips the new, more detailed entries and shows a "log segment malformed" warning; the older entries stay readable.

**Test Radarr's and Sonarr's indexers.** Their connection dialogs now list the indexers each app uses, with which ones are failing, and Test and Test all buttons that run the app's own indexer test. As with Prowlarr, the indexers' keys never leave Helmsman's server.

**Tidier connection tests.** In the Test connection results, a check that expands with the service's own health report keeps its shape instead of stretching into an oval.

## v1.12.2

**One refresh button for everything.** The top bar now has a refresh button on every page, phones included. It runs a full health check of your media and infrastructure services and reloads what the page shows (the agent's notes, Prowlarr indexers on Health, logs on Logs, and so on). It spins while it works. The "Check now" buttons on individual pages do the same thing.

**Fresh as soon as you look.** Coming back to Helmsman's tab or window now shows the latest results right away instead of waiting up to 30 seconds for the next update.

## v1.12.1

**Faster loading.** Helmsman's app files are now compressed and cached by your browser, so a reload only checks for changes instead of downloading everything again (about half the size on a first visit). Posters and artwork stay cached longer, in the browser and on the server, so media cards fill in right away after time away.

**Everything that looks clickable goes somewhere.** On the Overview, each row under Service health opens that service on Media → Health, and each connection opens its Proxmox environment or Portainer instance. The Infrastructure signals tiles lead to their detail: nodes, CPU and memory to Proxmox nodes, guests to Workloads, storage to Proxmox storage, and failed tasks and backups to the environment's recent activity.

**Solid dialog bars.** The header and footer of connection and detail dialogs no longer show the content scrolling behind them.

**Fixes and polish.**
- Activity shows each download's percent above its progress bar instead of on an unreadable green block.
- Finished and seeding torrents no longer show "ETA 100d" (qBittorrent's "no ETA" value).
- The helper starts in the bottom-right corner and drifts less, and pages leave room at the end so it never hides the last row.
- Logs, Connections, Connectors, Proxmox, Workloads, Portainer, Incidents and Settings line up with every other page.
- Today's "Last assessment" times show just the time, so they fit their tiles.
- Helmsman's small background worker is no longer blocked by its own script-safety policy.
- On phones, Workloads rows fit the screen, the Calendar is a day-by-day list, and the log counts wrap to two rows.
- A single Proxmox environment fills the row.

## v1.12.0

**Prowlarr indexers.** Media → Health has an Indexers panel listing every indexer with its status, Prowlarr's last error and recent query numbers, with buttons to test one indexer or all of them, test Prowlarr's connections to its apps, and sync indexers to the apps. Indexer and app settings carry API keys and passwords; Helmsman keeps only names, status and numbers, so those never reach the browser, the logs or the agent's model.

**The agent tests failing indexers.** Under Settings → Automation → Indexers (off by default), the agent tests an indexer as soon as Prowlarr reports it failing, retests it after a while, and notifies you only if every test fails (2 tests, 15 minutes apart, to start with). You can also ask it in chat: "test indexers" or "test 1337x". It only ever tests the failing indexer, at most 12 tests an hour, and can't change indexers.

## v1.11.1

qBittorrent no longer shows as a problem just for being idle. It reports "firewalled" until a peer connects in to it, so with nothing downloading or seeding it always looks firewalled even when its port is open. Helmsman now treats that as healthy, and only flags "firewalled" while something is downloading, seeding or stalled waiting for peers.

## v1.11.0

**Stuck downloads get cleared.** Under Settings → Automation → Stuck downloads, Helmsman watches Radarr's and Sonarr's queues for downloads that stay stalled, failed or blocked from importing. Past the wait you choose (an hour to start with), you get one notification and an Approve button to remove the download, blocklist that release and search again: the same action, with the same checks, as the "Block release & search again" button. Optionally, Helmsman clears stalled and failed downloads by itself while "Let rules act" is on, within the shared 10-a-day cap; blocked imports always ask first. While it's on, queue-only Radarr and Sonarr incidents stay quiet so you aren't notified twice. It's off by default, and the agent's settings file only gains the new section once you use it.

## v1.10.0

**Unhealthy containers get restarted, and repeat offenders get flagged.** Under Settings → Automation → Unhealthy containers, Helmsman can restart a container whose Docker health check fails, after a short wait. The first restart is quiet; if it goes unhealthy again you're notified each time, and after a set number of times within a window it stops restarting that container and tells you it needs attention. It covers all containers except the ones you tick (databases, Portainer, Helmsman and similar are ticked to start with) or only the ones you tick, shares the 10-a-day cap with rules, only acts while "Let rules act" is on, and the daily summary mentions containers that keep failing. It's off by default.

**Settings has tabs**: Access, Agent, Notifications, Automation and About, and remembers the last one. **Each Portainer connection is its own collapsible section** on the Portainer page, showing running containers and anything needing attention when closed; the open or closed state is remembered, and searching opens the sections with matches. The agent's settings file only gains the new container-health section once you use it, so rolling back to 1.9 still works if you haven't.

## v1.9.1

Asking the agent to do something now gives you something to approve. A chat message that is only a request, such as "restart qbittorrent" or "reboot vm 105", becomes an approval request with buttons straight away, instead of the model writing a pretend proposal. Typing "approved" or "yes" points to the button and never runs anything, unknown names get a list of what Helmsman can see, and markdown bold no longer shows up in answers.

## v1.9.0

The agent answers questions directly instead of opening every reply with a status recap, and knows what it can and can't do: it can suggest an action for you to approve, never acts by itself, and knows whether your rules are on. Questions also start with the lines of your manual that match them, so "what's the IP of norco?" is answered from the manual instead of the model offering to search it, and the manual search now ignores filler words and matches whole words. **Settings → Agent → How the agent responds** lets you tell it how to talk (length, tone, what to include), with Brief, Detailed and Friendly presets and a count of how much context the text uses. The built-in safety rules always come after your text. The old one-line extra instructions carry over and can now span several lines, up to 2,000 characters.

## v1.8.0

The agent gets a face: a small floating helper that appears on every page once you're signed in. It drifts gently near where you leave it, and you can drag it anywhere. Click it and it glides to the right edge and opens a mini chat beside itself, sharing the conversation with the Overview's chat box. It shows a badge when an action is waiting for approval or a new report has arrived, and a short speech bubble when something breaks or recovers. Hide it from its chat window or under **Settings → Agent** (a per-browser choice). It respects reduced-motion settings. Nothing on the server changes.

## v1.7.0

The agent gets its screens. The Overview in the Overview workspace has an **Agent** card with the latest reports, actions waiting for your approval, and a chat box for questions about your homelab. **Settings → Agent** sets it up without the browser console: numbered first-time steps, the model server (with a connection test that lists the server's models), what the agent reports and when, Home Assistant phone notifications with a test button, and a rule builder that lists your monitored services, containers and guests. Nothing on the server changes, and the state file stays on schema 6.

## v1.6.1

The agent now works with small local models that go quiet when offered many tools. qwen2.5:3b on Ollama answered every question with an empty reply; questions now start with Helmsman's overview already looked up, and an empty reply is retried once without tools. Nothing else changes, and the state file stays on schema 6.

## v1.6.0

This release adds the **Helmsman agent**, an optional assistant built for a small model on your own hardware, such as a 3–4B model on a 4 GB GPU, through any OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM). It stays off until you configure it, and it has no screens yet; [docs/LOCAL-AI.md](docs/LOCAL-AI.md) sets it up from the browser console. Nothing else changes, and the state file stays on schema 6.

The agent wakes up when something changes instead of polling: an incident opens or gets worse, a service recovers, the daily digest is due at your local time, or a periodic check-in is due. It looks into the problem with read-only tools and writes a short note (what is wrong, the likely cause, the next step), and it can send notes to your phone through a Home Assistant notify service. One outage gives one note and one notification. Without a model it still notifies you, using Helmsman's own facts.

It changes things only through rules you write, such as "restart the sonarr container when Sonarr has been down for 5 minutes", which Helmsman's code checks, never the model. Rules can only start or restart containers and start or reboot guests, fire only for an incident on the service they name, run once per incident with a cooldown, a daily limit and a cap of 10 actions a day across all rules, and only while the autonomy switch is on (off by default). Anything the model suggests waits for your approval and runs through the dashboard's own action checks. The agent's settings are kept in `agent.json`, sealed with an integrity tag from the master key; its model-server key and Home Assistant token are encrypted with your other credentials. `npm run demo -- --outage` shows the whole loop with a scripted stand-in model.

## v1.5.0

This release prepares Helmsman for homelabs other than the one it was built in. It has no visual changes.

**Back up `/data` before updating.** The state file moves to schema 6, which stores media connections by their own id instead of by service name, so a later release can hold more than one connection of the same service. Every connection, encrypted credential, session and approval is kept, but v1.4.0 refuses to start on a migrated volume; rolling back means restoring the backup.

Request headers are renamed from `X-Jellofin-*` to `X-Helmsman-CSRF`, `x-helmsman-device-token` and `x-helmsman-target-revision`. The old names are still accepted, so existing reverse-proxy rules keep working; a rule that strips them should cover both prefixes, as the Authentik Caddyfile example now does. Capacity limits (Proxmox environments and endpoints, endpoints per environment, and Portainer and Loki connections) and the release-calendar window can now be set with `HELMSMAN_*` environment variables; the defaults are unchanged and a bad value stops startup with the variable's name. See **Capacity limits** in [deploy/DOCKER.md](deploy/DOCKER.md).

Network map import now moves items without a usable grid cell to a free one and reports what it moved or skipped, instead of failing on save. [docs/NETWORK-MAP-FORMAT.md](docs/NETWORK-MAP-FORMAT.md) documents the map JSON, and both it and [docs/MANUAL-FORMAT.md](docs/MANUAL-FORMAT.md) include a prompt for writing a map or manual with an AI assistant. For contributors, `npm run demo` runs the real server against built-in fake services, and [docs/ADDING-A-CONNECTOR.md](docs/ADDING-A-CONNECTOR.md) lists every file a new service touches.

## v1.4.0

This release finishes the Obsidian Glass visual refresh and adds the **Launchpad**. The refresh raises the near-black canvas with one sheet for the header and content, turns rows into quiet tiles, restyles the System Health gauge as a 28-segment arc, gives every button, chip, tab and filter one compact desktop scale with 44px touch targets on phones and coarse pointers, and restyles Calendar, Logs, filters, dialogs and phone layouts. The Launchpad, in the Overview workspace between Overview and Logs, opens every connected media service, Proxmox environment and Portainer server in a new tab. Each tile uses an optional external address first and the connection address as the fallback. External addresses are stored privately in `launchpad.json` in the data volume, accept only plain http(s) links, and are never requested by Helmsman. The bundled Portainer mark is now the dark-background variant and the favicon helmet fills its icon.

This release also adds a **Manual** to the Overview workspace and a **Search Helmsman** field to the top bar. The Manual, between Launchpad and Logs, holds your own operations manual written in Markdown: sections, tables, lists, code blocks and `> [!WARNING]`-style callouts, with table cells such as Pending, Healthy or Critical shown as status badges. It is edited in place, or loaded by dropping a `.md` or `.txt` file on the page (or choosing **Import file**) for review before saving, stored privately in `manual.json` in the data volume, and saved only against the revision the editor opened, so two sessions cannot silently overwrite each other. Helmsman ships with no manual content, renders the Markdown through an escaping subset that never passes HTML or script through, and limits a manual to 256 KiB. The manual is not encrypted, so keep passwords, keys and tokens out of it. The editor has a **Formatting help** panel and a **Start from template** skeleton, and [docs/MANUAL-FORMAT.md](docs/MANUAL-FORMAT.md) lists everything the Manual understands. Search Helmsman (press `/` or Ctrl/⌘ K) finds pages, connected services, Proxmox workloads and manual sections or table rows in one list, and opening a manual result scrolls to that row and highlights the match.

This release also adds a **Network** page to the Infrastructure workspace: an interactive 3D model of your network, styled in Obsidian Glass. You arrange zones (such as "Network edge" or one per server) and place items on each zone's grid; Helmsman lays them out, draws connections as wired, WAN, Wi-Fi, tunnel or service-flow links, and colours each item from live data it already collects. An item can be linked to a Proxmox node or guest (by VMID), a Portainer container (by name) or a configured service, chosen from a dropdown of everything Helmsman can see; anything Helmsman cannot reach, such as a modem, switch or access point, is added by hand with a manual state. **Build from inventory** creates a first map from your Proxmox nodes and Portainer environments, and the editor adds a node with all its guests, or an environment with all its containers, in one step. Drag to rotate, shift-drag to pan, scroll or pinch to zoom, and click any item to see its live facts and connections while everything else fades. The map is stored privately in `network-map.json` in the data volume, saved only against the revision the editor opened, and can be exported or imported as JSON. It holds no credentials or URLs Helmsman contacts, and every value is bounded, validated on the server and escaped before display; the scene is positioned through the CSSOM so the page keeps the existing Content-Security-Policy.

It also fixes the collapsed sidebar rail, where space-taking scrollbars (such as Windows Chrome) clipped the workspace switch and squeezed the navigation icons, and adds **Formatting help** and **Start from template** to the Manual editor, with the full syntax in [docs/MANUAL-FORMAT.md](docs/MANUAL-FORMAT.md).

## v1.3.4

This patch adds an **Ignore** control for health warnings. Any warning or error reported by a media service, Proxmox environment, or Portainer/Loki connection can be ignored from the dashboard, and the new System overview **Warnings** card lists current warnings alongside an **Ignored warnings** list with Restore. An ignored warning stops lowering service state, the health score, and incidents; it never hides connection failures, and it is restored automatically once the warning has been absent for 24 hours. Acknowledgements are stored privately in `acknowledgements.json` in the data volume. The System Health gauge segments now follow one evenly spaced radial arc.

## v1.3.3

This patch moves the System Health gauge geometry into the trusted stylesheet so all 28 segments render under Helmsman's strict content security policy. It also adds the reviewed local Portainer icon to desktop and mobile Infrastructure navigation.

## v1.3.2

This patch restores the wide segmented System Health gauge, compacts the combined Overview into a reference-aligned dashboard grid, expands the workspace selector, and installs the supplied transparent Proxmox and helmet assets throughout the application.

## v1.3.1

This release adds a combined Overview workspace with real Media and Infrastructure health, independent header health controls, compact interaction styling, cleaner service-health copy, background-free integration marks, and a larger transparent helmet app icon.

This release introduces the **Obsidian Glass** visual system across the entire
application. Helmsman now uses the near-black, compact operations-console
presentation selected for the project: smoked translucent surfaces, restrained
graphite borders, subtle blue-violet ambient depth, and green reserved for
healthy state and primary emphasis. The redesign covers the shared shell,
Media and Infrastructure dashboards, connector catalogs, service rows,
logging, forms, controls, drawers, dialogs, notices, and mobile navigation.

The visual reference informs color, density, surface treatment, typography,
and interaction polish only. Helmsman does not copy its charts or example
metrics, and every displayed value still comes from the existing normalized
service model. Routes, authentication, cached-state boundaries, monitoring,
health semantics, and fixed confirmation-controlled actions are unchanged.
The responsive layer keeps desktop, tablet, and phone layouts usable without
hiding authorized controls, and toast copy retains the full popup width.

## v1.2.0

This release adds a private persistent cache for normalized dashboard state and
media artwork. After a container restart, Helmsman can immediately show the
last successful bounded snapshot with a visible **Cached data** notice while a
live health cycle runs in the background. Cached evidence is always read-only:
media recovery, Proxmox, and Portainer controls stay unavailable until a fresh
connected, revision-matched health result replaces it.

Successful raster artwork now uses a two-tier cache: the 32 MiB
in-memory LRU remains the fast path, while a guarded 512 MiB persistent tier
under `/data/cache/artwork` avoids refetching unchanged posters after a
restart. Snapshot and artwork files are private, bounded, checksummed or
content-verified, written atomically, and never contain credentials, headers,
raw upstream responses, Jellyfin session identity, or Loki query results.
Connector revisions remain part of every artwork key, so a changed service
destination cannot reuse a previous target's cache entry.

Shared toast notifications now use their full available width. Short messages
such as **Health checks completed** no longer wrap one word per line on desktop
or mobile.

## v1.1.2

This maintenance release fixes Infrastructure Overview text collisions by
giving labels, supporting copy, values, and chevrons stable grid columns. On
narrow screens, the assessment heading now stacks its full-width **Refresh
now** action beneath the heading copy instead of allowing the two to overlap.

The Media **Calendar** now requests a bounded release window from Sonarr and
Radarr—one day back through 35 days ahead—rather than depending on each
service's default calendar range. Date-only episode and movie fields are also
accepted, so valid monitored releases are not discarded when a service omits a
timestamp. The seven-day schedule remains focused on the current week, with
later results listed under **Beyond this week**.

## v1.1.1

This interface refinement makes **Overview** the canonical Media landing page;
the legacy `#/home` route now redirects to `#/overview`. Its layout, labels,
supporting copy, spacing, and card hierarchy are aligned more closely with the
approved dashboard reference while retaining Helmsman's established palette,
real service data, and existing action boundaries.

Overview keeps connection health compact and separate from upstream service
health, combines requests and service warnings in one attention card, and
shows the evidence-backed five-stage **Requested → Monitored → Downloading →
Imported → Available** lifecycle. Continue Watching remains the lead card when current
Jellyfin data exists; otherwise Downloads & Imports moves into that position
without leaving an empty panel. The bundled local Radarr, Seerr, and Sonarr SVG
marks have also been refreshed from the user-supplied artwork. The reference
informs presentation only; Helmsman continues to show live normalized data
rather than the mockup's illustrative metrics.

## v1.1.0

This interface release redesigns Media and Infrastructure as a modern rounded
bento dashboard while preserving Helmsman's charcoal, slate, and muted
sea-green palette. The sidebar now presents the helmet with the **HELMSMAN**
wordmark only, and connection health remains distinct from upstream service
health throughout the dashboard.

Media Home gives current Continue Watching data the lead card; when none is
available, Downloads & Imports moves into that position without leaving an
empty placeholder. Infrastructure Overview now uses the same clear bento
hierarchy for its configured environments, signals, workloads, and incidents,
while retaining the existing normalized data, links, confirmations, and
supported actions.

## v1.0.6

This observability release adds an always-available built-in Helmsman journal
and a first-class Grafana Loki connection and explorer. Connection health and
Loki service/query health remain separate, saved credentials stay encrypted
and write-only, and externally sourced log results remain transient.

### Built-in logging and Loki Explorer

The global **Logs** workspace now keeps Helmsman's own sanitized operational
event journal available without another service. Operators can also register
Grafana Loki under **Infrastructure → Connectors → Observability** and query it
from the dedicated **Loki Explorer**. Grafana is optional: Helmsman talks to
Loki's HTTP API directly and does not require a Grafana connection.

These are deliberately separate sources. Helmsman's journal persists bounded,
allowlisted event facts under `/data/logs`; Loki query results remain transient
and are never copied into that journal. Contextual **View logs** links can open
the explorer with relevant service or incident context, but the operator still
controls the LogQL query that is sent.

## v1.0.5

This interface maintenance release centers and simplifies Jellyfin sign-in,
separates browser-to-service connection health from upstream application
health in the shared Media advisory, aligns shared panel actions and inventory
counts, and applies Infrastructure hover feedback to each complete target
card. Monitor summary updates now patch their existing DOM in place while
preserving the active workspace and accessible status labeling.

## v1.0.4

This maintenance release hardens Discovery and drawer-based Seerr season
requests. Helmsman now accepts Seerr's documented `201 Created`
acknowledgement when optional echoed relations are absent or filtered, warns
when Seerr reports no TVDB mapping for Sonarr routing, explains unreadable
gateway failures, and treats every mutation HTTP 5xx as an uncertain outcome
that must be refreshed before another write is allowed.

## License and project identity

Helmsman's project-owned source code is licensed under the
[GNU Affero General Public License v3.0 only](LICENSE). If you modify Helmsman
and let users interact with that modified version over a network, review
section 13's Corresponding Source requirement. This summary does not replace
the license text.

The Helmsman name and helmet logo identify this project. The AGPL is a
copyright license and does not grant trademark rights. Service names identify
compatible products; their names and trademarks remain the property of their
respective owners. Helmsman bundles reviewed, hash-pinned local icons only to
identify the nine existing media and infrastructure integrations; Loki uses
Helmsman's project-owned logging mark. Original generic VM/container workload
drawings are also bundled. See
[the asset notices](assets/services/THIRD_PARTY_NOTICES.md).

Helmsman v1.15.0 combines built-in logging, optional Loki search, Portainer monitoring, a private persistent state/artwork cache, and a small, fixed set of confirmed recovery actions under Infrastructure with targeted media recovery actions and Helmsman's cluster-aware Proxmox model:

- Media and Infrastructure are separate workspaces inside the same authenticated application, and only the selected workspace's navigation is shown;
- the desktop sidebar collapses to an icon rail, remembers that preference, keeps its navigation scrollable at high browser zoom, and keeps its collapse control in the sidebar's brand row (under the brand mark when collapsed);
- Infrastructure **Overview** contains only already-configured Proxmox and Portainer connections plus their current read-only signals, while the always-available categorized **Connectors** view owns supported-provider discovery, setup, and editing;
- the Media workspace has dedicated **Overview**, **Discover**, **Library**, **Requests**, **Activity**, **Calendar**, **Health**, and **Connections** views; the legacy `#/home` URL redirects to canonical `#/overview`;
- Media **Connections** groups every supported integration by purpose: media server, requests, media management, indexers, download clients, and subtitles;
- Jellyfin, Seerr, Radarr, Sonarr, qBittorrent, and Bazarr records are correlated by TMDb, TVDb, IMDb, download, and service identifiers rather than title matching;
- Overview combines Continue Watching, service health, active downloads and imports, requests and warnings, an evidence-backed media lifecycle, and recently added titles; Continue Watching yields its lead position to Downloads & Imports when empty, episode resumes use their series poster rather than an episode frame, and additional resume items remain available in a compact poster rail;
- Activity combines qBittorrent transfer progress, speed, and ETA with Sonarr/Radarr queue and import state, including the current bounded service-reported error when one is available;
- Requests keep Seerr approval separate from acquisition state, use exact **Awaiting approval**, **In progress**, **Available**, **Needs attention**, and **Closed** buckets, preserve the exact season/4K scope, and never treat older episodes from the same series as proof that a new request is available;
- request rows missing presentation metadata are enriched through Seerr's fixed movie/TV detail routes with revision-scoped caching and a fair three-worker background queue; the short dashboard wait no longer cancels slow TV lookups, and visible unresolved rows can resolve their cover through the same typed route on demand;
- series and parent-resolved episode drawers load current season state on demand, warn when Seerr reports no TVDB mapping for an auto-approved Sonarr handoff, and can submit one confirmed, standard-quality Seerr request for the exact selected requestable seasons;
- normalized media detail and the Overview pipeline retain the read-only lifecycle **Requested → Monitored → Downloading → Imported → Available** and report only stages supported by current service evidence;
- artwork is served only through an authenticated opaque Helmsman URL, uses revisioned 342 px Jellyfin/Seerr thumbnails and fixed 250 px, 500 px, then original Radarr/Sonarr covers, safely resolves Sonarr's TV metadata through a typed Seerr lookup when its local cover is unavailable, coalesces duplicate misses, and bounds cold artwork to three concurrent upstream fetches with 64 queued requests;
- unreleased Radarr movies remain **Upcoming** and are not counted as missing, Sonarr calendar episodes inherit their parent-series poster, and calendar-only episode rows are excluded from Library;
- unchanged artwork keeps a stable browser URL with a one-day private cache, while image revisions produce a new opaque URL, cold proxy fetches receive an eight-second artwork-only budget, and temporary failures receive two bounded browser retries without cache-busting;
- reviewed, hash-pinned icons for the nine existing media and infrastructure integrations are bundled locally without a runtime icon CDN; v1.1.1 refreshes the Radarr, Seerr, and Sonarr marks from user-supplied SVG artwork, Loki uses Helmsman's own logging mark, and original generic VM and container SVGs identify workloads;
- media monitoring remains read-only by default; the only media writes are a Seerr failed-request retry, a selected standard-season request for one exact current series through Seerr, a targeted Radarr/Sonarr search when Helmsman can resolve one exact current record, and a fixed blocked-queue recovery for one exact current errored Sonarr/Radarr queue item, and each opens Helmsman's own confirmation dialog before it runs;
- each standalone Proxmox server or multi-node cluster is one environment, separate from its physical nodes and VM/LXC workloads;
- **Connect and discover** verifies authentication, certificate trust, environment identity, cluster name, and visible nodes before an environment can be saved;
- an environment can have up to four explicitly approved API endpoints, each with its own URL, TLS trust, encrypted API token, and availability state;
- cluster-wide inventory is collected once per monitoring cycle through one healthy endpoint, so nodes, workloads, storage, tasks, backups, and incidents are not duplicated;
- endpoint reachability and actual Proxmox node health remain separate—loss of one endpoint can make an environment Limited while another endpoint keeps its inventory available;
- one dedicated **Proxmox** view combines environments, physical nodes, and node-scoped storage capacity; **Workloads** remains a focused VM/LXC inventory view;
- stopped guests remain informational and do not make an environment unhealthy;
- Portainer servers are configured and monitored only in Infrastructure, independently from media connections and Proxmox environments;
- each Portainer connection verifies its API version and authenticated user, then reads bounded environment, stack, and Docker/Podman container inventories through fixed routes;
- the Portainer inventory groups containers by server and environment, keeps identity, stack, runtime, unique reported ports, and controls visually separate, marks internal-only ports explicitly, and adapts from compact desktop rows to mobile cards without a wide table;
- stopped Portainer containers remain informational, while unreachable environments and genuinely unhealthy, dead, or restarting containers report their specific failure;
- infrastructure monitoring remains read-only; controls are limited to Portainer container start, restart, and graceful stop plus Proxmox QEMU/LXC start, reboot, and graceful shutdown, and every command uses Helmsman's accessible in-app confirmation instead of a browser-native prompt;
- Helmsman has no delete, remove, force-stop, reset, kill, migration, backup, restore, reconfiguration, bulk-action, shell, SSH, console, Docker-socket, or host-mount capability;
- container-side checks continue when every browser is closed;
- repeated failures become deduplicated incidents after two matching results, with aligned open and recovered panels;
- the top assessment summary opens Media Health or Infrastructure Incidents for the active workspace;
- service, capability, and end-to-end pipeline health are shown separately;
- queue, request, download, import, schedule, missing-media, and subtitle-backlog views are derived from bounded normalized records; the last successful snapshot and successful raster artwork may be persisted privately under `/data/cache`, while raw service responses and credentials are never cached;
- current structured health reports from supported service APIs can be shown only to authenticated browsers after bounding, redaction, and escaping;
- the supplied Helmsman helmet is the sidebar, mobile, browser, and installable-app identity, and the interface uses its near-black Obsidian Glass operations-console palette with smoked surfaces, graphite rules, restrained green state accents, and subtle blue-violet ambient depth;
- credentials are encrypted in the container and are write-only through the interface;
- private-network access defaults to exact per-connection host approvals, with manual CIDR ranges available as an advanced boundary;
- the exact enrolled Jellyfin administrator signs in with a username and password to receive a revocable, 30-day, origin-bound HttpOnly session; passwords and internal Jellyfin identity IDs never reach browser storage, and each resulting Jellyfin token is encrypted server-side per session;
- Caddy, Authentik, and any other compatible HTTPS/MFA edge remain optional and do not replace credentials for the upstream systems.

## Deploy the published container

Helmsman is distributed as the public Linux AMD64/ARM64 image `ghcr.io/nunesg130-boop/helmsman`. The `v1.15.0` Git tag runs the contracts and architecture smoke tests, publishes the version, `latest`, and full-commit image tags, and creates a GitHub Release containing ready-to-use `compose.yaml`, `container.env.example`, and `SHA256SUMS` assets. The release deployment files pin `ghcr.io/nunesg130-boop/helmsman` to the exact multi-architecture manifest digest (`@sha256:...`).

Download those three files from the matching [GitHub Release](https://github.com/nunesg130-boop/helmsman/releases) into one directory, verify the two deployment files against `SHA256SUMS`, open a terminal there, and make sure Docker Desktop or Docker Engine is running. No source checkout, Dockerfile, Node.js installation, or server-side image build is required.

Windows PowerShell:

```powershell
$Expected = @{}
Get-Content .\SHA256SUMS | ForEach-Object {
  if ($_ -notmatch '^([0-9a-fA-F]{64})  (compose\.yaml|container\.env\.example)$') { throw "Invalid SHA256SUMS entry: $_" }
  $Expected[$Matches[2]] = $Matches[1].ToLowerInvariant()
}
foreach ($File in 'compose.yaml','container.env.example') {
  if ((Get-FileHash -Algorithm SHA256 $File).Hash.ToLowerInvariant() -ne $Expected[$File]) { throw "Checksum mismatch: $File" }
}
Copy-Item .\container.env.example .\.env
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

Linux or macOS:

```sh
sha256sum --strict --check SHA256SUMS
cp container.env.example .env
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

The canonical GHCR package is public, so Docker pulls it anonymously. A private
fork may require its own registry authentication; never place a registry token
in `.env`, Compose YAML, the repository, or shell history. Repository and GHCR
package visibility are separate GitHub settings.

On the Docker host, open `http://127.0.0.1:4180`. From another computer,
keep the default loopback bind and create an SSH tunnel first:

```sh
ssh -L 4180:127.0.0.1:4180 user@your-helmsman-host
```

Then open `http://127.0.0.1:4180` locally. For permanent remote access, put
Helmsman behind a trusted HTTPS reverse proxy and firewall the inner port to
that proxy; the first claim is rejected over untrusted remote HTTP. Paste the
newest one-time setup token from the container log and complete the claim to
open the setup session; Helmsman derives the browser name automatically. Add
and verify the Jellyfin connection under Media **Connections**, then enroll its
exact administrator under Settings by entering only the Jellyfin username and
password. Helmsman
obtains the stable server and user IDs itself and never asks for or displays
them. Subsequent browsers sign in with that same Jellyfin account and receive
their own 30-day HttpOnly sessions. The default **Exact service addresses** network mode
needs no CIDR list: when you register a private media service, Proxmox endpoint,
or Portainer server, Helmsman stores only its currently resolved safe private
addresses as `/32` or `/128` approvals for that connection. Manual private
CIDRs remain available as an advanced, intentionally broader registration
boundary. Service and endpoint URLs and credentials are entered in the
interface, not `.env`.

If Docker reports that `dockerDesktopLinuxEngine` or its named pipe cannot be found, start Docker Desktop, wait until it says the engine is running, select Linux containers, and run the commands again.

The guarded future-release workflow is in [GITHUB.md](GITHUB.md). Detailed installation, update, rollback, source-build, and release instructions are in [deploy/DOCKER.md](deploy/DOCKER.md).

## Maintainers: publish future versions

This section is for maintainers of the canonical repository, not for normal
installation. Operators should use the signed, checksum-listed release assets
above.

Use local source builds while a version is still experimental, then publish
each version that is intended for a deployment host. The same launcher works
for every future prerelease or stable version and on any Windows computer; it
does not contain a release-number-specific path or command.

Every full source archive includes `Publish-Helmsman.cmd` and
`Publish-Helmsman.ps1` at its root. Extract the archive, then double-click
`Publish-Helmsman.cmd`. The launcher detects the release version from that
source's `package.json` and uses it for the entire publication. To start it
from PowerShell instead:

```powershell
Set-Location "C:\path\to\the\extracted\helmsman"
.\Publish-Helmsman.ps1
```

Do not manually copy release files into `helmsman-github`; the launcher safely
prepares and synchronizes the selected source for you.

On a new computer the launcher checks or installs Git, requires GitHub CLI
2.57.0 or newer, opens the GitHub sign-in when necessary, verifies the exact active account, confirms write
access to the canonical `nunesg130-boop/helmsman` repository, and requires both
the `repo` and `workflow` permissions. It then verifies noninteractive HTTPS
Git access and rejects SSH or Git URL rewrites before creating or validating
the persistent `%USERPROFILE%\Downloads\helmsman-github` clone and configuring
the repository-local Git author. If that managed clone is incomplete, dirty, on a
different branch, uses a noncanonical remote, or contains the clean unpublished
commit from an interrupted release, the launcher preserves it and uses
`%USERPROFILE%\Downloads\helmsman-github-recovery` as the persistent clone.
An incompatible occupied recovery path is also preserved; the launcher safely
advances to `helmsman-github-recovery-2`, then a bounded numeric suffix when
necessary. A verified clean HTTPS recovery clone is reused on later
runs. Extract the complete release with Windows before
starting the publisher. Prefer a normal local folder such as
`C:\Helmsman-Releases`; if OneDrive marks the extracted tree as a cloud
placeholder or reparse point, move or re-extract it there. A standalone
launcher copy kept outside both the source and persistent clone prompts for
that extracted release folder. You may
select either the outer version folder that contains `helmsman` or the inner
`helmsman` source folder itself. From PowerShell, `-SourcePath` accepts either
folder form as well. Do not run the root launcher from `helmsman-github`: it
intentionally refuses the publishing clone so it cannot overwrite itself. It
safely prepares the source before publishing and never copies credentials,
`.env`, or runtime state into the repository.

The launcher verifies the extracted release's guarded publisher against its
bound SHA-256 identity, then gives it the validated source and independently
verified clean clone. That publisher performs static source validation, stages
the source, shows the review summary, and asks once for the exact
`PUBLISH <detected-version>` confirmation. After confirmation it pushes
`main`, requires the workflow for that exact commit to pass, publishes the
version tag, requires the tag workflow to pass, and verifies the GitHub Release
assets. It downloads the verified digest-pinned `compose.yaml`,
`container.env.example`, and `SHA256SUMS` into a new local deployment-assets
directory beside the source folder.

The publisher deliberately does not execute candidate source while maintainer
GitHub credentials are available. The mandatory hosted `main` and version-tag
workflows run the release tests in GitHub Actions before the publisher advances
to the next boundary.

Three prompts remain intentionally human-controlled:

- Windows installation or UAC approval if Git or GitHub CLI is missing;
- browser-based GitHub authentication once on each computer, and again if the
  saved authorization expires; and
- the exact `PUBLISH <detected-version>` release confirmation.

The launcher is part of the full source tree and source archive. It is not an
additional GitHub Release deployment asset; releases continue to publish the
same three digest-verified deployment files.

It never logs into or changes a deployment host. After publication it only
prints the PowerShell `scp` commands and manual `/opt/helmsman` update block.
That block verifies the transferred checksums, backs up both Compose and the
existing `.env`, installs the verified digest-pinned Compose file, preserves
all existing `.env` settings except canonicalizing `HELMSMAN_IMAGE`, creates a
mode-`0600` `.env` from the verified example when none exists, unsets shell
image and Compose-selector overrides, fixes the Compose file/env inputs, and
refuses to deploy unless Compose resolves the exact verified digest. Rollback restores both
Compose and `.env`. Cancellation before
the commit leaves the reviewed changes staged and makes no GitHub change; see
[GITHUB.md](GITHUB.md) for inspection, recovery, transfer commands, and the
advanced manual publisher fallback.

## Privacy and storage

There is no vendor cloud, hosted account, telemetry, analytics, advertising, tracking pixel, remote font, or runtime CDN dependency. The local container is technically a backend, but it belongs entirely to the operator and makes no outbound request except to explicitly registered media-service and infrastructure APIs.

| Location | Stored data |
|---|---|
| Browser | A revocable, 30-day, origin-bound HttpOnly session cookie, a per-session CSRF value, and non-secret presentation state; never the Jellyfin password or token |
| `/data/state.json` | Instance, network policy, media connections, Proxmox environments and endpoints, Infrastructure service records such as Portainer and Loki, discovered identities, exact URLs, and per-connection private-host approvals |
| `/data/sessions.json` | The enrolled owner's bounded Jellyfin identity binding and browser-session hashes, authenticated with the credential master key; never the password or bearer token. A beta.2 access-key verifier can exist only until owner enrollment finishes |
| `/data/credentials.json` | AES-256-GCM ciphertext and authenticated metadata, including destination-bound connector credentials and separate per-session Jellyfin login tokens |
| `/data/network-map.json` | The owner's Network page layout: zones, items, connections and optional live-source references by node name, VMID, container name or service id. Not encrypted and never contacted by Helmsman, so keep secrets out of item notes |
| `/data/credentials.key` | Auto-generated local encryption key, unless the environment-sourced Docker secret is enabled |
| `/data/logs/helmsman-events-*.jsonl` | Private, sanitized Helmsman operational events. The defaults retain no more than 14 days and 50 MiB across bounded segments |
| `/data/cache/operations-v1.json` | The last successful bounded normalized operations snapshot, retained for no more than 30 days and marked read-only when restored; never raw responses or credentials |
| `/data/cache/artwork/*.art` | Successful validated raster artwork only, keyed by connector revision and limited to 2,048 entries, 512 MiB total, 4 MiB per image, and 30 days |
| In-memory operations snapshot | The current live or explicitly marked cached view model used by the UI; never raw responses |

Saved credentials cannot be read back through the API. Each credential is bound to its connection's exact canonical destination; changing that URL requires a fresh credential, and offline URL tampering cannot redirect the old one. Replacing a credential overwrites it; removing a connection removes its encrypted credential. Proxmox token IDs and token secrets, Portainer access tokens, and Loki basic or bearer credentials are write-only just like media credentials. The monitor parses every response at a strict boundary and discards raw response bodies, headers, usernames, URLs, credentials, and unbounded error text. The authenticated UI receives only the normalized media fields needed for the desktop workflow, including bounded titles, provider identifiers, current states, progress, dates, and sanitized queue errors. Jellyfin Now Playing reads only the bounded current media item and play state; user, device, client, network, and stream-session metadata are discarded. The current normalized snapshot and successful validated artwork can be persisted only in the separate bounded `/data/cache` area; neither is added to `state.json`, and cached state cannot authorize a control action.

The built-in journal stores only a fixed event schema: timestamp, severity,
category, outcome, and bounded identifiers or safe status codes when relevant.
Credentials, cookies, authorization headers, request bodies, upstream response
bodies, raw LogQL, and returned Loki lines are excluded. The journal is useful
for operational history, but it is not a raw debug log or a multi-user audit
trail. Its JSONL files are private data-volume contents and must be protected in
live storage, backups, diagnostics, and support bundles.

An authenticated browser may also receive the current live health reports built only from allowlisted `source`, `type`, and `message` fields in supported structured service health responses. Helmsman bounds their count and length, normalizes and redacts secret-like values, and the interface escapes them again before display. These report messages are transient evidence in the current operations snapshot only: they are never copied into incidents, the journal, history, application logs, or persistent files. A derived health transition may record its safe service, capability, state, and code without copying that message. Raw response bodies and raw error bodies are never exposed. Service-authored reports can still contain non-secret operational details such as paths or hostnames, so treat access to the authenticated interface as sensitive.

The easy local mode keeps its generated encryption key beside ciphertext in the protected Docker volume. That protects against accidental disclosure and ciphertext-only copies, but it is not a separate trust boundary if an attacker steals the entire volume or controls the host. For encrypted backups or external deployments, use the optional Docker-secret key described below.

Protect backup history like the live volume. Authorization-state integrity detects forged edits but is not a hardware-backed monotonic counter, so replaying an older complete, valid backup rolls access state back to that snapshot. After intentionally restoring a backup that predates an owner or browser-access change, run `reset-access --confirm` and enroll the intended owner again.

## Security boundary

Helmsman is not a general-purpose proxy. Every outbound request must pass all of these checks:

- the media service, Proxmox endpoint, Portainer server, or Loki service has an exact registered destination;
- the connector allows that exact method, API path, query shape, and, for an action, fixed request-body template;
- in the default mode, every current private A and AAAA result matches the connection's saved exact `/32` or `/128` approvals; manual CIDRs can instead authorize a deliberately broader private range;
- loopback, link-local/cloud metadata, multicast, unspecified, reserved, broadcast, and mixed-policy DNS results are always rejected, regardless of mode;
- public HTTP is always rejected; public HTTPS requires the operator to enable it explicitly;
- the outbound socket is pinned to a validated address while preserving the TLS hostname;
- redirects, HTML API responses, unsupported content types, oversized bodies, excessive concurrency, and timeouts fail closed;
- browser mutations require an origin-bound HttpOnly session plus a per-session CSRF value.

The image runs as UID/GID 10001 with a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, bounded memory/PIDs/CPU, no Docker socket, and no host network. The fixed action routes use only saved upstream API credentials and do not grant Helmsman SSH, a shell, a hypervisor console, a generic Docker API, or host-filesystem access.

Monitoring and probes remain fixed read-only GET routes. Actions are separate requests built from fixed method, path, query, and body templates and gated by an accessible Helmsman confirmation dialog. The target and current revision are checked again after approval before dispatch. The browser selects only a supported action and a current normalized record; it cannot supply an arbitrary upstream path or request body. Helmsman exposes no general media-service, Proxmox, Portainer, Loki, or Docker API proxy and no generic delete, remove, force-stop, reset, kill, or bulk action. Its sole removal path is the exact confirmed blocked-queue recovery described below.

## Media and Infrastructure workspaces

Use the workspace switcher to keep media activity separate from host, virtualization, and container-platform health. Media navigation contains **Overview**, **Discover**, **Library**, **Requests**, **Activity**, **Calendar**, **Health**, and **Connections**. Logs and Settings remain global. Search and filters operate only on the bounded records already returned by configured services; Helmsman does not send free-form discovery searches or arbitrary management commands upstream.

Overview keeps existing data visible while a refresh is in flight and patches volatile progress, speed, ETA, state, counts, and timestamps in place. Its Now Playing signal comes from one fixed, bounded Jellyfin sessions query and omits session identity metadata. Continue Watching leads only when Jellyfin supplies current resume data; otherwise Downloads & Imports is promoted into that position. Requests and service warnings share the attention card, while compact columns continue to distinguish connection health from service health. Initial loads may use placeholders, but polling does not deliberately replace the whole page or reset stable artwork URLs. Discover presents Seerr's read-only discovery feed; items without a request are labeled **Not requested** rather than exposing an internal unknown state, and only Jellyfin evidence can label a title available in Helmsman's library. Library correlates Jellyfin availability with Radarr/Sonarr monitoring and import state. Requests preserve separate request IDs, approval state, acquisition state, requested seasons, and 4K scope; completed workflow rows become **Available** from Seerr's media availability, an exact Jellyfin movie match, or—when a series request is season-scoped—the matching Seerr media-season availability rather than the request-season workflow status. Activity and Calendar expose current read-only workflow state, while Health contains pipeline/service incidents and Connections owns service enrollment.

The only Media writes are a Helmsman-confirmed Seerr failed-request retry, a selected standard-season request for one exact current series through Seerr, a targeted Radarr/Sonarr search when Helmsman can resolve one exact current record, and **Block release & search again** for one exact current errored Sonarr/Radarr queue item. The blocked-queue action warns that it removes the download and its data from the download client, blocklists that release, and allows Sonarr/Radarr to seek a replacement according to its settings. It appears only from fresh, connected, revision-matched error evidence and is revalidated after its explicit danger confirmation. Series and parent-resolved episode drawers load a bounded current season catalog from Seerr on demand. The operator can select requestable standard seasons, review the exact selection in Helmsman's confirmation dialog, and submit one standard-quality request. Specials, 4K selection, arbitrary Seerr users, servers, profiles, root folders, and request bodies are not exposed. Helmsman revalidates the current record, target revision, and action-specific detail immediately before dispatch. Each action uses a Helmsman-styled confirmation dialog; browser-native confirmation prompts are not used. Helmsman cannot approve requests or delete requests, request movies or 4K/Specials, choose Seerr routing/profile fields, change monitoring, pause downloads, remove healthy or arbitrary downloads, alter any other files, or run a free-form search.

Each media record uses provider and service identifiers to join evidence from multiple systems. Its five-stage lifecycle indicates which of **Requested**, **Monitored**, **Downloading**, **Imported**, and **Available** have actually been observed rather than inferring progress from position alone. qBittorrent transfers are correlated to Sonarr/Radarr queue rows by download identifiers; a bounded sanitized queue error is displayed when the service supplies one. Titles, identifiers, progress, and bounded sanitized errors may appear in the last normalized persistent snapshot so the dashboard can recover after a restart; the UI clearly marks that data cached until a live cycle replaces it.

Artwork descriptors never reach the browser. The browser receives an opaque same-origin `/api/v2/media/artwork/<key>` URL, and the authenticated broker tries only fixed service-owned artwork routes in this order: Jellyfin, Radarr/Sonarr, then Seerr. Grid requests use a revisioned 342 px Jellyfin or Seerr thumbnail and try fixed 250 px, 500 px, then original Radarr/Sonarr covers. When Sonarr exposes only TVDB remote artwork, Helmsman uses the series' validated TMDb identifier for a typed Seerr metadata lookup and then requests only Seerr's fixed TMDb image-proxy route; it never follows the remote artwork URL. Duplicate misses are coalesced, and a bounded scheduler permits at most three upstream artwork fetches at once with 64 pending requests. Successful images are cached in memory for up to 24 hours and in the private persistent artwork tier for up to 30 days. General failures are cached only in memory for 15 minutes, versioned Arr cover misses for 30 seconds, and unrevisioned Arr misses are not negative-cached. The memory tier is limited to 512 entries and 32 MiB; the persistent tier is limited to 2,048 entries and 512 MiB. Both accept at most 4 MiB per image and only bounded raster types. Persistent entries are content-verified, keyed by the exact connector revision, protected against link traversal, and written atomically. Browser responses use an ETag, a one-day private cache lifetime, and one-week stale revalidation/error windows.

Infrastructure navigation contains **Overview**, **Connectors**, **Proxmox**, **Workloads**, **Portainer**, and **Incidents**. Overview shows only connections that are already configured and their current read-only status; the always-available categorized Connectors view lists every supported provider and owns setup and connection editing. Proxmox and Workloads appear only after a Proxmox environment is configured, while Portainer appears only after a Portainer connection is configured. Loki is enrolled in the **Observability** category and queried from the global **Logs** workspace instead of receiving an infrastructure inventory page. Helmsman supports up to 25 Proxmox environments and 25 total endpoints, with no more than four endpoints in one environment. An environment is either a standalone server or one multi-node cluster. The combined Proxmox view presents environments, nodes, and a dedicated storage section with current sanitized status and capacity information.

To add Proxmox, open **Infrastructure → Connectors**, select **Proxmox VE**, and enter:

- a display name;
- the full HTTPS URL reachable from inside the container, normally `https://host-or-ip:8006`;
- **System trust** for a publicly or privately trusted certificate, or **Pinned SHA-256 fingerprint** for a self-signed/local certificate;
- the full API token ID and generated token secret;
- whether the environment should be monitored continuously.

There is no insecure “ignore certificate errors” mode. A pinned fingerprint authorizes only that exact certificate and must be reviewed after a legitimate certificate replacement. **Discover environment** checks the endpoint without saving it, identifies it as standalone or clustered, and lists the visible nodes for confirmation. Helmsman refuses to save a connection whose identity cannot be established. Changing the URL, TLS identity, token, or discovered environment requires a fresh successful discovery.

For a self-signed certificate, run `pvenode cert info` directly on the Proxmox host console and copy the SHA-256 fingerprint for the certificate served by `pveproxy`. Verify it through that trusted console; do not accept a fingerprint learned only through the same network connection you are enrolling.

After saving an environment, additional cluster-node endpoints can be registered as failover paths. Every alternate URL, certificate trust choice, and token must be entered and verified explicitly. The endpoint must report the same stable cluster or standalone identity as the environment; discovered IP addresses are never trusted automatically. Helmsman does not automatically combine existing configurations, even if they later appear to describe the same cluster.

Each monitoring cycle tests endpoint availability, selects one healthy matching endpoint, and collects the cluster-wide inventory once. The snapshot contains a bounded node, VM/LXC, storage, recent-task, and recent-backup inventory alongside derived health metrics and sanitized reports. Recent tasks and backup history are collected through each visible node's fixed read-only task route, then merged once with node identity retained; raw UPIDs, command-bearing status text, and raw Proxmox responses are not exposed. If one API certificate or route fails but the cluster remains queryable through another approved endpoint, the failed endpoint is shown as unavailable while the actual node state continues to come from the cluster inventory; the environment is Limited rather than Down. A confirmed workload action can start, reboot, or gracefully shut down one current QEMU VM or LXC through the selected environment's fixed API route. Node, storage, backup, migration, restore, configuration, console, and forced power operations are not available.

### Portainer under Infrastructure

Portainer is a separate Infrastructure service, not a Media connection. Open **Infrastructure → Connectors**, select **Portainer**, and register up to eight independent servers. After the first connection is saved, the dedicated Portainer inventory view becomes available in the sidebar. For each server, enter:

- a display name;
- its full HTTPS base URL, normally `https://host-or-ip:9443`;
- **System trust** for a publicly or privately trusted certificate, or **Pinned SHA-256 fingerprint** for a self-signed/local certificate;
- a durable Portainer access token; and
- whether continuous monitoring is enabled.

Helmsman sends the token in Portainer's `X-API-Key` request header and never returns it to the browser. The connection test verifies the Portainer status API and the token with the authenticated-user endpoint before anything is saved. Portainer 3.x is detected through `/api/system/status`; Helmsman falls back to the legacy `/api/status` route only when the newer route returns HTTP 404.

Monitoring uses fixed read-only GET routes for environments, stacks, and Docker-compatible container inventories. Helmsman can list multiple Docker or Podman environments behind one Portainer server; Kubernetes and Azure environments can appear in the environment inventory but are not queried through the Docker container route. Containers are grouped by server and environment in responsive rows that keep identity, stack, runtime, deduplicated port chips, and actions separate; a private-only port is labeled internal instead of being presented as published. The normalized snapshot discards endpoint addresses, credentials, raw labels, raw stack definitions, and raw responses. A confirmed action may start, restart, or gracefully stop one current Docker-compatible container. There is no general Portainer or Docker API proxy, and Helmsman never mounts the Docker socket.

The Portainer page reports online/offline environments, running/stopped/restarting/unhealthy container counts, stacks, and bounded per-environment errors. A deliberately stopped container is informational and does not degrade health. Each server probe has a 45-second monitoring deadline and leaves request capacity available for the rest of Helmsman; if it expires, completed data remains visible and `PORTAINER_INVENTORY_PARTIAL` explains that unfinished coverage will be retried next cycle. Portainer access tokens inherit the permissions of their Portainer user, so create a dedicated least-privilege Portainer user or team limited to the visible environments and the required container lifecycle actions; do not reuse an administrator token.

### Built-in logging and Loki

The **Logs** workspace has four views: an overview, **Helmsman logs**,
**Server output** (what Helmsman has printed since it started, scrubbed of
secrets), and **Loki Explorer**. Debug logging, switched on for a few hours
under **Settings → Logging**, adds every health check, service request and
agent step to the Helmsman log; the Download button saves the filtered log as
JSON Lines. The built-in view queries the sanitized journal stored in
`/data/logs`; it works without Loki, Grafana, or another database. The journal
defaults to 14 days and 50 MiB total, rotates through bounded JSONL segments,
and prunes older segments when either retention boundary is exceeded.

To add Loki, open **Infrastructure → Connectors → Observability**, select
**Grafana Loki**, and enter its container-reachable base URL. Supported
authentication modes are none, HTTP Basic, and bearer token, with an optional
tenant ID sent as `X-Scope-OrgID`. Basic and bearer credentials are encrypted,
write-only, and may be used only over HTTPS. HTTPS requires either normal
system certificate validation or an explicitly reviewed SHA-256 leaf
certificate fingerprint; there is no ignore-certificate-errors mode. Plain
HTTP is accepted only with no authentication and only when the destination
passes Helmsman's private-network policy. Public HTTP remains prohibited.

Loki monitoring uses fixed readiness, build-information, and label-list
checks. Interactive search uses only Loki's read-only `query_range`
endpoint with a bounded time window, line count, response size, and timeout.
Helmsman does not expose Loki push, delete, ruler, configuration, administrative,
live-tail, or caller-selected API routes. The returned lines and stream labels
are normalized, bounded, and shown transiently; they are not written to the
built-in journal. Because they originate in other systems, they can still
contain sensitive operational data. Protect the authenticated UI and avoid
sharing screenshots or copied results without review.

Grafana is optional. Use it when its dashboards, alerts, or broader exploration
are useful; Helmsman's connector communicates directly with Loki and does not
need Grafana to provide its focused in-dashboard explorer. For upstream
behavior, see Grafana's [Loki HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/)
and [authentication guidance](https://grafana.com/docs/loki/latest/operations/authentication/).

### Agent and local AI

Helmsman can run an agent that watches for incidents, explains them with a
small model on your own hardware through any OpenAI-compatible server
(Ollama, LM Studio, llama.cpp, vLLM), sends notes to your phone through Home
Assistant, writes a daily digest, and runs owner-written rules such as
"restart the sonarr container when Sonarr has been down for 5 minutes".
Rules are checked by Helmsman's code, never by the model; anything the model
suggests waits for the owner's approval. It's off until configured. See
[docs/LOCAL-AI.md](docs/LOCAL-AI.md).

## Credentials

Use dedicated, least-privilege credentials where the service supports them:

| Service | Helmsman credential |
|---|---|
| Jellyfin | Dashboard API key, user access token, or one-time username/password exchange |
| Seerr | Global API key, or one-time local account email/password exchange |
| Radarr, Sonarr, Prowlarr, Bazarr | API key |
| qBittorrent | `qbt_` API key from qBittorrent 5.2 or newer |
| Proxmox VE | Dedicated API token ID and token secret scoped to inventory plus the selected guest power actions |
| Portainer | Durable access token for a dedicated user scoped to visible environments and allowed container lifecycle actions, sent as `X-API-Key` |
| Grafana Loki | None, reverse-proxy Basic credentials, or a bearer token; optional `X-Scope-OrgID` tenant |

Passwords are not retained. The Jellyfin credential saved with the Media connection is the monitoring connector credential: enter a Dashboard API key or existing user access token directly, or let Helmsman exchange a username and password once. Browser authentication is deliberately separate. The enrolled Jellyfin administrator enters a username and password for each new browser session; Helmsman discards the password immediately and encrypts the resulting user token server-side for only that session. It never substitutes the monitoring connector credential for the owner login. For Seerr, enter the global API key from Settings > General, or use a native local account email and password for a one-time exchange; Seerr local authentication must be enabled, and Helmsman discards the password and encrypts only the resulting session. Older qBittorrent password/SID mode is deliberately not used for unattended monitoring.

For Proxmox, create a dedicated user and API token with only the inventory privileges needed for the selected resources plus `VM.PowerMgmt` on the specific guests or pool Helmsman may control. Enter the complete token ID in the form `user@realm!token-name` and its generated secret. Helmsman encrypts both fields and never returns either value to the browser. Each approved endpoint keeps destination-bound encrypted credentials, so one endpoint cannot silently reuse another endpoint's credential against a changed host. Do not use `root@pam`, a password, a root API token, or an administrator token, and do not grant power-management privileges outside the intended guests. Proxmox environments are configured in the Infrastructure workspace; do not place their URLs or credentials in `.env`.

For Portainer, generate an access token for a dedicated user whose visible environments and container lifecycle permissions are limited to what Helmsman should monitor and control. Enter the token once in the Portainer connection form; Helmsman encrypts it, binds it to that server's exact destination and TLS identity, and exposes only whether a credential is configured. Do not place the Portainer URL or token in `.env`. Portainer access tokens inherit their user's permissions; Helmsman's fixed monitoring and action routes reduce its own request surface but cannot make an overprivileged Portainer account least-privilege.

For Loki, use no authentication only on a trusted private path, or configure a
least-privilege read credential at the reverse proxy or hosted Loki endpoint.
Basic and bearer credentials require HTTPS. Helmsman encrypts them, binds them
to the exact Loki destination and TLS identity, and never returns their values
to the browser. Do not put the Loki URL, credential, or tenant ID in `.env`.

## Browser access and recovery

Fresh setup uses the one-time setup token only to claim the instance and open the setup session. Configure and verify one Jellyfin connection, then use Settings to enroll its exact enabled administrator with a username and password. Helmsman learns and binds the stable Jellyfin server ID and user ID internally; neither ID is requested from or displayed to the operator. Another Jellyfin user—including another administrator—cannot sign in as the Helmsman owner.

Every subsequent browser shows only Jellyfin username and password fields. The unauthenticated status and login screen do not disclose the enrolled username. A successful login creates a revocable 30-day session bound to the exact scheme, host, and port. The browser receives an HttpOnly, `SameSite=Strict` session cookie and a per-session CSRF value, never the Jellyfin token. Helmsman immediately discards the submitted password and stores the resulting Jellyfin access token as server-side AES-256-GCM ciphertext scoped to that session. The ciphertext authentication data binds the token to the browser-cookie verifier and immutable session claims as well as the exact Jellyfin URL, target revision, approved address pins, and network policy. The owner binding and authorization-critical session index are also authenticated with a key derived from the credential master key, so offline edits fail closed. A changed Jellyfin authorization boundary atomically revokes every browser session locally before any old token can be decrypted or sent elsewhere; the initiating browser returns to sign-in. Logout or ordinary session revocation erases that token and makes a best-effort Jellyfin logout request only when the original boundary remains current.

Helmsman forwards that one-time username/password exchange to the configured Jellyfin URL. Prefer Jellyfin HTTPS. A private `http://` Jellyfin URL remains supported for common homelab deployments, but it does not encrypt the password on the Docker/LAN hop; use it only when every host and network segment on that path is trusted.

The configured Jellyfin connection is required for enrollment, login, and identity validation, but its monitoring credential stays distinct from every browser-authentication token. Helmsman periodically validates the exact owner and requires the account to remain enabled and administrative. Explicit rejection, revocation, identity mismatch, disablement, or administrator demotion revokes the local session. When Jellyfin is unreachable, new logins fail; a recently validated session may retain bounded read-only access during a transient outage, while state-changing actions require fresh validation and fail closed.

Authentik remains an optional external identity and MFA layer. Jellyfin's username/password exchange itself does not perform an Authentik challenge, so externally reachable deployments should keep Authentik or an equivalent MFA-capable edge in front of every Helmsman path and prevent direct access to port 4180.

Recovery must use the same Compose file stack that owns the running installation. If an optional override was used to deploy, add it to **every** `stop`, `run`, `up`, and `logs` command below:

| Installation | Compose command prefix |
|---|---|
| Fresh local install | `docker compose` |
| Upgrade using the v0.5 volume | `docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml` |
| Fresh install with external key | `docker compose -f compose.yaml -f deploy/compose.hardened.yaml` |
| v0.5 volume and external key | `docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml` |

For either hardened row, export the same `HELMSMAN_MASTER_KEY` before running any command and unset it afterward. Substituting a different key cannot recover the stored credentials.

If the enrolled Jellyfin owner can no longer authenticate and no browser session can repair the connection or enrollment, reset browser access from the Docker host:

```sh
docker compose stop helmsman
docker compose run --rm --no-deps helmsman reset-access --confirm
docker compose up -d
```

This is the sole break-glass path. It removes the owner binding, revokes every Helmsman browser session, and destroys Helmsman's encrypted copies of the browser-authentication tokens while preserving service URLs, the instance and network policy, registered targets, and encrypted monitoring credentials. Because this recovery command runs with the broker stopped, it cannot send Jellyfin logout requests; if a token may have been copied outside Helmsman's encrypted store, use Jellyfin's administration controls to invalidate that upstream session too. The next start emits a new one-time setup token so the operator can claim the instance and enroll an enabled Jellyfin administrator again. It does not create, print, or restore a reusable access key. The main service must stay stopped while the one-off container writes the shared `/data` volume.

When upgrading from v1.0.0-beta.2, its reusable access key is accepted only as a temporary migration credential. Use an existing browser session or that legacy key to open Settings, make sure the Jellyfin connection is configured, and enroll the owner. Successful enrollment atomically removes the access-key verifier and revokes every legacy browser session; v1.0.6 and later cannot create, reveal, or rotate another key. If no beta.2 session or key remains usable, use `reset-access --confirm` as described above.

If the credential encryption key is lost or the configured key no longer matches, the ciphertext cannot be recovered. Stop the service and reset the credential store and browser-access seal, using the same command prefix selected above:

```sh
docker compose stop helmsman
docker compose run --rm --no-deps helmsman reset-credentials --confirm
docker compose run --rm --no-deps helmsman reset-access --confirm
docker compose up -d
```

This preserves the instance, network policy, and registered service targets. It moves `credentials.json` and, in easy local mode, `credentials.key` to timestamped `*.unrecoverable-*` quarantine files. Because the same master key authenticates the owner/session authorization state, the required `reset-access` step removes the no-longer-verifiable owner binding and browser sessions; after restart, claim the instance and enroll the Jellyfin owner again. An externally managed master-key file is never modified. For a hardened deployment, export the valid replacement key and retain `-f deploy/compose.hardened.yaml` on every command; otherwise the service could restart in the wrong key mode. Then enter replacement service credentials in the interface and rotate the old credentials at their source. Quarantine files remain sensitive recovery material; keep them private and remove them only after the replacement configuration is verified.

Do not use `docker compose down -v` unless you intentionally want to erase all configuration and encrypted credentials.

## Optional stronger key separation

For normal same-computer use, no extra setup is required. To keep the master key outside the data volume, store a 64-character hex key outside the project and `.env`, export it only when Compose creates or recreates the container, and use the optional override.

This option requires a Docker Compose release that supports top-level secrets sourced from an environment variable. Run `docker compose config` before deployment; if it rejects `environment:` under `secrets:`, update Docker Compose. Compose materializes the value as a rootless-readable, mode `0400` file inside the container—the key is not placed in the container environment.

Linux or macOS:

```sh
helmsman_key_directory="${XDG_CONFIG_HOME:-$HOME/.config}/helmsman"
helmsman_key_file="$helmsman_key_directory/master-key.hex"
install -d -m 700 "$helmsman_key_directory"
if [ ! -e "$helmsman_key_file" ]; then
  (umask 077 && openssl rand -hex 32 > "$helmsman_key_file")
fi
chmod 600 "$helmsman_key_file"
export HELMSMAN_MASTER_KEY="$(tr -d '\r\n' < "$helmsman_key_file")"
test "${#HELMSMAN_MASTER_KEY}" -eq 64
docker compose -f compose.yaml -f deploy/compose.hardened.yaml config
docker compose -f compose.yaml -f deploy/compose.hardened.yaml pull
docker compose -f compose.yaml -f deploy/compose.hardened.yaml up -d
unset HELMSMAN_MASTER_KEY
```

PowerShell:

```powershell
$helmsmanKeyDirectory = Join-Path $env:LOCALAPPDATA 'Helmsman'
$helmsmanKeyFile = Join-Path $helmsmanKeyDirectory 'master-key.hex'
New-Item -ItemType Directory -Force $helmsmanKeyDirectory | Out-Null
if (-not (Test-Path -LiteralPath $helmsmanKeyFile)) {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    $generator.GetBytes($bytes)
    $generator.Dispose()
    $helmsmanKey = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    [IO.File]::WriteAllText($helmsmanKeyFile, $helmsmanKey)
}
$env:HELMSMAN_MASTER_KEY = (Get-Content $helmsmanKeyFile -Raw).Trim()
if ($env:HELMSMAN_MASTER_KEY.Length -ne 64) { throw 'Master key must be 64 hexadecimal characters.' }
docker compose -f compose.yaml -f deploy/compose.hardened.yaml config
docker compose -f compose.yaml -f deploy/compose.hardened.yaml pull
docker compose -f compose.yaml -f deploy/compose.hardened.yaml up -d
Remove-Item Env:\HELMSMAN_MASTER_KEY
Remove-Variable bytes, helmsmanKey -ErrorAction SilentlyContinue
```

Protect and back up that external key file separately. Export the exact same key for every redeploy, container recreation, migration, and restore. Do not enable the override after credentials already exist unless the same key that encrypted them is supplied; a wrong or missing key intentionally prevents startup. Never put the key in `.env`, Compose YAML, shell history, or the release directory.

## Caddy and Authentik are optional

- `http://127.0.0.1:4180` on the Docker host needs neither Caddy nor Authentik.
- Remote browser access needs trusted HTTPS, but the gateway can be Caddy, Traefik, Nginx, a VPN HTTPS feature, or another correctly configured reverse proxy.
- Authentik is an optional access/MFA layer. It protects entry through the edge; it does not encrypt the volume, protect backups, or help if the inner container port remains directly reachable.

Edge authentication protects browser access only. It does not authenticate Helmsman to Jellyfin, Seerr, Proxmox, Portainer, or another monitored system, so each upstream system still requires its own supported credential.

Jellyfin-backed browser login does not replace a Cloudflare Tunnel, Caddy, or Authentik deployment. Those layers continue to admit and proxy the browser first; after that, Helmsman authenticates the exact enrolled Jellyfin owner and issues its own origin-bound session. Authentik still owns external MFA, while upstream monitoring continues directly from the container with the separate saved connector credentials.

For external use, publish the container only on an address reachable by the edge, proxy every path unchanged, and firewall port 4180 so clients cannot bypass the HTTPS/Authentik route. Example Caddy configurations are in `deploy/`.

## Upgrade an existing Helmsman installation

Keep the existing Helmsman project directory and Compose file stack so Compose
reuses the current `helmsman-data` volume. Back up that volume, then use the
publisher's printed transfer and server blocks. They reverify the release
assets, back up both `compose.yaml` and the existing `.env`, preserve all
server-specific environment settings while replacing old `HELMSMAN_IMAGE`
assignments with one verified digest, and create `.env` from the verified
example if it was absent. They also unset a shell-level image override and
require Compose to resolve the exact release digest before these lifecycle
commands run:

```sh
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 helmsman
```

If the installation uses an override, include it in every command. These commands recreate the application container while preserving `/data`; do not run `docker compose down -v` during an update. Keep one known-good older digest-pinned image reference recorded before upgrading.

The production Compose file fixes the project name as `helmsman`, so fresh deployments consistently use the Docker volume `helmsman_helmsman-data` regardless of directory name. Before upgrading an older beta that was launched under a different Compose project name, run `docker volume ls`; set `COMPOSE_PROJECT_NAME` in `.env` to that previous project prefix before the first new `docker compose up`, or migrate the old volume deliberately. Do not continue with an unexpectedly empty instance.

To roll back application code, restore both
`compose.yaml.before-<version>` and `.env.before-<version>`, or remove the new
`.env` when none existed before the update. Unset `HELMSMAN_IMAGE`, inspect
`docker compose config --images`, and then repeat `docker compose pull` and
`docker compose up -d`. Do not roll an already migrated `/data` volume back
into an older image unless that release explicitly documents schema
compatibility; restore the matching pre-update volume backup instead.

v0.10 advances the state schema to 4 by adding an empty, bounded Infrastructure-services collection. Existing media connections, destination-bound encrypted credentials, browser sessions, network approvals, and Proxmox environments/endpoints remain in place; nothing is converted into or automatically combined with a Portainer connection. Its original unified media model and Portainer inventory required no catalog migration. v1.2.0 adds a separate disposable `/data/cache` without changing the state schema; it can always be rebuilt from current read-only service responses. Installations coming directly from an older schema still use the existing in-place migrations, including the rule that separate Proxmox targets are never merged automatically. Back up the volume before upgrading, and do not attempt to run an older image against state after it has been migrated.

v1.0.6 advances the state schema from 4 to 5 so Loki can be stored as a bounded Infrastructure observability service while preserving existing Portainer records exactly. Existing media connections, Proxmox environments, browser sessions, network approvals, and destination-bound encrypted credentials remain in place. Do not run v1.0.5 against state already migrated to schema 5; rollback requires restoring the `/data` volume backup taken before the v1.0.6 upgrade.

v1.5.0 advances the state schema from 5 to 6, storing media connections by their own id with a `type` field instead of by service name. Every connection keeps its other fields exactly, so encrypted credentials, sessions and approvals remain in place, and the interface still allows one connection per media service. Do not run v1.4.0 or older against state already migrated to schema 6; rollback requires restoring the `/data` volume backup taken before the upgrade.

For v0.10.0-beta.8 specifically, an existing browser session can be used to configure Jellyfin and enroll the exact administrator under Settings. If no prior session remains usable, run the `reset-access --confirm` sequence under **Browser access and recovery**; it preserves configuration and encrypted monitoring credentials, and the next start supplies a new one-time setup token.

## Upgrade from Jellofin Command v0.4 or v0.5

Back up the named volume and make sure the service credentials can be recovered or regenerated. First, from the old Jellofin Command directory, stop the old stack without `-v`:

```sh
docker compose down
```

Then open the extracted Helmsman directory, copy the environment example, and set `HELMSMAN_DATA_VOLUME` to the **exact existing** volume reported by `docker volume ls`. The standard v0.5 name is shown here, but inspect it before continuing:

```sh
cp container.env.example .env
# Edit .env and uncomment this upgrade-only setting:
# HELMSMAN_DATA_VOLUME=jellofin-command_jellofin-command-data
docker volume inspect jellofin-command_jellofin-command-data
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml config
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml pull
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml up -d
```

On PowerShell, replace the `cp` line with `Copy-Item .\container.env.example .\.env`. The upgrade override declares the old volume as external, so a misspelled or missing name fails instead of creating an empty volume. Fresh installs do not use this override and receive their own Compose-project-scoped volume.

If the v0.5 deployment used the hardened external key, export that exact key first and append `-f deploy/compose.hardened.yaml` to every `config`, `pull`, `up`, recovery, and operations command. For example, the first start must use all three files:

```sh
export HELMSMAN_MASTER_KEY="$(tr -d '\r\n' < /path/to/the/existing/master-key.hex)"
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml config
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml pull
docker compose -f compose.yaml -f deploy/compose.upgrade-v0.5.yaml -f deploy/compose.hardened.yaml up -d
unset HELMSMAN_MASTER_KEY
```

The server also accepts legacy `JELLOFIN_COMMAND_*` runtime variables for this transition release, but new deployments should use `HELMSMAN_*`. Do not change or regenerate an external master key during the rename. If you also change the browser-facing hostname, existing sessions will not follow because they are intentionally bound to the exact scheme, host, and port; after confirming the old volume is mounted, sign in on the new origin with the enrolled Jellyfin owner's username and password.

Upgrading directly from v0.4 preserves registered service URLs. Its credentials were browser-only, so they must be entered once into the server-side encrypted store. Keep the old archive/browser profile until every connection has been verified.

The v0.4 browser vault is not loaded by Helmsman. Helmsman does not request a vault passphrase or store new service secrets in the browser.

## Health and verification

`/healthz` checks the local process; upstream outages appear as incidents and do not cause a container restart loop.

Probe compatibility treats Radarr, Sonarr, and Prowlarr `Notice` health entries as informational rather than failures. Prowlarr's blocked-indexer endpoint and Seerr's current status, authenticated-identity, and request-count routes are handled explicitly. Absent HTTP statuses remain absent rather than displaying a fabricated `HTTP 100`, and Arr application warnings show their current sanitized count. Proxmox checks use a separate, fixed allowlist of read-only API routes, verify environment identity, report endpoint availability independently from node state, and collect only one cluster-wide inventory per environment and cycle. Portainer checks use their own fixed GET-only route allowlist, distinguish token authorization from environment or container failures, and keep intentionally stopped containers informational.

```sh
docker compose ps
docker compose logs --tail=100 helmsman
npm test
```

The tests cover the network boundary, encrypted credential store, session/CSRF model, state migration, environment discovery and identity matching, endpoint failover without duplicate inventory, media, Proxmox, and Portainer API contracts, service probes, incident debounce and recovery, monitor coalescing, hostile UI content, PWA shell, and container hardening.
