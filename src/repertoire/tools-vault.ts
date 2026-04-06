import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { ToolDefinition } from "./tools-base"
import { getAgentName, loadAgentConfig, resolveVaultConfig, getAgentSecretsPath } from "../heart/identity"
import { createVaultAccount } from "./vault-setup"
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

      try {
        const config = loadAgentConfig()
        const { email, serverUrl } = resolveVaultConfig(agentName, config.vault)

        // Generate a strong random master password (32 bytes -> base64)
        const masterPassword = crypto.randomBytes(32).toString("base64")

        // Store master password in secrets.json BEFORE creating the account
        // so it's not lost if the process crashes after registration
        const secretsPath = getAgentSecretsPath(agentName)
        const secretsDir = path.dirname(secretsPath)
        if (!fs.existsSync(secretsDir)) {
          fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 })
        }

        let secrets: Record<string, unknown> = {}
        if (fs.existsSync(secretsPath)) {
          try {
            secrets = JSON.parse(fs.readFileSync(secretsPath, "utf-8"))
          } catch {
            // If secrets.json is corrupt, start fresh but don't lose the file
            secrets = {}
          }
        }

        secrets.vault = {
          ...(typeof secrets.vault === "object" && secrets.vault !== null ? secrets.vault : {}),
          masterPassword,
          email,
          serverUrl,
        }

        fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + "\n", {
          mode: 0o600,
        })

        // Create the vault account
        const result = await createVaultAccount(agentName, serverUrl, email, masterPassword)

        if (!result.success) {
          return `Vault setup failed: ${result.error}`
        }

        return `Vault created at ${serverUrl} for ${email}. Master password stored in secrets.json.`
      } catch (err) {
        /* v8 ignore next -- defensive: error handling @preserve */
        const reason = err instanceof Error ? err.message : String(err)
        return `Vault setup error: ${reason}`
      }
    },
    summaryKeys: [],
  },
]
