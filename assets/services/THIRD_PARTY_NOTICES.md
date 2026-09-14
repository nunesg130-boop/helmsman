# Local service and workload mark notices

The SVG and PNG files in `assets/services` and `assets/workloads` are bundled
local assets. Helmsman uses them only to identify compatible services and to
distinguish virtual machines from LXC containers. They make no network requests.

The Seerr, Radarr, Sonarr, Prowlarr, Proxmox, qBittorrent, Jellyfin, VM, and LXC
artwork was supplied for this Helmsman build. Raster marks were resized and, where
needed, had only their surrounding image background removed. Bazarr retains the
existing compact local representation.

`portainer.svg` is an operator-supplied Portainer mark. No license metadata
accompanied the uploaded asset, so its inclusion here must not be interpreted as
a license grant. It is bundled only to identify an operator-configured Portainer
service inside Helmsman.

The service names and marks are trademarks or other protected identifiers of
their respective owners. Their appearance here does not imply sponsorship,
affiliation, or endorsement, and this notice does not grant rights to reuse a
mark outside that identification purpose.

Reference sources:

- Jellyfin: https://jellyfin.org/docs/general/contributing/branding/
- Seerr: https://seerr.dev/
- Radarr: https://github.com/Radarr/Radarr
- Sonarr: https://github.com/Sonarr/Sonarr
- Prowlarr: https://github.com/Prowlarr/Prowlarr
- qBittorrent: https://www.qbittorrent.org/
- Bazarr: https://www.bazarr.media/
- Proxmox: https://www.proxmox.com/en/about/media-kit
- Portainer: operator-supplied SVG; product reference at https://www.portainer.io/
- LXC: https://linuxcontainers.org/

Bundling or adapting an asset does not provide any additional license grant and
does not override third-party copyright, trademark, brand-guideline, or other
rights in the represented marks.
