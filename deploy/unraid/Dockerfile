# Speech-to-text for voice notes from every sense: whisper.cpp built for any x86-64/arm64 CPU, at a pinned, verified commit.
FROM node:22-bookworm-slim AS whisper
ARG WHISPER_CPP_VERSION=v1.8.7
ARG WHISPER_CPP_COMMIT=48f628a84833905ee4a0658ee6d4a5c915ce1997
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git cmake make g++ \
  && git clone --depth 1 --branch "$WHISPER_CPP_VERSION" https://github.com/ggml-org/whisper.cpp /src/whisper.cpp \
  && test "$(git -C /src/whisper.cpp rev-parse HEAD)" = "$WHISPER_CPP_COMMIT" \
  && cmake -S /src/whisper.cpp -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF \
  && cmake --build /src/build --target whisper-cli -j"$(nproc)" \
  && install -m 0755 /src/build/bin/whisper-cli /usr/local/bin/whisper-cli

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/ourostack/ouroboros"
LABEL bot.ouro.sanctuary.mount-contract="canonical-gateway"

ARG TARGETARCH
ARG SUPERCRONIC_AMD64_SHA256=5adff01c5a797663948e656d2b61d10932369ee437eb5cb54fa872b2960f222b
ARG SUPERCRONIC_ARM64_SHA256=c0576a8eb092e3f79108ed0a2155a25c7766af78456e5a6070e54757ef513bfe
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg procps python3 make g++ git openssh-client sudo \
  && rm -rf /var/lib/apt/lists/* \
  && case "$TARGETARCH" in amd64) SUPERCRONIC_SHA256="$SUPERCRONIC_AMD64_SHA256" ;; arm64) SUPERCRONIC_SHA256="$SUPERCRONIC_ARM64_SHA256" ;; *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; esac \
  && curl -fsSLo /usr/local/bin/supercronic "https://github.com/aptible/supercronic/releases/download/v0.2.46/supercronic-linux-${TARGETARCH}" \
  && echo "${SUPERCRONIC_SHA256}  /usr/local/bin/supercronic" | sha256sum -c - \
  && chmod 0755 /usr/local/bin/supercronic \
  && groupadd --gid 10001 ouro \
  && useradd --uid 10001 --gid 10001 --home-dir /home/ouro --create-home --shell /usr/sbin/nologin ouro \
  && groupadd --system --gid 10002 ouro-sync \
  && useradd --system --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ouro-sync

COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
RUN whisper-cli --help >/dev/null 2>&1 && ffmpeg -version >/dev/null
WORKDIR /opt/ouro
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --legacy-peer-deps --workspaces=false --no-audit --no-fund \
  && npm run build-release --prefix node_modules/better-sqlite3 \
  && cp node_modules/better-sqlite3/build/Release/better_sqlite3.node "node_modules/better-sqlite3/prebuilds/linux-$(node -p process.arch).node" \
  && node -e 'const Database = require("better-sqlite3"); const db = new Database(":memory:"); if (db.prepare("SELECT 1 AS ready").get().ready !== 1) process.exit(1); db.close()' \
  && rm -rf node_modules/better-sqlite3/build \
  && test -x /opt/ouro/node_modules/.bin/bw \
  && ln -s /opt/ouro/node_modules/.bin/bw /usr/local/bin/bw
# The runtime never reads dependency source maps, type declarations or Markdown, and the
# root authority pins and hashes every package file each time the gateway starts, which
# took minutes on Unraid's array (D-036). Dropping them removes about 40% of the files.
RUN find /opt/ouro/node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.md' -o -name '*.markdown' \) -delete
COPY dist ./dist
COPY assets ./assets
COPY skills ./skills
COPY changelog.json ./changelog.json
COPY deploy/unraid/container-runtime.json ./container-runtime.json
COPY deploy/unraid /opt/ouro/deploy/unraid
# Bundle sync pushes over ssh with the deploy key mounted at /run/ouro-sync. The key is 10002:10002 mode 0400, so
# only ouro-sync can read it; the agent (ouro, 10001) reaches it only through sudo and the root-owned wrapper, which
# accepts nothing but git's ssh call for one GitHub repository and trusts only GitHub's published host keys.
COPY deploy/unraid/github_known_hosts /etc/ouro/github_known_hosts
COPY deploy/unraid/ouro-sync-ssh /usr/local/libexec/ouro-sync-ssh
COPY deploy/unraid/ouro-sync.sudoers /etc/sudoers.d/ouro-sync
RUN chown root:root /etc/ouro /etc/ouro/github_known_hosts /usr/local/libexec/ouro-sync-ssh /etc/sudoers.d/ouro-sync \
  && chmod 0755 /etc/ouro /usr/local/libexec/ouro-sync-ssh \
  && chmod 0644 /etc/ouro/github_known_hosts \
  && chmod 0440 /etc/sudoers.d/ouro-sync \
  && visudo -cf /etc/sudoers.d/ouro-sync
COPY assets/sanctuary-host-launcher.sh /opt/ouro/deploy/unraid/sanctuary-host-launcher.sh
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
  && test "$BW_VERSION" = "2026.9.1" \
  && rm -rf -- "$BW_VERIFY_ROOT" \
  && trap - 0 \
  && test ! -e "/home/ouro/.config/Bitwarden CLI"
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node","/opt/ouro/dist/heart/daemon/container-healthcheck.js","--agent","sanctuary","--package-managed-agent","sanctuary"]
ENTRYPOINT ["node","/opt/ouro/dist/heart/daemon/daemon-entry.js","--package-managed-agent","sanctuary"]
