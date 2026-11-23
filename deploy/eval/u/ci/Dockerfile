# CI's stand-in for the U image: the eval agent image, the real checking tools (/opt/u-tools, from their lockfile) and
# a stub kit in all three template slots. It runs a scripted U conversation in the real container; it never serves a
# session, whose image (deploy/eval/u/Dockerfile) holds the real kits. Context: deploy/eval/u.
ARG AGENT_IMAGE
FROM ${AGENT_IMAGE}
USER root
COPY tools /opt/u-tools
COPY ci /opt/u-ci
RUN cd /opt/u-tools && npm ci --no-audit --no-fund --loglevel=error \
  && cd /opt/u-ci/template && npm ci --install-links --ignore-scripts --no-audit --no-fund --loglevel=error \
  && mkdir -p src \
  && for slot in k1 k2 k3; do mkdir -p /opt/u-kits && cp -r /opt/u-ci/template "/opt/u-kits/$slot"; done \
  && rm -rf /opt/u-ci /root/.npm \
  && chmod -R a+rX,go-w /opt/u-tools /opt/u-kits
USER 10001:10001
