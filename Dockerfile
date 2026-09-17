FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995

ARG HELMSMAN_VERSION=1.0.3
ARG HELMSMAN_REVISION=unknown

LABEL org.opencontainers.image.title="Helmsman" \
      org.opencontainers.image.version="${HELMSMAN_VERSION}" \
      org.opencontainers.image.revision="${HELMSMAN_REVISION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.description="Local-first media and infrastructure operations center with a hardened self-hosted control plane"

RUN addgroup -S -g 10001 helmsman \
    && adduser -S -D -H -u 10001 -G helmsman helmsman \
    && mkdir -p /app /data \
    && chown root:root /app \
    && chmod 0555 /app \
    && chown 10001:10001 /data \
    && chmod 0700 /data \
    && touch /data/.volume-init \
    && chown 10001:10001 /data/.volume-init \
    && chmod 0600 /data/.volume-init

WORKDIR /app

# Keep the runtime allowlist explicit. Local environment files, the legacy
# browser client/vault, deployment examples, tests, and metadata stay out.
COPY --chown=0:0 index.html styles.css manifest.webmanifest sw.js ./
COPY --chown=0:0 assets/helmsman-logo.png assets/icon-192.png assets/icon-512.png assets/icon-maskable-512.png ./assets/
COPY --chown=0:0 assets/services/THIRD_PARTY_NOTICES.md assets/services/bazarr.png assets/services/jellyfin.svg assets/services/portainer.svg assets/services/prowlarr.png assets/services/proxmox.png assets/services/qbittorrent.svg assets/services/radarr.png assets/services/seerr.jpg assets/services/sonarr.png ./assets/services/
COPY --chown=0:0 assets/services/licenses/ ./assets/services/licenses/
COPY --chown=0:0 assets/workloads/vm.svg assets/workloads/container.svg ./assets/workloads/
COPY --chown=0:0 src/app-v5.js ./src/app-v5.js
COPY --chown=0:0 src/ui/operations-views.js src/ui/operations.css src/ui/control.css src/ui/retro.css ./src/ui/
COPY --chown=0:0 server ./server
COPY --chown=0:0 package.json ./package.json
COPY --chown=0:0 LICENSE ./LICENSE

RUN find /app -type d -exec chmod 0555 {} + \
    && find /app -type f -exec chmod 0444 {} +

ENV NODE_ENV=production \
    NODE_OPTIONS="--disable-proto=throw --max-old-space-size=160" \
    HELMSMAN_VERSION=${HELMSMAN_VERSION} \
    HELMSMAN_HOST=0.0.0.0 \
    HELMSMAN_PORT=8080 \
    HELMSMAN_DATA_DIR=/data

USER 10001:10001
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "server/index.mjs", "healthcheck"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "server/index.mjs"]
CMD ["serve"]
