import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const loadAgentConfig = vi.hoisted(() => vi.fn())
vi.mock("../../../heart/identity", () => ({
  loadAgentConfig,
  getAgentName: () => "slugger",
  getAgentRoot: () => "/tmp/AgentBundles/slugger.ouro",
  getAgentToolsRoot: () => "/tmp/AgentBundles/slugger.ouro/state/tools",
}))

import { createBlueBubblesClient } from "../../../senses/bluebubbles/client"
import { resetBlueBubblesServerAccountCache } from "../../../senses/bluebubbles/host-account-verifier"

const chat = {
  chatGuid: "any;-;ari@mendelow.me",
  chatIdentifier: "ari@mendelow.me",
  isGroup: false,
  sessionKey: "chat:any;-;ari@mendelow.me",
  sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" } as const,
}
const config = { serverUrl: "http://bluebubbles.local", password: "pw", accountId: "default" }
const channel = { port: 18790, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 30000 }

/** A fake BlueBubbles server running under `serverAccount`; records the actions it was asked to do. */
function fakeServer(serverAccount: string): { fetch: typeof fetch; actions: string[] } {
  const actions: string[] = []
  const impl = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input))
    if (url.pathname === "/api/v1/server/info") {
      return new Response(JSON.stringify({ data: { computer_id: `${serverAccount}@ouroboros-host` } }))
    }
    actions.push(url.pathname)
    return new Response(JSON.stringify({ status: 200, data: { guid: "sent-guid" } }))
  })
  return { fetch: impl as unknown as typeof fetch, actions }
}

describe("BlueBubbles client host account gate", () => {
  const originalFetch = global.fetch
  beforeEach(() => {
    resetBlueBubblesServerAccountCache()
    loadAgentConfig.mockReturnValue({ senses: { bluebubbles: { enabled: true, hostUsername: "clawdbot" } } })
  })
  afterEach(() => {
    global.fetch = originalFetch
  })

  it("sends when the server runs under the declared host account", async () => {
    const server = fakeServer("clawdbot")
    global.fetch = server.fetch
    const client = createBlueBubblesClient(config, channel)
    await expect(client.sendText({ chat, text: "hi" })).resolves.toEqual({ messageGuid: "sent-guid" })
    expect(server.actions).toEqual(["/api/v1/message/text"])
  })

  it("refuses every Apple ID action when the server runs under another account", async () => {
    const server = fakeServer("arimendelow")
    global.fetch = server.fetch
    const client = createBlueBubblesClient(config, channel)
    const refusal = 'runs under macOS account "arimendelow", but the agent\'s iMessage host is "clawdbot"'
    await expect(client.sendText({ chat, text: "hi" })).rejects.toThrow(refusal)
    await expect(client.editMessage({ messageGuid: "g", text: "edit" })).rejects.toThrow(refusal)
    await expect(client.setTyping(chat, true)).rejects.toThrow(refusal)
    await expect(client.markChatRead(chat)).rejects.toThrow(refusal)
    expect(server.actions).toEqual([])
  })

  it("fails the health check when the server runs under another account", async () => {
    const server = fakeServer("arimendelow")
    global.fetch = server.fetch
    await expect(createBlueBubblesClient(config, channel).checkHealth()).rejects.toThrow("arimendelow")
  })

  it("fails closed when the running agent declares no host account", async () => {
    loadAgentConfig.mockReturnValue({ senses: { bluebubbles: { enabled: true } } })
    const server = fakeServer("arimendelow")
    global.fetch = server.fetch
    await expect(createBlueBubblesClient(config, channel).sendText({ chat, text: "hi" }))
      .rejects.toThrow("no host account is declared")
    loadAgentConfig.mockReturnValue({})
    await expect(createBlueBubblesClient(config, channel).sendText({ chat, text: "hi" }))
      .rejects.toThrow("no host account is declared")
    expect(server.actions).toEqual([])
  })

  it("uses an explicitly given agent and host account instead of the running agent's", async () => {
    const server = fakeServer("clawdbot")
    global.fetch = server.fetch
    loadAgentConfig.mockImplementation(() => { throw new Error("no ambient agent") })
    const client = createBlueBubblesClient(config, channel, { agent: "slugger", hostUsername: "clawdbot" })
    await expect(client.sendText({ chat, text: "hi" })).resolves.toEqual({ messageGuid: "sent-guid" })
    await expect(createBlueBubblesClient(config, channel, { agent: "slugger", hostUsername: undefined }).sendText({ chat, text: "hi" }))
      .rejects.toThrow('BlueBubbles refused for agent "slugger": no host account is declared')
  })
})
