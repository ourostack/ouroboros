// v1 → v2 agent.json migration.
// Creates explicit humanFacing/agentFacing blocks from the legacy provider.
// Uses raw fs and provider-model defaults — NO import from config.ts.

import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { getDefaultModelForProvider } from "./provider-models"
import type { AgentProvider } from "./identity"

function isAgentProvider(value: unknown): value is AgentProvider {
  return value === "azure" ||
    value === "minimax" ||
    value === "anthropic" ||
    value === "openai-codex" ||
    value === "github-copilot"
}

export function migrateAgentConfigV1ToV2(agentRoot: string): void {
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

  const provider = isAgentProvider(config.provider) ? config.provider : "anthropic"
  const model = getDefaultModelForProvider(provider)

  // Write v2 config
  const { provider: _removed, ...rest } = config
  const v2Config = {
    ...rest,
    version: 2,
    humanFacing: { provider, model },
    agentFacing: { provider, model },
  }
  fs.writeFileSync(configPath, JSON.stringify(v2Config, null, 2) + "\n", "utf-8")

  emitNervesEvent({
    component: "config/identity",
    event: "config_identity.migrate_end",
    message: "agent config migration complete",
    meta: { agentRoot, provider, model },
  })
}
