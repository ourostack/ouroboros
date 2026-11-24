# The replay eval's two sandbox images, built from a built checkout (`npm run build` first):
#   docker build --file deploy/eval/Dockerfile --target agent --tag ouro-eval-sandbox:local .
#   docker build --file deploy/eval/Dockerfile --target household --tag ouro-eval-household:local .
# Neither carries a credential, bundle or case; a run mounts those (src/eval/sandbox/docker.ts).

# The agent container: the harness under test, run as uid 10001. It holds none of the eval's grading code: no
# fakes, fixtures, assertions or cases, only the guest entry and the turn it runs.
FROM node:22-bookworm-slim AS agent
# The label `npm run eval:stop` removes every eval image by (src/eval/stop-command.ts).
LABEL ouro.eval=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 ouro \
  && useradd --uid 10001 --gid 10001 --home-dir /home/ouro --create-home --shell /usr/sbin/nologin ouro
WORKDIR /opt/ouro
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps --workspaces=false --no-audit --no-fund
COPY dist ./dist
RUN find dist/eval -mindepth 1 -maxdepth 1 ! -name guest-entry.js ! -name interview-guest-entry.js ! -name h-guest-entry.js ! -name sandbox ! -name transport ! -name domain ! -name interviews -exec rm -rf {} + \
  && find dist/eval/sandbox -mindepth 1 ! -name 'guest.js' -exec rm -rf {} + \
  # The interviews' neutral loop keeps only its guest and the protocol's brand scrub; the runner and grader stay out.
  && find dist/eval/interviews -mindepth 1 -maxdepth 1 ! -name guest ! -name 'protocol.js' -exec rm -rf {} + \
  && find dist/eval -name '*.map' -delete \
  # node is execute-only, so its process is not dumpable: the shell the model runs cannot open the guest's
  # stdio under /proc/1/fd, read its memory or trace it, and so cannot write into the provider channel.
  && chmod 0711 /usr/local/bin/node
USER 10001:10001

# The household sidecar (uid 10002), and the helpers that build the run's fixtures, its test authority and hand
# the run's folder back.
FROM debian:bookworm-slim AS household
LABEL ouro.eval=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl python3 \
  && rm -rf /var/lib/apt/lists/*
COPY src/eval/fakes/household.py src/eval/fakes/fixtures.py /opt/eval/fakes/
USER 10002:10002
