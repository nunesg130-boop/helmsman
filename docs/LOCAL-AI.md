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

The agent changes things in exactly two ways.

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

**2. Suggestions you approve.** The model can suggest a container start,
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

Other limits: at most 40 background model jobs and 60 questions an hour, 20
notifications an hour, and duplicate notifications within 10 minutes are
dropped.

## 1. Run a model server

Any server with an OpenAI-compatible API works: Ollama, LM Studio,
llama.cpp's `llama-server`, vLLM. The examples use Ollama.

Run it on a machine with a GPU. Helmsman only needs its address, so Helmsman
itself can run somewhere small.

**Pick a model with tool-calling support.** On a 4 GB card:

| Model | Approx. size at 4-bit | Notes |
|---|---|---|
| `qwen3:4b` | ~2.5 GB | Good tool use. Add `/no_think` to the extra instructions (below) so it doesn't reason at length before every answer. |
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

Open **Settings** and scroll to **Agent**. The numbered steps at the top show
what's done.

1. **Model server.** Enter the server's address, such as
   `http://model-server:11434` for Ollama or `http://model-server:1234` for
   LM Studio, without `/v1`. Select **Test connection**: the test lists the
   models the server has, and the Model field offers them. Pick one and
   select **Connect model**. Connecting the first time also turns the agent
   on, using this browser's time zone.
   - Add an API key only if your server needs one. It's stored encrypted,
     never in `agent.json`.
   - Under **Advanced**, set the context size to what your server loads the
     model with (4096 suits a 4 GB card), and optionally add one line of
     extra instructions, such as `/no_think` for Qwen3 models.
   - The address must fit your Helmsman network policy like any other
     connection. Private addresses are allowed by default.
2. **What the agent does.** Choose which events it reports, the daily
   summary time, how often it checks in, and your time zone.
3. **Phone notifications (optional).** See the next section.
4. **Rules (optional).** Pick a service, how long it must be down, and what
   to restart or start. The lists come from the services Helmsman monitors
   and your Portainer and Proxmox connections. Rules only run while **Let
   rules act** is on.

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
3. In Helmsman, under **Phone notifications**, enter Home Assistant's local
   address (such as `http://homeassistant.local:8123`), the token and the
   action, save, and select **Send test**.

Optionally add Helmsman's own address so tapping a notification opens it.

## Using it

On the **Overview** (Overview workspace):

- **Reports** lists the agent's latest notes. **Summarize now** writes a
  summary on demand.
- **Waiting for your approval** lists actions the model suggested. Approving
  one asks for confirmation, then runs it through the same checks as the
  dashboard's own buttons. Suggestions expire after 30 minutes.
- **Ask the agent** answers questions about your homelab from live data.
  Enter sends; Shift+Enter adds a line. The last few turns are sent along so
  follow-up questions work.

The **floating helper** offers the same chat on every page. Drag it anywhere;
click it and it moves to the right edge and opens a mini chat. A badge means
something is waiting for approval or there's a new report. Hide it with the
eye button in its chat, or under **Settings → Agent → In this browser**.

To stop all rules at once, turn off **Let rules act**. To stop the agent,
turn off **Agent on**.

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
