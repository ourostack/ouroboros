/**
 * A bundle's declared tools: the `tools.json` an agent bundle ships for one of its own MCP servers (agent.json
 * `mcpServers.<name>.tools`), written by Ouro UI core's ouro-actions-tools projection from the bundle's action
 * declarations (ourostack/ouro-ui-core `src/actions-tools.mts`, release v1.11.0). Each entry is an OpenAI function tool
 * with its Ouro AX card (`ax`, the census's DoorCard). The harness surfaces that server's tools with the declared
 * description, parameters and card, so a bundle's tool schemas and its Ouro AX cards come from one declaration.
 *
 * An entry that isn't a whole declaration (no effect, no `when`, a consequential one with no confirm question) is left
 * out, and its tool stays undeclared: it's handled as any MCP tool is, from what its server says, never from the broken entry.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import type { ToolDoorCard, ToolErrorCard, ToolRiskProfile } from "./tools-base"
import { emitNervesEvent } from "../nerves/runtime"

export interface DeclaredTool {
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly ax: ToolDoorCard
}

/** A server's declared tools, by the tool's name on the server. */
export type DeclaredTools = ReadonlyMap<string, DeclaredTool>

const EFFECTS = new Set(["read", "write", "consequential", "person-only"])
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isLine = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && !/[\r\n]/.test(v)

function errorCards(v: unknown): ToolErrorCard[] | null {
  if (!Array.isArray(v)) return null
  const cards: ToolErrorCard[] = []
  for (const e of v) {
    if (!isObject(e) || !isLine(e.code) || !isLine(e.means) || !isLine(e.fix)) return null
    cards.push({ code: e.code, means: e.means, fix: e.fix })
  }
  return cards
}

/** Why one entry isn't a whole declaration, or its declaration. */
function declaredTool(entry: unknown): { name: string; tool: DeclaredTool } | { problem: string } {
  if (!isObject(entry) || entry.type !== "function" || !isObject(entry.function) || typeof entry.function.name !== "string" || entry.function.name === "") {
    return { problem: "an entry is not a function tool with a name" }
  }
  const name = entry.function.name
  const { description, parameters } = entry.function
  if (!isLine(description)) return { problem: `${name}: no one-line description` }
  if (!isObject(parameters) || parameters.type !== "object") return { problem: `${name}: parameters is not an object schema` }
  const ax = entry.ax
  if (!isObject(ax)) return { problem: `${name}: no ax card` }
  if (typeof ax.effect !== "string" || !EFFECTS.has(ax.effect)) return { problem: `${name}: the card has no effect` }
  if (!isLine(ax.when)) return { problem: `${name}: the card has no when line` }
  if (!isLine(ax.group)) return { problem: `${name}: the card has no group` }
  const errors = errorCards(ax.errors)
  if (errors === null) return { problem: `${name}: the card's errors are not { code, means, fix } lines` }
  if (ax.effect === "consequential" && !isLine(ax.confirm)) return { problem: `${name}: a consequential card has no confirm question` }
  const card: ToolDoorCard = {
    id: `tool:${name}`, group: ax.group, when: ax.when, effect: ax.effect as ToolDoorCard["effect"], errors,
    ...(ax.destructive === true ? { destructive: true as const } : {}),
    ...(ax.idempotent === true ? { idempotent: true as const } : {}),
    ...(isLine(ax.confirm) ? { confirm: ax.confirm } : {}),
  }
  return { name, tool: { description, parameters, ax: card } }
}

/** The declared tools in a tools.json's content, and why any entry was left out. */
export function parseDeclaredTools(json: unknown): { tools: DeclaredTools; problems: string[] } {
  const tools = new Map<string, DeclaredTool>()
  const problems: string[] = []
  if (!isObject(json) || !Array.isArray(json.tools)) return { tools, problems: ["it has no tools list"] }
  for (const entry of json.tools) {
    const result = declaredTool(entry)
    if ("problem" in result) problems.push(result.problem)
    else if (tools.has(result.name)) problems.push(`${result.name}: declared twice`)
    else tools.set(result.name, result.tool)
  }
  return { tools, problems }
}

/**
 * Reads a server's tools.json, a path inside the agent's bundle (relative to it, or absolute). Null, with a warning,
 * when the path leaves the bundle or the file can't be read as JSON; the server's tools then stay undeclared.
 */
export function loadDeclaredTools(agentRoot: string, file: string, server: string): DeclaredTools | null {
  const root = path.resolve(agentRoot)
  const target = path.resolve(root, file)
  const warn = (reason: string): null => {
    emitNervesEvent({
      level: "warn", event: "mcp.declared_tools_unreadable", component: "repertoire",
      message: `the declared tools for MCP server ${server} can't be used`, meta: { server, reason },
    })
    return null
  }
  if (target !== root && !target.startsWith(root + path.sep)) return warn("the tools path is outside the agent bundle")
  let json: unknown
  try {
    json = JSON.parse(fs.readFileSync(target, "utf8"))
  } catch (error) {
    // readFileSync and JSON.parse throw only Errors.
    return warn((error as Error).message)
  }
  const { tools, problems } = parseDeclaredTools(json)
  if (problems.length > 0) {
    emitNervesEvent({
      level: "warn", event: "mcp.declared_tools_incomplete", component: "repertoire",
      message: `some declared tools for MCP server ${server} were left out`, meta: { server, problems },
    })
  }
  return tools
}

/** The risk the harness gives a declared tool, from its card's effect. */
export function declaredRiskProfile(effect: ToolDoorCard["effect"]): ToolRiskProfile {
  if (effect === "read") return { mutates: "none", risk: "low", reason: "declared read in the agent bundle's tools.json" }
  if (effect === "write") return { mutates: "durable_state_write", risk: "high", reason: "declared write in the agent bundle's tools.json" }
  return { mutates: "external_side_effect", risk: "high", reason: `declared ${effect} in the agent bundle's tools.json` }
}
