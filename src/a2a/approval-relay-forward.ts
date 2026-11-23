/**
 * The A2A process's half of the approval relay. A verified sealed message that carries friends' signed `approvalAnswer`
 * never becomes a model turn. Once the A2A server has verified it, the raw sealed message goes to the Telegram sense
 * process over `state/approvals/relay.sock`, and that process opens it again, checks it and decides it beside the taps
 * (security review H3, L4). This file is that one-line client.
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
/**
 * The Telegram process took the answer but didn't reply in time, usually because a tap holds the approval's lock. The
 * deny may still land, so this is not a refusal: the sender should tell Ari to check the card.
 */
export const RELAY_TIMED_OUT = "timed_out"
/** The one reply for a sender that isn't the owner route's peer, so nobody else learns how the relay is set up. */
export const RELAY_REFUSED = "refused"

/** Deciding waits for the approval's lock, so give it time, but never hang a request. */
export const RELAY_FORWARD_TIMEOUT_MS = 30_000
/** A reply line is a few dozen bytes; anything longer than this isn't one. */
export const MAX_RELAY_REPLY_BYTES = 1024

export async function forwardApprovalAnswer(input: { socketPath: string; message: A2AMessage; timeoutMs?: number }): Promise<string> {
  const reply = await new Promise<string>((resolve) => {
    let data = ""
    let sent = false
    let settled = false
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const socket = net.createConnection(input.socketPath)
    socket.setEncoding("utf8")
    /* v8 ignore next -- a local socket connects or fails at once, so a timeout before connect is a guard only @preserve */
    socket.setTimeout(input.timeoutMs ?? RELAY_FORWARD_TIMEOUT_MS, () => finish(sent ? RELAY_TIMED_OUT : RELAY_UNAVAILABLE))
    socket.on("connect", () => { sent = true; socket.write(`${JSON.stringify({ message: input.message })}\n`) })
    socket.on("data", (chunk: string) => {
      data += chunk
      const newline = data.indexOf("\n")
      if (newline < 0) {
        if (data.length > MAX_RELAY_REPLY_BYTES) finish(RELAY_UNAVAILABLE)
        return
      }
      let parsed: unknown
      try { parsed = (JSON.parse(data.slice(0, newline)) as { reply?: unknown }).reply } catch { parsed = undefined }
      finish(typeof parsed === "string" && RELAY_REPLY.test(parsed) ? parsed : RELAY_UNAVAILABLE)
    })
    socket.on("close", () => finish(RELAY_UNAVAILABLE))
    socket.on("error", () => finish(RELAY_UNAVAILABLE))
  })
  emitNervesEvent({
    ...(reply === RELAY_UNAVAILABLE || reply === RELAY_TIMED_OUT ? { level: "warn" as const } : {}),
    component: "channels",
    event: "channel.a2a_approval_answer_forwarded",
    message: "forwarded a relayed approval answer to the Telegram sense",
    meta: { reply },
  })
  return reply
}
