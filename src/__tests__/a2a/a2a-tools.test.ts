import { afterEach, describe, expect, it } from "vitest"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"
import { FileFriendStore } from "../../mind/friends/store-file"
import type { FriendRecord } from "../../mind/friends/types"
import { a2aToolDefinitions } from "../../repertoire/tools-a2a"
import type { ToolContext } from "../../repertoire/tools-base"

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

function tool(name: string) {
  const def = a2aToolDefinitions.find((entry) => entry.tool.function.name === name)
  if (!def) throw new Error(`missing tool ${name}`)
  return def.handler
}

describe("A2A repertoire tools", () => {
  it("lists peers, sends messages, and fetches remote tasks", async () => {
    tmp = createTmpBundle({ agentName: "a2a-tools" })
    server = await startA2AServer({
      agentName: "remote",
      agentRoot: tmp.agentRoot,
      port: 0,
      turnRunner: async ({ message }) => ({ response: `remote:${message}` }),
    })
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const peer: FriendRecord = {
      id: "peer-1",
      name: "Remote Agent",
      trustLevel: "friend",
      role: "agent-peer",
      kind: "agent",
      agentMeta: {
        bundleName: "remote",
        familiarity: 0,
        sharedMissions: [],
        outcomes: [],
        a2a: {
          endpointUrl: server.endpointUrl,
          agentId: "remote-agent",
        },
      },
      externalIds: [{ provider: "a2a-agent", externalId: "remote-agent", linkedAt: new Date().toISOString() }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    }
    await store.put(peer.id, peer)
    const ctx: ToolContext = {
      signin: async () => undefined,
      agentRoot: tmp.agentRoot,
      friendStore: store,
      context: {
        friend: { ...peer, id: "requester", trustLevel: "family", kind: "human" },
        channel: {
          channel: "cli",
          senseType: "local",
          availableIntegrations: [],
          supportsMarkdown: false,
          supportsStreaming: false,
          supportsRichCards: false,
          maxMessageLength: Infinity,
        },
      },
    }

    const peers = JSON.parse(await tool("a2a_list_peers")({}, ctx))
    expect(peers).toHaveLength(1)

    const sent = JSON.parse(await tool("a2a_send_message")({ friend_id: peer.id, message: "ping" }, ctx))
    expect(sent.status.state).toBe("TASK_STATE_COMPLETED")
    expect(sent.artifacts[0].parts[0].text).toBe("remote:ping")

    const fetched = JSON.parse(await tool("a2a_get_task")({ friend_id: peer.id, task_id: sent.id }, ctx))
    expect(fetched.id).toBe(sent.id)
  })
})
