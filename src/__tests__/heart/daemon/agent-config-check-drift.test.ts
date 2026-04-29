/**
 * Unit 3a: tests for `checkAgentConfigWithProviderHealth` integrating drift
 * detection. The function gains an additive `driftFindings: DriftFinding[]`
 * field on its result so callers (Layer 4 rollup, Layer 3 RepairGuide) can
 * see per-lane intent-vs-observed mismatches without changing the existing
 * `ok`/`error`/`fix` contract.
 *
 * Pinned behavior:
 * - Healthy agent + agent.json matches state/providers.json → driftFindings: [].
 * - Healthy agent + intent/observed mismatch → driftFindings has one entry,
 *   reason="provider-model-changed", repairCommand populated.
 * - Agent missing from state/providers.json (fresh install): the existing
 *   bootstrap path writes a fresh state matching intent, so by the time
 *   drift detection runs, intent and observed match → driftFindings: [].
 * - agent.json provider-lane parse failure: the existing error path returns
 *   ok=false, no driftFindings field (drift detection never ran).
 * - Drift detection is advisory: it does NOT flip the `ok` flag. A healthy
 *   live-ping with drift still returns `ok: true`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"

const providerPingMock = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const))
const refreshProviderCredentialPoolMock = vi.hoisted(() => vi.fn())

vi.mock("fs")
vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: (provider: string, config: Record<string, unknown>, options?: Record<string, unknown>) =>
    providerPingMock(provider, config, options),
}))
vi.mock("../../../heart/provider-credentials", () => ({
  providerCredentialMachineHomeDir: (homeDir?: string) => homeDir ?? "/home/test",
  refreshProviderCredentialPool: (...args: unknown[]) => refreshProviderCredentialPoolMock(...args),
}))

import { checkAgentConfigWithProviderHealth } from "../../../heart/daemon/agent-config-check"

const mockReadFileSync = vi.mocked(fs.readFileSync)
const mockExistsSync = vi.mocked(fs.existsSync)

const BUNDLES = "/bundles"
const TS = "2026-04-28T19:30:00.000Z"

function agentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    ...overrides,
  })
}

function providerStateJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    machineId: "machine_test",
    updatedAt: TS,
    lanes: {
      outward: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        source: "bootstrap",
        updatedAt: TS,
      },
      inner: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        source: "bootstrap",
        updatedAt: TS,
      },
    },
    readiness: {},
    ...overrides,
  })
}

function providerRecord(provider: string, fields: {
  credentials?: Record<string, unknown>
  config?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    provider,
    revision: `cred_${provider.replace(/[^a-z]/g, "_")}`,
    updatedAt: TS,
    credentials: fields.credentials ?? {},
    config: fields.config ?? {},
    provenance: {
      source: "manual",
      updatedAt: TS,
    },
  }
}

function credentialPool(providers: Record<string, Record<string, unknown>>) {
  return {
    ok: true,
    poolPath: "vault:myagent:providers/*",
    pool: {
      schemaVersion: 1,
      updatedAt: TS,
      providers,
    },
  } as const
}

function mockAgentAndProviderState(input: {
  agentConfig?: string
  providerState?: string
  providerStateExists?: boolean
} = {}): void {
  const stateExists = input.providerStateExists ?? true
  mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
    const p = String(filePath)
    if (p.endsWith("/state/providers.json")) return stateExists
    return false
  })
  mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
    const p = String(filePath)
    if (p === path.join(BUNDLES, "myagent.ouro", "agent.json")) {
      return input.agentConfig ?? agentJson()
    }
    if (p === path.join(BUNDLES, "myagent.ouro", "state", "providers.json")) {
      if (!stateExists) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
      }
      return input.providerState ?? providerStateJson()
    }
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
  })
}

describe("checkAgentConfigWithProviderHealth: drift detection integration (Unit 3a)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerPingMock.mockResolvedValue({ ok: true })
    refreshProviderCredentialPoolMock.mockResolvedValue(credentialPool({
      anthropic: providerRecord("anthropic", { credentials: { setupToken: "tok" } }),
    }))
  })

  it("emits driftFindings: [] when agent is healthy and agent.json matches state", async () => {
    mockAgentAndProviderState({
      agentConfig: agentJson(),
      providerState: providerStateJson(),
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, {
      recordReadiness: false,
    })

    expect(result.ok).toBe(true)
    expect(result.driftFindings).toEqual([])
  })

  it("emits a drift finding when agent.json's outward lane disagrees with state/providers.json", async () => {
    mockAgentAndProviderState({
      // intent: outward = openai/claude-opus-4-7
      agentConfig: agentJson({
        humanFacing: { provider: "openai", model: "claude-opus-4-7" },
      }),
      // observed: outward = anthropic/claude-opus-4-6 (from default state)
      providerState: providerStateJson(),
    })
    // Provide credentials for both providers since the live-check pings the
    // observed provider (anthropic) for outward AND inner. Drift is a
    // separate signal — it does NOT change which provider gets pinged.
    refreshProviderCredentialPoolMock.mockResolvedValue(credentialPool({
      anthropic: providerRecord("anthropic", { credentials: { setupToken: "tok" } }),
      openai: providerRecord("openai", { credentials: { setupToken: "tok" } }),
    }))

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, {
      recordReadiness: false,
    })

    expect(result.ok).toBe(true)
    expect(result.driftFindings).toBeDefined()
    expect(result.driftFindings).toHaveLength(1)
    const finding = result.driftFindings![0]
    expect(finding.lane).toBe("outward")
    expect(finding.intentProvider).toBe("openai")
    expect(finding.intentModel).toBe("claude-opus-4-7")
    expect(finding.observedProvider).toBe("anthropic")
    expect(finding.observedModel).toBe("claude-opus-4-6")
    expect(finding.reason).toBe("provider-model-changed")
    expect(finding.repairCommand).toBe(
      "ouro use --agent myagent --lane outward --provider openai --model claude-opus-4-7",
    )
  })

  it("emits driftFindings: [] when state/providers.json is missing (fresh install bootstraps to match intent)", async () => {
    // The existing bootstrap path writes a fresh state matching agent.json
    // intent. By the time drift detection runs, the comparison is intent
    // vs the just-written state — they match — so driftFindings is [].
    mockAgentAndProviderState({
      agentConfig: agentJson(),
      providerStateExists: false,
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, {
      recordReadiness: false,
    })

    expect(result.ok).toBe(true)
    expect(result.driftFindings).toEqual([])
  })

  it("returns ok=false without driftFindings when agent.json is missing humanFacing.provider", async () => {
    // Lane parse failure: existing error path fires before drift detection
    // can run. driftFindings is undefined (drift detection never ran).
    mockAgentAndProviderState({
      // No humanFacing/agentFacing — bootstrap will fail.
      agentConfig: JSON.stringify({}),
      providerStateExists: false,
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, {
      recordReadiness: false,
    })

    expect(result.ok).toBe(false)
    expect(result.driftFindings).toBeUndefined()
  })

  it("emits drift findings on BOTH lanes when both have intent/observed mismatch", async () => {
    mockAgentAndProviderState({
      agentConfig: agentJson({
        humanFacing: { provider: "openai", model: "claude-opus-4-7" },
        agentFacing: { provider: "minimax", model: "minimax-m2.5" },
      }),
      providerState: providerStateJson(),
    })
    refreshProviderCredentialPoolMock.mockResolvedValue(credentialPool({
      anthropic: providerRecord("anthropic", { credentials: { setupToken: "tok" } }),
    }))

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, {
      recordReadiness: false,
    })

    expect(result.ok).toBe(true)
    expect(result.driftFindings).toHaveLength(2)
    const lanes = result.driftFindings!.map((finding) => finding.lane).sort()
    expect(lanes).toEqual(["inner", "outward"])
  })

  it("does not flip ok=false when drift is detected (drift is advisory)", async () => {
    mockAgentAndProviderState({
      agentConfig: agentJson({
        humanFacing: { provider: "openai", model: "claude-opus-4-7" },
      }),
      providerState: providerStateJson(),
    })
    refreshProviderCredentialPoolMock.mockResolvedValue(credentialPool({
      anthropic: providerRecord("anthropic", { credentials: { setupToken: "tok" } }),
    }))

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, {
      recordReadiness: false,
    })

    expect(result.ok).toBe(true)
    expect(result.driftFindings!.length).toBeGreaterThan(0)
  })
})
