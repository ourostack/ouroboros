import { afterEach, describe, expect, it } from "vitest"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { buildA2AAgentCard } from "../../a2a/card"
import { defaultA2APort } from "../../a2a/config"
import { fetchA2AAgentCard, getA2ATask, sendA2AMessage } from "../../a2a/client"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"
import { onboardA2APeer } from "../../a2a/onboarding"
import { FriendResolver } from "../../mind/friends/resolver"
import { FileFriendStore } from "../../mind/friends/store-file"

let tmp: TmpBundleHandle | null = null
let server: A2AServerHandle | null = null

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
  tmp?.cleanup()
  tmp = null
})

describe("A2A core substrate", () => {
  it("builds, serves, sends, and fetches an A2A task", async () => {
    tmp = createTmpBundle({ agentName: "a2a-core" })
    expect(defaultA2APort(tmp.agentName)).toBeGreaterThanOrEqual(18920)
    const staticCard = buildA2AAgentCard({ agentName: tmp.agentName, baseUrl: "https://agent.example" })
    expect(staticCard.supportedInterfaces[0]?.url).toBe("https://agent.example/a2a")
    expect(staticCard.supportedInterfaces[0]?.protocolVersion).toBe("1.0")

    server = await startA2AServer({
      agentName: tmp.agentName,
      agentRoot: tmp.agentRoot,
      port: 0,
      turnRunner: async ({ message }) => ({ response: `echo:${message}` }),
    })

    const card = await fetchA2AAgentCard(`${server.url}/.well-known/agent-card.json`)
    expect(card.name).toBe(tmp.agentName)
    expect(card.supportedInterfaces[0]?.url).toBe(server.endpointUrl)

    const task = await sendA2AMessage({
      endpointUrl: server.endpointUrl,
      message: "hello peer",
      peerAgentId: "peer-agent",
      peerName: "Peer Agent",
      sessionKey: "case-1",
    })
    expect(task.status.state).toBe("TASK_STATE_COMPLETED")
    expect(task.artifacts?.[0]?.parts[0]?.text).toBe("echo:hello peer")

    const fetched = await getA2ATask({ endpointUrl: server.endpointUrl, taskId: task.id })
    expect(fetched.id).toBe(task.id)
  })

  it("onboards an A2A card as an agent friend", async () => {
    tmp = createTmpBundle({ agentName: "a2a-onboard" })
    const card = buildA2AAgentCard({ agentName: "remote-agent", baseUrl: "https://remote.example" })
    const fetchImpl = async () => new Response(JSON.stringify(card), {
      status: 200,
      headers: { "content-type": "application/json" },
    })

    const record = await onboardA2APeer({
      agentName: tmp.agentName,
      bundlesRoot: tmp.bundlesRoot,
      cardUrl: "https://remote.example/.well-known/agent-card.json",
      trustLevel: "friend",
      fetchImpl: fetchImpl as typeof fetch,
    })

    expect(record.kind).toBe("agent")
    expect(record.trustLevel).toBe("friend")
    expect(record.agentMeta?.a2a?.endpointUrl).toBe("https://remote.example/a2a")
    expect(record.agentMeta?.a2a?.protocolVersion).toBe("1.0")
    expect(record.externalIds.some((id) => id.provider === "a2a-agent")).toBe(true)
  })

  it("auto-created A2A peers use agent kind and never become first-imprint family", async () => {
    tmp = createTmpBundle({ agentName: "a2a-resolver" })
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const resolver = new FriendResolver(store, {
      provider: "a2a-agent",
      externalId: "remote-agent-id",
      displayName: "Remote Agent",
      channel: "a2a",
    })

    const context = await resolver.resolve()
    expect(context.friend.kind).toBe("agent")
    expect(context.friend.trustLevel).toBe("stranger")
    expect(context.channel.channel).toBe("a2a")
    expect(context.channel.senseType).toBe("open")
  })
})
