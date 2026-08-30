FROM node:22-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/ourostack/ouroboros"

ARG TARGETARCH
ARG SUPERCRONIC_AMD64_SHA256=5adff01c5a797663948e656d2b61d10932369ee437eb5cb54fa872b2960f222b
ARG SUPERCRONIC_ARM64_SHA256=c0576a8eb092e3f79108ed0a2155a25c7766af78456e5a6070e54757ef513bfe
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl procps python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && case "$TARGETARCH" in amd64) SUPERCRONIC_SHA256="$SUPERCRONIC_AMD64_SHA256" ;; arm64) SUPERCRONIC_SHA256="$SUPERCRONIC_ARM64_SHA256" ;; *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; esac \
  && curl -fsSLo /usr/local/bin/supercronic "https://github.com/aptible/supercronic/releases/download/v0.2.46/supercronic-linux-${TARGETARCH}" \
  && echo "${SUPERCRONIC_SHA256}  /usr/local/bin/supercronic" | sha256sum -c - \
  && chmod 0755 /usr/local/bin/supercronic \
  && groupadd --gid 10001 ouro \
  && useradd --uid 10001 --gid 10001 --home-dir /home/ouro --create-home --shell /usr/sbin/nologin ouro

WORKDIR /opt/ouro
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --legacy-peer-deps --workspaces=false --no-audit --no-fund \
  && test -x /opt/ouro/node_modules/.bin/bw \
  && ln -s /opt/ouro/node_modules/.bin/bw /usr/local/bin/bw
COPY dist ./dist
COPY assets ./assets
COPY skills ./skills
COPY changelog.json ./changelog.json
COPY deploy/unraid/container-runtime.json ./container-runtime.json
COPY deploy/unraid /opt/ouro/deploy/unraid
RUN chown -R 10001:10001 /opt/ouro /home/ouro

USER 10001:10001
ENV HOME=/home/ouro
RUN BW_VERIFY_ROOT="$(mktemp -d)" \
  && trap 'rm -rf -- "$BW_VERIFY_ROOT"' 0 \
  && mkdir "$BW_VERIFY_ROOT/appdata" \
  && printf '%s' '{}' >"$BW_VERIFY_ROOT/appdata/data.json" \
  && test ! -e "/home/ouro/.config/Bitwarden CLI" \
  && test "$(id -u)" = "10001" \
  && test "$(id -g)" = "10001" \
  && command -v bw >/dev/null \
  && BW_VERSION="$(BITWARDENCLI_APPDATA_DIR="$BW_VERIFY_ROOT/appdata" bw --version 2>"$BW_VERIFY_ROOT/stderr")" \
  && test ! -s "$BW_VERIFY_ROOT/stderr" \
  && test "$BW_VERSION" = "2026.6.0" \
  && rm -rf -- "$BW_VERIFY_ROOT" \
  && trap - 0 \
  && test ! -e "/home/ouro/.config/Bitwarden CLI"
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node","/opt/ouro/dist/heart/daemon/container-healthcheck.js","--agent","sanctuary"]
ENTRYPOINT ["node","/opt/ouro/dist/heart/daemon/daemon-entry.js"]
