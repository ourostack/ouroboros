// v1 → v2 agent.json migration.
// Moves model from secrets.json into agent.json under humanFacing/agentFacing.
// Uses raw fs — NO import from config.ts (avoids circular dependency).

import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

const MODEL_FIELD: Record<string, string> = {
  azure: "modelName",
  minimax: "model",
  anthropic: "model",
  "openai-codex": "model",
  "github-copilot": "model",
}

export interface MigrateConfigDeps {
  secretsRoot?: string
}

function resolveSecretsPath(agentRoot: string, deps?: MigrateConfigDeps): string {
  const agentName = path.basename(agentRoot).replace(/\.ouro$/, "")
  const secretsBase = deps?.secretsRoot ?? path.join(require("os").homedir(), ".agentsecrets")
  return path.join(secretsBase, agentName, "secrets.json")
}

export function migrateAgentConfigV1ToV2(agentRoot: string, deps?: MigrateConfigDeps): void {
  const configPath = path.join(agentRoot, "agent.json")

  let raw: string
  try {
    raw = fs.readFileSync(configPath, "utf-8")
  } catch {
    return // No agent.json — nothing to migrate
  }

  let config: Record<string, unknown>
  try {
    config = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error(`Cannot parse agent.json at ${configPath} — invalid JSON`)
  }

  const version = typeof config.version === "number" ? config.version : 1
  if (version >= 2) {
    emitNervesEvent({
      component: "config/identity",
      event: "config_identity.migrate_skip",
      message: "agent config already v2, skipping migration",
      meta: { agentRoot },
    })
    return
  }

  emitNervesEvent({
    component: "config/identity",
    event: "config_identity.migrate_start",
    message: "migrating agent config v1 → v2",
    meta: { agentRoot },
  })

  const provider = config.provider as string | undefined
  let model = ""

  if (provider) {
    const secretsPath = resolveSecretsPath(agentRoot, deps)
    try {
      const secretsRaw = fs.readFileSync(secretsPath, "utf-8")
      const secrets = JSON.parse(secretsRaw) as Record<string, unknown>
      const providers = secrets.providers as Record<string, Record<string, unknown>> | undefined
      if (providers) {
        const providerSecrets = providers[provider]
        if (providerSecrets) {
          /* v8 ignore next -- fallback: all known providers are in MODEL_FIELD @preserve */
          const fieldName = MODEL_FIELD[provider] ?? "model"
          const rawModel = providerSecrets[fieldName]
          model = typeof rawModel === "string" ? rawModel : ""

          // Strip model from secrets
          delete providerSecrets[fieldName]
          fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + "\n", "utf-8")
        }
      }
    } catch {
      // Missing or malformed secrets.json — leave model as empty string
    }
  }

  // Write v2 config
  const { provider: _removed, ...rest } = config
  const v2Config = {
    ...rest,
    version: 2,
    humanFacing: { provider: provider ?? "anthropic", model },
    agentFacing: { provider: provider ?? "anthropic", model },
  }
  fs.writeFileSync(configPath, JSON.stringify(v2Config, null, 2) + "\n", "utf-8")

  emitNervesEvent({
    component: "config/identity",
    event: "config_identity.migrate_end",
    message: "agent config migration complete",
    meta: { agentRoot, provider: provider ?? "unknown", model },
  })
}
