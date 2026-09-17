# Security policy

Helmsman stores encrypted credentials and can reach operator-approved private
services. Treat security reports as sensitive even when they use test data.

## Supported release

Only the newest published Helmsman release receives security fixes. Upgrade by
pinning the next published image or manifest digest after backing up the data
volume.

## Reporting a vulnerability

Submit reports through [GitHub private vulnerability reporting](https://github.com/nunesg130-boop/helmsman/security/advisories/new).
Do not open a public issue with vulnerability or exploit details. If private
reporting is temporarily unavailable, open a sanitized issue that asks the
maintainer to establish a private contact channel and include no technical
details.

Include the affected version, deployment topology, reproducible steps using
sanitized data, impact, and any proposed mitigation. Never attach a real
Helmsman data volume or `.env` file.

The maintainer will acknowledge a complete report when practical, investigate
it privately, and coordinate disclosure after a fix or mitigation is ready.
Because this is a volunteer project, no fixed response or resolution time is
guaranteed.

## Public reports and diagnostics

Public issues and pull requests must use synthetic hostnames and RFC 5737 or
RFC 3849 documentation addresses. Remove credentials, cookies, setup tokens,
access keys, certificate material, internal DNS names, public IP addresses,
real media titles, usernames, file paths, container labels, and raw API
responses. Prefer the smallest reproducible test fixture over screenshots or
logs from a live installation.

## Deployment boundary

Keep the published container port private or restricted to a trusted HTTPS
edge, protect the data volume and backups, use dedicated least-privilege
upstream credentials scoped only to visible resources and the actions you want
Helmsman to perform, and never mount the Docker socket. Authentik or another identity-aware proxy
protects browser entry only; it does not replace the credentials Helmsman uses
for upstream services.

Monitoring and probes use fixed read-only GET routes. The only writes are
Helmsman-confirmed Portainer container start/restart/graceful-stop, Proxmox
QEMU/LXC start/reboot/graceful-shutdown, Seerr failed-request retry, a selected
standard-season request for one exact current series through Seerr, and targeted
Radarr/Sonarr search actions for one exact current record. Each uses an accessible in-app
confirmation rather than a browser-native prompt, revalidates the selected
record after approval, and sends a fixed method, path, query, and request-body
template. The browser cannot provide an arbitrary upstream path or body.
Helmsman exposes no general upstream or Docker API proxy, SSH, shell, console,
host mount, delete/remove, force-stop, reset, kill, or bulk action.

Browser access belongs to one exact enabled Jellyfin administrator. Enrollment
and login ask only for that account's username and password; Helmsman obtains
the stable Jellyfin server and user IDs itself and never requests or displays
them. Submit the password only to Helmsman's sign-in form. Never place it in
`.env`, Compose YAML, a URL, browser storage, issue text, or application logs.
Helmsman forwards the one-time exchange to the configured Jellyfin URL. Prefer
Jellyfin HTTPS; private HTTP is supported for homelabs only when every host and
network segment between the container and Jellyfin is trusted, because that
hop does not encrypt the submitted password.

Helmsman discards the password immediately, encrypts the Jellyfin access token
server-side for that browser session, and returns only an origin-bound,
30-day, HttpOnly, `SameSite=Strict` session cookie. Browser mutations also need
the matching per-session CSRF value. The Jellyfin monitoring connector has its
own destination-bound credential and is never substituted for an owner's login
token. The token ciphertext is authenticated against the browser-cookie
verifier, immutable session claims, and exact Jellyfin URL, target revision,
approved address pins, and network policy. The owner binding and
authorization-critical session index carry a master-key-derived integrity
seal, so offline edits fail closed. A changed boundary revokes every browser
session locally before decryption or outbound use and requires sign-in again.
Public status reveals only that an owner is configured, never the enrolled username.
New logins fail while Jellyfin is unreachable; bounded read-only grace
may apply to a recently validated session, but writes require fresh identity
validation and fail closed. A disabled, demoted, revoked, or mismatched owner
loses the local session.

The integrity seal is tamper-evident, not a hardware-backed monotonic counter.
Replaying an older complete, valid data backup can therefore roll authorization
state back to that backup. Protect backup history like the live volume, and run
`reset-access --confirm` after an intentional restore if the enrolled owner or
browser access changed after the restored snapshot was taken.

Authentik or another identity-aware proxy remains the external MFA boundary;
Jellyfin password authentication does not perform an Authentik challenge. The
only offline break-glass command is `reset-access --confirm`, which revokes all
Helmsman browser sessions, destroys the locally encrypted browser-token copies,
and removes the owner binding while preserving registered services, network
policy, and encrypted monitoring credentials. The stopped broker cannot send
Jellyfin logout requests during this offline reset, so an operator who suspects
a token was copied must also invalidate that upstream session in Jellyfin. The
command never creates or prints a reusable browser key. A v1.0.0-beta.2 access key is accepted
only long enough to enroll the Jellyfin owner and is permanently removed when
that enrollment succeeds.
