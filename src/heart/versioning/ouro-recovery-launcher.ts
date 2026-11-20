import { emitNervesEvent } from "../../nerves/runtime"

export const OURO_RECOVERY_LAUNCHER_SCRIPT = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const home = path.join(os.homedir(), ".ouro-cli");
const current = path.join(home, "CurrentVersion");
const intentPath = path.join(home, "version-intent.json");
const entryRel = "node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-entry.js";
let intent = null;
try {
  intent = JSON.parse(fs.readFileSync(intentPath, "utf8"));
  if (intent.schemaVersion !== 1 || !["pinned", "latest"].includes(intent.mode) || !intent.targetVersion) throw new Error("invalid fields");
} catch (error) {
  if (error && error.code !== "ENOENT") {
    process.stderr.write("invalid Ouro version intent: " + error.message + "\\n");
    process.exit(1);
  }
}
if (intent) {
  const target = path.join(home, "versions", intent.targetVersion);
  const targetEntry = path.join(target, entryRel);
  if (!fs.existsSync(targetEntry)) {
    process.stderr.write("Ouro version intent target is not installed: " + intent.targetVersion + "\\n");
    process.exit(1);
  }
  let active = null;
  try { active = path.basename(fs.readlinkSync(current)); } catch {}
  if (active !== intent.targetVersion) {
    const next = current + ".next-" + process.pid;
    try { fs.unlinkSync(next); } catch {}
    fs.symlinkSync(target, next);
    fs.renameSync(next, current);
  }
}
const entry = path.join(current, entryRel);
if (!fs.existsSync(entry)) {
  process.stderr.write("ouro not installed. Run: npx ouro.bot@latest\\n");
  process.exit(1);
}
const result = cp.spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status == null ? 1 : result.status);
`

export const OURO_WRAPPER_SCRIPT = `#!/bin/sh
# @ouro.bot/cli needs Node 22 or newer, so pick the first node on PATH that
# qualifies instead of running whatever comes first.
OURO_MIN_NODE_MAJOR=22
OURO_NODE=""
OURO_NODE_SEEN=""
OLD_IFS="$IFS"
IFS=:
for dir in $PATH; do
  candidate="\${dir:-.}/node"
  [ -x "$candidate" ] || continue
  major=$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  if [ -z "$OURO_NODE_SEEN" ]; then OURO_NODE_SEEN="$candidate (Node \${major:-unknown})"; fi
  if [ -n "$major" ] && [ "$major" -ge "$OURO_MIN_NODE_MAJOR" ] 2>/dev/null; then
    OURO_NODE="$candidate"
    break
  fi
done
IFS="$OLD_IFS"
if [ -z "$OURO_NODE" ]; then
  echo "ouro needs Node $OURO_MIN_NODE_MAJOR or newer, but found: \${OURO_NODE_SEEN:-no node on PATH}. Install Node $OURO_MIN_NODE_MAJOR+ or put it first on PATH." >&2
  exit 1
fi
# Check for dev mode — if dev-config.json exists, dispatch to the dev repo.
# Skip dev dispatch for "up" command (explicitly returns to production).
DEV_CONFIG="$HOME/.ouro-cli/dev-config.json"
if [ -f "$DEV_CONFIG" ] && [ "$1" != "up" ]; then
  DEV_REPO=$("$OURO_NODE" -e "try{console.log(JSON.parse(require('fs').readFileSync('$DEV_CONFIG','utf-8')).repoPath)}catch{}" 2>/dev/null)
  DEV_ENTRY="$DEV_REPO/dist/heart/daemon/ouro-entry.js"
  if [ -n "$DEV_REPO" ] && [ -e "$DEV_ENTRY" ]; then
    exec "$OURO_NODE" "$DEV_ENTRY" "$@"
  fi
fi
exec "$OURO_NODE" "$HOME/.ouro-cli/bin/ouro-launcher.js" "$@"
`

export function resolveOuroRecoveryLauncherAssets(): {
  launcherScript: string
  wrapperScript: string
} {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.ouro_recovery_launcher_assets_resolved",
    message: "resolved stable CLI recovery launcher assets",
    meta: { launcher: "ouro-launcher.js", wrapper: "ouro" },
  })
  return {
    launcherScript: OURO_RECOVERY_LAUNCHER_SCRIPT,
    wrapperScript: OURO_WRAPPER_SCRIPT,
  }
}
