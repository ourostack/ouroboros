import type { ToolDefinition } from "./tools-base"
import { withCode } from "./tool-error-code"
import { authRequired } from "./auth-required"
import { githubRequest } from "./github-client"
import { emitNervesEvent } from "../nerves/runtime"

export const githubToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "file_ouroboros_bug",
        description: "File a bug or feature request on the ouroboros harness repo. Requires GitHub OAuth authorization from a configured Teams connection. Outside that channel, use the returned human-required issue route and report_failure to preserve the problem locally; no host/provider credentials are borrowed.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Issue title" },
            body: { type: "string", description: "Issue body/description (optional)" },
            labels: { type: "string", description: "Comma-separated label names (optional)" },
          },
          required: ["title"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.github_tool_call",
        message: "github tool invoked",
        meta: {},
      })
      if (!ctx?.githubToken) {
        const recovery = authRequired(ctx, "github", "I need access to GitHub.")
        return withCode(`${recovery}\nNot filed on GitHub. human-required: sign in at https://github.com/ourostack/ouroboros/issues/new and submit the title/body after checking for private data. agent-runnable: call report_failure to retain the failure locally if no authorized filing route is available.`, "auth-required")
      }
      const owner = "ourostack"
      const repo = "ouroboros"
      const payload: Record<string, unknown> = { title: args.title }
      if (args.body) payload.body = args.body
      if (args.labels) {
        payload.labels = args.labels.split(",").map((l) => l.trim())
      }
      return githubRequest(ctx.githubToken, "POST", `/repos/${owner}/${repo}/issues`, JSON.stringify(payload))
    },
    integration: "github",
    summaryKeys: ["title"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "files a GitHub issue" },
    ax: { id: "tool:file_ouroboros_bug", group: "turn-escalation", when: "Pick this to open a public GitHub issue on the harness repo when you hold GitHub access; without it, report_failure keeps the problem locally.", effect: "write", errors: [
      { code: "auth-required", means: "This turn has no GitHub authorization, so nothing was filed; the message gives the sign-in or manual route.", fix: "Call report_failure with the same facts, and pass on the manual route if the person wants a public issue." },
      { code: "orientation-hold", means: "This turn is on a correction hold, so new issues wait.", fix: "Call orientation_get, settle what the person meant, then go ahead if it is still right." },
    ] },
  },
]
