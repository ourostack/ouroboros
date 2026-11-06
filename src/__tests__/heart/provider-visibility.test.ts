import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderCredentialPoolReadResult } from "../../heart/provider-credentials"

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

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  cleanup.push(dir)
  return dir
}

function writeAgentConfig(agentRoot: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(agentRoot, { recursive: true })
  const config = {
    version: 2,
    enabled: true,
    humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    agentFacing: { provider: "openai-codex", model: "gpt-5.5" },
    phrases: { thinking: ["thinking"], tool: ["tool"], followup: ["followup"] },
    ...overrides,
  }
  fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8")
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
  it("builds safe lane visibility from agent.json and vault credentials", async () => {
    const agentRoot = path.join(makeTempDir("provider-visibility-bundles"), "slugger.ouro")
    writeAgentConfig(agentRoot)

    const { buildAgentProviderVisibility, formatAgentProviderVisibilityForPrompt } = await import("../../heart/provider-visibility")
    const visibility = buildAgentProviderVisibility({ agentName: "slugger", agentRoot })
    const rendered = formatAgentProviderVisibilityForPrompt(visibility)

    expect(visibility.lanes.map((lane) => `${lane.lane}:${lane.provider}:${lane.model}:${lane.readiness.status}`)).toEqual([
      "outward:minimax:MiniMax-M2.5:unknown",
      "inner:openai-codex:gpt-5.5:unknown",
    ])
    expect(rendered).toContain("runtime uses provider bindings from agent.json")
    expect(rendered).toContain("outward: minimax / MiniMax-M2.5")
    expect(rendered).toContain("inner: openai-codex / gpt-5.5")
    expect(rendered).toContain("credentials: auth-flow")
    expect(rendered).toContain("credentials: manual")
    expect(JSON.stringify(visibility)).not.toContain("secret-value")
    expect(rendered).not.toContain("secret-value")
  })

  it("renders invalid agent config as an explicit ouro use repair", async () => {
    const agentRoot = path.join(makeTempDir("provider-visibility-missing"), "slugger.ouro")

    const { buildAgentProviderVisibility, formatAgentProviderVisibilityForPrompt } = await import("../../heart/provider-visibility")
    const visibility = buildAgentProviderVisibility({ agentName: "slugger", agentRoot })
    const rendered = formatAgentProviderVisibilityForPrompt(visibility)

    expect(visibility.lanes.every((lane) => lane.status === "unconfigured")).toBe(true)
    expect(rendered).toContain("provider bindings are not configured in agent.json")
    expect(rendered).toContain("ouro use --agent slugger --lane outward --provider <provider> --model <model>")
    expect(rendered).toContain("ouro use --agent slugger --lane inner --provider <provider> --model <model>")
  })

  it("renders configured lanes with missing vault credentials as explicit auth repairs", async () => {
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue({
      ok: true,
      poolPath: "vault:slugger:providers/*",
      pool: { schemaVersion: 1, updatedAt: "2026-04-12T23:20:00.000Z", providers: {} },
    } satisfies ProviderCredentialPoolReadResult)
    const agentRoot = path.join(makeTempDir("provider-visibility-configured"), "slugger.ouro")
    writeAgentConfig(agentRoot)

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

  it("does not invent missing credentials when this process has not loaded the vault", async () => {
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue({
      ok: false,
      reason: "missing",
      poolPath: "vault:slugger:providers/*",
      error: "provider credentials have not been loaded from vault",
    } satisfies ProviderCredentialPoolReadResult)
    const agentRoot = path.join(makeTempDir("provider-visibility-not-loaded"), "slugger.ouro")
    writeAgentConfig(agentRoot)

    const { buildAgentProviderVisibility, formatAgentProviderVisibilityForPrompt, providerVisibilityStatusRows } = await import("../../heart/provider-visibility")
    const visibility = buildAgentProviderVisibility({ agentName: "slugger", agentRoot })
    const rendered = formatAgentProviderVisibilityForPrompt(visibility)
    const rows = providerVisibilityStatusRows(visibility)

    expect(visibility.lanes[0]).toMatchObject({
      lane: "outward",
      status: "configured",
      readiness: { status: "unknown" },
      credential: { status: "not-loaded" },
      warnings: [],
    })
    expect(rendered).toContain("credentials: checked previously")
    expect(rendered).not.toContain("credentials: missing")
    expect(rendered).not.toContain("repair: ouro auth")
    expect(rows[0]).toMatchObject({
      agent: "slugger",
      lane: "outward",
      readiness: "unknown",
      credential: "checked previously",
    })
  })

  it("formats readiness and credential edge states without exposing credentials", async () => {
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
      source: "agent.json",
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
      source: "agent.json",
      readiness: { status: "unknown", reason: "not checked" },
      credential: { status: "present", source: "manual" },
      warnings: [],
    })).toContain("unknown: not checked")
    expect(formatProviderVisibilityLine({
      lane: "inner",
      status: "configured",
      provider: "anthropic",
      model: "claude-opus-4-6",
      source: "agent.json",
      readiness: { status: "stale", reason: "credential changed" },
      credential: { status: "present", source: "manual" },
      warnings: [],
    })).toContain("stale: credential changed")
    expect(formatProviderVisibilityLine({
      lane: "inner",
      status: "configured",
      provider: "anthropic",
      model: "claude-opus-4-6",
      source: "agent.json",
      readiness: { status: "stale" },
      credential: { status: "invalid-pool" },
      warnings: [],
    })).toContain("credentials: vault unavailable")
    expect(formatProviderVisibilityLine({
      lane: "inner",
      status: "configured",
      provider: "azure",
      model: "gpt-4o",
      source: "agent.json",
      readiness: { status: "ready" },
      credential: { status: "not-loaded" },
      warnings: [],
    })).toContain("credentials: checked previously")

    const rows = providerVisibilityStatusRows({
      agentName: "slugger",
      lanes: [
        {
          lane: "outward",
          status: "configured",
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "agent.json",
          readiness: { status: "ready" },
          credential: { status: "present" },
          warnings: [],
        },
      ],
    })
    expect(rows[0]).toMatchObject({ credential: "vault", readiness: "ready" })
    expect(providerVisibilityStatusRows({
      agentName: "slugger",
      lanes: [
        {
          lane: "outward",
          status: "configured",
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "agent.json",
          readiness: { status: "failed", error: "bad token" },
          credential: { status: "present" },
          warnings: [],
        },
      ],
    })[0]).toMatchObject({ detail: "bad token" })

    expect(providerVisibilityStatusRows({
      agentName: "slugger",
      lanes: [{
        lane: "outward",
        status: "unconfigured",
        reason: "agent-config-invalid",
        repairCommand: "ouro use --agent slugger --lane outward --provider <provider> --model <model>",
      }],
    })[0]).toMatchObject({
      agent: "slugger",
      lane: "outward",
      provider: "unconfigured",
      detail: "ouro use --agent slugger --lane outward --provider <provider> --model <model>",
    })

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
