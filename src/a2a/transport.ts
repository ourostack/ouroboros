import type { A2ATransport, A2AMessage as FriendsA2AMessage } from "@ouro.bot/friends/a2a-client"
import { emitNervesEvent } from "../nerves/runtime"
import { A2AHttpStatusError, A2ARpcError, postA2AMessageEnvelope } from "./client"
import { RelayHttpError, relaySend } from "./relay-client"
import type { RelayContact } from "./relay-contacts"

export type DeliveredRung = "direct" | "relay"

/** How a relay delivery came about: `directMayHaveArrived` is true when the direct attempt failed after the request
 * could have reached the peer (a reset, a closed socket, a timeout while waiting for the reply, a gateway timeout). */
export interface DeliveryDetail {
  directMayHaveArrived: boolean
}

/** Failures that prove the request never reached the peer's agent. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"])

function causeCodes(error: Error): string[] {
  const cause = error.cause as { code?: unknown; errors?: Array<{ code?: unknown }> } | undefined
  const codes = [cause?.code, ...(cause?.errors ?? []).map((inner) => inner.code)]
  return codes.filter((code): code is string => typeof code === "string")
}

/** True when the direct attempt certainly did not reach the agent: a refused or unroutable connection, or a reply from
 * something other than the agent (a tunnel or proxy page; a gateway timeout is excluded, the agent may have it). */
function certainlyNotArrived(error: unknown): boolean {
  if (error instanceof A2AHttpStatusError) return error.status !== 504
  if (error instanceof SyntaxError) return true
  /* v8 ignore next -- fetch only throws Error instances @preserve */
  if (!(error instanceof Error)) return false
  const codes = causeCodes(error)
  return codes.length > 0 && codes.every((code) => NOT_SENT_CODES.has(code))
}

/**
 * The dependency seams for the harness A2A transport: the `fetch` both rungs use (injectable so tests never hit the
 * network), the peer's relay contact when it has shared one, and two callbacks: which rung delivered, and that the
 * relay refused the contact (so the caller can mark it stale).
 */
export interface MakeA2ATransportInput {
  fetchImpl?: typeof fetch
  relayContact?: RelayContact
  onDelivered?: (rung: DeliveredRung, detail?: DeliveryDetail) => void
  onRelayContactRefused?: () => void
}

/** The not-wired marker for rungs friends may name but the harness does not deliver on (the git mailbox). */
const NOT_WIRED = "A2A transport is not wired for this rung; the harness delivers direct, with the peer's friends-relay inbox as the fallback"

function describe(error: unknown): string {
  /* v8 ignore next -- fetch and the relay client only throw Error instances @preserve */
  if (!(error instanceof Error)) return String(error)
  const code = (error.cause as { code?: unknown } | undefined)?.code
  return typeof code === "string" ? `${error.message} (${code})` : error.message
}

/**
 * Build the harness `A2ATransport` (the outbound seam friends' `sendShare` calls). The direct rung HTTP-POSTs the
 * sealed message to the peer's endpoint as a JSON-RPC `message/send`. A JSON-RPC answer, result or error, means the
 * peer was reached and decided. Anything else (a refused connection, a timeout, a tunnel or proxy page) means the
 * peer is not there, and the SAME sealed message is queued at the peer's relay inbox, if the peer shared one. Sending
 * identical bytes is what makes a double delivery harmless: the peer's seen ledger rejects the second copy.
 */
export function makeA2ATransport(input: MakeA2ATransportInput = {}): A2ATransport {
  return {
    async send(target: { rung: "direct" | "relay" | "mailbox"; address: string }, message: FriendsA2AMessage): Promise<void> {
      if (target.rung !== "direct") {
        emitNervesEvent({
          component: "channels",
          event: "channel.a2a_transport_not_wired",
          message: "refused A2A transport over a rung the harness does not deliver on",
          meta: { rung: target.rung, address: target.address },
        })
        throw new Error(`${NOT_WIRED} (rung: ${target.rung})`)
      }
      emitNervesEvent({
        component: "channels",
        event: "channel.a2a_transport_direct_send",
        message: "delivering sealed A2A message over the direct rung",
        meta: { address: target.address },
      })
      let directError: unknown
      try {
        await postA2AMessageEnvelope({
          endpointUrl: target.address,
          message,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        })
        input.onDelivered?.("direct")
        return
      } catch (error) {
        if (error instanceof A2ARpcError) throw error
        directError = error
      }

      const contact = input.relayContact
      if (!contact) {
        const fate = certainlyNotArrived(directError) ? "it was not delivered" : "it may not have been delivered"
        throw new Error(`${describe(directError)}; ${fate}, and the peer has shared no relay contact to queue it for later`)
      }
      emitNervesEvent({
        component: "channels",
        event: "channel.a2a_transport_relay_fallback",
        message: "peer not reachable directly; queuing the sealed A2A message at its relay",
        meta: { address: target.address, relayUrl: contact.url, directError: describe(directError) },
      })
      try {
        await relaySend({ url: contact.url, handle: contact.handle, sendCredential: contact.sendCredential, message, fetchImpl: input.fetchImpl })
      } catch (error) {
        if (error instanceof RelayHttpError && [401, 403, 404].includes(error.status)) input.onRelayContactRefused?.()
        const fate = certainlyNotArrived(directError) ? "the message was not delivered" : "the message may not have been delivered"
        throw new Error(`peer not reachable directly (${describe(directError)}) or through its relay (${describe(error)}); ${fate}`)
      }
      input.onDelivered?.("relay", { directMayHaveArrived: !certainlyNotArrived(directError) })
    },
  }
}
