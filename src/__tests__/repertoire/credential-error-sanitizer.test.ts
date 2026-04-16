import { describe, expect, it } from "vitest"

import { sanitizeCredentialErrorDetail } from "../../repertoire/bitwarden-store"

describe("sanitizeCredentialErrorDetail", () => {
  it("drops command lines and hidden prompt echoes", () => {
    const result = sanitizeCredentialErrorDetail(
      "Command failed: bw create item eyJzZWNyZXQiOiJ0b29sb25nIn0=\n? Master password: [input is hidden]\nactual failure",
    )

    expect(result).toBe("actual failure")
  })

  it("redacts supplied secrets and long encoded payloads", () => {
    const encodedPayload = Buffer
      .from(JSON.stringify({ login: { password: "secret1234" } }))
      .toString("base64")
    const result = sanitizeCredentialErrorDetail(
      `save failed for agent@example.com / secret1234 / ${encodedPayload}`,
      { secrets: ["secret1234", "agent@example.com"] },
    )

    expect(result).toContain("[redacted]")
    expect(result).not.toContain("secret1234")
    expect(result).not.toContain("agent@example.com")
    expect(result).not.toContain(encodedPayload)
  })

  it("falls back to command failed when scrubbing removes everything", () => {
    const result = sanitizeCredentialErrorDetail(
      "Command failed: bw create item eyJzZWNyZXQiOiJ0b29sb25nIn0=\n? Master password: [input is hidden]",
    )

    expect(result).toBe("command failed")
  })
})
