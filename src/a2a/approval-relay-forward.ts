/**
 * The A2A process's half of the approval relay. A verified sealed message that carries friends' signed `approvalAnswer`
 * never becomes a model turn. It goes to the Telegram sense process unopened, over `state/approvals/relay.sock`, and
 * that process checks it and decides it beside the taps (security review H3, L4). This file is that one-line client.
 */
import * as net from "node:net"
import * as path from "node:path"

import { emitNervesEvent } from "../nerves/runtime"
import type { A2AMessage } from "./types"

/** Where the Telegram sense listens for relayed answers. */
export function approvalRelaySocketPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "approvals", "relay.sock")
}

/** What the sender hears back. The Telegram process answers one of these; anything else reads as unavailable. */
export const RELAY_REPLY = /^(denied|already_decided|expired|not_pending|refused:[a-z0-9_]{1,64})$/
export const RELAY_UNAVAILABLE = "refused:relay_unavailable"

/** Deciding includes one Telegram card edit before the store's write, so give it time, but never hang a request. */
export const RELAY_FORWARD_TIMEOUT_MS = 30_000

export async function forwardApprovalAnswer(input: { socketPath: string; message: A2AMessage; timeoutMs?: number }): Promise<string> {
  const reply = await new Promise<string>((resolve) => {
    let data = ""
    let settled = false
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const socket = net.createConnection(input.socketPath)
    socket.setEncoding("utf8")
    socket.setTimeout(input.timeoutMs ?? RELAY_FORWARD_TIMEOUT_MS, () => finish(RELAY_UNAVAILABLE))
    socket.on("connect", () => socket.write(`${JSON.stringify({ message: input.message })}\n`))
    socket.on("data", (chunk: string) => {
      data += chunk
      const newline = data.indexOf("\n")
      if (newline < 0) return
      let parsed: unknown
      try { parsed = (JSON.parse(data.slice(0, newline)) as { reply?: unknown }).reply } catch { parsed = undefined }
      finish(typeof parsed === "string" && RELAY_REPLY.test(parsed) ? parsed : RELAY_UNAVAILABLE)
    })
    socket.on("close", () => finish(RELAY_UNAVAILABLE))
    socket.on("error", () => finish(RELAY_UNAVAILABLE))
  })
  emitNervesEvent({
    ...(reply === RELAY_UNAVAILABLE ? { level: "warn" as const } : {}),
    component: "channels",
    event: "channel.a2a_approval_answer_forwarded",
    message: "forwarded a relayed approval answer to the Telegram sense",
    meta: { reply },
  })
  return reply
}
