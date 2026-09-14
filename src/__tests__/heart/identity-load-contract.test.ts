/**
 * Structural contract test for `loadAgentConfig()` in `src/heart/identity.ts`.
 *
 * Exercises the real loader against mocked filesystem reads, including explicit owner coordinates, without touching the developer's ~/AgentBundles.
 *
 * Why a separate file from `identity-contract.test.ts`: `vi.mock("fs")` is
 * per-file scoped, and `identity-contract.test.ts` needs real fs for
 * `createTmpBundle`. Splitting avoids the conflict.
 *
 * Regression guard: reuses `FULL_AGENT_JSON` from `identity-contract.test.ts`
 * which has a `satisfies DeepRequired<AgentConfig>` compile-time check —
 * adding a new field to `AgentConfig` forces a fixture update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as path from "path"

vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock("../../heart/migrate-config", () => ({
  migrateAgentConfigV1ToV2: vi.fn(),
}))

import * as fs from "fs"
import { FULL_AGENT_JSON } from "./identity-fixture"

let savedArgv: string[]

beforeEach(() => {
  savedArgv = [...process.argv]
  vi.mocked(fs.readFileSync).mockReset()
  vi.mocked(fs.writeFileSync).mockReset()
  vi.mocked(fs.existsSync).mockReset()
  vi.mocked(fs.existsSync).mockReturnValue(true)
  vi.resetModules()
})

afterEach(() => {
  process.argv = savedArgv
})

describe("loadAgentConfig structural contract", () => {
  it("round-trips every top-level AgentConfig field from agent.json", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "fixture-agent"]
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const pathStr = typeof p === "string" ? p : (p as { toString: () => string }).toString()
      if (pathStr.endsWith(path.join("fixture-agent.ouro", "agent.json"))) {
        return JSON.stringify(FULL_AGENT_JSON)
      }
      throw new Error(`unexpected read: ${pathStr}`)
    })

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()

    expect(config.version).toBe(FULL_AGENT_JSON.version)
    expect(config.enabled).toBe(FULL_AGENT_JSON.enabled)
    expect(config.provider).toBe(FULL_AGENT_JSON.provider)
    expect(config.humanFacing).toEqual(FULL_AGENT_JSON.humanFacing)
    expect(config.agentFacing).toEqual(FULL_AGENT_JSON.agentFacing)
    expect(config.context).toEqual(FULL_AGENT_JSON.context)
    expect(config.logging).toEqual(FULL_AGENT_JSON.logging)
    expect(config.senses).toEqual(FULL_AGENT_JSON.senses)
    expect(config.mcpServers).toEqual(FULL_AGENT_JSON.mcpServers)
    expect(config.shell).toEqual(FULL_AGENT_JSON.shell)
    expect(config.phrases).toEqual(FULL_AGENT_JSON.phrases)
    expect(config.vault).toEqual(FULL_AGENT_JSON.vault)
    expect(config.sync).toEqual(FULL_AGENT_JSON.sync)
    expect(config.plugins).toEqual(FULL_AGENT_JSON.plugins)
  })

  it("preserves the sync block (regression for #349)", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "fixture-agent"]
    const withSync = { ...FULL_AGENT_JSON, sync: { enabled: true, remote: "from-fixture" } }
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const pathStr = typeof p === "string" ? p : (p as { toString: () => string }).toString()
      if (pathStr.endsWith(path.join("fixture-agent.ouro", "agent.json"))) {
        return JSON.stringify(withSync)
      }
      throw new Error(`unexpected read: ${pathStr}`)
    })

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()
    expect(config.sync).toEqual({ enabled: true, remote: "from-fixture" })
  })

  it("preserves the shell block", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "fixture-agent"]
    const withShell = { ...FULL_AGENT_JSON, shell: { defaultTimeout: 99_000 } }
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const pathStr = typeof p === "string" ? p : (p as { toString: () => string }).toString()
      if (pathStr.endsWith(path.join("fixture-agent.ouro", "agent.json"))) {
        return JSON.stringify(withShell)
      }
      throw new Error(`unexpected read: ${pathStr}`)
    })

    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const config = loadAgentConfig()
    expect(config.shell).toEqual({ defaultTimeout: 99_000 })
  })
})

describe("loadAgentConfig explicit owner", () => {
  const owner = { agentName: "owner-a", agentRoot: "/mock/bundles/owner-a.ouro" }

  it("reads the initiating root without resolving an ambient agent", async () => {
    process.argv = ["node", "cli-entry.js"]
    const fixture = { ...FULL_AGENT_JSON, mcpServers: { owned: { command: "owner-a-mcp" } } }
    vi.mocked(fs.readFileSync).mockImplementation((file) => {
      if (String(file) !== path.join(owner.agentRoot, "agent.json")) throw new Error("wrong agent read")
      return JSON.stringify(fixture)
    })
    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()

    expect(loadAgentConfig(owner).mcpServers).toEqual(fixture.mcpServers)
    expect(fs.readFileSync).toHaveBeenCalledExactlyOnceWith(path.join(owner.agentRoot, "agent.json"), "utf-8")
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it("does not borrow or clear another agent's ambient override", async () => {
    const { loadAgentConfig, resetIdentity, setAgentConfigOverride } = await import("../../heart/identity")
    resetIdentity()
    const other = { ...FULL_AGENT_JSON, mcpServers: { other: { command: "owner-b-mcp" } } }
    setAgentConfigOverride(other)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(FULL_AGENT_JSON))

    expect(loadAgentConfig(owner).mcpServers).toEqual(FULL_AGENT_JSON.mcpServers)
    expect(loadAgentConfig()).toBe(other)
    expect(fs.readFileSync).toHaveBeenCalledExactlyOnceWith(path.join(owner.agentRoot, "agent.json"), "utf-8")
  })

  it("uses the explicit name for Sanctuary's required paid-turn budget", async () => {
    process.argv = ["node", "cli-entry.js", "--agent", "other"]
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(FULL_AGENT_JSON))
    const { loadAgentConfig, resetIdentity } = await import("../../heart/identity")
    resetIdentity()
    const sanctuary = { agentName: "sanctuary", agentRoot: "/mock/bundles/sanctuary.ouro" }

    expect(() => loadAgentConfig(sanctuary)).toThrow("must explicitly set")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ...FULL_AGENT_JSON, habitPaidTurnsPerDay: 24 }))
    expect(loadAgentConfig(sanctuary).habitPaidTurnsPerDay).toBe(24)
  })

  it.each(["missing", "malformed"])("does not fall back to an override after a %s explicit config", async (failure) => {
    const { loadAgentConfig, resetIdentity, setAgentConfigOverride } = await import("../../heart/identity")
    resetIdentity()
    setAgentConfigOverride(FULL_AGENT_JSON)
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      if (failure === "missing") throw new Error("ENOENT")
      return "{"
    })

    expect(() => loadAgentConfig(owner)).toThrow()
    expect(fs.readFileSync).toHaveBeenCalledExactlyOnceWith(path.join(owner.agentRoot, "agent.json"), "utf-8")
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(loadAgentConfig()).toBe(FULL_AGENT_JSON)
  })

  it.each([
    null,
    false,
    {},
    { agentName: "", agentRoot: "/mock/bundles/owner-a.ouro" },
    { agentName: 1, agentRoot: "/mock/bundles/owner-a.ouro" },
    { agentName: "owner-a", agentRoot: "" },
    { agentName: "owner-a", agentRoot: 1 },
    { agentName: "owner-a", agentRoot: "relative/owner-a.ouro" },
  ])("rejects invalid explicit coordinates before config access: %j", async (invalid) => {
    const { loadAgentConfig, resetIdentity, setAgentConfigOverride } = await import("../../heart/identity")
    resetIdentity()
    setAgentConfigOverride(FULL_AGENT_JSON)

    expect(() => Reflect.apply(loadAgentConfig, undefined, [invalid])).toThrow("invalid agent configuration owner")
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })
})
