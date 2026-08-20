#!/bin/sh
set -eu

ENTRY='import fs from "node:fs"; import("/opt/ouro/dist/heart/daemon/sanctuary-acceptance-harness.js").then(async (module) => { const configPath = process.argv[2]; const config = JSON.parse(fs.readFileSync(configPath || 0, "utf8")); await module.executeSanctuaryAcceptanceHarness(process.argv[1] ?? "", config); }).catch(() => { process.exitCode = 1; });'

if test "${1:-}" = --contract; then
  exec /bin/cat /opt/ouro/deploy/unraid/sanctuary-acceptance-contract.json
fi

COMMAND=${1:-}
CONFIG_PATH=
if test "${2:-}" = --config; then
  test -n "${3:-}" || exit 2
  CONFIG_PATH=$3
  test "$#" -eq 3 || exit 2
elif test "$#" -gt 1; then
  exit 2
fi

if test -e /proc/self/fd/3; then
  exec node --input-type=module -e "$ENTRY" "$COMMAND" "$CONFIG_PATH" 3<&3
fi
exec node --input-type=module -e "$ENTRY" "$COMMAND" "$CONFIG_PATH"
