import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { getChannelCapabilities } from "@ouro.bot/friends"
import type { ProviderCapability } from "../../heart/core"
import { resolveToolDefinition, selectToolsForChannel, toolSelectionSchemas } from "../../repertoire/tools"

export const SANCTUARY_OWNER_ADDITIONS = [
  "shell", "shell_status", "shell_tail", "read_file", "write_file", "edit_file", "glob", "grep",
  "web_search", "search_facts", "consult_diary", "consult_notes", "get_friend_note",
  "session_summary", "query_session", "set_reasoning_effort", "restart_runtime", "revive_sense",
]

export function sanctuaryContainmentBoundariesFixture(providerCapabilities: ProviderCapability[] = ["reasoning-effort"]) {
  const packaged = JSON.parse(readFileSync("deploy/unraid/sanctuary.ouro/tool-profiles.json", "utf8"))
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const boundary = (id: "sanctuary-owner" | "sanctuary-household" | "sanctuary-event", version: number) => {
    const original = packaged.profiles[id]
    const profile = {
      id, ...original, version,
      toolNames: id === "sanctuary-owner"
        ? [...original.toolNames.filter((name: string) => !SANCTUARY_OWNER_ADDITIONS.includes(name)), ...SANCTUARY_OWNER_ADDITIONS]
        : original.toolNames,
    }
    const selection = selectToolsForChannel(getChannelCapabilities(id === "sanctuary-event" ? "inner" : "telegram"), undefined, undefined, new Set(providerCapabilities), undefined, undefined, {
      agentName: "sanctuary", relationshipAuthorization: { profileId: id, advertisedToolNames: profile.toolNames },
    })
    const schemas = toolSelectionSchemas(selection)
    const excludedToolNames = ["vault_get", "mcp_call", "exec", "credential_get", ...(id === "sanctuary-owner" ? [] : SANCTUARY_OWNER_ADDITIONS)]
    return {
      profileId: id, profileVersion: version, profileDigest: digest(profile), profileToolNames: profile.toolNames,
      providerCapabilities: [...providerCapabilities], schemaDigest: digest(schemas), schemaToolNames: schemas.map((tool) => tool.function.name),
      ordinaryDefinitionCount: selection.ordinary.length, engineSchemaCount: selection.engine.length,
      profileExact: true, schemasExact: true, handlersExact: true, poisonedSchemaIntersectionCount: 0,
      excludedToolNames, excludedSchemaIntersectionCount: 0, fabricatedHandlerInvocationCount: 0,
      excludedToolAttemptCount: excludedToolNames.length, excludedToolRejectedCount: excludedToolNames.length,
      excludedToolInvokedCount: 0, excludedToolSideEffectCount: 0,
      globallyResolvableExcludedToolCount: excludedToolNames.filter((name) => resolveToolDefinition(name)).length,
    }
  }
  return {
    "sanctuary-owner": boundary("sanctuary-owner", 8),
    "sanctuary-household": boundary("sanctuary-household", 5),
    "sanctuary-event": boundary("sanctuary-event", 4),
  }
}
