import * as path from "path"
import { FileFriendStore } from "@ouro.bot/friends"
import { fileFailureReport, type FailureSeverity } from "../heart/failure-reports"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition } from "./tools-base"
import { withCode } from "./tool-error-code"

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
      description: "File a failure report for the engineers who fix you, when a tool you need is missing or errors in a way you cannot work around. File it at once and ask the owner for nothing. Report the actual result (queued, or saved locally pending authorization); never claim delivery or a GitHub issue from a local save. A repeat retries the same report.",
      parameters: {
        type: "object",
        properties: {
          ari_words: { type: "string", description: "What the owner asked for, verbatim from the conversation." },
          tried: { type: "string", description: "What you tried: tool names and arguments, summarized." },
          error: { type: "string", description: "The tool error, or what stopped you." },
          failed_tool: { type: "string", description: "The tool that failed or that you wished existed, if there is one." },
          severity: { type: "string", enum: ["low", "medium", "high"], description: "How much this blocks the owner." },
        },
        required: ["ari_words", "tried", "error"],
        additionalProperties: false,
      },
    },
  },
  handler: async (args, ctx) => {
    if (!ctx?.agentRoot) return withCode("report_failure is unavailable: no agent runtime.", "no-agent-runtime")
    const severity = (["low", "medium", "high"] as const).includes(args.severity as FailureSeverity) ? args.severity as FailureSeverity : "medium"
    const store = new FileFriendStore(path.join(ctx.agentRoot, "friends"))
    const result = await fileFailureReport(ctx.agentRoot, store, {
      ariWords: text(args.ari_words), tried: text(args.tried), error: text(args.error),
      ...(text(args.failed_tool) ? { failedTool: text(args.failed_tool) } : {}),
      severity,
      origin: { friendId: ctx.currentSession?.friendId ?? null, channel: ctx.currentSession?.channel ?? null, key: ctx.currentSession?.key ?? null },
    })
    emitNervesEvent({ component: "repertoire", event: "repertoire.report_failure", message: "failure report requested", meta: { ok: result.ok, ...(result.ok ? { duplicate: result.duplicate } : { reason: result.reason }) } })
    if (!result.ok) {
      if ("saved" in result) return JSON.stringify({
        filed: false, saved: true, delivery: "pending_authorization", reason: result.reason, detail: result.detail,
        reportId: result.id, shortId: result.shortId, duplicate: result.duplicate, recipients: 0,
        localPath: path.join(ctx.agentRoot, "state", "reports", `${result.id}.json`),
        recovery: "agent-runnable: retain/read this local report and retry report_failure after authorization is repaired. human-required: configure a verified escalation peer and its root-owned grant, or submit a sanitized issue at https://github.com/ourostack/ouroboros/issues/new. No peer was granted access and no external issue was filed.",
      })
      return withCode(`Not filed (${result.reason}): ${result.detail}`, "report-not-filed")
    }
    return JSON.stringify({ filed: true, reportId: result.id, shortId: result.shortId, duplicate: result.duplicate, recipients: result.recipients })
  },
  ax: { id: "tool:report_failure", group: "turn-escalation", when: "Pick this when a tool you need is missing or keeps failing in a way you can't get around, to hand it to the engineers who fix you.", effect: "write", errors: [
    { code: "no-agent-runtime", means: "This turn runs without an agent home, so there is nowhere to file from.", fix: "Tell the person plainly what failed; the report can be filed from a normal chat later." },
    { code: "report-not-filed", means: "The report was refused, usually because ari_words, tried or error is missing; the message gives the reason.", fix: "Fill in all three fields and call report_failure again." },
  ] },
}
