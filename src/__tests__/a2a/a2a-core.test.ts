import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { buildA2AAgentCard } from "../../a2a/card"
import { defaultA2APort, normalizeA2APath } from "../../a2a/config"
import { endpointForCard, fetchA2AAgentCard, getA2ATask, sendA2AMessage } from "../../a2a/client"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"
import { onboardA2APeer } from "../../a2a/onboarding"
import { FileA2ATaskStore } from "../../a2a/task-store"
import type { A2AJsonRpcRequest, A2AJsonRpcResponse, A2ATask } from "../../a2a/types"
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
  async function postRpc(method: string, params?: unknown, headers?: Record<string, string>): Promise<A2AJsonRpcResponse> {
    if (!server) throw new Error("server not started")
    const response = await fetch(server.endpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", method, params }),
    })
    return await response.json() as A2AJsonRpcResponse
  }

  function taskAccessToken(task: A2ATask): string {
    const a2a = task.metadata?.a2a && typeof task.metadata.a2a === "object" && !Array.isArray(task.metadata.a2a)
      ? task.metadata.a2a as { accessToken?: unknown }
      : undefined
    if (typeof a2a?.accessToken !== "string" || !a2a.accessToken.trim()) {
      throw new Error("missing A2A task access token")
    }
    return a2a.accessToken
  }

  function taskFromRpc(response: A2AJsonRpcResponse): A2ATask {
    if ("error" in response) throw new Error(response.error.message)
    const result = response.result as A2ATask | { task?: A2ATask }
    return result && typeof result === "object" && "task" in result && result.task ? result.task : result as A2ATask
  }

  it("builds, serves, sends, and fetches an A2A task", async () => {
    tmp = createTmpBundle({ agentName: "a2a-core" })
    expect(defaultA2APort(tmp.agentName)).toBeGreaterThanOrEqual(18920)
    expect(normalizeA2APath("custom-a2a")).toBe("/custom-a2a")
    expect(normalizeA2APath("/already-normal")).toBe("/already-normal")
    expect(normalizeA2APath(undefined)).toBe("/a2a")
      const defaultCard = buildA2AAgentCard({ agentName: tmp.agentName, baseUrl: "https://agent.example" })
      expect(defaultCard.supportedInterfaces[0]?.url).toBe("https://agent.example/a2a")
      expect(defaultCard.protocolVersion).toBe("1.0")
      expect(defaultCard.url).toBe("https://agent.example/a2a")
      expect(defaultCard.preferredTransport).toBe("JSONRPC")
      expect(defaultCard.additionalInterfaces?.[0]).toEqual({ url: "https://agent.example/a2a", transport: "JSONRPC" })
      expect(endpointForCard(defaultCard)).toBe("https://agent.example/a2a")
    const staticCard = buildA2AAgentCard({ agentName: tmp.agentName, baseUrl: "https://agent.example", path: "/custom-a2a" })
    expect(staticCard.supportedInterfaces[0]?.url).toBe("https://agent.example/custom-a2a")
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
      senderAgentId: "local-agent",
      senderName: "Local Agent",
      sessionKey: "case-1",
    })
    expect(task.kind).toBe("task")
    expect(task.status.state).toBe("completed")
    expect(task.history[0]?.kind).toBe("message")
    expect(task.status.message?.kind).toBe("message")
    expect(task.artifacts?.[0]?.parts[0]?.text).toBe("echo:hello peer")

    const fetched = await getA2ATask({
      endpointUrl: server.endpointUrl,
      taskId: task.id,
      accessToken: taskAccessToken(task),
      senderAgentId: "local-agent",
      senderName: "Local Agent",
    })
    expect(fetched.id).toBe(task.id)
    expect((fetched.metadata?.a2a as { accessToken?: unknown } | undefined)?.accessToken).toBeUndefined()

    await expect(sendA2AMessage({
      endpointUrl: server.endpointUrl,
      taskId: task.id,
      accessToken: taskAccessToken(task),
      message: "continued peer",
      senderAgentId: "local-agent",
      senderName: "Local Agent",
      sessionKey: "case-1",
    })).rejects.toThrow("task is terminal")
  })

  it("handles client validation and legacy JSON-RPC result shapes", async () => {
      const legacyCard = {
        name: "legacy",
        description: "legacy card",
        version: "0.3.0",
        supportedInterfaces: [],
        url: "https://legacy.example/a2a",
        preferredTransport: "JSONRPC",
        capabilities: {},
        defaultInputModes: [],
        defaultOutputModes: [],
        skills: [],
      }
      expect(endpointForCard(legacyCard)).toBe("https://legacy.example/a2a")
    expect(endpointForCard({
      ...legacyCard,
      preferredTransport: "GRPC",
      additionalInterfaces: [{ url: "https://legacy.example/jsonrpc", transport: "JSONRPC" }],
    })).toBe("https://legacy.example/jsonrpc")
      expect(endpointForCard({
        ...legacyCard,
        preferredTransport: "GRPC",
        supportedInterfaces: [{ url: "https://legacy.example/supported-transport", transport: "JSONRPC", protocolVersion: "1.0" }],
      })).toBe("https://legacy.example/supported-transport")
      expect(endpointForCard({
        ...legacyCard,
        preferredTransport: "GRPC",
        supportedInterfaces: [{ url: "https://legacy.example/no-binding", protocolVersion: "1.0" }],
        additionalInterfaces: [{ url: "https://legacy.example/jsonrpc-after-empty-supported", transport: "JSONRPC" }],
      })).toBe("https://legacy.example/jsonrpc-after-empty-supported")
      expect(endpointForCard({ ...legacyCard, supportedInterfaces: undefined, url: "https://legacy.example/fallback" })).toBe("https://legacy.example/fallback")
    expect(endpointForCard({
      ...legacyCard,
      supportedInterfaces: [{ url: "https://legacy.example/sse", protocolBinding: "SSE" }],
      url: "https://legacy.example/non-jsonrpc-fallback",
    })).toBe("https://legacy.example/non-jsonrpc-fallback")

    await expect(fetchA2AAgentCard("https://bad.example/card", async () => new Response("nope", {
      status: 503,
      statusText: "Unavailable",
    }) as Response)).rejects.toThrow("A2A card fetch failed")

    await expect(fetchA2AAgentCard("https://bad.example/card", async () => new Response(JSON.stringify({
      description: "missing fields",
      supportedInterfaces: [],
    }), { status: 200 }) as Response)).rejects.toThrow("missing required name")

    await expect(sendA2AMessage({
      endpointUrl: "https://bad.example/a2a",
      message: "hello",
      fetchImpl: async () => new Response("nope", { status: 502, statusText: "Bad Gateway" }) as Response,
    })).rejects.toThrow("A2A JSON-RPC request failed")

    await expect(sendA2AMessage({
      endpointUrl: "https://bad.example/a2a",
      message: "hello",
      fetchImpl: async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-1",
        error: { code: -32000, message: "remote refused" },
      }), { status: 200 }) as Response,
    })).rejects.toThrow("remote refused")

    const directTask: A2ATask = {
      id: "task-direct",
      contextId: "default",
      status: { state: "TASK_STATE_COMPLETED", timestamp: new Date().toISOString() },
      history: [],
    }
      let directRequest: A2AJsonRpcRequest | null = null
    const direct = await sendA2AMessage({
      endpointUrl: "https://legacy.example/a2a",
      message: "hello",
      senderCardUrl: "https://local.example/card",
      fetchImpl: async (_url, init) => {
        directRequest = JSON.parse(String(init?.body ?? "{}")) as A2AJsonRpcRequest
        return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-1",
        result: directTask,
        }), { status: 200 }) as Response
      },
    })
    expect(direct.id).toBe("task-direct")
      expect((directRequest?.params as { message?: { metadata?: Record<string, string> } }).message?.metadata?.senderCardUrl)
        .toBe("https://local.example/card")
      expect((directRequest?.params as { message?: { role?: string; parts?: Array<{ kind?: string }> } }).message?.role).toBe("user")
      expect((directRequest?.params as { message?: { kind?: string } }).message?.kind).toBe("message")
      expect((directRequest?.params as { message?: { parts?: Array<{ kind?: string }> } }).message?.parts?.[0]?.kind).toBe("text")

      const fallbackRequests: A2AJsonRpcRequest[] = []
      const fallbackTask: A2ATask = {
        id: "legacy-task",
        contextId: "default",
        status: { state: "completed", timestamp: new Date().toISOString() },
        history: [],
      }
      const fallback = await sendA2AMessage({
        endpointUrl: "https://legacy.example/a2a",
        message: "legacy fallback",
        fetchImpl: async (_url, init) => {
          const request = JSON.parse(String(init?.body ?? "{}")) as A2AJsonRpcRequest
          fallbackRequests.push(request)
          if (fallbackRequests.length === 1) {
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: "rpc-1",
              error: { code: -32601, message: "method not found" },
            }), { status: 200 }) as Response
          }
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: "rpc-2",
            result: { task: fallbackTask },
          }), { status: 200 }) as Response
        },
      })
      expect(fallback.id).toBe("legacy-task")
      expect(fallbackRequests.map((request) => request.method)).toEqual(["message/send", "SendMessage"])
      expect((fallbackRequests[1]?.params as { message?: { role?: string } }).message?.role).toBe("ROLE_USER")

      const getFallbackRequests: A2AJsonRpcRequest[] = []
      const fetchedFallback = await getA2ATask({
        endpointUrl: "https://legacy.example/a2a",
        taskId: "legacy-task",
        accessToken: "legacy-access",
        fetchImpl: async (_url, init) => {
          const request = JSON.parse(String(init?.body ?? "{}")) as A2AJsonRpcRequest
          getFallbackRequests.push(request)
          if (getFallbackRequests.length === 1) {
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: "rpc-1",
              error: { code: -32601, message: "method not found" },
            }), { status: 200 }) as Response
          }
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: "rpc-2",
            result: fallbackTask,
          }), { status: 200 }) as Response
        },
      })
      expect(fetchedFallback.id).toBe("legacy-task")
      expect(getFallbackRequests.map((request) => request.method)).toEqual(["tasks/get", "GetTask"])

    await expect(getA2ATask({
      endpointUrl: "https://bad.example/a2a",
      taskId: "missing",
      fetchImpl: async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-1",
        error: { code: -32001, message: "task not found" },
      }), { status: 200 }) as Response,
    })).rejects.toThrow("task not found")
  })

  it("covers A2A server error routes, legacy aliases, cancellation, and task misses", async () => {
    tmp = createTmpBundle({ agentName: "a2a-server-routes" })
    const observedPeerIds: string[] = []
    server = await startA2AServer({
      agentName: tmp.agentName,
      agentRoot: tmp.agentRoot,
      port: 0,
      turnRunner: async ({ message, peerAgentId, peerName, sessionKey }) => {
        observedPeerIds.push(peerAgentId)
        return { response: `route:${peerAgentId}:${peerName}:${sessionKey}:${message}` }
      },
    })

    const alternateCard = await fetchA2AAgentCard(`${server.url}/agent-card.json`)
    expect(alternateCard.name).toBe(tmp.agentName)

    expect((await fetch(`${server.url}/nope`)).status).toBe(404)

    const invalidJson = await fetch(server.endpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })
    expect(invalidJson.status).toBe(400)

    const tooLargeBody = await fetch(server.endpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(128 * 1024 + 1),
    })
    expect(tooLargeBody.status).toBe(413)
    const tooLargeBodyRpc = await tooLargeBody.json() as A2AJsonRpcResponse
    expect("error" in tooLargeBodyRpc ? tooLargeBodyRpc.error.message : "").toContain("request body exceeds")

    const invalidSend = await postRpc("SendMessage", { message: { role: "ROLE_USER", parts: [] } })
    expect("error" in invalidSend ? invalidSend.error.message : "").toContain("requires a text message")

    const tooLargeText = await postRpc("SendMessage", {
      message: {
        role: "ROLE_USER",
        messageId: "too-large-text",
        parts: [{ text: "x".repeat(16_001) }],
      },
    })
    expect("error" in tooLargeText ? tooLargeText.error.message : "").toContain("text exceeds")

    const noIdResponse = await fetch(server.endpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "SendMessage",
        params: { message: { role: "ROLE_USER", messageId: "no-id", parts: [{ text: "no id" }] } },
      }),
    })
    const noIdRpc = await noIdResponse.json() as A2AJsonRpcResponse
    expect(noIdRpc.id).toBeNull()

    for (const params of [
      null,
      {},
      { message: null },
      { message: { role: "ROLE_USER" } },
      { message: { role: "ROLE_USER", parts: [{ text: 123 }, "bad-part"] } },
    ]) {
      const invalidVariant = await postRpc("SendMessage", params)
      expect("error" in invalidVariant ? invalidVariant.error.message : "").toContain("requires a text message")
    }

    const legacySend = await postRpc("message/send", {
      message: {
        role: "ROLE_USER",
        messageId: "message-1",
        taskId: "task-1",
        parts: [{ text: "legacy hello" }, { text: "" }, null],
        metadata: { senderAgentId: "claimed-trusted-peer", senderName: "Claimed Peer" },
      },
    }, {
      "x-a2a-agent-id": "header-peer",
      "x-a2a-agent-name": "Header Peer",
    })
    const legacyTask = taskFromRpc(legacySend)
    if ("result" in legacySend) expect("task" in (legacySend.result as Record<string, unknown>)).toBe(false)
    const legacyAccessToken = taskAccessToken(legacyTask)
    const legacyText = legacyTask.artifacts?.[0]?.parts[0]?.text ?? ""
      expect(legacyTask.kind).toBe("task")
      expect(legacyTask.status.state).toBe("completed")
      expect(legacyTask.history[0]?.kind).toBe("message")
      expect(legacyTask.status.message?.kind).toBe("message")
      expect(legacyTask.artifacts?.[0]?.parts[0]?.kind).toBe("text")
    expect(legacyText).toContain("route:unauthenticated-a2a-peer")
    expect(legacyText).toContain(":Claimed Peer:default:legacy hello")
    expect(observedPeerIds.at(-1)).toBe("unauthenticated-a2a-peer")
    expect(legacyTask.id).not.toBe("task-1")
    expect((legacyTask.metadata?.a2a as { clientTaskId?: unknown } | undefined)?.clientTaskId).toBe("task-1")

    const headerOnlySend = await postRpc("SendMessage", {
      message: {
        role: "ROLE_USER",
        messageId: "message-header",
        parts: [{ text: "header hello" }],
      },
    }, {
      "x-a2a-agent-id": "header-peer",
      "x-a2a-agent-name": "Header Peer",
    })
    const headerOnlyTask = taskFromRpc(headerOnlySend)
    expect(headerOnlyTask.artifacts?.[0]?.parts[0]?.text ?? "").toContain(":Header Peer:default:header hello")

    const legacyMetadataSend = await postRpc("SendMessage", {
      message: {
        role: "ROLE_USER",
        messageId: "message-legacy-metadata",
        parts: [{ text: "legacy metadata hello" }],
        metadata: { cardUrl: "https://claimed.example/card", agentName: "Legacy Metadata Peer" },
      },
    })
    const legacyMetadataTask = taskFromRpc(legacyMetadataSend)
    expect(legacyMetadataTask.artifacts?.[0]?.parts[0]?.text ?? "").toContain(":Legacy Metadata Peer:default:legacy metadata hello")

    const agentIdMetadataSend = await postRpc("SendMessage", {
      message: {
        role: "ROLE_USER",
        messageId: "message-agent-id-metadata",
        parts: [{ text: "agent id metadata hello" }],
        metadata: { agentId: "legacy-agent-id", agentName: "Legacy Agent ID Peer" },
      },
    })
    const agentIdMetadataTask = taskFromRpc(agentIdMetadataSend)
    expect(agentIdMetadataTask.artifacts?.[0]?.parts[0]?.text ?? "").toContain(":Legacy Agent ID Peer:default:agent id metadata hello")

    const cardHintSend = await postRpc("SendMessage", {
      message: {
        role: "ROLE_USER",
        messageId: "message-card-hint",
        parts: [{ text: "card hint hello" }],
        metadata: { senderCardUrl: "https://sender.example/card" },
      },
    })
    const cardHintTask = taskFromRpc(cardHintSend)
    expect(cardHintTask.artifacts?.[0]?.parts[0]?.text ?? "").toContain(":https://sender.example/card:default:card hint hello")

    const anonymousSend = await postRpc("SendMessage", {
      message: {
        role: "ROLE_USER",
        messageId: "message-anonymous",
        parts: [{ text: "anonymous hello" }],
      },
    })
    const anonymousTask = taskFromRpc(anonymousSend)
    expect(anonymousTask.artifacts?.[0]?.parts[0]?.text ?? "").toContain(":Unauthenticated A2A peer:default:anonymous hello")
    expect(observedPeerIds.at(-1)).toBe("unauthenticated-a2a-peer")

    const traversal = await postRpc("SendMessage", {
      message: {
        role: "ROLE_USER",
        messageId: "message-traversal",
        taskId: "../../../agent",
        parts: [{ text: "path traversal" }],
      },
    })
    const traversalTask = taskFromRpc(traversal)
    expect(traversalTask.id).not.toBe("../../../agent")
    expect((traversalTask.metadata?.a2a as { clientTaskId?: unknown } | undefined)?.clientTaskId).toBe("../../../agent")
    expect(fs.existsSync(path.join(tmp.agentRoot, "state", "agent.json"))).toBe(false)

    const missingGetId = await postRpc("GetTask", {})
    expect("error" in missingGetId ? missingGetId.error.message : "").toContain("requires id")
    const missingGetParams = await postRpc("GetTask", null)
    expect("error" in missingGetParams ? missingGetParams.error.message : "").toContain("requires id")

    const missingTask = await postRpc("tasks/get", { id: "missing" })
    expect("error" in missingTask ? missingTask.error.message : "").toContain("requires accessToken")
    const missingTaskWithToken = await postRpc("tasks/get", {
      id: "missing",
      accessToken: "nope",
      metadata: { senderAgentId: "claimed-trusted-peer", senderName: "Claimed Peer" },
    })
    expect("error" in missingTaskWithToken ? missingTaskWithToken.error.message : "").toContain("task not found")

    const fetched = await postRpc("GetTask", {
      id: legacyTask.id,
      accessToken: legacyAccessToken,
      metadata: { senderAgentId: "claimed-trusted-peer", senderName: "Claimed Peer" },
    })
    expect(taskFromRpc(fetched).id).toBe(legacyTask.id)
    const headerFetched = await postRpc("tasks/get", {
      id: headerOnlyTask.id,
      access_token: taskAccessToken(headerOnlyTask),
    }, {
      "x-a2a-agent-id": "header-peer",
      "x-a2a-agent-name": "Header Peer",
    })
    expect(taskFromRpc(headerFetched).id).toBe(headerOnlyTask.id)
    const taskDir = path.join(tmp.agentRoot, "state", "a2a", "tasks")
    const headerTaskPath = fs.readdirSync(taskDir)
      .map((file) => path.join(taskDir, file))
      .find((file) => (JSON.parse(fs.readFileSync(file, "utf-8")) as A2ATask).id === headerOnlyTask.id)
    if (!headerTaskPath) throw new Error("missing header task file")
    for (const [index, [state, legacyState]] of [
      ["TASK_STATE_SUBMITTED", "submitted"],
      ["TASK_STATE_WORKING", "working"],
      ["TASK_STATE_FAILED", "failed"],
      ["TASK_STATE_CANCELED", "canceled"],
      ["TASK_STATE_REJECTED", "rejected"],
      ["TASK_STATE_AUTH_REQUIRED", "auth-required"],
      ["TASK_STATE_INPUT_REQUIRED", "input-required"],
      ["unknown", "unknown"],
    ].entries()) {
      const stored = JSON.parse(fs.readFileSync(headerTaskPath, "utf-8")) as A2ATask
      const nextTask: A2ATask = {
        ...stored,
        ...(index === 0 ? { kind: undefined } : {}),
        status: { ...stored.status, state },
        ...(index === 0 ? {
          history: stored.history.map((message) => ({ ...message, role: "agent" })),
          artifacts: undefined,
        } : {}),
      }
      fs.writeFileSync(headerTaskPath, `${JSON.stringify(nextTask, null, 2)}\n`, "utf-8")
      const legacyStateFetched = await postRpc("tasks/get", {
        id: headerOnlyTask.id,
        access_token: taskAccessToken(headerOnlyTask),
      }, {
        "x-a2a-agent-id": "header-peer",
        "x-a2a-agent-name": "Header Peer",
      })
      const legacyStateTask = taskFromRpc(legacyStateFetched)
      if (index === 0) expect(legacyStateTask.kind).toBe("task")
      expect(legacyStateTask.status.state).toBe(legacyState)
      if (index === 0) {
        expect(legacyStateTask.history[0]?.role).toBe("agent")
        expect(legacyStateTask.artifacts).toBeUndefined()
      }
    }
    const legacyMetadataFetched = await postRpc("GetTask", {
      id: legacyMetadataTask.id,
      accessToken: taskAccessToken(legacyMetadataTask),
      metadata: { cardUrl: "https://claimed.example/card", agentName: "Legacy Metadata Peer" },
    })
    expect(taskFromRpc(legacyMetadataFetched).id).toBe(legacyMetadataTask.id)
    const agentIdMetadataFetched = await postRpc("GetTask", {
      id: agentIdMetadataTask.id,
      accessToken: taskAccessToken(agentIdMetadataTask),
      metadata: { agentId: "legacy-agent-id", agentName: "Legacy Agent ID Peer" },
    })
    expect(taskFromRpc(agentIdMetadataFetched).id).toBe(agentIdMetadataTask.id)
    const cardHintFetched = await postRpc("GetTask", {
      id: cardHintTask.id,
      metadata: { senderCardUrl: "https://sender.example/card", accessToken: taskAccessToken(cardHintTask) },
    })
    expect(taskFromRpc(cardHintFetched).id).toBe(cardHintTask.id)
    const anonymousFetched = await postRpc("GetTask", {
      id: anonymousTask.id,
      accessToken: taskAccessToken(anonymousTask),
    })
    expect(taskFromRpc(anonymousFetched).id).toBe(anonymousTask.id)
    const wrongToken = await postRpc("GetTask", {
      id: legacyTask.id,
      accessToken: "wrong-token",
      metadata: { senderAgentId: "claimed-trusted-peer", senderName: "Claimed Peer" },
    })
    expect("error" in wrongToken ? wrongToken.error.message : "").toContain("task not found")
    const spoofedSenderWithToken = await postRpc("GetTask", {
      id: legacyTask.id,
      accessToken: legacyAccessToken,
      metadata: { senderAgentId: "different-peer", senderName: "Claimed Peer" },
    })
    expect(taskFromRpc(spoofedSenderWithToken).id).toBe(legacyTask.id)

    const legacyTaskPath = fs.readdirSync(taskDir)
      .map((file) => path.join(taskDir, file))
      .find((file) => (JSON.parse(fs.readFileSync(file, "utf-8")) as A2ATask).id === legacyTask.id)
    if (!legacyTaskPath) throw new Error("missing legacy task file")
    const storedLegacyTask = JSON.parse(fs.readFileSync(legacyTaskPath, "utf-8")) as A2ATask
    fs.writeFileSync(legacyTaskPath, `${JSON.stringify({
      ...storedLegacyTask,
      status: { ...storedLegacyTask.status, state: "TASK_STATE_INPUT_REQUIRED" },
    }, null, 2)}\n`, "utf-8")
    const continuedOpen = await postRpc("SendMessage", {
      accessToken: legacyAccessToken,
      message: {
        role: "ROLE_USER",
        messageId: "message-continue-open",
        taskId: legacyTask.id,
        parts: [{ text: "continue open legacy task" }],
        metadata: { senderAgentId: "claimed-trusted-peer", senderName: "Claimed Peer" },
      },
    })
    const continuedOpenTask = taskFromRpc(continuedOpen)
    expect(continuedOpenTask.id).toBe(legacyTask.id)
    expect(continuedOpenTask.history.length).toBeGreaterThan(legacyTask.history.length)

    const continued = await postRpc("SendMessage", {
      accessToken: legacyAccessToken,
      message: {
        role: "ROLE_USER",
        messageId: "message-continue",
        taskId: legacyTask.id,
        parts: [{ text: "continue legacy task" }],
        metadata: { senderAgentId: "claimed-trusted-peer", senderName: "Claimed Peer" },
      },
    })
    expect("error" in continued ? continued.error.message : "").toContain("task is terminal")

    const badContinuation = await postRpc("SendMessage", {
      accessToken: "wrong-token",
      message: {
        role: "ROLE_USER",
        messageId: "message-bad-continue",
        taskId: legacyTask.id,
        parts: [{ text: "bad continue" }],
      },
    })
    expect("error" in badContinuation ? badContinuation.error.message : "").toContain("task not found")

    const missingCancelId = await postRpc("CancelTask", {})
    expect("error" in missingCancelId ? missingCancelId.error.message : "").toContain("requires id")
    const missingCancelParams = await postRpc("CancelTask", null)
    expect("error" in missingCancelParams ? missingCancelParams.error.message : "").toContain("requires id")

    const missingCancelTask = await postRpc("tasks/cancel", { id: "missing" })
    expect("error" in missingCancelTask ? missingCancelTask.error.message : "").toContain("requires accessToken")
    const missingCancelTaskWithToken = await postRpc("tasks/cancel", {
      id: "missing",
      accessToken: "nope",
      metadata: { senderAgentId: "claimed-trusted-peer", senderName: "Claimed Peer" },
    })
    expect("error" in missingCancelTaskWithToken ? missingCancelTaskWithToken.error.message : "").toContain("task not found")

    const canceled = await postRpc("CancelTask", {
      id: legacyTask.id,
      accessToken: legacyAccessToken,
      metadata: { senderAgentId: "claimed-trusted-peer", senderName: "Claimed Peer" },
    })
    expect(taskFromRpc(canceled).status.state).toBe("TASK_STATE_CANCELED")

    const unknown = await postRpc("Nope", {})
    expect("error" in unknown ? unknown.error.message : "").toContain("unknown method")

    const scopedStore = new FileA2ATaskStore(tmp.agentRoot)
    expect(scopedStore.get("missing")).toBeNull()
    expect(scopedStore.get(legacyTask.id)).toBeNull()

    await server.close()
    await expect(server.close()).rejects.toThrow()
    server = null
  })

  it("turns turn-runner failures into JSON-RPC errors", async () => {
    tmp = createTmpBundle({ agentName: "a2a-server-error" })
    server = await startA2AServer({
      agentName: tmp.agentName,
      agentRoot: tmp.agentRoot,
      port: 0,
      turnRunner: async () => {
        throw new Error("turn failed")
      },
    })

    const rpc = await postRpc("SendMessage", {
      message: {
        role: "ROLE_USER",
        messageId: "message-1",
        parts: [{ text: "boom" }],
      },
    })
    expect("error" in rpc ? rpc.error.message : "").toBe("turn failed")
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
    expect(record.agentMeta?.a2a?.agentId).toBe("https://remote.example/.well-known/agent-card.json")
    expect(record.agentMeta?.a2a?.protocolVersion).toBe("1.0")
    expect(record.externalIds.some((id) => id.provider === "a2a-agent")).toBe(true)

    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await store.put(record.id, {
      ...record,
      externalIds: [
        ...record.externalIds,
        { provider: "local", externalId: "local-peer", linkedAt: new Date().toISOString() },
      ],
    })

    const updated = await onboardA2APeer({
      agentName: tmp.agentName,
      bundlesRoot: tmp.bundlesRoot,
      store,
      cardUrl: "https://remote.example/.well-known/agent-card.json",
      trustLevel: "family",
      name: "Remote Renamed",
      fetchImpl: fetchImpl as typeof fetch,
    })
    expect(updated.id).toBe(record.id)
    expect(updated.name).toBe("Remote Renamed")
    expect(updated.trustLevel).toBe("family")
    expect(updated.externalIds.some((id) => id.provider === "local" && id.externalId === "local-peer")).toBe(true)

    const preserved = await onboardA2APeer({
      agentName: tmp.agentName,
      bundlesRoot: tmp.bundlesRoot,
      store,
      cardUrl: "https://remote.example/.well-known/agent-card.json",
      fetchImpl: fetchImpl as typeof fetch,
    })
    expect(preserved.trustLevel).toBe("family")

    const spoofedCard = {
      ...card,
      name: "Evil Remote",
      supportedInterfaces: [{
        url: "https://evil.example/a2a",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      }],
      metadata: { ouro: { agentName: "remote-agent" } },
    }
    const spoofed = await onboardA2APeer({
      agentName: tmp.agentName,
      bundlesRoot: tmp.bundlesRoot,
      store,
      cardUrl: "https://evil.example/card",
      fetchImpl: (async () => new Response(JSON.stringify(spoofedCard), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    })
    expect(spoofed.id).not.toBe(record.id)
    expect(spoofed.trustLevel).toBe("acquaintance")
    expect((await store.get(record.id))?.agentMeta?.a2a?.endpointUrl).toBe("https://remote.example/a2a")

    await store.put(record.id, {
      ...preserved,
      agentMeta: {
        ...preserved.agentMeta!,
        bundleName: "",
      },
    })
    const repairedMeta = await onboardA2APeer({
      agentName: tmp.agentName,
      bundlesRoot: tmp.bundlesRoot,
      store,
      cardUrl: "https://remote.example/.well-known/agent-card.json",
      fetchImpl: fetchImpl as typeof fetch,
    })
    expect(repairedMeta.agentMeta?.bundleName).toBe("remote-agent")

    const fallbackCard = {
      name: "fallback-agent",
      description: "fallback",
      version: "1.0.0",
      url: "https://fallback.example/a2a",
      capabilities: {},
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
    }
    const fallback = await onboardA2APeer({
      agentName: tmp.agentName,
      store,
      cardUrl: "https://fallback.example/card",
      fetchImpl: (async () => new Response(JSON.stringify(fallbackCard), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    })
    expect(fallback.agentMeta?.a2a?.agentId).toBe("https://fallback.example/card")
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

  it("rejects A2A startup cleanly when the port is already bound", async () => {
    tmp = createTmpBundle({ agentName: "a2a-port-collision" })
    server = await startA2AServer({
      agentName: tmp.agentName,
      agentRoot: tmp.agentRoot,
      port: 0,
      turnRunner: async () => ({ response: "first" }),
    })
    const port = new URL(server.endpointUrl).port
    await expect(startA2AServer({
      agentName: `${tmp.agentName}-second`,
      agentRoot: tmp.agentRoot,
      port: Number(port),
      turnRunner: async () => ({ response: "second" }),
    })).rejects.toMatchObject({ code: "EADDRINUSE" })
  })
})
