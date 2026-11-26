import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { nervesEvents, socket } = vi.hoisted(() => ({
  nervesEvents: [] as Array<Record<string, unknown>>,
  socket: { calls: [] as unknown[][], answer: (): unknown => ({ ok: true, data: { outcome: "done", count: 0, listing: "" } }) },
}))
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => { nervesEvents.push(event) }),
}))
// The doors' default socket client: each call is recorded and answered by socket.answer.
vi.mock("../../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/test-daemon.sock",
  sendDaemonCommand: vi.fn(async (...args: unknown[]) => {
    socket.calls.push(args)
    return socket.answer()
  }),
}))
vi.mock("../../../heart/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../heart/identity")>()),
  getAgentName: () => "slugger",
}))

import { MAILBOX_CLI_WORDS } from "../../../heart/daemon/cli-parse"
import {
  MailboxDoorError,
  getToolSchemas,
  listTools,
  mailboxCliDeclarations,
  mailboxHelp,
  mailboxMcpSchema,
  mailboxMcpSchemas,
  mailboxUsageLines,
  parseMailboxCli,
  readMailboxDoors,
  renderMailboxResult,
  resetMailboxDoorsForTest,
  runMailboxAction,
} from "../../../heart/letters/doors"
import { IN_TURN_WAIT_MAX_S, declaredToolSchema, mailboxToolDefinitions, mailboxToolRefusal } from "../../../heart/letters/doors-tools"

const root = path.resolve(__dirname, "../../../..")
const generated = (file: string) => JSON.parse(fs.readFileSync(path.join(root, "actions/generated", file), "utf8"))
const temps: string[] = []

function fakeRoot(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c21-doors-"))
  temps.push(dir)
  for (const [file, json] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, "actions/generated", path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(dir, "actions/generated", file), typeof json === "string" ? json : JSON.stringify(json))
  }
  return dir
}

beforeEach(() => {
  nervesEvents.length = 0
  socket.calls.length = 0
  socket.answer = () => ({ ok: true, data: { outcome: "done", count: 0, listing: "" } })
  resetMailboxDoorsForTest()
})

async function refusalOf(promise: Promise<unknown>): Promise<MailboxDoorError> {
  const error = await promise.then(() => null, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(MailboxDoorError)
  return error as MailboxDoorError
}

const slugger = { agent: "slugger" }
afterEach(() => {
  resetMailboxDoorsForTest()
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("the mailbox group's generated doors", () => {
  it("reads every door from the generated files, not from a hand copy", () => {
    const doors = readMailboxDoors()
    expect(doors.commands).toEqual(generated("mailbox/commands.json").commands)
    expect(doors.mcpTools).toEqual(generated("mailbox/mcp.json").tools)
    expect(doors.actions).toEqual(generated("mailbox/actions.json").actions)
    expect([...doors.tools.keys()]).toEqual(generated("mailbox-tools/tools.json").tools.map((t: { function: { name: string } }) => t.function.name))
    expect(nervesEvents).toContainEqual(expect.objectContaining({ event: "mailbox.doors_loaded", meta: { commands: 6, mcp: 6, tools: 6 } }))
  })

  it("reads the files once and serves the same doors after", () => {
    const first = readMailboxDoors()
    expect(readMailboxDoors()).toBe(first)
  })

  it("holds the parser's word table (in cli-parse, where the census reads it) to the generated commands", () => {
    const fromGenerated = Object.fromEntries(
      generated("mailbox/commands.json").commands.map((c: { name: string }) => [c.name.replace(/^mailbox /, ""), generated("mailbox/actions.json").actions.find((a: { cli: string }) => a.cli === c.name).id]),
    )
    expect(MAILBOX_CLI_WORDS).toEqual(fromGenerated)
  })

  it("fails loudly when a generated file is missing or has drifted out of shape", () => {
    expect(() => readMailboxDoors(fakeRoot({}))).toThrow(/actions\/generated\/mailbox\/commands\.json/)
    expect(() => readMailboxDoors(fakeRoot({ "mailbox/commands.json": "{", "mailbox/mcp.json": {}, "mailbox-tools/tools.json": {} }))).toThrow(/commands\.json/)
    expect(() => readMailboxDoors(fakeRoot({ "mailbox/commands.json": { commands: [] }, "mailbox/mcp.json": { tools: "x" }, "mailbox-tools/tools.json": { tools: [] } }))).toThrow(/mcp\.json has no tools list/)
    expect(() => readMailboxDoors(fakeRoot({ "mailbox/commands.json": { commands: 1 }, "mailbox/mcp.json": { tools: [] }, "mailbox-tools/tools.json": { tools: [] } }))).toThrow(/commands\.json has no commands list/)
    expect(() => readMailboxDoors(fakeRoot({ "mailbox/commands.json": { commands: [] }, "mailbox/mcp.json": { tools: [] }, "mailbox-tools/tools.json": { tools: [{ type: "function" }] } }))).toThrow(/tools\.json: an entry is not a function tool/)
    expect(() => readMailboxDoors(fakeRoot({ "mailbox/commands.json": { commands: [] }, "mailbox/mcp.json": { tools: [] }, "mailbox-tools/tools.json": { tools: [] }, "mailbox/actions.json": {} }))).toThrow(/actions\.json has no actions list/)
  })

  it("refuses a generated command no generated action names as its cli", () => {
    readMailboxDoors(fakeRoot({
      "mailbox/commands.json": { commands: [{ name: "mailbox stray", summary: "s", effect: "private", output: "o" }] },
      "mailbox/mcp.json": { tools: [] }, "mailbox-tools/tools.json": { tools: [] }, "mailbox/actions.json": { actions: [] },
    }))
    expect(() => mailboxCliDeclarations()).toThrow(/mailbox stray.*no action/)
  })
})

describe("running an action", () => {
  it("sends the daemon's writer a letters.action over the socket and answers its result", async () => {
    const send = vi.fn(async () => ({ ok: true, data: { outcome: "needs-human", id: "ltr_X", code: "L1", state: "waiting", message: "m" } }))
    const input = { kind: "know", subject: "Heads up" }
    const result = await runMailboxAction("mailbox_send", input, { agent: "slugger", dryRun: true, socketPath: "/tmp/s.sock", send })
    expect(result.outcome).toBe("needs-human")
    expect(send).toHaveBeenCalledWith("/tmp/s.sock", { kind: "letters.action", agent: "slugger", action: "mailbox_send", input, dryRun: true }, { timeoutMs: 30_000 })
    expect(nervesEvents).toContainEqual(expect.objectContaining({ event: "mailbox.action_run", meta: { action: "mailbox_send", outcome: "needs-human" } }))
  })

  it("uses the daemon socket by default, and holds it open as long as a wait asks", async () => {
    await runMailboxAction("mailbox_list", {}, slugger)
    await runMailboxAction("mailbox_wait", { letter: "L1", timeout: 100 }, slugger)
    await runMailboxAction("mailbox_wait", { letter: "L1" }, slugger)
    // A deliver waits out the daemon's chat send, which answers within its own deadline.
    await runMailboxAction("mailbox_deliver", { letter: "L1" }, slugger)
    expect(socket.calls.map((call) => [call[0], call[2]])).toEqual([
      ["/tmp/test-daemon.sock", { timeoutMs: 30_000 }],
      ["/tmp/test-daemon.sock", { timeoutMs: 130_000 }],
      ["/tmp/test-daemon.sock", { timeoutMs: 90_000 }],
      ["/tmp/test-daemon.sock", { timeoutMs: 90_000 }],
    ])
  })

  it("refuses an input it doesn't take, naming it", async () => {
    const error = await refusalOf(runMailboxAction("mailbox_list", { to: "friend-x" }, slugger))
    expect(error.code).toBe("unknown-input")
    expect(error.message).toContain("to")
  })

  it("refuses an input that is missing or malformed, naming it, before reaching the daemon", async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["mailbox_read", {}, /^letter is missing: The letter's id/],
      ["mailbox_read", { letter: 7 }, /^letter takes text/],
      ["mailbox_read", { letter: "x".repeat(65) }, /letter is longer than 64 characters/],
      ["mailbox_send", { kind: "maybe", subject: "s" }, /kind is one of decide, do, accept, know, not maybe/],
      ["mailbox_list", { all: "yes" }, /all takes true or false/],
      ["mailbox_wait", { letter: "L1", timeout: 1.5 }, /timeout takes a whole number/],
      ["mailbox_wait", { letter: "L1", timeout: 301 }, /timeout is out of range/],
      ["mailbox_wait", { letter: "L1", cursor: -1 }, /cursor is out of range/],
      ["mailbox_send", { kind: "decide", subject: "s", options: "one" }, /options takes a list/],
      ["mailbox_send", { kind: "decide", subject: "s", options: [{ label: "a", effect: "b" }] }, /options has 1 items/],
      ["mailbox_send", { kind: "decide", subject: "s", options: [{ label: "a", effect: "b" }, "c"] }, /options\[1\] takes an object/],
      ["mailbox_send", { kind: "decide", subject: "s", options: [{ label: "a", effect: "b" }, { label: "c" }] }, /options\[1\]\.effect is missing/],
      ["mailbox_send", { kind: "decide", subject: "s", options: [{ label: "a", effect: "b" }, { label: "c", effect: "d", id: "9" }] }, /options\[1\] has id, which it doesn't take/],
      ["mailbox_send", { kind: "know", subject: "s", links: [{ label: "a", url: 5 }] }, /links\[0\]\.url takes text/],
      ["mailbox_send", { kind: "know", subject: "s", links: [{ label: "a", url: "https://x" }], urgency: "soon" }, /urgency is one of now, today, whenever/],
      ["mailbox_list", { all: true, kind: "letter" }, /kind is one of/],
    ]
    for (const [action, input, message] of cases) {
      const error = await refusalOf(runMailboxAction(action, input, slugger))
      expect([action, error.code]).toEqual([action, "bad-input"])
      expect(error.message).toMatch(message)
    }
    expect(socket.calls).toEqual([])
  })

  it("lets a list with no declared maximum hold any number of items", async () => {
    readMailboxDoors(fakeRoot({
      "mailbox/commands.json": { commands: [] },
      "mailbox/mcp.json": { tools: [{ name: "mailbox_tag", inputSchema: { type: "object", required: [], properties: { tags: { type: "array", description: "d", items: { type: "string", description: "t" } } } } }] },
      "mailbox-tools/tools.json": { tools: [] }, "mailbox/actions.json": { actions: [] },
    }))
    await runMailboxAction("mailbox_tag", { tags: Array.from({ length: 50 }, (_, i) => `t${i}`) }, slugger)
    expect(socket.calls).toHaveLength(1)
  })

  it("refuses an action the group doesn't have, and answers a person-only one with its refusal", async () => {
    expect((await refusalOf(runMailboxAction("mailbox_frobnicate", {}, slugger))).code).toBe("unknown-door")
    expect((await refusalOf(runMailboxAction("constructor", {}, slugger))).code).toBe("unknown-door")
    const personOnly = await refusalOf(runMailboxAction("mailbox_answer", { letter: "L1", option: "2" }, slugger))
    expect(personOnly.code).toBe("person-only")
    expect(personOnly.message).toMatch(/only they can/)
  })

  it("says daemon-down when nothing listens on the socket, and passes any other socket error on", async () => {
    for (const code of ["ENOENT", "ECONNREFUSED", "ENOTSOCK"]) {
      const send = async () => { throw Object.assign(new Error("connect"), { code }) }
      expect((await refusalOf(runMailboxAction("mailbox_list", {}, { agent: "slugger", send }))).code).toBe("daemon-down")
    }
    const timedOut = async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }
    await expect(runMailboxAction("mailbox_list", {}, { agent: "slugger", send: timedOut })).rejects.toThrow("timed out")
    await expect(runMailboxAction("mailbox_list", {}, { agent: "slugger", send: async () => { throw new Error("boom") } })).rejects.toThrow("boom")
  })

  it("carries the writer's refusal code, and fails when the daemon answers nothing usable", async () => {
    socket.answer = () => ({ ok: false, error: "No letter is L9.", data: { code: "not-found", message: "No letter is L9." } })
    const error = await refusalOf(runMailboxAction("mailbox_read", { letter: "L9" }, slugger))
    expect([error.code, error.message]).toEqual(["not-found", "No letter is L9."])
    socket.answer = () => ({ ok: false, error: "disk gone" })
    await expect(runMailboxAction("mailbox_list", {}, slugger)).rejects.toThrow("mailbox_list failed in the daemon: disk gone")
    socket.answer = () => ({ ok: true, message: "test mode: socket call suppressed" })
    await expect(runMailboxAction("mailbox_list", {}, slugger)).rejects.toThrow("failed in the daemon: test mode: socket call suppressed")
    socket.answer = () => ({ ok: true, data: null })
    await expect(runMailboxAction("mailbox_list", {}, slugger)).rejects.toThrow("failed in the daemon: it answered nothing")
  })
})

describe("the CLI's words", () => {
  it("prints each result the way a person reads it", () => {
    expect(renderMailboxResult("mailbox_list", { outcome: "done", count: 0, listing: "" })).toBe("No letters are waiting.")
    expect(renderMailboxResult("mailbox_list", { outcome: "done", count: 1, listing: "L1  waiting  2h  Hi" })).toBe("L1  waiting  2h  Hi")
    const letter = JSON.stringify({ code: "L1", subject: "Hi" })
    expect(renderMailboxResult("mailbox_read", { outcome: "done", state: "waiting", letter, events: "" })).toBe("L1 Hi (waiting)")
    expect(renderMailboxResult("mailbox_read", { outcome: "done", state: "answered", letter, events: "t answered 1" })).toBe("L1 Hi (answered)\nt answered 1")
    expect(renderMailboxResult("mailbox_send", { outcome: "needs-human", message: "Filed L1, Hi." })).toBe("Filed L1, Hi.")
    expect(renderMailboxResult("mailbox_withdraw", { outcome: "done", state: "withdrawn" })).toBe("done: withdrawn")
  })

  it("reads a command's words and flags into the action's input, as commands.json declares them", () => {
    expect(parseMailboxCli("send", [
      "--kind", "decide", "--subject", "Which?", "--why-only-you", "Yours.", "--options", '[{"label":"A","effect":"a"},{"label":"B","effect":"b"}]', "--dry-run", "--json",
    ])).toEqual({
      action: "mailbox_send", json: true, dryRun: true,
      input: { kind: "decide", subject: "Which?", whyOnlyYou: "Yours.", options: [{ label: "A", effect: "a" }, { label: "B", effect: "b" }] },
    })
    expect(parseMailboxCli("list", ["--all", "--mine"])).toEqual({ action: "mailbox_list", input: { all: true, mine: true }, json: false, dryRun: false })
    expect(parseMailboxCli("wait", ["L7", "--timeout", "30", "--cursor", "2"]).input).toEqual({ letter: "L7", timeout: 30, cursor: 2 })
    expect(parseMailboxCli("withdraw", ["L7", "--reason", "moot"]).input).toEqual({ letter: "L7", reason: "moot" })
  })

  it("refuses words it can't read, with the command's usage", () => {
    expect(() => parseMailboxCli("send", ["--kind", "know", "--subject"])).toThrow(/--subject needs a value\.\nUsage: ouro mailbox send --kind/)
    expect(() => parseMailboxCli("wait", ["L7", "--timeout", "soon"])).toThrow(/--timeout takes a number, not soon/)
    expect(() => parseMailboxCli("wait", ["L7", "--cursor", "0x10"])).toThrow(/--cursor takes a number, not 0x10/)
    expect(() => parseMailboxCli("wait", ["L7", "--cursor", ""])).toThrow(/--cursor takes a number, not /)
    expect(() => parseMailboxCli("wait", ["L7", "--timeout", "-5"])).toThrow(/--timeout takes a number, not -5/)
    expect(() => parseMailboxCli("send", ["--kind", "decide", "--subject", "s", "--options", "A, B"])).toThrow(/--options takes a JSON list/)
    expect(() => parseMailboxCli("read", ["L7", "--dry-run"])).toThrow(/ouro mailbox read doesn't take --dry-run/)
    expect(() => parseMailboxCli("read", ["L7", "L8"])).toThrow(/takes only <letter> after it: L7 L8/)
    expect(() => parseMailboxCli("list", ["extra"])).toThrow(/takes no words after it: extra/)
    expect(() => parseMailboxCli("withdraw", [])).toThrow(/needs <letter> and --reason/)
  })

  it("writes one usage line per command, which the flag gate reads its flags from", () => {
    expect(mailboxUsageLines()).toEqual([
      "ouro mailbox send --kind <decide|do|accept|know> --subject <subject> [--why-only-you <why-only-you>] [--body <body>] [--options <options>] [--links <links>] [--dedupe-key <dedupe-key>] [--urgency <now|today|whenever>] [--hold-until <hold-until>] [--expires-at <expires-at>] [--lane <lane>] [--dry-run] [--json]",
      "ouro mailbox list [--all] [--mine] [--kind <decide|do|accept|know>] [--json]",
      "ouro mailbox read <letter> [--json]",
      "ouro mailbox wait <letter> [--cursor <n>] [--timeout <n>] [--json]",
      "ouro mailbox withdraw <letter> --reason <reason> [--dry-run] [--json]",
      "ouro mailbox deliver <letter> [--dry-run] [--json]",
    ])
    expect(mailboxHelp().commands["mailbox send"]!.example).toBe("ouro mailbox send --kind decide --subject example --dry-run --json")
  })

  it("brackets an optional word in the usage line", () => {
    readMailboxDoors(fakeRoot({
      "mailbox/commands.json": { commands: [{ name: "mailbox read", summary: "s", effect: "private", readOnly: true, args: [{ name: "letter", description: "d" }], output: "o" }] },
      "mailbox/mcp.json": { tools: [] }, "mailbox-tools/tools.json": { tools: [] }, "mailbox/actions.json": { actions: [] },
    }))
    expect(mailboxUsageLines()).toEqual(["ouro mailbox read [<letter>] [--json]"])
  })
})

describe("each door's projection", () => {
  it("gives the CLI a declaration with the generated summary and a card in the mailbox group", () => {
    const declarations = mailboxCliDeclarations()
    const list = declarations.find((d) => d.name === "mailbox list")
    const group = declarations.at(-1)
    const command = generated("mailbox/commands.json").commands[1]
    expect(list).toEqual({
      name: "mailbox list", effect: "private", readOnly: true, summary: command.summary, example: "mailbox list --json",
      ax: expect.objectContaining({ id: "cli:mailbox list", group: "mailbox", effect: "read", idempotent: true, when: expect.stringMatching(/^From a shell, pick this to see /) }),
    })
    expect(list!.ax!.errors.map((e) => e.code)).toEqual(["daemon-down", "bad-input", "no-agent", "which-agent", "unknown-flag", "usage"])
    expect(group).toEqual(expect.objectContaining({ name: "mailbox", readOnly: true, ax: expect.objectContaining({ id: "cli:mailbox", group: "mailbox", effect: "read" }) }))
    expect(group!.ax!.errors.map((e) => e.code)).toEqual(["usage", "unknown-flag", "person-only"])
    expect(group!.ax!.errors[2]!.means).toBe("Only the person does what these words do, so they refuse every agent: ouro mailbox answer. The refusal says how the person does it.")
  })

  it("gives each door its own when line, so the census never reads two as one door", () => {
    const whens = [mailboxCliDeclarations()[0]!.ax!.when, mailboxMcpSchemas()[0]!.ax.when, mailboxToolDefinitions()[0]!.ax!.when]
    expect(new Set(whens).size).toBe(3)
    expect(whens[2]).toBe(generated("mailbox-tools/tools.json").tools[0].ax.when)
  })

  it("carries a write action's card and command as generated, with no read-only or idempotent claim", () => {
    const declared = generated("mailbox-tools/tools.json").tools[1]
    const { idempotent: _idempotent, ...writeCard } = declared.ax
    readMailboxDoors(fakeRoot({
      "mailbox/commands.json": { commands: [{ name: "mailbox file", summary: "File a letter.", effect: "others", output: "{ outcome }" }] },
      "mailbox/mcp.json": { tools: [] },
      "mailbox-tools/tools.json": { tools: [{ ...declared, function: { ...declared.function, name: "mailbox_file" }, ax: { ...writeCard, id: "tool:mailbox_file", effect: "write" } }] },
      "mailbox/actions.json": { actions: [{ id: "mailbox_file", cli: "mailbox file" }] },
    }))
    const [file] = mailboxCliDeclarations()
    expect(file).not.toHaveProperty("readOnly")
    expect(file!.ax).not.toHaveProperty("idempotent")
    expect(file!.ax!.effect).toBe("write")
  })

  it("gives the MCP server one generated tool by name, and fails loudly on a name mcp.json lacks", () => {
    expect(mailboxMcpSchema("mailbox_list")).toEqual(mailboxMcpSchemas()[1])
    expect(() => mailboxMcpSchema("mailbox_gone")).toThrow(/mcp\.json has no tool mailbox_gone/)
  })

  it("builds an in-turn schema only from the declared tool it is given", () => {
    const declared = readMailboxDoors().tools.get("mailbox_list")!
    expect(declaredToolSchema("mailbox", "mailbox_list", declared as never)).toEqual({ type: "function", function: { name: "mailbox_list", description: declared.description, parameters: declared.parameters } })
  })

  it("gives the MCP server the generated tool, with its card as an mcp door", () => {
    const schema = mailboxMcpSchemas()[1]
    const tool = generated("mailbox/mcp.json").tools[1]
    expect(schema).toEqual({
      name: "mailbox_list", description: tool.description, inputSchema: tool.inputSchema,
      ax: expect.objectContaining({ id: "mcp:mailbox_list", group: "mailbox", effect: "read", idempotent: true, when: expect.stringMatching(/^From a coding tool, pick this to see /) }),
    })
    expect(schema!.ax.errors.map((e) => e.code)).toEqual(["daemon-down", "unknown-input", "bad-input", "no-agent"])
  })

  it("gives the in-turn registry a definition that runs the action for the agent in the turn", async () => {
    const definition = mailboxToolDefinitions()[1]
    const declared = generated("mailbox-tools/tools.json").tools[1]
    expect(definition!.tool).toEqual({ type: "function", function: declared.function })
    expect(definition!.ax).toEqual({ ...declared.ax, id: "tool:mailbox_list" })
    expect(definition!.riskProfile).toEqual(expect.objectContaining({ mutates: "none" }))
    expect(JSON.parse(await definition!.handler({}))).toEqual({ outcome: "done", count: 0, listing: "" })
    expect(socket.calls[0]![1]).toEqual({ kind: "letters.action", agent: "slugger", action: "mailbox_list", input: {} })
    expect(nervesEvents).toContainEqual(expect.objectContaining({ event: "mailbox.tools_registered", meta: { tools: 6 } }))
  })

  it("answers an in-turn refusal as text with its card's code, and lets a failure throw", async () => {
    const read = mailboxToolDefinitions()[2]!
    expect(await read.handler({ letter: 5 } as never)).toMatch(/^letter takes text.*\(code: bad-input\)$/)
    socket.answer = () => ({ ok: false, error: "disk gone" })
    await expect(read.handler({ letter: "L1" })).rejects.toThrow("disk gone")
  })

  it("answers a model that calls a person-only action by name with its refusal", () => {
    expect(mailboxToolRefusal("mailbox_answer")).toMatch(/^Answer a letter: You can't answer a letter for the person.*\(code: person-only\)$/)
    expect(mailboxToolRefusal("mailbox_list")).toBeNull()
    expect(mailboxToolRefusal("constructor")).toBeNull()
  })

  it("runs an in-turn call for the turn's own agent over its daemon socket", async () => {
    const list = mailboxToolDefinitions()[1]!
    await list.handler({}, { agentName: "butler", daemonSocketPath: "/tmp/turn.sock" } as never)
    expect(socket.calls[0]!.slice(0, 2)).toEqual(["/tmp/turn.sock", { kind: "letters.action", agent: "butler", action: "mailbox_list", input: {} }])
  })

  it("files an in-turn letter with the turn's session, so its answer returns there", async () => {
    const [send, list] = [mailboxToolDefinitions().find((tool) => tool.tool.function.name === "mailbox_send")!, mailboxToolDefinitions()[1]!]
    const currentSession = { friendId: "friend-bo", channel: "teams", key: "thread-1", sessionPath: "/x" }
    await send.handler({ kind: "know", subject: "Heads up" } as never, { agentName: "butler", currentSession } as never)
    await list.handler({}, { agentName: "butler", currentSession } as never)
    expect(socket.calls.map((call) => call[1])).toEqual([
      { kind: "letters.action", agent: "butler", action: "mailbox_send", input: { kind: "know", subject: "Heads up" }, session: { friendId: "friend-bo", channel: "teams", key: "thread-1" } },
      { kind: "letters.action", agent: "butler", action: "mailbox_list", input: {} },
    ])
  })

  it("holds an in-turn wait for a few seconds at most, since turns run one at a time", async () => {
    const wait = mailboxToolDefinitions()[3]!
    expect(wait.tool.function.name).toBe("mailbox_wait")
    await wait.handler({ letter: "L1" })
    await wait.handler({ letter: "L1", timeout: 300 } as never)
    await wait.handler({ letter: "L1", timeout: 2 } as never)
    expect(socket.calls.map((call) => (call[1] as { input: { timeout: number } }).input.timeout)).toEqual([IN_TURN_WAIT_MAX_S, IN_TURN_WAIT_MAX_S, 2])
  })

  it("serves the declared tools for the census as the generated MCP tools list them", () => {
    expect(getToolSchemas()).toEqual(generated("mailbox/mcp.json").tools.map((t: Record<string, unknown>) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })))
    expect(listTools()).toEqual(getToolSchemas())
  })
})
