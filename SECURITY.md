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
logs, state files, or exploit details.

Include the affected version, deployment topology, reproducible steps using
sanitized data, impact, and any proposed mitigation. Never attach a real
Helmsman data volume or `.env` file.

## Deployment boundary

Keep the published container port private or restricted to a trusted HTTPS
edge, protect the data volume and backups, use read-only upstream credentials,
and never mount the Docker socket. Authentik or another identity-aware proxy
protects browser entry only; it does not replace the credentials Helmsman uses
for upstream services.
