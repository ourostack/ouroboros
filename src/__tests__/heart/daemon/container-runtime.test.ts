import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { hasManagedSupercronicProcess, hasManagedTelegramProcess, readContainerRuntimePolicy } from "../../../heart/daemon/container-runtime"

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
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as { files: string[] }

    expect(packageJson.files).toContain("deploy/unraid/")
    expect(packageJson.files).toContain("npm-shrinkwrap.json")
    expect(fs.existsSync("npm-shrinkwrap.json")).toBe(true)
    expect(dockerfile).toContain("COPY package.json npm-shrinkwrap.json ./")
    expect(dockerfile).toContain("npm ci --omit=dev")
    expect(dockerfile).not.toContain("npm install")
  })

  it("keeps Workbench out and ships the Supercronic-owned health habit", () => {
    const agent = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/agent.json", "utf8")) as { senses: Record<string, unknown> }
    expect(agent.senses).not.toHaveProperty("workbench")
    const habit = fs.readFileSync("deploy/unraid/sanctuary.ouro/habits/sanctuary-health.md", "utf8")
    expect(habit).toContain("cadence: 15m")
    expect(habit).toContain("status: active")
  })

  it("ships Sanctuary on the locked GLM provider instead of MiniMax", () => {
    const agent = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/agent.json", "utf8")) as {
      humanFacing: { provider: string; model: string }
      agentFacing: { provider: string; model: string }
    }

    expect(agent.humanFacing).toEqual({ provider: "openai-compatible", model: "glm-5.2" })
    expect(agent.agentFacing).toEqual({ provider: "openai-compatible", model: "glm-5.2" })
    const readiness = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/provider-readiness.json", "utf8"))
    expect(readiness).toEqual({
      version: 1,
      selectionPolicy: "explicit-same-lane-only",
      providers: [
        {
          provider: "openai-compatible",
          model: "glm-5.2",
          vaultItem: "providers/openai-compatible",
          baseUrl: "https://api.z.ai/api/paas/v4/",
        },
        {
          provider: "openai-compatible-gemini",
          model: "gemini-3.6-flash",
          vaultItem: "providers/openai-compatible-gemini",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
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
    "inspect --format {{.State.Running}} "*) case "$(command cat "$STATE")" in legacy|fresh-running|prod-running) command printf 'true\n' ;; *) command printf 'false\n' ;; esac ;;
    "image inspect "*) return 0 ;;
    "container inspect ouro-butler-staging") command printf '{}\n' ;;
    "stop ouro-butler-staging") case "$(command cat "$STATE")" in legacy) command printf legacy-stopped >"$STATE" ;; fresh-running) command printf fresh-stopped >"$STATE" ;; esac ;;
    "rename ouro-butler-staging ouro-butler-legacy-evidence") command printf evidence >"$STATE" ;;
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
${imageValidator}
${onlyRunning}
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
      expect(calls).toContain("stop ouro-butler-staging")
      expect(calls).toContain("rename ouro-butler-staging ouro-butler-legacy-evidence")
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
    const prepare = adoption.indexOf('prepare_canonical_sanctuary_roots "$IMAGE_ID"')
    const bootstrap = adoption.indexOf('bootstrap_sanctuary_vault "$IMAGE_ID" /mnt/user/appdata/ouro-butler/runtime/container-credentials.json', prepare)
    const stopLegacy = adoption.indexOf("docker stop ouro-butler-staging", bootstrap)

    expect(prepare).toBeGreaterThan(-1)
    expect(bootstrap).toBeGreaterThan(prepare)
    expect(stopLegacy).toBeGreaterThan(bootstrap)

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
prepare_canonical_sanctuary_roots() { command printf 'prepare %s\n' "$1" >>"$CALL_LOG"; }
bootstrap_sanctuary_vault() { command printf 'bootstrap %s\n' "$1" >>"$CALL_LOG"; return 23; }
validate_exact_image_id() { return 0; }
assert_only_running_butler() { return 0; }
${adoption}
install_from_legacy_staging`
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
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("branches vault bootstrap through same-image canonical interactive containers", () => {
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
      elif [ "$SCENARIO" = available ] || [ "$SCENARIO" = import-failure ]; then command printf 'vault locator: agent.json\nlocal unlock: available\n'
      else command printf 'vault locator: agent.json\nlocal unlock: missing\n'; fi ;;
    *"loadContainerCredentialBootstrap"*)
      if [ "$SCENARIO" = import-failure ]; then command mv "$CANONICAL_SOURCE" "$CANONICAL_SOURCE.consuming"; return 23; fi
      command rm -f "$CANONICAL_SOURCE" "$CANONICAL_SOURCE.consuming" ;;
    *"ouro-entry.js vault create --agent sanctuary --store plaintext-file"|*"ouro-entry.js vault unlock --agent sanctuary --store plaintext-file"|*"ouro-entry.js check --agent sanctuary --lane outward"*) return 0 ;;
    *) return 23 ;;
  esac
}
${imageValidator}
validate_sanctuary_roots() { return 0; }
${helper}
if [ "$SCENARIO" = available ] || [ "$SCENARIO" = import-failure ]; then
  bootstrap_sanctuary_vault "$IMAGE_ID" "$LEGACY_SOURCE"
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
          const providerCall = calls.indexOf("ouro-entry.js check --agent sanctuary --lane outward")
          expect(importCall).toBeGreaterThan(-1)
          expect(providerCall).toBeGreaterThan(importCall)
          expect(fs.existsSync(legacySource)).toBe(true)
          expect(fs.existsSync(canonicalSource)).toBe(false)
          expect(fs.existsSync(`${canonicalSource}.consuming`)).toBe(false)
          expect(calls).toContain("ouro-entry.js check --agent sanctuary --lane outward")
          expect(calls).toContain("ouro-entry.js check --agent sanctuary --lane inner")
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
        expect(calls).toContain("ouro-entry.js check --agent sanctuary --lane outward")
        expect(calls).toContain("ouro-entry.js check --agent sanctuary --lane inner")
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

  it("requires fresh structured ready records for both configured provider lanes", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const helper = extractRunbookFunction(runbook, "bootstrap_sanctuary_vault")
    expect(helper).toContain("ouro-entry.js check --agent sanctuary --lane outward")
    expect(helper).toContain("ouro-entry.js check --agent sanctuary --lane inner")
    expect(helper).toContain("state/providers/readiness.json")
    expect(helper).toContain("umask 077")
    expect(helper).toContain('validate_sanctuary_roots "$BOOTSTRAP_RUNTIME_ROOT" "$BOOTSTRAP_AGENT_ROOT"')
    expect(helper).toContain('entry.status !== \\"ready\\"')
    expect(helper).toContain("entry.provider !== binding.provider")
    expect(helper).toContain("entry.model !== binding.model")
    expect(helper).not.toContain("ouro-entry.js auth verify --agent sanctuary")

    const match = helper.match(/node -e "\n([\s\S]*?)\n\s+" "\$READINESS_STARTED_AT"/u)
    expect(match).not.toBeNull()
    const validator = match![1]!.replaceAll('\\"', '"')
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-readiness-validator-"))
    const agentPath = path.join(testRoot, "agent.json")
    const readinessPath = path.join(testRoot, "readiness.json")
    const startedAt = "2026-08-20T12:00:00.000Z"
    fs.writeFileSync(agentPath, JSON.stringify({
      humanFacing: { provider: "openai-compatible", model: "glm-5.2" },
      agentFacing: { provider: "openai-compatible", model: "glm-5.2" },
    }))
    const ready = (status = "ready", checkedAt = "2026-08-20T12:00:01.000Z") => ({
      schemaVersion: 1,
      lanes: Object.fromEntries(["outward", "inner"].map((lane) => [lane, {
        agentName: "sanctuary", lane, provider: "openai-compatible", model: "glm-5.2",
        credentialRevision: "sha256:revision", status, checkedAt,
      }])),
    })
    try {
      for (const [name, payload, expected] of [
        ["ready", ready(), 0],
        ["failed", ready("failed"), 1],
        ["stale", ready("ready", "2026-08-20T11:59:59.000Z"), 1],
        ["missing", { schemaVersion: 1, lanes: { outward: ready().lanes.outward } }, 1],
        ["mismatch", { ...ready(), lanes: { ...ready().lanes, inner: { ...ready().lanes.inner, provider: "openai-compatible-gemini" } } }, 1],
      ] as const) {
        fs.writeFileSync(readinessPath, JSON.stringify(payload))
        const result = spawnSync(process.execPath, ["-e", validator, startedAt, agentPath, readinessPath], { encoding: "utf8" })
        expect(result.status, `${name}\n${result.stderr}`).toBe(expected)
      }
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

  it("revokes the exact compromised key set after unambiguous vault-backed verification", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const helper = extractRunbookFunction(runbook, "retire_legacy_unraid_key")
    const script = String.raw`set -u
SCENARIO=$1
verify_vault_backed_unraid_key() {
  command printf 'verify %s %s\n' "$1" "$2" >>"$CALL_LOG"
  test "$SCENARIO" != verify-failure || return 23
}
inventory_unraid_key_ids() {
  command printf 'inventory\n' >>"$CALL_LOG"
  if command grep -q '^revoke ' "$CALL_LOG"; then
    command printf '%s\tread-only\tnone\n%s\tbounded-write\tnone\n' "$READ_ID" "$WRITE_ID"
  elif [ "$SCENARIO" = duplicate ]; then
    command printf '%s\tread-only\tnone\n%s\tread-only\tnone\n%s\tbounded-write\tnone\n%s\tread-only\tnone\n%s\tbounded-write\tnone\n' "$READ_ID" "$READ_ID" "$WRITE_ID" "$OLD_READ_ID" "$OLD_WRITE_ID"
  elif [ "$SCENARIO" = unknown-class ]; then
    command printf '%s\tread-only\tnone\n%s\tbounded-write\tnone\n%s\tread-only\tnone\n%s\tbounded-write\tnone\nrogue\tadmin-write\tnone\n' "$READ_ID" "$WRITE_ID" "$OLD_READ_ID" "$OLD_WRITE_ID"
  elif [ "$SCENARIO" = unexpected-role ]; then
    command printf '%s\tread-only\tnone\n%s\tbounded-write\tnone\n%s\tread-only\tnone\n%s\tbounded-write\tnone\nrogue\tread-only\tadmin\n' "$READ_ID" "$WRITE_ID" "$OLD_READ_ID" "$OLD_WRITE_ID"
  else
    command printf '%s\tread-only\tnone\n%s\tbounded-write\tnone\n%s\tread-only\tnone\n%s\tbounded-write\tnone\n' "$READ_ID" "$WRITE_ID" "$OLD_READ_ID" "$OLD_WRITE_ID"
  fi
}
revoke_unraid_key_exact() { command printf 'revoke %s\n' "$1" >>"$CALL_LOG"; }
verify_revoked_unraid_key_rejected() { command printf 'rejected %s\n' "$1" >>"$CALL_LOG"; }
${helper}
retire_legacy_unraid_key "$READ_ID" "$WRITE_ID" "$OLD_READ_ID" "$OLD_WRITE_ID"`
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-key-retirement-"))
    const ids = { READ_ID: "key-ro-new", WRITE_ID: "key-rw-new", OLD_READ_ID: "key-ro-compromised", OLD_WRITE_ID: "key-rw-compromised" }
    try {
      for (const scenario of ["verify-failure", "duplicate", "unknown-class", "unexpected-role"]) {
        const callLog = path.join(testRoot, `${scenario}.log`)
        const result = runConditionalHelper(script, scenario, { CALL_LOG: callLog, ...ids })
        expect(result.status, `${scenario}\n${result.stderr}`).not.toBe(0)
        expect(fs.readFileSync(callLog, "utf8")).not.toContain("revoke ")
      }
      const callLog = path.join(testRoot, "safe.log")
      const success = runConditionalHelper(script, "safe", { CALL_LOG: callLog, ...ids })
      expect(success.status, success.stderr).toBe(0)
      const calls = fs.readFileSync(callLog, "utf8")
      expect(calls).toContain(`verify ${ids.READ_ID} read-only`)
      expect(calls).toContain(`verify ${ids.WRITE_ID} bounded-write`)
      expect(calls).toContain(`revoke ${ids.OLD_READ_ID}`)
      expect(calls).toContain(`revoke ${ids.OLD_WRITE_ID}`)
      expect(calls).toContain(`rejected ${ids.OLD_READ_ID}`)
      expect(calls).toContain(`rejected ${ids.OLD_WRITE_ID}`)
      expect(calls.match(/^revoke /gmu)).toHaveLength(2)
      expect(calls.match(/^inventory$/gmu)).toHaveLength(2)
      expect(calls.match(new RegExp(`^verify ${ids.READ_ID} read-only$`, "gmu"))).toHaveLength(2)
      expect(calls.match(new RegExp(`^verify ${ids.WRITE_ID} bounded-write$`, "gmu"))).toHaveLength(2)
      const oldReadRejected = calls.indexOf(`rejected ${ids.OLD_READ_ID}`)
      const oldWriteRejected = calls.indexOf(`rejected ${ids.OLD_WRITE_ID}`)
      expect(oldWriteRejected).toBeGreaterThan(oldReadRejected)
      expect(calls.lastIndexOf(`verify ${ids.READ_ID} read-only`)).toBeGreaterThan(oldWriteRejected)
      expect(calls.lastIndexOf(`verify ${ids.WRITE_ID} bounded-write`)).toBeGreaterThan(oldWriteRejected)
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
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
    expect(runbook).toContain("exact immutable key ID")
    expect(runbook).toContain("old credential receives an authentication rejection")
    expect(runbook).toMatch(/no additional key of\s+any capability/u)
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

    expect(template).toContain("<Overview>Mendelow Cloud Butler</Overview>")
    expect(template).toContain('Default="/mnt/user/appdata/ouro-butler/runtime/.ouro-cli"')
    expect(template).toContain('Default="/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro"')
    expect(template).not.toContain('/mnt/user/appdata/ouro-butler/AgentBundles')
    expect(template).toContain("<Repository>sha256:REPLACE_WITH_EXACT_LOCAL_IMAGE_ID</Repository>")
    expect(template).not.toMatch(/<Repository>ouro-butler:/u)
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
    expect(meta).toMatchObject({ runtimeVersion: "0.1.0-alpha.734", bundleSchemaVersion: 3 })
    expect(fs.existsSync("deploy/unraid/sanctuary.ouro/arc/README.md")).toBe(true)
    expect(fs.existsSync("deploy/unraid/sanctuary.ouro/tool-profiles.json")).toBe(true)
    expect(dockerfile).toContain("COPY deploy/unraid /opt/ouro/deploy/unraid")
  })

  it("requires exactly one matching managed Telegram process", () => {
    const telegram = "node /opt/ouro/dist/senses/telegram-entry.js --agent sanctuary"
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
