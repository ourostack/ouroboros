/**
 * The `cli-shell` X arm: a conventional `books` command line behind one `shell` tool, written to the Command Line
 * Interface Guidelines (clig.dev): `--help` and `-h` on every command, a help overview with examples, output for a
 * person by default and `--json` for a program, errors on stderr that say what to do next, exit status 0 on success,
 * 1 on failure and 2 on a usage error.
 *
 * The shell runs one `books` command per call, with POSIX quoting. It has no other programs, pipes, redirection or
 * chaining, so this arm reaches exactly the operations the other two arms do (a fidelity note every report carries).
 */
import { emitNervesEvent } from "../../../nerves/runtime"
import type { Arm, ToolAnswer } from "./arms"
import { coreError, type BooksCore } from "./books-core"
import { OPERATIONS, argvOf, type Operation, type OperationInput } from "./operations"

/** The command's words, or why the shell will not run it. */
export function tokenize(command: string): string[] | { error: string } {
  const words: string[] = []
  let word: string | null = null
  let i = 0
  const add = (text: string): void => { word = (word ?? "") + text }
  while (i < command.length) {
    const c = command[i]!
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return { error: "unterminated quote" }
      add(command.slice(i + 1, end))
      i = end + 1
    } else if (c === "\"") {
      let j = i + 1
      let text = ""
      while (j < command.length && command[j] !== "\"") {
        if (command[j] === "\\" && j + 1 < command.length && "\"\\$`".includes(command[j + 1]!)) j += 1
        else if (command[j] === "$" || command[j] === "`") return { error: "substitution is not available in this shell" }
        text += command[j]
        j += 1
      }
      if (j >= command.length) return { error: "unterminated quote" }
      add(text)
      i = j + 1
    } else if (c === "\\") {
      add(command[i + 1] ?? "")
      i += 2
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word)
      word = null
      i += 1
    } else if ("|&;<>()`$".includes(c)) {
      return { error: "pipes, redirection, chaining and substitution are not available in this shell; run one books command at a time" }
    } else {
      add(c)
      i += 1
    }
  }
  if (word !== null) words.push(word)
  return words
}

const usageOf = (op: Operation): string => {
  const positional = op.params.filter((p) => p.positional).map((p) => p.kind === "list" ? `<${p.name.replace(/s$/, "")}>...` : `<${p.name}>`)
  const flags = op.params.filter((p) => !p.positional).map((p) => p.kind === "flag" ? `[--${p.name}]` : `[--${p.name} <${p.kind === "number" ? "n" : "value"}>]`)
  return ["books", ...op.words, ...positional, ...flags, "[--json]"].join(" ")
}

export function overviewHelp(): string {
  const width = Math.max(...OPERATIONS.map((op) => op.words.join(" ").length))
  return [
    "Find, check, shelve and send the household's e-books.",
    "",
    "Usage: books <command> [arguments] [--json]",
    "",
    "Commands:",
    ...OPERATIONS.map((op) => `  ${op.words.join(" ").padEnd(width)}  ${op.summary}`),
    "",
    "Examples:",
    "  books search \"The Harbour Almanac\"",
    "  books library find \"The Harbour Almanac\"",
    "  books check work/1700000000-ab12cd34/the-harbour-almanac.epub",
    "",
    "Run 'books <command> --help' for a command's arguments. Add --json to any command for machine-readable output.",
  ].join("\n")
}

export function commandHelp(op: Operation): string {
  const lines = [op.summary, "", `Usage: ${usageOf(op)}`]
  const positional = op.params.filter((p) => p.positional)
  const flags = op.params.filter((p) => !p.positional)
  if (positional.length > 0) lines.push("", "Arguments:", ...positional.map((p) => `  ${p.name}  ${p.description}`))
  lines.push("", "Options:", ...flags.map((p) => `  --${p.name}${p.kind === "flag" ? "" : " <value>"}  ${p.description}`), "  --json  Print the answer as JSON.", "  -h, --help  Show this help.")
  lines.push("", "Example:", `  books ${op.example}`)
  return lines.join("\n")
}

function table(rows: Array<Record<string, unknown>>): string[] {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => row[key] === null || typeof row[key] !== "object")))]
  const cell = (value: unknown): string => value === undefined || value === null ? "" : String(value)
  const widths = keys.map((key) => Math.max(key.length, ...rows.map((row) => cell(row[key]).length)))
  const line = (values: string[]): string => values.map((value, i) => value.padEnd(widths[i]!)).join("  ").trimEnd()
  const nested = rows.flatMap((row, i) => Object.entries(row).filter(([, value]) => value !== null && typeof value === "object").map(([key, value]) => `  row ${i + 1} ${key}: ${JSON.stringify(value)}`))
  return [line(keys.map((key) => key.toUpperCase())), ...rows.map((row) => line(keys.map((key) => cell(row[key])))), ...nested]
}

/** The answer for a person: each field on its line, lists of records as a table. */
export function humanText(value: Record<string, unknown>, indent = ""): string {
  const lines: string[] = []
  for (const [key, field] of Object.entries(value)) {
    if (key === "ok" && indent === "") continue
    if (Array.isArray(field)) {
      if (field.length === 0) lines.push(`${indent}${key}: none`)
      else if (field.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) lines.push(`${indent}${key}:`, ...table(field as Array<Record<string, unknown>>).map((row) => `${indent}  ${row}`))
      else lines.push(`${indent}${key}: ${field.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ")}`)
    } else if (field !== null && typeof field === "object") {
      lines.push(`${indent}${key}:`, humanText(field as Record<string, unknown>, `${indent}  `))
    } else {
      lines.push(`${indent}${key}: ${String(field)}`)
    }
  }
  return lines.join("\n")
}

type Parsed = { help: string } | { usage: string; op?: Operation } | { op: Operation; input: OperationInput; json: boolean }

/** Reads `books` argv into an operation and its input, its help, or a usage error. */
export function parseBooks(argv: string[]): Parsed {
  const asksHelp = argv.includes("--help") || argv.includes("-h")
  const rest = argv.filter((word) => word !== "--help" && word !== "-h")
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "help")) return { help: overviewHelp() }
  const op = [...OPERATIONS].sort((a, b) => b.words.length - a.words.length).find((candidate) => candidate.words.every((word, i) => rest[i] === word))
  if (!op) {
    const near = OPERATIONS.filter((candidate) => candidate.words[0] === rest[0] || candidate.words.join(" ").startsWith(rest[0]!.slice(0, 3))).map((candidate) => candidate.words.join(" "))
    return { usage: `'${rest.slice(0, 2).join(" ")}' is not a books command.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} See 'books --help'.` }
  }
  if (asksHelp) return { help: commandHelp(op) }
  const input: OperationInput = {}
  const positional: string[] = []
  let json = false
  const words = rest.slice(op.words.length)
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    if (word === "--json") { json = true; continue }
    if (!word.startsWith("--") || word === "--") { positional.push(word); continue }
    const [name, inline] = word.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    const param = op.params.find((p) => !p.positional && p.name === name)
    if (!param) return { op, usage: `unknown option --${name}. Usage: ${usageOf(op)}` }
    if (param.kind === "flag") { input[param.name] = true; continue }
    const value = inline ?? words[i + 1]
    if (value === undefined) return { op, usage: `--${name} needs a value. Usage: ${usageOf(op)}` }
    if (inline === undefined) i += 1
    if (param.kind === "number" && !Number.isFinite(Number(value))) return { op, usage: `--${name} must be a number, not '${value}'.` }
    input[param.name] = param.kind === "number" ? Number(value) : value
  }
  const slots = op.params.filter((p) => p.positional)
  for (const [index, param] of slots.entries()) {
    if (param.kind === "list") {
      if (positional.length > index) input[param.name] = positional.slice(index)
    } else if (positional[index] !== undefined) {
      if (param.kind === "number" && !/^\d+$/.test(positional[index]!)) return { op, usage: `<${param.name}> must be a whole number, not '${positional[index]}'.` }
      input[param.name] = param.kind === "number" ? Number(positional[index]) : positional[index]
    }
  }
  const extra = slots.some((p) => p.kind === "list") ? 0 : positional.length - slots.length
  if (extra > 0) return { op, usage: `too many arguments: ${positional.slice(slots.length).join(" ")}. Usage: ${usageOf(op)}` }
  const missing = op.params.find((p) => p.required && input[p.name] === undefined)
  if (missing) return { op, usage: `missing <${missing.name}>. Usage: ${usageOf(op)}` }
  return { op, input, json }
}

const shellAnswer = (stdout: string, stderr: string, code: number): ToolAnswer => {
  const parts = [stdout, stderr].filter(Boolean)
  if (code !== 0) parts.push(`[exit status ${code}]`)
  return { text: parts.join("\n"), isError: code !== 0 }
}

export function cliShellArm(core: BooksCore): Arm {
  const commandOf = (args: string): string | null => {
    try {
      const parsed = JSON.parse(args || "{}") as { command?: unknown }
      return typeof parsed.command === "string" ? parsed.command : null
    } catch {
      return null
    }
  }
  const parse = (args: string): { words: string[] } | { answer: ToolAnswer } => {
    const command = commandOf(args)
    if (command === null) return { answer: shellAnswer("", "shell: give the command line to run as {\"command\": \"...\"}", 2) }
    const words = tokenize(command)
    if (!Array.isArray(words)) return { answer: shellAnswer("", `shell: ${words.error}`, 2) }
    if (words.length === 0) return { answer: shellAnswer("", "", 0) }
    if (words[0] !== "books") return { answer: shellAnswer("", `shell: ${words[0]}: command not found (this shell has one program: books; see 'books --help')`, 127) }
    return { words: words.slice(1) }
  }
  return {
    key: "cli-shell",
    tools: [{
      name: "shell",
      description: "Run a command line in the household's shell and return its output and exit status. The shell has one program, `books`; run `books --help` to see its commands.",
      parameters: { type: "object", properties: { command: { type: "string", description: "The command line to run, such as: books --help" } }, required: ["command"] },
    }],
    async call(name, args) {
      emitNervesEvent({ component: "eval", event: "eval.interview_shell_call", message: "running a cli-shell call", meta: { tool: name } })
      if (name !== "shell") return shellAnswer("", `unknown tool ${name}; the only tool is shell`, 2)
      const words = parse(args)
      if ("answer" in words) return words.answer
      const parsed = parseBooks(words.words)
      if ("help" in parsed) return shellAnswer(parsed.help, "", 0)
      if ("usage" in parsed) return shellAnswer("", `books: ${parsed.usage}`, 2)
      const result = await core(argvOf(parsed.op, parsed.input))
      const error = coreError(result)
      if (error !== null) return shellAnswer("", `books ${parsed.op.words.join(" ")}: ${error}`, result.code === 0 ? 1 : result.code)
      const stdout = parsed.json ? JSON.stringify(result.json, null, 2) : humanText(result.json!)
      return shellAnswer(stdout, "", result.code)
    },
    operationOf(name, args) {
      if (name !== "shell") return null
      const words = parse(args)
      if ("answer" in words) return null
      const parsed = parseBooks(words.words)
      return "input" in parsed ? { op: parsed.op, input: parsed.input } : null
    },
  }
}
