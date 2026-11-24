# The U arms' agent image (pre-registration v1 sections 2 to 4): the eval agent image plus the three project
# templates and the checking tools. Built from build-kits.sh's output folder as the context:
#
#   docker build -f deploy/eval/u/Dockerfile --build-arg AGENT_IMAGE=<agent image> -t <name> <folder holding u-kits and u-tools>
#
# Everything here belongs to root and is read-only to the guest's user (10001), which reads the templates through
# the project's node_modules link and runs the tools with node.
ARG AGENT_IMAGE
FROM ${AGENT_IMAGE}
COPY --chown=0:0 u-tools /opt/u-tools
COPY --chown=0:0 u-kits /opt/u-kits
USER 10001:10001
