# The replay eval's sandbox image: the harness under test and the fake household, used for both of a run's
# containers (the agent as uid 10001, the household as uid 10002). Build it from a built checkout:
#   npm run build && docker build --file deploy/eval/Dockerfile --tag ouro-eval-sandbox:local .
# It carries no credentials, bundle or case; a run mounts those (src/eval/sandbox/docker.ts).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl openssl python3 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 ouro \
  && useradd --uid 10001 --gid 10001 --home-dir /home/ouro --create-home --shell /usr/sbin/nologin ouro

WORKDIR /opt/ouro
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps --workspaces=false --no-audit --no-fund
COPY dist ./dist
COPY src/eval/fakes /opt/eval/fakes
RUN chmod 0755 /opt/eval/fakes/books-stub/books
USER 10001:10001
