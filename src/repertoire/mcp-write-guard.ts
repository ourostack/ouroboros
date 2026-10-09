/**
 * Runtime guards on MCP tool arguments that the MCP server itself cannot enforce, because only the runtime knows who is calling.
 *
 *  - A replay identity (the host's replay gate, src/a2a/replay-harness.ts) never applies a change: every tool that declares a
 *    `dry_run` argument is forced to a dry run for it, so a gate case can never alter the live house.
 *  - A replay identity may not call a write tool that has no dry run at all (see REPLAY_REFUSED_WRITE_TOOLS).
 *  - Some tools change settings only the owner may change: applying (dry_run false) is refused for any other caller, and the
 *    caller is stamped into the arguments so the tool's audit line names who asked.
 */
import { isReplayIdentity } from "../a2a/replay-harness"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolContext } from "./tools-base"

/** MCP tools whose applied writes are owner-only. */
export const OWNER_ONLY_WRITE_TOOLS: ReadonlySet<string> = new Set(["media_quality_profile"])

/** MCP tools that change the house and have no dry run: a replay identity may not call them at all. media_manual_import is a write only in `import` mode. */
export const REPLAY_REFUSED_WRITE_TOOLS: ReadonlySet<string> = new Set(["media_request", "media_search_now", "media_blocklist", "media_blocklist_stalled", "media_fill_missing", "media_release_grab", "media_manual_import"])

export type GuardedMcpArgs = { args: Record<string, unknown>; rejected?: undefined } | { rejected: string }

const isWrite = (args: Record<string, unknown>): boolean => (args.dry_run === false || args.dry_run === "false") && args.action !== "read"

function callerFriend(ctx: ToolContext | undefined): { id: string | undefined; name: string | undefined } {
  const friend = ctx?.context?.friend
  return { id: friend?.id ?? ctx?.relationshipAuthorization?.actor?.friendId, name: friend?.name }
}

export function guardMcpArgs(input: { toolName: string; declaresDryRun: boolean; args: Record<string, unknown>; ctx: ToolContext | undefined }): GuardedMcpArgs {
  const { toolName, declaresDryRun, ctx } = input
  let args = input.args
  const caller = callerFriend(ctx)
  if (OWNER_ONLY_WRITE_TOOLS.has(toolName)) {
    if (isWrite(args) && ctx?.relationshipAuthorization?.profileId !== "sanctuary-owner") {
      emitNervesEvent({ level: "warn", component: "repertoire", event: "mcp.write_refused_non_owner", message: "an owner-only MCP write was refused", meta: { tool: toolName } })
      return { rejected: `${toolName} changes settings only the owner may change. Show the owner the dry run and ask them to confirm; do not apply it for anyone else.` }
    }
    args = { ...args, caller: caller.id ? `${caller.id}${caller.name ? ` (${caller.name})` : ""}` : "unknown" }
  }
  const replay = Boolean(caller.id && ctx?.agentRoot && isReplayIdentity(ctx.agentRoot, caller.id))
  if (replay && !declaresDryRun && REPLAY_REFUSED_WRITE_TOOLS.has(toolName) && (toolName !== "media_manual_import" || args.mode === "import")) {
    emitNervesEvent({ level: "warn", component: "repertoire", event: "mcp.replay_write_refused", message: "a replay identity's MCP write with no dry run was refused", meta: { tool: toolName } })
    return { rejected: `${toolName} changes the live house and has no dry run, so a replay identity may not call it. Describe what you would do instead.` }
  }
  if (replay && declaresDryRun && args.dry_run !== true) {
    emitNervesEvent({ level: "warn", component: "repertoire", event: "mcp.replay_forced_dry_run", message: "a replay identity's MCP call was forced to a dry run", meta: { tool: toolName } })
    args = { ...args, dry_run: true }
  }
  return { args }
}
