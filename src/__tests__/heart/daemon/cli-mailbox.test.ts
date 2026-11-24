import { describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { parseOuroCommand, usage } from "../../../heart/daemon/cli-parse"
import { runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import { CLI_COMMANDS } from "../../../heart/daemon/cli-manifest"
import { gateCommandArgs } from "../../../heart/daemon/cli-gate"
import { mailboxCliDeclarations } from "../../../heart/letters/doors"

function deps(): OuroCliDeps & { writeStdout: ReturnType<typeof vi.fn> } {
  return {
    socketPath: "/tmp/c21-test.sock",
    sendCommand: vi.fn().mockResolvedValue({ ok: true, message: "ok" }),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 1 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(false),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("/tmp/pending"),
  } as OuroCliDeps & { writeStdout: ReturnType<typeof vi.fn> }
}

describe("the mailbox group's CLI commands, dispatched from the generated commands", () => {
  it("parses each generated command to the action it runs", () => {
    expect(parseOuroCommand(["mailbox", "list"])).toEqual({ kind: "mailbox.action", action: "mailbox_list" })
    expect(parseOuroCommand(["mailbox", "list", "--json"])).toEqual({ kind: "mailbox.action", action: "mailbox_list", json: true })
    expect(parseOuroCommand(["mailbox", "--agent", "slugger", "list"])).toEqual({ kind: "mailbox.action", action: "mailbox_list" })
  })

  it("refuses the group's own words and unknown ones as usage, naming the commands", () => {
    expect(() => parseOuroCommand(["mailbox"])).toThrow("Usage: ouro mailbox list [--json]")
    expect(() => parseOuroCommand(["mailbox", "send"])).toThrow("Usage: ouro mailbox list [--json]")
    expect(() => parseOuroCommand(["mailbox", "list", "extra"])).toThrow("ouro mailbox list takes no words after it: extra")
  })

  it("lists the generated commands in usage and in the CLI's declarations", () => {
    expect(usage()).toContain("ouro mailbox list [--json]")
    const names = CLI_COMMANDS.map((command) => command.name)
    for (const declaration of mailboxCliDeclarations()) expect(names).toContain(declaration.name)
  })

  it("has help for the group and each generated command, from the generated summary", async () => {
    const { getCommandHelp, getGroupedHelp } = await import("../../../heart/daemon/cli-help")
    const summary = mailboxCliDeclarations()[0]!.summary
    expect(getCommandHelp("mailbox list")).toContain(summary)
    expect(getCommandHelp("mailbox list")).toContain("ouro mailbox list [--json]")
    expect(getCommandHelp("mailbox")).toContain("list")
    expect(getGroupedHelp()).toMatch(/\n {4}mailbox +/)
    const out = deps()
    await expect(runOuroCli(["mailbox", "list", "--help"], out)).resolves.toContain(summary)
  })

  it("gates an unknown flag on mailbox list by the declaration's card", () => {
    expect(gateCommandArgs(["mailbox", "list", "--frob"])).toEqual(expect.objectContaining({ kind: "refuse", code: "unknown-flag" }))
  })

  it("prints the empty pile as text, and as the action's output with --json", async () => {
    const text = deps()
    await expect(runOuroCli(["mailbox", "list"], text)).resolves.toBe("No letters are waiting.")
    expect(text.writeStdout).toHaveBeenCalledWith("No letters are waiting.")
    const json = deps()
    const out = await runOuroCli(["mailbox", "list", "--json"], json)
    expect(JSON.parse(out)).toEqual({ outcome: "done", count: 0, listing: "" })
    expect(json.writeStdout).toHaveBeenCalledWith(out)
  })

  it("prints a pile's listing when letters wait", async () => {
    const doors = await import("../../../heart/letters/doors")
    const spy = vi.spyOn(doors, "runMailboxAction").mockReturnValue({ outcome: "done", count: 1, listing: "L7  Pick a date  slugger" })
    const out = deps()
    await expect(runOuroCli(["mailbox", "list"], out)).resolves.toBe("L7  Pick a date  slugger")
    spy.mockRestore()
  })
})
