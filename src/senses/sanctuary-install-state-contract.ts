import { emitNervesEvent } from "../nerves/runtime"

type InstallState = {
  runtimePackageVersion: string
  packagedBundleVersion: string
  liveBundleVersion: string | null
  parity: "exact" | "mismatch"
  journalState: "absent" | "rollback" | "committing"
  ready: boolean
  repairAction: "none" | "restart_from_verified_release" | "run_verified_update_recovery" | "roll_back_or_install_verified_release"
}

const TOOL_NAME = "sanctuary_get_install_state"
const REQUEST = /\b(?:use|run|call)\s+sanctuary_get_install_state\b/iu
const NEGATED_REQUEST = /\b(?:do not|don't|dont|never|must not|should not|cannot|can't)\s+(?:(?:under|any|all|circumstances|whatsoever|ever|please|really|actually|immediately)\s+)*(?:use|run|call)\s+sanctuary_get_install_state\b|\bnot\s+to\s+(?:use|run|call)\s+sanctuary_get_install_state\b|\b(?:do not|don't|dont)\s+(?:(?:want|need|ask)\b(?:(?![.!?;,:]).){0,64}|(?:(?:under|any|all|circumstances|whatsoever|ever|please|really|actually|immediately)\s+)*(?:attempt|try|plan|intend)\s+(?:to\s+)?)(?:use|run|call)\s+sanctuary_get_install_state\b/giu
const HISTORICAL_QUESTION = /\b(?:did|have|has)\s+(?:you\s+)?(?:use|run|call)\s+sanctuary_get_install_state\b[^.!?;:]*/giu
const MISMATCH_CODES = new Set([
  "managed_file_missing",
  "managed_file_content",
  "managed_file_mode",
  "bundle_meta_missing",
  "bundle_meta_field",
  "bundle_meta_mode",
])
const REPAIR_ACTIONS = new Set([
  "restart_from_verified_release",
  "run_verified_update_recovery",
  "roll_back_or_install_verified_release",
])

function parseInstallState(result: string): InstallState | undefined {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>
    const data = parsed.ok === true && parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
      ? parsed.data as Record<string, unknown>
      : undefined
    const repair = data?.repair && typeof data.repair === "object" && !Array.isArray(data.repair)
      ? data.repair as Record<string, unknown>
      : undefined
    if (!data
      || typeof data.runtimePackageVersion !== "string" || data.runtimePackageVersion.length === 0
      || typeof data.packagedBundleVersion !== "string" || data.packagedBundleVersion.length === 0
      || !(typeof data.liveBundleVersion === "string" && data.liveBundleVersion.length > 0 || data.liveBundleVersion === null)
      || !["exact", "mismatch"].includes(String(data.parity))
      || !Array.isArray(data.mismatchCodes)
      || !data.mismatchCodes.every((code) => typeof code === "string" && MISMATCH_CODES.has(code))
      || !["absent", "rollback", "committing"].includes(String(data.journalState))
      || typeof data.ready !== "boolean"
      || !(repair?.actor === "none" && repair.action === "none"
        || repair?.actor === "human-required" && typeof repair.action === "string" && REPAIR_ACTIONS.has(repair.action))) return undefined
    return {
      runtimePackageVersion: data.runtimePackageVersion,
      packagedBundleVersion: data.packagedBundleVersion,
      liveBundleVersion: data.liveBundleVersion,
      parity: data.parity as InstallState["parity"],
      journalState: data.journalState as InstallState["journalState"],
      ready: data.ready,
      repairAction: repair.action as InstallState["repairAction"],
    }
  } catch {
    return undefined
  }
}

function exactAnswerPattern(current: InstallState): RegExp {
  const value = (raw: string): string => raw.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const assignment = String.raw`\s*(?:(?:is)\s+|[:=]\s*)?`
  const separator = String.raw`\s*[,;]\s*`
  return new RegExp(
    String.raw`runtime(?: package)?(?: version)?${assignment}${value(current.runtimePackageVersion)}${separator}`
    + String.raw`packaged(?: bundle)?(?: version)?${assignment}${value(current.packagedBundleVersion)}${separator}`
    + String.raw`live(?: bundle)?(?: version)?${assignment}${value(current.liveBundleVersion ?? "null")}${separator}`
    + String.raw`parity${assignment}${value(current.parity)}${separator}`
    + String.raw`journal(?: state)?${assignment}${value(current.journalState)}${separator}`
    + String.raw`ready(?: state)?${assignment}${value(String(current.ready))}${separator}`
    + String.raw`repair(?: action)?${assignment}${value(current.repairAction)}(?=$|[\s,;.!?])`,
    "iu",
  )
}

const RESIDUAL_INSTALL_STATE_CLAIM = /(?:^|[.!?;,]\s*)(?:(?:and|but|however|yet)\s+)*(?:(?:the\s+)?(?:runtime(?: package)?(?: version)?|packaged(?: bundle)?(?: version)?|live(?: bundle)?(?: version)?)\s*(?:(?:is)\s+|[:=]\s*)?(?=v?\d|unknown\b|null\b|missing\b|corrupt\b)|(?:the\s+)?installed package(?: version)?\b|(?:the\s+)?parity\s*(?:(?:is)\s+|[:=]\s*)?(?=(?:not\s+)?(?:exact|mismatch)\b)|(?:the\s+)?journal(?: state)?\s*(?:(?:is)\s+|[:=]\s*)?(?=(?:not\s+)?(?:absent|rollback|committing)\b)|(?:the\s+)?ready(?: state)?\s*(?:(?:is)\s+|[:=]\s*)?(?=(?:not\s+)?(?:true|false|ready)\b)|(?:the\s+)?repair(?: action)?\s*(?:(?:is)\s+|[:=]\s*)?(?=none\b|restart_from_verified_release\b|run_verified_update_recovery\b|roll_back_or_install_verified_release\b|required\b|needed\b)|(?:the\s+)?(?:install(?:ation)?|sanctuary|bundle|service|system|it)\s+(?:is(?:\s+not)?|isn't)\s+ready\b)/iu

export function sanctuaryInstallStateRequiredToolCalls(
  request: string,
  advertisedToolNames: readonly string[],
): {
  names: readonly string[]
  retryMessage: string
  requireSuccessfulResults: true
  validateRequiredToolResult(name: string, result: string, args: Record<string, string>): boolean
  validateTerminalAnswer(answer: string): string | undefined
} | undefined {
  const normalizedRequest = request.normalize("NFKC").replace(/[‘’]/gu, "'")
  const negationRequest = normalizedRequest.replace(/,/gu, " ")
  const affirmativeRequest = negationRequest
    .replace(NEGATED_REQUEST, " ")
    .replace(HISTORICAL_QUESTION, " ")
  if (!advertisedToolNames.includes(TOOL_NAME)
    || !REQUEST.test(affirmativeRequest)) return undefined
  let current: InstallState | undefined
  const retryMessage = "Call sanctuary_get_install_state with empty arguments, then answer only from that fresh result."
  emitNervesEvent({
    component: "senses",
    event: "senses.sanctuary_install_state_required",
    message: "explicit Sanctuary install-state request requires a fresh verified read",
    meta: { requiredToolName: TOOL_NAME },
  })
  return {
    names: [TOOL_NAME],
    retryMessage,
    requireSuccessfulResults: true,
    validateRequiredToolResult: (name, result, args) => {
      if (name !== TOOL_NAME || Object.keys(args).length !== 0) return false
      current = parseInstallState(result)
      return current !== undefined
    },
    validateTerminalAnswer: (answer) => {
      if (!current) {
        return "Answer from the fresh install-state result and include its runtime package version, packaged bundle version, live bundle version, parity, journal state, ready state, and repair action."
      }
      const normalizedAnswer = answer.normalize("NFKC").replace(/[‘’]/gu, "'").replace(/\*\*|`/gu, "")
      const exactMatches = [...normalizedAnswer.matchAll(new RegExp(exactAnswerPattern(current).source, "giu"))]
      if (exactMatches.length === 0) {
        const currentValues = [
          current.runtimePackageVersion,
          current.packagedBundleVersion,
          current.liveBundleVersion ?? "null",
          current.parity,
          current.journalState,
          String(current.ready),
          current.repairAction,
        ]
        return currentValues.every((value) => normalizedAnswer.includes(value))
          ? "State each fresh install-state value exactly once in one compact answer."
          : "Answer from the fresh install-state result and include its runtime package version, packaged bundle version, live bundle version, parity, journal state, ready state, and repair action."
      }
      if (exactMatches.length !== 1) return "State each fresh install-state value exactly once in one compact answer."
      const match = exactMatches[0]!
      const residual = normalizedAnswer.replace(match[0], " ").trim()
      if (RESIDUAL_INSTALL_STATE_CLAIM.test(residual)) return "State each fresh install-state value exactly once in one compact answer."
      return undefined
    },
  }
}

const VERSION_QUESTION = /\b(?:what|which)(?:'s|\s+is)?\s+(?:your\s+|the\s+)?(?:current\s+|live\s+|installed\s+|running\s+)?version\b|\bversion\s+(?:are|r)\s+(?:you|u)\b|\bwhat\s+(?:are\s+you|you're)\s+(?:on|running)\b|\bare\s+you\s+(?:on|running)\s+(?:the\s+)?(?:latest|newest|new|current)\b/iu
const VERSION_CLAIM = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?\b/gu

/**
 * A natural question about the Butler's own version must be answered from a fresh
 * install-state read. After an upgrade the Butler once answered "Just checked the live
 * state: 0.1.0-alpha.841" from earlier conversation while it was running 845, with no
 * tool call at all. Unlike the explicit install-state contract, the wording stays free:
 * only the version it states is checked against the read.
 */
export function sanctuaryVersionQuestionRequiredToolCalls(
  request: string,
  advertisedToolNames: readonly string[],
): {
  names: readonly string[]
  retryMessage: string
  requireSuccessfulResults: true
  validateRequiredToolResult(name: string, result: string, args: Record<string, string>): boolean
  validateTerminalAnswer(answer: string): string | undefined
} | undefined {
  const normalizedRequest = request.normalize("NFKC").replace(/[‘’]/gu, "'")
  if (!advertisedToolNames.includes(TOOL_NAME) || REQUEST.test(normalizedRequest) || !VERSION_QUESTION.test(normalizedRequest)) return undefined
  let current: InstallState | undefined
  emitNervesEvent({
    component: "senses",
    event: "senses.sanctuary_version_question_required",
    message: "a question about the running version requires a fresh install-state read",
    meta: { requiredToolName: TOOL_NAME },
  })
  return {
    names: [TOOL_NAME],
    retryMessage: "Call sanctuary_get_install_state with empty arguments now, then state the version from that fresh result, not from earlier conversation.",
    requireSuccessfulResults: true,
    validateRequiredToolResult: (name, result, args) => {
      if (name !== TOOL_NAME || Object.keys(args).length !== 0) return false
      current = parseInstallState(result)
      return current !== undefined
    },
    validateTerminalAnswer: (answer) => {
      if (!current) return "Call sanctuary_get_install_state and state the version from that fresh result."
      const known = new Set([current.runtimePackageVersion, current.packagedBundleVersion, ...(current.liveBundleVersion ? [current.liveBundleVersion] : [])].map((version) => version.replace(/^v/u, "")))
      const claimed = [...answer.normalize("NFKC").matchAll(VERSION_CLAIM)].map((match) => match[0].replace(/^v/u, ""))
      if (claimed.length === 0) return `State the running version from the fresh result: ${current.runtimePackageVersion}.`
      const stale = claimed.filter((version) => !known.has(version))
      return stale.length === 0 ? undefined : `The fresh install-state result says ${current.runtimePackageVersion}; do not state ${stale.join(", ")} as the current version.`
    },
  }
}
