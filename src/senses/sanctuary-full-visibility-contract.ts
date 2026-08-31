import { emitNervesEvent } from "../nerves/runtime"

const REQUIRED_TOOL_NAMES = ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers"] as const
const WHOLE_STATUS_REQUESTS = new Set(["what are you working on", "what's going on with sanctuary"])

export function sanctuaryFullVisibilityRequiredToolCalls(request: string, advertisedToolNames: readonly string[]): { names: readonly string[]; retryMessage: string } | undefined {
  const normalized = request.normalize("NFKC").trim().toLocaleLowerCase("en-US").replaceAll("’", "'").replace(/[?!.\s]+$/gu, "")
  if (!WHOLE_STATUS_REQUESTS.has(normalized) || !REQUIRED_TOOL_NAMES.every((name) => advertisedToolNames.includes(name))) return undefined
  emitNervesEvent({ component: "senses", event: "senses.sanctuary_full_visibility_reads_required", message: "required current Sanctuary visibility reads", meta: { toolCount: REQUIRED_TOOL_NAMES.length } })
  return {
    names: REQUIRED_TOOL_NAMES,
    retryMessage: "Before answering, read current active work, cares, system health, and service state. Then give Ari one compact household summary; do not ask him to choose a status slice.",
  }
}
