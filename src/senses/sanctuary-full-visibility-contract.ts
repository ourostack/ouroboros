import { createHash } from "node:crypto"
import { CARE_INCIDENT_RECOVERY_REVIEW_RISK, isManagedDockerCareIncidentBinding, projectCareEvidence, type CareIncidentBinding, type CareRecord } from "../arc/cares"
import { emitNervesEvent } from "../nerves/runtime"

const REQUIRED_TOOL_NAMES = ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers", "unraid_get_storage", "unraid_get_notifications", "sanctuary_get_download_queue"] as const
const WHOLE_STATUS_REQUESTS = new Set(["what are you working on", "what's going on with sanctuary"])

function unsupportedCurrentClaim(answer: string, queueUnavailable: boolean, authorizedDockerClaims: readonly string[]): string | undefined {
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
    const normalizedSentence = sentence.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    if (authorizedDockerClaims.some((claim) => claim.normalize("NFKC").replace(/[.!?]+$/u, "").trim().toLocaleLowerCase("en-US") === normalizedSentence)) return false
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
    if (name === "unraid_get_notifications") {
      const root = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
      const error = root?.error && typeof root.error === "object" && !Array.isArray(root.error) ? root.error as Record<string, unknown> : null
      const unavailable = root?.ok === false
        && JSON.stringify(Object.keys(root).sort()) === JSON.stringify(["error", "ok"])
        && !!error && JSON.stringify(Object.keys(error).sort()) === JSON.stringify(["code", "degraded", "message"])
        && ["unauthorized", "forbidden", "timeout", "transport", "graphql", "invalid_response"].includes(String(error.code))
        && typeof error.message === "string" && Buffer.byteLength(error.message, "utf8") <= 512 && error.degraded === true
      if (unavailable) return { valid: true, queueUnavailable: false }
      const data = root?.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data as Record<string, unknown> : null
      return { valid: root?.ok === true && Array.isArray(data?.unacknowledged) && typeof data.truncated === "boolean", queueUnavailable: false }
    }
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
  return request.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/[‘’]/gu, "'").replace(/[^a-z0-9']+/gu, " ").trim()
}

export function isSanctuaryCurrentStatusIntent(request: string): boolean {
  const normalized = normalizedRequest(request)
  if (WHOLE_STATUS_REQUESTS.has(normalized)) return true
  if (["what's up", "everything good", "anything wrong"].includes(normalized)) return true
  if (!normalized || /\b(?:yesterday|tomorrow|document|movie request)\b/u.test(normalized)) return false
  if (/^do you care about\b/u.test(normalized) || /\b(?:plex|jellyfin|sonarr|radarr|docker labels?)\b/u.test(normalized)) return false
  const wholeScope = /\b(?:anything|everything|what(?:'s| is)|things?)\b/u.test(normalized)
  const current = /\b(?:now|right now|currently|going on|status)\b/u.test(normalized)
  const concern = /\b(?:care about|should (?:i|we) know about|working on|going on|status)\b/u.test(normalized)
  return wholeScope && current && concern
}

export function sanctuaryFullVisibilityEmptyResponse(request: string): string | undefined {
  return isSanctuaryCurrentStatusIntent(request)
    ? "I couldn't finish a trustworthy Sanctuary status check because a current check was unavailable. I won't guess or reuse old alerts; please try again shortly."
    : undefined
}

export function sanctuaryFullVisibilityRequiredToolCalls(request: string, _advertisedToolNames: readonly string[], authorizedDockerClaims: () => readonly string[] = () => []): { names: readonly string[]; retryMessage: string; requireSuccessfulResults: true; validateRequiredToolResult(name: string, result: string): boolean; validateTerminalAnswer(answer: string): string | undefined; emptyResponseFallback(): string | undefined } | undefined {
  if (!isSanctuaryCurrentStatusIntent(request)) return undefined
  emitNervesEvent({ component: "senses", event: "senses.sanctuary_full_visibility_reads_required", message: "required current Sanctuary visibility reads", meta: { toolCount: REQUIRED_TOOL_NAMES.length } })
  let queueUnavailable = false
  const completed = new Set<string>()
  return {
    names: REQUIRED_TOOL_NAMES,
    retryMessage: "Before answering, read current active work, cares, system health, service state, storage, notifications, and the download queue. Current tool facts outrank care history; a stale care is a recheck item, not a present-tense fact. Then give Ari one compact household summary; do not ask him to choose a status slice.",
    requireSuccessfulResults: true,
    validateRequiredToolResult: (name, result) => {
      const validation = successfulCurrentResult(name, result)
      if (name === "sanctuary_get_download_queue" && validation.valid) queueUnavailable = validation.queueUnavailable
      if (validation.valid) completed.add(name)
      return validation.valid
    },
    validateTerminalAnswer: (answer) => unsupportedCurrentClaim(answer, queueUnavailable, authorizedDockerClaims()),
    emptyResponseFallback: () => REQUIRED_TOOL_NAMES.every((name) => completed.has(name)) ? sanctuaryFullVisibilityEmptyResponse(request) : undefined,
  }
}

const SAFE_LABEL = "Docker image disk utilization"
const INCONCLUSIVE_RISK = "Docker image disk utilization verification is inconclusive."
const ACTIVE_RISK = "A fresh Unraid notification reports high Docker image disk utilization."

type CapturedDockerCare = Pick<CareRecord, "id" | "updatedAt" | "currentRisk" | "salience" | "steward"> & { nextCheckAt: string; binding: CareIncidentBinding; hasOtherUnresolvedBindings: boolean }
export type StaleDockerMutation = Record<string, string>

function qualifyingDockerCare(care: CareRecord, now: number): CapturedDockerCare | undefined {
  if (projectCareEvidence(care, now) === care) return undefined
  const binding = care.incidentBindings?.find(isManagedDockerCareIncidentBinding)
  return binding ? {
    id: care.id, updatedAt: care.updatedAt, currentRisk: care.currentRisk, nextCheckAt: care.nextCheckAt!, salience: care.salience, steward: care.steward, binding: { ...binding },
    hasOtherUnresolvedBindings: care.incidentBindings!.some((candidate) => candidate !== binding && !candidate.resolvedAt),
  } : undefined
}

function canonicalNotification(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const notification = value as Record<string, unknown>
  return typeof notification.id === "string"
    && typeof notification.createdAt === "string"
    && Number.isFinite(Date.parse(notification.createdAt))
    && new Date(notification.createdAt).toISOString() === notification.createdAt
    && typeof notification.title === "string"
    && typeof notification.summary === "string"
    && typeof notification.severity === "string"
    && typeof notification.degraded === "boolean"
    ? notification
    : undefined
}

function notificationRevision(notification: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({
    id: notification.id,
    createdAt: notification.createdAt,
    severity: notification.severity,
    title: notification.title,
    summary: notification.summary,
    degraded: notification.degraded,
  })).digest("hex")
}

function dockerObservation(result: string, care: CapturedDockerCare): { outcome: "fresh_recovered" | "fresh_active" | "inconclusive"; revision?: string; risk?: string } {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>
    const data = parsed?.ok === true && parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? parsed.data as Record<string, unknown> : undefined
    if (!data || data.truncated !== false || !Array.isArray(data.unacknowledged)) return { outcome: "inconclusive" }
    const boundary = Math.max(Date.parse(care.updatedAt), Date.parse(care.nextCheckAt))
    const related = data.unacknowledged.map(canonicalNotification).filter((item): item is Record<string, unknown> => !!item).filter((item) => {
      const text = `${item.title} ${item.summary}`
      return item.degraded === false && Date.parse(String(item.createdAt)) > boundary && /docker/iu.test(text) && /image/iu.test(text) && /(?:disk|utilization)/iu.test(text)
    })
    if (related.length !== 1) return { outcome: "inconclusive" }
    const notification = related[0]!
    const text = `${notification.title} ${notification.summary}`
    const revision = notificationRevision(notification)
    if (/\b(?:recover(?:ed|y)?|resolved|normal|healthy|cleared)\b/iu.test(text)) return { outcome: "fresh_recovered", revision }
    if (/\b(?:critical|warning|error|full|high|9[0-9]%|100%)\b/iu.test(`${notification.severity} ${text}`)) {
      return { outcome: "fresh_active", revision, risk: ACTIVE_RISK }
    }
    return { outcome: "inconclusive" }
  } catch {
    return { outcome: "inconclusive" }
  }
}

function mutationFor(care: CapturedDockerCare, observation: ReturnType<typeof dockerObservation>, now: number): StaleDockerMutation {
  const common = {
    id: care.id,
    source: care.binding.source,
    incidentKey: care.binding.incidentKey,
    expectedUpdatedAt: care.updatedAt,
    label: SAFE_LABEL,
    why: observation.outcome === "inconclusive" ? "Current Unraid notification evidence was inconclusive." : "Current Unraid notification evidence was checked.",
  }
  if (observation.outcome === "fresh_recovered") {
    const unresolvedContextRemains = care.hasOtherUnresolvedBindings
    return {
      ...common,
      action: "resolve_incident",
      currentRisk: unresolvedContextRemains ? CARE_INCIDENT_RECOVERY_REVIEW_RISK : "",
      nextCheckAt: unresolvedContextRemains ? new Date(now + 15 * 60_000).toISOString() : "",
    }
  }
  return {
    ...common,
    action: "upsert_incident",
    kind: "system",
    status: observation.outcome === "fresh_active" ? "active" : "watching",
    salience: care.salience,
    stewardship: care.steward,
    classifiedRevision: observation.outcome === "fresh_active" ? observation.revision! : care.binding.classifiedRevision,
    currentRisk: observation.outcome === "fresh_active" ? observation.risk! : INCONCLUSIVE_RISK,
    nextCheckAt: new Date(now + 15 * 60_000).toISOString(),
  }
}

function exactMutation(expected: StaleDockerMutation, actual: Record<string, string>): boolean {
  return Object.keys(expected).length === Object.keys(actual).length
    && Object.entries(expected).every(([key, value]) => actual[key] === value)
}

export function sanctuaryStaleDockerCareRequiredToolCalls(activeCares: readonly CareRecord[], now: number, _advertisedToolNames: readonly string[]): {
  names: readonly string[]
  retryMessage: string
  requireSuccessfulResults: true
  validateRequiredToolResult(name: string, result: string, args: Record<string, string>): boolean
  validateToolCallBeforeDispatch(name: string, args: Record<string, string>): string | undefined
  requiredToolCallsAfterResult(name: string, args: Record<string, string>, result: string): readonly string[]
  expectedMutations(): readonly StaleDockerMutation[]
  currentRiskClaims(): readonly string[]
} | undefined {
  const cares = activeCares.map((care) => qualifyingDockerCare(care, now)).filter((care): care is CapturedDockerCare => !!care)
  if (cares.length === 0) return undefined
  emitNervesEvent({ component: "senses", event: "senses.sanctuary_stale_docker_care_verification_required", message: "stale Docker Care requires current notification verification", meta: { careCount: cares.length } })
  let verifierComplete = false
  let mutations: StaleDockerMutation[] = []
  const completed = new Set<string>()
  return {
    names: ["unraid_get_notifications"],
    get retryMessage() {
      return mutations.length === 0
        ? "Recheck the stale Docker image disk Care from current notifications, then apply every exact evidence-bounded Care update before answering."
        : `Apply these exact evidence-bounded care_manage arguments before answering: ${JSON.stringify(mutations)}.`
    },
    requireSuccessfulResults: true,
    validateRequiredToolResult: (name, result, args) => {
      if (name === "unraid_get_notifications") return Buffer.byteLength(result, "utf8") <= 1_000_000
      if (name !== "care_manage") return false
      const expected = mutations.find((candidate) => exactMutation(candidate, args))
      if (!expected) return false
      try {
        const care = JSON.parse(result) as CareRecord
        const binding = care.incidentBindings?.find((candidate) => candidate.source === expected.source && candidate.incidentKey === expected.incidentKey)
        const resolved = expected.action === "resolve_incident" ? !!binding?.resolvedAt : binding?.classifiedRevision === expected.classifiedRevision
        const updatedUnderCas = typeof care.updatedAt === "string" && Date.parse(care.updatedAt) > Date.parse(expected.expectedUpdatedAt)
        const wholeCareResolutionValid = expected.action !== "resolve_incident" || expected.currentRisk !== "" || care.incidentBindings?.some((candidate) => !candidate.resolvedAt) || care.status === "resolved"
        if (care.id !== expected.id || care.label !== SAFE_LABEL || care.why !== expected.why || care.currentRisk !== (expected.currentRisk || null) || care.nextCheckAt !== (expected.nextCheckAt || null) || (expected.status && care.status !== expected.status) || !resolved || !updatedUnderCas || !wholeCareResolutionValid) return false
        completed.add(care.id)
        return completed.size === mutations.length
      } catch {
        return false
      }
    },
    validateToolCallBeforeDispatch: (name, args) => {
      if (name !== "care_manage") return undefined
      if (!verifierComplete) return "Read current Unraid notifications before mutating stale Docker Care."
      return mutations.some((candidate) => exactMutation(candidate, args)) ? undefined : `Only these exact evidence-bounded stale Docker Care mutations are authorized in this turn: ${JSON.stringify(mutations)}.`
    },
    requiredToolCallsAfterResult: (name, _args, result) => {
      if (name !== "unraid_get_notifications") return []
      mutations = cares.map((care) => mutationFor(care, dockerObservation(result, care), now))
      verifierComplete = true
      emitNervesEvent({ component: "senses", event: "senses.sanctuary_stale_docker_care_verification_completed", message: "current notification verification produced bounded Care outcomes", meta: { careCount: cares.length, mutationCount: mutations.length } })
      return ["care_manage"]
    },
    expectedMutations: () => mutations.map((mutation) => ({ ...mutation })),
    currentRiskClaims: () => mutations.filter((mutation) => mutation.currentRisk === ACTIVE_RISK).map((mutation) => mutation.currentRisk!),
  }
}
