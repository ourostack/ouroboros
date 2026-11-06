import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentProvider } from "../../heart/identity"
import type { ProviderCredentialPoolReadResult, ProviderCredentialRecord } from "../../heart/provider-credentials"

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
import {
  clearProviderReadinessCache,
  readProviderLaneReadiness,
  recordProviderLaneReadiness,
} from "../../heart/provider-readiness-cache"

const timestamp = "2026-04-13T12:00:00.000Z"
const agentName = "slugger"
const createdDirs: string[] = []

function tempBundlesRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-binding-"))
  createdDirs.push(dir)
  return dir
}

function agentRootFor(bundlesRoot: string): string {
  return path.join(bundlesRoot, `${agentName}.ouro`)
}

function writeAgentConfig(bundlesRoot: string, config: Record<string, unknown> = {}): string {
  const agentRoot = agentRootFor(bundlesRoot)
  fs.mkdirSync(agentRoot, { recursive: true })
  const agentJson = {
    version: 2,
    enabled: true,
    humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    agentFacing: { provider: "openai-codex", model: "gpt-5.5" },
    phrases: { thinking: ["thinking"], tool: ["tool"], followup: ["followup"] },
    ...config,
  }
  fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify(agentJson, null, 2)}\n`, "utf8")
  return agentRoot
}

function record(provider: AgentProvider, revision = `vault_${provider}`): ProviderCredentialRecord {
  return {
    provider,
    revision,
    updatedAt: timestamp,
    credentials: provider === "openai-codex" ? { oauthAccessToken: "codex-token" } : { apiKey: `${provider}-key` },
    config: {},
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

function failedPool(reason: "invalid" | "unavailable" | "missing" = "invalid"): ProviderCredentialPoolReadResult {
  return {
    ok: false,
    reason,
    poolPath: "vault:slugger:providers/*",
    error: `${reason} pool`,
  }
}

describe("effective provider binding resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearProviderReadinessCache()
  })

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("normalizes current and legacy lane selectors", () => {
    expect(normalizeProviderLane("outward")).toEqual({ lane: "outward", warnings: [] })
    expect(normalizeProviderLane("inner")).toEqual({ lane: "inner", warnings: [] })
    expect(normalizeProviderLane("human")).toMatchObject({ lane: "outward", warnings: [{ code: "legacy-lane-selector" }] })
    expect(normalizeProviderLane("humanFacing")).toMatchObject({ lane: "outward", warnings: [{ code: "legacy-lane-selector" }] })
    expect(normalizeProviderLane("agent")).toMatchObject({ lane: "inner", warnings: [{ code: "legacy-lane-selector" }] })
    expect(normalizeProviderLane("agentFacing")).toMatchObject({ lane: "inner", warnings: [{ code: "legacy-lane-selector" }] })
  })

  it("resolves provider/model from agent.json and redacts credentials", () => {
    const bundlesRoot = tempBundlesRoot()
    const agentRoot = writeAgentConfig(bundlesRoot)
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue(okPool({
      minimax: record("minimax", "vault_minimax"),
    }))

    const result = resolveEffectiveProviderBinding({
      agentName,
      agentRoot,
      lane: "human",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        lane: "outward",
        provider: "minimax",
        model: "MiniMax-M2.5",
        source: "agent.json",
        credential: {
          status: "present",
          revision: "vault_minimax",
          credentialFields: ["apiKey"],
          configFields: [],
        },
        readiness: { status: "unknown" },
        warnings: [{ code: "legacy-lane-selector" }],
      },
    })
    expect(JSON.stringify(result)).not.toContain("minimax-key")
  })

  it("surfaces missing and unreadable agent.json as invalid config", () => {
    const bundlesRoot = tempBundlesRoot()
    const missingRoot = agentRootFor(bundlesRoot)

    expect(resolveEffectiveProviderBinding({
      agentName,
      agentRoot: missingRoot,
      lane: "outward",
    })).toMatchObject({
      ok: false,
      lane: "outward",
      reason: "agent-config-invalid",
      warnings: [{ code: "agent-config-invalid" }],
      repair: {
        command: "ouro use --agent slugger --lane outward --provider <provider> --model <model>",
      },
    })

    const invalidRoot = writeAgentConfig(bundlesRoot, {
      humanFacing: { provider: "minimax", model: "" },
    })
    expect(resolveEffectiveProviderBinding({
      agentName,
      agentRoot: invalidRoot,
      lane: "outward",
    })).toMatchObject({
      ok: false,
      reason: "agent-config-invalid",
      error: "humanFacing.model must be a non-empty string",
    })

    writeAgentConfig(bundlesRoot, {
      humanFacing: { provider: "minimax", model: 42 },
    })
    expect(resolveEffectiveProviderBinding({
      agentName,
      agentRoot: invalidRoot,
      lane: "outward",
    })).toMatchObject({
      ok: false,
      reason: "agent-config-invalid",
      error: "humanFacing.model must be a non-empty string",
    })

    writeAgentConfig(bundlesRoot, {
      humanFacing: { provider: "fake-provider", model: "MiniMax-M2.5" },
    })
    expect(resolveEffectiveProviderBinding({
      agentName,
      agentRoot: invalidRoot,
      lane: "outward",
    })).toMatchObject({
      ok: false,
      reason: "agent-config-invalid",
      error: expect.stringContaining("unsupported provider 'fake-provider'"),
    })
  })

  it("marks readiness unknown when credentials are missing or unavailable", () => {
    const bundlesRoot = tempBundlesRoot()
    const agentRoot = writeAgentConfig(bundlesRoot)

    mockProviderCredentials.readProviderCredentialPool.mockReturnValueOnce(okPool({}))
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        credential: { status: "missing" },
        readiness: { status: "unknown", reason: "credential-missing" },
        warnings: [{ code: "credential-missing" }],
      },
    })

    mockProviderCredentials.readProviderCredentialPool.mockReturnValueOnce(failedPool("unavailable"))
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        credential: { status: "invalid-pool", error: "unavailable pool" },
        readiness: { status: "unknown", reason: "credential-pool-invalid" },
        warnings: [{ code: "credential-pool-invalid" }],
      },
    })

    mockProviderCredentials.readProviderCredentialPool.mockReturnValueOnce(failedPool("missing"))
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        credential: { status: "missing" },
        readiness: { status: "unknown", reason: "credential-missing" },
      },
    })
  })

  it("uses matching in-memory live-check readiness without persisting readiness", () => {
    const bundlesRoot = tempBundlesRoot()
    const agentRoot = writeAgentConfig(bundlesRoot)
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue(okPool({
      minimax: record("minimax", "vault_minimax"),
    }))
    recordProviderLaneReadiness({
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "vault_minimax",
      status: "ready",
      checkedAt: timestamp,
      attempts: 1,
    })

    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        readiness: { status: "ready", checkedAt: timestamp, attempts: 1 },
      },
    })

    recordProviderLaneReadiness({
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "other-model",
      credentialRevision: "vault_minimax",
      status: "failed",
      checkedAt: timestamp,
      error: "wrong model",
    })
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        readiness: { status: "unknown" },
      },
    })

    recordProviderLaneReadiness({
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "vault_minimax",
      status: "failed",
      checkedAt: timestamp,
      error: "expired",
    })
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        readiness: { status: "failed", checkedAt: timestamp, error: "expired" },
      },
    })
  })

  it("keeps provider readiness exact-match and in-memory only", () => {
    const entry = {
      agentName,
      lane: "inner" as const,
      provider: "openai-codex" as const,
      model: "gpt-5.5",
      credentialRevision: "vault_codex",
      status: "failed" as const,
      checkedAt: timestamp,
      error: "expired",
    }

    expect(readProviderLaneReadiness(entry)).toBeNull()
    recordProviderLaneReadiness(entry)

    expect(readProviderLaneReadiness(entry)).toEqual(entry)
    expect(readProviderLaneReadiness({ ...entry, provider: "minimax" })).toBeNull()
    expect(readProviderLaneReadiness({ ...entry, model: "gpt-5.4" })).toBeNull()
    expect(readProviderLaneReadiness({ ...entry, credentialRevision: "vault_new" })).toBeNull()
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "config/identity",
      event: "config.provider_readiness_recorded",
    }))
  })
})
