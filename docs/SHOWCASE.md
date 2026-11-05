# Showing Helmsman to someone

The showcase demo is Helmsman running against an invented homelab, so you can
send someone a link and let them click around, watch the agent work, and even
press the buttons, without showing them anything real.

It is the same server code as your real Helmsman. Only the upstream services
are fake: Jellyfin, Seerr, Radarr, Sonarr, Prowlarr, Bazarr, qBittorrent,
a two-node Proxmox cluster, Portainer and Home Assistant are all answered
inside the demo process with made-up data.

## What your visitor sees

- A full Media and Infrastructure dashboard with invented titles, guests,
  containers, a sample manual and a network map.
- The agent turned on, with autonomy and three of its policies enabled:
  restarting unhealthy containers, cleaning up stuck downloads, and testing
  failing indexers, plus restart rules for Sonarr and Radarr.
- A new problem every few minutes, one at a time, each handled by those
  policies:

  | Problem staged | What the agent does |
  | --- | --- |
  | Sonarr or Radarr crashes | Reports it, suggests a start, then its rule restarts the container |
  | qBittorrent's health check fails | Restarts it; warns instead once it keeps happening |
  | A download stalls with no seeds | Blocklists it and searches again (after about 10 minutes) |
  | An indexer starts failing | Tests it, then reports it |

  Anything the agent hasn't fixed after 20 minutes is put right by the demo
  so the lab never stays broken. Approving the agent's suggestions or pressing
  Start/Restart in the dashboard works too; it only changes the fake lab.

## Running it

From a checkout of this repository, on the host that runs your reverse proxy:

```sh
HELMSMAN_DEMO_PASSWORD='something-long' \
  docker compose -f deploy/compose.demo.yaml up -d --build
```

Then add a site to your reverse proxy. Sign-in requires HTTPS, so a plain
`http://LAN-IP:4190` link will load but not let anyone in. In Caddy:

```
demo.example.com {
    reverse_proxy 127.0.0.1:4190
}
```

Send your visitor the link, the username `demo` and the password you chose.
Putting the site behind Authentik as well is a good idea if the link might get
passed around.

A restart starts a fresh fake lab. Stop it when you're done:

```sh
docker compose -f deploy/compose.demo.yaml down
```

## Using your real model

By default the agent answers with a scripted stand-in, which is enough to
show the loop but reads like a template. To let your visitor chat with your
real local model about the fake lab, set both:

```sh
HELMSMAN_DEMO_MODEL_URL=http://192.168.0.50:11434   # an OpenAI-compatible server, e.g. Ollama
HELMSMAN_DEMO_MODEL=qwen3:4b                          # a model that server has
HELMSMAN_DEMO_MODEL_CONTEXT=8192                      # optional
```

Only the agent's three model calls (`/v1/models`, `/api/tags`,
`/v1/chat/completions`) are forwarded there. Everything the model sees is the
fake lab. Your visitor's questions do use your GPU, within the agent's usual
limit of 60 questions an hour.

## Other settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `HELMSMAN_DEMO_PASSWORD` | (required) | Password for the `demo` account, 8+ characters |
| `HELMSMAN_DEMO_CHAOS_MINUTES` | `4` | Quiet minutes between one problem clearing and the next |
| `HELMSMAN_DEMO_BIND_IP` | `127.0.0.1` | Host address the port is published on |
| `HELMSMAN_DEMO_HOST_PORT` | `4190` | Host port |
| `HELMSMAN_IMAGE` | the matching release | Helmsman image the demo is built on; keep it the same version as your checkout |

## Without Docker

```sh
HELMSMAN_DEMO_PASSWORD='something-long' npm run demo -- --showcase
```

`npm run demo -- --help` lists every option. Plain `npm run demo` is still the
loopback-only developer demo with `demo` / `demo`.
