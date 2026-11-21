// The ouro CLI's commands for an agent's vault and the secrets in it, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"
import { agentErrors, unknownFlag, usageError } from "./cards"

export const VAULT_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "vault config set", effect: "private", summary: "Set a vault config value." },
  { name: "vault config status", effect: "private", readOnly: true, summary: "Show the vault config.", ax: { id: "cli:vault config status", group: "vault", effect: "read", when: "See which config keys are set at agent or machine scope, values hidden, before changing one.", errors: [unknownFlag("vault config status"), ...agentErrors("vault config status")] } },
  { name: "vault create", effect: "private", summary: "Create an agent's vault." },
  { name: "vault item list", effect: "private", readOnly: true, summary: "List vault items.", ax: { id: "cli:vault item list", group: "vault", effect: "read", when: "Find stored item paths, optionally under a --prefix, to pass as --item to another vault command.", errors: [unknownFlag("vault item list"), ...agentErrors("vault item list")] } },
  { name: "vault item set", effect: "private", summary: "Set a vault item's secret field." },
  { name: "vault item status", effect: "private", readOnly: true, summary: "Show a vault item's status.", ax: { id: "cli:vault item status", group: "vault", effect: "read", when: "Check that one stored item exists and which field names it has, never revealing secret values.", errors: [usageError("vault item status", "needs --item <path>, the item to look at.", "Find the path with ouro vault item list, then pass it as --item."), unknownFlag("vault item status"), ...agentErrors("vault item status")] } },
  { name: "vault ops porkbun set", effect: "private", summary: "Store the Porkbun account for DNS work.", ax: { id: "cli:vault ops porkbun set", group: "vault", effect: "write", when: "Before DNS work on a Porkbun domain, save that registrar account's API key pair, entered at a hidden prompt.", errors: [usageError("vault ops porkbun set", "needs --account <account>, the Porkbun account the key belongs to.", "Pass --account with the account name, such as the login email."), unknownFlag("vault ops porkbun set"), ...agentErrors("vault ops porkbun set")] } },
  { name: "vault ops porkbun status", effect: "private", readOnly: true, summary: "Show the Porkbun account status.", ax: { id: "cli:vault ops porkbun status", group: "vault", effect: "read", when: "See which Porkbun registrar accounts have API keys saved, or with --account whether one does, secrets hidden.", errors: [usageError("vault ops porkbun status", "takes only --agent and --account; another word follows it.", "Drop the extra word, or pass it as --account <account>."), unknownFlag("vault ops porkbun status"), ...agentErrors("vault ops porkbun status")] } },
  { name: "vault recover", effect: "private", summary: "Recover an agent's vault from exported keys." },
  { name: "vault replace", effect: "private", summary: "Replace an agent's vault." },
  { name: "vault status", effect: "private", readOnly: true, summary: "Show the vault's status.", ax: { id: "cli:vault status", group: "vault", effect: "read", when: "Learn whether secrets can be read on this machine: unlocked or locked, and which local store holds the key.", errors: [unknownFlag("vault status"), ...agentErrors("vault status")] } },
  { name: "vault unlock", effect: "private", summary: "Unlock an agent's vault." },
]
