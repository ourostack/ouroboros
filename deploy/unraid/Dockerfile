FROM node:22-bookworm-slim

ARG SUPERCRONIC_SHA256=5adff01c5a797663948e656d2b61d10932369ee437eb5cb54fa872b2960f222b
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl procps python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSLo /usr/local/bin/supercronic https://github.com/aptible/supercronic/releases/download/v0.2.46/supercronic-linux-amd64 \
  && echo "${SUPERCRONIC_SHA256}  /usr/local/bin/supercronic" | sha256sum -c - \
  && chmod 0755 /usr/local/bin/supercronic \
  && groupadd --gid 10001 ouro \
  && useradd --uid 10001 --gid 10001 --home-dir /home/ouro --create-home --shell /usr/sbin/nologin ouro

WORKDIR /opt/ouro
COPY package.json ./
RUN npm install --omit=dev --workspaces=false --no-audit --no-fund
COPY dist ./dist
COPY assets ./assets
COPY skills ./skills
COPY changelog.json ./changelog.json
COPY deploy/unraid/container-runtime.json ./container-runtime.json
RUN chown -R 10001:10001 /opt/ouro /home/ouro

USER 10001:10001
ENV HOME=/home/ouro
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node","/opt/ouro/dist/heart/daemon/container-healthcheck.js","--agent","sanctuary"]
ENTRYPOINT ["node","/opt/ouro/dist/heart/daemon/daemon-entry.js"]
