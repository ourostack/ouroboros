// Whether a shell beside the daemon could send iMessages as the agent's person (design §3.4, the shell boundary).
// senses.bluebubbles.hostUsername names the macOS account signed in to the agent's own Apple ID, so a daemon running
// under it can at most send as the agent. Under any other account, the person's own Messages may be signed in.
import { emitNervesEvent } from "../../nerves/runtime"

export type IMessageHostTrust = "shared-apple-id" | "separate"

/** `separate` only when the daemon runs under the declared host account; an undeclared one counts as shared. */
export function imessageHostTrust(hostUsername: string | undefined, daemonUser: string): IMessageHostTrust {
  const trust: IMessageHostTrust = hostUsername?.trim() && hostUsername.trim() === daemonUser ? "separate" : "shared-apple-id"
  emitNervesEvent({ level: "debug", component: "senses", event: "senses.bluebubbles_host_trust", message: "judged whether the daemon could send as the person", meta: { trust } })
  return trust
}
