import { emitNervesEvent } from "../nerves/runtime"

const REQUIRED_TOOL_NAMES = ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers", "unraid_get_storage", "sanctuary_get_download_queue"] as const
const WHOLE_STATUS_REQUESTS = new Set(["what are you working on", "what's going on with sanctuary"])

function unsupportedCurrentClaim(answer: string): string | undefined {
  const unsupported = answer.replace(/docker\.img/giu, "docker image").split(/[,;!?\n]|(?<!\d)\.(?!\d)/u).some((sentence) => {
    if (!/docker image(?: disk)?/iu.test(sentence)) return false
    const uncertaintyOnly = /\b(?:cannot|can't|unable to) (?:currently )?(?:verify|measure)\b|\b(?:unknown|unverified)\b|\bneeds? (?:a )?(?:fresh |authoritative )*(?:check|measurement)\b/iu.test(sentence)
    const stateClaim = /\b\d+(?:\.\d+)?\s*%|\bfull\b|\b(?:no|out of) space\b|\bwrites? (?:will |may )?fail\b|\b(?:healthy|unhealthy|running|stopped)\b/iu.test(sentence)
    return stateClaim || !uncertaintyOnly
  })
  if (unsupported) return "No current Butler tool measures Docker image utilization. Do not report a Docker image percentage or full state as current; say that the stale care needs a fresh authoritative check."
  const unsupportedProviderState = answer.split(/[,;!?\n]|(?<!\d)\.(?!\d)/u).some((clause) => {
    const explicitlyUnverified = /\b(?:cannot|can't|unable to) (?:currently )?(?:verify|confirm)|\b(?:unknown|unverified|stale|historical|previous|prior)\b|\bneeds? (?:a )?(?:fresh |authoritative )*(?:check|verification)\b/iu.test(clause)
    if (explicitlyUnverified) return false
    if (/\b(?:Astraweb|Usenet provider|download provider|(?:block|prepaid|download|provider) credit)\b/iu.test(clause)) return true
    return /\bSABnzbd\b/iu.test(clause) && /\b(?:auth(?:entication)?|authenticated|credentials?)\b/iu.test(clause)
  })
  return unsupportedProviderState ? "The current queue read does not prove provider credit or authentication state. Do not report Astraweb, block-credit, or authentication failure as current; say that provider state needs a fresh authoritative check." : undefined
}

function successfulCurrentResult(name: string, result: string): boolean {
  if (Buffer.byteLength(result, "utf8") > 1_000_000) return false
  if (name === "query_active_work") return result.trimStart().startsWith("this is my current top-level live world-state.")
  try {
    const parsed = JSON.parse(result) as unknown
    if (name === "query_cares") return Array.isArray(parsed)
    if (name === "sanctuary_get_download_queue") {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
      const queue = parsed as Record<string, unknown>
      const exactKeys = ["observedAt", "paused", "queuedJobs", "stateDigest", "status"]
      return JSON.stringify(Object.keys(queue).sort()) === JSON.stringify(exactKeys)
        && typeof queue.paused === "boolean"
        && typeof queue.status === "string" && Buffer.byteLength(queue.status, "utf8") <= 64
        && Number.isSafeInteger(queue.queuedJobs) && Number(queue.queuedJobs) >= 0 && Number(queue.queuedJobs) <= 1_000_000
        && typeof queue.observedAt === "string" && Number.isFinite(Date.parse(queue.observedAt)) && new Date(queue.observedAt).toISOString() === queue.observedAt
        && typeof queue.stateDigest === "string" && /^[a-f0-9]{64}$/u.test(queue.stateDigest)
    }
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { ok?: unknown }).ok === true
  } catch {
    return false
  }
}

export function sanctuaryFullVisibilityRequiredToolCalls(request: string, advertisedToolNames: readonly string[]): { names: readonly string[]; retryMessage: string; requireSuccessfulResults: true; validateRequiredToolResult(name: string, result: string): boolean; validateTerminalAnswer(answer: string): string | undefined } | undefined {
  const normalized = request.normalize("NFKC").trim().toLocaleLowerCase("en-US").replaceAll("’", "'").replace(/[?!.\s]+$/gu, "")
  if (!WHOLE_STATUS_REQUESTS.has(normalized) || !REQUIRED_TOOL_NAMES.every((name) => advertisedToolNames.includes(name))) return undefined
  emitNervesEvent({ component: "senses", event: "senses.sanctuary_full_visibility_reads_required", message: "required current Sanctuary visibility reads", meta: { toolCount: REQUIRED_TOOL_NAMES.length } })
  return {
    names: REQUIRED_TOOL_NAMES,
    retryMessage: "Before answering, read current active work, cares, system health, service state, storage, and the download queue. Current tool facts outrank care history; a stale care is a recheck item, not a present-tense fact. Then give Ari one compact household summary; do not ask him to choose a status slice.",
    requireSuccessfulResults: true,
    validateRequiredToolResult: successfulCurrentResult,
    validateTerminalAnswer: unsupportedCurrentClaim,
  }
}
