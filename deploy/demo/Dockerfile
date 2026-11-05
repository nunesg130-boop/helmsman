# Helmsman showcase demo: the released Helmsman image plus the demo harness.
#
# This is a separate image on purpose. The production image never contains
# scripts/demo.mjs, and this one never holds real credentials: every upstream
# service is answered inside the process with invented data. The only thing
# it can reach on the network is the model server you point it at.
#
# Build it against the same Helmsman version as this checkout so the demo's
# fake services match the server's API:
#
#   docker build -f deploy/demo/Dockerfile \
#     --build-arg HELMSMAN_IMAGE=ghcr.io/nunesg130-boop/helmsman:1.18.2 \
#     -t helmsman-demo:1.18.2 .     # run from the repository root
#
# See deploy/compose.demo.yaml for running it.

ARG HELMSMAN_IMAGE=ghcr.io/nunesg130-boop/helmsman:1.18.2
FROM ${HELMSMAN_IMAGE}

COPY --chown=0:0 --chmod=0444 scripts/demo.mjs ./scripts/demo.mjs

LABEL org.opencontainers.image.title="Helmsman demo" \
      org.opencontainers.image.description="Helmsman running against built-in fake services, for showing it to other people"

# Showcase mode needs HELMSMAN_DEMO_PASSWORD (8+ characters). Each start
# begins from a fresh temporary data directory, so a restart resets the demo.
ENV HELMSMAN_DEMO_SHOWCASE=1 \
    HELMSMAN_DEMO_PORT=8080 \
    HELMSMAN_PORT=8080

ENTRYPOINT ["node", "scripts/demo.mjs"]
CMD []
