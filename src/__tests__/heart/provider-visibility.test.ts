import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderCredentialPoolReadResult } from "../../heart/provider-credentials"
import { writeProviderState, type ProviderState } from "../../heart/provider-state"

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

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
}))

const cleanup: string[] = []

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

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
        credentialRevision: "vault_minimax_1",
        attempts: 1,
      },
      inner: {
        status: "failed",
        provider: "openai-codex",
        model: "gpt-5.4",
        checkedAt: "2026-04-12T23:23:00.000Z",
        credentialRevision: "vault_codex_1",
        error: "400 status code",
        attempts: 3,
      },
    },
    ...overrides,
  }
}

function credentialPool(): ProviderCredentialPoolReadResult {
  return {
    ok: true,
    poolPath: "vault:slugger:providers/*",
    pool: {
      schemaVersion: 1,
      updatedAt: "2026-04-12T23:20:00.000Z",
      providers: {
        minimax: {
          provider: "minimax",
          revision: "vault_minimax_1",
          updatedAt: "2026-04-12T23:20:00.000Z",
          credentials: { apiKey: "minimax-secret-value" },
          config: {},
          provenance: { source: "auth-flow", updatedAt: "2026-04-12T23:20:00.000Z" },
        },
        "openai-codex": {
          provider: "openai-codex",
          revision: "vault_codex_1",
          updatedAt: "2026-04-12T23:20:00.000Z",
          credentials: { oauthAccessToken: "codex-secret-value" },
          config: {},
          provenance: { source: "manual", updatedAt: "2026-04-12T23:20:00.000Z" },
        },
      },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProviderCredentials.readProviderCredentialPool.mockReturnValue(credentialPool())
})

afterEach(() => {
  while (cleanup.length > 0) {
    const entry = cleanup.pop()
    if (entry) fs.rmSync(entry, { recursive: true, force: true })
  }
})

describe("provider visibility", () => {
  it("builds safe lane visibility from local provider state and vault credentials", async () => {
    emitTestEvent("provider visibility safe lane test")
    const agentRoot = path.join(makeTempDir("provider-visibility-bundles"), "slugger.ouro")
    writeProviderState(agentRoot, providerState())

    const { buildAgentProviderVisibility, formatAgentProviderVisibilityForPrompt } = await import("../../heart/provider-visibility")
    const visibility = buildAgentProviderVisibility({ agentName: "slugger", agentRoot })
    const rendered = formatAgentProviderVisibilityForPrompt(visibility)

    expect(visibility.lanes.map((lane) => `${lane.lane}:${lane.provider}:${lane.model}:${lane.readiness.status}`)).toEqual([
      "outward:minimax:MiniMax-M2.5:ready",
      "inner:openai-codex:gpt-5.4:failed",
    ])
    expect(rendered).toContain("outward: minimax / MiniMax-M2.5")
    expect(rendered).toContain("inner: openai-codex / gpt-5.4")
    expect(rendered).toContain("credentials: auth-flow")
    expect(rendered).toContain("credentials: manual")
    expect(rendered).toContain("failed: 400 status code")
    expect(JSON.stringify(visibility)).not.toContain("secret-value")
    expect(rendered).not.toContain("secret-value")
  })

  it("renders missing provider state as an explicit ouro use repair", async () => {
    emitTestEvent("provider visibility missing state repair test")
    const agentRoot = path.join(makeTempDir("provider-visibility-missing"), "slugger.ouro")

    const { buildAgentProviderVisibility, formatAgentProviderVisibilityForPrompt } = await import("../../heart/provider-visibility")
    const visibility = buildAgentProviderVisibility({ agentName: "slugger", agentRoot })
    const rendered = formatAgentProviderVisibilityForPrompt(visibility)

    expect(visibility.lanes.every((lane) => lane.status === "unconfigured")).toBe(true)
    expect(rendered).toContain("provider bindings are not configured on this machine")
    expect(rendered).toContain("ouro use --agent slugger --lane outward --provider <provider> --model <model>")
    expect(rendered).toContain("ouro use --agent slugger --lane inner --provider <provider> --model <model>")
  })

  it("renders configured lanes with missing vault credentials as explicit auth repairs", async () => {
    emitTestEvent("provider visibility missing credential repair test")
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue({
      ok: true,
      poolPath: "vault:slugger:providers/*",
      pool: { schemaVersion: 1, updatedAt: "2026-04-12T23:20:00.000Z", providers: {} },
    } satisfies ProviderCredentialPoolReadResult)
    const agentRoot = path.join(makeTempDir("provider-visibility-configured"), "slugger.ouro")
    writeProviderState(agentRoot, providerState())

    const { buildAgentProviderVisibility, formatAgentProviderVisibilityForPrompt, providerVisibilityStatusRows } = await import("../../heart/provider-visibility")
    const visibility = buildAgentProviderVisibility({ agentName: "slugger", agentRoot })
    const rendered = formatAgentProviderVisibilityForPrompt(visibility)
    const rows = providerVisibilityStatusRows(visibility)

    expect(visibility.lanes[0]).toMatchObject({
      lane: "outward",
      status: "configured",
      credential: {
        status: "missing",
        repairCommand: "ouro auth --agent slugger --provider minimax",
      },
      warnings: ["minimax has no credential record in the agent vault."],
    })
    expect(rendered).toContain("credentials: missing")
    expect(rendered).toContain("repair: ouro auth --agent slugger --provider minimax")
    expect(rows[1]).toMatchObject({
      agent: "slugger",
      lane: "inner",
      credential: "missing",
    })
    expect(rows[1]).not.toHaveProperty("detail")
  })

  it("omits absent readiness optional fields from built visibility", async () => {
    emitTestEvent("provider visibility absent readiness optionals")
    const agentRoot = path.join(makeTempDir("provider-visibility-optionals"), "slugger.ouro")
    writeProviderState(agentRoot, providerState({
      readiness: {
        outward: {
          status: "ready",
          provider: "minimax",
          model: "MiniMax-M2.5",
          credentialRevision: "vault_minimax_1",
        },
        inner: {
          status: "failed",
          provider: "openai-codex",
          model: "gpt-5.4",
          credentialRevision: "vault_codex_1",
        },
      },
    }))

    const { buildAgentProviderVisibility } = await import("../../heart/provider-visibility")
    const visibility = buildAgentProviderVisibility({ agentName: "slugger", agentRoot })

    expect(visibility.lanes[0].readiness).toEqual({ status: "ready" })
    expect(visibility.lanes[1].readiness).toEqual({ status: "failed" })
  })

  it("formats readiness and credential edge states without exposing credentials", async () => {
    emitTestEvent("provider visibility formatting edge states")
    const {
      formatProviderVisibilityLine,
      isAgentProviderVisibility,
      providerVisibilityStatusRows,
    } = await import("../../heart/provider-visibility")

    const presentVaultLine = formatProviderVisibilityLine({
      lane: "outward",
      status: "configured",
      provider: "minimax",
      model: "MiniMax-M2.5",
      source: "local",
      readiness: { status: "failed" },
      credential: { status: "present", revision: "vault_mm" },
      warnings: [],
    })
    expect(presentVaultLine).toContain("failed")
    expect(presentVaultLine).toContain("credentials: vault")

    expect(formatProviderVisibilityLine({
      lane: "inner",
      status: "configured",
      provider: "anthropic",
      model: "claude-opus-4-6",
      source: "bootstrap",
      readiness: { status: "stale", reason: "model changed" },
      credential: { status: "invalid-pool", error: "vault locked" },
      warnings: [],
    })).toContain("stale: model changed")
    expect(formatProviderVisibilityLine({
      lane: "inner",
      status: "configured",
      provider: "anthropic",
      model: "claude-opus-4-6",
      source: "bootstrap",
      readiness: { status: "stale" },
      credential: { status: "missing", repairCommand: "ouro auth --agent slugger --provider anthropic" },
      warnings: ["missing credential"],
    })).toContain("stale")
    expect(formatProviderVisibilityLine({
      lane: "inner",
      status: "configured",
      provider: "azure",
      model: "gpt-4o",
      source: "local",
      readiness: { status: "unknown", reason: "not checked" },
      credential: { status: "present", source: "manual" },
      warnings: [],
    })).toContain("unknown: not checked")
    expect(formatProviderVisibilityLine({
      lane: "inner",
      status: "configured",
      provider: "azure",
      model: "gpt-4o",
      source: "local",
      readiness: { status: "unknown" },
      credential: { status: "present", source: "manual" },
      warnings: [],
    })).toContain("unknown")

    const rows = providerVisibilityStatusRows({
      agentName: "slugger",
      lanes: [
        {
          lane: "outward",
          status: "configured",
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "local",
          readiness: { status: "ready" },
          credential: { status: "present" },
          warnings: [],
        },
      ],
    })
    expect(rows[0]).toMatchObject({ credential: "vault", readiness: "ready" })

    const failedPresentRows = providerVisibilityStatusRows({
      agentName: "slugger",
      lanes: [
        {
          lane: "inner",
          status: "configured",
          provider: "openai-codex",
          model: "gpt-5.4",
          source: "local",
          readiness: { status: "failed", error: "current ping failure" },
          credential: { status: "present", source: "manual" },
          warnings: [],
        },
      ],
    })
    expect(failedPresentRows[0]).toMatchObject({ credential: "manual", detail: "current ping failure" })

    const invalidCredentialRows = providerVisibilityStatusRows({
      agentName: "slugger",
      lanes: [
        {
          lane: "inner",
          status: "configured",
          provider: "openai-codex",
          model: "gpt-5.4",
          source: "bootstrap",
          readiness: { status: "stale", error: "old ping failure", reason: "credential-pool-invalid" },
          credential: { status: "invalid-pool", repairCommand: "ouro auth --agent slugger --provider openai-codex" },
          warnings: [],
        },
      ],
    })
    expect(invalidCredentialRows[0]).toMatchObject({ credential: "vault unavailable", readiness: "stale" })
    expect(invalidCredentialRows[0]).not.toHaveProperty("detail")

    expect(isAgentProviderVisibility({ agentName: "slugger", lanes: [{ lane: "outward", status: "configured" }] })).toBe(true)
    expect(isAgentProviderVisibility(null)).toBe(false)
    expect(isAgentProviderVisibility([])).toBe(false)
    expect(isAgentProviderVisibility({ agentName: 42, lanes: [] })).toBe(false)
    expect(isAgentProviderVisibility({ agentName: "slugger", lanes: "nope" })).toBe(false)
    expect(isAgentProviderVisibility({ agentName: "slugger", lanes: [null] })).toBe(false)
    expect(isAgentProviderVisibility({ agentName: "slugger", lanes: [[]] })).toBe(false)
    expect(isAgentProviderVisibility({ agentName: "slugger", lanes: [{ lane: "sideways", status: "configured" }] })).toBe(false)
    expect(isAgentProviderVisibility({ agentName: "slugger", lanes: [{ lane: "inner", status: "ready" }] })).toBe(false)
  })
})
