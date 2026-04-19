import { describe, expect, it, vi } from "vitest"
import * as path from "path"

const {
  collectSecretStrings,
  normalizeRealSmokeInput,
  parseArgs,
  readRealSmokeInput,
  redactKnownSecrets,
  runRealSmokeSuite,
  summarizeRealSmokeSuite,
} = require(path.resolve(__dirname, "../../../scripts/nightly-real-smoke.cjs"))

describe("nightly-real-smoke", () => {
  it("parses the secrets-file argument", () => {
    expect(parseArgs(["--secrets-file", "/tmp/ouro-real-smoke.json"])).toEqual({
      secretsFile: "/tmp/ouro-real-smoke.json",
    })
  })

  it("normalizes the expected real-smoke JSON shape", () => {
    const input = normalizeRealSmokeInput({
      providerCheck: {
        provider: "minimax",
        model: "MiniMax-M2.5",
        config: { apiKey: "mini-secret" },
      },
      portableChecks: {
        perplexityApiKey: "pplx-secret",
        openaiEmbeddingsApiKey: "emb-secret",
      },
    })

    expect(input.providerCheck.provider).toBe("minimax")
    expect(input.portableChecks.perplexityApiKey).toBe("pplx-secret")
  })

  it("rejects malformed real-smoke JSON early", () => {
    expect(() => normalizeRealSmokeInput({
      providerCheck: {
        provider: "minimax",
        config: { apiKey: "mini-secret" },
      },
      portableChecks: {
        perplexityApiKey: "pplx-secret",
        openaiEmbeddingsApiKey: "emb-secret",
      },
    })).toThrow("providerCheck.model")
  })

  it("reads and validates the secrets file without printing it", () => {
    const deps = {
      readFileSync: vi.fn(() => JSON.stringify({
        providerCheck: {
          provider: "minimax",
          model: "MiniMax-M2.5",
          config: { apiKey: "mini-secret" },
        },
        portableChecks: {
          perplexityApiKey: "pplx-secret",
          openaiEmbeddingsApiKey: "emb-secret",
        },
      })),
    }

    const input = readRealSmokeInput("/tmp/ouro-real-smoke.json", deps)

    expect(input.providerCheck.model).toBe("MiniMax-M2.5")
    expect(deps.readFileSync).toHaveBeenCalledWith("/tmp/ouro-real-smoke.json", "utf8")
  })

  it("collects secret strings recursively for log redaction", () => {
    expect(collectSecretStrings({
      providerCheck: {
        config: { apiKey: "mini-secret", nested: { refreshToken: "refresh-secret" } },
      },
      portableChecks: {
        perplexityApiKey: "pplx-secret",
      },
    })).toEqual(expect.arrayContaining([
      "mini-secret",
      "refresh-secret",
      "pplx-secret",
    ]))
  })

  it("redacts exact secret values from smoke output", () => {
    expect(redactKnownSecrets(
      "provider rejected mini-secret while pplx-secret also failed",
      ["mini-secret", "pplx-secret"],
    )).toBe("provider rejected [redacted] while [redacted] also failed")
  })

  it("runs provider and portable capability checks through one suite", async () => {
    const deps = {
      pingProvider: vi.fn(async () => ({ ok: true })),
      verifyPerplexityCapability: vi.fn(async () => ({ ok: true, summary: "live check passed" })),
      verifyEmbeddingsCapability: vi.fn(async () => ({ ok: false, summary: "401 bad key" })),
    }

    const results = await runRealSmokeSuite({
      providerCheck: {
        provider: "minimax",
        model: "MiniMax-M2.5",
        config: { apiKey: "mini-secret" },
      },
      portableChecks: {
        perplexityApiKey: "pplx-secret",
        openaiEmbeddingsApiKey: "emb-secret",
      },
    }, deps)

    expect(results).toEqual([
      { ok: true, label: "provider minimax / MiniMax-M2.5", message: "live check passed" },
      { ok: true, label: "Perplexity search", message: "live check passed" },
      { ok: false, label: "memory embeddings", message: "401 bad key" },
    ])
    expect(deps.pingProvider).toHaveBeenCalledWith("minimax", { apiKey: "mini-secret" }, { model: "MiniMax-M2.5" })
    expect(deps.verifyPerplexityCapability).toHaveBeenCalledWith("pplx-secret")
    expect(deps.verifyEmbeddingsCapability).toHaveBeenCalledWith("emb-secret")
  })

  it("redacts leaked secret echoes from checker failures before summarizing", async () => {
    const deps = {
      pingProvider: vi.fn(async () => ({ ok: false, message: "mini-secret was rejected" })),
      verifyPerplexityCapability: vi.fn(async () => ({ ok: false, summary: "pplx-secret expired" })),
      verifyEmbeddingsCapability: vi.fn(async () => ({ ok: false, summary: "emb-secret expired" })),
    }

    const results = await runRealSmokeSuite({
      providerCheck: {
        provider: "minimax",
        model: "MiniMax-M2.5",
        config: { apiKey: "mini-secret" },
      },
      portableChecks: {
        perplexityApiKey: "pplx-secret",
        openaiEmbeddingsApiKey: "emb-secret",
      },
    }, deps)
    const summary = summarizeRealSmokeSuite(results)
    const joined = summary.lines.join("\n")

    expect(joined).not.toContain("mini-secret")
    expect(joined).not.toContain("pplx-secret")
    expect(joined).not.toContain("emb-secret")
    expect(joined).toContain("[redacted]")
    expect(summary.ok).toBe(false)
  })
})
