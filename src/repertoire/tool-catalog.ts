import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDoorCard } from "./tools-base"

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
    eager: TURN_TOOL_NAMES.has(name) || card?.eager === true,
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
function words(text: string): string[] {
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
