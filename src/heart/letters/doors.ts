// The Mailbox's doors, dispatched from what ouro-actions generated from actions/mailbox.actions.mts: the CLI's commands
// (actions/generated/mailbox/commands.json), the MCP tools (mcp.json) and the in-turn tools
// (actions/generated/mailbox-tools/tools.json). Each surface reads its descriptions, schemas and Ouro AX cards from
// those files, so a door is declared once and never copied by hand. Only the handlers live here; the in-turn tools'
// definitions are in doors-tools.ts, because the CLI loads this module on every start and must not load the MCP tool
// code they need (the edge benchmark counts the modules `ouro --version` loads).
import { createRequire } from "module"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { CliCommandDeclaration, CliDoorCard } from "../daemon/cli-manifest"
import type { CommandHelp } from "../daemon/cli-help"
import { needsSubcommand, unknownFlag } from "../daemon/cli-commands/cards"
import type { McpToolSchema } from "../mcp/mcp-server"
import { parseDeclaredTools, type DeclaredTool } from "../../repertoire/mcp-declared-tools"

/** One command as ouro-actions' commands.json lists it. */
export interface GeneratedCommand {
  name: string
  summary: string
  effect: "private" | "others"
  readOnly?: true
  output: string
}

/** One tool as ouro-actions' mcp.json lists it. */
export interface GeneratedMcpTool {
  name: string
  title: string
  description: string
  inputSchema: McpToolSchema["inputSchema"]
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean; idempotentHint?: boolean }
  outputSchema?: Record<string, unknown>
}

/** One action as ouro-actions' actions.json lists it: here only its id and the CLI words that run it. */
export interface GeneratedAction {
  id: string
  cli?: string
}

export interface MailboxDoors {
  actions: GeneratedAction[]
  commands: GeneratedCommand[]
  mcpTools: GeneratedMcpTool[]
  /** The in-turn tools by name, each with its declared card. */
  tools: ReadonlyMap<string, DeclaredTool>
}

/** The actions this module has a handler for. cli-parse's MAILBOX_CLI_WORDS maps the CLI's words to them. */
export type MailboxActionId = "mailbox_list"

/** An action refused by its card's error code. */
export class MailboxDoorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "MailboxDoorError"
  }
}

export interface MailboxListResult {
  outcome: "done"
  count: number
  listing: string
}

let loaded: MailboxDoors | null = null

/** For tests: forget the doors read so far. */
export function resetMailboxDoorsForTest(): void {
  loaded = null
}

/**
 * Node's own `fs`, through Node's loader rather than an import: the CLI's declarations are read when cli-manifest
 * loads, and the many tests that mock `fs` must still see the real generated files. The files are read, not
 * required, so `ouro --version` loads no extra modules for them (the edge benchmark counts its modules).
 */
const realFs = createRequire(__filename)("fs") as typeof import("fs")

function readGenerated(root: string, file: string): Record<string, unknown> {
  const full = path.join(root, "actions", "generated", file)
  const where = `actions/generated/${file}`
  let json: unknown
  try {
    json = JSON.parse(realFs.readFileSync(full, "utf8"))
  } catch (error) {
    throw new Error(`${where} can't be read: ${(error as Error).message}. Fix: run ouro-actions generate for actions/mailbox.actions.mts.`)
  }
  return json as Record<string, unknown>
}

/**
 * Where the generated doors are, from this module's own folder, not identity's getRepoRoot (many tests point that at
 * a fake root). In a checkout it is the package root, where ouro-actions writes them, so a dev build made with `tsc`
 * alone never reads a stale or missing copy. An installed package or an image has no actions/ folder there; it reads
 * the copies the build put in dist/ (scripts/copy-action-doors.cjs), because every runtime ships dist/.
 */
export function doorsRoot(moduleDir: string, exists: (file: string) => boolean = (file) => realFs.existsSync(file)): string {
  const top = path.resolve(moduleDir, "../..")
  const packageRoot = path.dirname(top)
  return exists(path.join(packageRoot, "actions", "generated", "mailbox", "commands.json")) ? packageRoot : top
}

const PACKAGE_ROOT = doorsRoot(__dirname)

/**
 * Reads the generated doors once; later calls return the first read, whatever root they pass (tests read fake doors
 * this way, then reset). A missing or malformed file fails loudly: a door with no declaration never runs.
 */
export function readMailboxDoors(root: string = PACKAGE_ROOT): MailboxDoors {
  if (loaded) return loaded
  const commands = readGenerated(root, "mailbox/commands.json")
  const mcp = readGenerated(root, "mailbox/mcp.json")
  const toolsJson = readGenerated(root, "mailbox-tools/tools.json")
  if (!Array.isArray(commands.commands)) throw new Error("actions/generated/mailbox/commands.json has no commands list. Fix: run ouro-actions generate.")
  if (!Array.isArray(mcp.tools)) throw new Error("actions/generated/mailbox/mcp.json has no tools list. Fix: run ouro-actions generate.")
  const { tools, problems } = parseDeclaredTools(toolsJson)
  if (problems.length > 0) throw new Error(`actions/generated/mailbox-tools/tools.json: ${problems.join("; ")}. Fix: run ouro-actions-tools generate.`)
  const actions = readGenerated(root, "mailbox/actions.json")
  if (!Array.isArray(actions.actions)) throw new Error("actions/generated/mailbox/actions.json has no actions list. Fix: run ouro-actions generate.")
  const doors: MailboxDoors = { actions: actions.actions as GeneratedAction[], commands: commands.commands as GeneratedCommand[], mcpTools: mcp.tools as GeneratedMcpTool[], tools }
  loaded = doors
  emitNervesEvent({
    component: "daemon",
    event: "mailbox.doors_loaded",
    message: "mailbox doors read from the generated files",
    meta: { commands: doors.commands.length, mcp: doors.mcpTools.length, tools: doors.tools.size },
  })
  return doors
}

function listMailbox(): MailboxListResult {
  // Until the letters store lands (S3), no letter can be filed, so the pile is always empty.
  return { outcome: "done", count: 0, listing: "" }
}

const HANDLERS: Record<MailboxActionId, (input: Record<string, unknown>) => MailboxListResult> = {
  mailbox_list: listMailbox,
}

/** Runs one mailbox action with its input, checked against the generated schema; refusals carry the card's code. */
export function runMailboxAction(action: string, input: Record<string, unknown>): MailboxListResult {
  const handler = Object.hasOwn(HANDLERS, action) ? HANDLERS[action as MailboxActionId] : undefined
  const tool = readMailboxDoors().mcpTools.find((t) => t.name === action)
  if (!handler || !tool) throw new MailboxDoorError("unknown-door", `The mailbox has no action ${action}.`)
  const extra = Object.keys(input).filter((key) => !Object.hasOwn(tool.inputSchema.properties, key))
  if (extra.length > 0) throw new MailboxDoorError("unknown-input", `${action} doesn't take ${extra.join(", ")}.`)
  const result = handler(input)
  emitNervesEvent({ component: "daemon", event: "mailbox.action_run", message: "mailbox action ran", meta: { action, outcome: result.outcome } })
  return result
}

function cardFor(name: string): DeclaredTool["ax"] {
  return readMailboxDoors().tools.get(name)!.ax
}

/**
 * The census reads two doors with the same `when` as one door described twice, so the CLI and MCP doors say where
 * they are called from; the in-turn tool keeps the generated line as tools.json declares it.
 */
function whenFrom(where: string, when: string): string {
  return `${where}, ${when.charAt(0).toLowerCase()}${when.slice(1)}`
}

/** The CLI's declarations: one per generated command, each carded from its action, then the group's own words. */
export function mailboxCliDeclarations(): CliCommandDeclaration[] {
  const doors = readMailboxDoors()
  const commands = doors.commands.map((command): CliCommandDeclaration => {
    const action = doors.actions.find((a) => a.cli === command.name)
    if (!action) throw new Error(`actions/generated/mailbox/commands.json lists ${command.name}, but no action in actions.json names it as its cli. Fix: run ouro-actions generate.`)
    const card = cardFor(action.id)
    const ax: CliDoorCard = {
      id: `cli:${command.name}`, group: card.group, when: whenFrom("From a shell", card.when), effect: card.effect, errors: [unknownFlag(command.name)],
      ...(card.idempotent ? { idempotent: true as const } : {}),
    }
    return { name: command.name, effect: command.effect, ...(command.readOnly ? { readOnly: true as const } : {}), summary: command.summary, example: `${command.name} --json`, ax }
  })
  const words = doors.commands.map((command) => command.name.replace(/^mailbox /, "")).join(", ")
  return [
    ...commands,
    {
      name: "mailbox", effect: "private", readOnly: true, summary: "The commands for the letters an agent files for its person.",
      ax: { id: "cli:mailbox", group: "mailbox", effect: "read", when: "Names the ways to see the letters an agent has filed for its person and what they wait on.", errors: [needsSubcommand("mailbox", words), unknownFlag("mailbox")] },
    },
  ]
}

/** `ouro help` for the group and each generated command, from the generated summaries. */
export function mailboxHelp(): { group: CommandHelp; commands: Record<string, CommandHelp> } {
  const commands = readMailboxDoors().commands
  const subcommands = commands.map((command) => command.name.replace(/^mailbox /, ""))
  return {
    group: {
      description: "See the letters an agent has filed for you",
      usage: `ouro ${commands[0]!.name.split(" ")[0]} <${subcommands.join("|")}> [--json]`,
      example: `ouro ${commands[0]!.name}`,
      subcommands,
    },
    commands: Object.fromEntries(commands.map((command) => [command.name, { description: command.summary, usage: `ouro ${command.name} [--json]`, example: `ouro ${command.name} --json` }])),
  }
}

/** The MCP server's schemas: the generated tools, each carded from its action as an `mcp:` door. */
export function mailboxMcpSchemas(): McpToolSchema[] {
  return readMailboxDoors().mcpTools.map((tool) => {
    const card = cardFor(tool.name)
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, ax: { ...card, id: `mcp:${tool.name}`, when: whenFrom("From a coding tool", card.when) } }
  })
}

/**
 * One generated MCP tool by name. mcp-server.ts names each tool it serves, because the census places an MCP door by
 * its literal name in that file; a name mcp.json doesn't list fails loudly here.
 */
export function mailboxMcpSchema(name: string): McpToolSchema {
  const schema = mailboxMcpSchemas().find((s) => s.name === name)
  if (!schema) throw new Error(`actions/generated/mailbox/mcp.json has no tool ${name}. Fix: declare it in actions/mailbox.actions.mts and run ouro-actions generate.`)
  return schema
}

/**
 * The declared tools as a server lists them, for the AX census's declared-tools walker
 * (ax/census.config.json), which holds them to tools.json.
 */
export function getToolSchemas(): Array<Pick<GeneratedMcpTool, "name" | "description" | "inputSchema" | "annotations">> {
  return readMailboxDoors().mcpTools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))
}

export function listTools(): ReturnType<typeof getToolSchemas> {
  return getToolSchemas()
}
