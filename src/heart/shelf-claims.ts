/**
 * "On the shelf" is a promise that a title is in the house library and ready to play. A reply may make it only for a
 * title a library lookup in this turn found there (2026-10-11: the Butler told Sam lists were "all on the shelf"
 * with no lookup, and named titles its own search had just shown were missing). Pure functions; the runtime calls
 * them at settle for agents that opt in (see ToolContext.answerGates).
 */
import { emitNervesEvent } from "../nerves/runtime"
import type { TurnToolRecord } from "./source-grounding"

const SHELF_CLAIM = /\b(?:on\s+(?:the|our)\s+shelf|shelf[- ]ready|ready\s+to\s+(?:play|watch)|in\s+(?:the|our)\s+(?:library|jellyfin))\b/i
/**
 * "isn't on the shelf", "check if it's in our library", "I'll tell you when it's ready to watch": the same words, but a
 * denial, an offer or a promise about later, not a claim that something is there now.
 */
const NOT_A_CLAIM = /\bnot\b|n['’]t\b|\bno\s+longer\b|\bnever\b|\bif\b|\bwhether\b|\bwhen\b|\bonce\b|\buntil\b|\bwill\b|['’]ll\b|\bshould\b|\bsoon\b/i
/** How far before a claim a denial word still governs it ("Dune isn't on the shelf"; not "No worries, Dune is on the shelf"). */
const DENIAL_REACH_WORDS = 4
const LIBRARY_LOOKUP_TOOLS = new Set(["media_search", "sanctuary_search_media_catalog"])
const MIN_TITLE_LENGTH = 3
/** The bundle's books CLI reading or changing the house book library: `./books get … --deliver`, `books library find …`. */
const BOOKS_COMMAND = /(?:^|[\s;&|(])(?:[\w.~/-]*\/)?books\s+(?:get|deliver|library\s+(?:find|add))\b/
/** `NAME=value` and `export NAME=value` in a command; `alias name=value`. A value is quoted or runs to a separator. */
const ASSIGNMENT = /(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_]\w*)=("[^"\n]*"|'[^'\n]*'|[^\s;&|()]+)/g
const ALIAS = /(?:^|[\s;&|(])alias\s+([A-Za-z_][\w.-]*)=("[^"\n]*"|'[^'\n]*'|[^\s;&|()]+)/g
const VARIABLE = /"?\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))"?/g

/**
 * The command with the variables and aliases it sets itself put back in place: `B=…/books; $B library find …` and
 * `alias bk=./books; bk library find …` both read as the books CLI. A variable the command does not set stays as it is.
 */
function resolveOwnNames(command: string): string {
  const unquote = (value: string): string => value.replace(/^(["'])(.*)\1$/, "$2")
  const variables = new Map([...command.matchAll(ASSIGNMENT)].map((match) => [match[1]!, unquote(match[2]!)] as const))
  let resolved = command.replace(VARIABLE, (whole, braced?: string, bare?: string) => variables.get((braced ?? bare)!) ?? whole)
  for (const [, name, value] of command.matchAll(ALIAS)) {
    const escaped = name!.replace(/[.-]/g, "\\$&")
    resolved = resolved.replace(new RegExp(`(^|[\\s;&|(])${escaped}(?=\\s)`, "g"), `$1${unquote(value!)}`)
  }
  return resolved
}
/** A reply about the gate's own line ("sorry, that note was wrong"): it corrects a disclosure, so it gets none of its own. */
const APOLOGY = /\b(?:sorry|apolog\w*|my\s+(?:mistake|bad)|ignore|disregard)\b|\bwas\s+wrong\b/i
const DISCLOSURE_REF = /\bha(?:ve|d)n['’]?t\s+checked\s+the\s+library\b|\bcan['’]?t\s+promise\s+it['’]?s\s+on\s+the\s+shelf\b|\b(?:that|the|this)\s+(?:line|note|disclaimer|disclosure|warning)\b/i

function normalize(text: string): string {
  return ` ${text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `
}

/** Each title as the lookup wrote it, with its normalized form for matching against the reply. */
interface Title { name: string; key: string }
function titlesFrom(records: readonly TurnToolRecord[]): { onShelf: Title[]; offShelf: Title[] } {
  const onShelf: Title[] = []
  const offShelf: Title[] = []
  // A lookup can name one title in several places (a result and a candidate); keep it once so the reply names it once.
  const add = (list: Title[], title: unknown): void => {
    if (typeof title !== "string" || normalize(title).trim().length < MIN_TITLE_LENGTH) return
    const key = normalize(title)
    if (!list.some((known) => known.key === key)) list.push({ name: title.trim(), key })
  }
  for (const record of records) {
    if (!LIBRARY_LOOKUP_TOOLS.has(record.name)) continue
    let parsed: { items?: unknown; library_matches?: unknown; lookup_candidates?: unknown; data?: { items?: unknown } }
    try { parsed = JSON.parse(record.result) } catch { continue }
    const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [])
    for (const item of list(parsed.items)) add(item.on_shelf === true ? onShelf : item.on_shelf === false ? offShelf : [], item.title)
    for (const item of list(parsed.library_matches)) add(item.in_jellyfin === true ? onShelf : [], item.title)
    for (const item of list(parsed.lookup_candidates)) add(offShelf, item.title)
    // The legacy catalog read lists only what is already in the library.
    for (const item of list(parsed.data?.items)) add(onShelf, item.untrustedTitle)
  }
  return { onShelf, offShelf: offShelf.filter((title) => !onShelf.some((found) => found.key === title.key)) }
}

/** True when a books CLI run this turn succeeded and, if it was a search, found something: the book library backs the claim. */
function bookLibraryBacked(records: readonly TurnToolRecord[]): boolean {
  return records.some((record) => {
    if (record.name !== "shell" || !BOOKS_COMMAND.test(resolveOwnNames(record.args.command ?? "")) || /^error:/i.test(record.result.trim())) return false
    let parsed: unknown
    try { parsed = JSON.parse(record.result) } catch { return record.result.trim().length > 0 }
    if (!parsed || typeof parsed !== "object") return true
    const fields = parsed as Record<string, unknown>
    if (fields.ok === false) return false
    const lists = ["results", "items", "books", "matches"].map((key) => fields[key]).filter(Array.isArray)
    return lists.length === 0 || lists.some((list) => list.length > 0)
  })
}

/** Null when the reply's shelf claims are backed; otherwise the titles this turn's lookup showed missing (empty: nothing found). */
function unbackedClaim(answer: string, tools: readonly TurnToolRecord[]): { missing: string[] } | null {
  const clauses = answer.split(/[.!?,;\n]+/)
  const denied = (clause: string): boolean => NOT_A_CLAIM.test(clause.slice(0, clause.search(SHELF_CLAIM)).trim().split(/\s+/).slice(-DENIAL_REACH_WORDS).join(" "))
  if (!clauses.some((clause) => SHELF_CLAIM.test(clause) && !denied(clause))) return null
  if (APOLOGY.test(answer) && DISCLOSURE_REF.test(answer)) return null
  if (bookLibraryBacked(tools)) return null
  // Titles count from everything but the denials, so "Dune isn't on the shelf" never reads as a claim about Dune.
  const said = normalize(clauses.filter((clause) => !SHELF_CLAIM.test(clause) || !denied(clause)).join(" "))
  const { onShelf, offShelf } = titlesFrom(tools)
  const missing = offShelf.filter((title) => said.includes(title.key)).map((title) => title.name)
  if (missing.length > 0) return { missing }
  // "It's in the library" names no title: it is backed when this turn's lookup found something on the shelf.
  const namesAny = [...onShelf, ...offShelf].some((title) => said.includes(title.key))
  return onShelf.some((title) => said.includes(title.key)) || (!namesAny && onShelf.length > 0) ? null : { missing }
}

/** The correction for a reply that says something is on the shelf without this turn's lookup finding it there, or null. */
export function shelfClaimError(answer: string, tools: readonly TurnToolRecord[]): string | null {
  const claim = unbackedClaim(answer, tools)
  if (!claim) return null
  emitNervesEvent({ level: "warn", component: "engine", event: "engine.shelf_claim_unbacked", message: "a reply said something is on the shelf that no lookup this turn found there", meta: { missing: claim.missing.length } })
  const why = claim.missing.length > 0
    ? `your library lookup this turn shows ${claim.missing.join(", ")} not on the shelf`
    : "no library lookup this turn found what you named"
  return `you said something is on the shelf, but ${why}. say "on the shelf" only for a title a lookup in this turn found there. otherwise say it plainly, like "I can check if we have it", or look it up first.`
}

/** An unbacked shelf claim that survived its retry goes out with the truth in front: what the lookup showed missing, that it found no match, or that nothing was checked. */
export function withShelfDisclosure(answer: string, tools: readonly TurnToolRecord[]): string {
  const { missing } = unbackedClaim(answer, tools)!
  const looked = tools.some((record) => LIBRARY_LOOKUP_TOOLS.has(record.name))
  const note = missing.length > 0 ? `My lookup shows ${missing.join(", ")} isn't on the shelf.`
    : looked ? "My library lookup didn't find that, so I can't promise it's on the shelf."
      : "I haven't checked the library for that yet, so I can't promise it's on the shelf."
  return `${note}\n\n${answer}`
}
