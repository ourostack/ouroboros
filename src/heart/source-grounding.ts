/**
 * Primary-source grounding for claims about external works (books, shows, films, their characters).
 *
 * A model asked about a work it half-remembers will invent plausible names and present them as fact; a principle in
 * the prompt did not stop that. This check runs where an answer is about to be delivered and judges the answer against
 * what the turn actually looked up: a name that appears in no lookup result, and is not house vocabulary or the
 * person's own words, is a name the model made up. Only a lookup (a web search or page fetch, a catalog lookup, a
 * curl, the books tool) can clear a name that is claimed to come from a work. Memory, notes, the diary and ordinary
 * shell output cannot, because they may hold an earlier fabrication. Pure functions; the runtime calls them at settle
 * for agents that opt in (see ToolContext.answerGates).
 */
import { emitNervesEvent } from "../nerves/runtime"

export interface TurnToolRecord {
  name: string
  args: Record<string, string>
  result: string
}

export interface GroundingFinding {
  kind: "invented" | "unsourced_claim"
  names: string[]
  lookups: number
  /** The correction to send the model back with. */
  message: string
}

const LOOKUP_TOOL_NAMES = new Set(["web_search", "media_search", "media_episodes"])
const LOOKUP_TOOL_PATTERN = /^(web_fetch|fetch_url|fetch_page|read_url|read_page|browse\w*)$/
const SHELL_LOOKUP = /\b(curl|wget)\b|https?:\/\/|\bbooks\s+(get|search|series|library\s+(find|search))\b/

const STRONG_CUE = /\b(books?|novels?|movies?|films?|anime|saga|trilogy|albums?|episodes?|protagonists?)\b/i
const WORK_CUE = /\b(books?|novels?|series|saga|trilogy|shows?|movies?|films?|anime|characters?|protagonists?|authors?|episodes?|seasons?|albums?|bands?|lore)\b/i
const COPULA_AFTER_NAME = /^(?:['’]s\b|\s+(?:is|was|are|were|isn['’]t|wasn['’]t|has|had|does|did)\b)/i
/** Words that start a sentence or a bullet without being a name. */
const COMMON_STARTERS = new Set([
  "the", "this", "that", "these", "those", "it", "its", "i", "so", "and", "but", "or", "yes", "no", "not", "sure", "okay", "ok", "here", "there",
  "what", "when", "where", "why", "how", "who", "which", "if", "then", "now", "also", "both", "one", "two", "my", "your", "our", "we", "you", "he", "she", "they",
  "got", "thanks", "thank", "done", "understood", "noted", "good", "great", "fine", "sorry", "will", "can", "could", "would", "should", "let", "yeah", "yep", "nope",
  "right", "well", "anyway", "still", "just", "all", "any", "some", "each", "every", "for", "from", "with", "without", "to", "in", "on", "at", "by", "as", "is",
  "are", "was", "were", "do", "does", "did", "have", "has", "had", "maybe", "probably", "honestly", "unfortunately", "looks", "seems", "see", "check", "try",
  "use", "make", "keep", "stop", "start", "once", "first", "next", "last", "before", "after", "because", "since", "while", "though", "although", "however",
  "otherwise", "instead", "meanwhile", "today", "tonight", "tomorrow", "yesterday", "more", "most", "many", "other", "another", "such", "only", "even",
  "about", "over", "under", "between", "among", "like", "per", "plus", "both", "either", "neither", "whether", "yet", "nothing", "something", "everything",
  "anything", "everyone", "someone", "anyone", "nobody", "overall", "basically", "actually", "generally", "usually", "often", "sometimes", "never", "always",
  "note", "tip", "warning", "heads", "update", "summary", "answer", "plan", "status", "result", "results", "source", "sources", "todo",
])
/** A sentence-opening "Word:" is a label when the word is one of these; any other "Name:" is treated as a name. */
const LABEL_WORDS = new Set([
  "note", "notes", "tip", "warning", "update", "summary", "answer", "plan", "status", "result", "results", "source", "sources", "todo", "next", "why", "how", "what",
  "done", "reply", "title", "healthy", "snoozed", "down", "up", "broken", "failed", "pending", "running", "stopped", "paused", "queued", "cast", "characters", "authors", "books", "series", "shows", "movies", "episodes", "tldr", "caveat", "caveats", "options", "option",
])
/** Words that read as names but are not about a work: the house, the tools it uses, months, weekdays, common brands and services. */
const HOUSE_VOCABULARY = new Set([
  "ari", "butler", "claude", "code", "sanctuary", "jellyfin", "sonarr", "radarr", "prowlarr", "jellyseerr", "calibre", "books", "telegram", "unraid", "docker",
  "mendelow", "cloud", "pocketbook", "astraweb", "usenet", "sabnzbd", "bazarr", "tmdb", "tvdb", "libgen", "plex", "github", "google", "apple", "amazon", "netflix",
  "hulu", "disney", "youtube", "spotify", "kindle", "kobo", "goodreads", "audible", "python", "javascript", "typescript", "node", "lodash", "vitest", "react",
  "linux", "windows", "macos", "android", "chrome", "firefox", "safari", "slack", "discord", "wikipedia", "english", "ouro", "ouroboros", "a2a", "radarr", "http", "https",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
])
const MIN_NAME_LENGTH = 3
const MAX_ACRONYM_LENGTH = 5
const LOWERCASE_LIST_INTRO = /\b(?:characters?|cast|names?|authors?|protagonists?|bands?|members?)\b[ \t]*(?::|—|-|are|includes?|including|like|such as)[ \t]+([^.!?\n]+)/gi
const LOWERCASE_LIST_ITEM = /^[a-z][a-z'’-]{3,}$/
const LOWERCASE_LIST_STOP = new Set(["others", "etc", "more", "many", "several", "various", "everyone", "anyone", "someone", "people", "these", "those", "them", "others", "similar", "same", "like"])

/** True when the call read a primary source: a web search or page fetch, a catalog lookup, a curl, or the books tool. */
export function isLookupToolCall(record: TurnToolRecord): boolean {
  if (LOOKUP_TOOL_NAMES.has(record.name) || LOOKUP_TOOL_PATTERN.test(record.name)) return true
  return record.name === "shell" && SHELL_LOOKUP.test(record.args.command ?? "")
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Whole-word, case-insensitive, Unicode-aware: "Dross" is not found inside "Drossel" or "Gross". */
export function mentions(haystack: string, name: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu").test(haystack)
}

const TOKEN = /\p{Lu}[\p{L}\p{M}'’]*/gu

/** Capitalised words that read as names, in order of first appearance, case-insensitively de-duplicated. House vocabulary is not a name. */
export function candidateNames(text: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const match of text.matchAll(TOKEN)) {
    const word = match[0].replace(/['’]s$/i, "").replace(/['’]$/, "")
    if (word.length < MIN_NAME_LENGTH) continue
    if (word.length <= MAX_ACRONYM_LENGTH && word === word.toUpperCase()) continue
    const lower = word.toLowerCase()
    if (HOUSE_VOCABULARY.has(lower) || seen.has(lower)) continue
    const before = text.slice(0, match.index).replace(/[ \t"'“‘(\[*_#>-]+$/u, "")
    const startsSentence = before === "" || /[.!?:\n]$/.test(before)
    if (startsSentence && COMMON_STARTERS.has(lower)) continue
    if (startsSentence && LABEL_WORDS.has(lower) && text[match.index! + match[0].length] === ":") continue
    seen.add(lower)
    names.push(word)
  }
  return names
}

/** Lowercase items in a list a work cue introduces ("characters: lindon, yerin and eithan"): two or more are treated as names. */
export function lowercaseListNames(text: string): string[] {
  const names: string[] = []
  for (const intro of text.matchAll(LOWERCASE_LIST_INTRO)) {
    const items = intro[1]!.split(/,|;|\band\b|\bor\b/i).map((item) => item.trim().split(/\s+/).slice(0, 2).join(" ")).map((item) => (/\s/.test(item) ? item.split(" ")[0]! : item))
    const words = items.filter((item) => LOWERCASE_LIST_ITEM.test(item) && !COMMON_STARTERS.has(item) && !LOWERCASE_LIST_STOP.has(item) && !HOUSE_VOCABULARY.has(item))
    if (words.length >= 2) names.push(...words)
  }
  return [...new Set(names)]
}

function claimsSomethingAbout(answer: string, name: string): boolean {
  const lower = answer.toLowerCase()
  const needle = name.toLowerCase()
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    if (COPULA_AFTER_NAME.test(answer.slice(at + needle.length))) return true
  }
  return false
}

/**
 * What is wrong with a reply about an external work, or null: it names things no lookup this turn contains (invented),
 * or states something about a work the person only named, with no lookup at all (unsourced_claim).
 */
export function sourceGroundingFinding(input: { answer: string; userText: string; tools: readonly TurnToolRecord[] }): GroundingFinding | null {
  if (!WORK_CUE.test(input.answer)) return null
  const lookups = input.tools.filter(isLookupToolCall)
  const lookedUp = lookups.map((record) => record.result).join("\n")
  const names = [...candidateNames(input.answer), ...lowercaseListNames(input.answer)]
  const invented = names.filter((name) => !mentions(lookedUp, name) && !mentions(input.userText, name))
  if (invented.length > 0 && (invented.length >= 2 || STRONG_CUE.test(input.answer))) {
    const named = invented.join(", ")
    emitNervesEvent({ level: "warn", component: "engine", event: "engine.unsourced_work_claim", message: "a reply named things from a work that the turn did not look up", meta: { names: invented.length, lookups: lookups.length } })
    return {
      kind: "invented", names: invented, lookups: lookups.length,
      message: lookups.length === 0
        ? `you named ${named} as part of a book, show, film or its cast, and you looked up nothing this turn. don't state facts about a work from memory. read a primary source first (web_search, or fetch the page), then answer only from what it says. if you can't find it, say so plainly.`
        : `${named} do not appear in anything you looked up this turn, so they may be made up. check them against the source you read, drop the ones it does not support, or look them up, then settle again.`,
    }
  }
  const unsourced = names.filter((name) => mentions(input.userText, name) && !mentions(lookedUp, name) && claimsSomethingAbout(input.answer, name))
  if (lookups.length === 0 && unsourced.length > 0) {
    return {
      kind: "unsourced_claim", names: unsourced, lookups: 0,
      message: `you stated something about ${unsourced.join(", ")} and looked up nothing this turn. read a primary source first (web_search, or fetch the page), then answer only from what it says. if you can't find it, say so plainly.`,
    }
  }
  return null
}

export function sourceGroundingError(input: { answer: string; userText: string; tools: readonly TurnToolRecord[] }): string | null {
  return sourceGroundingFinding(input)?.message ?? null
}

/** When the model keeps naming unsourced things after the retries are spent, say so rather than deliver them as fact. */
export function withUnverifiedDisclosure(answer: string, names: readonly string[]): string {
  return `I couldn't verify ${names.join(", ")} against a source, so treat ${names.length === 1 ? "that" : "those"} as unconfirmed.\n\n${answer}`
}
