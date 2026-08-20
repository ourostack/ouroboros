import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import { hasManagedSupercronicProcess, hasManagedTelegramProcess, readContainerRuntimePolicy } from "../../../heart/daemon/container-runtime"

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

  it("rolls final production activation back under set -eu before propagating failure", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const update = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("Backup:"))
    const activation = update.slice(update.indexOf("if audit_effective ouro-butler"))

    expect(activation).toContain('if audit_effective ouro-butler "$IMAGE_ID" \\')
    expect(activation).toContain("PRODUCTION_ACTIVATION_STATUS=$?")
    const failedStop = activation.indexOf("docker stop ouro-butler >/dev/null 2>&1 || true")
    const failedRemove = activation.indexOf("docker rm ouro-butler", failedStop)
    const oldImage = activation.indexOf("ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback)", failedRemove)
    const rename = activation.indexOf("docker rename ouro-butler-rollback ouro-butler", oldImage)
    const audit = activation.indexOf('audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"', rename)
    const restart = activation.indexOf("docker start ouro-butler", audit)
    const ready = activation.indexOf("wait_butler_ready ouro-butler", restart)
    const autostart = activation.indexOf("enable_butler_autostart", ready)
    const propagate = activation.indexOf('(exit "$PRODUCTION_ACTIVATION_STATUS")', autostart)
    expect(failedStop).toBeGreaterThan(-1)
    expect(failedRemove).toBeGreaterThan(failedStop)
    expect(oldImage).toBeGreaterThan(failedRemove)
    expect(rename).toBeGreaterThan(oldImage)
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
    const staging = update.slice(rename, update.indexOf("Create production from the same exact image ID"))

    const oldImage = update.indexOf("ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)")
    const validateOldImage = update.indexOf("docker image inspect \"$ROLLBACK_IMAGE_ID\" >/dev/null", oldImage)
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
    const renameRollback = staging.indexOf("docker rename ouro-butler-rollback ouro-butler", verifyAbsent)
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
    expect(renameRollback).toBeGreaterThan(verifyAbsent)
    expect(auditRollback).toBeGreaterThan(renameRollback)
    expect(startRollback).toBeGreaterThan(auditRollback)
    expect(readyRollback).toBeGreaterThan(startRollback)
    expect(autostart).toBeGreaterThan(readyRollback)
    expect(propagate).toBeGreaterThan(autostart)
  })

  it("contains failed restore activation explicitly while leaving autostart disabled", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const restore = runbook.slice(runbook.indexOf("Restore:"), runbook.indexOf("Credential recovery:"))

    expect(restore).toContain('if audit_effective ouro-butler "$IMAGE_ID" \\')
    expect(restore).toContain("RESTORE_ACTIVATION_STATUS=$?")
    expect(restore).toContain("docker stop ouro-butler >/dev/null 2>&1 || true")
    expect(restore).toContain("docker rm ouro-butler")
    expect(restore).toContain('(exit "$RESTORE_ACTIVATION_STATUS")')
    const failure = restore.slice(restore.indexOf("RESTORE_ACTIVATION_STATUS=$?"))
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
    expect(runbook).toContain("test \"$(stat -c '%u:%g %a' \"$AUTOSTART_FILE\")\" = \"0:0 644\"")
    expect(runbook).toContain('$0 != "ouro-butler" && $0 != "ouro-butler-staging" && $0 != "ouro-butler-rollback"')
    expect(runbook).toContain('! grep -Fxq "ouro-butler" "$AUTOSTART_FILE"')
    expect(runbook).toContain('! grep -Fxq "ouro-butler-staging" "$AUTOSTART_FILE"')
    expect(runbook).toContain('! grep -Fxq "ouro-butler-rollback" "$AUTOSTART_FILE"')
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
    const productionAudit = updateRunbook.indexOf('if audit_effective ouro-butler "$IMAGE_ID"')
    const productionStart = updateRunbook.indexOf("&& docker start ouro-butler", productionAudit)
    expect(productionStart).toBeGreaterThan(productionAudit)
    expect(updateRunbook).toContain("docker start ouro-butler")
    expect(runbook).toContain("printf '%s\\n' ouro-butler >>\"$AUTOSTART_TMP\"")
    expect(runbook).toContain('test "$(grep -Fxc "ouro-butler" "$AUTOSTART_FILE")" = 1')
    const rollbackReady = updateRunbook.indexOf("wait_butler_ready ouro-butler", rollbackStart)
    const rollbackEnable = updateRunbook.indexOf("enable_butler_autostart", rollbackReady)
    expect(rollbackReady).toBeGreaterThan(rollbackStart)
    expect(rollbackEnable).toBeGreaterThan(rollbackReady)
    const productionReady = updateRunbook.indexOf("wait_butler_ready ouro-butler", productionStart)
    const productionEnable = updateRunbook.indexOf("enable_butler_autostart", productionReady)
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
