import { describe, it, expect, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import {
  buildFailoverContext,
  formatCredentialProvenanceLabel,
  handleFailoverReply,
  runMachineProviderFailoverInventory,
} from "../../heart/provider-failover"
import { writeProviderCredentialPool } from "../../heart/provider-credential-pool"

const models = { anthropic: "claude-opus-4-6", "openai-codex": "gpt-5.4", azure: "gpt-4o-mini", minimax: "minimax-text-01" }

const now = "2026-04-13T05:40:00.000Z"

describe("buildFailoverContext", () => {
  it("builds message with working providers and model info", () => {
    const ctx = buildFailoverContext(
      "exceeded your usage limit",
      "usage-limit",
      "openai-codex",
      "gpt-5.4",
      "slugger",
      {
        anthropic: { ok: true },
        minimax: { ok: false, classification: "auth-failure", message: "no credentials configured" },
        azure: { ok: false, classification: "auth-failure", message: "no credentials configured" },
      },
      models,
    )

    expect(ctx.errorSummary).toBe("openai-codex (gpt-5.4) hit its usage limit")
    expect(ctx.workingProviders).toEqual(["anthropic"])
    expect(ctx.unconfiguredProviders).toContain("minimax")
    expect(ctx.unconfiguredProviders).toContain("azure")
    expect(ctx.userMessage).toContain("switch to anthropic")
    expect(ctx.userMessage).toContain("anthropic (claude-opus-4-6)")
    expect(ctx.userMessage).toContain("ouro auth --agent slugger")
  })

  it("handles multiple working providers", () => {
    const ctx = buildFailoverContext(
      "auth failed",
      "auth-failure",
      "openai-codex",
      "gpt-5.4",
      "slugger",
      {
        anthropic: { ok: true },
        azure: { ok: true },
        minimax: { ok: false, classification: "auth-failure", message: "no credentials configured" },
      },
      models,
    )

    expect(ctx.workingProviders).toEqual(["anthropic", "azure"])
    expect(ctx.userMessage).toContain("switch to anthropic")
    expect(ctx.userMessage).toContain("switch to azure")
    expect(ctx.userMessage).toContain("claude-opus-4-6")
    expect(ctx.userMessage).toContain("gpt-4o-mini")
  })

  it("renders machine-wide ready providers with credential provenance labels", () => {
    const ctx = buildFailoverContext(
      "400 status code (no body)",
      "auth-failure",
      "openai-codex",
      "gpt-5.4",
      "slugger",
      {
        ready: [
          {
            provider: "minimax",
            model: "MiniMax-M2.7",
            credentialRevision: "cred_minimax",
            source: "auth-flow",
            contributedByAgent: "kicker",
            result: { ok: true },
          },
        ],
        unavailable: [
          {
            provider: "anthropic",
            model: "claude-opus-4-6",
            credentialRevision: "cred_anthropic",
            source: "legacy-agent-secrets",
            contributedByAgent: "slugger",
            result: { ok: false, classification: "auth-failure", message: "expired" },
          },
        ],
        unconfigured: ["azure"],
      } as any,
      {},
    )

    expect(ctx.workingProviders).toEqual(["minimax"])
    expect((ctx as any).readyProviders).toEqual([
      expect.objectContaining({
        provider: "minimax",
        model: "MiniMax-M2.7",
        source: "auth-flow",
        contributedByAgent: "kicker",
      }),
    ])
    expect(ctx.userMessage).toContain("Ready providers:")
    expect(ctx.userMessage).toContain('minimax (MiniMax-M2.7; credentials from kicker via auth-flow): reply "switch to minimax"')
    expect(ctx.userMessage).toContain("anthropic: credentials need to be refreshed")
    expect(ctx.userMessage).not.toContain("cred_minimax")
    expect(ctx.userMessage).not.toContain("setupToken")
    expect(ctx.userMessage).not.toContain(".agentsecrets")
  })

  it("handles no working providers", () => {
    const ctx = buildFailoverContext(
      "server error",
      "server-error",
      "anthropic",
      "claude-opus-4-6",
      "slugger",
      {
        "openai-codex": { ok: false, classification: "server-error", message: "502" },
        minimax: { ok: false, classification: "auth-failure", message: "no credentials configured" },
        azure: { ok: false, classification: "auth-failure", message: "no credentials configured" },
      },
      models,
    )

    expect(ctx.workingProviders).toHaveLength(0)
    expect(ctx.userMessage).toContain("ouro auth --agent slugger")
  })

  it("handles no providers at all (empty inventory)", () => {
    const ctx = buildFailoverContext(
      "network error",
      "network-error",
      "anthropic",
      "claude-opus-4-6",
      "slugger",
      {},
      {},
    )

    expect(ctx.workingProviders).toHaveLength(0)
    expect(ctx.unconfiguredProviders).toHaveLength(0)
    expect(ctx.userMessage).toContain("No other providers are available")
  })

  it("omits providers that are configured but also failing", () => {
    const ctx = buildFailoverContext(
      "rate limited",
      "rate-limit",
      "openai-codex",
      "gpt-5.4",
      "slugger",
      {
        anthropic: { ok: true },
        azure: { ok: false, classification: "rate-limit", message: "429" },
        minimax: { ok: false, classification: "server-error", message: "500" },
      },
      models,
    )

    expect(ctx.workingProviders).toEqual(["anthropic"])
    expect(ctx.unconfiguredProviders).toHaveLength(0)
  })

  it("gives concrete recovery guidance for every configured-but-unavailable provider class", () => {
    const ctx = buildFailoverContext(
      "network error",
      "network-error",
      "openai-codex",
      "gpt-5.4",
      "slugger",
      {
        anthropic: { ok: false, classification: "auth-failure", message: "expired" },
        azure: { ok: false, classification: "network-error", message: "fetch failed" },
        minimax: { ok: false, classification: "usage-limit", message: "quota" },
        "github-copilot": { ok: false, classification: "unknown", message: "mystery" },
      },
      models,
    )

    expect(ctx.userMessage).toContain("Configured but unavailable:")
    expect(ctx.userMessage).toContain("anthropic: credentials need to be refreshed")
    expect(ctx.userMessage).toContain("azure: could not be reached")
    expect(ctx.userMessage).toContain("minimax: usage limit hit")
    expect(ctx.userMessage).toContain("github-copilot: could not be reached")
  })

  it("truncates overly long provider detail in the user-facing message", () => {
    const longDetail = `fatal ${"x".repeat(320)}`
    const ctx = buildFailoverContext(
      longDetail,
      "unknown",
      "openai-codex",
      "gpt-5.4",
      "slugger",
      {},
      models,
    )

    expect(ctx.userMessage).toContain(`provider detail: ${longDetail.slice(0, 297)}...`)
  })

  it("reflects classification in error summary with model", () => {
    expect(buildFailoverContext("", "auth-failure", "anthropic", "claude-opus-4-6", "a", {}, {}).errorSummary)
      .toBe("anthropic (claude-opus-4-6) authentication failed")
    expect(buildFailoverContext("", "usage-limit", "openai-codex", "gpt-5.4", "a", {}, {}).errorSummary)
      .toBe("openai-codex (gpt-5.4) hit its usage limit")
    expect(buildFailoverContext("", "server-error", "azure", "", "a", {}, {}).errorSummary)
      .toBe("azure is experiencing an outage")
  })

  it("calls out provider/model mismatches with concrete repair commands", () => {
    const ctx = buildFailoverContext(
      "401 Provided authentication token is expired.",
      "auth-failure",
      "openai-codex",
      "claude-sonnet-4.6",
      "slugger",
      {
        anthropic: { ok: true },
      },
      models,
    )

    expect(ctx.errorSummary).toBe("openai-codex [configured model: claude-sonnet-4.6] authentication failed")
    expect(ctx.userMessage).toContain("provider detail: 401 Provided authentication token is expired.")
    expect(ctx.userMessage).toContain("does not look like a model for OpenAI Codex")
    expect(ctx.userMessage).toContain("ouro use --agent slugger --lane outward --provider openai-codex --model gpt-5.4")
    expect(ctx.userMessage).toContain("Ready providers:")
    expect(ctx.userMessage).toContain('reply "switch to anthropic"')
  })

  it("handles structured unavailable providers without a model hint", () => {
    const ctx = buildFailoverContext(
      "token expired",
      "auth-failure",
      "openai-codex",
      "gpt-5.4",
      "slugger",
      {
        ready: [],
        unavailable: [
          {
            provider: "anthropic",
            result: { ok: false, classification: "auth-failure", message: "expired" },
          },
        ],
        unconfigured: [],
      },
      {},
    )

    expect(ctx.userMessage).toContain("Configured but unavailable:")
    expect(ctx.userMessage).toContain("anthropic: credentials need to be refreshed")
  })
})

describe("formatCredentialProvenanceLabel", () => {
  it("renders only safe provenance labels", () => {
    expect(formatCredentialProvenanceLabel({ source: "auth-flow", contributedByAgent: "slugger" }))
      .toBe("credentials from slugger via auth-flow")
    expect(formatCredentialProvenanceLabel({ contributedByAgent: "slugger" }))
      .toBe("credentials from slugger")
    expect(formatCredentialProvenanceLabel({ source: "manual" }))
      .toBe("credentials from this machine via manual")
    expect(formatCredentialProvenanceLabel({})).toBeUndefined()
  })
})

describe("runMachineProviderFailoverInventory", () => {
  it("pings machine credential-pool providers and preserves safe provenance", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-failover-"))
    try {
      writeProviderCredentialPool(tmp, {
        schemaVersion: 1,
        updatedAt: now,
        providers: {
          anthropic: {
            provider: "anthropic",
            revision: "cred_anthropic",
            updatedAt: now,
            credentials: { setupToken: "anthropic-secret" },
            config: {},
            provenance: { source: "legacy-agent-secrets", contributedByAgent: "slugger", updatedAt: now },
          },
          minimax: {
            provider: "minimax",
            revision: "cred_minimax",
            updatedAt: now,
            credentials: { apiKey: "minimax-secret" },
            config: {},
            provenance: { source: "auth-flow", contributedByAgent: "kicker", updatedAt: now },
          },
        },
      })
      const ping = vi.fn(async (provider: string) => provider === "anthropic"
        ? { ok: true as const }
        : { ok: false as const, classification: "auth-failure" as const, message: "expired" })

      const inventory = await runMachineProviderFailoverInventory("slugger", "openai-codex", {
        homeDir: tmp,
        ping: ping as any,
      })

      expect(ping).toHaveBeenCalledWith("anthropic", expect.objectContaining({ setupToken: "anthropic-secret" }), { model: "claude-opus-4-6" })
      expect(ping).toHaveBeenCalledWith("minimax", expect.objectContaining({ apiKey: "minimax-secret" }), { model: "MiniMax-M2.7" })
      expect(inventory.ready).toEqual([
        expect.objectContaining({
          provider: "anthropic",
          model: "claude-opus-4-6",
          credentialRevision: "cred_anthropic",
          source: "legacy-agent-secrets",
          contributedByAgent: "slugger",
        }),
      ])
      expect(inventory.unavailable).toEqual([
        expect.objectContaining({
          provider: "minimax",
          model: "MiniMax-M2.7",
          credentialRevision: "cred_minimax",
          source: "auth-flow",
          contributedByAgent: "kicker",
          result: expect.objectContaining({ ok: false, classification: "auth-failure" }),
        }),
      ])
      expect(inventory.unconfigured).toEqual(["azure", "github-copilot"])
      expect(JSON.stringify(inventory)).not.toContain("anthropic-secret")
      expect(JSON.stringify(inventory)).not.toContain("minimax-secret")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("treats a missing machine credential pool as unconfigured providers without pinging", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-failover-missing-"))
    try {
      const inventory = await runMachineProviderFailoverInventory("slugger", "anthropic", {
        homeDir: tmp,
      })

      expect(inventory.ready).toEqual([])
      expect(inventory.unavailable).toEqual([])
      expect(inventory.unconfigured).toEqual(["openai-codex", "azure", "minimax", "github-copilot"])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("handleFailoverReply", () => {
  const ctx = buildFailoverContext(
    "usage limit",
    "usage-limit",
    "openai-codex",
    "gpt-5.4",
    "slugger",
    {
      anthropic: { ok: true },
      azure: { ok: true },
    },
    models,
  )

  it("matches 'switch to anthropic'", () => {
    expect(handleFailoverReply("switch to anthropic", ctx)).toEqual({
      action: "switch",
      provider: "anthropic",
      model: "claude-opus-4-6",
      lane: "outward",
    })
  })

  it("returns selected lane and model when matching a provenance-rich ready provider", () => {
    const richContext = buildFailoverContext(
      "usage limit",
      "usage-limit",
      "openai-codex",
      "gpt-5.4",
      "slugger",
      {
        ready: [
          {
            provider: "minimax",
            model: "MiniMax-M2.7",
            credentialRevision: "cred_minimax",
            source: "manual",
            contributedByAgent: "slugger",
            result: { ok: true },
          },
        ],
        unavailable: [],
        unconfigured: [],
      } as any,
      {},
    )

    expect(handleFailoverReply("switch to minimax", richContext)).toEqual({
      action: "switch",
      provider: "minimax",
      model: "MiniMax-M2.7",
      lane: "outward",
      credentialRevision: "cred_minimax",
      source: "manual",
      contributedByAgent: "slugger",
    })
  })

  it("matches 'switch to azure'", () => {
    expect(handleFailoverReply("switch to azure", ctx)).toEqual({
      action: "switch",
      provider: "azure",
      model: "gpt-4o-mini",
      lane: "outward",
    })
  })

  it("matches bare provider name", () => {
    expect(handleFailoverReply("anthropic", ctx)).toEqual({
      action: "switch",
      provider: "anthropic",
      model: "claude-opus-4-6",
      lane: "outward",
    })
  })

  it("is case-insensitive", () => {
    expect(handleFailoverReply("Switch to Anthropic", ctx)).toEqual({
      action: "switch",
      provider: "anthropic",
      model: "claude-opus-4-6",
      lane: "outward",
    })
  })

  it("trims whitespace", () => {
    expect(handleFailoverReply("  switch to anthropic  ", ctx)).toEqual({
      action: "switch",
      provider: "anthropic",
      model: "claude-opus-4-6",
      lane: "outward",
    })
  })

  it("dismisses unrelated messages", () => {
    expect(handleFailoverReply("hey can you review this PR?", ctx)).toEqual({ action: "dismiss" })
  })

  it("dismisses empty reply", () => {
    expect(handleFailoverReply("", ctx)).toEqual({ action: "dismiss" })
  })

  it("does not allow switching to non-working providers", () => {
    const limited = buildFailoverContext("err", "auth-failure", "openai-codex", "gpt-5.4", "s", {
      anthropic: { ok: true },
      minimax: { ok: false, classification: "server-error", message: "down" },
    }, models)
    expect(handleFailoverReply("switch to minimax", limited)).toEqual({ action: "dismiss" })
  })
})
