/**
 * Structural contract test for `loadAgentConfig()` in `src/heart/identity.ts`.
 *
 * `loadAgentConfig` reads from `getAgentRoot()` with no parameter override,
 * so this file follows the same pattern as the existing `identity.test.ts`:
 * mock `fs` and return the fixture agent.json when `readFileSync` is called
 * on the expected path. This lets us exercise the real function without
 * touching the developer's ~/AgentBundles.
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
