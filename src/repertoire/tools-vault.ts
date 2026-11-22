import { withCode, type ToolDefinition } from "./tools-base"
import { getAgentName } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"

export const vaultToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "vault_setup",
        description:
          "Explain how a person sets up or unlocks this agent's credential vault. Returns the terminal commands to run; changes nothing.",
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

      return withCode([
        "Vault setup is human-required.",
        "",
        "Why I cannot do it here:",
        "  Creating or unlocking a vault requires secret entry that must stay out of agent context.",
        "",
        "Do this in a terminal:",
        `  ouro vault create --agent ${agentName}`,
        `  ouro vault unlock --agent ${agentName}`,
      ].join("\n"), "human-required")
    },
    summaryKeys: [],
    riskProfile: { mutates: "none", risk: "low", reason: "returns the setup steps and changes nothing" },
    ax: { id: "tool:vault_setup", group: "turn-vault", when: "Pick this when someone asks you to create or unlock your own vault; the reply gives them the terminal steps.", effect: "person-only", idempotent: true, errors: [
      { code: "human-required", means: "Creating or unlocking a vault needs a secret typed by a person, so this tool never does it itself.", fix: "Ask the person to run ouro vault create only if the agent has no vault yet, else ouro vault unlock; never ask for the secret." },
      { code: "guardrail-blocked", means: "Only the agent's family may set up its vault, and the person asking isn't family.", fix: "Don't pass on the vault commands; tell them a family member has to ask." },
    ] },
  },
]
