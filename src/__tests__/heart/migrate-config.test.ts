import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "config/identity",
    event: "config_identity.test_run",
    message: testName,
    meta: { test: true },
  })
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `migrate-config-${prefix}-`))
}

function writeAgentJson(bundleRoot: string, config: Record<string, unknown>): void {
  fs.mkdirSync(bundleRoot, { recursive: true })
  fs.writeFileSync(path.join(bundleRoot, "agent.json"), JSON.stringify(config, null, 2) + "\n")
}

function readAgentJson(bundleRoot: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(bundleRoot, "agent.json"), "utf-8"))
}

describe("migrateAgentConfigV1ToV2", () => {
  let tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    tempDirs = []
  })

  function temp(prefix: string): string {
    const dir = makeTempDir(prefix)
    tempDirs.push(dir)
    return dir
  }

  it("migrates a v1 provider into explicit facings using provider default models", async () => {
    emitTestEvent("migrate v1 provider to facings")
    const bundleRoot = path.join(temp("anthropic"), "TestAgent.ouro")
    writeAgentJson(bundleRoot, {
      version: 1,
      enabled: true,
      provider: "anthropic",
      context: { maxTokens: 80000, contextMargin: 20 },
      senses: { cli: { enabled: true }, teams: { enabled: false }, bluebubbles: { enabled: false } },
      phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
    })

    const { migrateAgentConfigV1ToV2 } = await import("../../heart/migrate-config")
    migrateAgentConfigV1ToV2(bundleRoot)

    const config = readAgentJson(bundleRoot)
    expect(config.version).toBe(2)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
    expect(config.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
    expect(config).not.toHaveProperty("provider")
    expect(config.context).toEqual({ maxTokens: 80000, contextMargin: 20 })
  })

  it("uses anthropic defaults when the legacy provider is missing or invalid", async () => {
    emitTestEvent("migrate invalid provider fallback")
    const bundleRoot = path.join(temp("fallback"), "Fallback.ouro")
    writeAgentJson(bundleRoot, {
      enabled: true,
      provider: "bogus-provider",
      phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
    })

    const { migrateAgentConfigV1ToV2 } = await import("../../heart/migrate-config")
    migrateAgentConfigV1ToV2(bundleRoot)

    const config = readAgentJson(bundleRoot)
    expect(config.version).toBe(2)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
    expect(config.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
  })

  it("is idempotent when agent.json is already v2", async () => {
    emitTestEvent("migrate v2 idempotent")
    const bundleRoot = path.join(temp("idempotent"), "TestAgent.ouro")
    const v2Config = {
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
    }
    writeAgentJson(bundleRoot, v2Config)
    const originalContent = fs.readFileSync(path.join(bundleRoot, "agent.json"), "utf-8")

    const { migrateAgentConfigV1ToV2 } = await import("../../heart/migrate-config")
    migrateAgentConfigV1ToV2(bundleRoot)

    expect(fs.readFileSync(path.join(bundleRoot, "agent.json"), "utf-8")).toBe(originalContent)
  })

  it("returns without error when agent.json is missing", async () => {
    emitTestEvent("migrate missing agent json")
    const bundleRoot = path.join(temp("missing"), "Missing.ouro")

    const { migrateAgentConfigV1ToV2 } = await import("../../heart/migrate-config")
    expect(() => migrateAgentConfigV1ToV2(bundleRoot)).not.toThrow()
  })

  it("throws clearly when agent.json is invalid JSON", async () => {
    emitTestEvent("migrate invalid agent json")
    const bundleRoot = path.join(temp("invalid"), "Invalid.ouro")
    fs.mkdirSync(bundleRoot, { recursive: true })
    fs.writeFileSync(path.join(bundleRoot, "agent.json"), "not-json")

    const { migrateAgentConfigV1ToV2 } = await import("../../heart/migrate-config")
    expect(() => migrateAgentConfigV1ToV2(bundleRoot)).toThrow(/Cannot parse agent\.json/)
  })
})
