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
  validateProviderState,
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

  it("treats a disappeared provider state file as missing", async () => {
    emitTestEvent("provider state disappeared during read")
    const statePath = getProviderStatePath(agentRoot)
    vi.resetModules()
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return {
        ...actual,
        existsSync: (filePath: fs.PathLike) => String(filePath) === statePath,
        readFileSync: (filePath: fs.PathOrFileDescriptor, ...args: any[]) => {
          if (String(filePath) === statePath) {
            throw Object.assign(new Error("gone"), { code: "ENOENT" })
          }
          return actual.readFileSync(filePath as never, ...(args as never[]))
        },
      }
    })

    try {
      const { readProviderState: readRacingProviderState } = await import("../../heart/provider-state")
      const result = readRacingProviderState(agentRoot)
      expect(result).toEqual({
        ok: false,
        reason: "missing",
        statePath,
        error: "provider state not found",
      })
    } finally {
      vi.doUnmock("fs")
      vi.resetModules()
    }
  })

  it("reads readiness entries with error and attempt metadata", () => {
    emitTestEvent("provider state readiness error metadata")
    const state = providerState({
      readiness: {
        outward: {
          status: "failed",
          checkedAt: "2026-04-12T17:42:00.000Z",
          provider: "anthropic",
          model: "claude-opus-4-6",
          credentialRevision: "cred_2",
          error: "401",
          attempts: 3,
        },
      },
    })
    writeProviderState(agentRoot, state)

    expect(readProviderState(agentRoot)).toEqual({
      ok: true,
      statePath: getProviderStatePath(agentRoot),
      state,
    })
  })

  it("reads minimal readiness entries without optional metadata", () => {
    emitTestEvent("provider state minimal readiness")
    const state = providerState({
      readiness: {
        outward: {
          status: "unknown",
          provider: "azure",
          model: "gpt-4o",
        },
      },
    })
    writeProviderState(agentRoot, state)

    expect(readProviderState(agentRoot)).toEqual({
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

  it("reports invalid JSON in provider state", () => {
    emitTestEvent("provider state invalid json")
    const statePath = getProviderStatePath(agentRoot)
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, "not json{{{", "utf-8")

    const result = readProviderState(agentRoot)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("invalid")
      expect(result.error).toContain("Unexpected")
    }
  })

  it("reports read errors other than missing provider state as invalid", () => {
    emitTestEvent("provider state read error")
    fs.mkdirSync(getProviderStatePath(agentRoot), { recursive: true })

    const result = readProviderState(agentRoot)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("invalid")
      expect(result.error).not.toBe("provider state not found")
    }
  })

  it("validates provider state root shape", () => {
    emitTestEvent("provider state root validation")
    expect(() => validateProviderState(null)).toThrow("provider state must be an object")
    expect(() => validateProviderState({ schemaVersion: 2 })).toThrow("schemaVersion")
    expect(() => validateProviderState({ schemaVersion: 1, machineId: "", updatedAt: "x" })).toThrow("machineId")
    expect(() => validateProviderState({ schemaVersion: 1, machineId: "m", updatedAt: "" })).toThrow("updatedAt")
    expect(() => validateProviderState({ schemaVersion: 1, machineId: "m", updatedAt: "x" })).toThrow("lanes")
    expect(() => validateProviderState({
      schemaVersion: 1,
      machineId: "m",
      updatedAt: "x",
      lanes: {
        outward: { provider: "anthropic", model: "claude-opus-4-6", source: "bootstrap", updatedAt: "x" },
        inner: { provider: "minimax", model: "MiniMax-M2.5", source: "local", updatedAt: "x" },
      },
    })).toThrow("readiness")
  })

  it("validates provider lane binding fields", () => {
    emitTestEvent("provider state binding validation")
    const base = providerState()
    expect(() => validateProviderState({
      ...base,
      lanes: { ...base.lanes, outward: null },
    })).toThrow("outward must be an object")
    expect(() => validateProviderState({
      ...base,
      lanes: { ...base.lanes, outward: { ...base.lanes.outward, model: "" } },
    })).toThrow("outward.model")
    expect(() => validateProviderState({
      ...base,
      lanes: { ...base.lanes, outward: { ...base.lanes.outward, source: "remote" } },
    })).toThrow("outward.source")
    expect(() => validateProviderState({
      ...base,
      lanes: { ...base.lanes, outward: { ...base.lanes.outward, updatedAt: "" } },
    })).toThrow("outward.updatedAt")
  })

  it("validates provider readiness fields", () => {
    emitTestEvent("provider state readiness validation")
    const base = providerState()
    const invalidReadiness = (readiness: Record<string, unknown>) => ({
      ...base,
      readiness: { outward: readiness },
    })

    expect(() => validateProviderState(invalidReadiness(null as unknown as Record<string, unknown>))).toThrow("outward.readiness")
    expect(() => validateProviderState(invalidReadiness({ status: "sleeping", provider: "anthropic", model: "m" }))).toThrow("status")
    expect(() => validateProviderState(invalidReadiness({ status: "ready", provider: "fake", model: "m" }))).toThrow("provider")
    expect(() => validateProviderState(invalidReadiness({ status: "ready", provider: "anthropic", model: "" }))).toThrow("model")
    expect(() => validateProviderState(invalidReadiness({ status: "ready", provider: "anthropic", model: "m", checkedAt: 1 }))).toThrow("checkedAt")
    expect(() => validateProviderState(invalidReadiness({ status: "ready", provider: "anthropic", model: "m", credentialRevision: 1 }))).toThrow("credentialRevision")
    expect(() => validateProviderState(invalidReadiness({ status: "ready", provider: "anthropic", model: "m", error: 1 }))).toThrow("error")
    expect(() => validateProviderState(invalidReadiness({ status: "ready", provider: "anthropic", model: "m", attempts: "1" }))).toThrow("attempts")
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
