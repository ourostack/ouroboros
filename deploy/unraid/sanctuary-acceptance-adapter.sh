#!/bin/sh
set -eu

ENTRY='import fs from "node:fs"; import("/opt/ouro/dist/heart/daemon/sanctuary-acceptance-adapter.js").then(async (module) => { const payload = JSON.parse(fs.readFileSync(0, "utf8")); const result = await module.executeSanctuaryAcceptanceAdapter(payload); process.stdout.write(JSON.stringify(result)); }).catch(() => { process.exitCode = 1; });'
VAULT_ENTRY='import("/opt/ouro/dist/heart/daemon/sanctuary-acceptance-adapter.js").then(async (module) => { const result = await module.executeSanctuaryAcceptanceVaultProbe(process.argv[1], process.argv[2]); process.stdout.write(JSON.stringify(result)); }).catch(() => { process.exitCode = 1; });'

if test "${1:-}" = vault-probe; then
  test "$#" -eq 3 || exit 2
  exec node --input-type=module -e "$VAULT_ENTRY" "$2" "$3"
fi

test "$#" -eq 0 || exit 2

if test -e /proc/self/fd/3; then
  exec node --input-type=module -e "$ENTRY" 3<&3
fi
exec node --input-type=module -e "$ENTRY"
