import { emitNervesEvent } from "../nerves/runtime"
import type { ToolContext } from "./tools-base"

/**
 * The result a tool returns when it has no token for an OAuth connection. When the sense already knows sign-in
 * cannot start for that connection (for example the bot has no such OAuth connection), the result says exactly
 * that instead of promising a sign-in prompt that will never appear.
 */
export function authRequired(ctx: ToolContext | undefined, connection: string, need: string): string {
  const unavailable = ctx?.oauthUnavailable?.[connection]
    || (!ctx?.oauthAvailable?.includes(connection) ? "this channel has no OAuth sign-in route. human-required: use a configured Teams OAuth connection; an agent cannot supply consent or borrow another account's credentials." : undefined)
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.auth_required",
    message: "tool needs an OAuth token it does not have",
    meta: { connection, signinAvailable: !unavailable },
  })
  return unavailable
    ? `AUTH_UNAVAILABLE:${connection} -- ${need} Sign-in can't start here: ${unavailable}`
    : `AUTH_REQUIRED:${connection} -- ${need} Please sign in when prompted.`
}
