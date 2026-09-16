# Security policy

Helmsman stores encrypted credentials and can reach operator-approved private
services. Treat security reports as sensitive even when they use test data.

## Supported release

Only the newest published Helmsman release receives security fixes while the
project is in beta. Upgrade by pinning the next published image or manifest
digest after backing up the data volume.

## Reporting a vulnerability

Use GitHub's private vulnerability-reporting feature for this repository when
it is enabled. Otherwise contact the repository owner privately. Do not open a
public issue containing credentials, tokens, setup links, internal addresses,
Helmsman access keys, logs, state files, or exploit details.

Include the affected version, deployment topology, reproducible steps using
sanitized data, impact, and any proposed mitigation. Never attach a real
Helmsman data volume or `.env` file.

## Deployment boundary

Keep the published container port private or restricted to a trusted HTTPS
edge, protect the data volume and backups, use dedicated least-privilege
upstream credentials scoped only to visible resources and the actions you want
Helmsman to perform, and never mount the Docker socket. Authentik or another identity-aware proxy
protects browser entry only; it does not replace the credentials Helmsman uses
for upstream services.

Monitoring and probes use fixed read-only GET routes. The only writes are
Helmsman-confirmed Portainer container start/restart/graceful-stop, Proxmox
QEMU/LXC start/reboot/graceful-shutdown, Seerr failed-request retry, and
targeted Radarr/Sonarr search actions. Each uses an accessible in-app
confirmation rather than a browser-native prompt, revalidates the selected
record after approval, and sends a fixed method, path, query, and request-body
template. The browser cannot provide an arbitrary upstream path or body.
Helmsman exposes no general upstream or Docker API proxy, SSH, shell, console,
host mount, delete/remove, force-stop, reset, kill, or bulk action.

The reusable 256-bit Helmsman access key is a bearer secret. Store it in a
password manager and enter it only in Helmsman's unlock form. Never place it in
`.env`, Compose YAML, a URL, browser storage, issue text, or application logs.
Helmsman persists only a SHA-256 verifier and issues one-year, origin-bound
HttpOnly browser sessions. Rotate the key immediately if it may have been
exposed; rotation revokes every prior Helmsman session without deleting service
configuration or encrypted upstream credentials. Rotation in Settings issues
the initiating browser a replacement session; offline CLI rotation does not.
