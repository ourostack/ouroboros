import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const bundleRoot = path.resolve("deploy/unraid/sanctuary.ouro")

function psyche(name: string): string {
  return fs.readFileSync(path.join(bundleRoot, "psyche", `${name}.md`), "utf8")
}

describe("Mendelow Cloud Butler household UX", () => {
  it("serves Ari and approved household members without requiring the internal server name", () => {
    expect(psyche("IDENTITY")).toContain("Mendelow Cloud Butler")
    expect(psyche("IDENTITY")).toContain("approved household members")
    expect(psyche("IDENTITY")).toContain("People do not need to say Sanctuary")
    expect(psyche("IDENTITY")).not.toContain("serve one trusted operator")
  })

  it("has an original playful, perceptive personality without borrowing Cradle names or catchphrases", () => {
    const soul = psyche("SOUL")
    expect(soul).toContain("wry")
    expect(soul).toContain("curious")
    expect(soul).toContain("quietly delighted by a clever fix")
    expect(soul).toContain("gentle theatrical flair")
    expect(soul).toContain("kind, never smug")
    expect(soul).not.toMatch(/\b(?:Dross|Lindon|Eithan|Cradle|Abidan|Monarch)\b/u)
  })

  it("acts under typed standing policy instead of demanding approval for every reversible restart", () => {
    const tacit = psyche("TACIT")
    expect(tacit).toContain("standing policy")
    expect(tacit).toContain("verify the outcome")
    expect(tacit).toContain("request-bound")
    expect(tacit).not.toContain("after a durable Telegram approval")
  })

  it("ships relationship capability profiles as one typed registry rather than tool-only arrays", () => {
    const config = JSON.parse(fs.readFileSync(path.join(bundleRoot, "tool-profiles.json"), "utf8")) as {
      version: number
      profiles: Record<string, unknown>
    }
    expect(config.version).toBe(2)
    expect(config.profiles).toMatchObject({
      "sanctuary-owner": {
        contextScopes: expect.arrayContaining(["household.status", "household.policy"]),
        toolNames: expect.arrayContaining(["steward_policy_manage", "unraid_restart_container"]),
        effectScopes: expect.arrayContaining(["telegram.proactive", "telegram.request_return"]),
      },
      "sanctuary-household": {
        contextScopes: expect.arrayContaining(["household.status"]),
        toolNames: expect.arrayContaining(["unraid_get_system"]),
        effectScopes: ["telegram.request_return"],
      },
      "sanctuary-event": {
        contextScopes: expect.arrayContaining(["household.status", "household.policy"]),
        toolNames: expect.arrayContaining(["external_event_disposition", "query_cares", "care_manage", "await_condition"]),
        effectScopes: ["telegram.owner_event"],
      },
    })
  })
})
