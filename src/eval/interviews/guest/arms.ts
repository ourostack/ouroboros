/**
 * The three X arms (pre-registration section 2), each the same books operations (`operations.ts`) on the same books
 * command (`books-core.ts`), presented three ways:
 * - `ouro`: the operations defined once with `ax-command` from Ouro AX v1.3.445 (vendored unchanged in `./ax`, its
 *   imports without the `.ts` extension), offered as the kit's own MCP tools: `createMcpHandler`'s tools/list and
 *   tools/call, with its input checks, error shape and result text.
 * - `mcp-plain`: the same operations as hand-written MCP tools, each with a description, an `inputSchema`, a text
 *   result and `isError` on failure.
 * - `cli-shell`: a conventional `books` command line behind one `shell` tool (`cli-shell.ts`).
 *
 * The core's answer is the result in every arm, as JSON text in the two tool arms and as lines of text (or `--json`)
 * on the command line. A core error is an error in every arm, with the core's message; none adds a fix the others lack.
 */
import { emitNervesEvent } from "../../../nerves/runtime"
import { checkInput, defineCli, defineCommand, type ArgSpec, type FlagSpec, type Input } from "./ax/ax-command"
import { createMcpHandler, mcpTools, PROTOCOL_VERSIONS } from "./ax/mcp"
import { AxError } from "./ax/problem"
import { coreError, type BooksCore } from "./books-core"
import { cliShellArm } from "./cli-shell"
import { OPERATIONS, argvOf, type Operation, type OperationInput, type Param } from "./operations"

export type JsonSchema = Record<string, unknown>
export type ArmTool = { name: string; description: string; parameters: JsonSchema }
export type ToolAnswer = { text: string; isError: boolean }
export type Arm = {
  key: string
  tools: ArmTool[]
  call(name: string, args: string): Promise<ToolAnswer>
  /** The operation a call ran and its input, so the host can write it as the books command line; null when it ran none. */
  operationOf(name: string, args: string): { op: Operation; input: OperationInput } | null
}

export const X_ARMS = ["ouro", "mcp-plain", "cli-shell"] as const
export type XArm = (typeof X_ARMS)[number]

const parseArgs = (args: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(args || "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

// ---- ouro: ax-command ------------------------------------------------------------------------------------------

const axArg = (param: Param): ArgSpec => ({ name: param.name, description: param.description, required: param.required === true, ...(param.kind === "list" ? { rest: "list" as const } : {}) })
const axFlag = (param: Param): FlagSpec => ({ type: param.kind === "flag" ? "boolean" : param.kind === "number" ? "number" : "string", description: param.description })

function axInput(op: Operation, input: Input): OperationInput {
  const out: OperationInput = {}
  for (const param of op.params) {
    const value = input[param.name]
    if (value !== undefined) out[param.name] = Array.isArray(value) ? [...value] : value as string | number | boolean
  }
  return out
}

/** The books command line built with ax-command, one definition per operation. */
export function booksAxCli(core: BooksCore) {
  return defineCli({
    name: "books",
    about: ["books: find, check, shelve and send the household's e-books."],
    commands: OPERATIONS.map((op) => defineCommand({
      name: op.words.join(" "),
      summary: op.summary,
      effect: "private",
      readOnly: op.readOnly,
      args: op.params.filter((p) => p.positional).map(axArg),
      flags: Object.fromEntries(op.params.filter((p) => !p.positional).map((p) => [p.name, axFlag(p)])),
      examples: [`books ${op.example}`],
      output: "the books command's answer as JSON",
      run: async (input: Input) => {
        const result = await core(argvOf(op, axInput(op, input)))
        const error = coreError(result)
        if (error !== null) throw new AxError({ code: "books-failed", exit: result.code === 2 ? 2 : 1, thing: op.words.join("_"), problem: error, fix: null })
        return result.json
      },
    })),
  })
}

function axArm(core: BooksCore): Arm {
  const cli = booksAxCli(core)
  const handle = createMcpHandler({ cli })
  const byName = new Map(OPERATIONS.map((op) => [op.words.join("_"), op]))
  let id = 0
  return {
    key: "ouro",
    tools: mcpTools({ cli }).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema as JsonSchema })),
    async call(name, args) {
      id += 1
      const params = parseArgs(args) ?? { "": args }
      const meta = { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSIONS[0], "io.modelcontextprotocol/clientCapabilities": {} }
      const reply = await handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: params, _meta: meta } }) as { result: { content: Array<{ text: string }>; isError: boolean } }
      return { text: reply.result.content.map((part) => part.text).join("\n"), isError: reply.result.isError }
    },
    operationOf(name, args) {
      // Only what the kit would run: its own input check, so a call it refuses names no operation.
      const op = byName.get(name)
      const command = cli.commands.find((c) => c.name === op?.words.join(" "))
      const params = parseArgs(args)
      if (!op || !command || !params) return null
      try {
        return { op, input: axInput(op, checkInput(cli, command, params)) }
      } catch {
        return null
      }
    },
  }
}

// ---- mcp-plain: hand-written MCP tools ---------------------------------------------------------------------------

const PLAIN_NAMES: Readonly<Record<string, string>> = {
  "search": "search_books", "get": "download_book", "check": "check_books", "text": "read_book_text", "library find": "find_in_library",
  "library add": "add_to_library", "library remove": "remove_from_library", "library replace": "replace_in_library",
  "send": "send_to_reader", "deliver": "deliver_books", "ledger": "show_history",
}

function plainSchema(op: Operation): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  for (const param of op.params) {
    const type = param.kind === "list" ? { type: "array", items: { type: "string" } } : param.kind === "flag" ? { type: "boolean" } : param.kind === "number" ? { type: param.name === "id" ? "integer" : "number" } : { type: "string" }
    properties[param.name.replace(/-/g, "_")] = { ...type, description: param.description }
  }
  return { type: "object", properties, required: op.params.filter((p) => p.required).map((p) => p.name.replace(/-/g, "_")) }
}

function plainInput(op: Operation, params: Record<string, unknown>): OperationInput | string {
  const input: OperationInput = {}
  for (const param of op.params) {
    const key = param.name.replace(/-/g, "_")
    const value = params[key]
    if (value === undefined || value === null) {
      if (param.required) return `missing required argument: ${key}`
      continue
    }
    const ok = param.kind === "list" ? Array.isArray(value) && value.every((v) => typeof v === "string") : param.kind === "flag" ? typeof value === "boolean" : param.kind === "number" ? typeof value === "number" : typeof value === "string"
    if (!ok) return `argument ${key} must be ${param.kind === "list" ? "an array of strings" : param.kind === "flag" ? "a boolean" : `a ${param.kind}`}`
    input[param.name] = value as string | number | boolean | string[]
  }
  return input
}

function mcpPlainArm(core: BooksCore): Arm {
  const byName = new Map(OPERATIONS.map((op) => [PLAIN_NAMES[op.words.join(" ")]!, op]))
  const resolve = (name: string, args: string): { error: string } | { op: Operation; input: OperationInput } => {
    const op = byName.get(name)
    if (!op) return { error: `Unknown tool: ${name}` }
    const params = parseArgs(args)
    if (!params) return { error: "arguments must be a JSON object" }
    const input = plainInput(op, params)
    return typeof input === "string" ? { error: input } : { op, input }
  }
  return {
    key: "mcp-plain",
    tools: [...byName].map(([name, op]) => ({ name, description: op.summary, parameters: plainSchema(op) })),
    async call(name, args) {
      const resolved = resolve(name, args)
      if ("error" in resolved) return { text: resolved.error, isError: true }
      const result = await core(argvOf(resolved.op, resolved.input))
      const error = coreError(result)
      return error !== null ? { text: error, isError: true } : { text: JSON.stringify(result.json), isError: false }
    },
    operationOf(name, args) {
      const resolved = resolve(name, args)
      return "error" in resolved ? null : resolved
    },
  }
}

/** The X arm named `key`, on `core`. */
export function buildArm(key: string, core: BooksCore): Arm {
  emitNervesEvent({ component: "eval", event: "eval.interview_arm_built", message: "built an X arm's tools", meta: { arm: key } })
  if (key === "ouro") return axArm(core)
  if (key === "mcp-plain") return mcpPlainArm(core)
  if (key === "cli-shell") return cliShellArm(core)
  throw new Error(`no X arm ${key}; the arms are ${X_ARMS.join(", ")}`)
}
