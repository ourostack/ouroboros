import { emitNervesEvent } from "../nerves/runtime"
import { normalizeSanctuaryMediaText } from "./sanctuary-media-optimization"

const REQUIRED_TOOL_NAMES = ["sanctuary_search_media_catalog"] as const
const HOUSEHOLD_JARGON = /\b(?:bounded|catalog read|inventory|endpoint|backend|data shape|pars(?:e|ed|ing)|json|sanctuary_search_media_catalog)\b/iu
const UNSOLICITED_PIVOT = /\b(?:what would you like|what are you in the mood for|would you like me to|do you want me to|want me to|recommend we add)\b/iu
const TITLE_LIST_GLUE = new Set(["and", "are", "catalog", "film", "films", "from", "have", "here", "in", "is", "library", "movie", "movies", "on", "shelf", "show", "shows", "the", "these", "titles", "we"])
const COUNT_ANSWER_GLUE = new Set(["and", "are", "currently", "episodes", "film", "films", "have", "in", "items", "library", "movie", "movies", "on", "shelf", "show", "shows", "the", "there", "tv", "we"])

type MediaRequestKind = "visibility" | "title_lookup" | "taste_recommendation" | "other"

interface CatalogEvidence {
  query: string
  totalItems: number
  matchedItems: number
  titles: string[]
}

function requestKind(request: string, titleQuery: string): MediaRequestKind {
  if (/\b(?:favorite|favourite|recommend|suggest|pick|what (?:movie|film|show) should|should (?:we|i) (?:watch|add)|what to watch|missing from|must (?:watch|add|get))\b/u.test(request)) return "taste_recommendation"
  if (/\b(?:see|visible|visibility|access|accessible|browse|browseable|browsable)\b.*\b(?:jellyfin|library|lib|catalog|shelf)\b|\b(?:jellyfin|library|lib|catalog|shelf)\b.*\b(?:see|visible|visibility|access|accessible|browse|browseable|browsable)\b/u.test(request)) return "visibility"
  if (titleQuery) return "title_lookup"
  return "other"
}

function requestedListCount(request: string): number | null {
  const match = request.match(/\b(?:show|list)\s+(?:me\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|[1-9]|1[0-9]|20)\b/u)
  if (!match) return null
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
  return words[match[1]!] ?? Number(match[1])
}

function requestedTitle(request: string): string {
  const conversationalSuffixRemoved = request.replace(/\s+(?:please|(?:right\s+)?now|currently)$/u, "")
  const haveMatch = conversationalSuffixRemoved.match(/\b(?:do|did|can|could)\s+(?:we|you)\s+(?:have|got|stock)\s+(.+)$/u)
  if (haveMatch) return haveMatch[1]!.replace(/^(?:the\s+)?(?:movie|film|show)\s+/u, "").trim()
  const locationMatch = conversationalSuffixRemoved.match(/\b(?:is|are)\s+(.+?)\s+(?:in|on)\s+(?:(?:the|our)\s+)?(?:jellyfin|library|lib|catalog|shelf)$/u)
  return locationMatch?.[1]?.replace(/^(?:the\s+)?(?:movie|film|show)\s+/u, "").trim() ?? ""
}

function includesNormalizedPhrase(text: string, phrase: string): boolean {
  return ` ${normalizeSanctuaryMediaText(text)} `.includes(` ${normalizeSanctuaryMediaText(phrase)} `)
}

function catalogTitleGroundingRejection(answer: string, current: CatalogEvidence, expectedCount: number | null): string | undefined {
  let remainder = ` ${normalizeSanctuaryMediaText(answer)} `
  const titles = [...new Set(current.titles.map(normalizeSanctuaryMediaText).filter(Boolean))].sort((left, right) => right.length - left.length)
  const mentioned: string[] = []
  for (const title of titles) {
    const phrase = ` ${title} `
    if (!remainder.includes(phrase)) continue
    mentioned.push(title)
    remainder = remainder.replaceAll(phrase, " ")
  }
  const hasUnverifiedWords = remainder.split(/\s+/u).some((word) => word && !TITLE_LIST_GLUE.has(word))
  const hasExactCount = expectedCount === null || (titles.length === expectedCount && mentioned.length === expectedCount)
  if (mentioned.length === 0 || !hasExactCount || hasUnverifiedWords) return "Name exactly the returned catalog titles; do not add or substitute unverified titles."
  return undefined
}

function catalogCountGroundingRejection(answer: string, current: CatalogEvidence): string | undefined {
  const formattedCount = new Intl.NumberFormat("en-US").format(current.totalItems)
  let remainder = ` ${normalizeSanctuaryMediaText(answer)} `
  const countPhrase = ` ${normalizeSanctuaryMediaText(formattedCount)} `
  const countOccurrences = remainder.split(countPhrase).length - 1
  if (countOccurrences === 0) return `Report the current verified shelf count of ${formattedCount}.`
  if (countOccurrences !== 1) return "Report the verified shelf count once."
  remainder = remainder.replaceAll(countPhrase, " ")
  if (remainder.split(/\s+/u).some((word) => word && !COUNT_ANSWER_GLUE.has(word))) return "Report only the verified count in ordinary household language."
  return undefined
}

function parseCatalogEvidence(result: string, args: Record<string, string>): CatalogEvidence | null {
  try {
    const parsed = JSON.parse(result) as { ok?: unknown; data?: { totalItems?: unknown; matchedItems?: unknown; items?: unknown } }
    if (parsed.ok !== true || !parsed.data || !Number.isSafeInteger(parsed.data.totalItems) || !Number.isSafeInteger(parsed.data.matchedItems) || !Array.isArray(parsed.data.items)) return null
    const titles = parsed.data.items.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return []
      const title = (item as { untrustedTitle?: unknown }).untrustedTitle
      return typeof title === "string" && title.trim() ? [title.trim()] : []
    })
    return {
      query: normalizeSanctuaryMediaText(args.query ?? ""),
      totalItems: parsed.data.totalItems as number,
      matchedItems: parsed.data.matchedItems as number,
      titles,
    }
  } catch {
    return null
  }
}

function sentenceCount(answer: string): number {
  return answer.split(/[.!?]+(?:\s+|$)/u).filter((part) => part.trim()).length
}

function commonAnswerRejection(answer: string, technicalDetailRequested: boolean): string | undefined {
  if (/\b(?:just|only|actually|merely)\s+(?:a\s+)?(?:bot|ai|assistant)\b|\bi\s+(?:can[’']?t|cannot|don[’']?t|do not)\s+(?:actually\s+)?watch\b|\bif i had to pick\b/iu.test(answer)) {
    return "Answer from the catalog evidence with a confident, personable choice; do not retreat into an AI or 'I cannot watch' disclaimer."
  }
  if (/\b(?:you'?d|you\s+would|you\s+need\s+to|please)\b.*\b(?:check|look at|poke|nudge)\b.*\b(?:log|logs|dashboard|jellyfin|unmanic)\b/iu.test(answer)) {
    return "Do not send Ari to check Jellyfin, Unmanic, dashboards, or logs for ordinary library visibility while safe catalog tools are available. Use the catalog evidence, or if the catalog read itself fails, say exactly what I could and could not verify."
  }
  if (UNSOLICITED_PIVOT.test(answer)) return "Answer the media question that was asked, then stop; do not append an unsolicited question or recommendation pivot."
  if (!technicalDetailRequested && HOUSEHOLD_JARGON.test(answer)) return "Use household language such as shelf or library; omit implementation jargon unless technical detail was requested."
  return undefined
}

export function sanctuaryMediaCatalogRequiredToolCalls(
  request: string,
  advertisedToolNames: readonly string[],
): { names: readonly string[]; retryMessage: string; requireSuccessfulResults: true; validateRequiredToolResult(name: string, result: string, args: Record<string, string>): boolean; validateToolCallBeforeDispatch(name: string, args: Record<string, string>): string | undefined; validateTerminalAnswer(answer: string): string | undefined } | undefined {
  if (!advertisedToolNames.includes("sanctuary_search_media_catalog")) return undefined
  const normalized = normalizeSanctuaryMediaText(request)
  const mentionsMedia = /\b(?:film|films|movie|movies|shows|tv|jellyfin|watch|shelf|stock|catalog|library|lib)\b/u.test(normalized)
  const asksCatalog = /\b(?:have|got|stock|catalog|library|lib|shelf|jellyfin|favorite|favourite|recommend|suggest|pick|watch|add|see|show|list|browse|access)\b/u.test(normalized)
  const requestedTitleQuery = requestedTitle(normalized)
  if ((!mentionsMedia && !requestedTitleQuery) || !asksCatalog) return undefined

  const kind = requestKind(normalized, requestedTitleQuery)
  const asksForAddition = /\b(?:add|missing from|must get)\b/u.test(normalized)
  const asksForCount = /\b(?:how many|count)\b/u.test(normalized)
  const listCount = requestedListCount(normalized)
  const technicalDetailRequested = /\b(?:technical|technically|implementation|endpoint|backend|debug|detail|internals?)\b/u.test(normalized)
  let latestEvidence: CatalogEvidence | undefined
  const names = [...REQUIRED_TOOL_NAMES]
  emitNervesEvent({
    component: "senses",
    event: "senses.sanctuary_media_catalog_obligation",
    message: "media catalog intent requires safe restricted catalog evidence",
    meta: { requiredToolNames: names },
  })
  return {
    names,
    requireSuccessfulResults: true,
    retryMessage: asksForCount
      ? "Use sanctuary_search_media_catalog before answering, then report only the current shelf count in ordinary household language."
      : kind === "visibility"
      ? "Use sanctuary_search_media_catalog before answering. Lead with the direct answer from current catalog evidence, report the shelf count in ordinary household language, and stop without sampled titles or a follow-up question."
      : kind === "title_lookup"
        ? "Use sanctuary_search_media_catalog with the requested title before answering. Confirm its presence or absence directly from current catalog evidence."
        : kind === "taste_recommendation"
          ? "Use sanctuary_search_media_catalog before answering. Make one concise, decisive choice grounded in returned catalog evidence; do not volunteer an AI or 'I cannot watch' disclaimer."
          : listCount
            ? `Use sanctuary_search_media_catalog with limit ${listCount} before answering, then name exactly the returned catalog titles.`
            : "Use sanctuary_search_media_catalog before answering and base any named titles on the returned catalog evidence.",
    validateRequiredToolResult(name: string, result: string, args: Record<string, string>): boolean {
      if (name !== "sanctuary_search_media_catalog") return false
      const current = parseCatalogEvidence(result, args)
      if (!current) return false
      latestEvidence = current
      return true
    },
    validateToolCallBeforeDispatch(name: string, args: Record<string, string>): string | undefined {
      if (name !== "sanctuary_search_media_catalog") return undefined
      const query = normalizeSanctuaryMediaText(args.query ?? "")
      if (kind === "title_lookup" && !query) return "Search for the requested title by name before answering whether it is on the shelf."
      if (kind === "title_lookup" && query !== requestedTitleQuery) return `Search for the requested title ${requestedTitleQuery} before answering whether it is on the shelf.`
      if (asksForAddition && !query) return "Search for one candidate title by name before recommending it as an addition."
      if (listCount && Number(args.limit) !== listCount) return `Set the catalog limit to ${listCount} so the answer is grounded in exactly the requested number of titles.`
      return undefined
    },
    validateTerminalAnswer(answer: string): string | undefined {
      const commonRejection = commonAnswerRejection(answer, technicalDetailRequested)
      if (commonRejection) return commonRejection
      const latest = latestEvidence
      if (asksForCount && latest) return catalogCountGroundingRejection(answer, latest)

      if (kind === "visibility") {
        if (answer.length > 240 || answer.includes("\n") || sentenceCount(answer) > 2) return "Answer library visibility in no more than two short sentences and 240 characters."
        if (!/^yes\b/iu.test(answer.trim())) return "Lead with a direct yes when the current catalog read succeeds."
        if (/\b(?:titles? like|such as|including)\b/iu.test(answer)) return "Do not sample titles for a visibility question; answer whether the shelf is visible and give the current count."
        if ([...answer.matchAll(/\byes\b/giu)].length > 1) return "Give one answer once; do not repeat the yes or restate the response."
        if (answer.includes("?")) return "Answer the visibility question and stop without asking a new question."
        if (latest && !answer.includes(new Intl.NumberFormat("en-US").format(latest.totalItems))) return "Include the current shelf count from the successful catalog evidence."
      }

      if (kind === "title_lookup" && latest?.query) {
        const exactMatch = latest.titles.some((title) => normalizeSanctuaryMediaText(title) === requestedTitleQuery)
        const expectedLead = exactMatch ? /^yes\b/iu : /^no\b/iu
        if (!expectedLead.test(answer.trim())) return `Lead with ${exactMatch ? "yes" : "no"} based on the current title search.`
        if (!includesNormalizedPhrase(answer, requestedTitleQuery)) return "Name the requested title in the direct answer."
      }

      if (kind === "taste_recommendation" && latest) {
        if (asksForAddition) {
          if (!latest.query || latest.matchedItems !== 0 || !includesNormalizedPhrase(answer, latest.query)) return "Recommend an addition only after an exact current catalog search shows that candidate is absent."
          if (/\b(?:i|we)\s+(?:added|requested|submitted|queued)\b/iu.test(answer)) return "Do not claim the title was added or requested when no media-request action was available."
        } else if (!latest.titles.some((title) => includesNormalizedPhrase(answer, title))) {
          return "Make the choice from a title returned by the current catalog evidence."
        }
      }
      if (kind === "other" && latest) return catalogTitleGroundingRejection(answer, latest, listCount)
      return undefined
    },
  }
}
