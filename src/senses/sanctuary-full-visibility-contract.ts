import { emitNervesEvent } from "../nerves/runtime"

const REQUIRED_TOOL_NAMES = ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers", "unraid_get_storage", "sanctuary_get_download_queue"] as const
const WHOLE_STATUS_REQUESTS = new Set(["what are you working on", "what's going on with sanctuary"])

function unsupportedCurrentClaim(answer: string, queueUnavailable: boolean): string | undefined {
  if (queueUnavailable && answer.trim().length === 0) return "Give Ari the current results that did complete and say plainly that the download queue is currently unavailable; do not return an empty answer."
  if (queueUnavailable) {
    const unsupportedQueueClaim = answer.split(/[,;!?\n]|(?<!\d)\.(?!\d)/u).some((clause) => {
      if (!/\b(?:download(?:s| queue)?|queue|SABnzbd)\b/iu.test(clause)) return false
      const explicitlyUnverified = /\b(?:(?:cannot|can't|could not|couldn't|unable to) (?:currently )?(?:be )?(?:verif(?:y|ied)|read|check(?:ed)?|confirm(?:ed)?)|(?:do not|don't) know(?: whether)?|unknown|unavailable|unverified|stale|historical|previous|prior|failed)\b|\bneeds? (?:a )?(?:fresh |authoritative )*(?:check|read|verification)\b/iu.test(clause)
      return !explicitlyUnverified
    })
    if (unsupportedQueueClaim) return "The current download-queue read is unavailable. Preserve the other current results, but do not claim a queue state; say plainly that downloads could not be verified."
  }
  const unsupported = answer.replace(/docker\.img/giu, "docker image").split(/[,;!?\n]|(?<!\d)\.(?!\d)/u).some((sentence) => {
    if (!/docker image(?: disk)?/iu.test(sentence)) return false
    const uncertaintyOnly = /\b(?:cannot|can't|unable to) (?:currently )?(?:verify|measure)\b|\b(?:unknown|unverified)\b|\bneeds? (?:a )?(?:fresh |authoritative )*(?:check|measurement)\b/iu.test(sentence)
    const stateClaim = /\b\d+(?:\.\d+)?\s*%|\bfull\b|\b(?:no|out of) space\b|\bwrites? (?:will |may )?fail\b|\b(?:healthy|unhealthy|running|stopped)\b/iu.test(sentence)
    return stateClaim || !uncertaintyOnly
  })
  if (unsupported) return "No current Butler tool measures Docker image utilization. Do not report a Docker image percentage or full state as current; say that the stale care needs a fresh authoritative check."
  const unsupportedProviderClaim = answer.split(/[,;!?\n]|(?<!\d)\.(?!\d)/u).some((clause) => {
    const explicitlyUnverified = /\b(?:cannot|can't|unable to) (?:currently )?(?:verify|confirm)|\b(?:unknown|unverified|stale|historical|previous|prior)\b|\bneeds? (?:a )?(?:fresh |authoritative )*(?:check|verification)\b/iu.test(clause)
    if (explicitlyUnverified) return false
    if (/\b(?:Astraweb|Usenet provider|download provider|(?:block|prepaid|download|provider) credit)\b/iu.test(clause)) return true
    return /\bSABnzbd\b/iu.test(clause) && /\b(?:auth(?:entication)?|authenticated|credentials?)\b/iu.test(clause)
  })
  return unsupportedProviderClaim ? "The current queue read does not prove provider credit or authentication status. Do not report Astraweb, block-credit, or authentication failure as current; say that the provider needs a fresh authoritative check." : undefined
}

function exactQueueUnavailableResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(["error", "observedAt", "ok"])) return false
  if (result.ok !== false || typeof result.observedAt !== "string" || !Number.isFinite(Date.parse(result.observedAt)) || new Date(result.observedAt).toISOString() !== result.observedAt) return false
  const error = result.error
  return !!error && typeof error === "object" && !Array.isArray(error)
    && JSON.stringify(Object.keys(error).sort()) === JSON.stringify(["code"])
    && ["credential_unavailable", "request_unavailable", "malformed_response"].includes(String((error as { code?: unknown }).code))
}

function successfulCurrentResult(name: string, result: string): { valid: boolean; queueUnavailable: boolean } {
  if (Buffer.byteLength(result, "utf8") > 1_000_000) return { valid: false, queueUnavailable: false }
  if (name === "query_active_work") return { valid: result.trimStart().startsWith("this is my current top-level live world-state."), queueUnavailable: false }
  try {
    const parsed = JSON.parse(result) as unknown
    if (name === "query_cares") return { valid: Array.isArray(parsed), queueUnavailable: false }
    if (name === "sanctuary_get_download_queue") {
      if (exactQueueUnavailableResult(parsed)) return { valid: true, queueUnavailable: true }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { valid: false, queueUnavailable: false }
      const queue = parsed as Record<string, unknown>
      const exactKeys = ["observedAt", "paused", "queuedJobs", "stateDigest", "status"]
      return { valid: JSON.stringify(Object.keys(queue).sort()) === JSON.stringify(exactKeys)
        && typeof queue.paused === "boolean"
        && typeof queue.status === "string" && Buffer.byteLength(queue.status, "utf8") <= 64
        && Number.isSafeInteger(queue.queuedJobs) && Number(queue.queuedJobs) >= 0 && Number(queue.queuedJobs) <= 1_000_000
        && typeof queue.observedAt === "string" && Number.isFinite(Date.parse(queue.observedAt)) && new Date(queue.observedAt).toISOString() === queue.observedAt
        && typeof queue.stateDigest === "string" && /^[a-f0-9]{64}$/u.test(queue.stateDigest), queueUnavailable: false }
    }
    return { valid: !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { ok?: unknown }).ok === true, queueUnavailable: false }
  } catch {
    return { valid: false, queueUnavailable: false }
  }
}

function normalizedRequest(request: string): string {
  return request.normalize("NFKC").trim().toLocaleLowerCase("en-US").replaceAll("’", "'").replace(/[?!.\s]+$/gu, "")
}

export function sanctuaryFullVisibilityEmptyResponse(request: string): string | undefined {
  return WHOLE_STATUS_REQUESTS.has(normalizedRequest(request))
    ? "I couldn't finish a trustworthy Sanctuary status check because a current check was unavailable. I won't guess or reuse old alerts; please try again shortly."
    : undefined
}

export function sanctuaryFullVisibilityRequiredToolCalls(request: string, advertisedToolNames: readonly string[]): { names: readonly string[]; retryMessage: string; requireSuccessfulResults: true; validateRequiredToolResult(name: string, result: string): boolean; validateTerminalAnswer(answer: string): string | undefined; emptyResponseFallback(): string | undefined } | undefined {
  const normalized = normalizedRequest(request)
  if (!WHOLE_STATUS_REQUESTS.has(normalized) || !REQUIRED_TOOL_NAMES.every((name) => advertisedToolNames.includes(name))) return undefined
  emitNervesEvent({ component: "senses", event: "senses.sanctuary_full_visibility_reads_required", message: "required current Sanctuary visibility reads", meta: { toolCount: REQUIRED_TOOL_NAMES.length } })
  let queueUnavailable = false
  const completed = new Set<string>()
  return {
    names: REQUIRED_TOOL_NAMES,
    retryMessage: "Before answering, read current active work, cares, system health, service state, storage, and the download queue. Current tool facts outrank care history; a stale care is a recheck item, not a present-tense fact. Then give Ari one compact household summary; do not ask him to choose a status slice.",
    requireSuccessfulResults: true,
    validateRequiredToolResult: (name, result) => {
      const validation = successfulCurrentResult(name, result)
      if (name === "sanctuary_get_download_queue" && validation.valid) queueUnavailable = validation.queueUnavailable
      if (validation.valid) completed.add(name)
      return validation.valid
    },
    validateTerminalAnswer: (answer) => unsupportedCurrentClaim(answer, queueUnavailable),
    emptyResponseFallback: () => REQUIRED_TOOL_NAMES.every((name) => completed.has(name)) ? sanctuaryFullVisibilityEmptyResponse(request) : undefined,
  }
}
