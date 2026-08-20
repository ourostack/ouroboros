#!/bin/sh
set -eu

ENTRY='import fs from "node:fs"; import("/opt/ouro/dist/heart/daemon/sanctuary-acceptance-harness.js").then(async (module) => { const config = JSON.parse(fs.readFileSync(0, "utf8")); await module.executeSanctuaryAcceptanceHarness(process.argv[1] ?? "", config); }).catch(() => { process.exitCode = 1; });'

if test -e /proc/self/fd/3; then
  exec node --input-type=module -e "$ENTRY" "$@" 3<&3
fi
exec node --input-type=module -e "$ENTRY" "$@"
