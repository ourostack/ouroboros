import { describe, expect, it } from "vitest"

import { SENSITIVE_KEYS, redactMeta } from "../../nerves/redact"

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
})
