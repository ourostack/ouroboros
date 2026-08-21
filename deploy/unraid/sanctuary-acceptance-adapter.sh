#!/bin/sh
set -eu

ENTRY='import fs from "node:fs"; import("/opt/ouro/dist/heart/daemon/sanctuary-acceptance-adapter.js").then(async (module) => { const payload = JSON.parse(fs.readFileSync(0, "utf8")); const result = await module.executeSanctuaryAcceptanceAdapter(payload); process.stdout.write(JSON.stringify(result)); }).catch(() => { process.exitCode = 1; });'
VAULT_ENTRY='import("/opt/ouro/dist/heart/daemon/sanctuary-acceptance-adapter.js").then(async (module) => { const result = await module.executeSanctuaryAcceptanceVaultProbe(process.argv[1], process.argv[2]); process.stdout.write(JSON.stringify(result)); }).catch(() => { process.exitCode = 1; });'
REVOKED_ENTRY='import fs from "node:fs"; import("/opt/ouro/dist/heart/daemon/sanctuary-acceptance-adapter.js").then(async (module) => { const result = await module.executeSanctuaryAcceptanceRevokedProbe(process.argv[1], process.argv[2], fs.readFileSync(3, "utf8")); process.stdout.write(JSON.stringify(result)); }).catch(() => { process.exitCode = 1; });'
CALLBACK_ENTRY='import fs from "node:fs"; import("/opt/ouro/dist/heart/daemon/sanctuary-acceptance-adapter.js").then(async (module) => { const result = await module.executeSanctuaryAcceptanceCallbackProbe(JSON.parse(fs.readFileSync(0, "utf8")), process.argv[1] === "replay"); process.stdout.write(JSON.stringify(result)); }).catch(() => { process.exitCode = 1; });'
MATERIALIZE_ENTRY='import("/opt/ouro/dist/heart/daemon/sanctuary-acceptance-adapter.js").then(async (module) => { const payload = { operation: "materialize_config", command: process.argv[1] }; if (process.argv[2]) payload.phase = process.argv[2]; const result = await module.executeSanctuaryAcceptanceAdapter(payload); process.stdout.write(JSON.stringify(result)); }).catch(() => { process.exitCode = 1; });'

if test "${1:-}" = vault-probe; then
  test "$#" -eq 3 || exit 2
  exec node --input-type=module -e "$VAULT_ENTRY" "$2" "$3"
fi

if test "${1:-}" = revoked-probe; then
  test "$#" -eq 3 || exit 2
  exec node --input-type=module -e "$REVOKED_ENTRY" "$2" "$3" 3<&0
fi

if test "${1:-}" = callback-probe; then
  test "$#" -eq 2 || exit 2
  case "$2" in concurrent|replay) ;; *) exit 2 ;; esac
  exec node --input-type=module -e "$CALLBACK_ENTRY" "$2"
fi

if test "${1:-}" = materialize-config; then
  test "$#" -eq 2 || { test "$#" -eq 3 && test "$2" = cursor-snapshot; } || exit 2
  if test "$#" -eq 3; then case "$3" in before|after) ;; *) exit 2 ;; esac; fi
  exec node --input-type=module -e "$MATERIALIZE_ENTRY" "$2" "${3:-}"
fi

test "$#" -eq 0 || exit 2

if test -e /proc/self/fd/3; then
  exec node --input-type=module -e "$ENTRY" 3<&3
fi
exec node --input-type=module -e "$ENTRY"
