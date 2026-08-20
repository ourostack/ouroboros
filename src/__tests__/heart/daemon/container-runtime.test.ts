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
    expect(updateRunbook).toContain("AUTOSTART_FILE=/var/lib/docker/unraid-autostart")
    expect(updateRunbook).toContain("test \"$(stat -c '%u:%g %a' \"$AUTOSTART_FILE\")\" = \"0:0 644\"")
    expect(updateRunbook).toContain('$0 != "ouro-butler" && $0 != "ouro-butler-staging" && $0 != "ouro-butler-rollback"')
    expect(updateRunbook).toContain('! grep -Fxq "ouro-butler" "$AUTOSTART_FILE"')
    expect(updateRunbook).toContain('! grep -Fxq "ouro-butler-staging" "$AUTOSTART_FILE"')
    expect(updateRunbook).toContain('! grep -Fxq "ouro-butler-rollback" "$AUTOSTART_FILE"')
    expect(updateRunbook).toContain('docker create --name ouro-butler-staging --network host --restart unless-stopped --user 10001:10001 \\')
    expect(updateRunbook).toContain('--mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli,rw" \\')
    expect(updateRunbook).toContain('--mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro,rw" \\')
    expect(updateRunbook).toContain('"$IMAGE_ID"')
    expect(updateRunbook).toContain("docker inspect ouro-butler-staging >\"$INSPECT_DIR/container.json\"")
    expect(updateRunbook).toContain("docker image inspect \"$IMAGE_ID\" >\"$INSPECT_DIR/image.json\"")
    expect(updateRunbook).toContain("--inspect /audit/container.json --image-inspect /audit/image.json")
    expect(updateRunbook).toContain("rm -f -- \"$INSPECT_DIR/container.json\" \"$INSPECT_DIR/image.json\"")
    expect(updateRunbook).toContain("rmdir -- \"$INSPECT_DIR\"")
    const stopProduction = updateRunbook.indexOf("docker stop ouro-butler")
    const disableAutostart = updateRunbook.indexOf('! grep -Fxq "ouro-butler-rollback" "$AUTOSTART_FILE"')
    const renameRollback = updateRunbook.indexOf("docker rename ouro-butler ouro-butler-rollback")
    const createStaging = updateRunbook.indexOf("docker create --name ouro-butler-staging")
    const auditStaging = updateRunbook.indexOf("docker inspect ouro-butler-staging")
    const startStaging = updateRunbook.indexOf("docker start ouro-butler-staging")
    expect(disableAutostart).toBeGreaterThan(-1)
    expect(stopProduction).toBeGreaterThan(disableAutostart)
    expect(stopProduction).toBeGreaterThan(-1)
    expect(renameRollback).toBeGreaterThan(stopProduction)
    expect(createStaging).toBeGreaterThan(renameRollback)
    expect(auditStaging).toBeGreaterThan(createStaging)
    expect(startStaging).toBeGreaterThan(auditStaging)
    expect(updateRunbook).toContain("At no point may production and staging run together against the same Telegram token")
    expect(updateRunbook).toContain("docker rename ouro-butler-rollback ouro-butler")
    expect(updateRunbook).toContain("docker start ouro-butler")
    expect(updateRunbook).toContain("printf '%s\\n' ouro-butler >>\"$AUTOSTART_TMP\"")
    expect(updateRunbook).toContain('test "$(grep -Fxc "ouro-butler" "$AUTOSTART_FILE")" = 1')
    const restoreRunbook = runbook.slice(runbook.indexOf("Restore:"), runbook.indexOf("Credential recovery:"))
    expect(restoreRunbook).toContain("docker create --name ouro-butler")
    expect(restoreRunbook).toContain("--inspect /audit/container.json --image-inspect /audit/image.json")
    expect(restoreRunbook.indexOf("docker start ouro-butler")).toBeGreaterThan(restoreRunbook.indexOf("--inspect /audit/container.json"))
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
