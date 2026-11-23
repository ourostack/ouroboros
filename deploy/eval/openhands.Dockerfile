# The agent image for H's `openhands` arm: the eval sandbox's agent image with the OpenHands Software Agent SDK at the
# pinned commit, its Python and the arm's supervisor under /opt/agent-sdk (built by deploy/eval/build-openhands.sh
# into <dir>/image/agent-sdk), and tmux, which its terminal tool runs in:
#
#   docker build -f deploy/eval/openhands.Dockerfile --build-arg SANDBOX_IMAGE=<agent image> -t <openhands image> <dir>/image
ARG SANDBOX_IMAGE=ouro-eval-sandbox:local
FROM ${SANDBOX_IMAGE}
USER 0:0
RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux \
  && rm -rf /var/lib/apt/lists/*
COPY agent-sdk /opt/agent-sdk
# The arm's home has no brand word in its path; the arm links the mounted bundle under it.
RUN chmod -R a+rX /opt/agent-sdk \
  && mkdir -p /home/agent/AgentBundles \
  && chown -R 10001:10001 /home/agent
USER 10001:10001
