import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  BlueBubblesHostAccountError,
  resetBlueBubblesServerAccountCache,
  verifyBlueBubblesServerAccount,
} from "../../../senses/bluebubbles/host-account-verifier"

function serverInfo(computerId: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ status, data: { computer_id: computerId } }), { status })) as unknown as typeof fetch
}

const base = {
  agent: "slugger",
  serverUrl: "http://127.0.0.1:1234",
  password: "pw",
  requestTimeoutMs: 1000,
}

describe("verifyBlueBubblesServerAccount", () => {
  beforeEach(() => resetBlueBubblesServerAccountCache())

  it("passes when the server runs under the declared host account", async () => {
    const fetchImpl = serverInfo("clawdbot@ouroboros-host")
    await expect(verifyBlueBubblesServerAccount({ ...base, hostUsername: "clawdbot", fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:1234/api/v1/server/info?password=pw", expect.objectContaining({ method: "GET" }))
  })

  it("refuses a server running under another account and treats the field as a human decision", async () => {
    const attempt = verifyBlueBubblesServerAccount({ ...base, hostUsername: "clawdbot", fetchImpl: serverInfo("arimendelow@ouroboros-host") })
    await expect(attempt).rejects.toBeInstanceOf(BlueBubblesHostAccountError)
    await expect(verifyBlueBubblesServerAccount({ ...base, hostUsername: "clawdbot", fetchImpl: serverInfo("arimendelow@ouroboros-host") }))
      .rejects.toThrow('runs under macOS account "arimendelow", but the agent\'s iMessage host is "clawdbot"')
    await expect(verifyBlueBubblesServerAccount({ ...base, hostUsername: "clawdbot", fetchImpl: serverInfo("arimendelow@ouroboros-host") }))
      .rejects.toThrow("Changing senses.bluebubbles.hostUsername is a human decision")
  })

  it("fails closed when no host account is declared, without contacting the server", async () => {
    const fetchImpl = serverInfo("arimendelow@ouroboros-host")
    await expect(verifyBlueBubblesServerAccount({ ...base, hostUsername: undefined, fetchImpl }))
      .rejects.toThrow("no host account is declared (senses.bluebubbles.hostUsername)")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ["an HTTP error", serverInfo("clawdbot@host", 500)],
    ["a missing computer_id", serverInfo(undefined)],
    ["a computer_id without a username", serverInfo("@host")],
    ["a network failure", vi.fn(async () => { throw new Error("ECONNREFUSED") }) as unknown as typeof fetch],
  ])("fails closed on %s", async (_label, fetchImpl) => {
    await expect(verifyBlueBubblesServerAccount({ ...base, hostUsername: "clawdbot", fetchImpl }))
      .rejects.toThrow("could not confirm which macOS account the BlueBubbles server at http://127.0.0.1:1234 runs under")
  })

  it("reuses a confirmation for a minute, then checks again", async () => {
    let now = 1_000_000
    const fetchImpl = serverInfo("clawdbot@host")
    const input = { ...base, serverUrl: "http://127.0.0.1:1234/", hostUsername: "clawdbot", fetchImpl, now: () => now }
    await verifyBlueBubblesServerAccount(input)
    await verifyBlueBubblesServerAccount(input)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now += 60_001
    await verifyBlueBubblesServerAccount(input)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("asks the server again when a fresh check is requested, despite a recent confirmation", async () => {
    const fetchImpl = serverInfo("clawdbot@host")
    const input = { ...base, hostUsername: "clawdbot", fetchImpl, now: () => 1_000_000 }
    await verifyBlueBubblesServerAccount(input)
    await verifyBlueBubblesServerAccount({ ...input, fresh: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("forgets a confirmation as soon as the server reports another account", async () => {
    let now = 1_000_000
    let computerId = "clawdbot@host"
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { computer_id: computerId } }))) as unknown as typeof fetch
    const input = { ...base, hostUsername: "clawdbot", fetchImpl, now: () => now }
    await verifyBlueBubblesServerAccount(input)
    now += 60_001
    computerId = "arimendelow@host"
    await expect(verifyBlueBubblesServerAccount(input)).rejects.toThrow("arimendelow")
    computerId = "clawdbot@host"
    await verifyBlueBubblesServerAccount(input)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it("uses the global fetch by default", async () => {
    const original = global.fetch
    global.fetch = serverInfo("clawdbot@host")
    try {
      await expect(verifyBlueBubblesServerAccount({ ...base, hostUsername: "clawdbot" })).resolves.toBeUndefined()
    } finally {
      global.fetch = original
    }
  })
})
