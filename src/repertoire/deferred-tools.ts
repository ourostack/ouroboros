import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Deferred tool loading (trial, off by default). When OURO_DEFERRED_TOOLS is set, each request carries the core
 * tools plus `find_tools`; the rest are advertised only after the model asks for them. Selection, relationship
 * filtering, guards and approvals are untouched: this only narrows which already-selected schemas are sent.
 */
export const DEFERRED_TOOLS_FLAG = "OURO_DEFERRED_TOOLS"
export const FIND_TOOLS_NAME = "find_tools"
const MAX_RESULTS = 8

export function deferredToolLoadingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "on"].includes((env[DEFERRED_TOOLS_FLAG] ?? "").trim().toLowerCase())
}

/** Always sent. Engine tools are listed so the offline measurement keeps them; the engine adds them separately. */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "settle", "ponder", "observe", "rest", "speak", "surface", "send_message",
  "load_skill", "list_skills",
  "read_file", "write_file", "edit_file", "glob", "grep", "ls",
  "shell", "shell_status", "shell_tail",
  "web_search", "fetch_url",
  "note", "diary_write", "consult_diary", "consult_notes", "search_facts", "get_friend_note", "save_friend_note",
])

export interface ToolPartition {
  readonly active: OpenAI.ChatCompletionFunctionTool[]
  readonly deferred: OpenAI.ChatCompletionFunctionTool[]
}

/**
 * Core tools keep their canonical order; loaded tools follow in the order they were loaded, so the cached prefix
 * only grows at the end. `find_tools` is added only when something is deferred.
 */
export function partitionTools(
  tools: readonly OpenAI.ChatCompletionFunctionTool[],
  loaded: readonly string[] = [],
  alwaysKeep: ReadonlySet<string> = new Set(),
): ToolPartition {
  const keep = (name: string) => CORE_TOOL_NAMES.has(name) || alwaysKeep.has(name)
  const core = tools.filter((tool) => keep(tool.function.name))
  const deferred = tools.filter((tool) => !keep(tool.function.name))
  if (deferred.length === 0) return { active: [...core], deferred }
  const loadedTools = loaded.flatMap((name) => deferred.filter((tool) => tool.function.name === name))
  return { active: [...core, buildFindToolsSchema(deferred), ...loadedTools], deferred }
}

function groupCatalogue(deferred: readonly OpenAI.ChatCompletionFunctionTool[]): string {
  const groups = new Map<string, string[]>()
  for (const tool of deferred) {
    const name = tool.function.name
    const prefix = name.includes("_") ? name.slice(0, name.indexOf("_")) : name
    groups.set(prefix, [...(groups.get(prefix) ?? []), name])
  }
  return [...groups.entries()].map(([prefix, names]) => (names.length === 1 ? names[0]! : `${prefix}_*(${names.map((n) => n.slice(prefix.length + 1)).join(",")})`)).join(" ")
}

export function buildFindToolsSchema(deferred: readonly OpenAI.ChatCompletionFunctionTool[]): OpenAI.ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name: FIND_TOOLS_NAME,
      description: `more tools exist than are listed. call find_tools with a short query (what you need to do) or select:name1,name2 to load them; they become callable on your next step this turn. not loaded now: ${groupCatalogue(deferred)}`,
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "what you need, or select:name1,name2" } },
        required: ["query"],
      },
    },
  }
}

const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "again", "please", "need", "use", "can", "you", "tool", "tools"])
const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOPWORDS.has(word)).map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))

export function searchDeferredTools(deferred: readonly OpenAI.ChatCompletionFunctionTool[], query: string): OpenAI.ChatCompletionFunctionTool[] {
  const trimmed = query.trim()
  if (trimmed.toLowerCase().startsWith("select:")) {
    const names = new Set(trimmed.slice(7).split(",").map((name) => name.trim()).filter(Boolean))
    return deferred.filter((tool) => names.has(tool.function.name))
  }
  const terms = words(trimmed)
  const scored = deferred
    .map((tool, index) => {
      const name = tool.function.name.toLowerCase()
      const nameWords = words(name)
      const description = new Set(words(tool.function.description ?? ""))
      const score = terms.reduce((sum, term) =>
        sum + (name === term ? 6 : nameWords.includes(term) ? 4 : name.includes(term) ? 2 : 0) + (description.has(term) ? 1 : 0), 0)
      return { tool, score, index }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  // Drop weak description-only hits when something matches strongly, so the result stays short.
  const floor = scored.length > 0 ? Math.ceil(scored[0]!.score / 3) : 0
  return scored.filter((entry) => entry.score >= floor).slice(0, MAX_RESULTS).map((entry) => entry.tool)
}

function signature(tool: OpenAI.ChatCompletionFunctionTool): string {
  const parameters = tool.function.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined
  const required = new Set(parameters?.required ?? [])
  return Object.keys(parameters?.properties ?? {}).map((key) => (required.has(key) ? key : `${key}?`)).join(", ")
}

export function formatFindToolsResult(matched: readonly OpenAI.ChatCompletionFunctionTool[]): string {
  if (matched.length === 0) return "no matching tools. try different words, or select:name1,name2 using a name from the list in find_tools."
  return `loaded; callable on your next step:\n${matched.map((tool) => `- ${tool.function.name}(${signature(tool)}): ${tool.function.description ?? ""}`).join("\n")}`
}

/** Deferred tools the conversation already called, so a follow-up turn does not have to find them again. */
export function deferredNamesCalledInHistory(messages: readonly OpenAI.ChatCompletionMessageParam[], deferred: readonly OpenAI.ChatCompletionFunctionTool[]): string[] {
  const deferredNames = new Set(deferred.map((tool) => tool.function.name))
  const called: string[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const call of message.tool_calls ?? []) {
      if (call.type === "function" && deferredNames.has(call.function.name) && !called.includes(call.function.name)) called.push(call.function.name)
    }
  }
  return called
}

export function recordDeferredToolsLoaded(query: string, matched: readonly OpenAI.ChatCompletionFunctionTool[]): void {
  emitNervesEvent({ component: "engine", event: "engine.deferred_tools_loaded", message: "deferred tools loaded for this turn", meta: { query, loaded: matched.map((tool) => tool.function.name).join(",") } })
}
