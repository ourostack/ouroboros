import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition, ToolDoorCard } from "./tools-base"
import { withCode } from "./tool-error-code"

/**
 * The tool catalog: one entry per door a turn may call, read from the door's Ouro AX card (`group`, `when`, `effect`,
 * `eager`). A provider loads the eager doors up front and the rest on demand: Anthropic marks them `defer_loading`,
 * other providers get them from `find_tools`. The cards are the only source; this module adds no second registry.
 */
export interface CatalogDoor {
  readonly name: string
  readonly group: string
  readonly when: string
  readonly effect: ToolDoorCard["effect"]
  readonly eager: boolean
}

export interface CatalogGroup {
  readonly id: string
  readonly when: string
}

export interface ToolCatalog {
  readonly doors: readonly CatalogDoor[]
  readonly groups: readonly CatalogGroup[]
}

/** A selected door: its schema, and its card when it has one (MCP tools and the engine's turn tools may not). */
export interface CatalogSource {
  readonly tool: OpenAI.ChatCompletionFunctionTool
  readonly ax?: Pick<ToolDoorCard, "group" | "when" | "effect" | "eager">
  readonly mcpServer?: string
}

/** The door that loads deferred doors on every provider. */
export const FIND_TOOLS_NAME = "find_tools"

/** The engine's turn tools: a turn can't end, think or reply without them, so they are never deferred. */
export const TURN_TOOL_NAMES: ReadonlySet<string> = new Set(["settle", "ponder", "observe", "rest", "speak", "surface"])

const MAX_WHEN = 200

function firstSentence(text: string): string {
  const line = text.trim().split("\n")[0]!.trim()
  const end = line.search(/[.!?](\s|$)/)
  const sentence = end >= 0 ? line.slice(0, end + 1) : line
  return sentence.length > MAX_WHEN ? `${sentence.slice(0, MAX_WHEN - 1)}…` : sentence
}

export function catalogDoor(source: CatalogSource): CatalogDoor {
  const name = source.tool.function.name
  const card = source.ax
  return {
    name,
    group: card?.group ?? (source.mcpServer ? `mcp:${source.mcpServer}` : "other"),
    when: card?.when ?? firstSentence(source.tool.function.description ?? ""),
    effect: card?.effect ?? "write",
    // A door with neither a card nor an MCP server came straight from the caller and can't be described for search.
    eager: TURN_TOOL_NAMES.has(name) || card?.eager === true || (!card && !source.mcpServer),
  }
}

/** Builds the catalog for the doors selected this turn; groups keep their census `when` line, or none if unknown. */
export function buildToolCatalog(sources: readonly CatalogSource[], groups: readonly CatalogGroup[] = []): ToolCatalog {
  const doors = sources.map(catalogDoor)
  const known = new Map(groups.map((group) => [group.id, group.when]))
  const used = [...new Set(doors.map((door) => door.group))].map((id) => ({ id, when: known.get(id) ?? "" }))
  emitNervesEvent({
    component: "repertoire", event: "repertoire.tool_catalog_built", message: "tool catalog built for the selected doors",
    meta: { doors: doors.length, eager: doors.filter((door) => door.eager).length, groups: used.length },
  })
  return { doors, groups: used }
}

const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "again", "please", "need", "use", "can", "you", "tool", "tools", "pick", "when", "what", "want", "how", "are", "its", "your", "his", "her", "their", "out", "about"])

/** Lower-cased words with stopwords dropped and a light stem, so "downloading", "downloads" and "download" meet. */
export function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .map(stem)
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}

const MAX_RESULTS = 8

/**
 * Finds deferred doors for a query. `select:a,b` loads by exact name. Otherwise each query word scores against the
 * door's name (strongest), its card's `when` line, its group's `when` line and its description; weak hits are dropped
 * when a strong one exists, so the reply stays short.
 */
export function searchCatalog(
  catalog: ToolCatalog,
  candidates: readonly OpenAI.ChatCompletionFunctionTool[],
  query: string,
): string[] {
  const trimmed = query.trim()
  const names = new Set(candidates.map((tool) => tool.function.name))
  if (trimmed.toLowerCase().startsWith("select:")) {
    const wanted = trimmed.slice(7).split(",").map((name) => name.trim()).filter((name) => names.has(name))
    return [...new Set(wanted)]
  }
  const terms = [...new Set(words(trimmed))]
  const doors = new Map(catalog.doors.map((door) => [door.name, door]))
  const groupWhen = new Map(catalog.groups.map((group) => [group.id, group.when]))
  const scored = candidates.map((tool, index) => {
    const name = tool.function.name.toLowerCase()
    const door = doors.get(tool.function.name)
    const nameWords = new Set(words(name))
    const whenWords = new Set(words(door?.when ?? ""))
    const groupWords = new Set(words(`${door?.group ?? ""} ${groupWhen.get(door?.group ?? "") ?? ""}`))
    const descriptionWords = new Set(words(tool.function.description ?? ""))
    const termScores = terms.map((term) =>
      (name === term ? 8 : nameWords.has(term) ? 5 : name.includes(term) ? 2 : 0)
      + (whenWords.has(term) ? 2 : 0)
      + (groupWords.has(term) ? 1 : 0)
      + (descriptionWords.has(term) ? 1 : 0))
    // A door that answers more of the query's words beats one that matches a single word strongly.
    const covered = termScores.filter((score) => score > 0).length
    const score = termScores.reduce((sum, termScore) => sum + termScore, 0) + (covered > 1 ? 3 * (covered - 1) : 0)
    return { name: tool.function.name, score, index }
  }).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const floor = scored.length > 0 ? Math.ceil(scored[0]!.score / 3) : 0
  return scored.filter((entry) => entry.score >= floor).slice(0, MAX_RESULTS).map((entry) => entry.name)
}

const LOADED_HEADER = "loaded; callable on your next step:"

function signature(tool: OpenAI.ChatCompletionFunctionTool): string {
  const parameters = tool.function.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined
  const required = new Set(parameters?.required ?? [])
  return Object.keys(parameters?.properties ?? {}).map((key) => (required.has(key) ? key : `${key}?`)).join(", ")
}

/** `find_tools`'s reply: the doors it loaded, one per line, or how to try again. */
export function formatLoadedDoors(loaded: readonly OpenAI.ChatCompletionFunctionTool[]): string {
  if (loaded.length === 0) return withCode("no matching tools. try different words, or select:name1,name2 using a name from the list in find_tools.", "no-matching-tools")
  return `${LOADED_HEADER}\n${loaded.map((tool) => `- ${tool.function.name}(${signature(tool)}): ${tool.function.description ?? ""}`).join("\n")}`
}

const SKILL_NOTE_HEADER = "skills that document this job:"

/**
 * `find_tools`'s whole reply: the doors it loaded, then any skill sections that document the job under their own
 * header. The loaded-doors header stays first, so `loadedDoorNames` reads the reply back unchanged.
 */
export function formatFindToolsReply(loaded: readonly OpenAI.ChatCompletionFunctionTool[], skillNote: string): string {
  if (!skillNote) return formatLoadedDoors(loaded)
  const note = `${SKILL_NOTE_HEADER}\n${skillNote}`
  return loaded.length === 0 ? `no held-back tool matched.\n\n${note}` : `${formatLoadedDoors(loaded)}\n\n${note}`
}

/** The skill note a `find_tools` reply carries after its loaded doors, header included, or "" when it has none. */
export function findToolsNote(reply: string): string {
  if (!reply.startsWith(LOADED_HEADER)) return ""
  const at = reply.indexOf(`\n\n${SKILL_NOTE_HEADER}\n`)
  return at >= 0 ? reply.slice(at + 2) : ""
}

/** The door names a `find_tools` reply loaded, read back from its text so the reply itself stays the record. */
export function loadedDoorNames(reply: string): string[] {
  if (!reply.startsWith(LOADED_HEADER)) return []
  return reply.split("\n").slice(1).flatMap((line) => /^- ([A-Za-z0-9_-]+)\(/.exec(line)?.[1] ?? [])
}

export interface CatalogPartition {
  readonly active: OpenAI.ChatCompletionFunctionTool[]
  readonly deferred: OpenAI.ChatCompletionFunctionTool[]
}

/**
 * Splits a turn's doors. Eager doors, names in `keep` and doors the catalog doesn't know stay in canonical order;
 * `find_tools` follows when anything is held back, then loaded doors in the order they were loaded, so the request's
 * tool list only grows at its end.
 */
export function partitionCatalog(
  tools: readonly OpenAI.ChatCompletionFunctionTool[],
  catalog: ToolCatalog,
  loaded: readonly string[],
  keep: ReadonlySet<string>,
): CatalogPartition {
  const doors = new Map(catalog.doors.map((door) => [door.name, door]))
  const held = (name: string) => !keep.has(name) && doors.get(name)?.eager === false
  const kept = tools.filter((tool) => !held(tool.function.name))
  const deferred = tools.filter((tool) => held(tool.function.name))
  if (deferred.length === 0) return { active: kept, deferred }
  const loadedTools = loaded.flatMap((name) => deferred.filter((tool) => tool.function.name === name))
  return { active: [...kept, buildFindToolsSchema(deferred, catalog), ...loadedTools], deferred }
}

/** `find_tools`'s schema; its description names every held-back door by catalog group, so a select needs no search. */
export function buildFindToolsSchema(deferred: readonly OpenAI.ChatCompletionFunctionTool[], catalog: ToolCatalog): OpenAI.ChatCompletionFunctionTool {
  const groupOf = new Map(catalog.doors.map((door) => [door.name, door.group]))
  const groups = new Map<string, string[]>()
  for (const tool of deferred) {
    const group = groupOf.get(tool.function.name) ?? "other"
    groups.set(group, [...(groups.get(group) ?? []), tool.function.name])
  }
  const listing = [...groups.entries()].map(([group, names]) => `${group}: ${names.join(", ")}`).join("; ")
  return {
    type: "function",
    function: {
      name: FIND_TOOLS_NAME,
      description: `more tools exist than are listed. call find_tools with a short query (what you need to do) or select:name1,name2 to load them; they become callable on your next step. not loaded now, by group: ${listing}`,
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "what you need, or select:name1,name2" } },
        required: ["query"],
      },
    },
  }
}

/** Doors that `find_tools` replies in the conversation loaded, once each, in order. */
export function doorsFoundInHistory(messages: readonly OpenAI.ChatCompletionMessageParam[]): string[] {
  return scanHistory(messages, false)
}

/** Held-back doors the conversation already called or loaded with `find_tools`, so a later turn needn't find them again. */
export function namesLoadedInHistory(messages: readonly OpenAI.ChatCompletionMessageParam[], pool: ReadonlySet<string>): string[] {
  return scanHistory(messages, true).filter((name) => pool.has(name))
}

function scanHistory(messages: readonly OpenAI.ChatCompletionMessageParam[], withCalls: boolean): string[] {
  const names: string[] = []
  const add = (name: string) => { if (!names.includes(name)) names.push(name) }
  const findCalls = new Set<string>()
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        /* v8 ignore next -- type narrowing: the engine only records function tool calls @preserve */
        if (call.type !== "function") continue
        if (call.function.name === FIND_TOOLS_NAME) findCalls.add(call.id)
        else if (withCalls) add(call.function.name)
      }
    } else if (message.role === "tool" && findCalls.has(message.tool_call_id) && typeof message.content === "string") {
      for (const name of loadedDoorNames(message.content)) add(name)
    }
  }
  return names
}

/** One `find_tools` search, as counts: never the query text, which can carry what the person asked for. */
export function recordFindTools(search: { query: string; matched: number; deferred: number; skills?: number }): void {
  emitNervesEvent({
    component: "repertoire", event: "repertoire.find_tools_searched", message: "find_tools searched the held-back doors",
    meta: { select: search.query.trim().toLowerCase().startsWith("select:"), matched: search.matched, deferred: search.deferred, skills: search.skills ?? 0 },
  })
}

/**
 * find_tools's Ouro AX card and risk profile. The engine runs find_tools itself, so this is a declaration rather than
 * a dispatched definition: loading a door changes only which schemas this turn sends.
 */
export const findToolsDefinition: Required<Pick<ToolDefinition, "tool" | "ax" | "riskProfile">> = {
  tool: buildFindToolsSchema([], { doors: [], groups: [] }),
  riskProfile: { mutates: "none", risk: "low" },
  ax: { id: "tool:find_tools", group: "turn-skills", when: "Pick this when the tool you need isn't in your list; it searches the tools held back from this turn and makes the matches callable.", effect: "read", idempotent: true, errors: [
    { code: "no-matching-tools", means: "No held-back tool matched the query, so nothing was loaded.", fix: "Try other words for the job, or select:name1,name2 with names from the find_tools list." },
  ] },
}
