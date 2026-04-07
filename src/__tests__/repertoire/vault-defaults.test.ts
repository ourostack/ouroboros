import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock child_process (required by credential-access transitive deps)
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

// Mock identity
vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "test-agent"),
  getAgentRoot: vi.fn(() => path.join(os.tmpdir(), "test-agent-bundle")),
}))

import { ensureVaultDefaults } from "../../repertoire/credential-access"

describe("ensureVaultDefaults", () => {
  let tmpDir: string
  let agentRoot: string

  beforeEach(() => {
    nervesEvents.length = 0
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-defaults-test-"))
    agentRoot = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns existing vault config when already present", () => {
    const existing = { email: "custom@ouro.bot", serverUrl: "https://custom.vault" }
    const result = ensureVaultDefaults("test-agent", agentRoot, existing)

    expect(result).toBe(existing)
    // Should NOT emit any event
    expect(nervesEvents).toHaveLength(0)
  })

  it("writes defaults to agent.json when vault section is missing", () => {
    const configPath = path.join(agentRoot, "agent.json")
    fs.writeFileSync(configPath, JSON.stringify({ version: 2, enabled: true }, null, 2) + "\n")

    const result = ensureVaultDefaults("slugger", agentRoot, undefined)

    expect(result).toEqual({
      email: "slugger@ouro.bot",
      serverUrl: "https://vault.ouro.bot",
    })

    // Verify agent.json was updated
    const updated = JSON.parse(fs.readFileSync(configPath, "utf-8"))
    expect(updated.vault).toEqual({
      email: "slugger@ouro.bot",
      serverUrl: "https://vault.ouro.bot",
    })

    // Existing fields preserved
    expect(updated.version).toBe(2)
    expect(updated.enabled).toBe(true)

    // Should emit nerves event
    expect(nervesEvents.some((e) => e.event === "repertoire.vault_defaults_auto_configured")).toBe(true)
    const event = nervesEvents.find((e) => e.event === "repertoire.vault_defaults_auto_configured")!
    expect((event.meta as any).agentName).toBe("slugger")
    expect((event.meta as any).email).toBe("slugger@ouro.bot")
  })

  it("returns undefined when agent.json does not exist", () => {
    const result = ensureVaultDefaults("test-agent", "/nonexistent/path", undefined)
    expect(result).toBeUndefined()
    expect(nervesEvents).toHaveLength(0)
  })

  it("returns undefined when agent.json is invalid JSON", () => {
    const configPath = path.join(agentRoot, "agent.json")
    fs.writeFileSync(configPath, "not valid json{{{")

    const result = ensureVaultDefaults("test-agent", agentRoot, undefined)
    expect(result).toBeUndefined()
  })

  it("uses agentName to construct the email default", () => {
    const configPath = path.join(agentRoot, "agent.json")
    fs.writeFileSync(configPath, JSON.stringify({ version: 2 }))

    const result = ensureVaultDefaults("ouroboros", agentRoot, undefined)

    expect(result!.email).toBe("ouroboros@ouro.bot")
    expect(result!.serverUrl).toBe("https://vault.ouro.bot")
  })

  it("preserves all existing agent.json fields when adding vault", () => {
    const configPath = path.join(agentRoot, "agent.json")
    const original = {
      version: 2,
      enabled: true,
      humanFacing: { provider: "azure", model: "gpt-4o" },
      agentFacing: { provider: "azure", model: "gpt-4o" },
      senses: { cli: { enabled: true } },
      mcpServers: { liteapi: { command: "node", args: ["server.js"] } },
    }
    fs.writeFileSync(configPath, JSON.stringify(original, null, 2) + "\n")

    ensureVaultDefaults("test-agent", agentRoot, undefined)

    const updated = JSON.parse(fs.readFileSync(configPath, "utf-8"))
    expect(updated.version).toBe(2)
    expect(updated.enabled).toBe(true)
    expect(updated.humanFacing).toEqual(original.humanFacing)
    expect(updated.agentFacing).toEqual(original.agentFacing)
    expect(updated.senses).toEqual(original.senses)
    expect(updated.mcpServers).toEqual(original.mcpServers)
    expect(updated.vault).toBeDefined()
  })
})
