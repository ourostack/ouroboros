import { describe, it, expect, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { buildFailoverContext, handleFailoverReply } from "../../heart/provider-failover"

const models = { anthropic: "claude-opus-4-6", "openai-codex": "gpt-5.4", azure: "gpt-4o-mini", minimax: "minimax-text-01" }

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
    expect(handleFailoverReply("switch to anthropic", ctx)).toEqual({ action: "switch", provider: "anthropic" })
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
    })
  })

  it("matches 'switch to azure'", () => {
    expect(handleFailoverReply("switch to azure", ctx)).toEqual({ action: "switch", provider: "azure" })
  })

  it("matches bare provider name", () => {
    expect(handleFailoverReply("anthropic", ctx)).toEqual({ action: "switch", provider: "anthropic" })
  })

  it("is case-insensitive", () => {
    expect(handleFailoverReply("Switch to Anthropic", ctx)).toEqual({ action: "switch", provider: "anthropic" })
  })

  it("trims whitespace", () => {
    expect(handleFailoverReply("  switch to anthropic  ", ctx)).toEqual({ action: "switch", provider: "anthropic" })
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
