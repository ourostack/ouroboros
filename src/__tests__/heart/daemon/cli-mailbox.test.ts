import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { socket } = vi.hoisted(() => ({
  socket: { calls: [] as unknown[][], answer: (): unknown => ({ ok: true, data: { outcome: "done", count: 0, listing: "" } }) },
}))

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))
// The daemon's socket, as the mailbox doors reach it: each call is recorded and answered by socket.answer.
vi.mock("../../../heart/daemon/socket-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../heart/daemon/socket-client")>()),
  sendDaemonCommand: vi.fn(async (...args: unknown[]) => {
    socket.calls.push(args)
    const answer = socket.answer()
    if (answer instanceof Error) throw answer
    return answer
  }),
}))

import { parseOuroCommand, usage } from "../../../heart/daemon/cli-parse"
import { runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import { CLI_COMMANDS } from "../../../heart/daemon/cli-manifest"
import { gateCommandArgs } from "../../../heart/daemon/cli-gate"
import { mailboxCliDeclarations, mailboxMcpSchemas, mailboxUsageLines } from "../../../heart/letters/doors"
import { mailboxToolDefinitions } from "../../../heart/letters/doors-tools"
import { readAnsweringHandles } from "../../../heart/letters/answering"

function deps(extra: Partial<OuroCliDeps> = {}): OuroCliDeps & { writeStdout: ReturnType<typeof vi.fn> } {
  return {
    socketPath: "/tmp/c21-test.sock",
    sendCommand: vi.fn().mockResolvedValue({ ok: true, message: "ok" }),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 1 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(false),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("/tmp/pending"),
    ...extra,
  } as OuroCliDeps & { writeStdout: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  socket.calls.length = 0
  socket.answer = () => ({ ok: true, data: { outcome: "done", count: 0, listing: "" } })
})

describe("the mailbox group's CLI commands, dispatched from the generated commands", () => {
  it("parses each generated command to the action it runs, with its input", () => {
    expect(parseOuroCommand(["mailbox", "list"])).toEqual({ kind: "mailbox.action", action: "mailbox_list", input: {} })
    expect(parseOuroCommand(["mailbox", "list", "--json"])).toEqual({ kind: "mailbox.action", action: "mailbox_list", input: {}, json: true })
    expect(parseOuroCommand(["mailbox", "--agent", "slugger", "list"])).toEqual({ kind: "mailbox.action", action: "mailbox_list", input: {}, agent: "slugger" })
    expect(parseOuroCommand(["mailbox", "send", "--kind", "know", "--subject", "Green", "--dry-run"])).toEqual({
      kind: "mailbox.action", action: "mailbox_send", input: { kind: "know", subject: "Green" }, dryRun: true,
    })
    expect(parseOuroCommand(["mailbox", "wait", "L7", "--timeout", "5"])).toEqual({ kind: "mailbox.action", action: "mailbox_wait", input: { letter: "L7", timeout: 5 } })
  })

  it("refuses the group's own words and unknown ones as usage, naming the commands", () => {
    expect(() => parseOuroCommand(["mailbox"])).toThrow("Usage: ouro mailbox send|list|read|wait|withdraw|deliver|handle set [--json]")
    expect(() => parseOuroCommand(["mailbox", "frob"])).toThrow("Usage: ouro mailbox send|list|read|wait|withdraw|deliver|handle set [--json]")
    expect(() => parseOuroCommand(["mailbox", "list", "extra"])).toThrow("ouro mailbox list takes no words after it: extra")
  })

  it("refuses a person-only word with its generated refusal", () => {
    expect(() => parseOuroCommand(["mailbox", "answer", "L7", "2"])).toThrow(expect.objectContaining({ code: "person-only", message: expect.stringMatching(/only they can/) }))
  })

  it("lists the generated commands in usage and in the CLI's declarations", () => {
    for (const line of mailboxUsageLines()) expect(usage()).toContain(`  ${line}`)
    const names = CLI_COMMANDS.map((command) => command.name)
    for (const declaration of mailboxCliDeclarations()) expect(names).toContain(declaration.name)
  })

  it("has help for the group and each generated command, from the generated summary", async () => {
    const { getCommandHelp, getGroupedHelp } = await import("../../../heart/daemon/cli-help")
    const summary = mailboxCliDeclarations().find((d) => d.name === "mailbox list")!.summary
    expect(getCommandHelp("mailbox list")).toContain(summary)
    expect(getCommandHelp("mailbox list")).toContain("ouro mailbox list [--all] [--mine]")
    expect(getCommandHelp("mailbox")).toContain("send")
    expect(getGroupedHelp()).toMatch(/\n {4}mailbox +/)
    await expect(runOuroCli(["mailbox", "list", "--help"], deps())).resolves.toContain(summary)
  })

  it("gates flags by the usage line each generated command has", () => {
    expect(gateCommandArgs(["mailbox", "list", "--frob"])).toEqual(expect.objectContaining({ kind: "refuse", code: "unknown-flag" }))
    expect(gateCommandArgs(["mailbox", "send", "--kind", "know", "--subject", "s", "--why-only-you", "w"])).toEqual(expect.objectContaining({ kind: "pass" }))
    expect(gateCommandArgs(["mailbox", "read", "L7", "--json"])).toEqual(expect.objectContaining({ kind: "pass" }))
  })

  it("asks the daemon for the agent named, and prints the result as text or as JSON", async () => {
    const text = deps()
    await expect(runOuroCli(["mailbox", "list", "--agent", "slugger"], text)).resolves.toBe("No letters are waiting.")
    expect(text.writeStdout).toHaveBeenCalledWith("No letters are waiting.")
    expect(socket.calls[0]!.slice(0, 2)).toEqual(["/tmp/c21-test.sock", { kind: "letters.action", agent: "slugger", action: "mailbox_list", input: {} }])
    const json = deps()
    const out = await runOuroCli(["mailbox", "list", "--agent", "slugger", "--json"], json)
    expect(JSON.parse(out)).toEqual({ outcome: "done", count: 0, listing: "" })
    expect(json.writeStdout).toHaveBeenCalledWith(out)
  })

  it("passes a dry run on, and finds the agent from where it runs when none is named", async () => {
    socket.answer = () => ({ ok: true, data: { outcome: "preview", id: "", code: "", state: "waiting", message: "Would file a new letter to friend-ari." } })
    const out = deps({ whoamiInfo: () => ({ agentName: "slugger" }) as never })
    await expect(runOuroCli(["mailbox", "send", "--kind", "know", "--subject", "Green", "--dry-run"], out)).resolves.toBe("Would file a new letter to friend-ari.")
    expect(socket.calls[0]![1]).toEqual({ kind: "letters.action", agent: "slugger", action: "mailbox_send", input: { kind: "know", subject: "Green" }, dryRun: true })
  })

  it("fails with the refusal's code, which the CLI prints as its last line", async () => {
    socket.answer = () => Object.assign(new Error("connect ENOENT"), { code: "ENOENT" })
    await expect(runOuroCli(["mailbox", "list", "--agent", "slugger"], deps())).rejects.toEqual(expect.objectContaining({ code: "daemon-down" }))
    socket.answer = () => ({ ok: false, error: "No letter is L9.", data: { code: "not-found", message: "No letter is L9." } })
    await expect(runOuroCli(["mailbox", "read", "L9", "--agent", "slugger"], deps())).rejects.toEqual(expect.objectContaining({ code: "not-found", message: "No letter is L9." }))
    socket.answer = () => ({ ok: false, error: "disk gone" })
    await expect(runOuroCli(["mailbox", "list", "--agent", "slugger"], deps())).rejects.toThrow("disk gone")
    socket.answer = () => ({ ok: false, error: "Odd.", data: { code: "odd", message: "Odd." } })
    const odd = await runOuroCli(["mailbox", "list", "--agent", "slugger"], deps()).catch((error: unknown) => error)
    expect(odd).toEqual(expect.objectContaining({ message: "Odd." }))
    expect((odd as { code?: string }).code).toBeUndefined()
  })

  it("passes the daemon's no-agent refusal through with its code", async () => {
    socket.answer = () => ({ ok: false, error: "No agent bundle slugr.ouro is on this machine.", data: { code: "no-agent", message: "No agent bundle slugr.ouro is on this machine." } })
    await expect(runOuroCli(["mailbox", "list", "--agent", "slugr"], deps())).rejects.toEqual(expect.objectContaining({ code: "no-agent", message: "No agent bundle slugr.ouro is on this machine." }))
  })

  it("fails with a code for each refusal the commands' cards give, and only those", async () => {
    const { MAILBOX_CLI_REFUSAL_CODES } = await import("../../../heart/daemon/cli-exec")
    // which-agent, unknown-input, unknown-flag and usage are raised before the action runs; no-agent is raised both
    // before (no bundles at all) and by the daemon (an --agent it has no bundle for).
    const before = new Set(["which-agent", "unknown-input", "unknown-flag", "usage"])
    const carded = new Set(mailboxCliDeclarations().filter((d) => d.name !== "mailbox").flatMap((d) => d.ax!.errors.map((e) => e.code)).filter((code) => !before.has(code)))
    expect([...MAILBOX_CLI_REFUSAL_CODES].sort()).toEqual([...carded].sort())
  })
})

describe("ouro mailbox handle set", () => {
  it("parses the person and handle, and refuses anything else as usage", () => {
    expect(parseOuroCommand(["mailbox", "handle", "set", "friend-ari", "+15551234567"])).toEqual({ kind: "mailbox.handle.set", person: "friend-ari", handle: "+15551234567" })
    expect(parseOuroCommand(["mailbox", "--agent", "slugger", "handle", "set", "Ari", "ari@example.com"])).toEqual({ kind: "mailbox.handle.set", person: "Ari", handle: "ari@example.com", agent: "slugger" })
    for (const words of [["handle"], ["handle", "get", "a", "b"], ["handle", "set", "a"], ["handle", "set", "a", "b", "c"]]) {
      expect(() => parseOuroCommand(["mailbox", ...words])).toThrow("Usage: ouro mailbox handle set <person> <handle> [--agent <agent>]")
    }
  })

  it("writes the handle into the agent's answering file and says what it did", async () => {
    const bundles = fs.mkdtempSync(path.join(os.tmpdir(), "c21-handle-"))
    try {
      const friends = path.join(bundles, "slugger.ouro", "friends")
      fs.mkdirSync(friends, { recursive: true })
      fs.writeFileSync(path.join(friends, "friend-ari.json"), JSON.stringify({
        id: "friend-ari", name: "Ari", trustLevel: "family", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1,
      }))
      const out = deps({ bundlesRoot: bundles })
      await expect(runOuroCli(["mailbox", "handle", "set", "ari", "+1 (555) 123-4567", "--agent", "slugger"], out)).resolves.toMatch(/^Ari \(friend-ari\) answers letters from \+15551234567\./)
      expect(readAnsweringHandles(path.join(bundles, "slugger.ouro", "state", "letters"))).toEqual({ "friend-ari": "+15551234567" })
      await expect(runOuroCli(["mailbox", "handle", "set", "ari", "5551234567", "--agent", "slugger"], out)).rejects.toEqual(expect.objectContaining({ code: "bad-handle" }))
    } finally {
      fs.rmSync(bundles, { recursive: true, force: true })
    }
  })

  it("has a CLI door only: no MCP tool and no in-turn tool", () => {
    const card = CLI_COMMANDS.find((command) => command.name === "mailbox handle set")
    expect(card!.ax!.errors.map((error) => error.code)).toEqual(["usage", "bad-handle", "no-person", "which-person", "unknown-flag", "no-agent", "which-agent"])
    expect(mailboxMcpSchemas().map((tool) => tool.name)).not.toContain("mailbox_handle_set")
    expect(mailboxToolDefinitions().map((tool) => tool.tool.function.name).filter((name) => name.includes("handle"))).toEqual([])
  })
})
