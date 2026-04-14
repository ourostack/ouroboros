import type { ToolDefinition } from "./tools-base"
import { getAgentName } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"

export const vaultToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "vault_setup",
        description:
          "Set up the agent's credential vault. Creates a Bitwarden account on the configured Vaultwarden server. One-time operation — idempotent if vault already exists.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: async () => {
      const agentName = getAgentName()

      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.vault_tool_call",
        message: "vault_setup invoked",
        meta: { tool: "vault_setup", agentName },
      })

      return [
        "Vault setup is human-required.",
        "",
        "Why I cannot do it here:",
        "  Creating or unlocking a vault requires secret entry that must stay out of agent context.",
        "",
        "Do this in a terminal:",
        `  ouro vault create --agent ${agentName}`,
        `  ouro vault unlock --agent ${agentName}`,
      ].join("\n")
    },
    summaryKeys: [],
  },
]
