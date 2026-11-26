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
import { agentErrors, needsSubcommand, unknownFlag, usageError } from "../daemon/cli-commands/cards"
import type { DaemonCommand, DaemonResponse } from "../daemon/daemon"
import type { McpToolSchema } from "../mcp/mcp-server"
import { parseDeclaredTools, type DeclaredTool } from "../../repertoire/mcp-declared-tools"

/** One CLI flag or word as ouro-actions' commands.json lists it. */
export interface GeneratedFlag {
  type: "string" | "number" | "boolean" | "enum"
  description: string
  required?: boolean
  values?: string[]
}

/** One command as ouro-actions' commands.json lists it. */
export interface GeneratedCommand {
  name: string
  summary: string
  effect: "private" | "others"
  readOnly?: true
  args?: Array<{ name: string; description: string; required?: boolean }>
  flags?: Record<string, GeneratedFlag>
  output: string
}

/** A person-only action's refusal, as mcp.json and tools.json carry it: web's refused outcome. */
export interface GeneratedRefusal {
  state: "refused"
  summary: string
  error: { code: "person-only"; message: string }
  [key: string]: unknown
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
  /** The person-only actions' refusals by action id, which every agent door answers. */
  refusals: Record<string, GeneratedRefusal>
  /** The in-turn tools by name, each with its declared card. */
  tools: ReadonlyMap<string, DeclaredTool>
}

/** The actions the doors run. cli-parse's MAILBOX_CLI_WORDS maps the CLI's words to them. */
export type MailboxActionId = "mailbox_send" | "mailbox_list" | "mailbox_read" | "mailbox_wait" | "mailbox_withdraw" | "mailbox_deliver"

/** An action refused by its card's error code. */
export class MailboxDoorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "MailboxDoorError"
  }
}

/** What an action answers: its generated output fields, `outcome` first. */
export type MailboxResult = Record<string, unknown> & { outcome: string }

type SendCommand = (socketPath: string, command: DaemonCommand, options: { timeoutMs?: number }) => Promise<DaemonResponse>

/** Who a door serves and how it reaches the daemon. */
export interface MailboxCaller {
  /** The agent whose letters these are: the CLI's --agent, the MCP server's agent, the agent in the turn. */
  agent: string
  dryRun?: boolean
  socketPath?: string
  /** For tests; the default is the daemon socket client. */
  send?: SendCommand
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
  const doors: MailboxDoors = {
    actions: actions.actions as GeneratedAction[], commands: commands.commands as GeneratedCommand[], mcpTools: mcp.tools as GeneratedMcpTool[],
    refusals: (mcp.refusals ?? {}) as Record<string, GeneratedRefusal>, tools,
  }
  loaded = doors
  emitNervesEvent({
    component: "daemon",
    event: "mailbox.doors_loaded",
    message: "mailbox doors read from the generated files",
    meta: { commands: doors.commands.length, mcp: doors.mcpTools.length, tools: doors.tools.size },
  })
  return doors
}

interface InputSchema {
  type?: string
  description?: string
  enum?: string[]
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  items?: InputSchema
  properties?: Record<string, InputSchema>
  required?: string[]
}

const TYPE_WORDS: Record<string, string> = { string: "text", integer: "a whole number", boolean: "true or false", array: "a list" }

/** What is wrong with one value against its generated schema, naming it; null when nothing is. */
function problemWith(name: string, schema: InputSchema, value: unknown): string | null {
  const takes = `${name} takes ${TYPE_WORDS[schema.type!] ?? "an object"}`
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return `${takes}: ${schema.description}`
      if (schema.enum && !schema.enum.includes(value)) return `${name} is one of ${schema.enum.join(", ")}, not ${value}.`
      if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return `${name} is longer than ${schema.maxLength} characters.`
      return null
    case "integer":
      if (!Number.isInteger(value)) return `${takes}: ${schema.description}`
      if ((schema.minimum !== undefined && (value as number) < schema.minimum) || (schema.maximum !== undefined && (value as number) > schema.maximum)) {
        return `${name} is out of range: ${schema.description}`
      }
      return null
    case "boolean":
      return typeof value === "boolean" ? null : `${takes}: ${schema.description}`
    case "array": {
      if (!Array.isArray(value)) return `${takes}: ${schema.description}`
      if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return `${name} has ${value.length} items: ${schema.description}`
      for (const [index, item] of value.entries()) {
        const problem = problemWith(`${name}[${index}]`, schema.items!, item)
        if (problem) return problem
      }
      return null
    }
    default: {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${takes}: ${schema.description}`
      const record = value as Record<string, unknown>
      const extra = Object.keys(record).find((key) => !Object.hasOwn(schema.properties!, key))
      if (extra) return `${name} has ${extra}, which it doesn't take.`
      const missing = schema.required!.find((key) => record[key] === undefined)
      if (missing) return `${name}.${missing} is missing: ${schema.properties![missing]!.description}`
      for (const [key, item] of Object.entries(record)) {
        const problem = problemWith(`${name}.${key}`, schema.properties![key]!, item)
        if (problem) return problem
      }
      return null
    }
  }
}

/** Errors a socket call throws when nothing listens there: the daemon is down. */
const DOWN = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"])

/**
 * Runs one mailbox action: its input is checked against the generated schema here, then the daemon's single writer
 * runs it (src/heart/letters/writer.ts) over the socket. Refusals carry the card's code.
 */
export async function runMailboxAction(action: string, input: Record<string, unknown>, caller: MailboxCaller): Promise<MailboxResult> {
  const doors = readMailboxDoors()
  const refusal = Object.hasOwn(doors.refusals, action) ? doors.refusals[action] : undefined
  if (refusal) throw new MailboxDoorError("person-only", refusal.summary)
  const tool = doors.mcpTools.find((t) => t.name === action)
  if (!tool) throw new MailboxDoorError("unknown-door", `The mailbox has no action ${action}.`)
  const schema = tool.inputSchema as InputSchema
  const extra = Object.keys(input).filter((key) => !Object.hasOwn(schema.properties!, key))
  if (extra.length > 0) throw new MailboxDoorError("unknown-input", `${action} doesn't take ${extra.join(", ")}.`)
  // ouro-actions writes every input schema with its required list, empty when nothing is.
  const missing = schema.required!.find((key) => input[key] === undefined)
  if (missing) throw new MailboxDoorError("bad-input", `${missing} is missing: ${schema.properties![missing]!.description}`)
  for (const [key, value] of Object.entries(input)) {
    const problem = problemWith(key, schema.properties![key]!, value)
    if (problem) throw new MailboxDoorError("bad-input", problem)
  }
  const send = caller.send ?? (await import("../daemon/socket-client")).sendDaemonCommand
  const socketPath = caller.socketPath ?? (await import("../daemon/socket-client")).DEFAULT_DAEMON_SOCKET_PATH
  const command: DaemonCommand = { kind: "letters.action", agent: caller.agent, action, input, ...(caller.dryRun ? { dryRun: true } : {}) }
  // A wait holds the socket for its own timeout, and a deliver for its chat send (the daemon answers within
  // DELIVER_DEADLINE_MS of starting it, perhaps after another deliver ahead of it); anything else answers at once.
  const waitSeconds = action === "mailbox_wait" ? Number(input.timeout ?? 60) : action === "mailbox_deliver" ? 60 : 0
  let response: DaemonResponse
  try {
    response = await send(socketPath, command, { timeoutMs: (waitSeconds + 30) * 1000 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code && DOWN.has(code)) throw new MailboxDoorError("daemon-down", `The Ouro daemon isn't running, so ${action} did nothing.`)
    throw error
  }
  const refused = response.data as { code?: unknown; message?: unknown } | undefined
  if (!response.ok && typeof refused?.code === "string") throw new MailboxDoorError(refused.code, String(refused.message))
  if (!response.ok || typeof response.data !== "object" || response.data === null) {
    throw new Error(`${action} failed in the daemon: ${response.error ?? response.message ?? "it answered nothing"}`)
  }
  const result = response.data as MailboxResult
  emitNervesEvent({ component: "daemon", event: "mailbox.action_run", message: "mailbox action ran", meta: { action, outcome: result.outcome } })
  return result
}

/** A result as a person reads it in a shell; --json prints the result itself. */
export function renderMailboxResult(action: MailboxActionId, result: MailboxResult): string {
  if (action === "mailbox_list") return result.count === 0 ? "No letters are waiting." : String(result.listing)
  if (action === "mailbox_read") {
    const letter = JSON.parse(String(result.letter)) as { code: string; subject: string }
    return [`${letter.code} ${letter.subject} (${String(result.state)})`, ...(result.events ? [String(result.events)] : [])].join("\n")
  }
  if (typeof result.message === "string") return result.message
  return `${result.outcome}: ${String(result.state)}`
}

/** The camelCase input name of a kebab-case flag (`why-only-you` is `whyOnlyYou`). */
function inputName(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/** `ouro mailbox <word> …` as the action's input, read the way commands.json declares its words and flags. */
export function parseMailboxCli(word: string, tokens: readonly string[]): { action: MailboxActionId; input: Record<string, unknown>; json: boolean; dryRun: boolean } {
  const doors = readMailboxDoors()
  const command = doors.commands.find((c) => c.name === `mailbox ${word}`)!
  const action = doors.actions.find((a) => a.cli === command.name)!.id as MailboxActionId
  const properties = (doors.mcpTools.find((t) => t.name === action)!.inputSchema as InputSchema).properties!
  const flags = command.flags ?? {}
  const args = command.args ?? []
  const usageText = `Usage: ${mailboxUsageLines().find((line) => line.startsWith(`ouro ${command.name} `))}`
  const input: Record<string, unknown> = {}
  const words: string[] = []
  let json = false
  let dryRun = false
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === "--json") json = true
    else if (token === "--dry-run" && !command.readOnly) dryRun = true
    else if (token.startsWith("--") && Object.hasOwn(flags, token.slice(2))) {
      const name = token.slice(2)
      const key = inputName(name)
      if (flags[name]!.type === "boolean") {
        input[key] = true
        continue
      }
      const value = tokens[++index]
      if (value === undefined) throw new Error(`${token} needs a value.\n${usageText}`)
      const type = properties[key]!.type
      // The generator gives a whole number flag type "number" and a list one JSON string (ouro-actions.mts).
      if (type === "integer") {
        input[key] = /^\d+$/.test(value) ? Number(value) : Number.NaN
        if (!Number.isFinite(input[key])) throw new Error(`${token} takes a number, not ${value}.\n${usageText}`)
      } else if (type === "array") {
        try {
          input[key] = JSON.parse(value)
        } catch {
          throw new Error(`${token} takes a JSON list, such as '[{"label":"Yes","effect":"…"}]'.\n${usageText}`)
        }
      } else input[key] = value
    } else if (token.startsWith("-")) throw new Error(`ouro ${command.name} doesn't take ${token}.\n${usageText}`)
    else words.push(token)
  }
  if (words.length > args.length) throw new Error(`ouro ${command.name} takes ${args.length === 0 ? "no words" : `only <${args.map((a) => a.name).join("> <")}>`} after it: ${words.join(" ")}\n${usageText}`)
  args.forEach((arg, index) => {
    if (words[index] !== undefined) input[arg.name] = words[index]
  })
  const missing = [
    ...args.filter((arg) => arg.required && input[arg.name] === undefined).map((arg) => `<${arg.name}>`),
    ...Object.entries(flags).filter(([name, flag]) => flag.required && input[inputName(name)] === undefined).map(([name]) => `--${name}`),
  ]
  if (missing.length > 0) throw new Error(`ouro ${command.name} needs ${missing.join(" and ")}.\n${usageText}`)
  return { action, input, json, dryRun }
}

/** A command line the parser accepts, after `ouro`: each required word and flag with a sample value, a write as a dry run. */
function exampleFor(command: GeneratedCommand): string {
  const args = (command.args ?? []).filter((arg) => arg.required).map(() => "L1")
  const flags = Object.entries(command.flags ?? {}).filter(([, flag]) => flag.required).map(([name, flag]) => `--${name} ${flag.type === "enum" ? flag.values![0] : "example"}`)
  return [command.name, ...args, ...flags, ...(command.readOnly ? [] : ["--dry-run"]), "--json"].join(" ")
}

/** Each generated command's usage line: its words, its flags (optional ones in brackets), --dry-run on a write, --json. */
export function mailboxUsageLines(): string[] {
  return readMailboxDoors().commands.map((command) => {
    const args = (command.args ?? []).map((arg) => (arg.required ? `<${arg.name}>` : `[<${arg.name}>]`))
    const flags = Object.entries(command.flags ?? {}).map(([name, flag]) => {
      const value = flag.type === "boolean" ? "" : flag.type === "enum" ? ` <${flag.values!.join("|")}>` : flag.type === "number" ? " <n>" : ` <${name}>`
      return flag.required ? `--${name}${value}` : `[--${name}${value}]`
    })
    return ["ouro", command.name, ...args, ...flags, ...(command.readOnly ? [] : ["[--dry-run]"]), "[--json]"].join(" ")
  })
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

/** The group's card for its person-only words, which refuse every agent; none when it has none. */
function personOnlyCard(words: string[]): CliDoorCard["errors"] {
  if (words.length === 0) return []
  return [{
    code: "person-only",
    means: `Only the person does what these words do, so they refuse every agent: ${words.join(", ")}. The refusal says how the person does it.`,
    fix: "Tell the person what the refusal says, and leave the step to them.",
  }]
}

/** The CLI's declarations: one per generated command, each carded from its action, then the group's own words. */
export function mailboxCliDeclarations(): CliCommandDeclaration[] {
  const doors = readMailboxDoors()
  const commands = doors.commands.map((command): CliCommandDeclaration => {
    const action = doors.actions.find((a) => a.cli === command.name)
    if (!action) throw new Error(`actions/generated/mailbox/commands.json lists ${command.name}, but no action in actions.json names it as its cli. Fix: run ouro-actions generate.`)
    const card = cardFor(action.id)
    // The action's own codes, except no-agent, which the CLI's card says its own way, and unknown-input, which the
    // flag gate answers first as unknown-flag.
    const own = card.errors.filter((error) => error.code !== "no-agent" && error.code !== "unknown-input")
    const errors = [
      ...own, ...agentErrors(command.name), unknownFlag(command.name),
      usageError(command.name, "is missing a word or flag it needs, or got a value it can't read; the error names it.", `Read ouro ${command.name} --help, then run it again.`),
    ]
    const ax: CliDoorCard = {
      id: `cli:${command.name}`, group: card.group, when: whenFrom("From a shell", card.when), effect: card.effect, errors,
      ...(card.idempotent ? { idempotent: true as const } : {}),
    }
    return { name: command.name, effect: command.effect, ...(command.readOnly ? { readOnly: true as const } : {}), summary: command.summary, example: exampleFor(command), ax }
  })
  const words = doors.commands.map((command) => command.name.replace(/^mailbox /, "")).join(", ")
  return [
    ...commands,
    {
      name: "mailbox", effect: "private", readOnly: true, summary: "The commands for the letters an agent files for its person.",
      ax: { id: "cli:mailbox", group: "mailbox", effect: "read", when: "Names the ways to see the letters an agent has filed for its person and what they wait on.", errors: [
        needsSubcommand("mailbox", words), unknownFlag("mailbox"),
        ...personOnlyCard(Object.values(doors.refusals).map((refusal) => `ouro ${String(refusal.action)}`)),
      ] },
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
    commands: Object.fromEntries(commands.map((command, index) => [command.name, { description: command.summary, usage: mailboxUsageLines()[index]!, example: `ouro ${exampleFor(command)}` }])),
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
