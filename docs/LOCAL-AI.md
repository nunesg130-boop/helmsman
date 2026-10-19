# The Helmsman agent and local AI

Helmsman can run an agent that watches your homelab, explains problems in
plain language, sends them to your phone through Home Assistant, and fixes
the specific things you've allowed it to fix. It's built for a **small model
on your own hardware**, such as a 3–4B model on a 4 GB GPU, and never needs a
cloud AI service.

The screens for this are still to come. This guide sets it up through
Helmsman's API from your browser, which takes a few minutes.

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

Then pull the model: `ollama pull qwen3:4b`.

On Proxmox, running Ollama in an LXC container with the NVIDIA device passed
through lets other containers share the same GPU. Passing the GPU to a VM
gives that VM the card exclusively.

## 2. Create a Home Assistant token

In Home Assistant, open your user profile, go to **Security**, and create a
**long-lived access token**. Then find your phone's notify action under
**Developer tools → Actions**. It looks like `notify.mobile_app_pixel_8`.
Helmsman needs only the part after `notify.`.

## 3. Configure Helmsman

Sign in to Helmsman, open your browser's developer console on the Helmsman
tab, and paste this helper. It uses your signed-in session.

```js
const { csrfToken } = await (await fetch("/api/v2/status")).json();
const agent = (path, method = "GET", body) => fetch(`/api/v2/agent${path}`, {
  method,
  headers: { "Content-Type": "application/json", "X-Helmsman-CSRF": csrfToken },
  body: body === undefined ? undefined : JSON.stringify(body)
}).then((response) => response.json());
```

**Connect the model server.** Test it first. The test lists the models the
server offers, so you can copy the exact name.

```js
await agent("/ai/test", "POST", { url: "http://192.168.0.20:11434", model: "qwen3:4b" });
await agent("/ai", "PUT", {
  url: "http://192.168.0.20:11434",
  model: "qwen3:4b",
  contextTokens: 4096,
  timeoutSeconds: 120,
  extraInstructions: "/no_think"
});
```

`url` is the server's base address; a trailing `/v1` is removed. If the
server needs a key, add `apiKey`. It's stored encrypted, never in
`agent.json`. The address must fit your Helmsman network policy like any
other connection.

**Connect Home Assistant** and send a test notification:

```js
await agent("/notify", "PUT", {
  url: "http://192.168.0.30:8123",
  service: "mobile_app_pixel_8",
  token: "PASTE-THE-LONG-LIVED-TOKEN",
  helmsmanUrl: "https://helmsman.example.com"
});
await agent("/notify/test", "POST", {});
```

`helmsmanUrl` is optional. When set, tapping a notification opens Helmsman.

**Turn the agent on:**

```js
await agent("/settings", "PUT", {
  enabled: true,
  timeZone: "America/New_York",
  digestTime: "07:30",
  checkInHours: 6,
  triggers: { incidents: true, recoveries: true, digest: true, checkIn: true },
  autonomy: false
});
```

**Add rules (optional).** A rule names the service whose incident triggers
it, and the container or VM to act on. Look up the Portainer connection's ID
with `await (await fetch("/api/v2/infrastructure/services")).json()`, and a
Proxmox environment's ID with `/api/v2/infrastructure/environments`.

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
await agent("/settings", "PUT", { autonomy: true });
```

`when.service` is the service ID shown on incidents: `sonarr`, `radarr`,
`jellyfin` and so on for media services. Saving the rule list replaces the
whole list.

## Using it

```js
await agent("/");                                        // settings, status, latest notes, pending suggestions, history
await agent("/ask", "POST", { question: "Why is Sonarr down?" });
await agent("/run", "POST", { job: "digest" });          // or "checkIn"
await agent("/proposals/PROPOSAL-ID", "POST", { decision: "approve" });   // or "decline"
await agent("/settings", "PUT", { autonomy: false });    // stop all rules at once
await agent("/settings", "PUT", { enabled: false });     // turn the agent off
```

`/ask` accepts up to six earlier turns as `history: [{ role, content }]` for
follow-up questions.

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
