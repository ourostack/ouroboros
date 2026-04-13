import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"
import { writeProviderCredentialPool } from "../../heart/provider-credential-pool"
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
})
