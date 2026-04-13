import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"
import { writeProviderCredentialPool } from "../../heart/provider-credential-pool"
import type { AgentProviderVisibility } from "../../heart/provider-visibility"
import { writeProviderState, type ProviderState } from "../../heart/provider-state"

const cleanup: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  cleanup.push(dir)
  return dir
}

function providerState(overrides: Partial<ProviderState> = {}): ProviderState {
  return {
    schemaVersion: 1,
    machineId: "machine_provider_visibility",
    updatedAt: "2026-04-12T23:20:00.000Z",
    lanes: {
      outward: {
        provider: "minimax",
        model: "MiniMax-M2.5",
        source: "local",
        updatedAt: "2026-04-12T23:20:00.000Z",
      },
      inner: {
        provider: "openai-codex",
        model: "gpt-5.4",
        source: "local",
        updatedAt: "2026-04-12T23:21:00.000Z",
      },
    },
    readiness: {
      outward: {
        status: "ready",
        provider: "minimax",
        model: "MiniMax-M2.5",
        checkedAt: "2026-04-12T23:22:00.000Z",
        credentialRevision: "cred_minimax_1",
        attempts: 1,
      },
      inner: {
        status: "failed",
        provider: "openai-codex",
        model: "gpt-5.4",
        checkedAt: "2026-04-12T23:23:00.000Z",
        credentialRevision: "cred_codex_1",
        error: "400 status code",
        attempts: 3,
      },
    },
    ...overrides,
  }
}

afterEach(() => {
  while (cleanup.length > 0) {
    const entry = cleanup.pop()
    if (entry) fs.rmSync(entry, { recursive: true, force: true })
  }
})

describe("provider visibility", () => {
  it("builds safe lane visibility from local provider state and machine credentials", async () => {
    emitNervesEvent({
      component: "heart",
      event: "heart.test_provider_visibility",
      message: "provider visibility safe lane test",
      meta: { test: true },
    })
    const homeDir = makeTempDir("provider-visibility-home")
    const agentRoot = path.join(makeTempDir("provider-visibility-bundles"), "slugger.ouro")
    writeProviderState(agentRoot, providerState())
    writeProviderCredentialPool(homeDir, {
      schemaVersion: 1,
      updatedAt: "2026-04-12T23:20:00.000Z",
      providers: {
        minimax: {
          provider: "minimax",
          revision: "cred_minimax_1",
          updatedAt: "2026-04-12T23:20:00.000Z",
          credentials: { apiKey: "minimax-secret-value" },
          config: {},
          provenance: {
            source: "auth-flow",
            contributedByAgent: "slugger",
            updatedAt: "2026-04-12T23:20:00.000Z",
          },
        },
        "openai-codex": {
          provider: "openai-codex",
          revision: "cred_codex_1",
          updatedAt: "2026-04-12T23:20:00.000Z",
          credentials: { oauthAccessToken: "codex-secret-value" },
          config: {},
          provenance: {
            source: "legacy-agent-secrets",
            contributedByAgent: "kicker",
            updatedAt: "2026-04-12T23:20:00.000Z",
          },
        },
      },
    })

    const { buildAgentProviderVisibility, formatAgentProviderVisibilityForPrompt } = await import("../../heart/provider-visibility")
    const visibility = buildAgentProviderVisibility({ agentName: "slugger", agentRoot, homeDir })
    const rendered = formatAgentProviderVisibilityForPrompt(visibility)

    expect(visibility.lanes.map((lane) => `${lane.lane}:${lane.provider}:${lane.model}:${lane.readiness.status}`)).toEqual([
      "outward:minimax:MiniMax-M2.5:ready",
      "inner:openai-codex:gpt-5.4:failed",
    ])
    expect(rendered).toContain("outward: minimax / MiniMax-M2.5")
    expect(rendered).toContain("inner: openai-codex / gpt-5.4")
    expect(rendered).toContain("credentials: auth-flow from slugger")
    expect(rendered).toContain("credentials: legacy-agent-secrets from kicker")
    expect(rendered).toContain("failed: 400 status code")
    expect(JSON.stringify(visibility)).not.toContain("secret-value")
    expect(rendered).not.toContain("secret-value")
    expect(rendered).not.toContain(homeDir)
  })

  it("renders missing provider state as an explicit ouro use repair, not a raw agent.json fallback", async () => {
    emitNervesEvent({
      component: "heart",
      event: "heart.test_provider_visibility",
      message: "provider visibility missing state repair test",
      meta: { test: true },
    })
    const agentRoot = path.join(makeTempDir("provider-visibility-missing"), "slugger.ouro")

    const { buildAgentProviderVisibility, formatAgentProviderVisibilityForPrompt } = await import("../../heart/provider-visibility")
    const visibility = buildAgentProviderVisibility({ agentName: "slugger", agentRoot, homeDir: makeTempDir("provider-visibility-home") })
    const rendered = formatAgentProviderVisibilityForPrompt(visibility)

    expect(visibility.lanes.every((lane) => lane.status === "unconfigured")).toBe(true)
    expect(rendered).toContain("provider bindings are not configured on this machine")
    expect(rendered).toContain("ouro use --agent slugger --lane outward --provider <provider> --model <model>")
    expect(rendered).toContain("ouro use --agent slugger --lane inner --provider <provider> --model <model>")
    expect(rendered).not.toContain("agentFacing")
    expect(rendered).not.toContain("humanFacing")
  })

  it("renders configured lanes with missing credentials as explicit auth repairs", async () => {
    emitNervesEvent({
      component: "heart",
      event: "heart.test_provider_visibility",
      message: "provider visibility missing credential repair test",
      meta: { test: true },
    })
    const homeDir = makeTempDir("provider-visibility-empty-home")
    const agentRoot = path.join(makeTempDir("provider-visibility-configured"), "slugger.ouro")
    writeProviderState(agentRoot, providerState())

    const { buildAgentProviderVisibility, formatAgentProviderVisibilityForPrompt, providerVisibilityStatusRows } = await import("../../heart/provider-visibility")
    const visibility = buildAgentProviderVisibility({ agentName: "slugger", agentRoot, homeDir })
    const rendered = formatAgentProviderVisibilityForPrompt(visibility)
    const rows = providerVisibilityStatusRows(visibility)

    expect(visibility.lanes[0]).toMatchObject({
      lane: "outward",
      status: "configured",
      credential: {
        status: "missing",
        repairCommand: "ouro auth --agent slugger --provider minimax",
      },
      warnings: ["minimax has no credential record in the machine credential pool."],
    })
    expect(visibility.lanes[1]).toMatchObject({
      lane: "inner",
      status: "configured",
      credential: {
        status: "missing",
        repairCommand: "ouro auth --agent slugger --provider openai-codex",
      },
      warnings: ["openai-codex has no credential record in the machine credential pool."],
    })
    expect(rendered).toContain("credentials: missing")
    expect(rendered).toContain("repair: ouro auth --agent slugger --provider minimax")
    expect(rendered).toContain("warnings: minimax has no credential record in the machine credential pool.")
    expect(rows[1]).toMatchObject({
      agent: "slugger",
      lane: "inner",
      detail: "400 status code",
    })
  })

  it("omits unchecked readiness fields instead of inventing timestamps or attempts", async () => {
    emitNervesEvent({
      component: "heart",
      event: "heart.test_provider_visibility",
      message: "provider visibility unchecked readiness test",
      meta: { test: true },
    })
    const homeDir = makeTempDir("provider-visibility-unchecked-home")
    const agentRoot = path.join(makeTempDir("provider-visibility-unchecked"), "slugger.ouro")
    writeProviderState(agentRoot, providerState({ readiness: {} }))

    const { buildAgentProviderVisibility } = await import("../../heart/provider-visibility")
    const visibility = buildAgentProviderVisibility({ agentName: "slugger", agentRoot, homeDir })

    expect(visibility.lanes[0].readiness).toEqual({
      status: "unknown",
      reason: "credential-missing",
    })
    expect(visibility.lanes[0].readiness).not.toHaveProperty("checkedAt")
    expect(visibility.lanes[0].readiness).not.toHaveProperty("attempts")
  })

  it("formats non-ready and unconfigured edge states for status and prompts", async () => {
    emitNervesEvent({
      component: "heart",
      event: "heart.test_provider_visibility",
      message: "provider visibility formatting edge test",
      meta: { test: true },
    })
    const {
      formatProviderVisibilityLine,
      formatAgentProviderVisibilityForStartOfTurn,
      providerVisibilityStatusRows,
    } = await import("../../heart/provider-visibility")
    const visibility: AgentProviderVisibility = {
      agentName: "slugger",
      lanes: [
        {
          lane: "outward",
          status: "configured",
          provider: "anthropic",
          model: "claude-opus-4-6",
          source: "local",
          readiness: { status: "stale", reason: "credential-revision-changed" },
          credential: { status: "invalid-pool", repairCommand: "ouro auth --agent slugger --provider anthropic" },
          warnings: ["credential pool is invalid"],
        },
        {
          lane: "inner",
          status: "unconfigured",
          provider: "unconfigured",
          model: "-",
          source: "missing",
          readiness: { status: "unknown", reason: "provider-state-missing" },
          credential: { status: "missing", repairCommand: "ouro use --agent slugger --lane inner --provider <provider> --model <model>" },
          repairCommand: "ouro use --agent slugger --lane inner --provider <provider> --model <model>",
          reason: "provider-state-missing",
          warnings: ["missing local binding"],
        },
      ],
    }

    const rendered = formatAgentProviderVisibilityForStartOfTurn(visibility)
    const rows = providerVisibilityStatusRows(visibility)

    expect(rendered).toContain("stale: credential-revision-changed")
    expect(rendered).toContain("credentials: invalid pool")
    expect(rendered).toContain("repair: ouro auth --agent slugger --provider anthropic")
    expect(rendered).toContain("warnings: credential pool is invalid")
    expect(rendered).toContain("inner: unconfigured (provider-state-missing)")
    expect(rows[1]).toMatchObject({
      agent: "slugger",
      lane: "inner",
      provider: "unconfigured",
      detail: "ouro use --agent slugger --lane inner --provider <provider> --model <model>",
      credential: "missing",
    })
    expect(formatProviderVisibilityLine({
      lane: "inner",
      status: "configured",
      provider: "minimax",
      model: "MiniMax-M2.5",
      source: "local",
      readiness: { status: "failed" },
      credential: { status: "present" },
      warnings: [],
    })).toContain("[failed; source: local; credentials: unknown]")
    expect(formatProviderVisibilityLine({
      lane: "inner",
      status: "configured",
      provider: "minimax",
      model: "MiniMax-M2.5",
      source: "local",
      readiness: { status: "stale" },
      credential: { status: "present", source: "manual" },
      warnings: [],
    })).toContain("[stale; source: local; credentials: manual]")
    expect(formatProviderVisibilityLine({
      lane: "inner",
      status: "configured",
      provider: "minimax",
      model: "MiniMax-M2.5",
      source: "local",
      readiness: { status: "unknown" },
      credential: { status: "missing", repairCommand: "ouro auth --agent slugger --provider minimax" },
      warnings: [],
    })).toContain("[unknown; source: local; credentials: missing; repair: ouro auth --agent slugger --provider minimax]")
    expect(formatProviderVisibilityLine({
      lane: "inner",
      status: "configured",
      provider: "minimax",
      model: "MiniMax-M2.5",
      source: "local",
      readiness: { status: "unknown", reason: "credential-missing" },
      credential: { status: "present", source: "auth-flow" },
      warnings: [],
    })).toContain("[unknown: credential-missing; source: local; credentials: auth-flow]")
  })

  it("guards provider visibility payload shape for pulse readers", async () => {
    emitNervesEvent({
      component: "heart",
      event: "heart.test_provider_visibility",
      message: "provider visibility guard test",
      meta: { test: true },
    })
    const { isAgentProviderVisibility } = await import("../../heart/provider-visibility")

    expect(isAgentProviderVisibility(null)).toBe(false)
    expect(isAgentProviderVisibility([])).toBe(false)
    expect(isAgentProviderVisibility({})).toBe(false)
    expect(isAgentProviderVisibility({ agentName: "slugger", lanes: "nope" })).toBe(false)
    expect(isAgentProviderVisibility({ agentName: "slugger", lanes: [null] })).toBe(false)
    expect(isAgentProviderVisibility({ agentName: "slugger", lanes: [{ lane: "sideways", status: "configured" }] })).toBe(false)
    expect(isAgentProviderVisibility({ agentName: "slugger", lanes: [{ lane: "inner", status: "weird" }] })).toBe(false)
    expect(isAgentProviderVisibility({ agentName: "slugger", lanes: [{ lane: "inner", status: "configured" }] })).toBe(true)
  })
})
