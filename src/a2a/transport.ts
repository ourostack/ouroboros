import type { A2ATransport, A2AMessage as FriendsA2AMessage } from "@ouro.bot/friends/a2a-client"
import { emitNervesEvent } from "../nerves/runtime"
import { postA2AMessageEnvelope } from "./client"

/**
 * The dependency seam for the harness A2A transport: the `fetch` used by the
 * `direct` rung's HTTP POST (injectable so tests never hit the network).
 */
export interface MakeA2ATransportInput {
  fetchImpl?: typeof fetch
}

/** The not-wired marker for the relay/mailbox rungs (the stubbed seam). */
const RELAY_NOT_WIRED = "A2A relay/mailbox transport is not wired — see ourostack/friends-relay"

/**
 * Build the harness `A2ATransport` (the outbound delivery seam friends' `sendShare`
 * calls). Only the `direct` rung is wired in this slice: it HTTP-POSTs the sealed,
 * `wrapInDataPart`-wrapped message to the peer's `endpointUrl` (the `address`) as a
 * JSON-RPC `message/send`, reusing the harness `client.ts` plumbing. The `relay` and
 * `mailbox` rungs are a TYPED-but-STUBBED seam: they throw a clear not-wired error
 * naming the `ourostack/friends-relay` dependency, so a future relay slice has an
 * exact insertion point without this slice shipping an untrusted relay.
 */
export function makeA2ATransport(input: MakeA2ATransportInput = {}): A2ATransport {
  return {
    async send(target: { rung: "direct" | "relay" | "mailbox"; address: string }, message: FriendsA2AMessage): Promise<void> {
      if (target.rung === "direct") {
        emitNervesEvent({
          component: "channels",
          event: "channel.a2a_transport_direct_send",
          message: "delivering sealed A2A message over the direct rung",
          meta: { address: target.address },
        })
        await postA2AMessageEnvelope({
          endpointUrl: target.address,
          message,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        })
        return
      }

      // relay / mailbox: the typed-but-stubbed seam. Loud refusal (security-relevant:
      // we never silently fall through to an untrusted relay).
      emitNervesEvent({
        component: "channels",
        event: "channel.a2a_transport_not_wired",
        message: "refused A2A transport over a non-direct rung (not wired)",
        meta: { rung: target.rung, address: target.address, dependency: "ourostack/friends-relay" },
      })
      throw new Error(`${RELAY_NOT_WIRED} (rung: ${target.rung})`)
    },
  }
}
