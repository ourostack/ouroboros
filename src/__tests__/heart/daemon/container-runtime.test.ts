import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as net from "node:net"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { hasManagedAgentProcess, hasManagedSupercronicProcess, hasManagedTelegramProcess, readContainerRuntimePolicy } from "../../../heart/daemon/container-runtime"
import { createSanctuaryInteractiveControl } from "../../../senses/sanctuary-interactive-control"

function extractRunbookFunction(runbook: string, name: string): string {
  const marker = `    ${name}() {`
  const start = runbook.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const end = runbook.indexOf("\n    }", start)
  expect(end).toBeGreaterThan(start)
  return runbook.slice(start, end + "\n    }".length).split("\n").map((line) => line.replace(/^ {4}/u, "")).join("\n")
}

function runConditionalHelper(script: string, failKey: string, env: Record<string, string> = {}) {
  return spawnSync("/bin/sh", ["-c", script, "runbook-helper-test", failKey], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
}

function extractTopLevelShellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf("\n}", start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end + 2)
}

describe("container runtime policy", () => {
  it("accepts only the locked scheduler/update policy", () => {
    expect(readContainerRuntimePolicy({ readFile: () => JSON.stringify({ scheduler: "supercronic", updates: "disabled" }) })).toEqual({ scheduler: "supercronic", updates: "disabled" })
    expect(() => readContainerRuntimePolicy({ readFile: () => JSON.stringify({ scheduler: "cron", updates: "disabled" }) })).toThrow()
    expect(() => readContainerRuntimePolicy({ readFile: () => JSON.stringify({ scheduler: "supercronic", updates: "disabled", extra: true }) })).toThrow()
  })

  it("uses the packaged default path and distinguishes a missing policy from read failures", () => {
    expect(readContainerRuntimePolicy()).toBeNull()
    for (const error of [null, "denied", {}, { code: "EACCES" }]) {
      expect(() => readContainerRuntimePolicy({ readFile: () => { throw error } })).toThrow()
    }
    expect(readContainerRuntimePolicy({ readFile: () => { throw { code: "ENOENT" } } })).toBeNull()
  })

  it("packages the process inspector required by fail-fast orphan cleanup", () => {
    const dockerfile = fs.readFileSync("deploy/unraid/Dockerfile", "utf8")
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bprocps\b/u)
  })

  it("ships a released-package Docker build context", () => {
    const dockerfile = fs.readFileSync("deploy/unraid/Dockerfile", "utf8")
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as { files: string[]; dependencies: Record<string, string> }

    expect(packageJson.files).toContain("deploy/unraid/")
    expect(packageJson.files).toContain("npm-shrinkwrap.json")
    expect(fs.existsSync("npm-shrinkwrap.json")).toBe(true)
    expect(dockerfile).toContain("COPY package.json npm-shrinkwrap.json ./")
    expect(dockerfile).toContain("npm ci --omit=dev --legacy-peer-deps")
    expect(dockerfile).not.toContain("npm install")
  })

  it("pins and exposes the Bitwarden CLI before the image drops privileges", () => {
    const dockerfile = fs.readFileSync("deploy/unraid/Dockerfile", "utf8")
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> }

    expect(packageJson.dependencies["@bitwarden/cli"]).toMatch(/^\d+\.\d+\.\d+$/u)
    expect(dockerfile).toContain("test -x /opt/ouro/node_modules/.bin/bw")
    expect(dockerfile).toContain("ln -s /opt/ouro/node_modules/.bin/bw /usr/local/bin/bw")
    expect(dockerfile).toContain('BW_VERIFY_ROOT="$(mktemp -d)"')
    expect(dockerfile).toContain('printf \'%s\' \'{}\' >"$BW_VERIFY_ROOT/appdata/data.json"')
    expect(dockerfile).toContain('BITWARDENCLI_APPDATA_DIR="$BW_VERIFY_ROOT/appdata" bw --version 2>"$BW_VERIFY_ROOT/stderr"')
    expect(dockerfile).toContain('test ! -s "$BW_VERIFY_ROOT/stderr"')
    expect(dockerfile).toContain('test "$BW_VERSION" = "2026.6.0"')
    expect(dockerfile).toContain('rm -rf -- "$BW_VERIFY_ROOT"')
    expect(dockerfile).toContain('test ! -e "/home/ouro/.config/Bitwarden CLI"')
    expect(dockerfile).not.toContain('$(bw --version)')
    expect(dockerfile.indexOf("test -x /opt/ouro/node_modules/.bin/bw")).toBeLessThan(dockerfile.indexOf("USER 10001:10001"))
  })

  it("keeps Workbench out and ships the Supercronic-owned health habit", () => {
    const agent = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/agent.json", "utf8")) as { senses: Record<string, unknown> }
    expect(agent.senses).not.toHaveProperty("workbench")
    const habit = fs.readFileSync("deploy/unraid/sanctuary.ouro/habits/sanctuary-health.md", "utf8")
    expect(habit).toContain("cadence: 15m")
    expect(habit).toContain("status: active")
  })

  it("ships Sanctuary on the cost-effective MiniMax provider", () => {
    const agent = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/agent.json", "utf8")) as {
      humanFacing: { provider: string; model: string }
      agentFacing: { provider: string; model: string }
    }

    expect(agent.humanFacing).toEqual({ provider: "minimax", model: "MiniMax-M3" })
    expect(agent.agentFacing).toEqual({ provider: "minimax", model: "MiniMax-M3" })
    const readiness = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/provider-readiness.json", "utf8"))
    expect(readiness).toEqual({
      version: 1,
      selectionPolicy: "explicit-same-lane-only",
      providers: [
        {
          provider: "minimax",
          model: "MiniMax-M3",
          vaultItem: "providers/minimax",
        },
      ],
    })
  })

  it("changes Butler autostart through Unraid's root backend without touching ghost entries", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-autostart-helper-"))
    const autostartFile = path.join(testRoot, "unraid-autostart")
    const includeFile = path.join(testRoot, "UpdateConfig.php")
    const callLog = path.join(testRoot, "calls.log")
    const stubs = String.raw`
id() { command printf '0\n'; }
stat() { command printf '0:0:644\n'; }
sync() { return 0; }
docker() { command printf 'docker %s\n' "$*" >>"$CALL_LOG"; }
mv() {
  eval "AUTOSTART_MV_DEST=\${$#}"
  if test "$FAIL_RESTORE_MV" = yes && test "$AUTOSTART_MV_DEST" = "$AUTOSTART_TEST_FILE"; then return 25; fi
  command mv "$@"
}
php() {
  AUTOSTART_ACTION=$3
  AUTOSTART_NAME=$4
  AUTOSTART_VALUE=$5
  command printf 'php %s:%s %s\n' "$AUTOSTART_ACTION" "$AUTOSTART_VALUE" "$AUTOSTART_NAME" >>"$CALL_LOG"
  test "$FAIL_BACKEND" != "$AUTOSTART_ACTION:$AUTOSTART_VALUE" || return 23
  if test "$READBACK_DRIFT" = yes; then return 0; fi
  AUTOSTART_MUTATION_TMP=$AUTOSTART_TEST_ROOT/php-mutation.tmp
  case "$AUTOSTART_ACTION:$AUTOSTART_VALUE" in
    wait:0)
      command awk -v name="$AUTOSTART_NAME" '{ if ($1 == name) print name " 0"; else print }' "$AUTOSTART_TEST_FILE" >"$AUTOSTART_MUTATION_TMP" ;;
    autostart:true)
      command cp "$AUTOSTART_TEST_FILE" "$AUTOSTART_MUTATION_TMP"
      command printf '%s 0\n' "$AUTOSTART_NAME" >>"$AUTOSTART_MUTATION_TMP" ;;
    autostart:false)
      command awk -v name="$AUTOSTART_NAME" '$0 != name " 0" { print }' "$AUTOSTART_TEST_FILE" >"$AUTOSTART_MUTATION_TMP" ;;
    *) return 24 ;;
  esac
  if test "$DRIFT_NONBUTLER" = yes; then command printf 'injected-drift\n' >>"$AUTOSTART_MUTATION_TMP"; fi
  command mv "$AUTOSTART_MUTATION_TMP" "$AUTOSTART_TEST_FILE"
}
`
    try {
      fs.writeFileSync(includeFile, "<?php", { mode: 0o644 })
      const helpers = ["butler_autostart_counts", "snapshot_nonbutler_autostart", "run_unraid_autostart_backend", "mutate_butler_autostart", "verify_butler_autostart", "set_butler_autostart", "disable_butler_autostart", "enable_butler_autostart"]
        .map((helperName) => extractRunbookFunction(runbook, helperName)).join("\n")
        .replaceAll("/var/lib/docker", "$AUTOSTART_TEST_ROOT")
        .replaceAll("/run/unraid-autostart.nonbutler-before.XXXXXX", "$AUTOSTART_TEST_ROOT/nonbutler-before.XXXXXX")
        .replaceAll("/run/unraid-autostart.nonbutler-after.XXXXXX", "$AUTOSTART_TEST_ROOT/nonbutler-after.XXXXXX")
        .replaceAll("/usr/local/emhttp/plugins/dynamix.docker.manager/include/UpdateConfig.php", "$AUTOSTART_INCLUDE_TEST")
        .replaceAll("timeout -s KILL 20 /usr/bin/php", "php")
      const run = (command: string, options: Record<string, string> = {}) => runConditionalHelper(`set -u\n${stubs}\n${helpers}\n${command}`, "unused", {
        AUTOSTART_TEST_FILE: autostartFile, AUTOSTART_TEST_ROOT: testRoot, AUTOSTART_INCLUDE_TEST: includeFile, CALL_LOG: callLog,
        FAIL_BACKEND: "none", FAIL_RESTORE_MV: "no", READBACK_DRIFT: "no", DRIFT_NONBUTLER: "no", ...options,
      })

      const ghosts = "ghost-zero\ndeluge 7\njackett\n"
      fs.writeFileSync(autostartFile, `ghost-zero\ndeluge 7\nouro-butler-staging 4\njackett\n`, { mode: 0o644 })
      fs.writeFileSync(callLog, "")
      expect(run("disable_butler_autostart").status).toBe(0)
      expect(fs.readFileSync(autostartFile, "utf8")).toBe(ghosts)
      expect(fs.readFileSync(callLog, "utf8").match(/^php/gmu)).toHaveLength(2)

      fs.writeFileSync(callLog, "")
      expect(run("enable_butler_autostart").status).toBe(0)
      expect(fs.readFileSync(autostartFile, "utf8")).toBe(`${ghosts}ouro-butler 0\n`)

      fs.writeFileSync(autostartFile, `${ghosts}ouro-butler 0\n`, { mode: 0o644 })
      fs.writeFileSync(callLog, "")
      expect(run("set_butler_autostart staging").status).toBe(0)
      const stagingTransition = fs.readFileSync(callLog, "utf8")
      expect(stagingTransition.indexOf("php autostart:false ouro-butler")).toBeGreaterThan(-1)
      expect(stagingTransition.indexOf("php autostart:false ouro-butler")).toBeLessThan(stagingTransition.indexOf("php autostart:true ouro-butler-staging"))
      expect(fs.readFileSync(autostartFile, "utf8")).toBe(`${ghosts}ouro-butler-staging 0\n`)

      fs.writeFileSync(callLog, "")
      expect(run("enable_butler_autostart").status).toBe(0)
      const productionTransition = fs.readFileSync(callLog, "utf8")
      expect(productionTransition.indexOf("php autostart:false ouro-butler-staging")).toBeGreaterThan(-1)
      expect(productionTransition.indexOf("php autostart:false ouro-butler-staging")).toBeLessThan(productionTransition.indexOf("php autostart:true ouro-butler"))
      expect(fs.readFileSync(autostartFile, "utf8")).toBe(`${ghosts}ouro-butler 0\n`)

      for (const [initial, command, options] of [
        [`${ghosts}ouro-butler\nouro-butler 4\n`, "enable_butler_autostart", {}],
        [`${ghosts}ouro-butler-staging 4\n`, "disable_butler_autostart", { FAIL_BACKEND: "autostart:false" }],
        [ghosts, "enable_butler_autostart", { READBACK_DRIFT: "yes" }],
        [`${ghosts}ouro-butler-staging\n`, "disable_butler_autostart", { DRIFT_NONBUTLER: "yes" }],
      ] as const) {
        fs.writeFileSync(autostartFile, initial, { mode: 0o644 })
        fs.writeFileSync(callLog, "")
        const failed = run(command, options)
        expect(failed.status, `${command} ${JSON.stringify(options)} ${failed.stderr}`).not.toBe(0)
        expect(fs.readFileSync(autostartFile, "utf8")).toBe(initial)
      }

      const restoreFailureInitial = `${ghosts}ouro-butler-staging 4\n`
      fs.writeFileSync(autostartFile, restoreFailureInitial, { mode: 0o644 })
      const restoreFailure = run("disable_butler_autostart", { FAIL_BACKEND: "autostart:false", FAIL_RESTORE_MV: "yes" })
      expect(restoreFailure.status).not.toBe(0)
      const preserved = /recovery copy preserved at (.+)$/mu.exec(restoreFailure.stderr)?.[1]
      expect(preserved).toMatch(/\.unraid-autostart\.ouro\.[A-Za-z0-9]+$/u)
      expect(fs.readFileSync(String(preserved), "utf8")).toBe(restoreFailureInitial)
      fs.rmSync(String(preserved))

      fs.renameSync(includeFile, `${includeFile}.missing`)
      fs.writeFileSync(autostartFile, ghosts, { mode: 0o644 })
      expect(run("disable_butler_autostart").status).not.toBe(0)
      expect(fs.readFileSync(autostartFile, "utf8")).toBe(ghosts)
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("propagates effective-audit faults from a conditional function context", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-audit-helper-"))
    const helper = extractRunbookFunction(runbook, "audit_effective").replace("/mnt/user/appdata/ouro-butler/staging/inspect.XXXXXX", "$AUDIT_TEST_ROOT/inspect.XXXXXX")
    expect(helper).not.toContain("$IMAGE_ID")
    const imageValidator = extractRunbookFunction(runbook, "validate_exact_image_id")
    const script = String.raw`set -u
FAIL_KEY=$1
maybe_fail() { if [ "$FAIL_KEY" = "$1" ]; then return 23; fi; }
mktemp() { maybe_fail mktemp || return $?; command mktemp "$@"; }
chmod() { KEY=chmod-$1; maybe_fail "$KEY" || return $?; command chmod "$@"; }
docker() {
  case "$1 $2" in "inspect "*) KEY=docker-inspect ;; "image inspect") KEY=docker-image ;; "run --rm") KEY=docker-run ;; *) KEY=docker-other ;; esac
  maybe_fail "$KEY" || return $?
  case "$KEY" in docker-inspect|docker-image) command printf '{}\n' ;; esac
}
${imageValidator}
${helper}
unset IMAGE_ID
if audit_effective ouro-butler "$SOURCE_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" canonical "$SOURCE_IMAGE_REFERENCE" "$EXPECTED_ICON"; then command printf 'TRANSITION\n'; else STATUS=$?; set -- "$AUDIT_TEST_ROOT"/inspect.*; if [ -e "$1" ]; then command printf 'LEAK\n'; fi; command printf 'FAILED:%s\n' "$STATUS"; exit "$STATUS"; fi`
    try {
      for (const failKey of ["mktemp", "chmod-0700", "docker-inspect", "docker-image", "chmod-0600", "docker-run"]) {
        const result = runConditionalHelper(script, failKey, { AUDIT_TEST_ROOT: testRoot, SOURCE_IMAGE_ID: `sha256:${"a".repeat(64)}`, AUDIT_RUNNER_IMAGE_ID: `sha256:${"b".repeat(64)}`, SOURCE_IMAGE_REFERENCE: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798", EXPECTED_ICON: "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png" })
        expect(result.status, `${failKey}\n${result.stderr}`).toBe(23)
        expect(result.stdout).not.toContain("TRANSITION")
        expect(result.stdout).not.toContain("LEAK")
        expect(fs.readdirSync(testRoot), `${failKey} leaked an inspect directory`).toEqual([])
      }
      const success = runConditionalHelper(script, "none", { AUDIT_TEST_ROOT: testRoot, SOURCE_IMAGE_ID: `sha256:${"a".repeat(64)}`, AUDIT_RUNNER_IMAGE_ID: `sha256:${"b".repeat(64)}`, SOURCE_IMAGE_REFERENCE: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798", EXPECTED_ICON: "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png" })
      expect(success.status, success.stderr).toBe(0)
      expect(success.stdout).toContain("TRANSITION")
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("audits standalone backup preflight and recovery with IMAGE_ID unset", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-backup-audit-runner-"))
    const audit = extractRunbookFunction(runbook, "audit_effective").replace("/mnt/user/appdata/ouro-butler/staging/inspect.XXXXXX", "$AUDIT_TEST_ROOT/inspect.XXXXXX")
    const validateImage = extractRunbookFunction(runbook, "validate_exact_image_id")
    const pin = extractRunbookFunction(runbook, "assert_sanctuary_update_source_pin")
    const legacy = extractRunbookFunction(runbook, "assert_legacy_alpha742_source")
    const source = extractRunbookFunction(runbook, "assert_update_source")
    const script = String.raw`set -u
docker() {
  case "$1 $2" in
    "inspect --format") command printf '%s\n' "$BACKUP_IMAGE_ID" ;;
    "inspect "*|"image inspect") command printf '{}\n' ;;
    "run --rm")
      case " $* " in *" $AUDIT_RUNNER_IMAGE_ID "*) command printf 'AUDIT_RUN\n' ;; *) return 29 ;; esac ;;
    *) return 23 ;;
  esac
}
${validateImage}
${audit}
${pin}
${legacy}
${source}
unset IMAGE_ID
assert_update_source "$BACKUP_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
assert_update_source "$BACKUP_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"`
    try {
      const result = runConditionalHelper(script, "unused", {
        AUDIT_TEST_ROOT: testRoot,
        BACKUP_IMAGE_ID: "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d",
        AUDIT_RUNNER_IMAGE_ID: `sha256:${"c".repeat(64)}`,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim().split("\n")).toEqual(["AUDIT_RUN", "AUDIT_RUN"])
      const rejectedRunner = runConditionalHelper(script, "unused", {
        AUDIT_TEST_ROOT: testRoot,
        BACKUP_IMAGE_ID: "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d",
        AUDIT_RUNNER_IMAGE_ID: "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d",
      })
      expect(rejectedRunner.status).not.toBe(0)
      expect(rejectedRunner.stdout).not.toContain("AUDIT_RUN")
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("propagates readiness and optional-rollback lookup faults from conditional functions", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const waitHelper = extractRunbookFunction(runbook, "wait_butler_ready")
    const rollbackHelper = extractRunbookFunction(runbook, "remove_stopped_rollback_if_present")
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-wait-helper-"))
    const dateCount = path.join(testRoot, "date-count")
    fs.writeFileSync(dateCount, "0")
    const waitScript = String.raw`set -u
FAIL_KEY=$1
date() {
  if [ "$FAIL_KEY" = date ]; then return 23; fi
  COUNT=$(command cat "$DATE_COUNT_FILE"); COUNT=$((COUNT + 1)); command printf '%s' "$COUNT" >"$DATE_COUNT_FILE"
  if [ "$COUNT" -gt 2 ]; then command printf '241\n'; else command printf '0\n'; fi
}
docker() { if [ "$FAIL_KEY" = docker ]; then return 23; fi; if [ "$FAIL_KEY" = sleep ]; then command printf 'running starting\n'; else command printf 'running healthy\n'; fi; }
sleep() { if [ "$FAIL_KEY" = sleep ]; then return 23; fi; }
${waitHelper}
if wait_butler_ready ouro-butler; then command printf 'TRANSITION\n'; else STATUS=$?; command printf 'FAILED:%s\n' "$STATUS"; exit "$STATUS"; fi`
    try {
      for (const failKey of ["date", "docker", "sleep"]) {
        fs.writeFileSync(dateCount, "0")
        const result = runConditionalHelper(waitScript, failKey, { DATE_COUNT_FILE: dateCount })
        expect(result.status, `wait:${failKey}\n${result.stderr}`).toBe(23)
        expect(result.stdout).not.toContain("TRANSITION")
      }
      const rollbackScript = String.raw`set -u
FAIL_KEY=$1
docker() {
  case "$1 $2" in
    "container ls") KEY=list ;;
    "inspect --format") case "$3" in *Image*) KEY=inspect-image ;; *) KEY=inspect-state ;; esac ;;
    "rm ouro-butler-rollback") KEY=rm ;;
    *) KEY=other ;;
  esac
  if [ "$FAIL_KEY" = "$KEY" ]; then return 23; fi
  case "$KEY" in list) command printf 'ouro-butler-rollback\n' ;; inspect-state) command printf 'false\n' ;; inspect-image) command printf '%s\n' "$EXPECTED_IMAGE" ;; esac
}
${rollbackHelper}
if remove_stopped_rollback_if_present "$EXPECTED_IMAGE"; then command printf 'TRANSITION\n'; else STATUS=$?; exit "$STATUS"; fi`
      const expectedImage = `sha256:${"d".repeat(64)}`
      for (const failKey of ["list", "inspect-state", "inspect-image", "rm"]) {
        const rollbackFailure = runConditionalHelper(rollbackScript, failKey, { EXPECTED_IMAGE: expectedImage })
        expect(rollbackFailure.status, `rollback:${failKey}\n${rollbackFailure.stderr}`).toBe(23)
        expect(rollbackFailure.stdout).not.toContain("TRANSITION")
      }
      const rollbackSuccess = runConditionalHelper(rollbackScript, "none", { EXPECTED_IMAGE: expectedImage })
      expect(rollbackSuccess.status, rollbackSuccess.stderr).toBe(0)
      expect(rollbackSuccess.stdout).toContain("TRANSITION")
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("rejects unsafe update topologies before any mutation", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const onlyRunning = extractRunbookFunction(runbook, "assert_only_running_butler")
    const preflight = extractRunbookFunction(runbook, "assert_update_topology")
    const expectedImage = `sha256:${"a".repeat(64)}`
    const script = String.raw`set -u
SCENARIO=$1
docker() {
  case "$1 $2 $3" in
    "container ls -a")
      case "$SCENARIO" in staging-running) command printf 'ouro-butler\nouro-butler-staging\n' ;; *) command printf 'ouro-butler\nouro-butler-rollback\n' ;; esac ;;
    "container ls -q")
      case "$SCENARIO" in production-stopped) : ;; *) command printf 'production-id\n' ;; esac ;;
    "container inspect --format")
      case "$4 $5" in "{{.Name}} production-id") command printf '/ouro-butler\n' ;; *) return 23 ;; esac ;;
    "inspect --format {{.State.Running}}")
      case "$4" in ouro-butler) command printf 'true\n' ;; ouro-butler-rollback) command printf 'false\n' ;; esac ;;
    "inspect --format {{.Image}}")
      if [ "$SCENARIO" = rollback-mismatch ] && [ "$4" = ouro-butler-rollback ]; then command printf 'sha256:%064d\n' 0; else command printf '%s\n' "$EXPECTED_IMAGE"; fi ;;
    *) return 23 ;;
  esac
}
${onlyRunning}
${preflight}
if assert_update_topology "$EXPECTED_IMAGE"; then command printf 'MUTATION\n'; else exit $?; fi`
    for (const scenario of ["staging-running", "production-stopped", "rollback-mismatch"]) {
      const result = runConditionalHelper(script, scenario, { EXPECTED_IMAGE: expectedImage })
      expect(result.status, `${scenario}\n${result.stderr}`).not.toBe(0)
      expect(result.stdout).not.toContain("MUTATION")
    }
    const success = runConditionalHelper(script, "safe", { EXPECTED_IMAGE: expectedImage })
    expect(success.status, success.stderr).toBe(0)
    expect(success.stdout).toContain("MUTATION")
  })

  it("rejects hidden running Ouro containers and shared writable Sanctuary roots", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const onlyRunning = extractRunbookFunction(runbook, "assert_only_running_butler")
    const script = String.raw`set -u
SCENARIO=$1
docker() {
  case "$1 $2 $3" in
    "container ls -q") if [ "$SCENARIO" = fail-list ]; then return 23; elif [ "$SCENARIO" != none-safe ]; then command printf 'expected-id\nother-id\n'; fi ;;
    "container inspect --format")
      case "$4 $5" in
        "{{.Name}} expected-id") command printf '/ouro-butler\n' ;;
        "{{.Name}} other-id") if [ "$SCENARIO" = fail-name ]; then return 23; else command printf '/lucid_shockley\n'; fi ;;
        "{{.Image}} expected-id") command printf 'sha256:%064d\n' 1 ;;
        "{{.Image}} other-id")
          case "$SCENARIO" in fail-image) return 23 ;; legacy-image) command printf 'sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d\n' ;; *) command printf 'sha256:%064d\n' 2 ;; esac ;;
        "{{.Config.Image}} expected-id") command printf 'ghcr.io/ourostack/ouroboros-butler:expected\n' ;;
        "{{.Config.Image}} other-id")
          case "$SCENARIO" in fail-ref) return 23 ;; ouro-reference) command printf 'ghcr.io/ourostack/ouroboros-butler:old\n' ;; ouro-short-reference) command printf 'ouro-butler:0.1.0-alpha.742-amd64\n' ;; *) command printf 'example.invalid/unrelated:latest\n' ;; esac ;;
        "{{range .Mounts}}{{if .RW}}{{println .Source}}{{end}}{{end}} expected-id") command printf '/mnt/user/appdata/ouro-butler/runtime/.ouro-cli\n/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro\n' ;;
        "{{range .Mounts}}{{if .RW}}{{println .Source}}{{end}}{{end}} other-id")
          case "$SCENARIO" in fail-mounts) return 23 ;; runtime-root) command printf '/mnt/user/appdata/ouro-butler/runtime/.ouro-cli\n' ;; runtime-parent) command printf '/mnt/user/appdata/ouro-butler/runtime\n' ;; runtime-child) command printf '/mnt/user/appdata/ouro-butler/runtime/.ouro-cli/state\n' ;; agent-root) command printf '/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro\n' ;; agent-parent) command printf '/mnt/user/appdata/ouro-butler/agent\n' ;; package-agent-root) command printf '/mnt/user/appdata/ouro-butler/AgentBundles\n' ;; package-agent-child) command printf '/mnt/user/appdata/ouro-butler/AgentBundles/sanctuary.ouro\n' ;; package-agent-parent) command printf '/mnt/user/appdata/ouro-butler\n' ;; unrelated-empty) : ;; *) command printf '/mnt/user/appdata/unrelated\n' ;; esac ;;
        *) return 23 ;;
      esac ;;
    "image inspect --format")
      test "$4" = '{{with .Config.Labels}}{{index . "org.opencontainers.image.source"}}{{end}}' || return 23
      case "$SCENARIO" in fail-source) return 23 ;; ouro-provenance) command printf 'https://github.com/ourostack/ouroboros\n' ;; *) command printf '<no value>\n' ;; esac ;;
    *) return 23 ;;
  esac
}
${onlyRunning}
if assert_only_running_butler ouro-butler; then command printf 'TRANSITION\n'; else exit $?; fi`
    for (const scenario of ["ouro-provenance", "ouro-reference", "ouro-short-reference", "legacy-image", "runtime-root", "runtime-parent", "runtime-child", "agent-root", "agent-parent", "package-agent-root", "package-agent-child", "package-agent-parent"]) {
      const result = runConditionalHelper(script, scenario)
      expect(result.status, `${scenario}\n${result.stderr}`).not.toBe(0)
      expect(result.stdout).not.toContain("TRANSITION")
    }
    const unrelated = runConditionalHelper(script, "unrelated")
    expect(unrelated.status, unrelated.stderr).toBe(0)
    expect(unrelated.stdout).toContain("TRANSITION")
    const unrelatedEmpty = runConditionalHelper(script, "unrelated-empty")
    expect(unrelatedEmpty.status, unrelatedEmpty.stderr).toBe(0)
    expect(unrelatedEmpty.stdout).toContain("TRANSITION")
    const noneSafe = runConditionalHelper(script.replace("assert_only_running_butler ouro-butler", "assert_only_running_butler -"), "none-safe")
    expect(noneSafe.status, noneSafe.stderr).toBe(0)
    expect(noneSafe.stdout).toContain("TRANSITION")
    for (const scenario of ["fail-list", "fail-name", "fail-image", "fail-ref", "fail-source", "fail-mounts"]) {
      const failure = runConditionalHelper(script, scenario)
      expect(failure.status, `${scenario}\n${failure.stderr}`).toBe(23)
      expect(failure.stdout).not.toContain("TRANSITION")
    }
  })

  it("rejects invalid restore inputs and topology before any mutation", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const imageValidator = extractRunbookFunction(runbook, "validate_exact_image_id")
    const onlyRunning = extractRunbookFunction(runbook, "assert_only_running_butler")
    const preflight = extractRunbookFunction(runbook, "assert_restore_preflight")
    const provenance = extractRunbookFunction(runbook, "verify_sanctuary_snapshot_provenance")
      .replaceAll("/usr/local/bin/node", process.execPath)
      .replace("const expectedUid = 0;", "const expectedUid = process.getuid();")
      .replace("const expectedGid = 0;", "const expectedGid = process.getgid();")
    const audit = extractRunbookFunction(runbook, "audit_effective").replace("/mnt/user/appdata/ouro-butler/staging/inspect.XXXXXX", "$AUDIT_TEST_ROOT/inspect.XXXXXX")
    const sourcePin = extractRunbookFunction(runbook, "assert_sanctuary_update_source_pin")
    const legacySource = extractRunbookFunction(runbook, "assert_legacy_alpha742_source")
    const updateSource = extractRunbookFunction(runbook, "assert_update_source")
    expect(preflight.indexOf('assert_update_source "$RESTORE_PRODUCTION_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"')).toBeGreaterThan(preflight.indexOf("assert_only_running_butler ouro-butler"))
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-restore-preflight-"))
    const validRootPath = path.join(testRoot, "backup")
    fs.mkdirSync(path.join(validRootPath, "runtime", ".ouro-cli"), { recursive: true })
    fs.mkdirSync(path.join(validRootPath, "agent", "sanctuary.ouro"), { recursive: true })
    fs.mkdirSync(path.join(validRootPath, "host", "custom", "ouro-events"), { recursive: true, mode: 0o700 })
    for (const directory of [path.join(validRootPath, "host"), path.join(validRootPath, "host", "custom"), path.join(validRootPath, "host", "custom", "ouro-events")]) fs.chmodSync(directory, 0o700)
    fs.writeFileSync(path.join(validRootPath, "host", "go.butler-lines"), "", { mode: 0o600 })
    fs.writeFileSync(path.join(validRootPath, "host", "crontab.butler-lines"), "", { mode: 0o600 })
    fs.writeFileSync(path.join(validRootPath, "host", "global-state"), "go\tabsent\t-\t0\ncrontab\tabsent\t-\t0\n", { mode: 0o600 })
    fs.writeFileSync(path.join(validRootPath, "host", "inventory"), [
      "absent\tcustom/usenet_health.sh",
      "absent\tcustom/ouro-events/bootstrap-spool.sh",
      "absent\tcustom/ouro-events/emit-event.mjs",
      "absent\tcustom/ouro-events/emit-usenet-event.sh",
      "absent\tcustom/ouro-events/install-usenet-guard.sh",
      "present\tgo.butler-lines",
      "present\tcrontab.butler-lines",
      "present\tglobal-state",
      "",
    ].join("\n"), { mode: 0o600 })
    const validRoot = fs.realpathSync(validRootPath)
    const validImage = `sha256:${"b".repeat(64)}`
    const auditRunnerImage = `sha256:${"d".repeat(64)}`
    const restoreVersionImage = "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.743"
    const provenanceRoot = path.join(validRoot, "provenance")
    const writeProvenance = (imageId = validImage, inspectImageId = imageId, sourceLabel: string | null = "https://github.com/ourostack/ouroboros") => {
      fs.rmSync(provenanceRoot, { recursive: true, force: true })
      fs.mkdirSync(provenanceRoot, { recursive: true, mode: 0o700 })
      const imagePath = path.join(provenanceRoot, "image-id")
      const inspectPath = path.join(provenanceRoot, "container-inspect.json")
      const imageInspectPath = path.join(provenanceRoot, "image-inspect.json")
      const packageVersionPath = path.join(provenanceRoot, "package-version")
      fs.writeFileSync(imagePath, `${imageId}\n`, { mode: 0o600 })
      fs.writeFileSync(inspectPath, `${JSON.stringify([{ Image: inspectImageId, Config: { Image: restoreVersionImage } }])}\n`, { mode: 0o600 })
      const labels = sourceLabel === null ? {} : { "org.opencontainers.image.source": sourceLabel }
      fs.writeFileSync(imageInspectPath, `${JSON.stringify([{ Id: imageId, Config: { Labels: labels } }])}\n`, { mode: 0o600 })
      fs.writeFileSync(packageVersionPath, "0.1.0-alpha.743\n", { mode: 0o600 })
      const entries = [path.join(validRoot, "host", "inventory"), path.join(validRoot, "host", "go.butler-lines"), path.join(validRoot, "host", "crontab.butler-lines"), path.join(validRoot, "host", "global-state"), imagePath, inspectPath, imageInspectPath, packageVersionPath].map((filePath) => {
        const relative = path.relative(validRoot, filePath)
        const digest = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
        return `${digest}  ${relative}`
      }).sort()
      fs.writeFileSync(path.join(provenanceRoot, "manifest.sha256"), `${entries.join("\n")}\n`, { mode: 0o600 })
    }
    writeProvenance()
    const script = String.raw`set -u
SCENARIO=$1
docker() {
  case "$*" in
    "image inspect --format {{.Id}} "*) command printf '%s\n' "$VALID_IMAGE" ;;
    "image inspect --format {{with .Config.Labels}}{{index . \"org.opencontainers.image.source\"}}{{end}} "*) command printf 'https://github.com/ourostack/ouroboros\n' ;;
    "image inspect "*) command printf '{}\n' ;;
    "inspect ouro-butler") command printf '{}\n' ;;
    "run --rm "*) if [ "$SCENARIO" = auditor-fails ]; then return 23; fi ;;
    "container ls -a --format {{.Names}}") if [ "$SCENARIO" = staging ]; then command printf 'ouro-butler\nouro-butler-staging\n'; else command printf 'ouro-butler\n'; fi ;;
    "container ls -q") command printf 'production-id\n' ;;
    "container inspect --format {{.Name}} production-id") command printf '/ouro-butler\n' ;;
    "inspect --format {{.State.Running}} "*) command printf 'true\n' ;;
    "inspect --format {{.Image}} "*) command printf '%s\n' "$VALID_IMAGE" ;;
    "inspect --format {{.Config.Image}} ouro-butler") command printf '%s\n' "$RESTORE_VERSION_IMAGE" ;;
    "inspect --format {{with .Config.Labels}}{{index . \"net.unraid.docker.managed\"}}{{end}} ouro-butler") command printf 'dockerman\n' ;;
    "inspect --format {{with .Config.Labels}}{{index . \"net.unraid.docker.icon\"}}{{end}} ouro-butler") command printf 'https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png\n' ;;
    *) return 23 ;;
  esac
}
stat() {
  if [ "$1" = -c ] && [ "$2" = %u:%g:%a ]; then
    case "$3" in */provenance|*/host) command printf '0:0:700\n' ;; */provenance/*) command printf '0:0:600\n' ;; *) command stat "$@" ;; esac
  else
    command stat "$@"
  fi
}
${imageValidator}
${onlyRunning}
${provenance}
${audit}
${sourcePin}
${legacySource}
${updateSource}
validate_sanctuary_roots() { test "$SCENARIO" != invalid-roots; }
${preflight}
if assert_restore_preflight; then command printf 'MUTATION\n'; else exit $?; fi`
    try {
      const cases = [
        { scenario: "unset", env: {}, unset: true },
        { scenario: "relative", env: { BACKUP_ROOT: "relative", IMAGE_ID: validImage } },
        { scenario: "missing", env: { BACKUP_ROOT: path.join(testRoot, "missing"), IMAGE_ID: validImage } },
        { scenario: "bad-image", env: { BACKUP_ROOT: validRoot, IMAGE_ID: "latest" } },
        { scenario: "legacy-audit-runner", env: { BACKUP_ROOT: validRoot, IMAGE_ID: validImage, AUDIT_RUNNER_IMAGE_ID: "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d" } },
        { scenario: "prepackage-audit-runner", env: { BACKUP_ROOT: validRoot, IMAGE_ID: validImage, AUDIT_RUNNER_IMAGE_ID: "sha256:e337dff04c92d116b269052f473b26a47eea933d017d1befc73af50dd37bb08d" } },
        { scenario: "wrong-snapshot-image", env: { BACKUP_ROOT: validRoot, IMAGE_ID: `sha256:${"c".repeat(64)}` } },
        { scenario: "invalid-roots", env: { BACKUP_ROOT: validRoot, IMAGE_ID: validImage } },
        { scenario: "staging", env: { BACKUP_ROOT: validRoot, IMAGE_ID: validImage } },
        { scenario: "auditor-fails", env: { BACKUP_ROOT: validRoot, IMAGE_ID: validImage } },
      ]
      for (const testCase of cases) {
        const caseScript = testCase.unset ? `unset BACKUP_ROOT IMAGE_ID AUDIT_RUNNER_IMAGE_ID RESTORE_VERSION_IMAGE\n${script}` : script
        const result = runConditionalHelper(caseScript, testCase.scenario, { VALID_IMAGE: validImage, AUDIT_RUNNER_IMAGE_ID: auditRunnerImage, AUDIT_TEST_ROOT: testRoot, RESTORE_VERSION_IMAGE: restoreVersionImage, ...testCase.env })
        expect(result.status, `${testCase.scenario}\n${result.stderr}`).not.toBe(0)
        expect(result.stdout).not.toContain("MUTATION")
      }
      const success = runConditionalHelper(script, "safe", { VALID_IMAGE: validImage, BACKUP_ROOT: validRoot, IMAGE_ID: validImage, AUDIT_RUNNER_IMAGE_ID: auditRunnerImage, AUDIT_TEST_ROOT: testRoot, RESTORE_VERSION_IMAGE: restoreVersionImage })
      expect(success.status, success.stderr).toBe(0)
      expect(success.stdout).toContain("MUTATION")
      const legacyImage = "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d"
      writeProvenance(legacyImage, legacyImage, null)
      const unlabeledLegacy = runConditionalHelper(script, "safe", { VALID_IMAGE: legacyImage, BACKUP_ROOT: validRoot, IMAGE_ID: legacyImage, AUDIT_RUNNER_IMAGE_ID: auditRunnerImage, AUDIT_TEST_ROOT: testRoot, RESTORE_VERSION_IMAGE: restoreVersionImage })
      expect(unlabeledLegacy.status, unlabeledLegacy.stderr).not.toBe(0)
      expect(unlabeledLegacy.stdout).not.toContain("MUTATION")
      writeProvenance(validImage, validImage, null)
      const unlabeledCurrent = runConditionalHelper(script, "safe", { VALID_IMAGE: validImage, BACKUP_ROOT: validRoot, IMAGE_ID: validImage, AUDIT_RUNNER_IMAGE_ID: auditRunnerImage, AUDIT_TEST_ROOT: testRoot, RESTORE_VERSION_IMAGE: restoreVersionImage })
      expect(unlabeledCurrent.status).not.toBe(0)
      expect(unlabeledCurrent.stdout).not.toContain("MUTATION")
      writeProvenance(legacyImage, legacyImage, "https://example.invalid/not-ouroboros")
      const mislabeledLegacy = runConditionalHelper(script, "safe", { VALID_IMAGE: legacyImage, BACKUP_ROOT: validRoot, IMAGE_ID: legacyImage, AUDIT_RUNNER_IMAGE_ID: auditRunnerImage, AUDIT_TEST_ROOT: testRoot, RESTORE_VERSION_IMAGE: restoreVersionImage })
      expect(mislabeledLegacy.status).not.toBe(0)
      expect(mislabeledLegacy.stdout).not.toContain("MUTATION")
      writeProvenance()
      fs.appendFileSync(path.join(provenanceRoot, "image-id"), "tampered")
      const tampered = runConditionalHelper(script, "safe", { VALID_IMAGE: validImage, BACKUP_ROOT: validRoot, IMAGE_ID: validImage, AUDIT_RUNNER_IMAGE_ID: auditRunnerImage, AUDIT_TEST_ROOT: testRoot, RESTORE_VERSION_IMAGE: restoreVersionImage })
      expect(tampered.status).not.toBe(0)
      expect(tampered.stdout).not.toContain("MUTATION")
      writeProvenance()
      fs.writeFileSync(path.join(validRoot, "agent", "sanctuary.ouro", "unmanifested"), "extra")
      const extra = runConditionalHelper(script, "safe", { VALID_IMAGE: validImage, BACKUP_ROOT: validRoot, IMAGE_ID: validImage, AUDIT_RUNNER_IMAGE_ID: auditRunnerImage, AUDIT_TEST_ROOT: testRoot })
      expect(extra.status).not.toBe(0)
      expect(extra.stdout).not.toContain("MUTATION")
      fs.rmSync(path.join(validRoot, "agent", "sanctuary.ouro", "unmanifested"))
      writeProvenance()
      const topLevelExtra = path.join(validRoot, "unexpected")
      fs.writeFileSync(topLevelExtra, "extra")
      const unexpectedFile = runConditionalHelper(script, "safe", { VALID_IMAGE: validImage, BACKUP_ROOT: validRoot, IMAGE_ID: validImage, AUDIT_RUNNER_IMAGE_ID: auditRunnerImage, AUDIT_TEST_ROOT: testRoot })
      expect(unexpectedFile.status).not.toBe(0)
      expect(unexpectedFile.stdout).not.toContain("MUTATION")
      fs.rmSync(topLevelExtra)
      expect(spawnSync("mkfifo", [topLevelExtra]).status).toBe(0)
      const unexpectedFifo = runConditionalHelper(script, "safe", { VALID_IMAGE: validImage, BACKUP_ROOT: validRoot, IMAGE_ID: validImage, AUDIT_RUNNER_IMAGE_ID: auditRunnerImage, AUDIT_TEST_ROOT: testRoot })
      expect(unexpectedFifo.status).not.toBe(0)
      expect(unexpectedFifo.stdout).not.toContain("MUTATION")
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("rejects representative inline credential forms from host snapshots without rejecting references", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const scanner = extractRunbookFunction(runbook, "host_file_contains_inline_credential")
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-host-credential-scan-"))
    const candidate = path.join(testRoot, "candidate")
    const scan = (contents: string) => {
      fs.writeFileSync(candidate, contents, { mode: 0o600 })
      return runConditionalHelper(`${scanner}\nhost_file_contains_inline_credential "$CANDIDATE"`, "unused", { CANDIDATE: candidate })
    }

    for (const contents of [
      "TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi\n",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature\n",
      "curl --token abcdefghijklmnopqrstuvwxyz012345\n",
      "client --api-key=abcdefghijklmnopqrstuvwxyz012345\n",
      "https://service-user:correct-horse-battery-staple@example.invalid/path\n",
      "-----BEGIN PRIVATE KEY-----\nbase64body\n-----END PRIVATE KEY-----\n",
      '{"token":"abcdefghijklmnopqrstuvwxyz012345"}\n',
      "api_key: abcdefghijklmnopqrstuvwxyz012345\n",
      "password: 'correct-horse-battery-staple'\n",
    ]) {
      const result = scan(contents)
      expect(result.status, `${contents}\n${result.stderr}`).toBe(0)
    }

    for (const contents of [
      "Authorization: Bearer $ACCESS_TOKEN\n",
      'curl --token "$ACCESS_TOKEN"\n',
      "https://example.invalid/path\n",
      "-----BEGIN PUBLIC KEY-----\nbase64body\n-----END PUBLIC KEY-----\n",
      '{"token":"${TOKEN_FROM_VAULT}"}\n',
      "api_key: $API_KEY\n",
    ]) {
      const result = scan(contents)
      expect(result.status, `${contents}\n${result.stderr}`).not.toBe(0)
    }

    fs.rmSync(testRoot, { recursive: true, force: true })
  })

  it("snapshots only exact complete canonical Butler go hooks", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const classifier = extractRunbookFunction(runbook, "snapshot_butler_go_fragments")
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-go-fragments-"))
    const source = path.join(testRoot, "go")
    const target = path.join(testRoot, "fragments")
    const canonical = "/bin/bash /boot/config/custom/ouro-events/install-usenet-guard.sh --boot"
    const unrelated = "/bin/bash /opt/team/ouro-events/install-usenet-guard.sh --boot"
    const malicious = `${canonical} --token stolen-secret`
    fs.writeFileSync(source, `#!/bin/bash\n${canonical}\n${unrelated}\n${malicious}\n`, { mode: 0o700 })

    const result = runConditionalHelper(`${classifier}\nsnapshot_butler_go_fragments "$SOURCE" "$TARGET"`, "unused", { SOURCE: source, TARGET: target })
    expect(result.status, result.stderr).toBe(0)
    expect(fs.readFileSync(target, "utf8")).toBe(`${canonical}\n`)
    fs.rmSync(testRoot, { recursive: true, force: true })
  })

  it("snapshots only exact Sanctuary cron lines and excludes marker-bearing commands", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const classifier = extractRunbookFunction(runbook, "snapshot_butler_cron_fragments")
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-cron-fragments-"))
    const source = path.join(testRoot, "crontab")
    const target = path.join(testRoot, "fragments")
    const legacy = "*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh"
    const canonical = `${legacy} # ouro:usenet-health`
    const malicious = "* * * * * curl --token stolen-secret # ouro:usenet-health"
    fs.writeFileSync(source, `${legacy}\n${canonical}\n${malicious}\n`, { mode: 0o600 })

    const result = runConditionalHelper(`${classifier}\nsnapshot_butler_cron_fragments "$SOURCE" "$TARGET"`, "unused", { SOURCE: source, TARGET: target })
    expect(result.status, result.stderr).toBe(0)
    expect(fs.readFileSync(target, "utf8")).toBe(`${legacy}\n${canonical}\n`)
    fs.rmSync(testRoot, { recursive: true, force: true })
  })

  it("creates cron capture files inside a private unpredictable directory", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const createCapture = extractRunbookFunction(runbook, "create_private_cron_capture")
    const victim = path.join(os.tmpdir(), `ouro-cron-victim-${process.pid}`)
    const oldCompanion = path.join(os.tmpdir(), `ouro-backup-crontab-${process.pid}.error`)
    fs.writeFileSync(victim, "untouched\n", { mode: 0o600 })
    fs.symlinkSync(victim, oldCompanion)
    const result = runConditionalHelper(`${createCapture}\ncreate_private_cron_capture || exit $?\nprintf '%s\n%s\n%s\n' "$BACKUP_CRON_ROOT" "$BACKUP_CRON_SOURCE" "$BACKUP_CRON_ERROR"`, "unused")
    expect(result.status, result.stderr).toBe(0)
    const [captureRoot, stdoutPath, stderrPath] = result.stdout.trim().split("\n") as [string, string, string]
    expect(captureRoot).toMatch(/^\/tmp\/ouro-backup-cron\.[A-Za-z0-9]+$/u)
    expect(path.dirname(stdoutPath)).toBe(captureRoot)
    expect(path.dirname(stderrPath)).toBe(captureRoot)
    expect(fs.lstatSync(captureRoot).isSymbolicLink()).toBe(false)
    expect(fs.statSync(captureRoot).mode & 0o777).toBe(0o700)
    expect(fs.statSync(stdoutPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(stderrPath).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(victim, "utf8")).toBe("untouched\n")
    fs.rmSync(captureRoot, { recursive: true, force: true })
    fs.rmSync(oldCompanion, { force: true })
    fs.rmSync(victim, { force: true })
  })

  it("rejects an unsafe initial adoption source before the full Update prelude can mutate", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const updateStart = runbook.indexOf("Update:")
    const preludeEnd = runbook.indexOf("  If extraction or", updateStart)
    const updateEnd = runbook.indexOf("\nBackup:", updateStart)
    expect(updateStart).toBeGreaterThan(-1)
    expect(preludeEnd).toBeGreaterThan(updateStart)
    expect(updateEnd).toBeGreaterThan(preludeEnd)
    const update = runbook.slice(updateStart, updateEnd)
    const updatePrelude = runbook.slice(updateStart, preludeEnd).split("\n")
      .filter((line) => line.startsWith("    "))
      .map((line) => line.slice(4))
      .join("\n")
      .replace("PACKAGE_VERSION=<released-version>", "PACKAGE_VERSION=0.1.0-alpha.798")
      .replace("MANIFEST_DIGEST=sha256:<reviewed-release-manifest-digest>", `MANIFEST_DIGEST=sha256:${"f".repeat(64)}`)
      .replace("IMAGE_ID=sha256:<reviewed-local-image-id>", `IMAGE_ID=sha256:${"e".repeat(64)}`)
    const gateIndex = update.indexOf("admit_sanctuary_update_entry")
    expect(gateIndex).toBeGreaterThan(-1)
    for (const mutation of [
      'docker pull "$VERSION_IMAGE"',
      "EVENT_ASSET_STAGE=$(mktemp -d",
      'mkdir "$EVENT_SCRIPT_STAGE"',
      "trap cleanup_event_asset_stage EXIT",
      'docker create --pull=never --network none --read-only --entrypoint /bin/false "$IMAGE_ID"',
      'docker cp "$EVENT_ASSET_CONTAINER:',
      'docker rm "$EVENT_ASSET_CONTAINER"',
      'chown 0:0 "$STAGED_TEMPLATE"',
      '/bin/bash "$EVENT_SCRIPT_STAGE/install-usenet-guard.sh"',
      "/bin/bash /boot/config/custom/ouro-events/install-usenet-guard.sh --boot",
      "fs.writeFileSync(destinationPath",
      "prepare_sanctuary_legacy_adoption",
      "provision_sanctuary_sab_credential",
      "disable_butler_autostart",
      "docker stop ouro-butler",
    ]) {
      expect(update.indexOf(mutation), mutation).toBeGreaterThan(gateIndex)
    }

    const sourcePin = extractRunbookFunction(runbook, "assert_sanctuary_update_source_pin")
    const entryAdmission = extractRunbookFunction(runbook, "admit_sanctuary_update_entry")
      .replaceAll("/boot/config/custom/ouro-butler/docker-man-template-transaction.json", "$ENTRY_JOURNAL")
    const script = String.raw`set -eu
SCENARIO=$1
source_image() {
  case "$SCENARIO" in
    canonical-alpha742) command printf '%s\n' "$ALPHA742_IMAGE_ID" ;;
    canonical-alpha797|staging-alpha797) command printf '%s\n' "$ALPHA797_IMAGE_ID" ;;
    package-managed) command printf '%s\n' "$PACKAGE_IMAGE_ID" ;;
    *) command printf '%s\n' "$UNKNOWN_IMAGE_ID" ;;
  esac
}
docker() {
  DOCKER_CALL=$*
  while test "$#" -lt 4; do set -- "$@" ""; done
  if test "$1 $2 $3" = "container ls -a"; then
    case "$SCENARIO" in
      disallowed-name) command printf 'ouro-butler-staging\nouro-butler-shadow\n' ;;
      staging-*) command printf 'ouro-butler-staging\n' ;;
      *) command printf 'ouro-butler\n' ;;
    esac
    return 0
  fi
  if test "$1 $2 $3" = "container ls -q"; then command printf '%s\n' "$LEGACY_CONTAINER_ID"; return 0; fi
  if test "$1 $2 $3" = "container inspect --format" && test "$4" = "{{.Name}}"; then
    case "$SCENARIO" in staging-*|disallowed-name) command printf '/ouro-butler-staging\n' ;; *) command printf '/ouro-butler\n' ;; esac
    return 0
  fi
  if test "$1 $2" = "inspect --format"; then
    case "$3" in
      "{{.State.Running}}") command printf 'true\n' ;;
      "{{.Id}}") command printf '%s\n' "$LEGACY_CONTAINER_ID" ;;
      "{{.Image}}") source_image ;;
      "{{.Config.Image}}") command printf '%s\n' "$PACKAGE_IMAGE_REFERENCE" ;;
      '{{with .Config.Labels}}{{index . "net.unraid.docker.managed"}}{{end}}') command printf 'dockerman\n' ;;
      '{{with .Config.Labels}}{{index . "net.unraid.docker.icon"}}{{end}}') command printf 'https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png\n' ;;
      *) return 89 ;;
    esac
    return 0
  fi
  if test "$1 $2 $3 $4" = "image inspect --format {{.Id}}"; then source_image; return 0; fi
  if test "$1 $2 $3" = "image inspect --format"; then
    if test "$SCENARIO" = canonical-unknown-image; then command printf 'https://example.invalid/not-ouroboros\n'; else command printf 'https://github.com/ourostack/ouroboros\n'; fi
    return 0
  fi
  if test "$1 $2" = "image inspect"; then return 0; fi
  if test "$1 $2 $3" = "buildx imagetools inspect"; then command printf '%s\n' "$TARGET_MANIFEST"; return 0; fi
  command printf 'MUTATION:docker:%s\n' "$DOCKER_CALL" >>"$CALL_LOG"
  return 91
}
${extractRunbookFunction(runbook, "validate_exact_image_id")}
${extractRunbookFunction(runbook, "assert_only_running_butler")}
${extractRunbookFunction(runbook, "assert_update_topology")}
${sourcePin}
${extractRunbookFunction(runbook, "validate_sanctuary_legacy_staging")}
${extractRunbookFunction(runbook, "classify_sanctuary_update_source")}
${entryAdmission}
${updatePrelude}`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-update-entry-pin-"))
    try {
      const callLog = path.join(testRoot, "calls.log")
      const environment = {
        CALL_LOG: callLog,
        ENTRY_JOURNAL: path.join(testRoot, "absent-transaction.json"),
        LEGACY_CONTAINER_ID: "a".repeat(64),
        ALPHA742_IMAGE_ID: "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d",
        ALPHA797_IMAGE_ID: "sha256:e337dff04c92d116b269052f473b26a47eea933d017d1befc73af50dd37bb08d",
        PACKAGE_IMAGE_ID: `sha256:${"d".repeat(64)}`,
        UNKNOWN_IMAGE_ID: `sha256:${"c".repeat(64)}`,
        PACKAGE_IMAGE_REFERENCE: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.796",
        TARGET_MANIFEST: `sha256:${"f".repeat(64)}`,
      }
      for (const scenario of ["staging-unknown-image", "canonical-unknown-image", "disallowed-name"]) {
        fs.writeFileSync(callLog, "", { mode: 0o600 })
        const result = runConditionalHelper(script, scenario, environment)
        expect(result.status, `${scenario}\n${result.stderr}`).not.toBe(0)
        expect(fs.readFileSync(callLog, "utf8"), scenario).toBe("")
      }
      for (const scenario of ["canonical-alpha742", "canonical-alpha797", "staging-alpha797", "package-managed"]) {
        fs.writeFileSync(callLog, "", { mode: 0o600 })
        const result = runConditionalHelper(script, scenario, environment)
        expect(result.status, `${scenario}\n${result.stderr}`).toBe(91)
        expect(fs.readFileSync(callLog, "utf8"), scenario).toBe("MUTATION:docker:pull ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798\n")
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("stages exact recovery tools before repairing an interrupted DockerMan transaction", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const admission = extractRunbookFunction(runbook, "admit_sanctuary_update_entry")
      .replaceAll("/boot/config/custom/ouro-butler/docker-man-template-transaction.json", "$JOURNAL_PATH")
    const updateStart = runbook.indexOf("Update:")
    const updateEnd = runbook.indexOf("\nBackup:", updateStart)
    const update = runbook.slice(updateStart, updateEnd)
    const admissionCall = update.indexOf("admit_sanctuary_update_entry")
    const pull = update.indexOf('docker pull "$VERSION_IMAGE"')
    const exactAudit = update.indexOf('"$IMAGE_ID" --template /audit/sanctuary.exact-image.xml')
    const recoverTemplate = update.indexOf("recover_dockerman_template_transaction")
    const recoverBundle = update.indexOf('recover_pending_sanctuary_bundle_migration "$IMAGE_ID"')
    const classifyRecoveredSource = update.indexOf("classify_sanctuary_update_source", recoverBundle)
    const installGuard = update.indexOf('/bin/bash "$EVENT_SCRIPT_STAGE/install-usenet-guard.sh"')

    expect(admissionCall).toBeGreaterThan(-1)
    expect(admissionCall).toBeLessThan(pull)
    expect(recoverTemplate).toBeGreaterThan(exactAudit)
    expect(recoverBundle).toBeGreaterThan(recoverTemplate)
    expect(classifyRecoveredSource).toBeGreaterThan(recoverBundle)
    expect(installGuard).toBeGreaterThan(classifyRecoveredSource)
    expect(update.indexOf("recover_dockerman_template_transaction", recoverTemplate + 1)).toBe(-1)
    expect(update.indexOf('recover_pending_sanctuary_bundle_migration "$IMAGE_ID"', recoverBundle + 1)).toBe(-1)

    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-update-recovery-admission-"))
    try {
      const journalPath = path.join(testRoot, "docker-man-template-transaction.json")
      const targetPath = path.join(testRoot, "target")
      fs.writeFileSync(targetPath, "target\n", { mode: 0o600 })
      const script = String.raw`set -u
classify_sanctuary_update_source() { command printf 'classify\n' >>"$CALL_LOG"; return "$CLASSIFY_STATUS"; }
stat() { command printf '%s\n' "$JOURNAL_METADATA"; }
${admission}
admit_sanctuary_update_entry`
      const callLog = path.join(testRoot, "calls.log")
      for (const [scenario, prepare, metadata, classifyStatus, expectedStatus, expectedCalls] of [
        ["absent", () => {}, "0:0:600", "73", 73, "classify\n"],
        ["safe", () => fs.writeFileSync(journalPath, "{}\n", { mode: 0o600 }), "0:0:600", "73", 0, ""],
        ["writable", () => fs.writeFileSync(journalPath, "{}\n", { mode: 0o644 }), "0:0:644", "73", 1, ""],
        ["symlink", () => fs.symlinkSync(targetPath, journalPath), "0:0:600", "73", 1, ""],
      ] as const) {
        fs.rmSync(journalPath, { force: true })
        fs.writeFileSync(callLog, "")
        prepare()
        const result = runConditionalHelper(script, "unused", { CALL_LOG: callLog, CLASSIFY_STATUS: classifyStatus, JOURNAL_METADATA: metadata, JOURNAL_PATH: journalPath })
        expect(result.status, `${scenario}: ${result.stderr}`).toBe(expectedStatus)
        expect(fs.readFileSync(callLog, "utf8"), scenario).toBe(expectedCalls)
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("pins and audits the initial adoption source before any adoption mutation", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const sourceAssertion = extractRunbookFunction(runbook, "assert_prepackage_alpha797_source")
    const preparation = extractRunbookFunction(runbook, "prepare_sanctuary_legacy_adoption")
    const adoption = extractRunbookFunction(runbook, "install_from_legacy_staging")
    const validate = preparation.indexOf("validate_sanctuary_legacy_staging")
    const sourceAudit = preparation.indexOf('assert_prepackage_alpha797_source "$PREPARED_LEGACY_IMAGE_ID" "$IMAGE_ID" ouro-butler-staging')
    const adoptionPreparation = adoption.indexOf('prepare_sanctuary_legacy_adoption "$IMAGE_ID"')

    expect(sourceAssertion).toContain("SOURCE_CONTAINER=$3")
    expect(sourceAssertion).toContain('audit_effective "$SOURCE_CONTAINER" "$EXPECTED_SOURCE_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" prepackage-alpha797')
    expect(sourceAudit).toBeGreaterThan(validate)
    for (const mutation of [
      'prepare_canonical_sanctuary_roots "$IMAGE_ID"',
      'bootstrap_sanctuary_vault "$IMAGE_ID"',
      'provision_sanctuary_sab_credential "$IMAGE_ID"',
    ]) {
      expect(preparation.indexOf(mutation)).toBeGreaterThan(sourceAudit)
    }
    expect(adoptionPreparation).toBeGreaterThan(-1)
    for (const mutation of [
      "capture_sanctuary_legacy_evidence",
      '"$STAGED_DOCKERMAN_TRANSACTION" prepare',
      "disable_butler_autostart",
      'docker stop "$LEGACY_STAGING_CONTAINER_ID"',
      "docker create --pull=never --name ouro-butler",
    ]) {
      expect(adoption.indexOf(mutation)).toBeGreaterThan(adoptionPreparation)
    }

    const script = String.raw`set -u
SCENARIO=$1
validate_exact_image_id() { return 0; }
validate_sanctuary_legacy_staging() {
  LEGACY_STAGING_CONTAINER_ID=$(command printf '%064d' 1)
  case "$SCENARIO" in
    unknown-image) LEGACY_STAGING_IMAGE_ID=$UNKNOWN_LEGACY_IMAGE ;;
    third-name) LEGACY_STAGING_IMAGE_ID=$PINNED_LEGACY_IMAGE ;;
    *) return 97 ;;
  esac
}
audit_effective() {
  command printf 'AUDIT:%s:%s:%s:%s\n' "$1" "$2" "$3" "$4" >>"$CALL_LOG"
  test "$SCENARIO" != third-name || return 29
}
${extractRunbookFunction(runbook, "assert_sanctuary_update_source_pin")}
${sourceAssertion}
prepare_canonical_sanctuary_roots() { command printf 'MUTATION:prepare-roots\n' >>"$CALL_LOG"; }
bootstrap_sanctuary_vault() { command printf 'MUTATION:bootstrap-vault\n' >>"$CALL_LOG"; }
provision_sanctuary_sab_credential() { command printf 'MUTATION:provision-sab\n' >>"$CALL_LOG"; }
verify_sanctuary_sab_readiness() { return 0; }
verify_sanctuary_provider_readiness() { return 0; }
capture_sanctuary_legacy_evidence() { command printf 'MUTATION:capture-evidence\n' >>"$CALL_LOG"; }
disable_butler_autostart() { command printf 'MUTATION:disable-autostart\n' >>"$CALL_LOG"; }
enable_butler_autostart() { command printf 'MUTATION:enable-autostart\n' >>"$CALL_LOG"; }
docker() {
  if test "$1 $2 $3" = "inspect --format {{.Image}}"; then
    case "$SCENARIO" in unknown-image) command printf '%s\n' "$UNKNOWN_LEGACY_IMAGE" ;; *) command printf '%s\n' "$PINNED_LEGACY_IMAGE" ;; esac
    return 0
  fi
  case "$1" in
    stop|rename|create|rm|start) command printf 'MUTATION:docker:%s\n' "$*" >>"$CALL_LOG" ;;
  esac
  return 0
}
${preparation}
${adoption}
install_from_legacy_staging`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-adoption-source-pin-"))
    try {
      const callLog = path.join(testRoot, "calls.log")
      const targetImage = `sha256:${"e".repeat(64)}`
      const unknownLegacyImage = `sha256:${"c".repeat(64)}`
      const pinnedLegacyImage = "sha256:e337dff04c92d116b269052f473b26a47eea933d017d1befc73af50dd37bb08d"
      for (const [scenario, expectedStatus, expectedLog] of [
        ["unknown-image", 1, ""],
        ["third-name", 29, `AUDIT:ouro-butler-staging:${pinnedLegacyImage}:${targetImage}:prepackage-alpha797\n`],
      ] as const) {
        fs.writeFileSync(callLog, "", { mode: 0o600 })
        const result = runConditionalHelper(script, scenario, { CALL_LOG: callLog, IMAGE_ID: targetImage, UNKNOWN_LEGACY_IMAGE: unknownLegacyImage, PINNED_LEGACY_IMAGE: pinnedLegacyImage })
        expect(result.status, result.stderr).toBe(expectedStatus)
        expect(fs.readFileSync(callLog, "utf8")).toBe(expectedLog)
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("preserves legacy evidence while promoting one canonical production poller", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const imageValidator = extractRunbookFunction(runbook, "validate_exact_image_id")
    const onlyRunning = extractRunbookFunction(runbook, "assert_only_running_butler")
    const validateLegacy = extractRunbookFunction(runbook, "validate_sanctuary_legacy_staging")
    const adoption = extractRunbookFunction(runbook, "install_from_legacy_staging")
      .replaceAll("/mnt/user/appdata/ouro-butler", "$TEST_ROOT/appdata")
      .replaceAll('/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION"', "docker_man_transaction")
    const image = "sha256:e337dff04c92d116b269052f473b26a47eea933d017d1befc73af50dd37bb08d"
    const script = String.raw`set -u
SCENARIO=$1
docker() {
  command printf '%s\n' "$*" >>"$CALL_LOG"
  case "$*" in
    "container ls -a --format {{.Names}}")
      if [ "$SCENARIO" = extra ]; then command printf 'ouro-butler-staging\nouro-butler-rollback\n'
      else case "$(command cat "$STATE")" in
        legacy|legacy-stopped) command printf 'ouro-butler-staging\n' ;;
        evidence) command printf 'ouro-butler-legacy-evidence\n' ;;
        prod-created|prod-running) command printf 'ouro-butler\nouro-butler-legacy-evidence\n' ;;
      esac; fi ;;
    "container ls -q")
      case "$(command cat "$STATE")" in legacy) command printf 'staging-id\n' ;; prod-running) command printf 'production-id\n' ;; esac ;;
    "container inspect --format {{.Name}} staging-id") command printf '/ouro-butler-staging\n' ;;
    "container inspect --format {{.Name}} production-id") command printf '/ouro-butler\n' ;;
    "inspect --format {{.Image}} "*) if [ "$SCENARIO" = mismatch ] && [ "$(command cat "$STATE")" = legacy ]; then command printf 'not-an-image\n'; elif [ "$4" = ouro-butler-legacy-evidence ]; then command printf '%s\n' "$LEGACY_IMAGE"; elif [ "$(command cat "$STATE")" = legacy ] || [ "$(command cat "$STATE")" = legacy-stopped ]; then command printf '%s\n' "$LEGACY_IMAGE"; else command printf '%s\n' "$TARGET_IMAGE"; fi ;;
    "inspect --format {{.Id}} ouro-butler-staging") command printf '%064d\n' 1 ;;
    "inspect --format {{.State.Running}} "*) case "$(command cat "$STATE")" in legacy|prod-running) command printf 'true\n' ;; *) command printf 'false\n' ;; esac ;;
    "buildx imagetools inspect "*) command printf '%s\n' "$MANIFEST_DIGEST" ;;
    "image inspect --format {{.Id}} "*) command printf '%s\n' "$TARGET_IMAGE" ;;
    "image inspect "*) return 0 ;;
    "container inspect ouro-butler-staging") command printf '{}\n' ;;
    "stop "*) case "$(command cat "$STATE")" in legacy) command printf legacy-stopped >"$STATE" ;; esac ;;
    "rename "*" ouro-butler-legacy-evidence") command printf evidence >"$STATE" ;;
    "create --pull=never --name ouro-butler "*) command printf prod-created >"$STATE" ;;
    "start ouro-butler") command printf prod-running >"$STATE" ;;
    *) return 0 ;;
  esac
}
install() { eval "INSTALL_LAST=\${$#}"; command mkdir -p "$INSTALL_LAST"; }
chmod() { return 0; }
sync() { return 0; }
audit_effective() { return 0; }
disable_butler_autostart() { return 0; }
enable_butler_autostart() { return 0; }
wait_butler_ready() { return 0; }
prepare_canonical_sanctuary_roots() { return 0; }
bootstrap_sanctuary_vault() { return 0; }
prepare_sanctuary_legacy_adoption() { LEGACY_STAGING_CONTAINER_ID=$(command printf '%064d' 1); LEGACY_STAGING_IMAGE_ID=$LEGACY_IMAGE; }
verify_sanctuary_provider_readiness() { return 0; }
capture_sanctuary_legacy_evidence() { return 0; }
docker_man_transaction() { command printf 'transaction:%s\n' "$1" >>"$CALL_LOG"; }
write_dockerman_final_proof() { command printf '%s\n' "$TEST_ROOT/final-proof.json"; }
verify_known_good_rollback_artifact() { test "$1" = "$LEGACY_IMAGE"; }
${imageValidator}
${onlyRunning}
${validateLegacy}
${adoption}
if install_from_legacy_staging; then command printf 'ADOPTED\n'; else exit $?; fi`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-adoption-"))
    try {
      for (const scenario of ["extra", "mismatch"]) {
        const callLog = path.join(testRoot, `${scenario}.log`)
        const state = path.join(testRoot, `${scenario}.state`)
        fs.writeFileSync(state, "legacy")
        const result = runConditionalHelper(script, scenario, { CALL_LOG: callLog, STATE: state, TEST_ROOT: testRoot, EVENT_ASSET_STAGE: testRoot, LEGACY_IMAGE: image, TARGET_IMAGE: `sha256:${"e".repeat(64)}`, IMAGE_ID: `sha256:${"e".repeat(64)}`, STAGED_TEMPLATE: "/stage/sanctuary.xml", VERSION_IMAGE: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798", MANIFEST_DIGEST: `sha256:${"f".repeat(64)}`, TEMPLATE_ICON: "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png" })
        expect(result.status, `${scenario}\n${result.stderr}`).not.toBe(0)
        expect(result.stdout).not.toContain("ADOPTED")
        expect(fs.readFileSync(callLog, "utf8")).not.toContain("rm ")
      }
      const callLog = path.join(testRoot, "legacy.log")
      const state = path.join(testRoot, "legacy.state")
      fs.writeFileSync(state, "legacy")
      const success = runConditionalHelper(script, "legacy", { CALL_LOG: callLog, STATE: state, TEST_ROOT: testRoot, EVENT_ASSET_STAGE: testRoot, LEGACY_IMAGE: image, TARGET_IMAGE: `sha256:${"e".repeat(64)}`, IMAGE_ID: `sha256:${"e".repeat(64)}`, STAGED_TEMPLATE: "/stage/sanctuary.xml", VERSION_IMAGE: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798", MANIFEST_DIGEST: `sha256:${"f".repeat(64)}`, TEMPLATE_ICON: "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png" })
      expect(success.status, success.stderr).toBe(0)
      expect(success.stdout).toContain("ADOPTED")
      const calls = fs.readFileSync(callLog, "utf8")
      expect(calls).toContain(`stop ${"0".repeat(63)}1`)
      expect(calls).toContain(`rename ${"0".repeat(63)}1 ouro-butler-legacy-evidence`)
      expect(calls).not.toContain("create --name ouro-butler-staging")
      expect(calls).not.toContain("start ouro-butler-staging")
      expect(calls).not.toContain("rm ouro-butler-staging")
      expect(calls).toContain("create --pull=never --name ouro-butler")
      expect(calls).toContain("start ouro-butler")
      expect(calls).not.toContain("rm ouro-butler-legacy-evidence")
      expect(calls).toContain("transaction:prepare")
      expect(calls).toContain("transaction:mark-committing")
      expect(calls).toContain("transaction:commit")
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("prepares and bootstraps canonical roots from the exact image before stopping legacy", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const adoption = extractRunbookFunction(runbook, "install_from_legacy_staging")
    const preparation = extractRunbookFunction(runbook, "prepare_sanctuary_legacy_adoption")
    const prepare = preparation.indexOf('prepare_canonical_sanctuary_roots "$IMAGE_ID"')
    const bootstrap = preparation.indexOf('bootstrap_sanctuary_vault "$IMAGE_ID"', prepare)
    const readiness = adoption.indexOf('verify_sanctuary_provider_readiness "$IMAGE_ID"')
    const stopLegacy = adoption.indexOf("docker stop ouro-butler-staging", readiness)

    expect(prepare).toBeGreaterThan(-1)
    expect(bootstrap).toBeGreaterThan(prepare)
    expect(stopLegacy).toBeGreaterThan(bootstrap)
    expect(runbook).not.toContain('discardProviderCredentialRecords: { providers: ["minimax"] }')

    const script = String.raw`set -u
SCENARIO=$1
docker() {
  command printf '%s\n' "$*" >>"$CALL_LOG"
  case "$*" in
    "container ls -a --format {{.Names}}") command printf 'ouro-butler-staging\n' ;;
    "container ls --format {{.Names}}") command printf 'ouro-butler-staging\n' ;;
    "inspect --format {{.Image}} ouro-butler-staging") command printf '%s\n' "$LEGACY_IMAGE" ;;
    "image inspect "*) return 0 ;;
    *) return 0 ;;
  esac
}
validate_sanctuary_legacy_staging() { LEGACY_STAGING_CONTAINER_ID=$(command printf '%064d' 1); LEGACY_STAGING_IMAGE_ID=$LEGACY_IMAGE; }
assert_prepackage_alpha797_source() { command printf 'audit %s %s %s\n' "$1" "$2" "$3" >>"$CALL_LOG"; }
prepare_canonical_sanctuary_roots() { command printf 'prepare %s\n' "$1" >>"$CALL_LOG"; }
bootstrap_sanctuary_vault() { command printf 'bootstrap %s\n' "$1" >>"$CALL_LOG"; return 23; }
validate_exact_image_id() { return 0; }
assert_only_running_butler() { return 0; }
${preparation}
prepare_sanctuary_legacy_adoption "$IMAGE_ID"`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-adoption-prestop-"))
    try {
      const callLog = path.join(testRoot, "calls.log")
      const image = `sha256:${"f".repeat(64)}`
      const legacyImage = "sha256:e337dff04c92d116b269052f473b26a47eea933d017d1befc73af50dd37bb08d"
      const result = runConditionalHelper(script, "bootstrap-failure", { CALL_LOG: callLog, LEGACY_IMAGE: legacyImage, IMAGE_ID: image })
      expect(result.status, result.stderr).toBe(23)
      const calls = fs.readFileSync(callLog, "utf8")
      expect(calls).toContain(`audit ${legacyImage} ${image} ouro-butler-staging`)
      expect(calls).toContain(`prepare ${image}`)
      expect(calls).toContain(`bootstrap ${image}`)
      expect(calls).not.toContain("stop ouro-butler-staging")
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("installs the packaged Sanctuary skeleton from the exact image with locked modes", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const imageValidator = extractRunbookFunction(runbook, "validate_exact_image_id")
    const prepare = extractRunbookFunction(runbook, "prepare_canonical_sanctuary_roots").replaceAll("/mnt/user/appdata/ouro-butler", "$TEST_ROOT/appdata")
    const image = `sha256:${"6".repeat(64)}`
    const script = String.raw`set -u
docker() {
  command printf '%s\n' "$*" >>"$CALL_LOG"
  case "$*" in
    "image inspect "*) return 0 ;;
    "container inspect ouro-butler-bundle-bootstrap") return 1 ;;
    "run --rm --pull=never --network=none --name ouro-butler-bundle-bootstrap "*)
      for FILE in agent.json bundle-meta.json provider-readiness.json tool-profiles.json psyche/SOUL.md habits/sanctuary-health.md; do
        command mkdir -p "$TEST_ROOT/appdata/agent/sanctuary.ouro/$(command dirname "$FILE")"
        command printf '{}\n' >"$TEST_ROOT/appdata/agent/sanctuary.ouro/$FILE"
      done
      command find "$TEST_ROOT/appdata" -type d -exec chmod 0700 {} +
      command find "$TEST_ROOT/appdata" -type f -exec chmod 0600 {} +
      ;;
    *) return 23 ;;
  esac
}
find() { case "$*" in *"! -user 10001"*) return 0 ;; *) command find "$@" ;; esac; }
install() { eval "INSTALL_LAST=\${$#}"; command mkdir -p "$INSTALL_LAST"; command chmod 0700 "$INSTALL_LAST"; }
ensure_sanctuary_machine_identity() { command printf '{"schemaVersion":1,"machineId":"sanctuary","createdAt":"x","updatedAt":"x","hostnameAliases":[]}\n' >"$1"; command chmod 0600 "$1"; }
${imageValidator}
${prepare}
prepare_canonical_sanctuary_roots "$IMAGE_ID"`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-canonical-roots-"))
    try {
      const callLog = path.join(testRoot, "calls.log")
      const result = runConditionalHelper(script, "safe", { CALL_LOG: callLog, TEST_ROOT: testRoot, IMAGE_ID: image })
      expect(result.status, result.stderr).toBe(0)
      const calls = fs.readFileSync(callLog, "utf8")
      const copyCall = calls.split("\n").find((line) => line.startsWith("run --rm --pull=never --network=none --name ouro-butler-bundle-bootstrap "))
      expect(copyCall).toContain("--user 10001:10001")
      expect(copyCall).toContain(`--entrypoint /bin/sh ${image} -ceu`)
      expect(calls).toContain("/opt/ouro/deploy/unraid/sanctuary.ouro/.")
      expect(calls).toContain("/home/ouro/AgentBundles/sanctuary.ouro/")
      expect(fs.statSync(path.join(testRoot, "appdata", "agent", "sanctuary.ouro", "agent.json")).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.join(testRoot, "appdata", "agent", "sanctuary.ouro", "psyche")).mode & 0o777).toBe(0o700)
      const machine = JSON.parse(fs.readFileSync(path.join(testRoot, "appdata", "runtime", ".ouro-cli", "machine.json"), "utf8")) as { machineId: string }
      expect(machine.machineId).toBe("sanctuary")
      expect(calls).not.toContain("machine_")
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("branches vault bootstrap through same-image canonical interactive containers without running readiness", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const imageValidator = extractRunbookFunction(runbook, "validate_exact_image_id")
    const helper = extractRunbookFunction(runbook, "bootstrap_sanctuary_vault")
      .replaceAll("/mnt/user/appdata/ouro-butler/runtime/container-credentials.json", "$LEGACY_SOURCE")
      .replaceAll("/mnt/user/appdata/ouro-butler/runtime/.ouro-cli", "$CANONICAL_RUNTIME_ROOT")
    const script = String.raw`set -u
SCENARIO=$1
stat() { case "$*" in *container-credentials.json*) command printf '10001:10001 600\n' ;; *) command stat "$@" ;; esac; }
install() { eval "INSTALL_TARGET=\${$#}"; command cp "$LEGACY_SOURCE" "$INSTALL_TARGET"; command chmod 0600 "$INSTALL_TARGET"; }
chown() { return 0; }
sync() { return 0; }
docker() {
  command printf '%s\n' "$*" >>"$CALL_LOG"
  case "$*" in
    "image inspect "*) return 0 ;;
    "container inspect "*) return 1 ;;
    *"ouro-entry.js vault status --agent sanctuary --store plaintext-file")
      if [ "$SCENARIO" = status-failure ]; then return 23; fi
      if command grep -q 'ouro-entry.js vault \(create\|unlock\) --agent sanctuary --store plaintext-file' "$CALL_LOG"; then
        command printf 'vault locator: agent.json\nlocal unlock: available\n'
      elif [ "$SCENARIO" = absent ]; then command printf 'vault locator: not configured in agent.json\nlocal unlock: not checked\n'
      elif [ "$SCENARIO" = available ] || [ "$SCENARIO" = resume ] || [ "$SCENARIO" = import-failure ]; then command printf 'vault locator: agent.json\nlocal unlock: available\n'
      else command printf 'vault locator: agent.json\nlocal unlock: missing\n'; fi ;;
    *"loadContainerCredentialBootstrap"*)
      if [ "$SCENARIO" = import-failure ]; then command mv "$CANONICAL_SOURCE" "$CANONICAL_SOURCE.consuming"; return 23; fi
      if [ "$SCENARIO" = resume ]; then return 91; fi
      command rm -f "$CANONICAL_SOURCE" "$CANONICAL_SOURCE.consuming" ;;
    *"ouro-entry.js vault create --agent sanctuary --store plaintext-file"|*"ouro-entry.js vault unlock --agent sanctuary --store plaintext-file"|*"ouro-entry.js check --agent sanctuary --lane outward"*) return 0 ;;
    *) return 23 ;;
  esac
}
${imageValidator}
validate_sanctuary_roots() { return 0; }
validate_sanctuary_legacy_import_marker() { test -f "$1"; }
record_sanctuary_legacy_import_marker() { command printf '{"schemaVersion":1,"machineId":"sanctuary","sourceDigest":"sha256:test","importedAt":"2026-08-20T00:00:00.000Z"}\n' >"$1"; }
${helper}
if [ "$SCENARIO" = available ] || [ "$SCENARIO" = import-failure ]; then
  bootstrap_sanctuary_vault "$IMAGE_ID" "$LEGACY_SOURCE" sanctuary-unraid sanctuary
else
  bootstrap_sanctuary_vault "$IMAGE_ID"
fi`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-vault-bootstrap-"))
    const image = `sha256:${"7".repeat(64)}`
    try {
      for (const scenario of ["absent", "existing", "available"]) {
        const callLog = path.join(testRoot, `${scenario}.log`)
        const legacySource = path.join(testRoot, "legacy", "container-credentials.json")
        const canonicalRuntimeRoot = path.join(testRoot, "canonical")
        const canonicalSource = path.join(canonicalRuntimeRoot, "container-credentials.json")
        fs.mkdirSync(path.dirname(legacySource), { recursive: true })
        fs.mkdirSync(canonicalRuntimeRoot, { recursive: true })
        if (scenario === "available") fs.writeFileSync(legacySource, '{"credential":"redacted"}\n', { mode: 0o600 })
        else fs.rmSync(legacySource, { force: true })
        const legacyBytes = scenario === "available" ? fs.readFileSync(legacySource) : null
        const result = runConditionalHelper(script, scenario, {
          CALL_LOG: callLog,
          IMAGE_ID: image,
          LEGACY_SOURCE: legacySource,
          CANONICAL_RUNTIME_ROOT: canonicalRuntimeRoot,
          CANONICAL_SOURCE: canonicalSource,
        })
        expect(result.status, `${scenario}\n${result.stderr}`).toBe(0)
        const calls = fs.readFileSync(callLog, "utf8")
        if (scenario === "available") {
          expect(calls).not.toMatch(/ouro-entry\.js vault (?:create|unlock)/u)
          expect(calls).not.toContain("run --rm -it")
          const importCall = calls.indexOf("loadContainerCredentialBootstrap")
          expect(importCall).toBeGreaterThan(-1)
          expect(calls).not.toContain("ouro-entry.js check --agent sanctuary")
          expect(fs.existsSync(legacySource)).toBe(true)
          expect(fs.readFileSync(legacySource)).toEqual(legacyBytes)
          expect(fs.existsSync(canonicalSource)).toBe(false)
          expect(fs.existsSync(`${canonicalSource}.consuming`)).toBe(false)
          const marker = path.join(canonicalRuntimeRoot, "legacy-credentials-imported.json")
          expect(fs.existsSync(marker)).toBe(true)
          expect(fs.readFileSync(legacySource)).toEqual(legacyBytes)
          expect(calls).not.toContain("ouro-entry.js check --agent sanctuary")
          const resumeLog = path.join(testRoot, "resume.log")
          const resumed = runConditionalHelper(script, "resume", {
            CALL_LOG: resumeLog,
            IMAGE_ID: image,
            LEGACY_SOURCE: legacySource,
            CANONICAL_RUNTIME_ROOT: canonicalRuntimeRoot,
            CANONICAL_SOURCE: canonicalSource,
          })
          expect(resumed.status, resumed.stderr).toBe(0)
          expect(fs.readFileSync(resumeLog, "utf8")).not.toContain("loadContainerCredentialBootstrap")
          expect(fs.existsSync(marker)).toBe(true)
          continue
        }
        const action = scenario === "absent" ? "create" : "unlock"
        const opposite = scenario === "absent" ? "unlock" : "create"
        const actionCall = calls.split("\n").find((line) => line.includes(`ouro-entry.js vault ${action} --agent sanctuary --store plaintext-file`))
        expect(actionCall).toContain("run --rm -it --pull=never --network host")
        expect(actionCall).toContain("--user 10001:10001")
        expect(actionCall).toContain(`type=bind,src=${canonicalRuntimeRoot},dst=/home/ouro/.ouro-cli`)
        expect(actionCall).toContain("type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro")
        expect(actionCall).toContain(`--entrypoint node ${image} /opt/ouro/dist/heart/daemon/ouro-entry.js`)
        expect(calls).not.toContain(`ouro-entry.js vault ${opposite} --agent sanctuary`)
        expect(calls.lastIndexOf("ouro-entry.js vault status --agent sanctuary --store plaintext-file")).toBeGreaterThan(calls.indexOf(`ouro-entry.js vault ${action} --agent sanctuary --store plaintext-file`))
        expect(calls).not.toContain("ouro-entry.js check --agent sanctuary")
      }
      const callLog = path.join(testRoot, "failure.log")
      const failure = runConditionalHelper(script, "status-failure", {
        CALL_LOG: callLog,
        IMAGE_ID: image,
        LEGACY_SOURCE: path.join(testRoot, "legacy", "container-credentials.json"),
        CANONICAL_RUNTIME_ROOT: path.join(testRoot, "canonical"),
        CANONICAL_SOURCE: path.join(testRoot, "canonical", "container-credentials.json"),
      })
      expect(failure.status).toBe(23)
      expect(fs.readFileSync(callLog, "utf8")).not.toMatch(/ouro-entry\.js vault (?:create|unlock)/u)

      const importFailureLog = path.join(testRoot, "import-failure.log")
      const legacySource = path.join(testRoot, "legacy", "container-credentials.json")
      const canonicalRuntimeRoot = path.join(testRoot, "canonical")
      const canonicalSource = path.join(canonicalRuntimeRoot, "container-credentials.json")
      fs.rmSync(path.join(canonicalRuntimeRoot, "legacy-credentials-imported.json"), { force: true })
      fs.mkdirSync(path.dirname(legacySource), { recursive: true })
      fs.writeFileSync(legacySource, '{"credential":"redacted"}\n', { mode: 0o600 })
      const importFailure = runConditionalHelper(script, "import-failure", {
        CALL_LOG: importFailureLog,
        IMAGE_ID: image,
        LEGACY_SOURCE: legacySource,
        CANONICAL_RUNTIME_ROOT: canonicalRuntimeRoot,
        CANONICAL_SOURCE: canonicalSource,
      })
      expect(importFailure.status).toBe(23)
      expect(fs.existsSync(legacySource)).toBe(true)
      expect(fs.existsSync(`${canonicalSource}.consuming`)).toBe(true)
      expect(fs.readFileSync(importFailureLog, "utf8")).not.toContain("ouro-entry.js check --agent sanctuary --lane outward")
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("pins the fixed Sanctuary machine identity and records one-time legacy import authority", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const prepare = extractRunbookFunction(runbook, "prepare_canonical_sanctuary_roots")
    const bootstrap = extractRunbookFunction(runbook, "bootstrap_sanctuary_vault")
    const machine = extractRunbookFunction(runbook, "ensure_sanctuary_machine_identity")
    const validateMarker = extractRunbookFunction(runbook, "validate_sanctuary_legacy_import_marker")
    const recordMarker = extractRunbookFunction(runbook, "record_sanctuary_legacy_import_marker")
    expect(prepare).toContain("$PREPARE_RUNTIME_ROOT/machine.json")
    expect(machine).toContain('value.machineId === "sanctuary"')
    expect(machine).toContain('machineId: "sanctuary"')
    expect(machine).not.toContain("machine_${")
    expect(bootstrap).toContain("legacy-credentials-imported.json")
    expect(validateMarker).toContain("sourceDigest")
    expect(validateMarker).toContain('marker.machineId !== "sanctuary"')
    expect(validateMarker).toContain("sha256")
    expect(recordMarker).toContain('machineId: "sanctuary"')
    expect(recordMarker).toContain('flag: "w"')
    expect(recordMarker).not.toContain('flag: "wx"')
    expect(bootstrap).toContain("sourceMachineId: process.argv[1]")
    expect(bootstrap).toContain("targetMachineId: process.argv[2]")
    expect(bootstrap).toContain('test "$BOOTSTRAP_SOURCE_MACHINE_ID" = sanctuary-unraid')
    expect(bootstrap).toContain('test "$BOOTSTRAP_TARGET_MACHINE_ID" = sanctuary')
    expect(bootstrap).not.toContain("ouro-entry.js check --agent sanctuary")
  })

  it("requires fresh live checks for both configured provider lanes", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const helper = extractRunbookFunction(runbook, "verify_sanctuary_provider_readiness")
    expect(helper).toContain("ouro-entry.js check --agent sanctuary --lane outward")
    expect(helper).toContain("ouro-entry.js check --agent sanctuary --lane inner")
    expect(helper).toContain("umask 077")
    expect(helper).toContain('validate_sanctuary_roots "$READINESS_RUNTIME_ROOT" "$READINESS_AGENT_ROOT"')
    expect(helper).toContain("refreshProviderCredentialPool")
    expect(helper).not.toContain("pingProvider")
    expect(helper.match(/provider: "minimax", model: "MiniMax-M3"/gu)).toHaveLength(1)
    expect(helper).not.toContain('provider: "openai-compatible-gemini", model: "gemini-3.6-flash"')
    expect(helper).not.toContain("ouro-entry.js auth verify --agent sanctuary")
  })

  it("splits legacy preparation, provider authentication, readiness, and noninteractive install authority", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const prepare = extractRunbookFunction(runbook, "prepare_sanctuary_legacy_adoption")
    const bootstrap = extractRunbookFunction(runbook, "bootstrap_sanctuary_vault")
    const authenticate = extractRunbookFunction(runbook, "authenticate_sanctuary_provider")
    const readiness = extractRunbookFunction(runbook, "verify_sanctuary_provider_readiness")
    const install = extractRunbookFunction(runbook, "install_from_legacy_staging")

    expect(prepare).toMatch(/bootstrap_sanctuary_vault "\$IMAGE_ID" \\\n\s+\/mnt\/user\/appdata\/ouro-butler\/runtime\/container-credentials\.json \\\n\s+sanctuary-unraid sanctuary/u)
    expect(bootstrap).toContain("sourceMachineId: process.argv[1]")
    expect(bootstrap).toContain("targetMachineId: process.argv[2]")
    expect(prepare).not.toContain("verify_sanctuary_provider_readiness")
    expect(prepare).not.toContain("disable_butler_autostart")
    expect(prepare).not.toMatch(/docker (?:stop|rename|create|rm) /u)
    expect(authenticate).not.toContain("install_from_legacy_staging")
    expect(readiness).not.toContain("ouro auth verify")
    expect(install).not.toContain("authenticate_sanctuary_provider")
    expect(install).not.toMatch(/ouro-entry\.js auth|ouro auth/u)
  })

  it("rejects non-allowlisted provider authentication before Docker and keeps secrets off argv", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const authenticate = extractRunbookFunction(runbook, "authenticate_sanctuary_provider")
    const image = `sha256:${"8".repeat(64)}`
    const script = String.raw`set -u
docker() { case "$*" in "container inspect "*) return 1 ;; *) command printf '%s\n' "$*" >>"$CALL_LOG" ;; esac; }
validate_exact_image_id() { return 0; }
${authenticate}
authenticate_sanctuary_provider "$IMAGE_ID" "$PROVIDER"`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-auth-"))
    try {
      for (const provider of ["openai", "gemini", "", "openai-compatible-gemini "]) {
        const callLog = path.join(testRoot, `rejected-${provider.replaceAll(/[^a-z]/gu, "_")}.log`)
        const result = runConditionalHelper(script, "auth", { CALL_LOG: callLog, IMAGE_ID: image, PROVIDER: provider })
        expect(result.status, `${provider}\n${result.stderr}`).not.toBe(0)
        expect(fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "").toBe("")
      }
      for (const provider of ["openai-compatible", "openai-compatible-gemini"]) {
        const callLog = path.join(testRoot, `allowed-${provider}.log`)
        const result = runConditionalHelper(script, "auth", { CALL_LOG: callLog, IMAGE_ID: image, PROVIDER: provider })
        expect(result.status, `${provider}\n${result.stderr}`).toBe(0)
        const call = fs.readFileSync(callLog, "utf8")
        expect(call).toContain("run --rm -it --pull=never --network host")
        expect(call).toContain("--user 10001:10001")
        expect(call).toContain("type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli")
        expect(call).toContain("type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro")
        expect(call).toContain(`--entrypoint node ${image}`)
        expect(call).toContain(`auth --agent sanctuary --provider ${provider}`)
        expect(call).not.toMatch(/api[-_]?key|secret|token=/iu)
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("requires exact MiniMax lane bindings and live primary lane checks", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const readiness = extractRunbookFunction(runbook, "verify_sanctuary_provider_readiness")

    expect(readiness).toContain('provider: "minimax"')
    expect(readiness).toContain('model: "MiniMax-M3"')
    expect(readiness).toContain('vaultItem: "providers/minimax"')
    expect(readiness).toContain('selectionPolicy: "explicit-same-lane-only"')
    expect(readiness).toContain("policy.selectionPolicy !== expectedPolicy.selectionPolicy")
    expect(readiness).toContain("revision")
    expect(readiness).toContain("ouro-entry.js check --agent sanctuary --lane outward")
    expect(readiness).toContain("ouro-entry.js check --agent sanctuary --lane inner")
    expect(readiness).not.toContain("ouro-entry.js auth verify")
    expect(readiness).not.toMatch(/AUTH_VERIFY|verify output/iu)
  })

  it("executes the structured provider-readiness matrix and rejects every authority defect", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const readiness = extractRunbookFunction(runbook, "verify_sanctuary_provider_readiness")
    const match = readiness.match(/node - <<'"'"'NODE'"'"'\n([\s\S]*?)\nNODE/u)
    expect(match, "readiness must contain an executable Node heredoc validator").not.toBeNull()
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-readiness-matrix-"))
    const agentPath = path.join(testRoot, "agent.json")
    const contractPath = path.join(testRoot, "provider-readiness.json")
    const credentialsPath = path.join(testRoot, "credentials.json")
    const credentialModule = path.join(testRoot, "provider-credentials.cjs")
    const validator = match![1]!
      .replace('const root = "/home/ouro/AgentBundles/sanctuary.ouro";', `const root = ${JSON.stringify(testRoot)};`)
      .replace('require("/opt/ouro/dist/heart/provider-credentials.js")', `require(${JSON.stringify(credentialModule)})`)
    const exactAgent = {
      humanFacing: { provider: "minimax", model: "MiniMax-M3" },
      agentFacing: { provider: "minimax", model: "MiniMax-M3" },
    }
    const exactContract = {
      version: 1,
      selectionPolicy: "explicit-same-lane-only",
      providers: [
        {
          provider: "minimax", model: "MiniMax-M3",
          vaultItem: "providers/minimax",
        },
      ],
    }
    const exactCredentials = { ok: true, pool: { providers: {
      minimax: {
        provider: "minimax", revision: "sha256:minimax",
        credentials: { apiKey: "minimax-secret" }, config: {},
      },
    } } }
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const run = (
      agent: typeof exactAgent,
      contract: typeof exactContract,
      credentials: typeof exactCredentials,
    ) => {
      fs.writeFileSync(agentPath, JSON.stringify(agent))
      fs.writeFileSync(contractPath, JSON.stringify(contract))
      fs.writeFileSync(credentialsPath, JSON.stringify(credentials))
      return spawnSync(process.execPath, ["-e", validator], {
        encoding: "utf8",
        env: { ...process.env, PROVIDER_FIXTURE: credentialsPath },
      })
    }
    try {
      fs.writeFileSync(credentialModule, 'const fs=require("node:fs");module.exports.refreshProviderCredentialPool=async()=>JSON.parse(fs.readFileSync(process.env.PROVIDER_FIXTURE,"utf8"));\n')
      expect(run(exactAgent, exactContract, exactCredentials).status).toBe(0)
      const failures: Array<[string, typeof exactAgent, typeof exactContract, typeof exactCredentials]> = []
      const missingMiniMax = clone(exactCredentials); delete (missingMiniMax.pool.providers as Record<string, unknown>)["minimax"]
      failures.push(["missing MiniMax", exactAgent, exactContract, missingMiniMax])
      for (const [field, value] of [
        ["provider", "other-provider"],
        ["model", "other-model"],
        ["vaultItem", "providers/wrong"],
      ] as const) {
        const contract = clone(exactContract)
        Object.assign(contract.providers[0]!, { [field]: value })
        failures.push([`wrong ${field}`, exactAgent, contract, exactCredentials])
      }
      const badPolicy = clone(exactContract); badPolicy.selectionPolicy = "fallback-allowed"
      failures.push(["wrong selection policy", exactAgent, badPolicy, exactCredentials])
      const badOutward = clone(exactAgent); badOutward.humanFacing.provider = "openai-compatible-gemini"
      failures.push(["wrong outward binding", badOutward, exactContract, exactCredentials])
      const badInner = clone(exactAgent); badInner.agentFacing.model = "gemini-3.6-flash"
      failures.push(["wrong inner binding", badInner, exactContract, exactCredentials])
      const wrongRecordProvider = clone(exactCredentials); wrongRecordProvider.pool.providers.minimax.provider = "other-provider"
      failures.push(["wrong credential provider", exactAgent, exactContract, wrongRecordProvider])
      for (const [name, agent, contract, credentials] of failures) {
        const result = run(agent, contract, credentials)
        expect(result.status, `${name}\n${result.stderr}`).not.toBe(0)
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it.each([
    "prepare-failure",
    "readiness-failure",
    "container-id-changed",
    "image-id-changed",
    "extra-butler",
    "legacy-stopped",
    "legacy-missing",
  ])("revalidates the exact prepared legacy instance after fresh readiness before mutation: %s", (scenario) => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const install = extractRunbookFunction(runbook, "install_from_legacy_staging")
    const image = `sha256:${"9".repeat(64)}`
    const legacyImage = `sha256:${"a".repeat(64)}`
    const script = String.raw`set -u
SCENARIO=$1
prepare_sanctuary_legacy_adoption() {
  command printf 'prepare\n' >>"$CALL_LOG"
  test "$SCENARIO" != prepare-failure || return 23
  LEGACY_STAGING_CONTAINER_ID=$(command printf '%064d' 1)
  LEGACY_STAGING_IMAGE_ID=$LEGACY_IMAGE
}
verify_sanctuary_provider_readiness() { command printf 'readiness\n' >>"$CALL_LOG"; test "$SCENARIO" != readiness-failure; }
docker() {
  case "$*" in
    "container ls -a --format {{.Names}}") case "$SCENARIO" in extra-butler) command printf 'ouro-butler-staging\nother-butler\n' ;; legacy-missing) : ;; *) command printf 'ouro-butler-staging\n' ;; esac ;;
    "container ls --format {{.Names}}") case "$SCENARIO" in legacy-stopped|legacy-missing) : ;; *) command printf 'ouro-butler-staging\n' ;; esac ;;
    "inspect --format {{.Id}} ouro-butler-staging") if [ "$SCENARIO" = container-id-changed ]; then command printf '%064d\n' 2; else command printf '%064d\n' 1; fi ;;
    "inspect --format {{.Image}} ouro-butler-staging") if [ "$SCENARIO" = image-id-changed ]; then command printf 'sha256:%064d\n' 0; else command printf '%s\n' "$LEGACY_IMAGE"; fi ;;
    "inspect --format {{.State.Running}} ouro-butler-staging") if [ "$SCENARIO" = legacy-stopped ]; then command printf 'false\n'; else command printf 'true\n'; fi ;;
    stop\ *|rename\ *|create\ *|rm\ *) command printf 'MUTATION:%s\n' "$*" >>"$CALL_LOG"; return 23 ;;
    *) return 0 ;;
  esac
}
disable_butler_autostart() { command printf 'MUTATION:disable-autostart\n' >>"$CALL_LOG"; return 23; }
${install}
install_from_legacy_staging`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-adoption-race-"))
    try {
      const callLog = path.join(testRoot, "calls.log")
      const result = runConditionalHelper(script, scenario, { CALL_LOG: callLog, IMAGE_ID: image, LEGACY_IMAGE: legacyImage })
      expect(result.status, `${scenario}\n${result.stderr}`).not.toBe(0)
      const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : ""
      expect(calls).toContain("prepare")
      if (scenario !== "prepare-failure") expect(calls).toContain("readiness")
      expect(calls).not.toContain("MUTATION:")
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("keeps preparation resumable and requires fresh readiness on every final-install retry", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const prepare = extractRunbookFunction(runbook, "prepare_sanctuary_legacy_adoption")
    const bootstrap = extractRunbookFunction(runbook, "bootstrap_sanctuary_vault")
    const install = extractRunbookFunction(runbook, "install_from_legacy_staging")

    expect(bootstrap).toContain("legacy-credentials-imported.json")
    expect(bootstrap).toContain(".consuming")
    expect(bootstrap).toContain("cmp -s")
    expect(bootstrap).toContain("validate_sanctuary_legacy_import_marker")
    expect(bootstrap).not.toMatch(/rm[^\n]*legacy[^\n]*container-credentials|mv[^\n]*legacy[^\n]*container-credentials/iu)
    expect(prepare).toContain('validate_sanctuary_legacy_staging "$PREPARED_LEGACY_CONTAINER_ID" "$PREPARED_LEGACY_IMAGE_ID"')
    expect(install.match(/prepare_sanctuary_legacy_adoption/g)).toHaveLength(1)
    expect(install.match(/verify_sanctuary_provider_readiness/g)).toHaveLength(1)
    expect(install.indexOf("prepare_sanctuary_legacy_adoption")).toBeLessThan(install.indexOf("verify_sanctuary_provider_readiness"))
    expect(install.indexOf("verify_sanctuary_provider_readiness")).toBeLessThan(install.indexOf("disable_butler_autostart"))
    expect(install).not.toMatch(/receipt|READINESS_OK|READY_MARKER/iu)
  })

  it.each([
    ["empty", "empty"],
    ["partial", "partial"],
    ["complete", "complete"],
  ])("resumes exact legacy evidence capture from a %s evidence directory", (_label, scenario) => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const capture = extractRunbookFunction(runbook, "capture_sanctuary_legacy_evidence").replaceAll("/usr/local/bin/node", "node")
    const containerId = "0".repeat(63) + "1"
    const imageId = `sha256:${"a".repeat(64)}`
    const containerJson = `${JSON.stringify([{ Id: containerId, Image: imageId }])}\n`
    const imageJson = `${JSON.stringify([{ Id: imageId }])}\n`
    const script = String.raw`set -u
docker() {
  command printf '%s\n' "$*" >>"$CALL_LOG"
  case "$*" in
    "container inspect $CONTAINER_ID") command printf '%s' "$CONTAINER_JSON" ;;
    "image inspect $IMAGE_ID") command printf '%s' "$IMAGE_JSON" ;;
    *) return 23 ;;
  esac
}
install() { eval "TARGET=\${$#}"; command mkdir -p "$TARGET"; command chmod 0700 "$TARGET"; }
sync() { return 0; }
validate_exact_image_id() { return 0; }
file_inode() { node -e 'const fs = require("node:fs"); process.stdout.write(String(fs.statSync(process.argv[1]).ino))' "$1"; }
${capture}
EVIDENCE_DIR="$EVIDENCE_ROOT/${imageId.slice("sha256:".length)}"
command mkdir -p "$EVIDENCE_DIR"
command chmod 0700 "$EVIDENCE_ROOT" "$EVIDENCE_DIR"
case "$SCENARIO" in
  partial) command printf '%s' "$CONTAINER_JSON" >"$EVIDENCE_DIR/container.json" ;;
  complete)
    command printf '%s' "$CONTAINER_JSON" >"$EVIDENCE_DIR/container.json"
    command printf '%s' "$IMAGE_JSON" >"$EVIDENCE_DIR/image.json"
    ;;
esac
test ! -e "$EVIDENCE_DIR/container.json" || test "$SCENARIO" = partial || command chmod 0600 "$EVIDENCE_DIR/container.json"
test ! -e "$EVIDENCE_DIR/image.json" || command chmod 0600 "$EVIDENCE_DIR/image.json"
BEFORE_CONTAINER_INODE=$(test -e "$EVIDENCE_DIR/container.json" && file_inode "$EVIDENCE_DIR/container.json" || command printf missing)
BEFORE_IMAGE_INODE=$(test -e "$EVIDENCE_DIR/image.json" && file_inode "$EVIDENCE_DIR/image.json" || command printf missing)
capture_sanctuary_legacy_evidence "$CONTAINER_ID" "$IMAGE_ID" "$EVIDENCE_ROOT" || exit $?
command printf 'container-inode:%s:%s\n' "$BEFORE_CONTAINER_INODE" "$(file_inode "$EVIDENCE_DIR/container.json")"
command printf 'image-inode:%s:%s\n' "$BEFORE_IMAGE_INODE" "$(file_inode "$EVIDENCE_DIR/image.json")"`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-legacy-evidence-resume-"))
    try {
      const evidenceRoot = path.join(testRoot, "legacy-evidence")
      const callLog = path.join(testRoot, "calls.log")
      const result = runConditionalHelper(script, scenario, {
        SCENARIO: scenario, EVIDENCE_ROOT: evidenceRoot, CALL_LOG: callLog,
        CONTAINER_ID: containerId, IMAGE_ID: imageId, CONTAINER_JSON: containerJson, IMAGE_JSON: imageJson,
      })
      expect(result.status, result.stderr).toBe(0)
      const evidenceDir = path.join(evidenceRoot, imageId.slice("sha256:".length))
      expect(fs.readFileSync(path.join(evidenceDir, "container.json"), "utf8")).toBe(containerJson)
      expect(fs.readFileSync(path.join(evidenceDir, "image.json"), "utf8")).toBe(imageJson)
      expect(fs.statSync(path.join(evidenceDir, "container.json")).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.join(evidenceDir, "image.json")).mode & 0o777).toBe(0o600)
      const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").trim().split("\n") : []
      expect(calls.filter(call => call.startsWith("container inspect"))).toHaveLength(scenario === "empty" ? 1 : 0)
      expect(calls.filter(call => call.startsWith("image inspect"))).toHaveLength(scenario === "complete" ? 0 : 1)
      if (scenario === "partial") expect(result.stdout).toMatch(/container-inode:(\d+):\1/u)
      if (scenario === "complete") {
        expect(result.stdout).toMatch(/container-inode:(\d+):\1/u)
        expect(result.stdout).toMatch(/image-inode:(\d+):\1/u)
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it.each([
    ["mismatched container evidence", "mismatch"],
    ["symbolic-link evidence", "symlink"],
    ["unexpected evidence entry", "extra"],
    ["failed fresh evidence capture", "capture-failure"],
  ])("fails closed without overwriting or mutating legacy for %s", (_label, scenario) => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const capture = extractRunbookFunction(runbook, "capture_sanctuary_legacy_evidence").replaceAll("/usr/local/bin/node", "node")
    const containerId = "0".repeat(63) + "1"
    const imageId = `sha256:${"a".repeat(64)}`
    const conflicting = `${JSON.stringify([{ Id: "0".repeat(63) + "2", Image: imageId }])}\n`
    const validImage = `${JSON.stringify([{ Id: imageId }])}\n`
    const script = String.raw`set -u
docker() { command printf 'INSPECT:%s\n' "$*" >>"$CALL_LOG"; return 23; }
install() { eval "TARGET=\${$#}"; command mkdir -p "$TARGET"; command chmod 0700 "$TARGET"; }
sync() { return 0; }
validate_exact_image_id() { return 0; }
${capture}
EVIDENCE_DIR="$EVIDENCE_ROOT/${imageId.slice("sha256:".length)}"
command mkdir -p "$EVIDENCE_DIR"
command chmod 0700 "$EVIDENCE_ROOT" "$EVIDENCE_DIR"
command printf '%s' "$CONFLICTING" >"$PRESERVED"
case "$SCENARIO" in
  mismatch) command cp "$PRESERVED" "$EVIDENCE_DIR/container.json" ;;
  symlink) command ln -s "$PRESERVED" "$EVIDENCE_DIR/container.json" ;;
  extra)
    command printf '%s' "$VALID_IMAGE" >"$EVIDENCE_DIR/image.json"
    command printf 'unexpected\n' >"$EVIDENCE_DIR/unexpected"
    ;;
esac
test ! -L "$EVIDENCE_DIR/container.json" && test -e "$EVIDENCE_DIR/container.json" && command chmod 0600 "$EVIDENCE_DIR/container.json" || true
test ! -L "$EVIDENCE_DIR/image.json" && test -e "$EVIDENCE_DIR/image.json" && command chmod 0600 "$EVIDENCE_DIR/image.json" || true
capture_sanctuary_legacy_evidence "$CONTAINER_ID" "$IMAGE_ID" "$EVIDENCE_ROOT"`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-legacy-evidence-reject-"))
    try {
      const evidenceRoot = path.join(testRoot, "legacy-evidence")
      const callLog = path.join(testRoot, "calls.log")
      const preserved = path.join(testRoot, "preserved.json")
      const result = runConditionalHelper(script, scenario, {
        SCENARIO: scenario, EVIDENCE_ROOT: evidenceRoot, CALL_LOG: callLog, PRESERVED: preserved,
        CONTAINER_ID: containerId, IMAGE_ID: imageId, CONFLICTING: conflicting, VALID_IMAGE: validImage,
      })
      expect(result.status, result.stderr).not.toBe(0)
      expect(fs.readFileSync(preserved, "utf8")).toBe(conflicting)
      const evidenceDir = path.join(evidenceRoot, imageId.slice("sha256:".length))
      if (scenario === "mismatch") expect(fs.readFileSync(path.join(evidenceDir, "container.json"), "utf8")).toBe(conflicting)
      if (scenario === "symlink") expect(fs.lstatSync(path.join(evidenceDir, "container.json")).isSymbolicLink()).toBe(true)
      const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : ""
      if (scenario === "capture-failure") expect(calls).toContain("INSPECT:container inspect")
      else expect(calls).toBe("")
      expect(fs.readdirSync(evidenceRoot).some(name => name.startsWith(".capture."))).toBe(false)
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("documents the executable noninteractive adoption phase order", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const heading = "Sanctuary legacy adoption commands:"
    const start = runbook.indexOf(heading)
    const end = runbook.indexOf("\n  These commands", start + heading.length)
    const commands = runbook.slice(start, end === -1 ? undefined : end)

    expect(start).toBeGreaterThan(-1)
    const prepare = commands.indexOf('prepare_sanctuary_legacy_adoption "$IMAGE_ID"')
    const verify = commands.indexOf('verify_sanctuary_provider_readiness "$IMAGE_ID"')
    const install = commands.indexOf("install_from_legacy_staging")
    expect(prepare).toBeGreaterThan(-1)
    expect(commands).not.toContain('authenticate_sanctuary_provider "$IMAGE_ID" openai-compatible')
    expect(verify).toBeGreaterThan(prepare)
    expect(install).toBeGreaterThan(verify)
    expect(commands).not.toMatch(/(?:api[-_]?key|secret|token)=/iu)
  })

  it.each([
    ["container replacement", "replace-id"],
    ["image replacement", "replace-image"],
  ])("rechecks a successfully prechecked legacy instance immediately before mutation: %s", (_name, scenario) => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const install = extractRunbookFunction(runbook, "install_from_legacy_staging")
      .replaceAll("/mnt/user/appdata/ouro-butler", "$TEST_ROOT/appdata")
    const validateLegacy = extractRunbookFunction(runbook, "validate_sanctuary_legacy_staging")
    const image = `sha256:${"8".repeat(64)}`
    const legacyImage = `sha256:${"7".repeat(64)}`
    const script = String.raw`set -u
SCENARIO=$1
prepare_sanctuary_legacy_adoption() {
  LEGACY_STAGING_CONTAINER_ID=$(command printf '%064d' 1)
  LEGACY_STAGING_IMAGE_ID=$LEGACY_IMAGE
}
verify_sanctuary_provider_readiness() { return 0; }
capture_sanctuary_legacy_evidence() { return 0; }
docker() {
  command printf '%s\n' "$*" >>"$CALL_LOG"
  case "$*" in
    "container ls -a --format {{.Names}}"|"container ls --format {{.Names}}") command printf 'ouro-butler-staging\n' ;;
    "inspect --format {{.State.Running}} ouro-butler-staging") command printf 'true\n' ;;
    "inspect --format {{.Id}} ouro-butler-staging")
      COUNT=$(command cat "$ID_COUNT"); COUNT=$((COUNT + 1)); command printf '%s' "$COUNT" >"$ID_COUNT"
      if [ "$SCENARIO" = replace-id ] && [ "$COUNT" -eq 2 ]; then command printf '%064d\n' 2; else command printf '%064d\n' 1; fi ;;
    "inspect --format {{.Image}} ouro-butler-staging")
      COUNT=$(command cat "$IMAGE_COUNT"); COUNT=$((COUNT + 1)); command printf '%s' "$COUNT" >"$IMAGE_COUNT"
      if [ "$SCENARIO" = replace-image ] && [ "$COUNT" -eq 2 ]; then command printf 'sha256:%064d\n' 0; else command printf '%s\n' "$LEGACY_IMAGE"; fi ;;
    "container inspect ouro-butler-staging") command printf '{}\n' ;;
    "image inspect "*) command printf '{}\n' ;;
    stop\ *|rename\ *|create\ *|rm\ *) command printf 'MUTATION:%s\n' "$*" >>"$CALL_LOG"; return 23 ;;
    *) return 0 ;;
  esac
}
assert_only_running_butler() { docker container ls --format '{{.Names}}' >/dev/null; }
validate_exact_image_id() { return 0; }
install() { eval "TARGET=\${$#}"; command mkdir -p "$TARGET"; }
mkdir() { eval "TARGET=\${$#}"; command mkdir -p "$TARGET"; }
chmod() { return 0; }
sync() { return 0; }
disable_butler_autostart() { command printf 'MUTATION:disable-autostart\n' >>"$CALL_LOG"; return 23; }
${validateLegacy}
${install}
install_from_legacy_staging`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-adoption-outgoing-race-"))
    try {
      const callLog = path.join(testRoot, "calls.log")
      const idCount = path.join(testRoot, "id-count")
      const imageCount = path.join(testRoot, "image-count")
      fs.writeFileSync(idCount, "0")
      fs.writeFileSync(imageCount, "0")
      const result = runConditionalHelper(script, scenario, {
        CALL_LOG: callLog, ID_COUNT: idCount, IMAGE_COUNT: imageCount, IMAGE_ID: image,
        LEGACY_IMAGE: legacyImage, TEST_ROOT: testRoot,
      })
      expect(result.status, result.stderr).not.toBe(0)
      const calls = fs.readFileSync(callLog, "utf8").trim().split("\n")
      expect(calls.filter(call => call === "inspect --format {{.Id}} ouro-butler-staging"), `${result.stderr}\n${calls.join("\n")}`).toHaveLength(2)
      if (scenario === "replace-image") {
        expect(calls.filter(call => call === "inspect --format {{.Image}} ouro-butler-staging")).toHaveLength(2)
      }
      expect(calls.some(call => call.startsWith("MUTATION:"))).toBe(false)
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("targets the captured container ID after the outgoing exact-instance inspection", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const install = extractRunbookFunction(runbook, "install_from_legacy_staging")
    const outgoing = install.lastIndexOf('validate_sanctuary_legacy_staging "$ADOPTION_PREPARED_CONTAINER_ID" "$ADOPTION_PREPARED_IMAGE_ID"')
    const disable = install.indexOf("disable_butler_autostart", outgoing)
    const stop = install.indexOf('docker stop "$LEGACY_STAGING_CONTAINER_ID"', disable)
    const rename = install.indexOf('docker rename "$LEGACY_STAGING_CONTAINER_ID" ouro-butler-legacy-evidence', stop)

    expect(outgoing).toBeGreaterThan(-1)
    expect(disable).toBeGreaterThan(outgoing)
    expect(stop).toBeGreaterThan(disable)
    expect(rename).toBeGreaterThan(stop)
    expect(install.slice(outgoing, disable).match(/validate_sanctuary_legacy_staging/g)).toHaveLength(1)
  })

  it("never stops a same-name replacement introduced after the outgoing inspection succeeds", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const validateLegacy = extractRunbookFunction(runbook, "validate_sanctuary_legacy_staging")
    const install = extractRunbookFunction(runbook, "install_from_legacy_staging")
      .replaceAll("/mnt/user/appdata/ouro-butler", "$TEST_ROOT/appdata")
      .replaceAll('/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION"', "docker_man_transaction")
    const targetImage = `sha256:${"6".repeat(64)}`
    const legacyImage = `sha256:${"5".repeat(64)}`
    const originalId = "0".repeat(63) + "1"
    const replacementId = "0".repeat(63) + "2"
    const script = String.raw`set -u
prepare_sanctuary_legacy_adoption() { LEGACY_STAGING_CONTAINER_ID=$ORIGINAL_ID; LEGACY_STAGING_IMAGE_ID=$LEGACY_IMAGE; }
verify_sanctuary_provider_readiness() { return 0; }
capture_sanctuary_legacy_evidence() { return 0; }
docker() {
  command printf '%s\n' "$*" >>"$CALL_LOG"
  case "$*" in
    "container ls -a --format {{.Names}}"|"container ls --format {{.Names}}") command printf 'ouro-butler-staging\n' ;;
    "inspect --format {{.State.Running}} ouro-butler-staging") command printf 'true\n' ;;
    "inspect --format {{.Id}} ouro-butler-staging") if [ -e "$REPLACED" ]; then command printf '%s\n' "$REPLACEMENT_ID"; else command printf '%s\n' "$ORIGINAL_ID"; fi ;;
    "inspect --format {{.Image}} ouro-butler-staging") command printf '%s\n' "$LEGACY_IMAGE" ;;
    "container inspect "*) command printf '{}\n' ;;
    "image inspect "*) command printf '{}\n' ;;
    "stop $ORIGINAL_ID") return 23 ;;
    stop\ *|rename\ *|create\ *|rm\ *) command printf 'TOPOLOGY:%s\n' "$*" >>"$CALL_LOG"; return 23 ;;
    *) return 0 ;;
  esac
}
assert_only_running_butler() { docker container ls --format '{{.Names}}' >/dev/null; }
validate_exact_image_id() { return 0; }
install() { eval "TARGET=\${$#}"; command mkdir -p "$TARGET"; }
mkdir() { eval "TARGET=\${$#}"; command mkdir -p "$TARGET"; }
chmod() { return 0; }
sync() { return 0; }
disable_butler_autostart() { command : >"$REPLACED"; command printf 'DISABLE\n' >>"$CALL_LOG"; }
docker_man_transaction() { command printf 'transaction:%s\n' "$1" >>"$CALL_LOG"; }
${validateLegacy}
${install}
install_from_legacy_staging`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-adoption-post-check-replacement-"))
    try {
      const callLog = path.join(testRoot, "calls.log")
      const result = runConditionalHelper(script, "replacement", {
        CALL_LOG: callLog, REPLACED: path.join(testRoot, "replaced"), TEST_ROOT: testRoot,
        IMAGE_ID: targetImage, LEGACY_IMAGE: legacyImage, ORIGINAL_ID: originalId, REPLACEMENT_ID: replacementId,
        STAGED_TEMPLATE: "/stage/sanctuary.xml", VERSION_IMAGE: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798", MANIFEST_DIGEST: `sha256:${"f".repeat(64)}`,
      })
      expect(result.status, result.stderr).not.toBe(0)
      const calls = fs.readFileSync(callLog, "utf8").trim().split("\n")
      const outgoingIdInspect = calls.filter(call => call === "inspect --format {{.Id}} ouro-butler-staging")
      const outgoingImageInspect = calls.filter(call => call === "inspect --format {{.Image}} ouro-butler-staging")
      const disable = calls.indexOf("DISABLE")
      const stopCaptured = calls.indexOf(`stop ${originalId}`)
      expect(outgoingIdInspect).toHaveLength(3)
      expect(outgoingImageInspect).toHaveLength(3)
      expect(disable).toBeGreaterThan(calls.lastIndexOf("inspect --format {{.Image}} ouro-butler-staging", disable))
      expect(stopCaptured).toBeGreaterThan(disable)
      expect(calls).not.toContain("stop ouro-butler-staging")
      expect(calls.some(call => call.startsWith("TOPOLOGY:"))).toBe(false)
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("retries failed authentication with the same bounded ephemeral command and no persisted secret argument", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const authenticate = extractRunbookFunction(runbook, "authenticate_sanctuary_provider")
    const image = `sha256:${"b".repeat(64)}`
    const script = String.raw`set -u
docker() {
  case "$*" in
    "container inspect "*) return 1 ;;
    *) command printf '%s\n' "$*" >>"$CALL_LOG"; COUNT=$(command cat "$COUNT_FILE"); COUNT=$((COUNT + 1)); command printf '%s' "$COUNT" >"$COUNT_FILE"; test "$COUNT" -gt 1 ;;
  esac
}
validate_exact_image_id() { return 0; }
${authenticate}
if authenticate_sanctuary_provider "$IMAGE_ID" openai-compatible; then exit 91; fi
authenticate_sanctuary_provider "$IMAGE_ID" openai-compatible`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-auth-retry-"))
    try {
      const countFile = path.join(testRoot, "count")
      const callLog = path.join(testRoot, "calls.log")
      fs.writeFileSync(countFile, "0")
      const result = runConditionalHelper(script, "retry", { COUNT_FILE: countFile, CALL_LOG: callLog, IMAGE_ID: image })
      expect(result.status, result.stderr).toBe(0)
      const calls = fs.readFileSync(callLog, "utf8").trim().split("\n")
      expect(calls).toHaveLength(2)
      expect(calls[1]).toBe(calls[0])
      expect(calls[0]).toContain("run --rm -it")
      expect(calls[0]).toContain(image)
      expect(calls[0]).not.toMatch(/api[-_]?key|secret|token=/iu)
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("reruns preparation and fresh verification after an interrupted final-install attempt", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const install = extractRunbookFunction(runbook, "install_from_legacy_staging")
      .replaceAll("/mnt/user/appdata/ouro-butler", "$TEST_ROOT/appdata")
      .replaceAll('/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION"', "docker_man_transaction")
    const image = `sha256:${"c".repeat(64)}`
    const legacyImage = `sha256:${"d".repeat(64)}`
    const script = String.raw`set -u
prepare_sanctuary_legacy_adoption() {
  command printf 'prepare\n' >>"$CALL_LOG"
  LEGACY_STAGING_CONTAINER_ID=$(command printf '%064d' 1)
  LEGACY_STAGING_IMAGE_ID=$LEGACY_IMAGE
}
verify_sanctuary_provider_readiness() {
  command printf 'verify\n' >>"$CALL_LOG"
  COUNT=$(command cat "$VERIFY_COUNT"); COUNT=$((COUNT + 1)); command printf '%s' "$COUNT" >"$VERIFY_COUNT"
  test "$COUNT" -gt 1
}
capture_sanctuary_legacy_evidence() { return 0; }
docker() {
  case "$*" in
    "container ls -a --format {{.Names}}"|"container ls --format {{.Names}}") command printf 'ouro-butler-staging\n' ;;
    "inspect --format {{.Id}} ouro-butler-staging") command printf '%064d\n' 1 ;;
    "inspect --format {{.Image}} ouro-butler-staging") command printf '%s\n' "$LEGACY_IMAGE" ;;
    "inspect --format {{.State.Running}} ouro-butler-staging") command printf 'true\n' ;;
    "container inspect ouro-butler-staging") command printf '{}\n' ;;
    "image inspect "*) command printf '{}\n' ;;
    stop\ *|rename\ *|create\ *|rm\ *) command printf 'MUTATION:%s\n' "$*" >>"$CALL_LOG"; return 23 ;;
    *) return 0 ;;
  esac
}
validate_exact_image_id() { return 0; }
assert_only_running_butler() { return 0; }
install() { eval "TARGET=\${$#}"; command mkdir -p "$TARGET"; }
mkdir() { eval "TARGET=\${$#}"; command mkdir -p "$TARGET"; }
chmod() { return 0; }
sync() { return 0; }
disable_butler_autostart() { command printf 'MUTATION:disable-autostart\n' >>"$CALL_LOG"; return 23; }
docker_man_transaction() { command printf 'transaction:%s\n' "$1" >>"$CALL_LOG"; }
validate_sanctuary_legacy_staging() { return 0; }
${install}
if install_from_legacy_staging; then exit 91; fi
install_from_legacy_staging`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-adoption-resume-"))
    try {
      const callLog = path.join(testRoot, "calls.log")
      const verifyCount = path.join(testRoot, "verify-count")
      fs.writeFileSync(verifyCount, "0")
      const result = runConditionalHelper(script, "resume", {
        CALL_LOG: callLog, VERIFY_COUNT: verifyCount, IMAGE_ID: image, LEGACY_IMAGE: legacyImage, TEST_ROOT: testRoot,
        STAGED_TEMPLATE: "/stage/sanctuary.xml", VERSION_IMAGE: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798", MANIFEST_DIGEST: `sha256:${"f".repeat(64)}`,
      })
      expect(result.status, result.stderr).toBe(23)
      expect(fs.readFileSync(callLog, "utf8").trim().split("\n")).toEqual([
        "prepare", "verify", "prepare", "verify", "transaction:prepare", "MUTATION:disable-autostart", "transaction:rollback",
      ])
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("validates production-shaped stopped restore roots before mutation and after copying", async () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const validator = extractRunbookFunction(runbook, "validate_sanctuary_roots")
    const preflightHelper = extractRunbookFunction(runbook, "assert_restore_preflight")
    const restore = runbook.slice(runbook.indexOf("Restore:"), runbook.indexOf("Credential recovery:"))
    expect(validator).toContain("agent.json bundle-meta.json provider-readiness.json tool-profiles.json")
    expect(validator).toContain("vault-unlock")
    expect(validator).toContain("-type l")
    expect(validator).toContain("! -user 10001")
    expect(validator).toContain("! -perm 0700")
    expect(validator).toContain("-perm 0755")
    expect(validator).toContain("! -perm 0600")
    expect(validator).toContain("-perm 0644")
    expect(validator).toContain('"$VALIDATE_RUNTIME_ROOT/daemon/logs/*"')
    expect(validator).toContain('"$VALIDATE_RUNTIME_ROOT/daemon/external-events/*"')
    expect(validator).toContain('"$VALIDATE_RUNTIME_ROOT/scheduler/*"')
    expect(validator).toContain('"$VALIDATE_AGENT_ROOT/arc/flight-recorder/*"')
    expect(validator).toContain('"$VALIDATE_AGENT_ROOT/state/health/*"')
    expect(validator).toContain('"$VALIDATE_AGENT_ROOT/state/logs/*"')
    expect(validator).toContain('"$VALIDATE_AGENT_ROOT/state/habits/*"')
    expect(validator).toContain('"$VALIDATE_AGENT_ROOT/state/arc/context-loss-sentinel-watermark.json"')
    expect(validator).toContain('test ! -S "$VALIDATE_AGENT_ROOT/state/acceptance/telegram-control.sock"')
    expect(validator).toContain('VALIDATE_CONTEXT=${3:-strict}')
    expect(validator).toContain('strict|live-precutover')
    expect(validator).toContain("stat -c '%u:%g:%a'")
    expect(validator).toContain("10001:10001:600")
    expect(validator).toContain("container-credentials.json")
    expect(preflightHelper).toContain('validate_sanctuary_roots "$BACKUP_ROOT/runtime/.ouro-cli" "$BACKUP_ROOT/agent/sanctuary.ouro"')
    const preflight = restore.indexOf("if assert_restore_preflight; then")
    const stop = restore.indexOf("docker stop ouro-butler", preflight)
    const postCopy = restore.indexOf('validate_sanctuary_roots /mnt/user/appdata/ouro-butler/runtime/.ouro-cli /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro', stop)
    const start = restore.indexOf("docker start ouro-butler", postCopy)
    expect(preflight).toBeGreaterThan(-1)
    expect(stop).toBeGreaterThan(preflight)
    expect(postCopy).toBeGreaterThan(stop)
    expect(start).toBeGreaterThan(postCopy)

    const testRoot = fs.mkdtempSync("/tmp/ouro-restore-roots-validator-")
    const runtimeRoot = path.join(testRoot, "runtime", ".ouro-cli")
    const agentRoot = path.join(testRoot, "agent", "sanctuary.ouro")
    const buildValidRoots = () => {
      fs.rmSync(testRoot, { recursive: true, force: true })
      for (const directory of [
        runtimeRoot,
        path.join(runtimeRoot, "vault-unlock"),
        path.join(runtimeRoot, "bitwarden"),
        path.join(runtimeRoot, "daemon"),
        agentRoot,
        path.join(agentRoot, "arc"),
        path.join(agentRoot, "psyche"),
        path.join(agentRoot, "habits"),
        path.join(agentRoot, "state"),
        path.join(agentRoot, "state", "arc"),
        path.join(agentRoot, "state", "sessions", "owner"),
        path.join(agentRoot, "friends"),
      ]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        fs.chmodSync(directory, 0o700)
      }
      for (const directory of [
        path.join(runtimeRoot, "scheduler"),
        path.join(runtimeRoot, "daemon", "logs"),
        path.join(runtimeRoot, "daemon", "external-events", "sanctuary", "usenet"),
        path.join(agentRoot, "arc", "flight-recorder", "events"),
        path.join(agentRoot, "state", "logs", "cli"),
        path.join(agentRoot, "state", "habits"),
        path.join(agentRoot, "state", "health"),
      ]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o755 })
        fs.chmodSync(directory, 0o755)
      }
      for (const relative of ["agent.json", "bundle-meta.json", "provider-readiness.json", "tool-profiles.json", "psyche/SOUL.md", "habits/sanctuary-health.md"]) {
        const file = path.join(agentRoot, relative)
        fs.writeFileSync(file, "x", { mode: 0o600 })
        fs.chmodSync(file, 0o600)
      }
      fs.writeFileSync(path.join(runtimeRoot, "vault-unlock", "one.secret"), "secret", { mode: 0o600 })
      fs.writeFileSync(path.join(runtimeRoot, "bitwarden", "data.json"), "secret", { mode: 0o600 })
      fs.writeFileSync(path.join(agentRoot, "state", "sessions", "owner", "session.json"), "private", { mode: 0o600 })
      fs.writeFileSync(path.join(agentRoot, "friends", "owner.json"), "private", { mode: 0o600 })
      for (const file of [
        path.join(runtimeRoot, "daemon", "logs", "daemon.ndjson"),
        path.join(runtimeRoot, "pulse.json"),
        path.join(runtimeRoot, "daemon-health.json"),
        path.join(agentRoot, "arc", "flight-recorder", "events", "today.jsonl"),
        path.join(agentRoot, "state", "logs", "cli", "latest.ndjson"),
        path.join(agentRoot, "state", "habits", "sanctuary-health.json"),
        path.join(agentRoot, "state", "health", "latest.json"),
        path.join(agentRoot, "state", "arc", "context-loss-sentinel-watermark.json"),
      ]) {
        fs.writeFileSync(file, "generated", { mode: 0o644 })
        fs.chmodSync(file, 0o644)
      }
    }
    const script = String.raw`set -u
find() {
  case "$*" in *"! -user 10001"*) return 0 ;; *) command find "$@" ;; esac
}
${validator}
validate_sanctuary_roots "$RUNTIME_ROOT" "$AGENT_ROOT"`
    try {
      const run = () => runConditionalHelper(script, "validate", { RUNTIME_ROOT: runtimeRoot, AGENT_ROOT: agentRoot })
      buildValidRoots()
      expect(run().status).toBe(0)
      const autonomyReceiptName = `autr_${"a".repeat(32)}.json`
      const autonomyReceiptsRoot = path.join(agentRoot, "state", "autonomy", "receipts")
      fs.mkdirSync(autonomyReceiptsRoot, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(autonomyReceiptsRoot, autonomyReceiptName), JSON.stringify({ contentStored: false }), { mode: 0o644 })
      expect(run().status).toBe(0)
      const actualOwnerScript = `${validator}\nvalidate_sanctuary_roots "$RUNTIME_ROOT" "$AGENT_ROOT"`
      expect(runConditionalHelper(actualOwnerScript, "validate", { RUNTIME_ROOT: runtimeRoot, AGENT_ROOT: agentRoot }).status).not.toBe(0)
      for (const [mutationIndex, mutate] of [
        () => fs.writeFileSync(path.join(agentRoot, "agent.json"), ""),
        () => fs.symlinkSync("agent.json", path.join(agentRoot, "link")),
        () => fs.chmodSync(path.join(agentRoot, "psyche"), 0o755),
        () => fs.chmodSync(path.join(agentRoot, "agent.json"), 0o644),
        () => fs.chmodSync(path.join(runtimeRoot, "bitwarden", "data.json"), 0o644),
        () => fs.chmodSync(path.join(agentRoot, "state", "sessions", "owner", "session.json"), 0o644),
        () => fs.chmodSync(path.join(agentRoot, "friends", "owner.json"), 0o644),
        () => fs.chmodSync(path.join(runtimeRoot, "scheduler"), 0o777),
        () => fs.mkdirSync(path.join(runtimeRoot, "daemon", "external-events-adjacent"), { mode: 0o755 }),
        () => fs.writeFileSync(path.join(agentRoot, "state", "arc", "context-loss-sentinel-watermark-adjacent.json"), "{}", { mode: 0o644 }),
        () => {
          const adjacent = path.join(agentRoot, "state", "autonomy", "receipts-adjacent")
          fs.mkdirSync(adjacent, { recursive: true, mode: 0o700 })
          fs.writeFileSync(path.join(adjacent, autonomyReceiptName), "{}", { mode: 0o644 })
        },
        () => {
          const receipts = path.join(agentRoot, "state", "autonomy", "receipts")
          fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
          fs.writeFileSync(path.join(receipts, "autr_.json"), "{}", { mode: 0o644 })
        },
        () => {
          const receipts = path.join(agentRoot, "state", "autonomy", "receipts")
          fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
          fs.writeFileSync(path.join(receipts, `autr_${"g".repeat(32)}.json`), "{}", { mode: 0o644 })
        },
        () => {
          const receipts = path.join(agentRoot, "state", "autonomy", "receipts")
          fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
          fs.writeFileSync(path.join(receipts, `autr_${"a".repeat(31)}.json`), "{}", { mode: 0o644 })
        },
        () => {
          const nested = path.join(agentRoot, "state", "autonomy", "receipts", "nested")
          fs.mkdirSync(nested, { recursive: true, mode: 0o700 })
          fs.writeFileSync(path.join(nested, autonomyReceiptName), "{}", { mode: 0o644 })
        },
        () => {
          const receipts = path.join(agentRoot, "state", "autonomy", "receipts")
          fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
          const receipt = path.join(receipts, autonomyReceiptName)
          fs.writeFileSync(receipt, "{}", { mode: 0o664 })
          fs.chmodSync(receipt, 0o664)
        },
        () => fs.chmodSync(path.join(runtimeRoot, "pulse.json"), 0o666),
        () => fs.writeFileSync(path.join(runtimeRoot, "container-credentials.json"), "{}", { mode: 0o600 }),
        () => fs.writeFileSync(path.join(runtimeRoot, "vault-unlock", "one.secret"), ""),
        () => spawnSync("mkfifo", [path.join(agentRoot, "unexpected.fifo")]),
      ].entries()) {
        buildValidRoots()
        mutate()
        expect(run().status, `root mutation ${mutationIndex} must be rejected`).not.toBe(0)
      }
      buildValidRoots()
      const socketPath = path.join(agentRoot, "unexpected.sock")
      const server = net.createServer()
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(socketPath, resolve)
      })
      try {
        expect(fs.lstatSync(socketPath).isSocket()).toBe(true)
        expect(run().status).not.toBe(0)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      buildValidRoots()
      const control = createSanctuaryInteractiveControl({
        agentRoot,
        transport: { handleUpdate: async () => ({ handled: false, accepted: false, reason: "unused" }), listPendingDeliveries: () => [] } as never,
        authorizedUserId: "42",
        authorizedChatId: "42",
      })
      await control.start()
      try {
        expect(fs.lstatSync(control.socketPath).isSocket()).toBe(true)
        expect(fs.statSync(control.socketPath).mode & 0o777).toBe(0o600)
        expect(run().status).not.toBe(0)
        const actualSocketMetadata = fs.statSync(control.socketPath)
        const localUid = actualSocketMetadata.uid
        const localGid = actualSocketMetadata.gid
        const productionIdenticalValidator = validator
          .replace("10001:10001:600", `${localUid}:${localGid}:600`)
          .replaceAll("-user 10001", `-user ${localUid}`)
          .replaceAll("-group 10001", `-group ${localGid}`)
        const statCompatibility = process.platform === "darwin" ? String.raw`stat() { command stat -f '%u:%g:%Lp' "$3"; }
` : ""
        const liveScript = `${statCompatibility}${productionIdenticalValidator}
validate_sanctuary_roots "$RUNTIME_ROOT" "$AGENT_ROOT" live-precutover`
        const runLive = () => runConditionalHelper(liveScript, "validate", {
          RUNTIME_ROOT: runtimeRoot, AGENT_ROOT: agentRoot,
        })
        const healthyLive = runLive()
        expect(healthyLive.status, healthyLive.stderr).toBe(0)
        const metadataOverrideScript = String.raw`stat() { printf '%s\n' "$SOCKET_METADATA"; }
${productionIdenticalValidator}
validate_sanctuary_roots "$RUNTIME_ROOT" "$AGENT_ROOT" live-precutover`
        const runLiveWithMetadata = (metadata: string) => runConditionalHelper(metadataOverrideScript, "validate", {
          RUNTIME_ROOT: runtimeRoot, AGENT_ROOT: agentRoot, SOCKET_METADATA: metadata,
        })
        expect(runLiveWithMetadata(`${localUid + 1}:${localGid}:600`).status).not.toBe(0)
        expect(runLiveWithMetadata(`${localUid}:${localGid + 1}:600`).status).not.toBe(0)
        fs.chmodSync(control.socketPath, 0o755)
        expect(runLive().status).not.toBe(0)
        fs.chmodSync(control.socketPath, 0o600)
        const extraSocket = net.createServer()
        const extraSocketPath = path.join(agentRoot, "state", "acceptance", "noncanonical.sock")
        await new Promise<void>((resolve, reject) => {
          extraSocket.once("error", reject)
          extraSocket.listen(extraSocketPath, resolve)
        })
        try {
          expect(runLive().status).not.toBe(0)
        } finally {
          await new Promise<void>((resolve) => extraSocket.close(() => resolve()))
        }
        for (const context of ["restore", "stopped", "live", "live-precutover-extra"]) {
          const invalidContextScript = `${validator}\nvalidate_sanctuary_roots "$RUNTIME_ROOT" "$AGENT_ROOT" "${context}"`
          expect(runConditionalHelper(invalidContextScript, "validate", {
            RUNTIME_ROOT: runtimeRoot, AGENT_ROOT: agentRoot,
          }).status, `unknown context ${context} must be rejected`).not.toBe(0)
        }
      } finally {
        await control.stop()
      }
      buildValidRoots()
      fs.mkdirSync(path.join(agentRoot, "state", "acceptance"), { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(agentRoot, "state", "acceptance", "telegram-control.sock"), "not a socket", { mode: 0o600 })
      const liveWithoutSocket = `${validator}\nvalidate_sanctuary_roots "$RUNTIME_ROOT" "$AGENT_ROOT" live-precutover`
      expect(runConditionalHelper(liveWithoutSocket, "validate", {
        RUNTIME_ROOT: runtimeRoot, AGENT_ROOT: agentRoot,
      }).status).not.toBe(0)
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("normalizes only exact existing-root private permission candidates before live validation", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const normalize = extractRunbookFunction(runbook, "normalize_sanctuary_private_permissions")
    const readiness = extractRunbookFunction(runbook, "verify_sanctuary_telegram_readiness")

    expect(normalize).not.toContain("chmod -R")
    expect(normalize).toContain("docker run --rm --pull=never --network none --user 10001:10001")
    expect(normalize).toContain("--read-only --cap-drop ALL --security-opt no-new-privileges")
    expect(normalize).toContain('type=bind,src=$NORMALIZE_RUNTIME_ROOT,dst=/normalize/runtime')
    expect(normalize).toContain('type=bind,src=$NORMALIZE_AGENT_ROOT,dst=/normalize/agent')
    expect(normalize).toContain('validate_exact_image_id "$NORMALIZE_IMAGE_ID"')
    expect(normalize).toContain("-user 10001")
    expect(normalize).toContain("-group 10001")
    expect(normalize).toContain("-links 1")
    expect(normalize).toContain("-perm 0755")
    expect(normalize).toContain("-perm 0644")
    expect(readiness).toContain('normalize_sanctuary_private_permissions "$TELEGRAM_READINESS_RUNTIME_ROOT" "$TELEGRAM_READINESS_AGENT_ROOT" "$TELEGRAM_READINESS_IMAGE_ID"')
    expect(readiness).toContain('validate_sanctuary_roots "$TELEGRAM_READINESS_RUNTIME_ROOT" "$TELEGRAM_READINESS_AGENT_ROOT" live-precutover')
    expect(readiness).not.toContain("docker stop")
    expect(readiness).not.toContain("unlink")

    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-permission-normalization-"))
    const runtimeRoot = path.join(testRoot, "runtime")
    const agentRoot = path.join(testRoot, "agent")
    try {
      const privateDirectory = path.join(agentRoot, "state", "sessions")
      const publicDirectory = path.join(agentRoot, "state", "logs")
      const privateFile = path.join(privateDirectory, "private.json")
      const publicFile = path.join(publicDirectory, "public.ndjson")
      const wrongModeFile = path.join(privateDirectory, "wrong-mode.json")
      const hardlinkedFile = path.join(privateDirectory, "hardlinked.json")
      fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o755 })
      fs.mkdirSync(privateDirectory, { recursive: true, mode: 0o755 })
      fs.mkdirSync(publicDirectory, { recursive: true, mode: 0o755 })
      for (const directory of [runtimeRoot, agentRoot, privateDirectory, publicDirectory]) fs.chmodSync(directory, 0o755)
      fs.writeFileSync(privateFile, "private", { mode: 0o644 })
      fs.writeFileSync(publicFile, "public", { mode: 0o644 })
      fs.writeFileSync(wrongModeFile, "wrong", { mode: 0o666 })
      fs.chmodSync(wrongModeFile, 0o666)
      fs.writeFileSync(hardlinkedFile, "linked", { mode: 0o644 })
      fs.linkSync(hardlinkedFile, path.join(privateDirectory, "hardlinked-copy.json"))
      const commandMarker = "-eu -c '\n"
      const commandStart = normalize.indexOf(commandMarker)
      const commandEnd = normalize.indexOf("\n    ' || return $?", commandStart)
      expect(commandStart).toBeGreaterThan(-1)
      expect(commandEnd).toBeGreaterThan(commandStart)
      const candidateRules = normalize.slice(commandStart + commandMarker.length, commandEnd)
        .replaceAll("-user 10001 -group 10001 ", "")
        .replaceAll("/normalize/runtime", runtimeRoot)
        .replaceAll("/normalize/agent", agentRoot)
      const result = runConditionalHelper(candidateRules, "normalize")
      expect(result.status, result.stderr).toBe(0)
      expect(fs.statSync(runtimeRoot).mode & 0o777).toBe(0o700)
      expect(fs.statSync(agentRoot).mode & 0o777).toBe(0o700)
      expect(fs.statSync(privateDirectory).mode & 0o777).toBe(0o700)
      expect(fs.statSync(publicDirectory).mode & 0o777).toBe(0o755)
      expect(fs.statSync(privateFile).mode & 0o777).toBe(0o600)
      expect(fs.statSync(publicFile).mode & 0o777).toBe(0o644)
      expect(fs.statSync(wrongModeFile).mode & 0o777).toBe(0o666)
      expect(fs.statSync(hardlinkedFile).mode & 0o777).toBe(0o644)
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("keeps provider readiness scoped to legacy adoption instead of normal updates", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const adoption = runbook.slice(runbook.indexOf("Initial install/adoption"), runbook.indexOf("For this cutover"))
    const normalUpdate = runbook.slice(runbook.indexOf("For this cutover"), runbook.indexOf("Restore:"))

    expect(adoption).toContain('verify_sanctuary_provider_readiness "$IMAGE_ID"')
    expect(adoption).toContain("adoption-only")
    expect(normalUpdate).not.toContain("verify_sanctuary_provider_readiness")
  })

  it("defines bounded host adapters instead of relying on test-only retirement stubs", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const verify = extractRunbookFunction(runbook, "verify_vault_backed_unraid_key")
    const inventory = extractRunbookFunction(runbook, "inventory_unraid_key_ids")
    const revoke = extractRunbookFunction(runbook, "revoke_unraid_key_exact")
    const rejected = extractRunbookFunction(runbook, "verify_revoked_unraid_key_rejected")
    const dockerBoundary = extractRunbookFunction(runbook, "run_sanctuary_docker")
    const apiBoundary = extractRunbookFunction(runbook, "run_sanctuary_unraid_api")
    const nodeBoundary = extractRunbookFunction(runbook, "run_sanctuary_node")

    expect(dockerBoundary).toContain('/usr/bin/timeout -s KILL 20 /usr/bin/docker "$@"')
    expect(apiBoundary).toContain('/usr/bin/timeout -s KILL 20 /usr/local/sbin/unraid-api "$@"')
    expect(nodeBoundary).toContain('/usr/local/bin/node "$@"')
    expect(verify).toContain('run_sanctuary_docker image inspect --format \'{{.Id}}\' "$IMAGE_ID"')
    expect(verify).toContain("run_sanctuary_docker run")
    expect(verify).toContain("--pull=never --network host")
    expect(verify).toContain("--entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh")
    expect(verify).not.toMatch(/unraid(Read|Write)ApiKey|x-api-key/u)

    expect(inventory).toContain("type=bind,src=/boot/config/plugins/dynamix.my.servers/keys,dst=/boot/config/plugins/dynamix.my.servers/keys,readonly")
    expect(inventory).toContain("--pull=never --network none")
    expect(inventory).toContain('{"operation":"closed-inventory"}')
    expect(inventory).not.toContain("/var/run/docker.sock")

    expect(revoke).toContain("run_sanctuary_unraid_api apikey --name")
    expect(revoke).toContain("--delete --json")
    expect(revoke).toContain("preserve_sanctuary_revoked_key")
    expect(revoke).not.toMatch(/\.key\b|x-api-key/u)

    expect(rejected).toContain("revoked-probe")
    expect(rejected).toContain("3<&0")
    expect(rejected).toContain('<"$REVOKED_KEY_RECOVERY_PATH"')
    expect(rejected).toContain("http://127.0.0.1/graphql")
    expect(rejected).not.toContain("/var/run/docker.sock")
  })

  it("documents only the executable collision-safe packaged key rotation", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    expect(runbook).not.toContain("retire_legacy_unraid_key")
    expect(runbook).not.toContain("exactly the new and old RO/RW pairs")
    expect(runbook).toMatch(/The packaged `unraid-key-rotate` command is the only canonical key-rotation\s+authority/u)
    expect(runbook).toContain("Butler RO Rotation <suffix>")
    expect(runbook).toContain("requires exactly the canonical pair")
    expect(runbook).toContain("revoked-key-proof")
    expect(runbook).toContain("retained across failed retries")
    expect(runbook).toContain("provisional `GUEST`")
    expect(runbook).toContain("`API_KEY:UPDATE_ANY`")
    expect(runbook).toContain("stops the exact production container")
    expect(runbook).toContain("resumes from the durable redacted transaction checkpoint")
    expect(runbook).toContain("durable callback playback journal")
  })

  it("exits through cleanup instead of resuming after a launcher termination signal", () => {
    const launcher = fs.readFileSync("deploy/unraid/sanctuary-unit16-run.sh", "utf8")
    const start = launcher.indexOf("terminate_broker()")
    const end = launcher.indexOf('\n\ncase "$MODE"', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-unit16-signal-")), "resumed")
    const prefix = `BROKER_PID=\nPRIVATE_ROOT=\nPRODUCTION_STOPPED=no\nHOST_REBOOT_COMMIT_STATE=not_sent\nACCEPTANCE_ALIAS_MOUNTED=no\nACCEPTANCE_CANONICAL_PINNED=no\nACCEPTANCE_PIN_ROOT=\nACCEPTANCE_STATE_ROOT=\n${launcher.slice(start, end)}\n`
    const result = spawnSync("/bin/sh", ["-c", `${prefix}kill -TERM $$\nprintf resumed >"$SIGNAL_MARKER"`], {
      env: { ...process.env, SIGNAL_MARKER: marker },
    })
    expect(result.status).toBe(143)
    expect(fs.existsSync(marker)).toBe(false)
    fs.rmSync(path.dirname(marker), { recursive: true, force: true })
  })

  it("ships a complete exact-image host launcher for every Unit 16 harness command", () => {
    const launcherPath = "deploy/unraid/sanctuary-unit16-run.sh"
    expect(fs.existsSync(launcherPath)).toBe(true)
    const launcher = fs.readFileSync(launcherPath, "utf8")
    const section = (start: string, end: string): string => {
      const startIndex = launcher.indexOf(start)
      const endIndex = launcher.indexOf(end, startIndex)
      expect(startIndex, `missing launcher section start: ${start}`).toBeGreaterThanOrEqual(0)
      expect(endIndex, `missing launcher section end: ${end}`).toBeGreaterThan(startIndex)
      return launcher.slice(startIndex, endIndex)
    }
    const runtimeWritable = '--mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli"'
    const runtimeReadonly = '--mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly"'
    const materializeInventory = section('if test -n "$EXTRA_MOUNT"; then', 'elif test -n "$SNAPSHOT_PHASE"; then')
    const materializeSnapshot = section('elif test -n "$SNAPSHOT_PHASE"; then', "  else\n    /usr/bin/timeout -s KILL 30")
    const materializeDefault = section("  else\n    /usr/bin/timeout -s KILL 30", "  fi\n  /usr/local/bin/node -e '")
    const telegramBootstrap = section('if test "$COMMAND" = telegram-bootstrap; then', 'elif test "$COMMAND" = callback-inject; then')
    const callbackInject = section('elif test "$COMMAND" = callback-inject; then', 'elif test "$COMMAND" = evidence-snapshot; then')
    const evidenceSnapshot = section('elif test "$COMMAND" = evidence-snapshot; then', 'elif test "$BROKER" = yes; then')
    const brokerCommands = section('elif test "$BROKER" = yes; then', "  else\n    /usr/bin/timeout -s KILL \"$TIME_LIMIT\"")
    const defaultCommands = section("  else\n    /usr/bin/timeout -s KILL \"$TIME_LIMIT\"", "  fi\n}\n\nrun_harness")
    const contract = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary-acceptance-contract.json", "utf8")) as {
      commands: Record<string, unknown>
    }
    expect(spawnSync("/bin/sh", ["-n", launcherPath]).status).toBe(0)
    expect(launcher).toContain("TIME_LIMIT=900")
    expect(launcher).toContain("TIME_LIMIT=5700")
    expect(launcher).toContain("TIME_LIMIT=780")
    expect(launcher).toContain('--pull=never --network "$NETWORK"')
    expect(launcher).toContain("--user 10001:10001 --read-only")
    expect(launcher).toContain("--cap-drop ALL --security-opt no-new-privileges")
    expect(launcher).toContain("type=bind,src=$CONFIG_PATH,dst=/run/ouro-acceptance/config.json,readonly")
    expect(launcher).toContain("type=bind,src=$EVIDENCE_ROOT,dst=/evidence")
    expect(launcher).toContain("type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly")
    expect(launcher).toContain("type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly")
    for (const materialization of [materializeInventory, materializeSnapshot, materializeDefault]) {
      expect(materialization).toContain(runtimeReadonly)
      expect(materialization).not.toContain(runtimeWritable)
    }
    expect(launcher).toContain('telegram-bootstrap) TIME_LIMIT=900; NETWORK=host; INPUT=no; BUNDLE_MODE=readonly; BROKER=no')
    expect(launcher).toContain('if test "$COMMAND" = unraid-key-rotate; then stop_exact_production_container; fi')
    expect(launcher).toContain('if test "$BUNDLE_MODE" = rw; then BUNDLE_SUFFIX=; else BUNDLE_SUFFIX=,readonly; fi')
    expect(telegramBootstrap).toContain("--user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges")
    expect(telegramBootstrap).toContain(runtimeWritable)
    expect(telegramBootstrap).not.toContain(runtimeReadonly)
    expect(telegramBootstrap).toContain('--mount "type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro$BUNDLE_SUFFIX"')
    expect(telegramBootstrap).not.toContain("3<&0")
    expect(telegramBootstrap).not.toContain("<&3")
    expect(callbackInject).toContain("3<&0")
    expect(callbackInject).toContain("<&3")
    for (const nonBootstrap of [callbackInject, evidenceSnapshot, brokerCommands, defaultCommands]) {
      expect(nonBootstrap).toContain(runtimeReadonly)
      expect(nonBootstrap).not.toContain(runtimeWritable)
    }
    expect(launcher).toContain("/opt/ouro/deploy/unraid/sanctuary-acceptance-harness.sh")
    expect(launcher).toContain('"$COMMAND" --config /run/ouro-acceptance/config.json')
    expect(launcher.match(/3<&3/gu)).toHaveLength(1)
    expect(launcher).toContain('MODE=${1:-}')
    expect(launcher).toContain('if test "$MODE" = materialize; then')
    expect(launcher).toContain('dst=/run/ouro-acceptance/closed-inventory.json,readonly')
    expect(launcher).toContain('dst=/run/ouro-host-acceptance,readonly')
    expect(launcher).toContain('dst=/run/ouro-acceptance/image-digest,readonly')
    expect(launcher).toContain('dst=/run/ouro-acceptance/container-digest,readonly')
    expect(launcher).toContain('dst=/run/ouro-acceptance/postboot-health.json,readonly')
    expect(launcher).toContain('dst=/run/ouro-acceptance/container-inspect.json,readonly')
    expect(launcher).toContain('evidence-snapshot) TIME_LIMIT=5700; NETWORK=host; INPUT=no; BUNDLE_MODE=readonly; BROKER=yes')
    expect(launcher).toContain('\nstart_broker\nEXPECTED_CONFIG=')
    expect(launcher).toContain('dst=/run/ouro-acceptance/boot-id,readonly')
    expect(launcher).toContain('/usr/bin/docker stop --time 30 "$EXPECTED_CONTAINER_ID"')
    expect(launcher).toContain("--format '{{.State.Pid}}'")
    expect(launcher).toContain('PRODUCTION_STOPPED=yes')
    expect(launcher).toContain('dst=/run/ouro-acceptance/telegram-poller-count.json,readonly')
    expect(launcher).toContain("'{\"activePollers\":0,\"productionContainerStopped\":true}'")
    expect(launcher).toContain('restore_production_container')
    expect(launcher).toContain("trap cleanup_unit16 EXIT")
    expect(launcher).toContain("trap 'exit 129' HUP")
    expect(launcher).toContain("trap 'exit 130' INT")
    expect(launcher).toContain("trap 'exit 143' TERM")
    expect(launcher).not.toContain("trap cleanup_unit16 EXIT HUP INT TERM")
    expect(launcher).toContain('while kill -0 "$BROKER_PID" 2>/dev/null && test "$BROKER_WAIT" -lt 10')
    expect(launcher).toContain('kill -KILL "$BROKER_PID"')
    expect(launcher).toContain('/usr/bin/docker start "$EXPECTED_CONTAINER_ID"')
    expect(launcher).toContain('test "$RESTORE_RUNNING" = true && test "$RESTORE_HEALTH" = healthy')
    const startBroker = launcher.slice(launcher.indexOf("start_broker()"), launcher.indexOf("prepare_live_facts()"))
    expect(startBroker.indexOf("await_post_audit_health")).toBeLessThan(startBroker.indexOf("refresh_live_facts"))
    expect(launcher).not.toMatch(/autostart.*(?:write|install|rm|mv)/iu)
    expect(launcher.match(/exec 3<&0; exec \/opt\/ouro\/deploy\/unraid\/sanctuary-acceptance-harness\.sh/g)).toHaveLength(1)
    expect(launcher.match(/<\&3/g)?.length).toBeGreaterThanOrEqual(2)
    const prepareFacts = launcher.slice(launcher.indexOf("prepare_live_facts()"), launcher.indexOf("restore_production_container()"))
    expect(prepareFacts).not.toContain("/usr/bin/docker inspect")
    expect(prepareFacts).toContain('install -m 0444 -o 0 -g 0 "$BROKER_SNAPSHOT" "$CONTAINER_INSPECT_FACT"')
    const launcherSnapshotKeys = JSON.parse(prepareFacts.match(/const expectedKeys = (\[[^;]+\]);/u)![1]!) as string[]
    expect(launcherSnapshotKeys).toEqual([
      "autostartExact", "containerId", "health", "imageId", "liveProcessUser", "manualAuthRequired", "mountCount", "mountsDigest",
      "mountsExact", "networkMode", "processBindingDigest", "publishedPortCount", "readOnlyRoot", "recoveryMilestones", "restartCount",
      "restartPolicy", "running", "schemaVersion", "securityExact", "updaterDisabled", "user", "vaultUnlocked", "writableKeyExposure",
    ])
    expect(prepareFacts).toContain('value.liveProcessUser !== "10001:10001"')
    expect(prepareFacts).toContain('fs.writeFileSync(process.argv[6], `${value.processBindingDigest}\\n`)')
    for (const fact of ["autostartExact", "updaterDisabled", "vaultUnlocked", "manualAuthRequired"]) {
      expect(prepareFacts).toContain(fact)
    }
    expect(launcher).toContain('ACCEPTANCE_STATE_ROOT=$BUNDLE_ROOT/state/acceptance')
    expect(launcher).toContain('ACCEPTANCE_PIN_ROOT=$PRIVATE_ROOT/pinned-acceptance-state')
    expect(launcher).not.toContain('/bin/mount --bind "$ACCEPTANCE_STATE_ROOT" "$ACCEPTANCE_PIN_ROOT"')
    expect(launcher).toContain('constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW')
    expect(launcher).toContain('["--bind", "/proc/self/fd/3", target]')
    expect(launcher).toContain('stdio: ["ignore", "ignore", "ignore", source]')
    expect(launcher).toContain('stop_exact_production_container')
    expect(launcher).toContain('/bin/mount --bind "$ACCEPTANCE_PIN_ROOT" "$ACCEPTANCE_STATE_ROOT"')
    const stopExact = launcher.slice(launcher.indexOf("stop_exact_production_container()"), launcher.indexOf("quiesce_production_telegram_poller()"))
    expect(stopExact.indexOf("PRODUCTION_STOPPED=yes")).toBeLessThan(stopExact.indexOf('/usr/bin/docker stop --time 30 "$EXPECTED_CONTAINER_ID"'))
    expect(stopExact).toContain("EXPECTED_CONTAINER_ID=$(cat \"$CONTAINER_FACT\")")
    expect(stopExact).toContain('test "$EXPECTED_CONTAINER_ID" = "$TARGET_CONTAINER_ID"')
    expect(stopExact).toContain("--format '{{.Id}}'")
    expect(stopExact).toContain("--format '{{.Name}}'")
    expect(launcher.indexOf("ACCEPTANCE_CANONICAL_PINNED=yes")).toBeLessThan(launcher.indexOf('/bin/mount --bind "$ACCEPTANCE_PIN_ROOT"'))
    const evidencePin = launcher.slice(launcher.indexOf('if test "$COMMAND" = evidence-snapshot'), launcher.indexOf("run_harness()"))
    expect(evidencePin.indexOf("stop_exact_production_container")).toBeGreaterThan(-1)
    expect(evidencePin.indexOf("stop_exact_production_container")).toBeLessThan(evidencePin.indexOf("constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW"))
    expect(evidencePin.indexOf("restore_production_container")).toBeLessThan(evidencePin.indexOf("assert_acceptance_state_inode"))
    expect(launcher).toContain('assert_acceptance_state_inode')
    expect(launcher).toContain('/usr/bin/docker exec "$TARGET_CONTAINER_ID" stat -Lc')
    expect(launcher.indexOf('/bin/umount "$ACCEPTANCE_STATE_ROOT"')).toBeLessThan(launcher.indexOf('/bin/umount "$ACCEPTANCE_PIN_ROOT"'))
    expect(launcher).toContain('test "$ACCEPTANCE_ALIAS_MOUNTED" = no')
    expect(launcher).toContain('src=$ACCEPTANCE_PIN_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro/state/acceptance')
    expect(launcher.match(/src=\$ACCEPTANCE_PIN_ROOT,dst=/gu)).toHaveLength(2)
    expect(launcher).not.toContain('src=$ACCEPTANCE_STATE_ROOT,dst=/home/ouro/AgentBundles')
    expect(launcher).toContain('install -m 0600 -o 10001 -g 10001')
    expect(launcher).toContain('materialize-config "$COMMAND"')
    expect(launcher).toContain('cmp -s "$EXPECTED_CONFIG" "$CONFIG_PATH"')
    expect(launcher).toContain('operation: "commit_reboot"')
    expect(launcher).toContain('operation: "stop_reboot_owner"')
    expect(launcher).toContain('dst=/run/ouro-acceptance/process-binding-digest,readonly')
    const brokerHarnessBranch = launcher.slice(launcher.indexOf('elif test "$BROKER" = yes'), launcher.indexOf('\n  fi\n}', launcher.indexOf('elif test "$BROKER" = yes')))
    expect(brokerHarnessBranch).toContain('src=$PROCESS_BINDING_FACT,dst=/run/ouro-acceptance/process-binding-digest,readonly')
    const pinnedPreparation = launcher.slice(launcher.indexOf('if test "$COMMAND" = evidence-snapshot'), launcher.indexOf('run_harness()'))
    expect(pinnedPreparation.indexOf("restore_production_container")).toBeLessThan(pinnedPreparation.indexOf("refresh_live_facts"))
    expect(pinnedPreparation.indexOf("refresh_live_facts")).toBeLessThan(pinnedPreparation.indexOf("assert_acceptance_state_inode"))
    const finalCommit = launcher.slice(launcher.indexOf('if test "$COMMAND" = reboot-request; then'), launcher.indexOf('exit 0', launcher.indexOf('if test "$COMMAND" = reboot-request; then')))
    expect(finalCommit.indexOf('operation: "stop_reboot_owner"')).toBeLessThan(finalCommit.indexOf('sync -f "$EVIDENCE_ROOT/reboot.json"'))
    expect(finalCommit.indexOf("HOST_REBOOT_COMMIT_STATE=attempting")).toBeLessThan(finalCommit.indexOf('operation: "commit_reboot"'))
    expect(finalCommit.indexOf("HOST_REBOOT_COMMIT_STATE=confirmed")).toBeGreaterThan(finalCommit.indexOf('operation: "commit_reboot"'))
    expect(launcher).toContain('test "$HOST_REBOOT_COMMIT_STATE" = not_sent')
    expect(launcher).not.toContain('test "$HOST_REBOOT_COMMIT_STATE" = attempting')
    expect(launcher).not.toMatch(/^\s*\/sbin\/reboot\s*$/mu)
    expect(fs.readFileSync("deploy/unraid/sanctuary-unit16-host-broker.mjs", "utf8")).toContain('const REBOOT = "/sbin/reboot"')
    expect(launcher).not.toMatch(/\beval\b/u)
    expect(launcher).not.toContain("/var/run/docker.sock")
    expect(launcher).not.toContain("dst=/boot/config/plugins/dynamix.my.servers/keys")
    expect(launcher).not.toContain("src=/,dst=")
    for (const command of Object.keys(contract.commands)) expect(launcher).toContain(command)

    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    expect(runbook).toContain("UNIT16_ROOT=/mnt/user/appdata/ouro-butler/acceptance")
    expect(runbook).toContain('"$UNIT16_ROOT/configs" "$UNIT16_ROOT/evidence"')
    expect(runbook).toContain('"$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID"')
    expect(runbook).not.toContain("UNIT16_BOT_TOKEN")
    expect(runbook).toContain("Telegram bootstrap refreshes the canonical agent vault")
    const callbackHelper = extractRunbookFunction(runbook, "run_unit16_callback_inject")
    expect(callbackHelper.match(/exec 3<"\$UNIT16_CALLBACK_FILE"/gu)).toHaveLength(1)
    expect(callbackHelper).toContain("/proc/self/fd/3")
    expect(callbackHelper).toContain("regular file 0:0 600")
    expect(callbackHelper).toContain("UNIT16_CALLBACK_VALIDATED=yes")
    expect(callbackHelper).toContain('callback-inject callback-inject.json 3<&3')
    expect(callbackHelper).toContain('mktemp "$UNIT16_CALLBACK_QUARANTINE_ROOT/failed.XXXXXX"')
    expect(callbackHelper).not.toContain("failed-$$")
    expect(callbackHelper).not.toContain('mv -- "$UNIT16_CALLBACK_FILE"')
    expect(callbackHelper).toContain('if test -e "$UNIT16_CALLBACK_FILE" || test -L "$UNIT16_CALLBACK_FILE"')
    expect(callbackHelper).toContain('truncate -s 0 /proc/self/fd/3')
    expect(callbackHelper).toContain('rm -f -- "$UNIT16_CALLBACK_FILE"')
    expect(runbook).not.toContain('callback-inject callback-inject.json 3<"$CALLBACK_UPDATE_FILE"')
    for (const command of Object.keys(contract.commands)) expect(runbook).toContain(`${command}.json`)
  })

  it("waits for the exact audited production container to recover health before continuing", () => {
    const launcher = fs.readFileSync("deploy/unraid/sanctuary-unit16-run.sh", "utf8")
    const helper = extractTopLevelShellFunction(launcher, "await_post_audit_health")
      .replaceAll("/usr/bin/timeout -s KILL 20 /usr/bin/docker", "docker")
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-unit16-post-audit-health-"))
    const countFile = path.join(testRoot, "count")
    const script = String.raw`set -u
SCENARIO=$1
docker() {
  COUNT=$(command cat "$COUNT_FILE"); COUNT=$((COUNT + 1)); command printf '%s' "$COUNT" >"$COUNT_FILE"
  case "$SCENARIO:$COUNT" in
    recovery:1) HEALTH=unhealthy ;;
    timeout:*) HEALTH=unhealthy ;;
    identity-drift:*) command printf '%s\n' "drifted /ouro-butler $IMAGE_ID true false false false 321 healthy"; return 0 ;;
    pid-drift:*) command printf '%s\n' "$TARGET_CONTAINER_ID /ouro-butler $IMAGE_ID true false false false 654 healthy"; return 0 ;;
    dead:*) command printf '%s\n' "$TARGET_CONTAINER_ID /ouro-butler $IMAGE_ID true false false true 321 unhealthy"; return 0 ;;
    *) HEALTH=healthy ;;
  esac
  command printf '%s\n' "$TARGET_CONTAINER_ID /ouro-butler $IMAGE_ID true false false false 321 $HEALTH"
}
sleep() { return 0; }
${helper}
await_post_audit_health`
    const run = (scenario: string) => {
      fs.writeFileSync(countFile, "0")
      return runConditionalHelper(script, scenario, {
        COUNT_FILE: countFile,
        IMAGE_ID: `sha256:${"a".repeat(64)}`,
        PRODUCTION_CONTAINER: "ouro-butler",
        TARGET_CONTAINER_ID: "b".repeat(64),
        TARGET_CONTAINER_PID: "321",
      })
    }
    try {
      const recovered = run("recovery")
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(fs.readFileSync(countFile, "utf8")).toBe("2")
      for (const [scenario, calls] of [["timeout", "120"], ["identity-drift", "1"], ["pid-drift", "1"], ["dead", "1"]]) {
        const rejected = run(scenario)
        expect(rejected.status, `${scenario}\n${rejected.stderr}`).not.toBe(0)
        expect(fs.readFileSync(countFile, "utf8"), scenario).toBe(calls)
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("routes every post-activation acceptance launcher invocation through the final profile", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const sectionStart = runbook.indexOf("  After final activation")
    const sectionEnd = runbook.indexOf("  Each execution revalidates", sectionStart)
    expect(sectionStart).toBeGreaterThan(-1)
    expect(sectionEnd).toBeGreaterThan(sectionStart)

    const invocations = runbook.slice(sectionStart, sectionEnd).split("\n")
      .filter((line) => line.includes('"$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID"'))
    expect(invocations.length).toBeGreaterThan(2)
    expect(invocations.filter((line) => !line.includes('"$IMAGE_ID" --profile final '))).toEqual([])
  })

  it("narrows capability proof authority to read-only roots and one exact key record", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const verify = extractRunbookFunction(runbook, "verify_vault_backed_unraid_key")
    expect(verify).toContain("KEY_TARGET=$(resolve_sanctuary_unraid_key")
    expect(verify).toContain('type=bind,src="$KEY_PATH",dst=/run/ouro-acceptance/unraid-key.json,readonly')
    expect(verify).toContain("dst=/home/ouro/.ouro-cli,readonly")
    expect(verify).toContain("dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly")
    expect(verify).not.toContain("src=/boot/config/plugins/dynamix.my.servers/keys,dst=")
    expect(verify).not.toContain("/var/run/docker.sock")
  })

  it("retains a private revoked descriptor for bounded retry and removes it only after proof", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const revoke = extractRunbookFunction(runbook, "revoke_unraid_key_exact")
    const rejected = extractRunbookFunction(runbook, "verify_revoked_unraid_key_rejected")
    expect(revoke).toContain("preserve_sanctuary_revoked_key")
    expect(rejected).toContain("REVOKED_KEY_RECOVERY_PATH=$(sanctuary_revoked_key_recovery_path")
    expect(rejected).toContain("while test \"$REJECT_ATTEMPT\" -lt 3")
    expect(rejected).toContain("sleep 2")
    expect(rejected).toContain("clear_sanctuary_revoked_key")
    expect(rejected.indexOf("clear_sanctuary_revoked_key")).toBeGreaterThan(rejected.indexOf("value.rejected !== true"))
    expect(rejected).not.toContain("exec 9<&-")
  })

  it("rejects update topology before effective audit can create a container", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const update = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("Backup:"))
    const topology = update.indexOf('if assert_update_topology "$ROLLBACK_IMAGE_ID"; then')
    const sourcePreflight = update.indexOf('assert_update_source "$ROLLBACK_IMAGE_ID"')
    const productionCreate = update.indexOf("docker create --pull=never --name ouro-butler", topology)
    expect(topology).toBeGreaterThan(-1)
    expect(sourcePreflight).toBeGreaterThan(topology)
    expect(productionCreate).toBeGreaterThan(sourcePreflight)
  })

  it("admits only the two exact pinned pre-package-managed source topologies", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const helper = extractRunbookFunction(runbook, "assert_legacy_alpha742_source")
    const pin = extractRunbookFunction(runbook, "assert_sanctuary_update_source_pin")
    const dispatch = extractRunbookFunction(runbook, "assert_update_source")
    const imageId = "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d"
    expect(pin).toContain(`"ouro-butler ${imageId}"`)
    expect(helper).toContain('assert_sanctuary_update_source_pin ouro-butler "$EXPECTED_SOURCE_IMAGE_ID"')
    expect(helper).toContain('audit_effective ouro-butler "$EXPECTED_SOURCE_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" legacy-alpha742')
    expect(helper).not.toContain("docker inspect --format")
    expect(dispatch).toContain('assert_legacy_alpha742_source "$EXPECTED_SOURCE_IMAGE_ID"')
    expect(dispatch).toContain('assert_prepackage_alpha797_source "$EXPECTED_SOURCE_IMAGE_ID"')
    expect(dispatch).toContain('audit_effective ouro-butler "$EXPECTED_SOURCE_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"')
    const audit = extractRunbookFunction(runbook, "audit_effective")
    expect(audit).toContain('legacy-alpha742|prepackage-alpha797) set -- --mount-contract "$AUDIT_MOUNT_CONTRACT" ;;')
    expect(audit).toContain('"$@"')
    const auditCalls = runbook.split("\n").filter((line) => line.includes("audit_effective "))
    expect(auditCalls).toHaveLength(9)
    expect(auditCalls.filter((line) => line.includes(" canonical "))).toHaveLength(7)
    expect(auditCalls.filter((line) => line.includes(" legacy-alpha742"))).toHaveLength(1)
    expect(auditCalls.filter((line) => line.includes(" prepackage-alpha797"))).toHaveLength(1)
    expect(auditCalls.every((line) => line.includes(" canonical ") ? line.includes("https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png") || line.includes('"$TEMPLATE_ICON"') : true)).toBe(true)
  })

  it("locks deployment and credential rotation to the canonical bot and exact key IDs", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    expect(runbook).toContain("Mendelow Cloud Butler")
    expect(runbook).toContain("MendelowCloudButlerBot")
    expect(runbook).toContain("8541786263")
    expect(runbook).not.toContain("Sanctuary Butler")
    expect(runbook).toMatch(/exact immutable\s+ID/u)
    expect(runbook).toContain("proves each old credential receives a 401 or 403")
    expect(runbook).toContain("requires exactly the canonical pair")
    expect(runbook).toContain("never raw key values")
  })

  it("rolls final production activation back under set -eu before propagating failure", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const update = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("Backup:"))
    const production = update.slice(update.indexOf("Create and activate production from the same exact image ID"))
    const activation = production.slice(production.indexOf('if test "$(docker buildx imagetools inspect "$VERSION_IMAGE"'))

    expect(activation).toContain("&& docker create --pull=never --name ouro-butler --network host --restart unless-stopped --user 10001:10001 \\")
    expect(activation).toContain('&& audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" canonical "$VERSION_IMAGE" "$TEMPLATE_ICON" \\')
    expect(activation).toContain("&& docker start ouro-butler \\")
    expect(activation).toContain("&& wait_butler_ready ouro-butler \\")
    expect(activation).toContain("&& enable_butler_autostart \\")
    expect(activation).toContain('&& /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" mark-committing >/dev/null; then')
    expect(activation).toContain("PRODUCTION_ACTIVATION_STATUS=$?")
    const inspectPartial = activation.indexOf("if docker container inspect ouro-butler >/dev/null 2>&1; then")
    const failedStop = activation.indexOf("docker stop ouro-butler >/dev/null 2>&1 || true", inspectPartial)
    const failedRemove = activation.indexOf("docker rm --force ouro-butler", failedStop)
    const verifyAbsent = activation.indexOf("! docker container inspect ouro-butler >/dev/null 2>&1", failedRemove)
    expect(activation).not.toMatch(/(?:^|\n)\s+ROLLBACK_IMAGE_ID=\$\(docker inspect --format '\{\{\.Image\}\}' ouro-butler-rollback\)/u)
    const currentImage = activation.indexOf("CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback)", verifyAbsent)
    const exactImage = activation.indexOf('test "$CURRENT_ROLLBACK_IMAGE_ID" = "$ROLLBACK_IMAGE_ID"', currentImage)
    const rename = activation.indexOf("docker rename ouro-butler-rollback ouro-butler", exactImage)
    const audit = activation.indexOf('assert_update_source "$ROLLBACK_IMAGE_ID"', rename)
    const restart = activation.indexOf("start_only_butler_for_recovery", audit)
    const ready = activation.indexOf("wait_butler_ready ouro-butler", restart)
    const autostart = activation.indexOf("enable_butler_autostart", ready)
    const finalizeRollback = activation.indexOf('migrate_sanctuary_package_managed_bundle "$IMAGE_ID" finalize-rollback', autostart)
    const propagate = activation.indexOf('(exit "$PRODUCTION_ACTIVATION_STATUS")', finalizeRollback)
    expect(inspectPartial).toBeGreaterThan(-1)
    expect(failedStop).toBeGreaterThan(inspectPartial)
    expect(failedRemove).toBeGreaterThan(failedStop)
    expect(verifyAbsent).toBeGreaterThan(failedRemove)
    expect(currentImage).toBeGreaterThan(verifyAbsent)
    expect(exactImage).toBeGreaterThan(currentImage)
    expect(rename).toBeGreaterThan(exactImage)
    expect(audit).toBeGreaterThan(rename)
    expect(restart).toBeGreaterThan(audit)
    expect(ready).toBeGreaterThan(restart)
    expect(autostart).toBeGreaterThan(ready)
    expect(finalizeRollback).toBeGreaterThan(autostart)
    expect(propagate).toBeGreaterThan(finalizeRollback)
  })

  it("keeps routine update readiness side-effect-free until the single production activation", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const update = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("Backup:"))
    const routine = update.slice(update.indexOf("For normal updates"))
    const disable = routine.indexOf("disable_butler_autostart")

    expect(routine).toContain("verify_sanctuary_telegram_readiness")
    expect(routine.indexOf('verify_sanctuary_sab_readiness "$IMAGE_ID"')).toBeLessThan(disable)
    expect(routine.indexOf('verify_sanctuary_telegram_readiness "$IMAGE_ID"')).toBeLessThan(disable)
    expect(update.indexOf("audit the original version-tagged template")).toBeLessThan(update.indexOf("For normal updates"))
    expect(routine).not.toContain('verify_sanctuary_provider_readiness "$IMAGE_ID"')
    expect(routine).not.toContain("docker create --name ouro-butler-staging")
    expect(routine).not.toContain("docker start ouro-butler-staging")
    expect(routine).not.toContain("wait_butler_ready ouro-butler-staging")
    expect(routine.match(/docker create --pull=never --name ouro-butler /gu)).toHaveLength(1)
    expect(routine).toContain("wait_butler_ready ouro-butler")
    expect(routine).toContain("PRODUCTION_ACTIVATION_STATUS=$?")
    expect(routine).toContain("docker rename ouro-butler-rollback ouro-butler")
  })

  it("contains production stop and rollback rename preparation under set -eu", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const update = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("Backup:"))

    const disableGuard = update.indexOf("if disable_butler_autostart; then")
    const disableStatus = update.indexOf("AUTOSTART_DISABLE_STATUS=$?", disableGuard)
    const disablePropagate = update.indexOf('(exit "$AUTOSTART_DISABLE_STATUS")', disableStatus)
    const stop = update.indexOf("if docker stop ouro-butler \\", disableGuard)
    const removeStale = update.indexOf('&& remove_stopped_rollback_if_present "$ROLLBACK_IMAGE_ID" \\', stop)
    const rename = update.indexOf("&& docker rename ouro-butler ouro-butler-rollback \\", removeStale)
    const stopped = update.indexOf("&& test \"$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)\" = false \\", rename)
    const migration = update.indexOf('&& migrate_sanctuary_package_managed_bundle "$IMAGE_ID" migrate "$ROLLBACK_IMAGE_ID"; then', stopped)
    const status = update.indexOf("PRODUCTION_PREPARATION_STATUS=$?", migration)
    const recoverProduction = update.indexOf("if docker container inspect ouro-butler >/dev/null 2>&1; then", status)
    const recoverRollback = update.indexOf("elif docker container inspect ouro-butler-rollback >/dev/null 2>&1; then", recoverProduction)
    const propagate = update.indexOf('(exit "$PRODUCTION_PREPARATION_STATUS")', recoverRollback)
    const namedProductionRecovery = update.slice(recoverProduction, recoverRollback)
    const renamedRollbackRecovery = update.slice(recoverRollback, propagate)

    expect(disableGuard).toBeGreaterThan(-1)
    expect(disableStatus).toBeGreaterThan(disableGuard)
    expect(disablePropagate).toBeGreaterThan(disableStatus)
    expect(stop).toBeGreaterThan(disableGuard)
    expect(removeStale).toBeGreaterThan(stop)
    expect(rename).toBeGreaterThan(removeStale)
    expect(stopped).toBeGreaterThan(rename)
    expect(migration).toBeGreaterThan(stopped)
    expect(status).toBeGreaterThan(migration)
    expect(recoverProduction).toBeGreaterThan(status)
    expect(recoverRollback).toBeGreaterThan(recoverProduction)
    expect(propagate).toBeGreaterThan(recoverRollback)
    for (const recovery of [namedProductionRecovery, renamedRollbackRecovery]) {
      const audit = recovery.indexOf('assert_update_source "$ROLLBACK_IMAGE_ID"')
      const start = recovery.indexOf("start_only_butler_for_recovery", audit)
      const ready = recovery.indexOf("wait_butler_ready ouro-butler", start)
      const autostart = recovery.indexOf("enable_butler_autostart", ready)
      const finalizeRollback = recovery.indexOf('finalize_sanctuary_bundle_rollback_if_retained "$IMAGE_ID"', autostart)
      expect(audit).toBeGreaterThan(-1)
      expect(start).toBeGreaterThan(audit)
      expect(ready).toBeGreaterThan(start)
      expect(autostart).toBeGreaterThan(ready)
      expect(finalizeRollback).toBeGreaterThan(autostart)
      expect(recovery).not.toContain('migrate_sanctuary_package_managed_bundle "$IMAGE_ID" commit')
    }
  })

  it("durably rolls managed bundle state back on every update failure and reconciles a killed updater before preflight", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const update = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("Backup:"))
    const helper = extractRunbookFunction(runbook, "migrate_sanctuary_package_managed_bundle")
    const recovery = extractRunbookFunction(runbook, "recover_pending_sanctuary_bundle_migration")
    const transactionStatus = extractRunbookFunction(runbook, "read_sanctuary_bundle_transaction_status")
    const optionalRollback = extractRunbookFunction(runbook, "rollback_sanctuary_bundle_if_pending")

    expect(helper).toContain('MIGRATE_OPERATION=$2')
    expect(helper).toContain('migrate|rollback|finalize-rollback|commit|status|inspect')
    expect(helper).toContain('--operation "$MIGRATE_OPERATION"')
    expect(transactionStatus).toContain('READ_BUNDLE_ROLLBACK_RECORD=$READ_BUNDLE_AGENT_ROOT/.sanctuary-package-managed-rollback.json')
    expect(transactionStatus).toContain('test -f "$READ_BUNDLE_CANDIDATE"')
    expect(transactionStatus).toContain("printf 'null\\n'")
    expect(recovery).toContain('RECOVERY_STATUS=$(read_sanctuary_bundle_transaction_status "$RECOVERY_IMAGE_ID")')
    expect(recovery).toContain('migrate_sanctuary_package_managed_bundle "$RECOVERY_IMAGE_ID" rollback')
    expect(recovery.indexOf('docker rm --force ouro-butler')).toBeLessThan(recovery.indexOf('docker rename ouro-butler-rollback ouro-butler'))
    expect(recovery.indexOf('migrate_sanctuary_package_managed_bundle "$RECOVERY_IMAGE_ID" rollback')).toBeLessThan(recovery.indexOf('docker rename ouro-butler-rollback ouro-butler'))
    expect(optionalRollback).toContain('if test -e "$OPTIONAL_ROLLBACK_RECORD"; then')
    expect(optionalRollback).toContain('migrate_sanctuary_package_managed_bundle "$OPTIONAL_ROLLBACK_IMAGE_ID" rollback')
    expect(optionalRollback).toContain('test ! -e "$OPTIONAL_COMMITTING_RECORD" || return 1')

    const recoverBeforePreflight = update.indexOf('recover_pending_sanctuary_bundle_migration "$IMAGE_ID"')
    const captureProduction = update.indexOf("ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)")
    expect(recoverBeforePreflight).toBeGreaterThan(-1)
    expect(recoverBeforePreflight).toBeLessThan(captureProduction)

    const migration = update.indexOf('migrate_sanctuary_package_managed_bundle "$IMAGE_ID" migrate "$ROLLBACK_IMAGE_ID"')
    const preparationFailure = update.indexOf("PRODUCTION_PREPARATION_STATUS=$?", migration)
    const productionFailure = update.indexOf("PRODUCTION_ACTIVATION_STATUS=$?", preparationFailure)
    const commit = update.indexOf('migrate_sanctuary_package_managed_bundle "$IMAGE_ID" commit', productionFailure)
    const renamedRollbackRecovery = update.indexOf("elif docker container inspect ouro-butler-rollback", preparationFailure)
    expect(migration).toBeGreaterThan(-1)
    expect(update.indexOf('rollback_sanctuary_bundle_if_pending "$IMAGE_ID"', migration)).toBeLessThan(update.indexOf("docker start ouro-butler", migration))
    expect(update.indexOf('rollback_sanctuary_bundle_if_pending "$IMAGE_ID"', renamedRollbackRecovery)).toBeLessThan(update.indexOf("docker rename ouro-butler-rollback ouro-butler", renamedRollbackRecovery))
    expect(update.indexOf('migrate_sanctuary_package_managed_bundle "$IMAGE_ID" rollback', productionFailure)).toBeLessThan(update.indexOf("docker rename ouro-butler-rollback ouro-butler", productionFailure))
    const productionCreate = update.lastIndexOf('if test "$(docker buildx imagetools inspect "$VERSION_IMAGE"', productionFailure)
    expect(commit).toBeGreaterThan(update.indexOf("wait_butler_ready ouro-butler", productionCreate))
    expect(commit).toBeGreaterThan(update.indexOf("enable_butler_autostart", productionCreate))
    expect(recovery).toContain('test "$(docker inspect --format \'{{.State.Running}}\' ouro-butler-rollback)" = false')
    expect(recovery).toContain('test "$RECOVERY_STAGING_IMAGE_ID" = "$RECOVERY_TARGET_IMAGE_ID"')
    expect(recovery).toContain('test "$RECOVERY_PRODUCTION_IMAGE_ID" = "$RECOVERY_TARGET_IMAGE_ID"')
    expect(recovery.indexOf('test "$RECOVERY_STAGING_IMAGE_ID" = "$RECOVERY_TARGET_IMAGE_ID"')).toBeLessThan(recovery.indexOf("docker rm --force ouro-butler-staging"))
    expect(recovery.indexOf('test "$RECOVERY_PRODUCTION_IMAGE_ID" = "$RECOVERY_TARGET_IMAGE_ID"', recovery.indexOf('if docker container inspect ouro-butler >/dev/null'))).toBeLessThan(recovery.indexOf("docker rm --force ouro-butler", recovery.indexOf('if docker container inspect ouro-butler >/dev/null')))
    expect(recovery).toContain('test "$RECOVERY_PRODUCTION_IMAGE_ID" = "$RECOVERY_TARGET_IMAGE_ID" || return 1')
    expect(recovery).not.toContain('elif test "$RECOVERY_PRODUCTION_IMAGE_ID" = "$RECOVERY_ROLLBACK_IMAGE_ID"; then')
    expect(recovery).toContain('assert_update_source "$RECOVERY_PRODUCTION_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"')
  })

  it("reports an absent bundle journal only when no journal staging residue exists", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const helper = extractRunbookFunction(runbook, "read_sanctuary_bundle_transaction_status")
      .replaceAll("/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro", "$BUNDLE_ROOT")
      .replaceAll("/usr/local/bin/node", "node")
      .replace("READ_BUNDLE_EXPECTED_UID=10001", `READ_BUNDLE_EXPECTED_UID=${process.getuid?.() ?? 10001}`)
      .replace("READ_BUNDLE_EXPECTED_GID=10001", `READ_BUNDLE_EXPECTED_GID=${process.getgid?.() ?? 10001}`)
    const templateRecovery = extractRunbookFunction(runbook, "recover_dockerman_template_transaction")
    expect(templateRecovery).toContain('TEMPLATE_RECOVERY_BUNDLE_STATUS=$(read_sanctuary_bundle_transaction_status "$IMAGE_ID")')
    expect(helper).toContain("stat.isDirectory()")
    expect(helper).toContain("stat.isSymbolicLink()")
    expect(helper).toContain("(rootStat.mode & 0o777) !== 0o700")
    expect(helper).toContain("fs.realpathSync(current) !== current")
    const imageId = `sha256:${"a".repeat(64)}`
    const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-bundle-journal-status-")))
    try {
      const bundleRoot = path.join(testRoot, "sanctuary.ouro")
      const callLog = path.join(testRoot, "calls.log")
      fs.writeFileSync(callLog, "")
      const script = String.raw`set -u
validate_exact_image_id() { return 0; }
migrate_sanctuary_package_managed_bundle() { command printf '%s\n' "$2" >>"$CALL_LOG"; command printf '{"state":"rollback"}\n'; }
${helper}
read_sanctuary_bundle_transaction_status "$IMAGE_ID"`
      const missing = runConditionalHelper(script, "missing", { BUNDLE_ROOT: bundleRoot, CALL_LOG: callLog, IMAGE_ID: imageId })
      expect(missing.status, missing.stderr).toBe(0)
      expect(missing.stdout).toBe("null\n")
      expect(fs.readFileSync(callLog, "utf8")).toBe("")
      const missingParents = runConditionalHelper(script, "missing-parents", { BUNDLE_ROOT: path.join(testRoot, "missing-agent", "sanctuary.ouro"), CALL_LOG: callLog, IMAGE_ID: imageId })
      expect(missingParents.status, missingParents.stderr).toBe(0)
      expect(missingParents.stdout).toBe("null\n")
      expect(fs.readFileSync(callLog, "utf8")).toBe("")

      fs.mkdirSync(bundleRoot, { mode: 0o700 })
      const absent = runConditionalHelper(script, "absent", { BUNDLE_ROOT: bundleRoot, CALL_LOG: callLog, IMAGE_ID: imageId })
      expect(absent.status, absent.stderr).toBe(0)
      expect(absent.stdout).toBe("null\n")
      expect(fs.readFileSync(callLog, "utf8")).toBe("")

      const invalidRoots = [path.join(testRoot, "regular-file"), path.join(testRoot, "symlink"), path.join(testRoot, "wrong-mode")]
      fs.writeFileSync(invalidRoots[0], "not a bundle\n")
      fs.symlinkSync(bundleRoot, invalidRoots[1], "dir")
      fs.mkdirSync(invalidRoots[2], { mode: 0o755 })
      for (const invalidRoot of invalidRoots) {
        const invalid = runConditionalHelper(script, "invalid-root", { BUNDLE_ROOT: invalidRoot, CALL_LOG: callLog, IMAGE_ID: imageId })
        expect(invalid.status, invalidRoot).not.toBe(0)
        expect(invalid.stdout, invalidRoot).toBe("")
        expect(fs.readFileSync(callLog, "utf8"), invalidRoot).toBe("")
      }
      const wrongOwnerScript = script.replace(`READ_BUNDLE_EXPECTED_UID=${process.getuid?.() ?? 10001}`, `READ_BUNDLE_EXPECTED_UID=${(process.getuid?.() ?? 10001) + 1}`)
      const wrongOwner = runConditionalHelper(wrongOwnerScript, "wrong-owner", { BUNDLE_ROOT: bundleRoot, CALL_LOG: callLog, IMAGE_ID: imageId })
      expect(wrongOwner.status).not.toBe(0)
      expect(wrongOwner.stdout).toBe("")
      expect(fs.readFileSync(callLog, "utf8")).toBe("")
      const linkedParent = path.join(testRoot, "linked-parent")
      const canonicalParent = path.join(testRoot, "canonical-parent")
      fs.mkdirSync(canonicalParent, { mode: 0o700 })
      const nestedRoot = path.join(canonicalParent, "sanctuary.ouro")
      fs.mkdirSync(nestedRoot, { mode: 0o700 })
      fs.symlinkSync(canonicalParent, linkedParent, "dir")
      const noncanonical = runConditionalHelper(script, "noncanonical", { BUNDLE_ROOT: path.join(linkedParent, "sanctuary.ouro"), CALL_LOG: callLog, IMAGE_ID: imageId })
      expect(noncanonical.status).not.toBe(0)
      expect(noncanonical.stdout).toBe("")
      expect(fs.readFileSync(callLog, "utf8")).toBe("")
      const noncanonicalMissing = runConditionalHelper(script, "noncanonical-missing", { BUNDLE_ROOT: path.join(linkedParent, "absent.ouro"), CALL_LOG: callLog, IMAGE_ID: imageId })
      expect(noncanonicalMissing.status).not.toBe(0)
      expect(noncanonicalMissing.stdout).toBe("")
      expect(fs.readFileSync(callLog, "utf8")).toBe("")

      for (const residueName of [
        ".sanctuary-package-managed-rollback.json.package-migration.interrupted",
        ".sanctuary-package-managed-rollback.json.committing.package-migration.interrupted",
      ]) {
        const residue = path.join(bundleRoot, residueName)
        fs.mkdirSync(residue)
        const interrupted = runConditionalHelper(script, "interrupted", { BUNDLE_ROOT: bundleRoot, CALL_LOG: callLog, IMAGE_ID: imageId })
        expect(interrupted.status, residueName).not.toBe(0)
        expect(interrupted.stdout, residueName).toBe("")
        expect(fs.readFileSync(callLog, "utf8"), residueName).toBe("")
        fs.rmdirSync(residue)
      }

      fs.writeFileSync(path.join(bundleRoot, ".sanctuary-package-managed-rollback.json"), "{}\n", { mode: 0o600 })
      const present = runConditionalHelper(script, "present", { BUNDLE_ROOT: bundleRoot, CALL_LOG: callLog, IMAGE_ID: imageId })
      expect(present.status, present.stderr).toBe(0)
      expect(present.stdout).toBe('{"state":"rollback"}\n')
      expect(fs.readFileSync(callLog, "utf8")).toBe("status\n")

      fs.writeFileSync(path.join(bundleRoot, ".sanctuary-package-managed-rollback.json.committing"), "{}\n", { mode: 0o600 })
      const dual = runConditionalHelper(script, "dual", { BUNDLE_ROOT: bundleRoot, CALL_LOG: callLog, IMAGE_ID: imageId })
      expect(dual.status).not.toBe(0)
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("rejects mismatched bundle and DockerMan recovery identities before mutation", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const recovery = extractRunbookFunction(runbook, "recover_dockerman_template_transaction").replaceAll("/usr/local/bin/node", "node")
    const identityRead = recovery.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" recovery-identity')
    const bundleRead = recovery.indexOf('read_sanctuary_bundle_transaction_status "$IMAGE_ID"')
    const mutableRecovery = recovery.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" recover-status', bundleRead)
    expect(identityRead).toBeGreaterThan(-1)
    expect(bundleRead).toBeGreaterThan(identityRead)
    expect(mutableRecovery).toBeGreaterThan(bundleRead)
    const oldImage = `sha256:${"a".repeat(64)}`
    const targetImage = `sha256:${"b".repeat(64)}`
    const otherImage = `sha256:${"c".repeat(64)}`
    const versionImage = "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798"
    const manifestDigest = `sha256:${"d".repeat(64)}`
    const script = String.raw`set -u
node() {
  if test "$1" = "$STAGED_DOCKERMAN_TRANSACTION" && test "$2" = recovery-identity; then command printf '%s\n' "$TEMPLATE_STATUS"
  elif test "$1" = "$STAGED_DOCKERMAN_TRANSACTION" && test "$2" = recover-status; then command printf 'recover-status\n' >>"$CALL_LOG"; command printf '%s\n' "$TEMPLATE_STATUS"
  else command "$NODE_BINARY" "$@"
  fi
}
validate_exact_image_id() { return 0; }
read_sanctuary_bundle_transaction_status() { command printf '%s\n' "$BUNDLE_STATUS"; }
recover_pending_sanctuary_bundle_migration() { command printf 'recover-bundle\n' >>"$CALL_LOG"; return 91; }
docker() { command printf 'docker:%s\n' "$*" >>"$CALL_LOG"; return 92; }
${recovery}
recover_dockerman_template_transaction`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-cross-journal-recovery-"))
    try {
      const templateStatus = JSON.stringify({ state: "rollback", rollbackImageId: oldImage, targetImageId: targetImage, canonicalVersionTag: versionImage, reviewedManifestDigest: manifestDigest })
      for (const [name, bundleStatus] of [
        ["rollback-image", JSON.stringify({ state: "rollback", rollbackImageId: otherImage, targetImageId: targetImage })],
        ["target-image", JSON.stringify({ state: "rollback", rollbackImageId: oldImage, targetImageId: otherImage })],
      ] as const) {
        const callLog = path.join(testRoot, `${name}.log`)
        fs.writeFileSync(callLog, "")
        const result = runConditionalHelper(script, "unused", { AUDIT_RUNNER_IMAGE_ID: targetImage, BUNDLE_STATUS: bundleStatus, CALL_LOG: callLog, EVENT_ASSET_STAGE: testRoot, IMAGE_ID: targetImage, MANIFEST_DIGEST: manifestDigest, NODE_BINARY: process.execPath, STAGED_DOCKERMAN_TRANSACTION: "/tmp/transaction.mjs", TEMPLATE_STATUS: templateStatus, VERSION_IMAGE: versionImage })
        expect(result.status, `${name}: ${result.stderr}`).not.toBe(0)
        expect(fs.readFileSync(callLog, "utf8"), name).toBe("")
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("finalizes an old-production rollback only when its retained record still exists", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const helper = extractRunbookFunction(runbook, "finalize_sanctuary_bundle_rollback_if_retained").replaceAll("/usr/local/bin/node", process.execPath)
    const imageId = `sha256:${"a".repeat(64)}`
    const script = String.raw`set -u
read_sanctuary_bundle_transaction_status() { command printf '%s\n' "$BUNDLE_STATUS"; }
migrate_sanctuary_package_managed_bundle() { command printf '%s\n' "$2" >>"$CALL_LOG"; }
${helper}
finalize_sanctuary_bundle_rollback_if_retained "$IMAGE_ID"`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-finalize-retained-rollback-"))
    try {
      for (const [name, bundleStatus, expectedStatus, expectedCalls] of [
        ["absent", "null", 0, ""],
        ["rollback", JSON.stringify({ state: "rollback" }), 0, "finalize-rollback\n"],
        ["committing", JSON.stringify({ state: "committing" }), 1, ""],
        ["invalid", JSON.stringify({ state: "invented" }), 1, ""],
      ] as const) {
        const callLog = path.join(testRoot, `${name}.log`)
        fs.writeFileSync(callLog, "")
        const result = runConditionalHelper(script, name, { BUNDLE_STATUS: bundleStatus, CALL_LOG: callLog, IMAGE_ID: imageId })
        expect(result.status === 0 ? 0 : 1, name).toBe(expectedStatus)
        expect(fs.readFileSync(callLog, "utf8"), name).toBe(expectedCalls)
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }

    const update = runbook.slice(runbook.indexOf("PRODUCTION_PREPARATION_STATUS=$?"), runbook.indexOf("Preparation failure therefore"))
    expect(update.match(/finalize_sanctuary_bundle_rollback_if_retained "\$IMAGE_ID"/gu)).toHaveLength(2)
    expect(update).not.toContain('migrate_sanctuary_package_managed_bundle "$IMAGE_ID" finalize-rollback')
  })

  it("never commits a target bundle after production has reverted to the rollback image", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const recovery = extractRunbookFunction(runbook, "recover_pending_sanctuary_bundle_migration").replaceAll("/usr/local/bin/node", process.execPath)
    const oldImage = `sha256:${"a".repeat(64)}`
    const targetImage = `sha256:${"b".repeat(64)}`
    const script = String.raw`set -u
read_sanctuary_bundle_transaction_status() { command printf '%s\n' "$RECOVERY_STATUS"; }
validate_exact_image_id() { return 0; }
disable_butler_autostart() { command printf 'disable\n' >>"$CALL_LOG"; }
assert_only_running_butler() { return 0; }
assert_update_source() { return 0; }
wait_butler_ready() { return 0; }
enable_butler_autostart() { command printf 'enable\n' >>"$CALL_LOG"; }
migrate_sanctuary_package_managed_bundle() { command printf '%s\n' "$2" >>"$CALL_LOG"; }
docker() {
  case "$*" in
    "container inspect ouro-butler-staging") return 1 ;;
    "inspect --format {{.Image}} ouro-butler") if test "$TOPOLOGY" = target; then command printf '%s\n' "$TARGET_IMAGE"; else command printf '%s\n' "$OLD_IMAGE"; fi ;;
    "inspect --format {{.State.Running}} ouro-butler") command printf 'true\n' ;;
    "container inspect ouro-butler-rollback") test "$TOPOLOGY" = target ;;
    "inspect --format {{.Image}} ouro-butler-rollback") command printf '%s\n' "$OLD_IMAGE" ;;
    "inspect --format {{.State.Running}} ouro-butler-rollback") command printf 'false\n' ;;
    *) return 23 ;;
  esac
}
${recovery}
recover_pending_sanctuary_bundle_migration "$TARGET_IMAGE"`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-committing-recovery-"))
    try {
      for (const topology of ["target", "rollback"]) {
        const callLog = path.join(testRoot, `${topology}.log`)
        fs.writeFileSync(callLog, "")
        const result = runConditionalHelper(script, "unused", {
          AUDIT_RUNNER_IMAGE_ID: targetImage,
          CALL_LOG: callLog,
          OLD_IMAGE: oldImage,
          TARGET_IMAGE: targetImage,
          TOPOLOGY: topology,
          RECOVERY_STATUS: JSON.stringify({ state: "committing", rollbackImageId: oldImage, targetImageId: targetImage }),
        })
        const calls = fs.readFileSync(callLog, "utf8")
        if (topology === "target") {
          expect(result.status, result.stderr).toBe(0)
          expect(calls).toContain("commit")
        } else {
          expect(result.status, result.stderr).not.toBe(0)
          expect(calls).not.toContain("commit")
          expect(calls).not.toContain("enable")
        }
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("requires exactly one stopped known-good artifact before deleting the outer transaction journal", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const helper = extractRunbookFunction(runbook, "verify_known_good_rollback_artifact")
    const imageId = `sha256:${"a".repeat(64)}`
    const script = String.raw`set -u
SCENARIO=$1
validate_exact_image_id() { return 0; }
docker() {
  case "$*" in
    "container inspect ouro-butler-rollback") test "$SCENARIO" != missing ;;
    "container inspect ouro-butler-legacy-evidence") test "$SCENARIO" = duplicate ;;
    "inspect --format {{.Image}} "*) command printf '%s\n' "$IMAGE_ID" ;;
    "inspect --format {{.State.Running}} "*) if test "$SCENARIO" = running; then command printf 'true\n'; else command printf 'false\n'; fi ;;
    *) return 23 ;;
  esac
}
${helper}
verify_known_good_rollback_artifact "$IMAGE_ID"`
    expect(runConditionalHelper(script, "stopped", { IMAGE_ID: imageId }).status).toBe(0)
    for (const scenario of ["missing", "running", "duplicate"]) expect(runConditionalHelper(script, scenario, { IMAGE_ID: imageId }).status, scenario).not.toBe(0)

    const templateRecovery = extractRunbookFunction(runbook, "recover_dockerman_template_transaction")
    const adoption = extractRunbookFunction(runbook, "install_from_legacy_staging")
    const update = runbook.slice(runbook.indexOf("For normal updates"), runbook.indexOf("Backup:"))
    expect(templateRecovery.indexOf('verify_known_good_rollback_artifact "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID"')).toBeLessThan(templateRecovery.indexOf('commit --proof "$TEMPLATE_RECOVERY_FINAL_PROOF"'))
    expect(adoption.indexOf('verify_known_good_rollback_artifact "$LEGACY_STAGING_IMAGE_ID"')).toBeLessThan(adoption.indexOf('commit --proof "$ADOPTION_FINAL_PROOF"'))
    expect(update.indexOf('verify_known_good_rollback_artifact "$ROLLBACK_IMAGE_ID"')).toBeLessThan(update.indexOf('commit --proof "$FINAL_PROOF_PATH"'))
  })

  it("binds every install and crash recovery to one unchanged Jellyfin checkpoint", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const finalProof = extractRunbookFunction(runbook, "write_dockerman_final_proof")
    const recovery = extractRunbookFunction(runbook, "recover_dockerman_template_transaction")
    const adoption = extractRunbookFunction(runbook, "install_from_legacy_staging")
    const update = runbook.slice(runbook.indexOf("For normal updates"), runbook.indexOf("Backup:"))

    expect(finalProof).toContain('"$STAGED_DOCKERMAN_TRANSACTION" jellyfin-status >"$FINAL_JELLYFIN_PATH"')
    expect(finalProof).toContain('const jellyfin = JSON.parse(fs.readFileSync(jellyfinPath, "utf8"));')
    expect(finalProof).toContain("const proof = { container:")
    expect(finalProof).toContain(", jellyfin };")
    expect(recovery.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" recovery-identity')).toBeLessThan(recovery.indexOf('read_sanctuary_bundle_transaction_status "$IMAGE_ID"'))
    const checkedRecovery = recovery.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" recover-status', recovery.indexOf('read_sanctuary_bundle_transaction_status "$IMAGE_ID"'))
    expect(checkedRecovery).toBeGreaterThan(recovery.indexOf('read_sanctuary_bundle_transaction_status "$IMAGE_ID"'))
    expect(checkedRecovery).toBeLessThan(recovery.indexOf("recover_pending_sanctuary_bundle_migration"))
    const adoptionFailure = adoption.indexOf("ADOPTION_STATUS=$?")
    const adoptionGate = adoption.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" verify-jellyfin', adoptionFailure)
    expect(adoptionGate).toBeGreaterThan(adoptionFailure)
    expect(adoptionGate).toBeLessThan(adoption.indexOf("docker stop ouro-butler", adoptionFailure))
    const preparationFailure = update.indexOf("PRODUCTION_PREPARATION_STATUS=$?")
    const preparationGate = update.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" verify-jellyfin', preparationFailure)
    expect(preparationGate).toBeGreaterThan(preparationFailure)
    expect(preparationGate).toBeLessThan(update.indexOf("docker stop ouro-butler-rollback", preparationFailure))
    const activationFailure = update.indexOf("PRODUCTION_ACTIVATION_STATUS=$?")
    const activationGate = update.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" verify-jellyfin', activationFailure)
    expect(activationGate).toBeGreaterThan(activationFailure)
    expect(activationGate).toBeLessThan(update.indexOf("docker stop ouro-butler", activationFailure))
    expect(runbook).toContain("container ID, image ID, state, and restart count")
  })

  it("recovers only exact normal-update and legacy-adoption template topologies", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const recovery = extractRunbookFunction(runbook, "recover_dockerman_template_transaction")

    const retainedBundle = recovery.indexOf('if test "$TEMPLATE_RECOVERY_BUNDLE_STATE" = rollback; then')
    const recoverBundle = recovery.indexOf('recover_pending_sanctuary_bundle_migration "$IMAGE_ID"', retainedBundle)
    const postBundleStatus = recovery.indexOf('TEMPLATE_RECOVERY_POST_BUNDLE_STATUS=$(read_sanctuary_bundle_transaction_status "$IMAGE_ID")', recoverBundle)
    const proveBundleAbsent = recovery.indexOf('test "$TEMPLATE_RECOVERY_POST_BUNDLE_STATUS" = null', postBundleStatus)
    const currentReceipt = recovery.indexOf('write_dockerman_recovery_evidence absent rollback-exact', proveBundleAbsent)
    const currentAction = recovery.indexOf('"action":"restore-prior-template"', currentReceipt)
    expect(retainedBundle).toBeGreaterThan(-1)
    expect(recoverBundle).toBeGreaterThan(retainedBundle)
    expect(postBundleStatus).toBeGreaterThan(recoverBundle)
    expect(proveBundleAbsent).toBeGreaterThan(postBundleStatus)
    expect(currentReceipt).toBeGreaterThan(proveBundleAbsent)
    expect(currentAction).toBeGreaterThan(currentReceipt)
    expect(recovery.slice(recoverBundle, currentAction)).not.toContain("write_dockerman_recovery_evidence rollback rollback-exact")

    const noProduction = recovery.indexOf('elif test "$TEMPLATE_RECOVERY_BUNDLE_STATE" = absent && test "$TEMPLATE_RECOVERY_PRODUCTION_PRESENT" = false; then')
    const adoptionSource = recovery.indexOf("if docker container inspect ouro-butler-staging >/dev/null 2>&1; then", noProduction)
    const adoptionRejectRollback = recovery.indexOf("! docker container inspect ouro-butler-rollback >/dev/null 2>&1", adoptionSource)
    const adoptionRejectEvidence = recovery.indexOf("! docker container inspect ouro-butler-legacy-evidence >/dev/null 2>&1", adoptionRejectRollback)
    const adoptionSourceImage = recovery.indexOf("TEMPLATE_RECOVERY_STAGING_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-staging)", adoptionRejectEvidence)
    const adoptionSourceExact = recovery.indexOf('test "$TEMPLATE_RECOVERY_STAGING_IMAGE_ID" = "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID"', adoptionSourceImage)
    const adoptionSourceAudit = recovery.indexOf('assert_prepackage_alpha797_source "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" ouro-butler-staging', adoptionSourceExact)
    const adoptionSourceState = recovery.indexOf("TEMPLATE_RECOVERY_STAGING_RUNNING=$(docker inspect --format '{{.State.Running}}' ouro-butler-staging)", adoptionSourceAudit)
    const adoptionSourceStart = recovery.indexOf("docker start ouro-butler-staging", adoptionSourceState)
    const adoptionSourceAutostart = recovery.indexOf("set_butler_autostart staging", adoptionSourceStart)
    const adoptionSourceEvidence = recovery.indexOf("adoption-source-exact", adoptionSourceAutostart)
    const adoptionSourceRollback = recovery.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" rollback', adoptionSourceEvidence)
    const normalRollback = recovery.indexOf("if docker container inspect ouro-butler-rollback >/dev/null 2>&1; then", noProduction)
    const normalRollbackImage = recovery.indexOf("TEMPLATE_RECOVERY_CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback)", normalRollback)
    const normalRollbackExact = recovery.indexOf('test "$TEMPLATE_RECOVERY_CURRENT_ROLLBACK_IMAGE_ID" = "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID"', normalRollbackImage)
    const normalRollbackStopped = recovery.indexOf("test \"$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)\" = false", normalRollbackExact)
    const normalRename = recovery.indexOf("docker rename ouro-butler-rollback ouro-butler", normalRollbackStopped)
    const normalAudit = recovery.indexOf('assert_update_source "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID"', normalRename)
    const normalStart = recovery.indexOf("start_only_butler_for_recovery", normalAudit)
    const normalReady = recovery.indexOf("wait_butler_ready ouro-butler", normalStart)
    const normalAutostart = recovery.indexOf("enable_butler_autostart", normalReady)
    const normalTemplateRollback = recovery.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" rollback', normalAutostart)
    expect(noProduction).toBeGreaterThan(-1)
    expect(adoptionSource).toBeGreaterThan(noProduction)
    expect(adoptionRejectRollback).toBeGreaterThan(adoptionSource)
    expect(adoptionRejectEvidence).toBeGreaterThan(adoptionRejectRollback)
    expect(adoptionSourceImage).toBeGreaterThan(adoptionRejectEvidence)
    expect(adoptionSourceExact).toBeGreaterThan(adoptionSourceImage)
    expect(adoptionSourceAudit).toBeGreaterThan(adoptionSourceExact)
    expect(adoptionSourceState).toBeGreaterThan(adoptionSourceAudit)
    expect(adoptionSourceStart).toBeGreaterThan(adoptionSourceState)
    expect(adoptionSourceAutostart).toBeGreaterThan(adoptionSourceStart)
    expect(recovery.slice(adoptionSource, adoptionSourceAutostart)).not.toContain("wait_butler_ready")
    expect(adoptionSourceEvidence).toBeGreaterThan(adoptionSourceAutostart)
    expect(adoptionSourceRollback).toBeGreaterThan(adoptionSourceEvidence)
    expect(normalRollback).toBeGreaterThan(adoptionSourceRollback)
    expect(normalRollbackImage).toBeGreaterThan(normalRollback)
    expect(normalRollbackExact).toBeGreaterThan(normalRollbackImage)
    expect(normalRollbackStopped).toBeGreaterThan(normalRollbackExact)
    expect(normalRename).toBeGreaterThan(normalRollbackStopped)
    expect(normalAudit).toBeGreaterThan(normalRename)
    expect(normalStart).toBeGreaterThan(normalAudit)
    expect(normalReady).toBeGreaterThan(normalStart)
    expect(normalAutostart).toBeGreaterThan(normalReady)
    expect(normalTemplateRollback).toBeGreaterThan(normalAutostart)

    const quarantineEvidence = recovery.indexOf("TEMPLATE_RECOVERY_LEGACY_EVIDENCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-legacy-evidence)", noProduction)
    const quarantineExact = recovery.indexOf('test "$TEMPLATE_RECOVERY_LEGACY_EVIDENCE_IMAGE_ID" = "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID"', quarantineEvidence)
    const quarantineStopped = recovery.indexOf("test \"$(docker inspect --format '{{.State.Running}}' ouro-butler-legacy-evidence)\" = false", quarantineExact)
    const quarantineAction = recovery.indexOf("adoption-evidence-exact-stopped", quarantineStopped)
    const quarantineRollback = recovery.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" rollback', quarantineAction)
    const quarantineGuidance = recovery.indexOf("Legacy adoption recovery requires a reviewed retry", quarantineRollback)
    expect(quarantineEvidence).toBeGreaterThan(normalTemplateRollback)
    expect(quarantineExact).toBeGreaterThan(quarantineEvidence)
    expect(quarantineStopped).toBeGreaterThan(quarantineExact)
    expect(quarantineAction).toBeGreaterThan(quarantineStopped)
    expect(quarantineRollback).toBeGreaterThan(quarantineAction)
    expect(quarantineGuidance).toBeGreaterThan(quarantineRollback)

    const adoptionTarget = recovery.indexOf('test "$TEMPLATE_RECOVERY_STATE" = rollback && test "$TEMPLATE_RECOVERY_PRODUCTION_IMAGE_ID" = "$IMAGE_ID"')
    const adoptionEvidence = recovery.indexOf("TEMPLATE_RECOVERY_LEGACY_EVIDENCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-legacy-evidence)", adoptionTarget)
    const adoptionEvidenceExact = recovery.indexOf('test "$TEMPLATE_RECOVERY_LEGACY_EVIDENCE_IMAGE_ID" = "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID"', adoptionEvidence)
    const adoptionAudit = recovery.indexOf('audit_effective ouro-butler "$IMAGE_ID"', adoptionEvidenceExact)
    const adoptionStart = recovery.indexOf("start_only_butler_for_recovery", adoptionAudit)
    const adoptionReady = recovery.indexOf("wait_butler_ready ouro-butler", adoptionStart)
    const adoptionInspect = recovery.indexOf('migrate_sanctuary_package_managed_bundle "$IMAGE_ID" inspect', adoptionReady)
    const adoptionDecision = recovery.indexOf("adoption-target-exact-ready", adoptionInspect)
    const adoptionAutostart = recovery.indexOf("enable_butler_autostart", adoptionDecision)
    const adoptionCommitting = recovery.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" mark-committing', adoptionAutostart)
    expect(adoptionTarget).toBeGreaterThan(-1)
    expect(adoptionEvidence).toBeGreaterThan(adoptionTarget)
    expect(adoptionEvidenceExact).toBeGreaterThan(adoptionEvidence)
    expect(adoptionAudit).toBeGreaterThan(adoptionEvidenceExact)
    expect(adoptionStart).toBeGreaterThan(adoptionAudit)
    expect(adoptionReady).toBeGreaterThan(adoptionStart)
    expect(adoptionInspect).toBeGreaterThan(adoptionReady)
    expect(adoptionDecision).toBeGreaterThan(adoptionInspect)
    expect(adoptionAutostart).toBeGreaterThan(adoptionDecision)
    expect(adoptionCommitting).toBeGreaterThan(adoptionAutostart)
  })

  it("restores an exact legacy staging source after adoption crashes before quarantine", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const recovery = extractRunbookFunction(runbook, "recover_dockerman_template_transaction").replaceAll("/usr/local/bin/node", "node")
    const oldImage = `sha256:${"a".repeat(64)}`
    const targetImage = `sha256:${"b".repeat(64)}`
    const versionImage = "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798"
    const manifestDigest = `sha256:${"c".repeat(64)}`
    const templateStatus = JSON.stringify({ state: "rollback", rollbackImageId: oldImage, targetImageId: targetImage, canonicalVersionTag: versionImage, reviewedManifestDigest: manifestDigest })
    const script = String.raw`set -u
SCENARIO=$1
node() {
  if test "$1" = "$STAGED_DOCKERMAN_TRANSACTION"; then
    case "$2" in
      recovery-identity|recover-status) command printf '%s\n' "$TEMPLATE_STATUS" ;;
      recovery-action) command printf 'action\n' >>"$CALL_LOG"; command printf '{"action":"restore-prior-template"}\n' ;;
      rollback) command printf 'rollback-template\n' >>"$CALL_LOG" ;;
      *) return 92 ;;
    esac
  else
    command "$NODE_BINARY" "$@"
  fi
}
validate_exact_image_id() { return 0; }
read_sanctuary_bundle_transaction_status() { command printf 'null\n'; }
docker() {
  case "$*" in
    "container inspect ouro-butler") return 1 ;;
    "container inspect ouro-butler-staging") return 0 ;;
    "container inspect ouro-butler-rollback") test "$SCENARIO" = rollback-present ;;
    "container inspect ouro-butler-legacy-evidence") test "$SCENARIO" = evidence-present ;;
    "inspect --format {{.Image}} ouro-butler-staging") if test "$SCENARIO" = wrong-image; then command printf '%s\n' "$TARGET_IMAGE"; else command printf '%s\n' "$OLD_IMAGE"; fi ;;
    "inspect --format {{.State.Running}} ouro-butler-staging") if test "$SCENARIO" = stopped; then command printf 'false\n'; elif test "$SCENARIO" = invalid-state; then command printf 'paused\n'; else command printf 'true\n'; fi ;;
    "start ouro-butler-staging") command printf 'start-staging\n' >>"$CALL_LOG" ;;
    *) command printf 'unexpected-docker:%s\n' "$*" >>"$CALL_LOG"; return 93 ;;
  esac
}
assert_prepackage_alpha797_source() { test "$1" = "$OLD_IMAGE" && test "$2" = "$TARGET_IMAGE" && test "$3" = ouro-butler-staging || return 1; command printf 'audit-source\n' >>"$CALL_LOG"; }
assert_only_running_butler() { command printf 'assert:%s\n' "$1" >>"$CALL_LOG"; }
wait_butler_ready() { command printf 'unexpected-wait:%s\n' "$1" >>"$CALL_LOG"; return 99; }
set_butler_autostart() { test "$1" = staging || return 1; command printf 'autostart:staging\n' >>"$CALL_LOG"; }
write_dockerman_recovery_evidence() { command printf 'evidence:%s:%s\n' "$1" "$2" >>"$CALL_LOG"; }
${recovery}
recover_dockerman_template_transaction`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-adoption-staging-recovery-"))
    try {
      for (const scenario of ["running", "unhealthy-running", "stopped", "wrong-image", "rollback-present", "evidence-present", "invalid-state"]) {
        const callLog = path.join(testRoot, `${scenario}.log`)
        fs.writeFileSync(callLog, "")
        const result = runConditionalHelper(script, scenario, { AUDIT_RUNNER_IMAGE_ID: targetImage, CALL_LOG: callLog, EVENT_ASSET_STAGE: testRoot, IMAGE_ID: targetImage, MANIFEST_DIGEST: manifestDigest, NODE_BINARY: process.execPath, OLD_IMAGE: oldImage, STAGED_DOCKERMAN_TRANSACTION: "/tmp/transaction.mjs", TARGET_IMAGE: targetImage, TEMPLATE_STATUS: templateStatus, VERSION_IMAGE: versionImage })
        const calls = fs.readFileSync(callLog, "utf8")
        if (["wrong-image", "rollback-present", "evidence-present", "invalid-state"].includes(scenario)) {
          expect(result.status).not.toBe(0)
          if (scenario === "invalid-state") expect(calls).toBe("audit-source\n")
          else expect(calls).toBe("")
          continue
        }
        expect(result.status, `${scenario}: ${result.stderr}`).toBe(0)
        expect(calls).toContain("audit-source\n")
        expect(calls).not.toContain("unexpected-wait:")
        expect(calls.indexOf("audit-source\n")).toBeLessThan(calls.indexOf("autostart:staging\n"))
        expect(calls.indexOf("autostart:staging\n")).toBeLessThan(calls.indexOf("evidence:absent:adoption-source-exact\n"))
        expect(calls.indexOf("evidence:absent:adoption-source-exact\n")).toBeLessThan(calls.indexOf("rollback-template\n"))
        if (scenario === "stopped") expect(calls).toContain("assert:-\nstart-staging\nassert:ouro-butler-staging\n")
        else {
          expect(calls).toContain("assert:ouro-butler-staging\n")
          expect(calls).not.toContain("start-staging\n")
        }
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  }, 15_000)

  it("never starts a recovery poller until it proves no competing Butler is running", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const helper = extractRunbookFunction(runbook, "start_only_butler_for_recovery")
    const script = String.raw`set -u
SCENARIO=$1
docker() {
  case "$*" in
    "inspect --format {{.State.Running}} ouro-butler") case "$SCENARIO" in running) command printf 'true\n' ;; stopped|competing) command printf 'false\n' ;; *) command printf 'unknown\n' ;; esac ;;
    "start ouro-butler") command printf 'start\n' >>"$CALL_LOG" ;;
    *) return 23 ;;
  esac
}
assert_only_running_butler() {
  command printf 'assert:%s\n' "$1" >>"$CALL_LOG"
  if test "$SCENARIO" = competing && test "$1" = -; then return 41; fi
}
${helper}
start_only_butler_for_recovery`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-template-recovery-start-"))
    try {
      for (const scenario of ["running", "stopped", "competing", "invalid"]) {
        const callLog = path.join(testRoot, `${scenario}.log`)
        fs.writeFileSync(callLog, "")
        const result = runConditionalHelper(script, scenario, { CALL_LOG: callLog })
        const calls = fs.readFileSync(callLog, "utf8")
        if (scenario === "running") {
          expect(result.status, result.stderr).toBe(0)
          expect(calls).toBe("assert:ouro-butler\n")
        } else if (scenario === "stopped") {
          expect(result.status, result.stderr).toBe(0)
          expect(calls).toBe("assert:-\nstart\nassert:ouro-butler\n")
        } else {
          expect(result.status, scenario).not.toBe(0)
          expect(calls).not.toContain("start\n")
        }
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("proves zero running pollers immediately before every changed deployment start and one immediately after", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const adoption = extractRunbookFunction(runbook, "install_from_legacy_staging")
    const update = runbook.slice(runbook.indexOf("For normal updates"), runbook.indexOf("Backup:"))
    const backup = runbook.slice(runbook.indexOf("Backup:"), runbook.indexOf("Restore:"))
    const restore = runbook.slice(runbook.indexOf("Restore:"), runbook.indexOf("Credential recovery:"))

    expect(adoption).toContain("&& assert_only_running_butler - \\\n    && docker start ouro-butler \\\n    && assert_only_running_butler ouro-butler \\")
    expect(update).toContain("&& assert_only_running_butler - \\\n      && docker start ouro-butler \\\n      && assert_only_running_butler ouro-butler \\")
    expect(backup).toContain("&& assert_only_running_butler - \\\n      && docker start ouro-butler \\\n      && assert_only_running_butler ouro-butler \\")
    expect(restore).toContain("&& assert_only_running_butler - \\\n      && docker start ouro-butler \\\n      && assert_only_running_butler ouro-butler \\")

    const preparationFailure = update.slice(update.indexOf("PRODUCTION_PREPARATION_STATUS=$?"), update.indexOf("Preparation failure therefore"))
    const activationFailure = update.slice(update.indexOf("PRODUCTION_ACTIVATION_STATUS=$?"), update.indexOf('(exit "$PRODUCTION_ACTIVATION_STATUS")'))
    expect(preparationFailure.match(/start_only_butler_for_recovery/gu)).toHaveLength(2)
    expect(activationFailure.match(/start_only_butler_for_recovery/gu)).toHaveLength(1)
    expect(preparationFailure).not.toContain("docker start ouro-butler")
    expect(activationFailure).not.toContain("docker start ouro-butler")
  })

  it("resumes rollback recovery after the old container was renamed, started, or re-enabled", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const recovery = extractRunbookFunction(runbook, "recover_pending_sanctuary_bundle_migration")
    const rollbackRecovery = recovery.slice(recovery.indexOf('test "$RECOVERY_STATE" = committing'))
    const rollbackBranch = recovery.slice(
      recovery.lastIndexOf("  if docker container inspect ouro-butler-rollback >/dev/null 2>&1; then"),
      recovery.lastIndexOf("\n}"),
    )

    expect(rollbackRecovery).toContain("if docker container inspect ouro-butler-rollback >/dev/null 2>&1; then")
    expect(rollbackRecovery).toContain("elif docker container inspect ouro-butler >/dev/null 2>&1; then")
    expect(rollbackRecovery).toContain('test "$RECOVERY_PRODUCTION_IMAGE_ID" = "$RECOVERY_ROLLBACK_IMAGE_ID" || return 1')
    expect(rollbackRecovery).toContain("! docker container inspect ouro-butler-staging >/dev/null 2>&1 || return 1")
    expect(rollbackRecovery).toContain("! docker container inspect ouro-butler-rollback >/dev/null 2>&1 || return 1")
    expect(rollbackRecovery).toContain('migrate_sanctuary_package_managed_bundle "$RECOVERY_IMAGE_ID" rollback || return $?')
    expect(rollbackRecovery).toContain("else\n    return 1\n  fi\n  RECOVERY_PRODUCTION_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler) || return $?")
    expect(rollbackRecovery).toContain('test "$RECOVERY_PRODUCTION_IMAGE_ID" = "$RECOVERY_ROLLBACK_IMAGE_ID" || return 1')

    const topologyResolved = rollbackRecovery.lastIndexOf("RECOVERY_PRODUCTION_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)")
    const audit = rollbackRecovery.indexOf('assert_update_source "$RECOVERY_ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"', topologyResolved)
    const start = rollbackRecovery.indexOf("start_only_butler_for_recovery", audit)
    const ready = rollbackRecovery.indexOf("wait_butler_ready ouro-butler", start)
    const autostart = rollbackRecovery.indexOf("enable_butler_autostart", ready)
    const finalizeRollback = rollbackRecovery.indexOf('migrate_sanctuary_package_managed_bundle "$RECOVERY_IMAGE_ID" finalize-rollback', autostart)
    expect(topologyResolved).toBeGreaterThan(-1)
    expect(audit).toBeGreaterThan(topologyResolved)
    expect(start).toBeGreaterThan(audit)
    expect(ready).toBeGreaterThan(start)
    expect(autostart).toBeGreaterThan(ready)
    expect(finalizeRollback).toBeGreaterThan(autostart)
    expect(rollbackRecovery.indexOf('migrate_sanctuary_package_managed_bundle "$RECOVERY_IMAGE_ID" commit', autostart)).toBe(-1)

    const oldImage = `sha256:${"a".repeat(64)}`
    const targetImage = `sha256:${"b".repeat(64)}`
    const startOnly = extractRunbookFunction(runbook, "start_only_butler_for_recovery")
    const script = `
docker() {
  command printf '%s\n' "docker $*" >>"$CALL_LOG"
  case "$*" in
    "container inspect ouro-butler-rollback") return 1 ;;
    "container inspect ouro-butler-staging") test "$TOPOLOGY" = ambiguous ;;
    "container inspect ouro-butler") return 0 ;;
    "inspect --format {{.Image}} ouro-butler")
      if test "$TOPOLOGY" = wrong-image; then command printf '%s\n' "$RECOVERY_TARGET_IMAGE_ID"; else command printf '%s\n' "$RECOVERY_ROLLBACK_IMAGE_ID"; fi ;;
    "inspect --format {{.State.Running}} ouro-butler") if test "$TOPOLOGY" = renamed; then command printf 'false\n'; else command printf 'true\n'; fi ;;
    "start ouro-butler")
      command printf '%s\n' started-stopped-container >>"$CALL_LOG" ;;
    *) return 23 ;;
  esac
}
assert_update_source() { test "$1" = "$RECOVERY_ROLLBACK_IMAGE_ID" && command printf '%s\n' assert-update-source >>"$CALL_LOG"; }
assert_only_running_butler() { command printf '%s\n' assert-only-running >>"$CALL_LOG"; }
wait_butler_ready() { command printf '%s\n' wait-ready >>"$CALL_LOG"; }
enable_butler_autostart() {
  if test "$TOPOLOGY" = autostart-enabled; then command printf '%s\n' autostart-was-idempotent >>"$CALL_LOG"; fi
  command printf '%s\n' enable-autostart >>"$CALL_LOG"
}
migrate_sanctuary_package_managed_bundle() {
  case "$2" in
    rollback|finalize-rollback) command printf '%s\n' "$2" >>"$CALL_LOG" ;;
    *) return 23 ;;
  esac
}
${startOnly}
recover_test() {
${rollbackBranch}
}
recover_test`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-old-topology-recovery-"))
    try {
      for (const topology of ["renamed", "started", "autostart-enabled"]) {
        const callLog = path.join(testRoot, `${topology}.log`)
        const result = runConditionalHelper(script, "unused", {
          AUDIT_RUNNER_IMAGE_ID: targetImage,
          CALL_LOG: callLog,
          RECOVERY_IMAGE_ID: targetImage,
          RECOVERY_ROLLBACK_IMAGE_ID: oldImage,
          RECOVERY_TARGET_IMAGE_ID: targetImage,
          TOPOLOGY: topology,
        })
        expect(result.status, `${topology}\n${result.stderr}`).toBe(0)
        const calls = fs.readFileSync(callLog, "utf8")
        expect(calls).toContain("rollback")
        expect(calls.indexOf("rollback")).toBeLessThan(calls.indexOf("assert-update-source"))
        expect(calls.indexOf("assert-update-source")).toBeLessThan(calls.indexOf("wait-ready"))
        expect(calls.indexOf("wait-ready")).toBeLessThan(calls.indexOf("enable-autostart"))
        expect(calls.indexOf("enable-autostart")).toBeLessThan(calls.indexOf("finalize-rollback"))
        expect(calls).not.toContain("\ncommit\n")
        if (topology === "renamed") {
          expect(calls).toContain("docker start ouro-butler")
          expect(calls.indexOf("assert-update-source")).toBeLessThan(calls.indexOf("docker start ouro-butler"))
          expect(calls.indexOf("docker start ouro-butler")).toBeLessThan(calls.indexOf("wait-ready"))
          expect(calls).toContain("started-stopped-container")
        } else expect(calls).not.toContain("docker start ouro-butler")
        if (topology === "autostart-enabled") expect(calls).toContain("autostart-was-idempotent")
      }

      for (const topology of ["wrong-image", "ambiguous"]) {
        const callLog = path.join(testRoot, `${topology}.log`)
        const result = runConditionalHelper(script, "unused", {
          AUDIT_RUNNER_IMAGE_ID: targetImage,
          CALL_LOG: callLog,
          RECOVERY_IMAGE_ID: targetImage,
          RECOVERY_ROLLBACK_IMAGE_ID: oldImage,
          RECOVERY_TARGET_IMAGE_ID: targetImage,
          TOPOLOGY: topology,
        })
        expect(result.status, topology).not.toBe(0)
        const calls = fs.readFileSync(callLog, "utf8")
        expect(calls).not.toContain("docker start ouro-butler")
        expect(calls).not.toContain("finalize-rollback")
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("contains failed restore activation explicitly while leaving autostart disabled", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const restore = runbook.slice(runbook.indexOf("Restore:"), runbook.indexOf("Credential recovery:"))

    const registeredTemplateAudit = restore.indexOf('audit_registered_dockerman_template "$AUDIT_RUNNER_IMAGE_ID" "$RESTORE_VERSION_IMAGE"')
    const disableGuard = restore.indexOf("if disable_butler_autostart; then")
    const disableStatus = restore.indexOf("RESTORE_AUTOSTART_DISABLE_STATUS=$?", disableGuard)
    const disablePropagate = restore.indexOf('(exit "$RESTORE_AUTOSTART_DISABLE_STATUS")', disableStatus)
    const stopOld = restore.indexOf("if { docker stop ouro-butler >/dev/null 2>&1 || true; } \\", disableGuard)
    const restoreRuntime = restore.indexOf('&& rsync -a --delete "$BACKUP_ROOT/runtime/.ouro-cli/"', stopOld)
    const restoreBundle = restore.indexOf('&& rsync -a --delete "$BACKUP_ROOT/agent/sanctuary.ouro/"', restoreRuntime)
    const create = restore.indexOf("&& docker create --pull=never --name ouro-butler --network host --restart unless-stopped --user 10001:10001 \\", restoreBundle)
    expect(registeredTemplateAudit).toBeGreaterThan(-1)
    expect(disableGuard).toBeGreaterThan(registeredTemplateAudit)
    expect(disableStatus).toBeGreaterThan(disableGuard)
    expect(disablePropagate).toBeGreaterThan(disableStatus)
    expect(stopOld).toBeGreaterThan(disableGuard)
    expect(restoreRuntime).toBeGreaterThan(stopOld)
    expect(restoreBundle).toBeGreaterThan(restoreRuntime)
    expect(create).toBeGreaterThan(restoreBundle)
    expect(restore).toContain('&& audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" canonical "$RESTORE_VERSION_IMAGE" https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png \\')
    expect(restore).toContain('&& verify_dockerman_and_community_apps "$RESTORE_VERSION_IMAGE" "$RESTORE_INSTALL_PROOF_ROOT/install.json" \\')
    expect(restore).toContain("&& docker start ouro-butler \\")
    expect(restore).toContain("&& wait_butler_ready ouro-butler \\")
    expect(restore).toContain("&& enable_butler_autostart; then")
    expect(restore).toContain("RESTORE_ACTIVATION_STATUS=$?")
    const status = restore.indexOf("RESTORE_ACTIVATION_STATUS=$?")
    const inspectPartial = restore.indexOf("if docker container inspect ouro-butler >/dev/null 2>&1; then", status)
    const stopPartial = restore.indexOf("docker stop ouro-butler >/dev/null 2>&1 || true", inspectPartial)
    const removePartial = restore.indexOf("docker rm --force ouro-butler", stopPartial)
    const verifyAbsent = restore.indexOf("! docker container inspect ouro-butler >/dev/null 2>&1", removePartial)
    const propagate = restore.indexOf('(exit "$RESTORE_ACTIVATION_STATUS")', verifyAbsent)
    expect(inspectPartial).toBeGreaterThan(status)
    expect(stopPartial).toBeGreaterThan(inspectPartial)
    expect(removePartial).toBeGreaterThan(stopPartial)
    expect(verifyAbsent).toBeGreaterThan(removePartial)
    expect(propagate).toBeGreaterThan(verifyAbsent)
    expect(restore).toContain('(exit "$RESTORE_ACTIVATION_STATUS")')
    const failure = restore.slice(status)
    expect(failure).not.toContain("enable_butler_autostart")
  })

  it("stops restore before mutation when the persistent template does not match the snapshot version", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const helper = extractRunbookFunction(runbook, "audit_registered_dockerman_template").replaceAll("/boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml", "$REGISTERED_TEMPLATE_TEST_PATH")
    const imageId = `sha256:${"a".repeat(64)}`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-restore-template-audit-"))
    try {
      const templatePath = path.join(testRoot, "my-ouro-butler.xml")
      fs.writeFileSync(templatePath, "<Container/>\n", { mode: 0o600 })
      const script = String.raw`set -u
validate_exact_image_id() { return 0; }
docker() { return 23; }
${helper}
if audit_registered_dockerman_template "$IMAGE_ID" "$VERSION_IMAGE"; then command printf 'MUTATION\n'; else exit $?; fi`
      const result = runConditionalHelper(script, "mismatch", { IMAGE_ID: imageId, REGISTERED_TEMPLATE_TEST_PATH: templatePath, VERSION_IMAGE: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798" })
      expect(result.status, result.stderr).toBe(23)
      expect(result.stdout).not.toContain("MUTATION")
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("ships Mendelow Cloud Butler with the exact persistent roots and complete bootstrap bundle", () => {
    const dockerfile = fs.readFileSync("deploy/unraid/Dockerfile", "utf8")
    const template = fs.readFileSync("deploy/unraid/sanctuary.xml", "utf8")
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const auditor = fs.readFileSync("deploy/unraid/audit-container-spec.sh", "utf8")
    const agent = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/agent.json", "utf8")) as {
      habitPaidTurnsPerDay?: number
    }
    const meta = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/bundle-meta.json", "utf8")) as {
      runtimeVersion: string
      bundleSchemaVersion: number
    }

    expect(template).toContain("<Overview>Mendelow Cloud Butler")
    expect(template).toContain('Default="/mnt/user/appdata/ouro-butler/runtime/.ouro-cli"')
    expect(template).toContain('Default="/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro"')
    expect(template).not.toContain('/mnt/user/appdata/ouro-butler/AgentBundles')
    expect(template).toContain(`<Repository>ghcr.io/ourostack/ouroboros-butler:${JSON.parse(fs.readFileSync("package.json", "utf8")).version}</Repository>`)
    expect(template).toContain('Default="/boot/config/custom/ouro-events/spool" Mode="ro"')
    expect(template).not.toContain('Default="/mnt/user/appdata/sabnzbd/sabnzbd.ini"')
    expect(runbook).toContain("Mendelow Cloud Butler operator runbook")
    expect(runbook).toContain("/mnt/user/appdata/ouro-butler/runtime/.ouro-cli")
    expect(runbook).toContain("/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro")
    expect(runbook).toContain("docker image inspect --format '{{.Id}}'")
    expect(runbook).toContain("docker image inspect \"$IMAGE_ID\"")
    expect(runbook).toContain("original version-tagged template")
    expect(runbook).toContain("writes every credential class into the unlocked Sanctuary vault before deleting the claimed envelope")
    expect(runbook).toContain('const envelope = { schemaVersion: 1, credentials: [credential] }')
    expect(runbook).toContain('machineRuntimeConfig: { sabnzbdApiKey: match[1] }')
    expect(runbook).toContain('verify_sanctuary_sab_readiness "$IMAGE_ID"')
    expect(runbook).toContain("PRECUTOVER_READINESS_STATUS=$?")
    expect(runbook).toContain('ouro vault config set --agent sanctuary --key sabnzbdApiKey --scope machine')
    expect(runbook).toContain("container-credentials.json.consuming")
    expect(runbook).toContain("byte-for-byte identical")
    expect(runbook).toContain("redundant unclaimed source")
    expect(runbook).toContain("human-required")
    expect(runbook).toContain("securely compare and quarantine")
    expect(runbook).toContain("Never print either envelope's contents")
    expect(runbook).not.toContain("repository digest")
    expect(runbook).toContain("docker run --rm --pull=never --network=none \\")
    expect(runbook.match(/--user 0:0 --read-only --cap-drop=ALL --security-opt=no-new-privileges \\/gu)).toHaveLength(3)
    expect(extractRunbookFunction(runbook, "audit_effective")).toContain("docker run --rm --pull=never --network=none \\\n    --user 0:0 --read-only --cap-drop=ALL --security-opt=no-new-privileges \\")
    const stagedAuditStart = runbook.indexOf("audit the original version-tagged template")
    const stagedAuditEnd = runbook.indexOf("If extraction, transactional installation", stagedAuditStart)
    expect(runbook.slice(stagedAuditStart, stagedAuditEnd)).toContain("docker run --rm --pull=never --network=none \\\n      --user 0:0 --read-only --cap-drop=ALL --security-opt=no-new-privileges \\")
    expect(runbook).toContain("--entrypoint /opt/ouro/deploy/unraid/audit-container-spec.sh \\")
    expect(runbook).toContain('--mount "type=bind,src=$STAGED_TEMPLATE,dst=/audit/sanctuary.xml,readonly" \\')
    expect(runbook).toContain('--mount "type=bind,src=$STAGED_RUNTIME_POLICY,dst=/audit/container-runtime.json,readonly" \\')
    expect(runbook).toContain('"$IMAGE_ID" --template /audit/sanctuary.exact-image.xml --runtime-policy /audit/container-runtime.json --expected-image "$IMAGE_ID"')
    const updateRunbook = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("Backup:"))
    const normalUpdateRunbook = updateRunbook.slice(updateRunbook.indexOf("For normal updates"))
    const sourceAdmission = updateRunbook.indexOf("admit_sanctuary_update_entry")
    const manifestCheck = updateRunbook.indexOf("docker buildx imagetools inspect")
    const targetPull = updateRunbook.indexOf('docker pull "$VERSION_IMAGE"')
    const targetImageValidation = updateRunbook.indexOf('validate_exact_image_id "$IMAGE_ID"')
    const localImageCheck = updateRunbook.indexOf('docker image inspect --format \'{{.Id}}\' "$VERSION_IMAGE"')
    expect(sourceAdmission).toBeLessThan(manifestCheck)
    expect(manifestCheck).toBeLessThan(targetPull)
    expect(targetPull).toBeLessThan(targetImageValidation)
    expect(targetImageValidation).toBeLessThan(localImageCheck)
    expect(updateRunbook.indexOf('verify_sanctuary_sab_readiness "$IMAGE_ID"')).toBeGreaterThanOrEqual(0)
    expect(updateRunbook.indexOf('verify_sanctuary_sab_readiness "$IMAGE_ID"')).toBeLessThan(updateRunbook.indexOf("disable_butler_autostart"))
    expect(normalUpdateRunbook.indexOf('verify_sanctuary_telegram_readiness "$IMAGE_ID"')).toBeGreaterThanOrEqual(0)
    expect(normalUpdateRunbook.indexOf('verify_sanctuary_telegram_readiness "$IMAGE_ID"')).toBeLessThan(normalUpdateRunbook.indexOf("disable_butler_autostart"))
    const backupRunbook = runbook.slice(runbook.indexOf("Backup:"), runbook.indexOf("Restore:"))
    const restoreRunbook = runbook.slice(runbook.indexOf("Restore:"), runbook.indexOf("Credential recovery:"))
    expect(runbook).toContain("AUTOSTART_FILE=/var/lib/docker/unraid-autostart")
    expect(runbook).toContain("/usr/local/emhttp/plugins/dynamix.docker.manager/include/UpdateConfig.php")
    expect(runbook).toContain("timeout -s KILL 20 /usr/bin/php -r")
    expect(runbook).toContain("false-to-index-zero behavior")
    expect(extractRunbookFunction(runbook, "set_butler_autostart")).not.toMatch(/(?:AUDIT_RUNNER_)?IMAGE_ID/u)
    expect(restoreRunbook).toContain("AUDIT_RUNNER_IMAGE_ID=")
    expect(restoreRunbook).toContain("IMAGE_ID=")
    expect(runbook).not.toContain('mv -f -- "$AUTOSTART_TMP" "$AUTOSTART_FILE"')
    expect(runbook).toContain('verify_butler_autostart "0 0 0 0" || return $?')
    expect(runbook).toContain('verify_butler_autostart "1 0 0 0" || return $?')
    expect(normalUpdateRunbook).not.toContain('docker create --name ouro-butler-staging')
    expect(updateRunbook).toContain('--mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \\')
    expect(updateRunbook).toContain('--mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \\')
    expect(updateRunbook).toContain('--mount "type=bind,src=/boot/config/custom/ouro-events/spool,dst=/run/ouro-events,readonly" \\')
    expect(updateRunbook.indexOf("bootstrap-spool.sh --mount")).toBeLessThan(updateRunbook.indexOf("disable_butler_autostart"))
    expect(backupRunbook).toContain("--exclude='/state/acceptance/telegram-control.sock'")
    expect(backupRunbook).toContain('test ! -S "$BACKUP_TMP/agent/sanctuary.ouro/state/acceptance/telegram-control.sock"')
    expect(backupRunbook).toContain('docker container inspect ouro-butler >"$BACKUP_TMP/provenance/container-inspect.json"')
    expect(backupRunbook).toContain('printf \'%s\\n\' "$BACKUP_IMAGE_ID" >"$BACKUP_TMP/provenance/image-id"')
    expect(backupRunbook).toContain('docker image inspect "$BACKUP_IMAGE_ID" >"$BACKUP_TMP/provenance/image-inspect.json"')
    expect(backupRunbook).toContain('>"$BACKUP_TMP/provenance/package-version"')
    expect(backupRunbook).toContain('"$BACKUP_TMP/agent" "$BACKUP_TMP/host" "$BACKUP_TMP/provenance"')
    expect(backupRunbook).toContain("snapshot_butler_host_fragments")
    expect(backupRunbook).toContain('backup_host_file /boot/config/custom/usenet_health.sh custom/usenet_health.sh')
    expect(backupRunbook).toContain('backup_host_file /boot/config/custom/ouro-events/install-usenet-guard.sh custom/ouro-events/install-usenet-guard.sh')
    expect(backupRunbook).toContain('crontab -l >"$BACKUP_CRON_SOURCE"')
    expect(backupRunbook).toContain('>"$BACKUP_TMP/host/go.butler-lines"')
    expect(backupRunbook).toContain('snapshot_butler_cron_fragments "$BACKUP_CRON_SOURCE" "$BACKUP_TMP/host/crontab.butler-lines"')
    expect(backupRunbook).toContain('>"$BACKUP_TMP/host/global-state"')
    expect(backupRunbook).toContain('install -d -m 0700 -o 0 -g 0 "$BACKUP_TMP/host/custom" "$BACKUP_TMP/host/custom/ouro-events"')
    expect(backupRunbook).toContain("BACKUP_GO_DIGEST=$(sha256sum /boot/config/go")
    expect(backupRunbook).toContain('BACKUP_CRON_DIGEST=$(sha256sum "$BACKUP_CRON_SOURCE"')
    expect(backupRunbook).not.toContain('backup_host_file /boot/config/go go')
    expect(backupRunbook).not.toContain('>"$BACKUP_TMP/host/crontab"')
    expect(backupRunbook).toContain('test ! -e "$BACKUP_TMP/host/notify.conf"')
    expect(backupRunbook).toContain('test ! -e "$BACKUP_TMP/host/sabnzbd.ini"')
    expect(backupRunbook).toContain('host/inventory')
    expect(backupRunbook).toContain('sha256sum --')
    expect(backupRunbook).toContain('mv -- "$BACKUP_TMP" "$BACKUP_ROOT"')
    const publish = backupRunbook.indexOf('mv -- "$BACKUP_TMP" "$BACKUP_ROOT"')
    const revalidate = backupRunbook.indexOf('assert_update_source "$BACKUP_IMAGE_ID"', publish)
    const restart = backupRunbook.indexOf("docker start ouro-butler", revalidate)
    const onlyRunningAfterBackup = backupRunbook.indexOf("assert_only_running_butler ouro-butler", restart)
    const readyAfterBackup = backupRunbook.indexOf("wait_butler_ready ouro-butler", onlyRunningAfterBackup)
    const autostartCapture = backupRunbook.indexOf("BACKUP_AUTOSTART_COUNTS=$(butler_autostart_counts)")
    const stopForBackup = backupRunbook.indexOf("if docker stop ouro-butler")
    const autostartAfterBackup = backupRunbook.indexOf('verify_butler_autostart "$BACKUP_AUTOSTART_COUNTS"', readyAfterBackup)
    expect(autostartCapture).toBeGreaterThan(-1)
    expect(backupRunbook).toContain('validate_exact_image_id "$AUDIT_RUNNER_IMAGE_ID"')
    expect(backupRunbook).toContain('test "$AUDIT_RUNNER_IMAGE_ID" != sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d')
    expect(backupRunbook).toContain('assert_update_source "$BACKUP_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"')
    expect(stopForBackup).toBeGreaterThan(autostartCapture)
    expect(revalidate).toBeGreaterThan(publish)
    expect(restart).toBeGreaterThan(revalidate)
    expect(onlyRunningAfterBackup).toBeGreaterThan(restart)
    expect(readyAfterBackup).toBeGreaterThan(onlyRunningAfterBackup)
    expect(autostartAfterBackup).toBeGreaterThan(readyAfterBackup)
    expect(backupRunbook).toContain("BACKUP_RECOVERY_STATUS=$?")
    expect(backupRunbook).toContain("completed snapshot remains intact")
    expect(backupRunbook.indexOf('chmod 0600 "$BACKUP_TMP/provenance/container-inspect.json"')).toBeLessThan(backupRunbook.indexOf('mv -- "$BACKUP_TMP" "$BACKUP_ROOT"'))
    expect(extractRunbookFunction(runbook, "assert_restore_preflight")).toContain('verify_sanctuary_snapshot_provenance "$BACKUP_ROOT" "$IMAGE_ID"')
    expect(extractRunbookFunction(runbook, "assert_restore_preflight")).toContain('test "$IMAGE_ID" != sha256:e337dff04c92d116b269052f473b26a47eea933d017d1befc73af50dd37bb08d')
    expect(restoreRunbook).toContain('--mount "type=bind,src=/boot/config/custom/ouro-events/spool,dst=/run/ouro-events,readonly" \\')
    expect(restoreRunbook).toContain('--restore-root "$BACKUP_ROOT/host"')
    expect(restoreRunbook).toContain('HOST_RESTORE_INSTALLER=$(mktemp /tmp/ouro-usenet-host-restore.XXXXXX)')
    expect(backupRunbook).toContain('host_file_contains_inline_credential "$BACKUP_HOST_SOURCE"')
    expect(restoreRunbook.indexOf("bootstrap-spool.sh --mount")).toBeLessThan(restoreRunbook.indexOf("disable_butler_autostart"))
    const createCount = runbook.match(/docker create (?:--pull=never )?--name ouro-butler(?:-staging)?/gu)?.length ?? 0
    expect(runbook.match(/--mount "type=bind,src=\/boot\/config\/custom\/ouro-events\/spool,dst=\/run\/ouro-events,readonly"/gu)).toHaveLength(createCount)
    expect(runbook).not.toContain('dst=/run/sanctuary/sabnzbd.ini')
    expect(updateRunbook).toContain('"$IMAGE_ID"')
    expect(runbook).toContain('docker inspect "$AUDIT_CONTAINER" >"$INSPECT_DIR/container.json"')
    expect(runbook).toContain('docker image inspect "$AUDIT_EXPECTED_IMAGE" >"$INSPECT_DIR/image.json"')
    expect(runbook).toContain("--inspect /audit/container.json --image-inspect /audit/image.json")
    expect(runbook).toContain("rm -f -- \"$INSPECT_DIR/container.json\" \"$INSPECT_DIR/image.json\"")
    expect(runbook).toContain("rmdir -- \"$INSPECT_DIR\"")
    const stopProduction = normalUpdateRunbook.indexOf("docker stop ouro-butler")
    const disableAutostart = normalUpdateRunbook.indexOf("disable_butler_autostart")
    const renameRollback = normalUpdateRunbook.indexOf("docker rename ouro-butler ouro-butler-rollback")
    expect(disableAutostart).toBeGreaterThan(-1)
    expect(stopProduction).toBeGreaterThan(disableAutostart)
    expect(stopProduction).toBeGreaterThan(-1)
    expect(renameRollback).toBeGreaterThan(stopProduction)
    const packageMigration = normalUpdateRunbook.indexOf("migrate_sanctuary_package_managed_bundle \"$IMAGE_ID\"")
    expect(packageMigration).toBeGreaterThan(renameRollback)
    expect(normalUpdateRunbook).not.toContain("wait_butler_ready ouro-butler-staging")
    expect(runbook).toContain("docker run --rm --pull=never --network=none --read-only --user 10001:10001 \\")
    expect(updateRunbook).toContain("Package-managed files are exactly")
    expect(updateRunbook).toContain("It preserves agent.json, all steward policy and audit bytes, relationships, sessions, and every other state path")
    expect(updateRunbook).toContain("only after the old production container is audited, ready, and back on autostart does `finalize-rollback` remove it without marking the new release committed")
    expect(normalUpdateRunbook).toContain("Do not start a target-image daemon between the production rename and final")
    expect(updateRunbook).toContain("docker rename ouro-butler-rollback ouro-butler")
    const rollbackAudit = normalUpdateRunbook.indexOf('assert_update_source "$ROLLBACK_IMAGE_ID"')
    const rollbackStart = normalUpdateRunbook.indexOf("docker start ouro-butler", rollbackAudit)
    expect(rollbackStart).toBeGreaterThan(rollbackAudit)
    const productionBlock = normalUpdateRunbook.slice(normalUpdateRunbook.indexOf("Create and activate production from the same exact image ID"))
    const productionCreate = productionBlock.indexOf("&& docker create --pull=never --name ouro-butler ")
    const productionAudit = productionBlock.indexOf('&& audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"', productionCreate)
    const productionStart = productionBlock.indexOf("&& docker start ouro-butler", productionAudit)
    expect(productionCreate).toBeGreaterThan(-1)
    expect(productionStart).toBeGreaterThan(productionAudit)
    expect(normalUpdateRunbook).toContain("docker start ouro-butler")
    expect(runbook).toContain("set_butler_autostart production || return $?")
    expect(runbook).toContain('verify_butler_autostart "1 0 0 0" || return $?')
    const rollbackReady = normalUpdateRunbook.indexOf("wait_butler_ready ouro-butler", rollbackStart)
    const rollbackEnable = normalUpdateRunbook.indexOf("enable_butler_autostart", rollbackReady)
    expect(rollbackReady).toBeGreaterThan(rollbackStart)
    expect(rollbackEnable).toBeGreaterThan(rollbackReady)
    const productionReady = productionBlock.indexOf("wait_butler_ready ouro-butler", productionStart)
    const productionEnable = productionBlock.indexOf("enable_butler_autostart", productionReady)
    expect(productionReady).toBeGreaterThan(productionStart)
    expect(productionEnable).toBeGreaterThan(productionReady)
    expect(restoreRunbook).toContain("docker create --pull=never --name ouro-butler")
    expect(restoreRunbook).toContain('audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"')
    expect(restoreRunbook.indexOf("docker start ouro-butler")).toBeGreaterThan(restoreRunbook.indexOf('audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"'))
    expect(restoreRunbook.indexOf("wait_butler_ready ouro-butler")).toBeGreaterThan(restoreRunbook.indexOf("docker start ouro-butler"))
    expect(restoreRunbook.indexOf("enable_butler_autostart")).toBeGreaterThan(restoreRunbook.indexOf("wait_butler_ready ouro-butler"))
    expect(auditor).toContain("exec node /opt/ouro/dist/heart/daemon/container-spec-auditor-main.js")
    expect(agent.habitPaidTurnsPerDay).toBe(24)
    expect(meta).toMatchObject({ runtimeVersion: JSON.parse(fs.readFileSync("package.json", "utf8")).version, bundleSchemaVersion: 3 })
    expect(fs.existsSync("deploy/unraid/sanctuary.ouro/arc/README.md")).toBe(true)
    expect(fs.existsSync("deploy/unraid/sanctuary.ouro/tool-profiles.json")).toBe(true)
    expect(dockerfile).toContain("COPY deploy/unraid /opt/ouro/deploy/unraid")
  })

  it("requires exactly one matching managed Telegram process", () => {
    const telegram = "node /opt/ouro/dist/senses/telegram-entry.js --agent sanctuary"
    expect(hasManagedAgentProcess(telegram, "  ")).toBe(false)
    expect(hasManagedTelegramProcess(`node daemon-entry.js\n${telegram}\n`, "sanctuary")).toBe(true)
    expect(hasManagedTelegramProcess("node daemon-entry.js\n", "sanctuary")).toBe(false)
    expect(hasManagedTelegramProcess(`${telegram}\n${telegram}\n`, "sanctuary")).toBe(false)
    expect(hasManagedTelegramProcess("node /opt/ouro/dist/senses/telegram-entry.js --agent other\n", "sanctuary")).toBe(false)
    expect(hasManagedTelegramProcess(telegram, "   ")).toBe(false)
    expect(hasManagedTelegramProcess("node --agent sanctuary\n", "sanctuary")).toBe(false)
    expect(hasManagedTelegramProcess("node /opt/ouro/dist/senses/telegram-entry.js\n", "sanctuary")).toBe(false)
  })

  it("requires exactly one matching owned Supercronic child", () => {
    const scheduler = "/usr/local/bin/supercronic -split-logs -inotify /home/ouro/.ouro-cli/scheduler/sanctuary.crontab"
    expect(hasManagedSupercronicProcess(`node daemon-entry.js\n${scheduler}\n`, "sanctuary")).toBe(true)
    expect(hasManagedSupercronicProcess(`${scheduler}\n${scheduler}\n`, "sanctuary")).toBe(false)
    expect(hasManagedSupercronicProcess("/usr/local/bin/supercronic /tmp/other.crontab\n", "sanctuary")).toBe(false)
  })
})
