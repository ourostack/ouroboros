import { describe, expect, it } from "vitest"
import {
  checkBlueBubblesHostAccount,
  checkBlueBubblesHostTarget,
  checkBlueBubblesSenseHostAccount,
  currentOsAccount,
} from "../../heart/bluebubbles-host-account"
import { normalizeSenses } from "../../heart/identity"

const ari = { username: "arimendelow", uid: 501 }
const clawdbot = { username: "clawdbot", uid: 502 }

describe("checkBlueBubblesHostAccount", () => {
  it("allows the configured host account", () => {
    expect(checkBlueBubblesHostAccount("slugger", "clawdbot", clawdbot)).toEqual({ ok: true })
  })

  it("refuses a different account and names both accounts and the fix", () => {
    const result = checkBlueBubblesHostAccount("slugger", "clawdbot", ari)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("mismatch")
    expect(result.message).toBe(
      'BlueBubbles refused for agent "slugger": iMessage is configured to run under macOS account "clawdbot", '
      + 'but this process is running as "arimendelow" (uid 501). Not starting, so the agent cannot send from the wrong Apple ID. '
      + 'Fix: run ouro as "clawdbot", or set senses.bluebubbles.hostUsername in agent.json.',
    )
  })

  it("fails closed when no host account is configured", () => {
    const result = checkBlueBubblesHostAccount("slugger", undefined, ari)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("unset")
    expect(result.message).toContain("no host account is configured (senses.bluebubbles.hostUsername)")
    expect(result.message).toContain('this process is running as "arimendelow" (uid 501)')
    expect(result.message).toContain('set senses.bluebubbles.hostUsername in agent.json')
  })
})

describe("checkBlueBubblesHostTarget", () => {
  it("allows a target account that an enabled agent declares as its host", () => {
    expect(checkBlueBubblesHostTarget("clawdbot", [{ agent: "slugger", hostUsername: "clawdbot" }])).toEqual({ ok: true })
  })

  it("refuses a target no agent declares, naming the declared hosts", () => {
    const result = checkBlueBubblesHostTarget("arimendelow", [{ agent: "slugger", hostUsername: "clawdbot" }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("mismatch")
    expect(result.message).toContain('macOS account "arimendelow"')
    expect(result.message).toContain('slugger -> "clawdbot"')
  })

  it("fails closed when no agent declares any host account", () => {
    const result = checkBlueBubblesHostTarget("arimendelow", [{ agent: "slugger" }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("unset")
    expect(result.message).toContain("no agent with BlueBubbles enabled declares senses.bluebubbles.hostUsername")
  })
})

describe("currentOsAccount", () => {
  it("returns the running process's username and uid", () => {
    const account = currentOsAccount()
    expect(typeof account.username).toBe("string")
    expect(account.username.length).toBeGreaterThan(0)
    expect(Number.isInteger(account.uid)).toBe(true)
  })
})

describe("normalizeSenses hostUsername", () => {
  it("keeps senses.bluebubbles.hostUsername", () => {
    const senses = normalizeSenses({ bluebubbles: { enabled: true, hostUsername: "clawdbot" } }, "/x/agent.json")
    expect(senses.bluebubbles).toEqual({ enabled: true, hostUsername: "clawdbot" })
  })

  it("leaves hostUsername absent when not set", () => {
    const senses = normalizeSenses({ bluebubbles: { enabled: true } }, "/x/agent.json")
    expect(senses.bluebubbles).toEqual({ enabled: true })
  })

  it("rejects a blank or non-string hostUsername", () => {
    expect(() => normalizeSenses({ bluebubbles: { enabled: true, hostUsername: " " } }, "/x/agent.json"))
      .toThrow("senses.bluebubbles.hostUsername must be a non-empty string")
    expect(() => normalizeSenses({ bluebubbles: { enabled: true, hostUsername: 502 } }, "/x/agent.json"))
      .toThrow("senses.bluebubbles.hostUsername must be a non-empty string")
  })

  it("ignores hostUsername on other senses", () => {
    const senses = normalizeSenses({ teams: { enabled: true, hostUsername: "clawdbot" } }, "/x/agent.json")
    expect(senses.teams).toEqual({ enabled: true })
  })
})

describe("checkBlueBubblesSenseHostAccount", () => {
  const config = (bluebubbles: { enabled: boolean; hostUsername?: string }) => () => ({ senses: { bluebubbles } }) as never

  it("checks the agent's own configured host account", () => {
    expect(checkBlueBubblesSenseHostAccount("slugger", config({ enabled: true, hostUsername: "clawdbot" }), clawdbot)).toEqual({ ok: true })
    const refused = checkBlueBubblesSenseHostAccount("slugger", config({ enabled: true, hostUsername: "clawdbot" }), ari)
    expect(refused).toEqual(expect.objectContaining({ ok: false, reason: "mismatch" }))
  })

  it("fails closed when the host account is unset", () => {
    expect(checkBlueBubblesSenseHostAccount("slugger", config({ enabled: true }), ari))
      .toEqual(expect.objectContaining({ ok: false, reason: "unset" }))
  })

  it("defaults to the loaded agent config and the running account", () => {
    const result = checkBlueBubblesSenseHostAccount("slugger", config({ enabled: true, hostUsername: currentOsAccount().username }))
    expect(result).toEqual({ ok: true })
  })
})
