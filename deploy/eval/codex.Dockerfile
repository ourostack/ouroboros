# The agent image for H's `codex` arm: the eval sandbox's agent image with OpenAI Codex CLI added. The binary is
# built from source at the pinned commit by deploy/eval/build-codex.sh, which writes it to <dir>/image/codex:
#
#   docker build -f deploy/eval/codex.Dockerfile --build-arg SANDBOX_IMAGE=<agent image> -t <codex image> <dir>/image
ARG SANDBOX_IMAGE=ouro-eval-sandbox:local
FROM ${SANDBOX_IMAGE}
USER 0:0
COPY codex /usr/local/bin/codex
RUN chmod 0755 /usr/local/bin/codex
USER 10001:10001
