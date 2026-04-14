import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentProvider } from "../../heart/identity"
import type { ProviderCredentialPoolReadResult, ProviderCredentialRecord } from "../../heart/provider-credentials"
import type { ProviderLaneReadiness, ProviderState } from "../../heart/provider-state"

const mockProviderCredentials = vi.hoisted(() => ({
  readProviderCredentialPool: vi.fn(),
}))

vi.mock("../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../heart/provider-credentials")>("../../heart/provider-credentials")
  return {
    ...actual,
    readProviderCredentialPool: mockProviderCredentials.readProviderCredentialPool,
  }
})

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
}))

import {
  normalizeProviderLane,
  resolveEffectiveProviderBinding,
} from "../../heart/provider-binding-resolver"
import { getProviderStatePath, writeProviderState } from "../../heart/provider-state"

const timestamp = "2026-04-13T12:00:00.000Z"
const agentName = "slugger"
const createdDirs: string[] = []

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

function tempAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-binding-"))
  createdDirs.push(dir)
  return dir
}

function record(provider: AgentProvider, revision = `vault_${provider}`): ProviderCredentialRecord {
  return {
    provider,
    revision,
    updatedAt: timestamp,
    credentials: provider === "azure" ? { apiKey: "azure-key" } : { apiKey: `${provider}-key` },
    config: provider === "azure" ? { endpoint: "https://example.openai.azure.com" } : {},
    provenance: { source: "manual", updatedAt: timestamp },
  }
}

function okPool(providers: Partial<Record<AgentProvider, ProviderCredentialRecord>>): ProviderCredentialPoolReadResult {
  return {
    ok: true,
    poolPath: "vault:slugger:providers/*",
    pool: {
      schemaVersion: 1,
      updatedAt: timestamp,
      providers,
    },
  }
}

function invalidPool(reason: "invalid" | "unavailable" | "missing" = "invalid"): ProviderCredentialPoolReadResult {
  return {
    ok: false,
    reason,
    poolPath: "vault:slugger:providers/*",
    error: `${reason} pool`,
  }
}

function baseState(readiness: Partial<Record<"outward" | "inner", ProviderLaneReadiness>> = {}): ProviderState {
  return {
    schemaVersion: 1,
    machineId: "machine-local",
    updatedAt: timestamp,
    lanes: {
      outward: {
        provider: "minimax",
        model: "MiniMax-M2.5",
        source: "bootstrap",
        updatedAt: timestamp,
      },
      inner: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        source: "local",
        updatedAt: timestamp,
      },
    },
    readiness,
  }
}

describe("effective provider binding resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("normalizes current and legacy lane selectors", () => {
    emitTestEvent("provider binding lane normalization")

    expect(normalizeProviderLane("outward")).toEqual({ lane: "outward", warnings: [] })
    expect(normalizeProviderLane("inner")).toEqual({ lane: "inner", warnings: [] })
    expect(normalizeProviderLane("human")).toMatchObject({ lane: "outward", warnings: [{ code: "legacy-lane-selector" }] })
    expect(normalizeProviderLane("humanFacing")).toMatchObject({ lane: "outward", warnings: [{ code: "legacy-lane-selector" }] })
    expect(normalizeProviderLane("agent")).toMatchObject({ lane: "inner", warnings: [{ code: "legacy-lane-selector" }] })
    expect(normalizeProviderLane("agentFacing")).toMatchObject({ lane: "inner", warnings: [{ code: "legacy-lane-selector" }] })
  })

  it("returns repair guidance for missing and invalid local provider state", () => {
    emitTestEvent("provider binding state guards")
    const missingRoot = tempAgentRoot()

    expect(resolveEffectiveProviderBinding({
      agentName,
      agentRoot: missingRoot,
      lane: "humanFacing",
    })).toMatchObject({
      ok: false,
      lane: "outward",
      reason: "provider-state-missing",
      warnings: [
        { code: "legacy-lane-selector" },
        { code: "provider-state-missing" },
      ],
      repair: {
        command: "ouro use --agent slugger --lane outward --provider <provider> --model <model>",
      },
    })

    const invalidRoot = tempAgentRoot()
    fs.mkdirSync(path.dirname(getProviderStatePath(invalidRoot)), { recursive: true })
    fs.writeFileSync(getProviderStatePath(invalidRoot), "{\"schemaVersion\":2}\n", "utf8")
    expect(resolveEffectiveProviderBinding({
      agentName,
      agentRoot: invalidRoot,
      lane: "inner",
    })).toMatchObject({
      ok: false,
      lane: "inner",
      reason: "provider-state-invalid",
      repair: {
        command: "ouro use --agent slugger --lane inner --provider <provider> --model <model> --force",
      },
    })
  })

  it("resolves a present credential with readiness and legacy lane warnings", () => {
    emitTestEvent("provider binding present credential")
    const root = tempAgentRoot()
    writeProviderState(root, baseState({
      outward: {
        status: "ready",
        provider: "minimax",
        model: "MiniMax-M2.5",
        credentialRevision: "vault_minimax",
        checkedAt: timestamp,
        attempts: 2,
      },
    }))
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue(okPool({
      minimax: record("minimax", "vault_minimax"),
    }))

    const result = resolveEffectiveProviderBinding({
      agentName,
      agentRoot: root,
      lane: "human",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        lane: "outward",
        provider: "minimax",
        model: "MiniMax-M2.5",
        machineId: "machine-local",
        credential: {
          status: "present",
          revision: "vault_minimax",
          credentialFields: ["apiKey"],
          configFields: [],
        },
        readiness: {
          status: "ready",
          credentialRevision: "vault_minimax",
          attempts: 2,
        },
        warnings: [{ code: "legacy-lane-selector" }],
      },
    })
  })

  it("marks readiness unknown when no prior readiness exists", () => {
    emitTestEvent("provider binding unknown readiness")
    const root = tempAgentRoot()
    writeProviderState(root, baseState())

    mockProviderCredentials.readProviderCredentialPool.mockReturnValueOnce(okPool({}))
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot: root, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        credential: { status: "missing" },
        readiness: { status: "unknown", reason: "credential-missing" },
        warnings: [{ code: "credential-missing" }],
      },
    })

    mockProviderCredentials.readProviderCredentialPool.mockReturnValueOnce(invalidPool("unavailable"))
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot: root, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        credential: { status: "invalid-pool", error: "unavailable pool" },
        readiness: { status: "unknown", reason: "credential-pool-invalid" },
        warnings: [{ code: "credential-pool-invalid" }],
      },
    })

    mockProviderCredentials.readProviderCredentialPool.mockReturnValueOnce(invalidPool("missing"))
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot: root, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        credential: { status: "missing" },
        readiness: { status: "unknown", reason: "credential-missing" },
      },
    })
  })

  it("marks prior readiness stale when bindings or vault revisions change", () => {
    emitTestEvent("provider binding stale readiness")
    const root = tempAgentRoot()
    writeProviderState(root, baseState({
      outward: {
        status: "ready",
        provider: "anthropic",
        model: "claude-opus-4-6",
        credentialRevision: "vault_old",
        checkedAt: timestamp,
      },
    }))
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue(okPool({
      minimax: record("minimax", "vault_minimax"),
    }))

    expect(resolveEffectiveProviderBinding({ agentName, agentRoot: root, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        readiness: {
          status: "stale",
          previousStatus: "ready",
          reason: "provider-model-changed",
        },
        warnings: [{ code: "readiness-stale" }],
      },
    })

    writeProviderState(root, baseState({
      outward: {
        status: "ready",
        provider: "minimax",
        model: "MiniMax-M2.5",
        credentialRevision: "vault_old",
        checkedAt: timestamp,
      },
    }))
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot: root, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        readiness: {
          status: "stale",
          previousStatus: "ready",
          reason: "credential-revision-changed",
        },
        warnings: [{ code: "readiness-stale" }],
      },
    })

    mockProviderCredentials.readProviderCredentialPool.mockReturnValueOnce(okPool({}))
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot: root, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        credential: { status: "missing" },
        readiness: {
          status: "stale",
          reason: "credential-missing",
        },
      },
    })

    mockProviderCredentials.readProviderCredentialPool.mockReturnValueOnce(invalidPool())
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot: root, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        credential: { status: "invalid-pool" },
        readiness: {
          status: "stale",
          reason: "credential-pool-invalid",
        },
      },
    })
  })
})
