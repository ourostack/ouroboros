import { emitNervesEvent } from "../nerves/runtime"

const REQUIRED_TOOL_NAMES = ["sanctuary_search_media_catalog"] as const

function normalizedRequest(request: string): string {
  return request
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/[^a-z0-9']+/gu, " ")
    .trim()
}

export function sanctuaryMediaCatalogRequiredToolCalls(
  request: string,
  advertisedToolNames: readonly string[],
): { names: readonly string[]; retryMessage: string; validateTerminalAnswer(answer: string): string | undefined } | undefined {
  if (!advertisedToolNames.includes("sanctuary_search_media_catalog")) return undefined
  const normalized = normalizedRequest(request)
  const mentionsMedia = /\b(?:film|films|movie|movies|show|shows|tv|jellyfin|watch|shelf|stock|catalog|library)\b/u.test(normalized)
  const asksCatalog = /\b(?:have|got|stock|catalog|library|favorite|favourite|recommend|suggest|pick|watch)\b/u.test(normalized)
  const titleInventoryQuestion = /\b(?:do|did|can)\s+(?:we|you)\s+(?:have|got|stock)\s+[a-z0-9'][a-z0-9' ]*\??$/u.test(normalized)
  if ((!mentionsMedia && !titleInventoryQuestion) || !asksCatalog) return undefined

  const names = [...REQUIRED_TOOL_NAMES]
  emitNervesEvent({
    component: "senses",
    event: "senses.sanctuary_media_catalog_obligation",
    message: "media catalog intent requires safe restricted catalog evidence",
    meta: { requiredToolNames: names },
  })
  return {
    names,
    retryMessage: "Use sanctuary_search_media_catalog before answering. If asked for taste or a favorite, form a light recommendation from returned catalog evidence instead of claiming you cannot have preferences. Keep it honest: say you cannot watch, but you can pick from the household shelf.",
    validateTerminalAnswer(answer: string): string | undefined {
      return /\b(?:just|only|actually|merely)\s+(?:a\s+)?(?:bot|ai|assistant)\b|\bi don'?t actually watch\b/iu.test(answer)
        ? "Answer from the catalog evidence with a truthful but personable recommendation; do not retreat into 'I am just a bot' framing."
        : undefined
    },
  }
}
