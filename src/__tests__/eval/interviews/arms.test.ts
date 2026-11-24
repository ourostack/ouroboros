import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildArm, X_ARMS } from "../../../eval/interviews/guest/arms"
import type { JsonObject } from "../../../heart/approval-store"
import { mcpToolSchema } from "../../../repertoire/mcp-tools"
import { booksCore, coreError, relativize, type BooksCore, type CoreResult } from "../../../eval/interviews/guest/books-core"
import { commandHelp, humanText, overviewHelp, parseBooks, tokenize } from "../../../eval/interviews/guest/cli-shell"
import { argvOf, commandLine, OPERATIONS, shellQuote } from "../../../eval/interviews/guest/operations"
import { brandHits } from "../../../eval/interviews/protocol"

const op = (words: string) => OPERATIONS.find((o) => o.words.join(" ") === words)!

/** A books core that answers each operation as the stub would, and records the argv it ran. */
function fakeCore(): BooksCore & { ran: string[][] } {
  const ran: string[][] = []
  const core = (async (argv: string[]): Promise<CoreResult> => {
    ran.push(argv)
    const words = argv.slice(0, 2).join(" ")
    if (words === "library find") return { code: 0, json: { ok: true, books: [{ id: 187, title: "The Harbour Almanac", authors: ["E. Marsh"], formats: { epub: true } }, { id: 189, title: "The Harbour Almanac" }] }, output: "" }
    if (words === "library remove") return argv[2] === "999" ? { code: 1, json: { ok: false, error: "no book 999 on the shelf" }, output: "" } : { code: 0, json: { ok: true, removed: Number(argv[2]), backup: "removed/187.epub" }, output: "" }
    if (argv[0] === "check") return { code: 1, json: { ok: false, results: [{ file: argv[1], ok: false, problems: [] }] }, output: "" }
    if (argv[0] === "ledger") return { code: 0, json: { ok: true, entries: [] }, output: "" }
    if (argv[0] === "search") return { code: 2, json: { ok: false, error: "bad arguments" }, output: "" }
    return { code: 0, json: { ok: true, argv }, output: "" }
  }) as BooksCore & { ran: string[][] }
  core.ran = ran
  return core
}

describe("the arms' tools as the model sees them", () => {
  it("go out with the arm's own name, description and schema, and nothing added", () => {
    for (const key of X_ARMS) {
      for (const tool of buildArm(key, fakeCore()).tools) {
        expect(tool.description.length).toBeGreaterThan(0)
        expect(mcpToolSchema({ server: tool.name }, { name: tool.name, description: tool.description, inputSchema: tool.parameters as JsonObject })).toEqual({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })
      }
    }
  })
})

describe("the operations", () => {
  it("write an input as the books command's argv and command line, quoting only where needed", () => {
    expect(argvOf(op("library replace"), { id: 187, file: "work/a b.epub", "accept-check-failure": true })).toEqual(["library", "replace", "187", "work/a b.epub", "--accept-check-failure"])
    expect(argvOf(op("get"), { md5: "abc", title: undefined, author: "E. Marsh", "allow-duplicate": false })).toEqual(["get", "--md5", "abc", "--author", "E. Marsh"])
    expect(argvOf(op("deliver"), { files: ["a.epub", "b.epub"], "allow-duplicate": false })).toEqual(["deliver", "a.epub", "b.epub"])
    expect(argvOf(op("search"), {})).toEqual(["search"])
    expect(commandLine(["library", "find", "The Harbour Almanac"])).toBe("books library find 'The Harbour Almanac'")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(OPERATIONS.map((o) => o.words.join(" "))).toEqual(["search", "get", "check", "text", "library find", "library add", "library remove", "library replace", "send", "deliver", "ledger"])
  })
})

describe("the books core", () => {
  it("runs the books command in its folder and makes the paths it prints relative", async () => {
    const seen: Array<{ file: string; args: string[]; cwd: string }> = []
    const core = booksCore({
      home: "/home/u/AgentBundles/sanctuary.ouro/books",
      exec: async (file, args, options) => {
        seen.push({ file, args, cwd: options.cwd })
        return { code: 0, stdout: JSON.stringify({ ok: true, file: "/home/u/AgentBundles/sanctuary.ouro/books/work/1/a.epub", home: "/home/u/AgentBundles/sanctuary.ouro/books" }), stderr: "" }
      },
    })
    const result = await core(["get", "--md5", "x"])
    expect(seen).toEqual([{ file: "/home/u/AgentBundles/sanctuary.ouro/books/books", args: ["get", "--md5", "x"], cwd: "/home/u/AgentBundles/sanctuary.ouro/books" }])
    expect(result).toMatchObject({ code: 0, json: { ok: true, file: "work/1/a.epub", home: "." } })
    expect(brandHits(result.output)).toEqual([])
  })

  it("turns output that is not a JSON object into an error, from stderr when there is one", async () => {
    const answer = (stdout: string, stderr: string, code: number) => booksCore({ home: "/h", command: "/bin/books", exec: async () => ({ code, stdout, stderr }) })([])
    expect(await answer("", "Traceback at /h/books line 3", 1)).toMatchObject({ code: 1, json: { ok: false, error: "Traceback at books line 3" } })
    expect(await answer("[1]", "", 0)).toMatchObject({ code: 1, json: { ok: false, error: "[1]" } })
    expect(await answer("", "", 3)).toMatchObject({ code: 3, json: { ok: false, error: "the books command exited 3 with no answer" } })
    expect(relativize("/h/x and /h", "/h/")).toBe("x and .")
  })

  it("runs the real books stub", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "books-home-"))
    fs.copyFileSync(path.resolve(__dirname, "../../../eval/fakes/books-stub/books"), path.join(home, "books"))
    fs.chmodSync(path.join(home, "books"), 0o755)
    const core = booksCore({ home })
    expect(await core(["ledger"])).toMatchObject({ code: 0, json: { ok: true, entries: [] } })
    const failed = await core(["library", "find", "almanac"])
    expect(coreError(failed)).toBe("cannot read settings at credentials.json: No such file or directory")
    const verdict = await core(["check", "nope.epub"])
    expect(coreError(verdict)).toBeNull()
    expect(verdict.json).toMatchObject({ ok: false, results: [{ file: "nope.epub", ok: false }] })
    fs.rmSync(home, { recursive: true, force: true })
    // Three runs of the Python stub take 3 to 5 s on a loaded Mac, against vitest's 5 s default.
  }, 20_000)
})

describe("the three X arms", () => {
  it("offer every operation, with no brand words in any name, description or schema", () => {
    for (const key of X_ARMS) {
      const arm = buildArm(key, fakeCore())
      expect(arm.key).toBe(key)
      expect(brandHits(JSON.stringify(arm.tools))).toEqual([])
    }
    expect(buildArm("ouro", fakeCore()).tools.map((t) => t.name)).toEqual(["search", "get", "check", "text", "library_find", "library_add", "library_remove", "library_replace", "send", "deliver", "ledger"])
    expect(buildArm("mcp-plain", fakeCore()).tools.map((t) => t.name)).toEqual(["search_books", "download_book", "check_books", "read_book_text", "find_in_library", "add_to_library", "remove_from_library", "replace_in_library", "send_to_reader", "deliver_books", "show_history"])
    expect(buildArm("cli-shell", fakeCore()).tools.map((t) => t.name)).toEqual(["shell"])
    expect(() => buildArm("codex", fakeCore())).toThrow(/no X arm codex/)
  })

  it("run the same operation with the same argv and give the same answer", async () => {
    const calls: Record<string, [string, string]> = {
      "ouro": ["library_remove", JSON.stringify({ id: "187" })],
      "mcp-plain": ["remove_from_library", JSON.stringify({ id: 187 })],
      "cli-shell": ["shell", JSON.stringify({ command: "books library remove 187 --json" })],
    }
    const answers: Record<string, unknown> = {}
    for (const key of X_ARMS) {
      const core = fakeCore()
      const arm = buildArm(key, core)
      const [name, args] = calls[key]!
      const answer = await arm.call(name, args)
      expect(answer.isError).toBe(false)
      expect(core.ran).toEqual([["library", "remove", "187"]])
      answers[key] = JSON.parse(answer.text)
      const ran = arm.operationOf(name, args)!
      expect(commandLine(argvOf(ran.op, ran.input))).toBe("books library remove 187")
    }
    expect(answers["mcp-plain"]).toEqual({ ok: true, removed: 187, backup: "removed/187.epub" })
    expect(answers["cli-shell"]).toEqual(answers["mcp-plain"])
    expect(JSON.stringify(answers.ouro)).toContain("removed/187.epub")
  })

  it("report the core's error as an error in every arm, with its message", async () => {
    const results = await Promise.all([
      buildArm("ouro", fakeCore()).call("library_remove", JSON.stringify({ id: "999" })),
      buildArm("mcp-plain", fakeCore()).call("remove_from_library", JSON.stringify({ id: 999 })),
      buildArm("cli-shell", fakeCore()).call("shell", JSON.stringify({ command: "books library remove 999" })),
    ])
    for (const result of results) {
      expect(result.isError).toBe(true)
      expect(result.text).toContain("no book 999 on the shelf")
    }
    expect(results[2]!.text).toBe("books library remove: no book 999 on the shelf\n[exit status 1]")
    const usage = await buildArm("ouro", fakeCore()).call("search", JSON.stringify({ query: "x" }))
    expect(usage.isError).toBe(true)
    expect((await buildArm("cli-shell", fakeCore()).call("shell", JSON.stringify({ command: "books search x" }))).text).toMatch(/\[exit status 2\]$/)
  })

  it("give a failed check verdict as data, not an error", async () => {
    const plain = await buildArm("mcp-plain", fakeCore()).call("check_books", JSON.stringify({ files: ["work/a.epub"] }))
    expect(plain).toEqual({ isError: false, text: JSON.stringify({ ok: false, results: [{ file: "work/a.epub", ok: false, problems: [] }] }) })
    const shell = await buildArm("cli-shell", fakeCore()).call("shell", JSON.stringify({ command: "books check work/a.epub" }))
    expect(shell.isError).toBe(true)
    expect(shell.text).toBe("results:\n  FILE         OK\n  work/a.epub  false\n    row 1 problems: []\n[exit status 1]")
  })
})

describe("the ouro arm", () => {
  it("checks inputs with the kit's own handler and names no operation for a call it refuses", async () => {
    const arm = buildArm("ouro", fakeCore())
    const wrong = await arm.call("library_remove", JSON.stringify({ idd: "187" }))
    expect(wrong.isError).toBe(true)
    expect(arm.operationOf("library_remove", JSON.stringify({ idd: "187" }))).toBeNull()
    // The kit types a positional id as a string and refuses a number, so the call names no operation.
    expect(arm.operationOf("library_remove", JSON.stringify({ id: 187 }))).toBeNull()
    expect(arm.operationOf("send", JSON.stringify({ files: "work/x.epub", "accept-check-failure": true }))).toBeNull()
    expect(arm.operationOf("library_remove", JSON.stringify({ id: "187" }))).toMatchObject({ input: { id: "187" } })
    expect(arm.operationOf("nope", "{}")).toBeNull()
    expect(arm.operationOf("ledger", "not json")).toBeNull()
    expect((await arm.call("ledger", "not json")).isError).toBe(true)
    expect((await arm.call("ledger", "")).isError).toBe(false)
    const listed = await arm.call("deliver", JSON.stringify({ files: ["a.epub", "b.epub"], "allow-duplicate": true }))
    expect(listed.isError).toBe(false)
    expect(JSON.parse(listed.text)).toMatchObject({ argv: ["deliver", "a.epub", "b.epub", "--allow-duplicate"] })
  })
})

describe("the mcp-plain arm", () => {
  it("checks required and typed arguments, and names no operation for a call it refuses", async () => {
    const arm = buildArm("mcp-plain", fakeCore())
    expect(await arm.call("nope", "{}")).toEqual({ text: "Unknown tool: nope", isError: true })
    expect(await arm.call("show_history", "[")).toEqual({ text: "arguments must be a JSON object", isError: true })
    expect(await arm.call("show_history", "null")).toEqual({ text: "arguments must be a JSON object", isError: true })
    expect(await arm.call("show_history", "[1]")).toEqual({ text: "arguments must be a JSON object", isError: true })
    expect(await arm.call("show_history", "")).toMatchObject({ isError: false })
    expect(await arm.call("remove_from_library", "{}")).toEqual({ text: "missing required argument: id", isError: true })
    expect(await arm.call("remove_from_library", JSON.stringify({ id: "187" }))).toEqual({ text: "argument id must be a number", isError: true })
    expect(await arm.call("deliver_books", JSON.stringify({ files: "a.epub" }))).toEqual({ text: "argument files must be an array of strings", isError: true })
    expect(await arm.call("deliver_books", JSON.stringify({ files: ["a"], allow_duplicate: "yes" }))).toEqual({ text: "argument allow_duplicate must be a boolean", isError: true })
    expect(await arm.call("download_book", JSON.stringify({ md5: 5 }))).toEqual({ text: "argument md5 must be a string", isError: true })
    expect(arm.operationOf("nope", "{}")).toBeNull()
    expect(arm.operationOf("deliver_books", JSON.stringify({ files: ["a"], accept_check_failure: true, author: null }))).toMatchObject({ input: { files: ["a"], "accept-check-failure": true } })
    expect(arm.tools.find((t) => t.name === "remove_from_library")!.parameters).toEqual({ type: "object", properties: { id: { type: "integer", description: "The book's id on the shelf." } }, required: ["id"] })
    expect(arm.tools.find((t) => t.name === "read_book_text")!.parameters).toMatchObject({ properties: { chars: { type: "number" } } })
  })
})

describe("the cli-shell arm", () => {
  it("tokenizes one command line with quoting, and refuses pipes, chaining and substitution", () => {
    expect(tokenize(`books library find "The Harbour \\"Almanac\\"" 'it''s' a\\ b`)).toEqual(["books", "library", "find", "The Harbour \"Almanac\"", "its", "a b"])
    expect(tokenize("  ")).toEqual([])
    expect(tokenize("books ''")).toEqual(["books", ""])
    expect(tokenize("books 'x")).toEqual({ error: "unterminated quote" })
    expect(tokenize("books \"x")).toEqual({ error: "unterminated quote" })
    expect(tokenize("books \"$HOME\"")).toEqual({ error: "substitution is not available in this shell" })
    expect(tokenize("books ledger | cat")).toMatchObject({ error: expect.stringContaining("one books command at a time") })
    expect(tokenize("books \"a\\b\" x\\")).toEqual(["books", "a\\b", "x"])
  })

  it("parses argv into an operation, with help, flags and usage errors", () => {
    expect(parseBooks([])).toEqual({ help: overviewHelp() })
    expect(parseBooks(["help"])).toEqual({ help: overviewHelp() })
    expect(parseBooks(["library", "remove", "--help"])).toEqual({ help: commandHelp(op("library remove")) })
    expect(parseBooks(["-h", "ledger"])).toEqual({ help: commandHelp(op("ledger")) })
    expect(parseBooks(["libary", "find"])).toEqual({ usage: "'libary find' is not a books command. Did you mean: library find, library add, library remove, library replace? See 'books --help'." })
    expect(parseBooks(["zzz"])).toEqual({ usage: "'zzz' is not a books command. See 'books --help'." })
    expect(parseBooks(["get", "--md5=abc", "--title", "T", "--json"])).toMatchObject({ input: { md5: "abc", title: "T" }, json: true })
    expect(parseBooks(["text", "a.epub", "--chars", "200"])).toMatchObject({ input: { file: "a.epub", chars: 200 }, json: false })
    expect(parseBooks(["text", "a.epub", "--chars", "lots"])).toMatchObject({ usage: "--chars must be a number, not 'lots'." })
    expect(parseBooks(["text", "a.epub", "--chars"])).toMatchObject({ usage: expect.stringMatching(/^--chars needs a value/) })
    expect(parseBooks(["ledger", "--force"])).toMatchObject({ usage: expect.stringMatching(/^unknown option --force/) })
    expect(parseBooks(["library", "remove", "x"])).toMatchObject({ usage: "<id> must be a whole number, not 'x'." })
    expect(parseBooks(["library", "remove"])).toMatchObject({ usage: expect.stringMatching(/^missing <id>/) })
    expect(parseBooks(["library", "remove", "1", "2"])).toMatchObject({ usage: expect.stringMatching(/^too many arguments: 2/) })
    expect(parseBooks(["deliver", "a", "--", "b", "--accept-check-failure"])).toMatchObject({ input: { files: ["a", "--", "b"], "accept-check-failure": true } })
    expect(parseBooks(["deliver"])).toMatchObject({ usage: expect.stringMatching(/^missing <files>/) })
  })

  it("writes help and answers to the guidelines", () => {
    expect(overviewHelp()).toContain("Usage: books <command> [arguments] [--json]")
    expect(commandHelp(op("library replace"))).toContain("Usage: books library replace <id> <file> [--accept-check-failure] [--json]")
    expect(commandHelp(op("deliver"))).toContain("books deliver <file>... [--allow-duplicate] [--accept-check-failure] [--json]")
    expect(commandHelp(op("text"))).toContain("[--chars <n>]")
    expect(commandHelp(op("get"))).toContain("Usage: books get [--md5 <value>] [--title <value>] [--author <value>] [--json]")
    expect(commandHelp(op("ledger"))).not.toContain("Arguments:")
    expect(humanText({ ok: true, books: [{ id: 187, title: "A", authors: ["E"], extra: null }, { id: 2, note: "x" }], tags: ["a", { b: 1 }], empty: [], nested: { a: 1 } })).toBe([
      "books:",
      "  ID   TITLE  EXTRA  NOTE",
      "  187  A",
      "  2                  x",
      "    row 1 authors: [\"E\"]",
      "tags: a, {\"b\":1}",
      "empty: none",
      "nested:",
      "  a: 1",
    ].join("\n"))
  })

  it("runs only books, one command per call", async () => {
    const core = fakeCore()
    const arm = buildArm("cli-shell", core)
    expect(await arm.call("bash", "{}")).toEqual({ text: "unknown tool bash; the only tool is shell\n[exit status 2]", isError: true })
    expect(await arm.call("shell", "{}")).toMatchObject({ isError: true, text: expect.stringContaining("give the command line") })
    expect(await arm.call("shell", "")).toMatchObject({ isError: true, text: expect.stringContaining("give the command line") })
    const zero = buildArm("cli-shell", async () => ({ code: 0, json: { ok: false, error: "odd" }, output: "" }))
    expect(await zero.call("shell", JSON.stringify({ command: "books ledger" }))).toEqual({ text: "books ledger: odd\n[exit status 1]", isError: true })
    expect(await arm.call("shell", "nope")).toMatchObject({ isError: true })
    expect(await arm.call("shell", JSON.stringify({ command: "ls -la" }))).toEqual({ text: "shell: ls: command not found (this shell has one program: books; see 'books --help')\n[exit status 127]", isError: true })
    expect(await arm.call("shell", JSON.stringify({ command: "books ledger; ls" }))).toMatchObject({ isError: true, text: expect.stringContaining("[exit status 2]") })
    expect(await arm.call("shell", JSON.stringify({ command: "" }))).toEqual({ text: "", isError: false })
    expect(await arm.call("shell", JSON.stringify({ command: "books --help" }))).toEqual({ text: overviewHelp(), isError: false })
    expect(await arm.call("shell", JSON.stringify({ command: "books library remove" }))).toMatchObject({ isError: true, text: expect.stringMatching(/^books: missing <id>/) })
    expect(await arm.call("shell", JSON.stringify({ command: "books library find almanac" }))).toMatchObject({ isError: false, text: expect.stringContaining("187  The Harbour Almanac") })
    expect(core.ran).toEqual([["library", "find", "almanac"]])
    expect(arm.operationOf("bash", "{}")).toBeNull()
    expect(arm.operationOf("shell", JSON.stringify({ command: "ls" }))).toBeNull()
    expect(arm.operationOf("shell", JSON.stringify({ command: "books --help" }))).toBeNull()
    expect(arm.operationOf("shell", JSON.stringify({ command: "books ledger" }))).toMatchObject({ op: op("ledger") })
  })
})
