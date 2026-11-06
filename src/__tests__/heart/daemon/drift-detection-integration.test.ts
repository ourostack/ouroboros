/**
 * Unit 5: end-to-end fixture-driven integration test for Layer 4 drift
 * detection. Creates a real bundle directory on disk with `agent.json`
 * + `state/providers.json`, runs `checkAgentConfigWithProviderHealth`
 * with a stubbed provider ping, and asserts the resulting drift
 * findings + the rolled-up daemon status.
 *
 * Structural precedent: `serpentguide-bootstrap.test.ts` for the
 * fixture-on-disk pattern.
 *
 * This test deliberately does NOT mock fs — it exercises the real
 * read paths (`readProviderState`, the agent.json reader in
 * drift-detection.ts) so the loader's tolerance for legacy/new key
 * names is verified with real data on disk, not a unit-test fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { computeDaemonRollup } from "../../../heart/daemon/daemon-rollup"

const TS = "2026-04-28T19:30:00.000Z"

// Pin a fake provider credential pool — the live ping path expects to
// read a credential pool, but for drift detection we only care about
// the comparator and rollup output. Stubbing here keeps the fixture
// focused on the agent.json ↔ providers.json drift case.
const refreshProviderCredentialPoolMock = vi.hoisted(() => vi.fn())

vi.mock("../../../heart/provider-credentials", () => ({
  providerCredentialMachineHomeDir: (homeDir?: string) => homeDir ?? "/home/test",
  refreshProviderCredentialPool: (...args: unknown[]) => refreshProviderCredentialPoolMock(...args),
}))

vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: vi.fn(async () => ({ ok: true })),
}))

// nerves runtime: silence event emission so the test output is clean.
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { checkAgentConfigWithProviderHealth } from "../../../heart/daemon/agent-config-check"

describe("Layer 4 drift detection — integration fixture (Unit 5)", () => {
  let tmpRoot: string
  let bundlesRoot: string
  let agentRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "drift-integration-"))
    bundlesRoot = path.join(tmpRoot, "AgentBundles")
    agentRoot = path.join(bundlesRoot, "slugger.ouro")
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.mkdirSync(path.join(agentRoot, "state"), { recursive: true })
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: true,
      poolPath: "vault:slugger:providers/*",
      pool: {
        schemaVersion: 1,
        updatedAt: TS,
        providers: {
          anthropic: {
            provider: "anthropic",
            revision: "rev_anthropic",
            updatedAt: TS,
            credentials: { setupToken: "tok" },
            config: {},
            provenance: { source: "manual", updatedAt: TS },
          },
          openai: {
            provider: "openai",
            revision: "rev_openai",
            updatedAt: TS,
            credentials: { setupToken: "tok" },
            config: {},
            provenance: { source: "manual", updatedAt: TS },
          },
          minimax: {
            provider: "minimax",
            revision: "rev_minimax",
            updatedAt: TS,
            credentials: { apiKey: "tok" },
            config: {},
            provenance: { source: "manual", updatedAt: TS },
          },
        },
      },
    })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function writeAgent(content: Record<string, unknown>): void {
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify(content), "utf-8")
  }

  function writeState(content: Record<string, unknown>): void {
    fs.writeFileSync(path.join(agentRoot, "state", "providers.json"), JSON.stringify(content), "utf-8")
  }

  function laneBinding(provider: string, model: string) {
    return { provider, model, source: "bootstrap", updatedAt: TS }
  }

  it("emits a drift finding and the daemon rollup downgrades to 'partial' when intent ≠ observed", async () => {
    writeAgent({
      version: 2,
      enabled: true,
      humanFacing: { provider: "openai", model: "claude-opus-4-7" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["t"] },
    })
    writeState({
      schemaVersion: 1,
      machineId: "machine_test",
      updatedAt: TS,
      lanes: {
        outward: laneBinding("anthropic", "claude-opus-4-6"),
        inner: laneBinding("anthropic", "claude-opus-4-6"),
      },
      readiness: {},
    })

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, {
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
      "ouro use --agent slugger --lane outward --provider openai --model claude-opus-4-7",
    )

    // Rollup downgrade: a single agent that's running with drift → partial.
    const rollup = computeDaemonRollup({
      enabledAgents: [{ name: "slugger", status: "running" }],
      bootstrapDegraded: [],
      safeMode: false,
      driftDetected: result.driftFindings!.length > 0,
    })
    expect(rollup).toBe("partial")
  })

  it("emits no drift findings when intent matches observed; rollup stays 'healthy'", async () => {
    writeAgent({
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["t"] },
    })
    writeState({
      schemaVersion: 1,
      machineId: "machine_test",
      updatedAt: TS,
      lanes: {
        outward: laneBinding("anthropic", "claude-opus-4-6"),
        inner: laneBinding("anthropic", "claude-opus-4-6"),
      },
      readiness: {},
    })

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, {
      recordReadiness: false,
    })

    expect(result.ok).toBe(true)
    expect(result.driftFindings).toEqual([])

    const rollup = computeDaemonRollup({
      enabledAgents: [{ name: "slugger", status: "running" }],
      bootstrapDegraded: [],
      safeMode: false,
      driftDetected: false,
    })
    expect(rollup).toBe("healthy")
  })

  it("emits drift on both lanes when both have intent/observed mismatch", async () => {
    writeAgent({
      version: 2,
      enabled: true,
      humanFacing: { provider: "openai", model: "claude-opus-4-7" },
      agentFacing: { provider: "minimax", model: "minimax-m2.5" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["t"] },
    })
    writeState({
      schemaVersion: 1,
      machineId: "machine_test",
      updatedAt: TS,
      lanes: {
        outward: laneBinding("anthropic", "claude-opus-4-6"),
        inner: laneBinding("anthropic", "claude-opus-4-6"),
      },
      readiness: {},
    })

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, {
      recordReadiness: false,
    })

    expect(result.ok).toBe(true)
    expect(result.driftFindings).toHaveLength(2)
    const lanes = result.driftFindings!.map((f) => f.lane).sort()
    expect(lanes).toEqual(["inner", "outward"])
  })

  it("preserves the read-only invariant: drift detection does not modify state/providers.json", async () => {
    writeAgent({
      version: 2,
      enabled: true,
      humanFacing: { provider: "openai", model: "claude-opus-4-7" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["t"] },
    })
    const stateContent = {
      schemaVersion: 1,
      machineId: "machine_test",
      updatedAt: TS,
      lanes: {
        outward: laneBinding("anthropic", "claude-opus-4-6"),
        inner: laneBinding("anthropic", "claude-opus-4-6"),
      },
      readiness: {},
    }
    writeState(stateContent)
    const beforeBytes = fs.readFileSync(path.join(agentRoot, "state", "providers.json"), "utf-8")

    await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, {
      recordReadiness: false,
    })

    const afterBytes = fs.readFileSync(path.join(agentRoot, "state", "providers.json"), "utf-8")
    expect(afterBytes).toBe(beforeBytes)
  })
})
