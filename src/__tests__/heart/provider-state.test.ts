import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import {
  bootstrapProviderStateFromAgentConfig,
  getProviderStatePath,
  readProviderState,
  writeProviderState,
  type ProviderState,
} from "../../heart/provider-state"

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

describe("provider state", () => {
  let agentRoot: string

  beforeEach(() => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-bundles-"))
    agentRoot = path.join(bundlesRoot, "slugger.ouro")
    fs.mkdirSync(agentRoot, { recursive: true })
    mockEmitNervesEvent.mockClear()
  })

  afterEach(() => {
    fs.rmSync(path.dirname(agentRoot), { recursive: true, force: true })
  })

  function providerState(overrides: Partial<ProviderState> = {}): ProviderState {
    return {
      schemaVersion: 1,
      machineId: "machine_random_123",
      updatedAt: "2026-04-12T17:40:00.000Z",
      lanes: {
        outward: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          source: "bootstrap",
          updatedAt: "2026-04-12T17:40:00.000Z",
        },
        inner: {
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "local",
          updatedAt: "2026-04-12T17:40:00.000Z",
        },
      },
      readiness: {
        inner: {
          status: "ready",
          checkedAt: "2026-04-12T17:41:00.000Z",
          provider: "minimax",
          model: "MiniMax-M2.5",
          credentialRevision: "cred_1",
        },
      },
      ...overrides,
    }
  }

  it("uses state/providers.json inside the agent bundle", () => {
    emitTestEvent("provider state path")
    expect(getProviderStatePath(agentRoot)).toBe(path.join(agentRoot, "state", "providers.json"))
  })

  it("reports missing provider state without creating a file", () => {
    emitTestEvent("provider state missing")
    const result = readProviderState(agentRoot)

    expect(result).toEqual({
      ok: false,
      reason: "missing",
      statePath: getProviderStatePath(agentRoot),
      error: "provider state not found",
    })
    expect(fs.existsSync(getProviderStatePath(agentRoot))).toBe(false)
  })

  it("writes provider state and creates the state directory", () => {
    emitTestEvent("provider state write")
    const state = providerState()

    writeProviderState(agentRoot, state)

    const raw = fs.readFileSync(getProviderStatePath(agentRoot), "utf-8")
    expect(JSON.parse(raw)).toEqual(state)
    expect(raw).not.toContain("apiKey")
    expect(raw).not.toContain("oauthAccessToken")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "config/identity",
      event: "config.provider_state_written",
    }))
  })

  it("reads valid provider state", () => {
    emitTestEvent("provider state read")
    const state = providerState()
    writeProviderState(agentRoot, state)

    const result = readProviderState(agentRoot)

    expect(result).toEqual({
      ok: true,
      statePath: getProviderStatePath(agentRoot),
      state,
    })
  })

  it("reports invalid provider state instead of accepting malformed lanes", () => {
    emitTestEvent("provider state invalid")
    const statePath = getProviderStatePath(agentRoot)
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 1,
      machineId: "machine_random_123",
      updatedAt: "2026-04-12T17:40:00.000Z",
      lanes: {
        outward: { provider: "fake-provider", model: "x", source: "local", updatedAt: "2026-04-12T17:40:00.000Z" },
      },
      readiness: {},
    }), "utf-8")

    const result = readProviderState(agentRoot)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("invalid")
      expect(result.error).toContain("outward.provider")
    }
  })

  it("bootstraps outward and inner lanes from legacy agent.json facings exactly once", () => {
    emitTestEvent("provider state bootstrap from agent config")
    const state = bootstrapProviderStateFromAgentConfig({
      machineId: "machine_random_123",
      now: new Date("2026-04-12T17:40:00.000Z"),
      agentConfig: {
        humanFacing: { provider: "openai-codex", model: "gpt-5.4" },
        agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      },
    })

    expect(state).toEqual({
      schemaVersion: 1,
      machineId: "machine_random_123",
      updatedAt: "2026-04-12T17:40:00.000Z",
      lanes: {
        outward: {
          provider: "openai-codex",
          model: "gpt-5.4",
          source: "bootstrap",
          updatedAt: "2026-04-12T17:40:00.000Z",
        },
        inner: {
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "bootstrap",
          updatedAt: "2026-04-12T17:40:00.000Z",
        },
      },
      readiness: {},
    })
  })
})
