import { describe, expect, it } from "vitest"
import {
  checkBlueBubblesHostDeclared,
  checkBlueBubblesHostTarget,
  currentOsAccount,
} from "../../heart/bluebubbles-host-account"
import { normalizeSenses } from "../../heart/identity"

describe("checkBlueBubblesHostDeclared", () => {
  it("allows any declared host account", () => {
    expect(checkBlueBubblesHostDeclared("slugger", "clawdbot")).toEqual({ ok: true })
  })

  it("fails closed when no host account is declared, and marks the choice as a human decision", () => {
    const result = checkBlueBubblesHostDeclared("slugger", undefined)
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "unset" }))
    if (result.ok) return
    expect(result.message).toContain('BlueBubbles refused for agent "slugger": no host account is declared (senses.bluebubbles.hostUsername)')
    expect(result.message).toContain("is a human decision")
  })
})

describe("checkBlueBubblesHostTarget", () => {
  it("allows a target account that an enabled agent declares as its host", () => {
    expect(checkBlueBubblesHostTarget("clawdbot", [{ agent: "slugger", hostUsername: "clawdbot" }])).toEqual({ ok: true })
  })

  it("refuses a target no agent declares, naming the declared hosts without inviting a self-edit", () => {
    const result = checkBlueBubblesHostTarget("arimendelow", [{ agent: "slugger", hostUsername: "clawdbot" }])
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "mismatch" }))
    if (result.ok) return
    expect(result.message).toContain('macOS account "arimendelow"')
    expect(result.message).toContain('slugger -> "clawdbot"')
    expect(result.message).toContain("Set up BlueBubbles under a declared account instead")
    expect(result.message).toContain("is a human decision")
  })

  it("fails closed when no agent declares any host account", () => {
    const result = checkBlueBubblesHostTarget("arimendelow", [{ agent: "slugger" }])
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "unset" }))
    if (result.ok) return
    expect(result.message).toContain("no agent with BlueBubbles enabled declares senses.bluebubbles.hostUsername")
  })
})

describe("currentOsAccount", () => {
  it("returns the running process's username and uid", () => {
    const account = currentOsAccount()
    expect(account.username.length).toBeGreaterThan(0)
    expect(Number.isInteger(account.uid)).toBe(true)
  })
})

describe("normalizeSenses hostUsername", () => {
  it("keeps senses.bluebubbles.hostUsername", () => {
    expect(normalizeSenses({ bluebubbles: { enabled: true, hostUsername: "clawdbot" } }, "/x/agent.json").bluebubbles)
      .toEqual({ enabled: true, hostUsername: "clawdbot" })
  })

  it("trims surrounding whitespace from hostUsername", () => {
    expect(normalizeSenses({ bluebubbles: { enabled: true, hostUsername: " clawdbot " } }, "/x/agent.json").bluebubbles)
      .toEqual({ enabled: true, hostUsername: "clawdbot" })
  })

  it("leaves hostUsername absent when not set", () => {
    expect(normalizeSenses({ bluebubbles: { enabled: true } }, "/x/agent.json").bluebubbles).toEqual({ enabled: true })
  })

  it("rejects a blank or non-string hostUsername", () => {
    expect(() => normalizeSenses({ bluebubbles: { enabled: true, hostUsername: " " } }, "/x/agent.json"))
      .toThrow("senses.bluebubbles.hostUsername must be a non-empty string")
    expect(() => normalizeSenses({ bluebubbles: { enabled: true, hostUsername: 502 } }, "/x/agent.json"))
      .toThrow("senses.bluebubbles.hostUsername must be a non-empty string")
  })

  it("ignores hostUsername on other senses", () => {
    expect(normalizeSenses({ teams: { enabled: true, hostUsername: "clawdbot" } }, "/x/agent.json").teams).toEqual({ enabled: true })
  })
})
