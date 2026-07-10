import { describe, expect, it, vi } from "vitest"

import {
  COMMAND_REGISTRY,
  getCommandHelp,
  getGroupedHelp,
} from "../../../heart/daemon/cli-help"
import { usage } from "../../../heart/daemon/cli-parse"
import { runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

function createMockDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockRejectedValue(new Error("daemon should not be called")),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 12345 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    ...overrides,
  }
}

describe("ouro rsvp CLI help", () => {
  it("registers the RSVP umbrella in top-level help", () => {
    expect(COMMAND_REGISTRY).toHaveProperty("rsvp")
    expect(COMMAND_REGISTRY["rsvp"]).toMatchObject({
      category: "Habits",
      usage: "ouro rsvp <doctor|incident|cutover|legacy-render|replay|config|habit|import-legacy|refresh|compare|smoke> ...",
      subcommands: [
        "doctor",
        "incident",
        "cutover",
        "legacy-render",
        "replay",
        "config import-legacy",
        "habit stage",
        "import-legacy",
        "refresh",
        "compare",
        "smoke",
      ],
    })

    const grouped = getGroupedHelp()
    expect(grouped).toContain("rsvp")
    expect(grouped).toContain("AislePlanner-backed RSVP habit")
  })

  it("includes RSVP usage in parser usage output", () => {
    expect(usage()).toContain("ouro rsvp <doctor|incident|cutover|legacy-render|replay|config|habit|import-legacy|refresh|compare|smoke>")
  })

  it("returns focused help for every RSVP subcommand", () => {
    const commands = [
      "rsvp",
      "rsvp doctor",
      "rsvp incident",
      "rsvp cutover",
      "rsvp legacy-render",
      "rsvp replay",
      "rsvp config import-legacy",
      "rsvp habit stage",
      "rsvp import-legacy",
      "rsvp refresh",
      "rsvp compare",
      "rsvp smoke",
    ]

    for (const command of commands) {
      const help = getCommandHelp(command)
      expect(help, command).not.toBeNull()
      expect(help, command).toContain(`Usage: ouro ${command}`)
    }
  })

  it("documents explicit safety flags for commands that can mutate or send", () => {
    expect(getCommandHelp("rsvp config import-legacy")).toContain("--yes")
    expect(getCommandHelp("rsvp import-legacy")).toContain("--yes")
    expect(getCommandHelp("rsvp refresh")).toContain("--no-send")
    expect(getCommandHelp("rsvp refresh")).toContain("--allow-send")
    expect(getCommandHelp("rsvp smoke")).toContain("--allow-send")
    expect(getCommandHelp("rsvp smoke")).toContain("preflight|live")
  })

  it("documents the RSVP operator triage workflow in command help", () => {
    const umbrella = getCommandHelp("rsvp") ?? ""
    expect(umbrella).toContain("doctor")
    expect(umbrella).toContain("incident")
    expect(umbrella).toContain("replay")
    expect(umbrella).toContain("receipts")
    expect(umbrella).toContain("ledgers")

    expect(getCommandHelp("rsvp doctor")).toContain("--json --strict")
    expect(getCommandHelp("rsvp incident")).toContain("--output")
    expect(getCommandHelp("rsvp replay")).toContain("offline fixture")
    expect(getCommandHelp("rsvp refresh")).toContain("receipts")
    expect(getCommandHelp("rsvp smoke")).toContain("preflight")
  })

  it("routes `rsvp --help` and `help rsvp smoke` through the help registry without daemon access", async () => {
    const deps = createMockDeps()

    const umbrella = await runOuroCli(["rsvp", "--help"], deps)
    expect(umbrella).toContain("rsvp -")
    expect(umbrella).toContain("config import-legacy")

    const smoke = await runOuroCli(["help", "rsvp", "smoke"], deps)
    expect(smoke).toContain("rsvp smoke")
    expect(smoke).toContain("--allow-send")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })
})
