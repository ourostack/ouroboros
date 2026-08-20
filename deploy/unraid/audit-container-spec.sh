#!/bin/sh
set -eu

exec node /opt/ouro/dist/heart/daemon/container-spec-auditor-main.js \
  --template "$1" \
  --runtime-policy "$2" \
  --expected-image "$3"
