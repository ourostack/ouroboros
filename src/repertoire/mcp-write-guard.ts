/**
 * Runtime guards on MCP tool arguments that the MCP server itself cannot enforce, because only the runtime knows who is calling.
 *
 *  - A replay identity (the host's replay gate, src/a2a/replay-harness.ts) never applies a change: every tool that declares a
 *    `dry_run` argument is forced to a dry run for it, so a gate case can never alter the live house.
 *  - A replay identity may not call a write tool that has no dry run at all (see REPLAY_REFUSED_WRITE_TOOLS).
 *  - Media trust rungs (spec R12): a friend may do everything that finds media and makes it available; some arguments are
 *    family-only. The rung is the caller's trust level, not its profile, so an agent peer gets the rung of its friend record.
 *    A family-only argument from a friend returns the policy result `{ result: "family_only", tool, argument }`.
 *  - The quality and release profile tools stamp the caller into the arguments, so the tool's audit line names who asked.
 */
import { isReplayIdentity } from "../a2a/replay-harness"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolContext } from "./tools-base"

/** MCP tools whose applied writes are family-only, and which stamp the caller. */
export const OWNER_ONLY_WRITE_TOOLS: ReadonlySet<string> = new Set(["media_quality_profile", "media_release_profile"])

export type Rung = "family" | "friend"

const nonEmpty = (value: unknown): boolean => (Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null)

/** A call applies unless it says dry_run === true (an omitted dry_run is not a loophole); a read never applies. */
const applies = (args: Record<string, unknown>): boolean => args.dry_run !== true && args.dry_run !== "true" && args.action !== "read"

/**
 * The family-only column of the rung table: for each tool, the argument a friend may not use, and when a call uses it.
 * media_manual_import's family-only case (an import that replaces a file) is known only to the tool, so it gets the rung stamped.
 */
export const FAMILY_ONLY_ARGUMENTS: Readonly<Record<string, { argument: string; used: (args: Record<string, unknown>) => boolean }>> = {
  media_quality_profile: { argument: "dry_run", used: applies },
  media_release_profile: { argument: "dry_run", used: applies },
  media_blocklist: { argument: "remove_ids", used: (args) => nonEmpty(args.remove_ids) },
  media_blocklist_stalled: { argument: "owner_words", used: (args) => nonEmpty(args.owner_words) },
  media_fill_missing: { argument: "retry_blocklisted", used: (args) => nonEmpty(args.retry_blocklisted) },
}

/** Tools that decide a family-only case themselves, from the rung the guard stamps as `caller_rung`. */
export const RUNG_STAMPED_TOOLS: ReadonlySet<string> = new Set(["media_manual_import"])

/**
 * The caller's rung: family for a family friend record, the owner profile, or the agent's own turn (a turn with no friend);
 * friend for anyone else, including unknown trust and a call with no turn context at all.
 */
export function callerRung(ctx: ToolContext | undefined): Rung {
  if (ctx === undefined) return "friend"
  if (ctx.relationshipAuthorization?.profileId === "sanctuary-owner") return "family"
  const friendId = ctx?.context?.friend?.id ?? ctx?.relationshipAuthorization?.actor?.friendId
  if (friendId === undefined) return "family"
  const trust = ctx?.context?.friend?.trustLevel ?? ctx?.relationshipAuthorization?.actor?.trustLevel
  return trust === "family" ? "family" : "friend"
}

/** MCP tools that change the house and have no dry run: a replay identity may not call them at all. media_manual_import is a write only in `import` mode. */
export const REPLAY_REFUSED_WRITE_TOOLS: ReadonlySet<string> = new Set(["media_request", "media_search_now", "media_blocklist", "media_blocklist_stalled", "media_fill_missing", "media_monitor", "media_release_grab", "media_manual_import"])

export type GuardedMcpArgs = { args: Record<string, unknown>; rejected?: undefined } | { rejected: string }

function callerFriend(ctx: ToolContext | undefined): { id: string | undefined; name: string | undefined } {
  const friend = ctx?.context?.friend
  return { id: friend?.id ?? ctx?.relationshipAuthorization?.actor?.friendId, name: friend?.name }
}

export function guardMcpArgs(input: { toolName: string; declaresDryRun: boolean; args: Record<string, unknown>; ctx: ToolContext | undefined }): GuardedMcpArgs {
  const { toolName, declaresDryRun, ctx } = input
  let args = input.args
  const caller = callerFriend(ctx)
  const rung = callerRung(ctx)
  const familyOnly = FAMILY_ONLY_ARGUMENTS[toolName]
  if (familyOnly && rung === "friend" && familyOnly.used(args)) {
    emitNervesEvent({ level: "warn", component: "repertoire", event: "mcp.write_refused_non_owner", message: "a family-only MCP argument was refused for a friend", meta: { tool: toolName, argument: familyOnly.argument } })
    return { rejected: JSON.stringify({ result: "family_only", tool: toolName, argument: familyOnly.argument, summary: `Nothing ran: ${familyOnly.argument} on ${toolName} is for family. A dry run or a read of the same tool still works for this person.` }) }
  }
  if (OWNER_ONLY_WRITE_TOOLS.has(toolName)) {
    args = { ...args, caller: caller.id ? `${caller.id}${caller.name ? ` (${caller.name})` : ""}` : "unknown" }
  }
  // The model's own caller_rung is never trusted: the guard always writes it.
  if (RUNG_STAMPED_TOOLS.has(toolName)) args = { ...args, caller_rung: rung }
  const replay = Boolean(caller.id && ctx?.agentRoot && isReplayIdentity(ctx.agentRoot, caller.id))
  if (replay && !declaresDryRun && REPLAY_REFUSED_WRITE_TOOLS.has(toolName) && (toolName !== "media_manual_import" || args.mode === "import")) {
    emitNervesEvent({ level: "warn", component: "repertoire", event: "mcp.replay_write_refused", message: "a replay identity's MCP write with no dry run was refused", meta: { tool: toolName } })
    return { rejected: `${toolName} changes the live house and has no dry run, so a replay identity may not call it. Nothing ran. This is a rehearsal: answer the way you would for the owner, saying what is already on the shelf or what you would do, and leave this limit out of the reply.` }
  }
  if (replay && declaresDryRun && args.dry_run !== true) {
    emitNervesEvent({ level: "warn", component: "repertoire", event: "mcp.replay_forced_dry_run", message: "a replay identity's MCP call was forced to a dry run", meta: { tool: toolName } })
    args = { ...args, dry_run: true }
  }
  return { args }
}
