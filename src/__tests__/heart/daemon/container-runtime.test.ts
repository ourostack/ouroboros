import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { hasManagedAgentProcess, hasManagedSupercronicProcess, hasManagedTelegramProcess, readContainerRuntimePolicy } from "../../../heart/daemon/container-runtime"

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

  it("changes autostart only through bounded authenticated WebGUI requests", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-autostart-helper-"))
    const autostartFile = path.join(testRoot, "unraid-autostart")
    const csrfFile = path.join(testRoot, "var.ini")
    const callLog = path.join(testRoot, "calls.log")
    const bodyLog = path.join(testRoot, "bodies.log")
    const stubs = String.raw`
awk() {
  case "$*" in *'END { printf'*) command printf '%s' "$EXPECTED_COUNTS" ;; *) command awk "$@" ;; esac
}
curl() {
  command printf '%s\n' "$*" >>"$CALL_LOG"
  command cat >>"$BODY_LOG"
  command printf '\n' >>"$BODY_LOG"
  if [ "$FAIL_CURL" = yes ]; then return 23; fi
}
`
    try {
      fs.writeFileSync(autostartFile, "other 9\n", { mode: 0o644 })
      fs.writeFileSync(csrfFile, 'csrf_token="redacted-test-csrf"\n', { mode: 0o600 })
      for (const [name, expectedCounts, expectedAutos] of [
        ["disable_butler_autostart", "0 0 0 0", ["false", "false", "false", "false"]],
        ["enable_butler_autostart", "1 0 0 0", ["false", "false", "false", "true"]],
      ] as const) {
        fs.writeFileSync(callLog, "")
        fs.writeFileSync(bodyLog, "")
        const helpers = ["set_butler_autostart", "verify_butler_autostart", name]
          .map((helperName) => extractRunbookFunction(runbook, helperName))
          .join("\n")
          .replaceAll("/var/local/emhttp/var.ini", "$AUTOSTART_CSRF_FILE")
          .replaceAll("/var/lib/docker/unraid-autostart", "$AUTOSTART_TEST_FILE")
        const script = `set -u\n${stubs}\n${helpers}\n${name}`
        const result = runConditionalHelper(script, "unused", {
          AUTOSTART_CSRF_FILE: csrfFile,
          AUTOSTART_TEST_FILE: autostartFile,
          BODY_LOG: bodyLog,
          CALL_LOG: callLog,
          EXPECTED_COUNTS: expectedCounts,
          FAIL_CURL: "no",
        })
        expect(result.status, `${name}\n${result.stderr}`).toBe(0)
        expect(result.stdout).not.toContain("redacted-test-csrf")
        expect(result.stderr).not.toContain("redacted-test-csrf")
        const calls = fs.readFileSync(callLog, "utf8").trim().split("\n")
        expect(calls).toHaveLength(4)
        for (const call of calls) {
          expect(call).toContain("--request POST")
          expect(call).toContain("--connect-timeout 5")
          expect(call).toContain("--max-time 15")
          expect(call).toContain("--header Content-Type: application/x-www-form-urlencoded")
          expect(call).toContain("--data-binary @-")
          expect(call).toContain("http://127.0.0.1/plugins/dynamix.docker.manager/include/UpdateConfig.php")
          expect(call).not.toContain("redacted-test-csrf")
        }
        const bodies = fs.readFileSync(bodyLog, "utf8").trim().split("\n")
        expect(bodies).toEqual([
          `action=autostart&container=ouro-butler-staging&auto=${expectedAutos[0]}&wait=0&csrf_token=redacted-test-csrf`,
          `action=autostart&container=ouro-butler-rollback&auto=${expectedAutos[1]}&wait=0&csrf_token=redacted-test-csrf`,
          `action=autostart&container=ouro-butler-legacy-evidence&auto=${expectedAutos[2]}&wait=0&csrf_token=redacted-test-csrf`,
          `action=autostart&container=ouro-butler&auto=${expectedAutos[3]}&wait=0&csrf_token=redacted-test-csrf`,
        ])

        const failure = runConditionalHelper(script, "unused", {
          AUTOSTART_CSRF_FILE: csrfFile,
          AUTOSTART_TEST_FILE: autostartFile,
          BODY_LOG: bodyLog,
          CALL_LOG: callLog,
          EXPECTED_COUNTS: expectedCounts,
          FAIL_CURL: "yes",
        })
        expect(failure.status).toBe(23)
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("propagates effective-audit faults from a conditional function context", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-audit-helper-"))
    const helper = extractRunbookFunction(runbook, "audit_effective").replace("/mnt/user/appdata/ouro-butler/staging/inspect.XXXXXX", "$AUDIT_TEST_ROOT/inspect.XXXXXX")
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
${helper}
if audit_effective ouro-butler "$IMAGE_ID"; then command printf 'TRANSITION\n'; else STATUS=$?; set -- "$AUDIT_TEST_ROOT"/inspect.*; if [ -e "$1" ]; then command printf 'LEAK\n'; fi; command printf 'FAILED:%s\n' "$STATUS"; exit "$STATUS"; fi`
    try {
      for (const failKey of ["mktemp", "chmod-0700", "docker-inspect", "docker-image", "chmod-0600", "docker-run"]) {
        const result = runConditionalHelper(script, failKey, { AUDIT_TEST_ROOT: testRoot, IMAGE_ID: `sha256:${"a".repeat(64)}` })
        expect(result.status, `${failKey}\n${result.stderr}`).toBe(23)
        expect(result.stdout).not.toContain("TRANSITION")
        expect(result.stdout).not.toContain("LEAK")
        expect(fs.readdirSync(testRoot), `${failKey} leaked an inspect directory`).toEqual([])
      }
      const success = runConditionalHelper(script, "none", { AUDIT_TEST_ROOT: testRoot, IMAGE_ID: `sha256:${"a".repeat(64)}` })
      expect(success.status, success.stderr).toBe(0)
      expect(success.stdout).toContain("TRANSITION")
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
    "container ls --format")
      case "$SCENARIO" in staging-running) command printf 'ouro-butler\nouro-butler-staging\n' ;; production-stopped) : ;; *) command printf 'ouro-butler\n' ;; esac ;;
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

  it("rejects invalid restore inputs and topology before any mutation", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const imageValidator = extractRunbookFunction(runbook, "validate_exact_image_id")
    const onlyRunning = extractRunbookFunction(runbook, "assert_only_running_butler")
    const preflight = extractRunbookFunction(runbook, "assert_restore_preflight")
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-restore-preflight-"))
    const validRootPath = path.join(testRoot, "backup")
    fs.mkdirSync(path.join(validRootPath, "runtime", ".ouro-cli"), { recursive: true })
    fs.mkdirSync(path.join(validRootPath, "agent", "sanctuary.ouro"), { recursive: true })
    const validRoot = fs.realpathSync(validRootPath)
    const validImage = `sha256:${"b".repeat(64)}`
    const script = String.raw`set -u
SCENARIO=$1
docker() {
  case "$*" in
    "image inspect "*) return 0 ;;
    "container ls -a --format {{.Names}}") if [ "$SCENARIO" = staging ]; then command printf 'ouro-butler\nouro-butler-staging\n'; else command printf 'ouro-butler\n'; fi ;;
    "container ls --format {{.Names}}") if [ "$SCENARIO" = staging ]; then command printf 'ouro-butler\nouro-butler-staging\n'; else command printf 'ouro-butler\n'; fi ;;
    "inspect --format {{.State.Running}} "*) command printf 'true\n' ;;
    "inspect --format {{.Image}} "*) command printf '%s\n' "$VALID_IMAGE" ;;
    *) return 23 ;;
  esac
}
${imageValidator}
${onlyRunning}
validate_sanctuary_roots() { test "$SCENARIO" != invalid-roots; }
${preflight}
if assert_restore_preflight; then command printf 'MUTATION\n'; else exit $?; fi`
    try {
      const cases = [
        { scenario: "unset", env: {}, unset: true },
        { scenario: "relative", env: { BACKUP_ROOT: "relative", IMAGE_ID: validImage } },
        { scenario: "missing", env: { BACKUP_ROOT: path.join(testRoot, "missing"), IMAGE_ID: validImage } },
        { scenario: "bad-image", env: { BACKUP_ROOT: validRoot, IMAGE_ID: "latest" } },
        { scenario: "invalid-roots", env: { BACKUP_ROOT: validRoot, IMAGE_ID: validImage } },
        { scenario: "staging", env: { BACKUP_ROOT: validRoot, IMAGE_ID: validImage } },
      ]
      for (const testCase of cases) {
        const caseScript = testCase.unset ? `unset BACKUP_ROOT IMAGE_ID\n${script}` : script
        const result = runConditionalHelper(caseScript, testCase.scenario, { VALID_IMAGE: validImage, ...testCase.env })
        expect(result.status, `${testCase.scenario}\n${result.stderr}`).not.toBe(0)
        expect(result.stdout).not.toContain("MUTATION")
      }
      const success = runConditionalHelper(script, "safe", { VALID_IMAGE: validImage, BACKUP_ROOT: validRoot, IMAGE_ID: validImage })
      expect(success.status, success.stderr).toBe(0)
      expect(success.stdout).toContain("MUTATION")
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("preserves legacy evidence while promoting a fresh canonical staging poller", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const imageValidator = extractRunbookFunction(runbook, "validate_exact_image_id")
    const onlyRunning = extractRunbookFunction(runbook, "assert_only_running_butler")
    const validateLegacy = extractRunbookFunction(runbook, "validate_sanctuary_legacy_staging")
    const adoption = extractRunbookFunction(runbook, "install_from_legacy_staging").replaceAll("/mnt/user/appdata/ouro-butler", "$TEST_ROOT/appdata")
    const image = `sha256:${"c".repeat(64)}`
    const script = String.raw`set -u
SCENARIO=$1
docker() {
  command printf '%s\n' "$*" >>"$CALL_LOG"
  case "$*" in
    "container ls -a --format {{.Names}}")
      if [ "$SCENARIO" = extra ]; then command printf 'ouro-butler-staging\nouro-butler-rollback\n'
      else case "$(command cat "$STATE")" in
        legacy|legacy-stopped) command printf 'ouro-butler-staging\n' ;;
        evidence|fresh-stopped) command printf 'ouro-butler-legacy-evidence\n' ;;
        fresh-created|fresh-running) command printf 'ouro-butler-staging\nouro-butler-legacy-evidence\n' ;;
        prod-created|prod-running) command printf 'ouro-butler\nouro-butler-legacy-evidence\n' ;;
      esac; fi ;;
    "container ls --format {{.Names}}")
      if [ "$SCENARIO" = extra ]; then command printf 'ouro-butler-staging\nouro-butler-rollback\n'
      else case "$(command cat "$STATE")" in legacy|fresh-running) command printf 'ouro-butler-staging\n' ;; prod-running) command printf 'ouro-butler\n' ;; esac; fi ;;
    "inspect --format {{.Image}} "*) if [ "$SCENARIO" = mismatch ] && [ "$(command cat "$STATE")" = legacy ]; then command printf 'not-an-image\n'; elif [ "$4" = ouro-butler-legacy-evidence ]; then command printf '%s\n' "$LEGACY_IMAGE"; elif [ "$(command cat "$STATE")" = legacy ] || [ "$(command cat "$STATE")" = legacy-stopped ]; then command printf '%s\n' "$LEGACY_IMAGE"; else command printf '%s\n' "$TARGET_IMAGE"; fi ;;
    "inspect --format {{.Id}} ouro-butler-staging") command printf '%064d\n' 1 ;;
    "inspect --format {{.State.Running}} "*) case "$(command cat "$STATE")" in legacy|fresh-running|prod-running) command printf 'true\n' ;; *) command printf 'false\n' ;; esac ;;
    "image inspect "*) return 0 ;;
    "container inspect ouro-butler-staging") command printf '{}\n' ;;
    "stop "*) case "$(command cat "$STATE")" in legacy) command printf legacy-stopped >"$STATE" ;; fresh-running) command printf fresh-stopped >"$STATE" ;; esac ;;
    "rename "*" ouro-butler-legacy-evidence") command printf evidence >"$STATE" ;;
    "create --name ouro-butler-staging "*) command printf fresh-created >"$STATE" ;;
    "start ouro-butler-staging") command printf fresh-running >"$STATE" ;;
    "rm ouro-butler-staging") command printf evidence >"$STATE" ;;
    "create --name ouro-butler "*) command printf prod-created >"$STATE" ;;
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
        const result = runConditionalHelper(script, scenario, { CALL_LOG: callLog, STATE: state, TEST_ROOT: testRoot, LEGACY_IMAGE: image, TARGET_IMAGE: `sha256:${"e".repeat(64)}`, IMAGE_ID: `sha256:${"e".repeat(64)}` })
        expect(result.status, `${scenario}\n${result.stderr}`).not.toBe(0)
        expect(result.stdout).not.toContain("ADOPTED")
        expect(fs.readFileSync(callLog, "utf8")).not.toContain("rm ")
      }
      const callLog = path.join(testRoot, "legacy.log")
      const state = path.join(testRoot, "legacy.state")
      fs.writeFileSync(state, "legacy")
      const success = runConditionalHelper(script, "legacy", { CALL_LOG: callLog, STATE: state, TEST_ROOT: testRoot, LEGACY_IMAGE: image, TARGET_IMAGE: `sha256:${"e".repeat(64)}`, IMAGE_ID: `sha256:${"e".repeat(64)}` })
      expect(success.status, success.stderr).toBe(0)
      expect(success.stdout).toContain("ADOPTED")
      const calls = fs.readFileSync(callLog, "utf8")
      expect(calls).toContain(`stop ${"0".repeat(63)}1`)
      expect(calls).toContain(`rename ${"0".repeat(63)}1 ouro-butler-legacy-evidence`)
      expect(calls).toContain("create --name ouro-butler-staging")
      expect(calls).toContain("start ouro-butler-staging")
      expect(calls).toContain("rm ouro-butler-staging")
      expect(calls).toContain("create --name ouro-butler")
      expect(calls).toContain("start ouro-butler")
      expect(calls).not.toContain("rm ouro-butler-legacy-evidence")
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
    "inspect --format {{.Image}} ouro-butler-staging") command printf '%s\n' "$TARGET_IMAGE" ;;
    "image inspect "*) return 0 ;;
    *) return 0 ;;
  esac
}
validate_sanctuary_legacy_staging() { LEGACY_STAGING_CONTAINER_ID=$(command printf '%064d' 1); LEGACY_STAGING_IMAGE_ID=$TARGET_IMAGE; }
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
      const result = runConditionalHelper(script, "bootstrap-failure", { CALL_LOG: callLog, TARGET_IMAGE: image, IMAGE_ID: image })
      expect(result.status, result.stderr).toBe(23)
      const calls = fs.readFileSync(callLog, "utf8")
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
${validateLegacy}
${install}
install_from_legacy_staging`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-adoption-post-check-replacement-"))
    try {
      const callLog = path.join(testRoot, "calls.log")
      const result = runConditionalHelper(script, "replacement", {
        CALL_LOG: callLog, REPLACED: path.join(testRoot, "replaced"), TEST_ROOT: testRoot,
        IMAGE_ID: targetImage, LEGACY_IMAGE: legacyImage, ORIGINAL_ID: originalId, REPLACEMENT_ID: replacementId,
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
      })
      expect(result.status, result.stderr).toBe(23)
      expect(fs.readFileSync(callLog, "utf8").trim().split("\n")).toEqual([
        "prepare", "verify", "prepare", "verify", "MUTATION:disable-autostart",
      ])
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("validates complete private restore roots before mutation and after copying", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const validator = extractRunbookFunction(runbook, "validate_sanctuary_roots")
    const preflightHelper = extractRunbookFunction(runbook, "assert_restore_preflight")
    const restore = runbook.slice(runbook.indexOf("Restore:"), runbook.indexOf("Credential recovery:"))
    expect(validator).toContain("agent.json bundle-meta.json provider-readiness.json tool-profiles.json")
    expect(validator).toContain("vault-unlock")
    expect(validator).toContain("-type l")
    expect(validator).toContain("! -user 10001")
    expect(validator).toContain("! -perm 0700")
    expect(validator).toContain("! -perm 0600")
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

    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-restore-roots-validator-"))
    const runtimeRoot = path.join(testRoot, "runtime", ".ouro-cli")
    const agentRoot = path.join(testRoot, "agent", "sanctuary.ouro")
    const buildValidRoots = () => {
      fs.rmSync(testRoot, { recursive: true, force: true })
      for (const directory of [runtimeRoot, path.join(runtimeRoot, "vault-unlock"), agentRoot, path.join(agentRoot, "psyche"), path.join(agentRoot, "habits")]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        fs.chmodSync(directory, 0o700)
      }
      for (const relative of ["agent.json", "bundle-meta.json", "provider-readiness.json", "tool-profiles.json", "psyche/SOUL.md", "habits/sanctuary-health.md"]) {
        const file = path.join(agentRoot, relative)
        fs.writeFileSync(file, "x", { mode: 0o600 })
        fs.chmodSync(file, 0o600)
      }
      fs.writeFileSync(path.join(runtimeRoot, "vault-unlock", "one.secret"), "secret", { mode: 0o600 })
    }
    const script = String.raw`set -u
find() { case "$*" in *"! -user 10001"*) return 0 ;; *) command find "$@" ;; esac; }
${validator}
validate_sanctuary_roots "$RUNTIME_ROOT" "$AGENT_ROOT"`
    try {
      const run = () => runConditionalHelper(script, "validate", { RUNTIME_ROOT: runtimeRoot, AGENT_ROOT: agentRoot })
      buildValidRoots()
      expect(run().status).toBe(0)
      for (const mutate of [
        () => fs.writeFileSync(path.join(agentRoot, "agent.json"), ""),
        () => fs.symlinkSync("agent.json", path.join(agentRoot, "link")),
        () => fs.chmodSync(path.join(agentRoot, "psyche"), 0o755),
        () => fs.chmodSync(path.join(agentRoot, "agent.json"), 0o644),
        () => fs.writeFileSync(path.join(runtimeRoot, "container-credentials.json"), "{}", { mode: 0o600 }),
        () => fs.writeFileSync(path.join(runtimeRoot, "vault-unlock", "one.secret"), ""),
      ]) {
        buildValidRoots()
        mutate()
        expect(run().status).not.toBe(0)
      }
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
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
  })

  it("ships a complete exact-image host launcher for every Unit 16 harness command", () => {
    const launcherPath = "deploy/unraid/sanctuary-unit16-run.sh"
    expect(fs.existsSync(launcherPath)).toBe(true)
    const launcher = fs.readFileSync(launcherPath, "utf8")
    const contract = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary-acceptance-contract.json", "utf8")) as {
      commands: Record<string, unknown>
    }
    expect(spawnSync("/bin/sh", ["-n", launcherPath]).status).toBe(0)
    expect(launcher).toContain("TIME_LIMIT=900")
    expect(launcher).toContain("TIME_LIMIT=4950")
    expect(launcher).toContain("TIME_LIMIT=780")
    expect(launcher).toContain('--pull=never --network "$NETWORK"')
    expect(launcher).toContain("--user 10001:10001 --read-only")
    expect(launcher).toContain("--cap-drop ALL --security-opt no-new-privileges")
    expect(launcher).toContain("type=bind,src=$CONFIG_PATH,dst=/run/ouro-acceptance/config.json,readonly")
    expect(launcher).toContain("type=bind,src=$EVIDENCE_ROOT,dst=/evidence")
    expect(launcher).toContain("type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly")
    expect(launcher).toContain("type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly")
    expect(launcher).toContain("/opt/ouro/deploy/unraid/sanctuary-acceptance-harness.sh")
    expect(launcher).toContain('"$COMMAND" --config /run/ouro-acceptance/config.json')
    expect(launcher).toContain('3<&3')
    expect(launcher).toContain('MODE=${1:-}')
    expect(launcher).toContain('if test "$MODE" = materialize; then')
    expect(launcher).toContain('dst=/run/ouro-acceptance/closed-inventory.json,readonly')
    expect(launcher).toContain('dst=/run/ouro-host-acceptance,readonly')
    expect(launcher).toContain('dst=/run/ouro-acceptance/image-digest,readonly')
    expect(launcher).toContain('dst=/run/ouro-acceptance/container-digest,readonly')
    expect(launcher).toContain('dst=/run/ouro-acceptance/postboot-health.json,readonly')
    expect(launcher).toContain('dst=/run/ouro-acceptance/container-inspect.json,readonly')
    expect(launcher).toContain('evidence-snapshot) TIME_LIMIT=4950; NETWORK=host; INPUT=no; BUNDLE_MODE=readonly; BROKER=yes')
    expect(launcher).toContain('\nstart_broker\nEXPECTED_CONFIG=')
    expect(launcher).toContain('dst=/run/ouro-acceptance/boot-id,readonly')
    expect(launcher).toContain('/usr/bin/docker stop --time 30 "$EXPECTED_CONTAINER_ID"')
    expect(launcher).toContain("--format '{{.State.Pid}}'")
    expect(launcher).toContain('PRODUCTION_STOPPED=yes')
    expect(launcher).toContain('dst=/run/ouro-acceptance/telegram-poller-count.json,readonly')
    expect(launcher).toContain("'{\"activePollers\":0,\"productionContainerStopped\":true}'")
    expect(launcher).toContain('restore_production_container')
    expect(launcher).toContain('/usr/bin/docker start "$EXPECTED_CONTAINER_ID"')
    expect(launcher).toContain('test "$RESTORE_RUNNING" = true && test "$RESTORE_HEALTH" = healthy')
    expect(launcher).not.toMatch(/autostart.*(?:write|install|rm|mv)/iu)
    expect(launcher.match(/exec 3<&0; exec \/opt\/ouro\/deploy\/unraid\/sanctuary-acceptance-harness\.sh/g)).toHaveLength(2)
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
    expect(runbook).toContain("IFS= read -r -s UNIT16_BOT_TOKEN")
    expect(runbook).toContain("3< <(printf '%s\\n' \"$UNIT16_BOT_TOKEN\")")
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
    const audit = update.indexOf('audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"')
    const firstDockerRun = update.indexOf("docker run --rm")
    expect(topology).toBeGreaterThan(-1)
    expect(audit).toBeGreaterThan(topology)
    expect(firstDockerRun).toBeGreaterThan(topology)
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
    const activation = production.slice(production.indexOf("if docker create --name ouro-butler "))

    expect(activation).toContain("if docker create --name ouro-butler --network host --restart unless-stopped --user 10001:10001 \\")
    expect(activation).toContain('&& audit_effective ouro-butler "$IMAGE_ID" \\')
    expect(activation).toContain("&& docker start ouro-butler \\")
    expect(activation).toContain("&& wait_butler_ready ouro-butler \\")
    expect(activation).toContain("&& enable_butler_autostart; then")
    expect(activation).toContain("PRODUCTION_ACTIVATION_STATUS=$?")
    const inspectPartial = activation.indexOf("if docker container inspect ouro-butler >/dev/null 2>&1; then")
    const failedStop = activation.indexOf("docker stop ouro-butler >/dev/null 2>&1 || true", inspectPartial)
    const failedRemove = activation.indexOf("docker rm --force ouro-butler", failedStop)
    const verifyAbsent = activation.indexOf("! docker container inspect ouro-butler >/dev/null 2>&1", failedRemove)
    expect(activation).not.toMatch(/(?:^|\n)\s+ROLLBACK_IMAGE_ID=\$\(docker inspect --format '\{\{\.Image\}\}' ouro-butler-rollback\)/u)
    const currentImage = activation.indexOf("CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback)", verifyAbsent)
    const exactImage = activation.indexOf('test "$CURRENT_ROLLBACK_IMAGE_ID" = "$ROLLBACK_IMAGE_ID"', currentImage)
    const rename = activation.indexOf("docker rename ouro-butler-rollback ouro-butler", exactImage)
    const audit = activation.indexOf('audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"', rename)
    const restart = activation.indexOf("docker start ouro-butler", audit)
    const ready = activation.indexOf("wait_butler_ready ouro-butler", restart)
    const autostart = activation.indexOf("enable_butler_autostart", ready)
    const propagate = activation.indexOf('(exit "$PRODUCTION_ACTIVATION_STATUS")', autostart)
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
    expect(propagate).toBeGreaterThan(autostart)
  })

  it("contains every post-rename staging failure and restores exact production", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const update = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("Backup:"))
    const rename = update.indexOf("docker rename ouro-butler ouro-butler-rollback")
    const staging = update.slice(rename, update.indexOf("Create and activate production from the same exact image ID"))

    const oldImage = update.indexOf("ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)")
    const validateOldImage = update.indexOf('validate_exact_image_id "$ROLLBACK_IMAGE_ID"', oldImage)
    const create = staging.indexOf("if docker create --name ouro-butler-staging")
    const audit = staging.indexOf('&& audit_effective ouro-butler-staging "$IMAGE_ID"', create)
    const start = staging.indexOf("&& docker start ouro-butler-staging", audit)
    const ready = staging.indexOf("&& wait_butler_ready ouro-butler-staging", start)
    const stopPassing = staging.indexOf("&& docker stop ouro-butler-staging", ready)
    const removePassing = staging.indexOf("&& docker rm ouro-butler-staging; then", stopPassing)
    const failureArm = staging.indexOf("else", removePassing)
    const status = staging.indexOf("STAGING_ACTIVATION_STATUS=$?", failureArm)
    const inspectPartial = staging.indexOf("if docker container inspect ouro-butler-staging >/dev/null 2>&1; then", status)
    const stopPartial = staging.indexOf("docker stop ouro-butler-staging >/dev/null 2>&1 || true", inspectPartial)
    const removePartial = staging.indexOf("docker rm --force ouro-butler-staging", stopPartial)
    const verifyAbsent = staging.indexOf("! docker container inspect ouro-butler-staging >/dev/null 2>&1", removePartial)
    const currentRollbackImage = staging.indexOf("CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback)", verifyAbsent)
    const exactRollbackImage = staging.indexOf('test "$CURRENT_ROLLBACK_IMAGE_ID" = "$ROLLBACK_IMAGE_ID"', currentRollbackImage)
    const renameRollback = staging.indexOf("docker rename ouro-butler-rollback ouro-butler", exactRollbackImage)
    const auditRollback = staging.indexOf('audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"', renameRollback)
    const startRollback = staging.indexOf("docker start ouro-butler", auditRollback)
    const readyRollback = staging.indexOf("wait_butler_ready ouro-butler", startRollback)
    const autostart = staging.indexOf("enable_butler_autostart", readyRollback)
    const propagate = staging.indexOf('(exit "$STAGING_ACTIVATION_STATUS")', autostart)

    expect(oldImage).toBeGreaterThan(-1)
    expect(validateOldImage).toBeGreaterThan(oldImage)
    expect(rename).toBeGreaterThan(validateOldImage)
    expect(create).toBeGreaterThan(-1)
    expect(audit).toBeGreaterThan(create)
    expect(start).toBeGreaterThan(audit)
    expect(ready).toBeGreaterThan(start)
    expect(stopPassing).toBeGreaterThan(ready)
    expect(removePassing).toBeGreaterThan(stopPassing)
    expect(failureArm).toBeGreaterThan(removePassing)
    expect(status).toBeGreaterThan(failureArm)
    expect(inspectPartial).toBeGreaterThan(status)
    expect(stopPartial).toBeGreaterThan(inspectPartial)
    expect(removePartial).toBeGreaterThan(stopPartial)
    expect(verifyAbsent).toBeGreaterThan(removePartial)
    expect(currentRollbackImage).toBeGreaterThan(verifyAbsent)
    expect(exactRollbackImage).toBeGreaterThan(currentRollbackImage)
    expect(renameRollback).toBeGreaterThan(exactRollbackImage)
    expect(auditRollback).toBeGreaterThan(renameRollback)
    expect(startRollback).toBeGreaterThan(auditRollback)
    expect(readyRollback).toBeGreaterThan(startRollback)
    expect(autostart).toBeGreaterThan(readyRollback)
    expect(propagate).toBeGreaterThan(autostart)
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
    const stopped = update.indexOf("&& test \"$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)\" = false; then", rename)
    const status = update.indexOf("PRODUCTION_PREPARATION_STATUS=$?", stopped)
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
    expect(status).toBeGreaterThan(stopped)
    expect(recoverProduction).toBeGreaterThan(status)
    expect(recoverRollback).toBeGreaterThan(recoverProduction)
    expect(propagate).toBeGreaterThan(recoverRollback)
    for (const recovery of [namedProductionRecovery, renamedRollbackRecovery]) {
      const audit = recovery.indexOf('audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"')
      const start = recovery.indexOf("docker start ouro-butler", audit)
      const ready = recovery.indexOf("wait_butler_ready ouro-butler", start)
      const autostart = recovery.indexOf("enable_butler_autostart", ready)
      expect(audit).toBeGreaterThan(-1)
      expect(start).toBeGreaterThan(audit)
      expect(ready).toBeGreaterThan(start)
      expect(autostart).toBeGreaterThan(ready)
    }
  })

  it("contains failed restore activation explicitly while leaving autostart disabled", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const restore = runbook.slice(runbook.indexOf("Restore:"), runbook.indexOf("Credential recovery:"))

    const disableGuard = restore.indexOf("if disable_butler_autostart; then")
    const disableStatus = restore.indexOf("RESTORE_AUTOSTART_DISABLE_STATUS=$?", disableGuard)
    const disablePropagate = restore.indexOf('(exit "$RESTORE_AUTOSTART_DISABLE_STATUS")', disableStatus)
    const stopOld = restore.indexOf("if { docker stop ouro-butler >/dev/null 2>&1 || true; } \\", disableGuard)
    const restoreRuntime = restore.indexOf('&& rsync -a --delete "$BACKUP_ROOT/runtime/.ouro-cli/"', stopOld)
    const restoreBundle = restore.indexOf('&& rsync -a --delete "$BACKUP_ROOT/agent/sanctuary.ouro/"', restoreRuntime)
    const create = restore.indexOf("&& docker create --name ouro-butler --network host --restart unless-stopped --user 10001:10001 \\", restoreBundle)
    expect(disableGuard).toBeGreaterThan(-1)
    expect(disableStatus).toBeGreaterThan(disableGuard)
    expect(disablePropagate).toBeGreaterThan(disableStatus)
    expect(stopOld).toBeGreaterThan(disableGuard)
    expect(restoreRuntime).toBeGreaterThan(stopOld)
    expect(restoreBundle).toBeGreaterThan(restoreRuntime)
    expect(create).toBeGreaterThan(restoreBundle)
    expect(restore).toContain('&& audit_effective ouro-butler "$IMAGE_ID" \\')
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
    expect(template).toContain('Default="/mnt/user/appdata/sabnzbd/sabnzbd.ini" Mode="ro"')
    expect(runbook).toContain("Mendelow Cloud Butler operator runbook")
    expect(runbook).toContain("/mnt/user/appdata/ouro-butler/runtime/.ouro-cli")
    expect(runbook).toContain("/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro")
    expect(runbook).toContain("docker image inspect --format '{{.Id}}'")
    expect(runbook).toContain("docker image inspect \"$IMAGE_ID\"")
    expect(runbook).toContain("staged template")
    expect(runbook).toContain("writes every credential class into the unlocked Sanctuary vault before deleting the claimed envelope")
    expect(runbook).toContain("container-credentials.json.consuming")
    expect(runbook).toContain("byte-for-byte identical")
    expect(runbook).toContain("redundant unclaimed source")
    expect(runbook).toContain("human-required")
    expect(runbook).toContain("securely compare and quarantine")
    expect(runbook).toContain("Never print either envelope's contents")
    expect(runbook).not.toContain("repository digest")
    expect(runbook).toContain("docker run --rm --pull=never --network=none \\")
    expect(runbook).toContain("--entrypoint /opt/ouro/deploy/unraid/audit-container-spec.sh \\")
    expect(runbook).toContain('--mount "type=bind,src=$STAGED_TEMPLATE,dst=/audit/sanctuary.xml,readonly" \\')
    expect(runbook).toContain('--mount "type=bind,src=$STAGED_RUNTIME_POLICY,dst=/audit/container-runtime.json,readonly" \\')
    expect(runbook).toContain('"$IMAGE_ID" --template /audit/sanctuary.xml --runtime-policy /audit/container-runtime.json --expected-image "$IMAGE_ID"')
    const updateRunbook = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("Backup:"))
    expect(runbook).toContain("AUTOSTART_FILE=/var/lib/docker/unraid-autostart")
    expect(runbook).toContain("/plugins/dynamix.docker.manager/include/UpdateConfig.php")
    expect(runbook).toContain("--connect-timeout 5")
    expect(runbook).toContain("--max-time 15")
    expect(runbook).toContain("--data-binary @-")
    expect(runbook).not.toContain('mv -f -- "$AUTOSTART_TMP" "$AUTOSTART_FILE"')
    expect(runbook).toContain('verify_butler_autostart "0 0 0 0" || return $?')
    expect(runbook).toContain('verify_butler_autostart "1 0 0 0" || return $?')
    expect(updateRunbook).toContain('docker create --name ouro-butler-staging --network host --restart unless-stopped --user 10001:10001 \\')
    expect(updateRunbook).toContain('--mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \\')
    expect(updateRunbook).toContain('--mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \\')
    const createCount = runbook.match(/docker create --name ouro-butler(?:-staging)?/gu)?.length ?? 0
    expect(runbook.match(/--mount "type=bind,src=\/boot\/config\/custom\/ouro-events\/spool,dst=\/run\/ouro-events,readonly"/gu)).toHaveLength(createCount)
    expect(runbook.match(/--mount "type=bind,src=\/mnt\/user\/appdata\/sabnzbd\/sabnzbd\.ini,dst=\/run\/sanctuary\/sabnzbd\.ini,readonly"/gu)).toHaveLength(createCount)
    expect(updateRunbook).toContain('"$IMAGE_ID"')
    expect(runbook).toContain('docker inspect "$AUDIT_CONTAINER" >"$INSPECT_DIR/container.json"')
    expect(runbook).toContain('docker image inspect "$AUDIT_EXPECTED_IMAGE" >"$INSPECT_DIR/image.json"')
    expect(runbook).toContain("--inspect /audit/container.json --image-inspect /audit/image.json")
    expect(runbook).toContain("rm -f -- \"$INSPECT_DIR/container.json\" \"$INSPECT_DIR/image.json\"")
    expect(runbook).toContain("rmdir -- \"$INSPECT_DIR\"")
    const stopProduction = updateRunbook.indexOf("docker stop ouro-butler")
    const disableAutostart = updateRunbook.indexOf("disable_butler_autostart")
    const renameRollback = updateRunbook.indexOf("docker rename ouro-butler ouro-butler-rollback")
    const createStaging = updateRunbook.indexOf("docker create --name ouro-butler-staging")
    const auditStaging = updateRunbook.indexOf('audit_effective ouro-butler-staging "$IMAGE_ID"')
    const startStaging = updateRunbook.indexOf("docker start ouro-butler-staging")
    expect(disableAutostart).toBeGreaterThan(-1)
    expect(stopProduction).toBeGreaterThan(disableAutostart)
    expect(stopProduction).toBeGreaterThan(-1)
    expect(renameRollback).toBeGreaterThan(stopProduction)
    expect(createStaging).toBeGreaterThan(renameRollback)
    expect(auditStaging).toBeGreaterThan(createStaging)
    expect(startStaging).toBeGreaterThan(auditStaging)
    expect(updateRunbook.indexOf("wait_butler_ready ouro-butler-staging")).toBeGreaterThan(startStaging)
    expect(updateRunbook).toContain("At no point may production and staging run together against the same Telegram token")
    expect(updateRunbook).toContain("docker rename ouro-butler-rollback ouro-butler")
    const rollbackAudit = updateRunbook.indexOf('audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"')
    const rollbackStart = updateRunbook.indexOf("docker start ouro-butler", rollbackAudit)
    expect(rollbackStart).toBeGreaterThan(rollbackAudit)
    const productionBlock = updateRunbook.slice(updateRunbook.indexOf("Create and activate production from the same exact image ID"))
    const productionCreate = productionBlock.indexOf("if docker create --name ouro-butler ")
    const productionAudit = productionBlock.indexOf('&& audit_effective ouro-butler "$IMAGE_ID"', productionCreate)
    const productionStart = productionBlock.indexOf("&& docker start ouro-butler", productionAudit)
    expect(productionCreate).toBeGreaterThan(-1)
    expect(productionStart).toBeGreaterThan(productionAudit)
    expect(updateRunbook).toContain("docker start ouro-butler")
    expect(runbook).toContain("set_butler_autostart ouro-butler true || return $?")
    expect(runbook).toContain('verify_butler_autostart "1 0 0 0" || return $?')
    const rollbackReady = updateRunbook.indexOf("wait_butler_ready ouro-butler", rollbackStart)
    const rollbackEnable = updateRunbook.indexOf("enable_butler_autostart", rollbackReady)
    expect(rollbackReady).toBeGreaterThan(rollbackStart)
    expect(rollbackEnable).toBeGreaterThan(rollbackReady)
    const productionReady = productionBlock.indexOf("wait_butler_ready ouro-butler", productionStart)
    const productionEnable = productionBlock.indexOf("enable_butler_autostart", productionReady)
    expect(productionReady).toBeGreaterThan(productionStart)
    expect(productionEnable).toBeGreaterThan(productionReady)
    const restoreRunbook = runbook.slice(runbook.indexOf("Restore:"), runbook.indexOf("Credential recovery:"))
    expect(restoreRunbook).toContain("docker create --name ouro-butler")
    expect(restoreRunbook).toContain('audit_effective ouro-butler "$IMAGE_ID"')
    expect(restoreRunbook.indexOf("docker start ouro-butler")).toBeGreaterThan(restoreRunbook.indexOf('audit_effective ouro-butler "$IMAGE_ID"'))
    expect(restoreRunbook.indexOf("wait_butler_ready ouro-butler")).toBeGreaterThan(restoreRunbook.indexOf("docker start ouro-butler"))
    expect(restoreRunbook.indexOf("enable_butler_autostart")).toBeGreaterThan(restoreRunbook.indexOf("wait_butler_ready ouro-butler"))
    expect(auditor).toContain("exec node /opt/ouro/dist/heart/daemon/container-spec-auditor-main.js")
    expect(agent.habitPaidTurnsPerDay).toBe(24)
    expect(meta).toMatchObject({ runtimeVersion: "0.1.0-alpha.735", bundleSchemaVersion: 3 })
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
