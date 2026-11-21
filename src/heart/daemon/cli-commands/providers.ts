// The ouro CLI's commands for an agent's model providers, credentials and integrations, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"
import { agentErrors, unknownFlag, usageError } from "./cards"

export const PROVIDERS_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "auth", effect: "private", summary: "Store or check provider credentials for an agent." },
  { name: "auth verify", effect: "private", readOnly: true, summary: "Check that an agent's provider credentials work.", ax: { id: "cli:auth verify", group: "providers", effect: "read", when: "After storing or rotating a key, test each credential live without changing any of them.", errors: [unknownFlag("auth verify"), ...agentErrors("auth verify")] } },
  { name: "account ensure", effect: "private", summary: "Make sure an agent has its account and mail keys." },
  { name: "check", effect: "private", readOnly: true, summary: "Check an agent's provider lane.", example: "check --lane inner", ax: { id: "cli:check", group: "providers", effect: "read", when: "Make one live call on the outward or inner lane to learn whether the agent can think right now; it records the result as that lane's readiness.", errors: [usageError("check", "needs --lane outward or --lane inner.", "Add --lane outward for the person-facing lane or --lane inner for the agent's own."), unknownFlag("check"), ...agentErrors("check")] } },
  { name: "connect", effect: "private", summary: "Guide setup of an integration or local sense." },
  { name: "provider refresh", effect: "private", summary: "Refresh the daemon's cached provider credentials." },
  { name: "use", effect: "private", summary: "Choose the provider and model for a lane." },
  { name: "config models", effect: "private", readOnly: true, summary: "List the models the agent's provider offers.", ax: { id: "cli:config models", group: "providers", effect: "read", when: "Before choosing a model with config model, list the ids the GitHub Copilot account offers.", errors: [unknownFlag("config models"), ...agentErrors("config models")] } },
]
