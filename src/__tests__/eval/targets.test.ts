import { describe, expect, it, vi } from "vitest"
import type { ProviderRuntime } from "../../heart/core"
import { parseTargetSpec, resolveTarget, type TargetDeps } from "../../eval/targets"

const record = (provider: string, credentials: Record<string, string>, config: Record<string, string> = {}) => ({
  ok: true as const, poolPath: "vault", record: { provider, revision: "r", updatedAt: "t", credentials, config, provenance: { source: "auth", updatedAt: "t" } },
}) as never

const fakeRuntime = (id: string, model: string): ProviderRuntime => ({
  id: id as ProviderRuntime["id"], model, client: null, capabilities: new Set(), streamTurn: vi.fn(), appendToolOutput: () => undefined,
  resetTurnState: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
})

const user = (login: string, tokenBased = true) => ({
  login, token_based_billing: tokenBased, quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
  quota_snapshots: { premium_interactions: { unlimited: false, percent_remaining: 80, remaining: 240, entitlement: 300, overage_permitted: false } },
})

function deps(overrides: Partial<TargetDeps> = {}): TargetDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    readCredential: async (_agent, provider) => provider === "github-copilot"
      ? record("github-copilot", { githubToken: "tok-a", baseUrl: "https://api.example.invalid" })
      : record("minimax", { apiKey: "key" }),
    listCopilotModels: async () => [{ id: "claude-opus-5.5", billing: null }, { id: "gpt-6.1-sol", billing: { multiplier: 3 } }],
    copilotUser: async () => user("ari"),
    createCopilotRuntime: (model, config) => { calls.push(`copilot ${model} ${JSON.stringify(config)}`); return fakeRuntime("github-copilot", model) },
    createMinimaxRuntime: (model) => { calls.push(`minimax ${model}`); return fakeRuntime("minimax", model) },
    ...overrides,
  }
}

describe("parseTargetSpec", () => {
  it("reads provider:model and refuses anything else", () => {
    expect(parseTargetSpec("github-copilot:claude-opus-5.5")).toEqual({ provider: "github-copilot", model: "claude-opus-5.5" })
    expect(parseTargetSpec("minimax:MiniMax-M3")).toEqual({ provider: "minimax", model: "MiniMax-M3" })
    expect(() => parseTargetSpec("anthropic:claude")).toThrow(/github-copilot:<model> or minimax:<model>/)
    expect(() => parseTargetSpec("minimax:")).toThrow(/github-copilot:<model>/)
  })
})

describe("resolveTarget", () => {
  it("reads the endpoint from the record's config, where ouro auth stores it, and the token from its credentials", async () => {
    const d = deps({ readCredential: async () => record("github-copilot", { githubToken: "tok-a" }, { baseUrl: "https://api.config.invalid" }) })
    const target = await resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger", premiumMultiplier: 1 }, d)
    expect(target.account).toBe("ari@github.com")
    expect(d.calls).toEqual([`copilot claude-opus-5.5 ${JSON.stringify({ githubToken: "tok-a", baseUrl: "https://api.config.invalid" })}`])
  })

  it("builds a Copilot target on the one named account, with no owner and no account pool", async () => {
    const pool = JSON.stringify([
      { login: "ari", host: "github.com", baseUrl: "https://api.one.invalid", githubToken: "tok-ari" },
      { login: "other", host: "github.com", baseUrl: "https://api.two.invalid", githubToken: "tok-other" },
    ])
    const d = deps({ readCredential: async () => record("github-copilot", { githubToken: "tok-ari", baseUrl: "https://api.one.invalid", accountPool: pool, fleetGistToken: "gist" }) })
    const target = await resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger", copilotAccount: "ari", premiumMultiplier: 1 }, d)
    expect(d.calls).toEqual([`copilot claude-opus-5.5 ${JSON.stringify({ githubToken: "tok-ari", baseUrl: "https://api.one.invalid" })}`])
    expect(target).toMatchObject({ spec: "github-copilot:claude-opus-5.5", unitCost: 1, multiplierSource: "--premium-multiplier", account: "ari@github.com" })
    expect(await target.quota()).toMatchObject({ tokenBased: true, reading: { key: "ari@github.com", remaining: 240 } })
  })

  it("takes the multiplier from Copilot's /models when it has one", async () => {
    const target = await resolveTarget("github-copilot:gpt-6.1-sol", { agent: "slugger", premiumMultiplier: 1 }, deps())
    expect(target).toMatchObject({ unitCost: 3, multiplierSource: "copilot /models" })
  })

  it("refuses, before any model call, a Copilot target with no multiplier from /models or --premium-multiplier", async () => {
    const d = deps()
    await expect(resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger" }, d)).rejects.toThrow(/no premium-request multiplier.*--premium-multiplier/)
    expect(d.calls).toEqual([])
  })

  it("refuses a model Copilot does not offer, and an unusable multiplier", async () => {
    await expect(resolveTarget("github-copilot:nope", { agent: "slugger", premiumMultiplier: 1 }, deps())).rejects.toThrow(/does not offer nope/)
    await expect(resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger", premiumMultiplier: -2 }, deps())).rejects.toThrow(/--premium-multiplier/)
  })

  it("refuses to choose between pooled accounts, and a named account that is not there", async () => {
    const pool = JSON.stringify([
      { login: "ari", host: "github.com", baseUrl: "https://a.invalid", githubToken: "t1" },
      { login: "bo", host: "ghe.example", baseUrl: "https://b.invalid", githubToken: "t2" },
    ])
    const d = deps({ readCredential: async () => record("github-copilot", { githubToken: "t1", baseUrl: "https://a.invalid", accountPool: pool }) })
    await expect(resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger", premiumMultiplier: 1 }, d)).rejects.toThrow(/--copilot-account ari@github.com or bo@ghe.example/)
    await expect(resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger", copilotAccount: "cy", premiumMultiplier: 1 }, d)).rejects.toThrow(/no Copilot account cy/)
    const ok = await resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger", copilotAccount: "bo@ghe.example", premiumMultiplier: 1 }, d)
    expect(ok.account).toBe("bo@ghe.example")
  })

  it("checks a single stored account's login against --copilot-account", async () => {
    await expect(resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger", copilotAccount: "someone", premiumMultiplier: 1 }, deps())).rejects.toThrow(/signs in as ari, not someone/)
    const unknown = deps({ copilotUser: async () => ({}) })
    await expect(resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger", premiumMultiplier: 1 }, unknown)).rejects.toThrow(/could not read the login/)
  })

  it("bills a pool's only account without naming it, and refuses stored credentials with no token", async () => {
    const pool = JSON.stringify([{ login: "ari", host: "github.com", baseUrl: "https://a.invalid", githubToken: "t1" }])
    const one = await resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger", premiumMultiplier: 1 },
      deps({ readCredential: async () => record("github-copilot", { accountPool: pool }), copilotUser: async () => "not json" }))
    expect(one.account).toBe("ari@github.com")
    expect(await one.quota()).toEqual({ tokenBased: null, reading: null })
    await expect(resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger", premiumMultiplier: 1 },
      deps({ readCredential: async () => record("github-copilot", {}) }))).rejects.toThrow(/no token and endpoint/)
  })

  it("reads a quota as unknown when Copilot gives none", async () => {
    let first = true
    const d = deps({ copilotUser: async () => { if (first) { first = false; return user("ari", false) } throw new Error("offline") } })
    const target = await resolveTarget("github-copilot:claude-opus-5.5", { agent: "slugger", premiumMultiplier: 1 }, d)
    expect(await target.quota()).toEqual({ tokenBased: null, reading: null })
  })

  it("names the auth step when a credential is missing", async () => {
    const missing = deps({ readCredential: async () => ({ ok: false, reason: "missing", poolPath: "vault", error: "no item" }) as never })
    await expect(resolveTarget("minimax:MiniMax-M3", { agent: "slugger" }, missing)).rejects.toThrow(/ouro auth --agent slugger --provider minimax/)
    const empty = deps({ readCredential: async () => record("minimax", {}) })
    await expect(resolveTarget("minimax:MiniMax-M3", { agent: "slugger" }, empty)).rejects.toThrow(/ouro auth --agent slugger --provider minimax/)
  })

  it("builds a MiniMax target that costs no premium requests", async () => {
    const d = deps()
    const target = await resolveTarget("minimax:MiniMax-M3", { agent: "slugger", premiumMultiplier: 9 }, d)
    expect(d.calls).toEqual(["minimax MiniMax-M3"])
    expect(target).toMatchObject({ unitCost: 0, multiplierSource: "not a Copilot target", account: null })
    expect(await target.quota()).toEqual({ tokenBased: null, reading: null })
  })
})
