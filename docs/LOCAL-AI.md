# The Helmsman agent and local AI

Helmsman can run an agent that watches your homelab, explains problems in
plain language, sends them to your phone through Home Assistant, and fixes
the specific things you've allowed it to fix. It's built for a **small model
on your own hardware**, such as a 3–4B model on a 4 GB GPU, and never needs a
cloud AI service.

You set it up under **Settings → Agent** and use it from the **Overview**
in the Overview workspace: its reports, suggestions waiting for approval, and
a chat box. Setup takes a few minutes.

## What the agent does

Helmsman already watches everything: it checks each service on a schedule and
opens an incident after two identical failures in a row. The agent doesn't add
another polling loop. It wakes up when something changes:

| Trigger | What happens |
|---|---|
| An incident opens or gets worse | The agent looks at the service's checks, health messages, containers and VMs with read-only tools, then writes a short note: what's wrong, the likely cause, the next step. It may suggest an action. |
| Everything for a service recovers | A short note with how long it was down. |
| Daily digest | One summary at the time you choose: health, what broke or recovered, what's coming up. |
| Periodic check-in | Every few hours it looks over everything. If all is well it writes a quiet note and doesn't notify you. |

One outage usually opens several incidents (status, health, queue), so they're
grouped per service: **one outage, one note, one notification**. The same
outage isn't announced twice unless it gets worse.

Detection stays deterministic. The model's job is explaining facts Helmsman
already found, which small models handle well; spotting problems in raw
numbers is not, so it isn't asked to.

Without a model configured, the agent still notifies you, using Helmsman's
own facts instead of a written explanation.

## What it can change, and the guardrails

The agent changes things in exactly four ways, and can test Prowlarr
indexers, which changes nothing.

**1. Rules you write.** For example: "when Sonarr has an open incident for 5
minutes, restart the `sonarr` container." Rules are checked by Helmsman's own
code, not by the model:

- A rule only fires for an incident on the service it names. Text in a log line
  or health message can't trigger it.
- Containers can only be **started or restarted**, and VMs or LXCs only
  **started or rebooted**. Stop, shut down and delete are never available to
  rules.
- "Restart" means "get it running": a stopped container is started, and a
  stopped guest is started instead of rebooted.
- Each rule has a wait (1–120 minutes), a cooldown (10 minutes to a day) and a
  daily limit (1–10). All rules together are capped at 10 actions a day.
- A rule fires at most once per incident. If its action fails, it isn't
  retried for that incident.
- Rules only run while **autonomy** is switched on. It's off by default and is
  a single switch.
- Every rule action is written to the event journal and sent to your phone.

**2. Restarting unhealthy containers.** When a container's Docker health
check fails (it reports "unhealthy", is dead, or is stuck restarting),
Helmsman can restart it. Settings → Automation → **Unhealthy containers**:

- Off by default, and only acts while **Let rules act** is on. With it off,
  you're told about unhealthy containers but nothing is restarted.
- Covers every container except the ones you tick, or only the ones you tick.
  The first time you open it, databases, Portainer, Helmsman, Home Assistant
  and similar core services are ticked to be left alone.
- Waits a few minutes (1–60) before restarting, since some containers report
  unhealthy briefly while starting.
- The first restart is quiet. If the container goes unhealthy again, you're
  notified on each restart, with how many times it has happened.
- After it goes unhealthy a set number of times (2–10) within a window (1–168
  hours), Helmsman **stops restarting it** and tells you, once, that it keeps
  coming back and needs you. Restarting forever would only hide the problem.
- A container Docker is already restarting in a loop isn't restarted again;
  you're told instead.
- These restarts share the 10-a-day cap with your rules. The card lists the
  containers that went unhealthy this week, and the daily summary mentions
  repeat offenders.

**3. Clearing stuck downloads.** When a Radarr or Sonarr download stays
stalled, failed or blocked from importing, or a release holds a potentially
dangerous file (an `.exe`, `.lnk`, script or similar, as Radarr or Sonarr
reports it), Helmsman can remove it and ask Radarr or Sonarr to search again.
Settings → Automation → **Stuck downloads**:

- Off by default. When on, each download stuck past the wait (10 minutes to a
  day, an hour to start with) gets one notification and an Approve button on
  the Overview and in the helper. The suggestion waits up to 12 hours, and
  closes itself if the download recovers.
- **Clear stuck and unsafe downloads without asking** lets Helmsman do it on
  its own, with no approval and whether or not **Let rules act** is on:
  - Stalled: removed and searched again, without blocklisting the release,
    since it may only lack seeders. If the same release stalls again, it is
    blocklisted the second time.
  - Failed: removed, that release blocklisted, and searched again.
  - Potentially dangerous file: removed, blocklisted and searched again as
    soon as it's seen, without waiting.
  - Blocked imports always ask first, since the file may be fine and only
    need a manual import.
  - It shares the 10-a-day cap with the other automatic actions; past it,
    each one asks.
- While it's on, a Radarr or Sonarr incident that is only about the queue
  stays a quiet note, so one stuck download doesn't send two notifications.
- Approving checks the queue again first: an item that is no longer stuck is
  refused.

**Testing Prowlarr indexers.** Settings → Automation → **Indexers**:

- Off by default. When on, an indexer Prowlarr reports as failing is tested
  by the agent straight away, retested after a while (2 tests, 15 minutes
  apart, to start with), and you're notified only if every test fails, with
  Prowlarr's error and a likely cause. A passing test is a quiet note. After
  notifying, it stops testing that indexer until it recovers.
- You can also ask in chat: "test indexers" tests them all, "test 1337x"
  tests one. When the switch is off, nothing is tested, and failing indexers
  are reported as usual.
- Only the failing indexer is tested (each test queries its site), at most
  12 tests an hour. The agent can't enable, disable or change indexers.
- While it's on, Prowlarr's own "indexers blocked" incident stays a quiet
  note, so you aren't notified twice.

The **Indexers** panel on Media → Health lists every indexer with its status,
Prowlarr's last error and recent numbers, with buttons to test one or all,
test Prowlarr's connections to its apps, and sync indexers to the apps.
Indexer settings carry API keys and passwords; Helmsman keeps only names,
status and numbers, so those never reach the browser, the logs or the model.

**4. Suggestions you approve.** The model can suggest a container start,
restart or stop, or a VM start, reboot or shutdown. A suggestion **never runs
by itself**. When you approve it, Helmsman looks up the target again in
current inventory, so a container that was recreated still gets the right one,
and runs the same checks as the buttons in the dashboard. Suggestions expire
after 30 minutes, and close themselves if the service recovers or the action
has already happened.

Everything the model reads from your services (health messages, container
status text, log events) is marked as data. The model is told never to follow
instructions inside it, and that text can't add lines or structure of its own.
Because the model can only read, and actions need your approval or a rule you
wrote, a crafted message has nowhere to go.

Other limits: at most 40 background model jobs, 20 notifications an hour, and
duplicate notifications within 10 minutes are dropped. Chat questions are
limited to 60 an hour by default; change it under Settings → Agent → Model
server → Advanced → **Questions per hour** (10 to 2,000), for example to run a
large set of test questions for training data.

## 1. Run a model server

Any server with an OpenAI-compatible API works: Ollama, LM Studio,
llama.cpp's `llama-server`, vLLM. The examples use Ollama.

Run it on a machine with a GPU. Helmsman only needs its address, so Helmsman
itself can run somewhere small.

**Pick a model with tool-calling support.** On a 4 GB card:

| Model | Approx. size at 4-bit | Notes |
|---|---|---|
| `qwen3:4b` | ~2.5 GB | Good tool use. Add `/no_think` to the response instructions (below) so it doesn't reason at length before every answer. |
| `qwen2.5:3b` | ~1.9 GB | Lighter, leaves room if the GPU is shared. |
| `llama3.2:3b` | ~2.0 GB | Another option with tool support. |

Bigger models (7–8B) give better explanations if you have the memory.

**Settings that matter on a small card:**

```sh
# Accept connections from the network, not only from the same machine.
OLLAMA_HOST=0.0.0.0
# Match the context size you'll give Helmsman (4096 suits a 4 GB card).
# Recent Ollama versions read this; older ones need a Modelfile with num_ctx.
OLLAMA_CONTEXT_LENGTH=4096
# Keep the model loaded so the first question after a quiet spell isn't slow.
OLLAMA_KEEP_ALIVE=30m
```

On Linux, Ollama's install script runs it as a systemd service that listens
only on `127.0.0.1`, so Helmsman can't reach it. Set the variables in the
service instead:

```sh
systemctl edit ollama
# Add, then save:
# [Service]
# Environment="OLLAMA_HOST=0.0.0.0"
# Environment="OLLAMA_CONTEXT_LENGTH=4096"
# Environment="OLLAMA_KEEP_ALIVE=30m"
systemctl daemon-reload && systemctl restart ollama
ss -ltnp | grep 11434   # should show 0.0.0.0:11434 or *:11434, not 127.0.0.1
```

Then pull the model: `ollama pull qwen3:4b`, and check it from the machine
running Helmsman with `curl http://model-server:11434/v1/models`.

On Proxmox, running Ollama in an LXC container with the NVIDIA device passed
through lets other containers share the same GPU. Passing the GPU to a VM
gives that VM the card exclusively.

## 2. Connect it in Helmsman

Open **Settings**. It has five tabs: **Access**, **Agent**,
**Notifications**, **Automation** and **About**. On the **Agent** tab, the
numbered steps at the top show what's done.

1. **Model server.** Enter the server's address, such as
   `http://model-server:11434` for Ollama or `http://model-server:1234` for
   LM Studio, without `/v1`. Select **Test connection**: the test lists the
   models the server has, and the Model field offers them. Pick one and
   select **Connect model**. Connecting the first time also turns the agent
   on, using this browser's time zone.
   - Add an API key only if your server needs one. It's stored encrypted,
     never in `agent.json`.
   - Under **Advanced**, set the context size to what your server loads the
     model with (4096 suits a 4 GB card).
   - The address must fit your Helmsman network policy like any other
     connection. Private addresses are allowed by default.
2. **How the agent responds (optional).** Tell it how to talk: length,
   tone, what to include. Start from the Brief, Detailed or Friendly preset
   and edit it. Your text is added to the built-in instructions; the safety
   rules always come after it, so they can't be switched off. Keep it short:
   small models follow short, specific instructions best, and the counter
   shows how much of the context it uses. For Qwen3 models, add `/no_think`
   so they don't reason at length before every answer.
3. **What the agent does.** Choose which events it reports, the daily
   summary time, how often it checks in, and your time zone.
4. **Phone notifications (optional),** on the **Notifications** tab. See the
   next section.
5. **Automation (optional),** on the **Automation** tab: the **Let rules
   act** switch, restarting unhealthy containers (above), and rules. For a
   rule, pick a service, how long it must be down, and what to restart or
   start. The lists come from the services Helmsman monitors and your
   Portainer and Proxmox connections.

## 3. Phone notifications through Home Assistant (optional)

Helmsman sends reports through any Home Assistant notify action, usually the
one the Companion app creates for your phone.

1. In Home Assistant, select your name at the bottom of the sidebar, open the
   **Security** tab, and under **Long-lived access tokens** select **Create
   token**. Name it Helmsman and copy it; Home Assistant shows it only once.
2. Under **Developer tools → Actions**, type `notify.mobile_app`. Your phone
   appears as something like `notify.mobile_app_your_phone`. Helmsman needs
   the part after `notify.`. Newer installs also show a `notify.your_phone`
   entity for `notify.send_message`; Helmsman uses the `mobile_app_…` action.
3. In Helmsman, on the **Notifications** tab, enter Home Assistant's local
   address (such as `http://homeassistant.local:8123`), the token and the
   action, save, and select **Send test**.

Optionally add Helmsman's own address so tapping a notification opens it.

## Using it

On the **Overview** (Overview workspace):

- **Reports** lists the agent's latest notes. **Summarize now** writes a
  summary on demand.
- **Approval requests** appear right where they were made: a request from
  the chat sits under the answer that made it, and requests from incident
  reports or stuck downloads appear under **Waiting for your approval**.
  Approve runs it through the same checks as the dashboard's own buttons;
  actions that take something offline (stop, shut down, reboot, clearing a
  download) ask once more. Afterwards the request shows what happened.
  Requests expire after 30 minutes.
- **Questions about a period** ("how has it been in the past 24 hours?",
  "anything wrong today?", "this week") are answered from Helmsman's own
  records: its code works out each problem's start, duration and whether it
  is still open, plus actions taken, and the model only puts that into words.
  The agent also knows exactly what Helmsman monitors, and says so when asked
  about something it does not watch, such as your internet connection or
  Wi-Fi.
- **Ask the agent** answers questions about your homelab from live data.
  Enter sends; Shift+Enter adds a line. The last few turns are sent along so
  follow-up questions work.
- **Commands.** A message that is only a request, such as `restart
  qbittorrent`, `can you reboot the media vm` or `shut down vm 105`, becomes
  an approval request straight away, without asking the model. Names match
  regardless of capitals, spaces or hyphens, and short names and small typos
  work too (`qbit`, `sonar`, `pve`, `qbitorrent`); when a name could mean more
  than one thing, the agent asks which; VMs and LXCs can be named or
  given by number. "Restart" on a VM means reboot, and "stop" means shut
  down. Approving always happens with the button: typing "yes" or "approved"
  never runs anything.

The **floating helper** offers the same chat on every page. Drag it anywhere;
click it and it moves to the right edge and opens a mini chat. A badge means
something is waiting for approval or there's a new report. Hide it with the
eye button in its chat, or under **Settings → Agent → In this browser**.

To stop automatic rules at once, turn off **Let rules act** on the
**Automation** tab; automatic download clean-up has its own switch under
**Stuck downloads**. To stop the agent,
turn off **Agent on**.

## Training data for your own model

Settings → Agent → **Training data** can keep each conversation with the
model: the instructions, the question, every tool call and result, and the
answer, exactly as the model saw them. It is off by default, and stored only
on your server for 90 days or 100 MB, oldest first. Secrets are scrubbed
before anything is saved. **Include reports** also keeps incident notes,
recoveries and summaries.

Saved answers get **Good**, **Bad** and **Fix answer** buttons, in the chat
and on reports. A fixed answer is what the model should have said; it
replaces the model's answer in the export and is the most useful training
example there is. **Download good and fixed** saves a JSON Lines file with one
`{"messages": [...], "tools": [...]}` example per line, ready for
fine-tuning: pass each line's `tools` to the chat template, for example
`tokenizer.apply_chat_template(example["messages"], tools=example["tools"], tokenize=False)`.
Answers rated Bad never export. **Delete all** removes every saved
conversation and rating.

The chat also comes back after a reload while conversations are kept.

## Using the API

Everything on these screens is also available at `/api/v2/agent`, for
scripts or for troubleshooting. From the browser console on a signed-in
Helmsman tab:

```js
const { csrfToken } = await (await fetch("/api/v2/status")).json();
const agent = (path, method = "GET", body) => fetch(`/api/v2/agent${path}`, {
  method,
  headers: { "Content-Type": "application/json", "X-Helmsman-CSRF": csrfToken },
  body: body === undefined ? undefined : JSON.stringify(body)
}).then((response) => response.json());

await agent("/");                                        // settings, status, latest notes, pending suggestions, history
await agent("/ai/test", "POST", { url: "http://model-server:11434", model: "qwen2.5:3b" });
await agent("/ai", "PUT", { url: "http://model-server:11434", model: "qwen2.5:3b", contextTokens: 4096, timeoutSeconds: 120 });
await agent("/notify", "PUT", { url: "http://homeassistant.local:8123", service: "mobile_app_your_phone", token: "LONG-LIVED-TOKEN" });
await agent("/notify/test", "POST", {});
await agent("/settings", "PUT", { enabled: true, timeZone: "Europe/Berlin", digestTime: "07:30", checkInHours: 6, autonomy: false });
await agent("/ask", "POST", { question: "Why is Sonarr down?" });
await agent("/run", "POST", { job: "digest" });          // or "checkIn"
await agent("/proposals/PROPOSAL-ID", "POST", { decision: "approve" });   // or "decline"
```

Fields you leave out keep their saved values; an empty token or API key keeps
the saved one. A rule looks like this, and saving the rule list replaces the
whole list:

```js
await agent("/container-health", "PUT", { enabled: true, scope: "all", containers: ["postgres", "portainer"], minutes: 3, repeatCount: 3, repeatHours: 24 });
await agent("/downloads", "PUT", { enabled: true, minutes: 60, automatic: false });
await agent("/indexers", "PUT", { enabled: true, tests: 2, spacingMinutes: 15 });
await agent("/rules", "PUT", {
  rules: [
    {
      id: "restart-sonarr",
      enabled: true,
      when: { service: "sonarr", minutes: 5 },
      then: { kind: "container", serviceId: "PORTAINER-CONNECTION-ID", containerName: "sonarr", operation: "restart" },
      cooldownMinutes: 60,
      maxPerDay: 3
    },
    {
      id: "start-media-vm",
      enabled: true,
      when: { service: "jellyfin", minutes: 10 },
      then: { kind: "guest", environmentId: "PROXMOX-ENVIRONMENT-ID", vmid: 105, operation: "start" },
      cooldownMinutes: 120,
      maxPerDay: 2
    }
  ]
});
```

`when.service` is the service ID shown on incidents (`sonarr`, `jellyfin` and
so on for media services). Portainer connection IDs are listed at
`/api/v2/infrastructure/services` and Proxmox environment IDs at
`/api/v2/infrastructure/environments`. `/ask` accepts up to six earlier turns
as `history: [{ role, content }]`.

## Try it without hardware

```sh
npm run demo -- --outage
```

The demo runs the real agent against a scripted stand-in for a model and a
stand-in Home Assistant, with a sample rule. A minute after starting, it
stops Sonarr. You'll see the outage notification in the terminal, the rule
starting the container, and the recovery.

## Files and data

- `agent.json` holds the addresses, schedule and rules. It's sealed with an
  integrity tag from Helmsman's master key; an edited or copied file is
  ignored and the agent starts unconfigured.
- `agent-activity.json` holds the last 200 notes and action history.
- The model server's API key and the Home Assistant token are in the
  encrypted credential store, bound to their exact address.

Prompts sent to the model include service names, states, error codes, health
messages, container and VM names, and lines from your manual. They go only to
the model server you configured.
