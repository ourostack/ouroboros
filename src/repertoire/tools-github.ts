import type { ToolDefinition } from "./tools-base"
import { githubRequest } from "./github-client"
import { emitNervesEvent } from "../nerves/runtime"

export const githubToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "file_ouroboros_bug",
        description: "File a bug or feature request on the ouroboros harness repo. Requires GitHub OAuth authorization.",
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
        return "AUTH_REQUIRED:github -- I need access to GitHub. Please sign in when prompted."
      }
      const owner = "ouroborosbot"
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
  },
]