import { describe, expect, it } from "vitest"

import { SENSITIVE_KEYS, redactMeta, redactString } from "../../nerves/redact"

describe("nerves/redact", () => {
  describe("redactMeta (structured key redaction)", () => {
    it("replaces password value with redaction marker", () => {
      const meta = { password: "secret123" }
      const result = redactMeta(meta)
      expect(result).toEqual({ password: "[REDACTED:password]" })
    })

    it("redacts only sensitive keys, leaves others untouched", () => {
      const meta = { password: "secret123", user: "alice" }
      const result = redactMeta(meta)
      expect(result).toEqual({ password: "[REDACTED:password]", user: "alice" })
    })

    it("matches keys case-insensitively", () => {
      const meta = { Authorization: "Bearer xxx" }
      const result = redactMeta(meta)
      expect(result).toEqual({ Authorization: "[REDACTED:Authorization]" })
    })

    it("recurses into nested objects", () => {
      const meta = { headers: { Authorization: "Bearer xxx", Accept: "application/json" } }
      const result = redactMeta(meta)
      expect(result).toEqual({
        headers: { Authorization: "[REDACTED:Authorization]", Accept: "application/json" },
      })
    })

    it("redacts all sensitive keys from the set", () => {
      for (const key of SENSITIVE_KEYS) {
        const meta = { [key]: "some-value" }
        const result = redactMeta(meta)
        expect(result[key]).toBe(`[REDACTED:${key}]`)
      }
    })

    it("passes through non-sensitive keys unchanged", () => {
      const meta = { model: "gpt-4", temperature: 0.7, user: "alice" }
      const result = redactMeta(meta)
      expect(result).toEqual({ model: "gpt-4", temperature: 0.7, user: "alice" })
    })

    it("replaces null values at sensitive keys with redaction marker", () => {
      const meta = { token: null }
      const result = redactMeta(meta)
      expect(result).toEqual({ token: "[REDACTED:token]" })
    })

    it("replaces undefined values at sensitive keys with redaction marker", () => {
      const meta = { token: undefined }
      const result = redactMeta(meta)
      expect(result).toEqual({ token: "[REDACTED:token]" })
    })

    it("replaces array values at sensitive keys with redaction marker", () => {
      const meta = { cookie: ["session=abc", "auth=xyz"] }
      const result = redactMeta(meta)
      expect(result).toEqual({ cookie: "[REDACTED:cookie]" })
    })

    it("returns empty object for empty meta", () => {
      const result = redactMeta({})
      expect(result).toEqual({})
    })

    it("does not mutate the original meta object", () => {
      const meta = { password: "secret123", nested: { token: "abc" } }
      const original = JSON.parse(JSON.stringify(meta))
      redactMeta(meta)
      expect(meta).toEqual(original)
    })
  })

  describe("redactString (regex fallback)", () => {
    it("redacts Anthropic API keys", () => {
      const input = "key is sk-ant-abc123_DEF"
      const result = redactString(input)
      expect(result).toBe("key is [REDACTED:anthropic_key]")
    })

    it("redacts OpenAI project keys", () => {
      const input = "using sk-proj-xyz789_ABC"
      const result = redactString(input)
      expect(result).toBe("using [REDACTED:openai_key]")
    })

    it("redacts Bearer tokens", () => {
      const input = "Authorization: Bearer eyJhbGci.payload.sig"
      const result = redactString(input)
      expect(result).toBe("Authorization: [REDACTED:bearer_token]")
    })

    it("redacts generic API key assignments", () => {
      const input = "api_key=abc123def"
      const result = redactString(input)
      expect(result).toBe("[REDACTED:api_key_assignment]")
    })

    it("redacts URL token query param but preserves other params", () => {
      const input = "https://api.example.com/data?token=abc123&other=ok"
      const result = redactString(input)
      expect(result).toBe("https://api.example.com/data[REDACTED:url_token]&other=ok")
    })

    it("redacts URL access_token query param", () => {
      const input = "?access_token=xyz789"
      const result = redactString(input)
      expect(result).toBe("[REDACTED:url_token]")
    })

    it("redacts multiple patterns in one string", () => {
      const input = "key=sk-ant-abc123 and Bearer eyJtoken.here.now"
      const result = redactString(input)
      expect(result).not.toContain("sk-ant-abc123")
      expect(result).not.toContain("eyJtoken.here.now")
    })

    it("passes through strings with no sensitive content", () => {
      const input = "just a normal log message with no secrets"
      const result = redactString(input)
      expect(result).toBe(input)
    })

    it("returns empty string for empty input", () => {
      expect(redactString("")).toBe("")
    })
  })
})
