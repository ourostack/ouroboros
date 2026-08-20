#!/bin/sh
set -eu

exec node /opt/ouro/dist/heart/daemon/container-spec-auditor-main.js \
  --inspect "$1" \
  --expected-image "$2"
