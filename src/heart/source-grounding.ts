/**
 * Primary-source grounding for claims about external works (books, shows, films, their characters).
 *
 * A model asked about a work it half-remembers will invent plausible names and present them as fact; a principle in
 * the prompt did not stop that. This check runs where an answer is about to be delivered and judges the answer against
 * what the turn actually read: a name that appears in no lookup result, and is not the house vocabulary or the
 * person's own words, is a name the model made up. Pure functions; the runtime calls them at settle.
 */
import { emitNervesEvent } from "../nerves/runtime"

export interface TurnToolRecord {
  name: string
  args: Record<string, string>
  result: string
}

const LOOKUP_TOOL_NAMES = new Set(["web_search", "media_search", "media_episodes"])
const LOOKUP_TOOL_PATTERN = /^(web_fetch|fetch_url|fetch_page|read_url|read_page|browse\w*)$/
const SHELL_LOOKUP = /\b(curl|wget)\b|https?:\/\/|\bbooks\s+(get|search|series|library\s+(find|search))\b/

const WORK_CUE = /\b(books?|novels?|series|saga|trilogy|shows?|movies?|films?|anime|characters?|protagonists?|authors?|episodes?|seasons?|albums?|bands?|lore)\b/i
const COPULA_AFTER_NAME = /^(?:['’]s\b|\s+(?:is|was|are|were|isn['’]t|wasn['’]t|has|had|does|did)\b)/i
const SENTENCE_STARTERS = [
  "the", "this", "that", "these", "those", "it", "its", "i", "so", "and", "but", "or", "yes", "no", "not", "sure", "okay", "ok", "here", "there",
  "what", "when", "where", "why", "how", "who", "which", "if", "then", "now", "also", "both", "one", "two", "my", "your", "our", "we", "you", "he", "she", "they",
  "got", "thanks", "thank", "done", "understood", "noted", "good", "great", "fine", "sorry", "will", "can", "could", "would", "should", "let", "ill", "ive", "yeah", "yep", "nope", "right", "well", "anyway", "still", "just", "all", "any", "some", "each", "every", "for", "from", "with", "without", "to", "in", "on", "at", "by", "as", "is", "are", "was", "were", "do", "does", "did", "have", "has", "had", "maybe", "probably", "honestly", "unfortunately", "looks", "seems", "see", "check", "try", "use", "make", "keep", "stop", "start", "once", "first", "next", "last", "before", "after", "because", "since", "while", "though", "although", "however", "otherwise", "instead", "meanwhile", "today", "tonight", "tomorrow", "yesterday",
]
const MIN_NAME_LENGTH = 3
const MAX_ACRONYM_LENGTH = 5

/** True when the call read a primary source: a web search or page fetch, a catalog lookup, a curl, or the books tool. */
export function isLookupToolCall(record: TurnToolRecord): boolean {
  if (LOOKUP_TOOL_NAMES.has(record.name) || LOOKUP_TOOL_PATTERN.test(record.name)) return true
  return record.name === "shell" && SHELL_LOOKUP.test(record.args.command ?? "")
}

/** Lowercase words of a text: what counts as an ordinary word rather than a name when it starts a sentence. */
export function commonWordsOf(text: string): Set<string> {
  const words = new Set<string>(SENTENCE_STARTERS)
  for (const match of text.matchAll(/\p{Ll}[\p{L}'’]*/gu)) words.add(match[0].toLowerCase())
  return words
}

const TOKEN = /\p{Lu}[\p{L}\p{M}'’]*/gu

/** Capitalised words that read as names, in order of first appearance, case-insensitively de-duplicated. */
export function candidateNames(text: string, commonWords: ReadonlySet<string>): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const match of text.matchAll(TOKEN)) {
    const word = match[0].replace(/['’]s$/i, "").replace(/['’]$/, "")
    if (word.length < MIN_NAME_LENGTH) continue
    if (word.length <= MAX_ACRONYM_LENGTH && word === word.toUpperCase()) continue
    const before = text.slice(0, match.index).replace(/[ \t"'“‘(\[*_#>-]+$/u, "")
    const startsSentence = before === "" || /[.!?:\n]$/.test(before)
    const lower = word.toLowerCase()
    if (startsSentence && (commonWords.has(lower) || text[match.index! + match[0].length] === ":")) continue
    if (seen.has(lower)) continue
    seen.add(lower)
    names.push(word)
  }
  return names
}

const mentions = (haystack: string, name: string): boolean => haystack.includes(name.toLowerCase())

function claimsSomethingAbout(answer: string, name: string): boolean {
  const lower = answer.toLowerCase()
  const needle = name.toLowerCase()
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    if (COPULA_AFTER_NAME.test(answer.slice(at + needle.length))) return true
  }
  return false
}

/**
 * The correction to send back when a reply about an external work names things the turn did not read, or states
 * something about a work the person only named without any lookup. null when the reply is grounded or is not about a work.
 */
export function sourceGroundingError(input: {
  answer: string
  userText: string
  systemText: string
  tools: readonly TurnToolRecord[]
}): string | null {
  if (!WORK_CUE.test(input.answer)) return null
  const system = input.systemText.toLowerCase()
  const user = input.userText.toLowerCase()
  const lookups = input.tools.filter(isLookupToolCall)
  const lookedUp = lookups.map((record) => record.result).join("\n").toLowerCase()
  // A name that any tool returned this turn is not invented (house state such as container names comes from state tools).
  const read = input.tools.map((record) => record.result).join("\n").toLowerCase()
  const names = candidateNames(input.answer, commonWordsOf(input.systemText)).filter((name) => !mentions(system, name))
  const invented = names.filter((name) => !mentions(read, name) && !mentions(user, name))
  if (invented.length > 0) {
    const named = invented.join(", ")
    emitNervesEvent({ level: "warn", component: "engine", event: "engine.unsourced_work_claim", message: "a reply named things from a work that the turn did not read", meta: { names: invented.length, lookups: lookups.length } })
    return lookups.length === 0
      ? `you named ${named} as part of a book, show, film or its cast, and you looked up nothing this turn. don't state facts about a work from memory. read a primary source first (web_search, or fetch the page), then answer only from what it says. if you can't find it, say so plainly.`
      : `${named} do not appear in anything you read this turn, so they may be made up. check them against the source you read, drop the ones it does not support, or look them up, then settle again.`
  }
  const unsourced = names.filter((name) => mentions(user, name) && !mentions(lookedUp, name) && claimsSomethingAbout(input.answer, name))
  if (lookups.length === 0 && unsourced.length > 0) {
    return `you stated something about ${unsourced.join(", ")} and looked up nothing this turn. read a primary source first (web_search, or fetch the page), then answer only from what it says. if you can't find it, say so plainly.`
  }
  return null
}
