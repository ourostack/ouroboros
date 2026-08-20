#!/bin/sh
set -eu

exec node /opt/ouro/dist/heart/daemon/container-spec-auditor-main.js "$@"
