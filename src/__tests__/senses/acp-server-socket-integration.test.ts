import { PassThrough } from "node:stream"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

import { createFrontendApprovalRuntime } from "../../heart/frontend-approval-runtime"
import { FrontendSessionService } from "../../heart/frontend-session-service"
import { startFrontendSocketServer } from "../../heart/frontend-socket"
import { createAcpServer } from "../../senses/acp-server"

function collect(output: PassThrough) {
  const messages: any[] = []
  let buffer = ""
  output.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) messages.push(JSON.parse(line))
    }
  })
  return messages
}

async function waitFor(messages: any[], predicate: (message: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = messages.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("ACP integration message did not arrive")
}

describe("Ouro ACP server socket integration", () => {
  it("streams a real frontend socket turn through ACP", async () => {
    const frontendPath = path.join("/tmp", `ouro-acp-integration-${process.pid}-${Date.now()}.sock`)
    const service = new FrontendSessionService({
      runner: async (input) => {
        input.frontendEventSink?.onEvent({ type: "text_delta", data: { text: "PONG" } })
        return {
          response: "PONG",
          ponderDeferred: false,
          deliveries: [],
          deliveryFailures: [],
          turnOutcome: "settled",
        }
      },
    })
    const frontend = await startFrontendSocketServer({ socketPath: frontendPath, service })
    const input = new PassThrough()
    const output = new PassThrough()
    const messages = collect(output)
    const acp = createAcpServer({
      agent: "boss",
      friendId: "local-ari",
      frontendSocketPath: frontendPath,
      stdin: input,
      stdout: output,
    })
    acp.start()

    try {
      input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')
      await waitFor(messages, (message) => message.id === 1)
      input.write('{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}\n')
      const sessionId = (await waitFor(messages, (message) => message.id === 2)).result.sessionId
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "PING" }] },
      })}\n`)

      expect(await waitFor(messages, (message) => message.method === "session/update")).toMatchObject({
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "PONG" } } },
      })
      expect(await waitFor(messages, (message) => message.id === 3)).toEqual({
        jsonrpc: "2.0",
        id: 3,
        result: { stopReason: "end_turn" },
      })
    } finally {
      acp.stop()
      await frontend.stop()
    }
  })

  it("round-trips a durable permission decision through the real frontend socket", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-acp-approval-"))
    const frontendPath = path.join("/tmp", `ouro-acp-approval-${process.pid}-${Date.now()}.sock`)
    const authority = createFrontendApprovalRuntime({
      agentRoot: (agent) => path.join(root, `${agent}.ouro`),
      settleApproval: async (approval) => {
        approval.frontendEventSink.onEvent({ type: "text_delta", data: { text: approval.optionId } })
        return {
          response: approval.optionId,
          ponderDeferred: false,
          deliveries: [],
          deliveryFailures: [],
          turnOutcome: "settled",
        }
      },
    })
    const service = new FrontendSessionService({
      authority,
      runner: async (input) => ({
        response: "",
        ponderDeferred: false,
        deliveries: [],
        deliveryFailures: [],
        turnOutcome: "suspended",
        suspension: await input.approvalCoordinatorFactory!({
          sessionPath: path.join(root, "boss.ouro", "state", "sessions", "friend", "mcp", "session.json"),
          baseSessionRevision: "d".repeat(64),
        }).propose({
          toolCall: {
            id: "call-1",
            type: "function",
            function: { name: "unraid_restart_container", arguments: '{"container":"calibre-web"}' },
          },
          arguments: { container: "calibre-web" },
          preCallMessages: [{ role: "user", content: "restart it" }],
          frozenAssistantMessage: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: { name: "unraid_restart_container", arguments: '{"container":"calibre-web"}' },
            }],
          },
          schemaDigest: "a".repeat(64),
          toolDigest: "b".repeat(64),
          policyDigest: "c".repeat(64),
          policyId: "unraid.restart.v1",
          actionClass: "unraid.container.restart",
        }),
      }),
    })
    const frontend = await startFrontendSocketServer({ socketPath: frontendPath, service })
    const input = new PassThrough()
    const output = new PassThrough()
    const messages = collect(output)
    const acp = createAcpServer({
      agent: "boss",
      friendId: "11111111-1111-4111-8111-111111111111",
      frontendSocketPath: frontendPath,
      stdin: input,
      stdout: output,
    })
    acp.start()

    try {
      input.write('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}\n')
      const sessionId = (await waitFor(messages, (message) => message.id === 1)).result.sessionId
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "restart it" }] },
      })}\n`)
      const permission = await waitFor(messages, (message) => message.method === "session/request_permission")
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: permission.id,
        result: { outcome: { outcome: "selected", optionId: "allow-once" } },
      })}\n`)

      expect(await waitFor(messages, (message) => message.id === 2)).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { stopReason: "end_turn" },
      })
      expect(messages).toContainEqual(expect.objectContaining({
        method: "session/update",
        params: expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "allow-once" },
          }),
        }),
      }))
    } finally {
      acp.stop()
      await frontend.stop()
      service.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
