import * as path from "path"
import { FileFriendStore } from "@ouro.bot/friends"
import { fileFailureReport, type FailureSeverity } from "../heart/failure-reports"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition } from "./tools-base"

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Lets the agent hand a failure it cannot work around to the peers who fix it. The session comes from the runtime
 * context, never from the model, so a report cannot be addressed to or attributed to anyone else.
 */
export const reportFailureToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "report_failure",
      description: "File a failure report for the engineers who fix you. Use it when a tool you need is missing, a tool errors in a way you cannot work around, or you are about to give up on what the owner asked. Then tell the owner you have filed it, with the short report id, in your own words. Do not ask the owner to do anything about it.",
      parameters: {
        type: "object",
        properties: {
          ari_words: { type: "string", description: "What the owner asked for, verbatim from the conversation." },
          tried: { type: "string", description: "What you tried: tool names and arguments, summarized." },
          error: { type: "string", description: "The tool error, or the reason you gave up." },
          failed_tool: { type: "string", description: "The tool that failed or that you wished existed, if there is one." },
          severity: { type: "string", enum: ["low", "medium", "high"], description: "How much this blocks the owner." },
        },
        required: ["ari_words", "tried", "error"],
        additionalProperties: false,
      },
    },
  },
  handler: async (args, ctx) => {
    if (!ctx?.agentRoot) return "report_failure is unavailable: no agent runtime."
    const severity = (["low", "medium", "high"] as const).includes(args.severity as FailureSeverity) ? args.severity as FailureSeverity : "medium"
    const store = new FileFriendStore(path.join(ctx.agentRoot, "friends"))
    const result = await fileFailureReport(ctx.agentRoot, store, {
      ariWords: text(args.ari_words), tried: text(args.tried), error: text(args.error),
      ...(text(args.failed_tool) ? { failedTool: text(args.failed_tool) } : {}),
      severity,
      origin: { friendId: ctx.currentSession?.friendId ?? null, channel: ctx.currentSession?.channel ?? null, key: ctx.currentSession?.key ?? null },
    })
    emitNervesEvent({ component: "repertoire", event: "repertoire.report_failure", message: "failure report requested", meta: { ok: result.ok, ...(result.ok ? { duplicate: result.duplicate } : { reason: result.reason }) } })
    if (!result.ok) return `Not filed (${result.reason}): ${result.detail}`
    return JSON.stringify({ filed: true, reportId: result.id, shortId: result.shortId, duplicate: result.duplicate, recipients: result.recipients })
  },
}
