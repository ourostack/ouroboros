import { describe, expect, it } from "vitest"

import { redactSecrets } from "../../../senses/shepherd/redact"

describe("cmux secret redaction", () => {
  it("removes secret-shaped strings and keeps the surrounding text", () => {
    const samples: Array<[string, string]> = [
      ["key sk-ant-api03-abcdefghijklmnopqrstuvwxyz done", "key [redacted] done"],
      ["export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234", "export OPENAI_API_KEY=[redacted]"],
      ["gh token ghp_abcdefghijklmnopqrstuvwxyz0123", "gh token [redacted]"],
      ["github_pat_11ABCDEFGHIJKLMNOPQRST_more", "[redacted]"],
      ["aws AKIAIOSFODNN7EXAMPLE x", "aws [redacted] x"],
      ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop", "jwt [redacted]"],
      [`cap v1.${"a".repeat(43)}.${"b".repeat(43)}`, "cap [redacted]"],
      ["slack xoxb-1234567890-abcdefghij", "slack [redacted]"],
      ["curl -H 'Authorization: Bearer abc.def.ghi123'", "curl -H 'Authorization: Bearer [redacted]'"],
      ["password = \"hunter2 two\" next", "password = [redacted] next"],
      ["client_secret: 's3cr3t'", "client_secret: [redacted]"],
      ["https://x.test/a?token=abc123&b=1", "https://x.test/a?token=[redacted]&b=1"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----", "[redacted]"],
      ["plain text with no secrets", "plain text with no secrets"],
    ]
    for (const [input, expected] of samples) expect(redactSecrets(input)).toBe(expected)
  })

  it("is stable when called repeatedly on the same pattern objects", () => {
    expect(redactSecrets("a sk-ant-abcdefghijklmnopqrstu b")).toBe("a [redacted] b")
    expect(redactSecrets("a sk-ant-abcdefghijklmnopqrstu b")).toBe("a [redacted] b")
  })
})
