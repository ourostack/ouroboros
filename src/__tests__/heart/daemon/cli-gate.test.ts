import { describe, expect, it } from "vitest"
import { commandHelp, errorText, fitWidth, gateCommandArgs, ownUsageLines } from "../../../heart/daemon/cli-gate"
import type { CliCommandDeclaration } from "../../../heart/daemon/cli-manifest"

describe("the flag gate in front of the ouro CLI", () => {
  it("lets a command line the gate does not know pass to the dispatcher, unchanged", () => {
    expect(gateCommandArgs([])).toEqual({ kind: "pass", args: [] })
    expect(gateCommandArgs(["no-such-command", "--anything"])).toEqual({ kind: "pass", args: ["no-such-command", "--anything"] })
  })

  it("refuses an unknown flag, naming the nearest real one", () => {
    const result = gateCommandArgs(["check", "--lan", "inner"])
    expect(result.kind === "refuse" && result.message).toContain('Unknown flag --lan for "ouro check". Fix: use --lane.')
    expect(result).toMatchObject({ code: "unknown-flag" })
  })

  it("refuses an unknown flag with no near match, pointing at help", () => {
    const result = gateCommandArgs(["check", "--zzzzzzzzzz"])
    expect(result.kind === "refuse" && result.message).toContain("drop --zzzzzzzzzz; `ouro check --help` lists its flags")
  })

  it("suggests the nearest of several real flags", () => {
    const result = gateCommandArgs(["check", "--hom", "x"])
    expect(result.kind === "refuse" && result.message).toContain("Fix: use --home.")
  })

  it("passes flags the usage lists, including those on a second usage line", () => {
    expect(gateCommandArgs(["check", "--lane", "inner"])).toMatchObject({ kind: "pass" })
    expect(
      gateCommandArgs(["auth", "--agent", "inbox-agent", "--provider", "anthropic", "--api-key-file", "key.txt"]),
    ).toMatchObject({ kind: "pass" })
  })

  it("passes a command with two words, preferring the longer name", () => {
    expect(gateCommandArgs(["auth", "verify", "--provider", "anthropic"])).toMatchObject({ kind: "pass" })
  })

  it("passes a flag the parser reads even when no usage line lists it for that command", () => {
    expect(gateCommandArgs(["hatch", "--human", "--answers", "answers.json"])).toMatchObject({ kind: "pass" })
  })

  it("requires --why on a command other people see, and removes it before the dispatcher reads the words", () => {
    expect(gateCommandArgs(["msg", "--to", "inbox-agent", "hello"])).toMatchObject({ kind: "refuse", code: "needs-why" })
    const result = gateCommandArgs(["msg", "--to", "inbox-agent", "hello", "--why", "they asked"])
    expect(result).toEqual({ kind: "pass", args: ["msg", "--to", "inbox-agent", "hello"] })
  })

  it("finds the command by its words when a flag comes before them, so --why can't be skipped by moving --agent first", () => {
    expect(gateCommandArgs(["a2a", "--agent", "slugger", "message", "--to", "peer", "--text", "hi"])).toMatchObject({ kind: "refuse", code: "needs-why" })
    expect(gateCommandArgs(["--agent", "slugger", "msg", "--to", "inbox-agent", "hello"])).toMatchObject({ kind: "refuse", code: "needs-why" })
    const result = gateCommandArgs(["a2a", "--agent", "slugger", "message", "--to", "peer", "--text", "hi", "--why", "they asked"])
    expect(result).toEqual({ kind: "pass", args: ["a2a", "--agent", "slugger", "message", "--to", "peer", "--text", "hi"] })
    expect(gateCommandArgs(["check", "--agent", "slugger", "--lan", "inner"])).toMatchObject({ kind: "refuse", code: "unknown-flag" })
  })

  it("previews a command other people see with --dry-run, and says nothing was sent", () => {
    const result = gateCommandArgs(["msg", "--to", "inbox-agent", "hello", "--why", "they asked", "--dry-run"])
    expect(result.kind).toBe("preview")
    expect(result.kind === "preview" && result.text).toContain("Other people will see this")
  })

  it("previews the same as an outcome document under --json", () => {
    const result = gateCommandArgs(["msg", "--to", "inbox-agent", "hello", "--why", "they asked", "--dry-run", "--json"])
    expect(result.kind === "preview" && JSON.parse(result.text)).toMatchObject({ state: "preview", command: "msg", dryRun: true })
  })

  it("prints a command other people see its help, with --dry-run", () => {
    const result = gateCommandArgs(["dns", "apply", "--help"])
    expect(result.kind).toBe("help")
    expect(result.kind === "help" && result.text).toContain("--dry-run")
  })

  it("answers a command the person sees its own help, never the whole CLI's usage", () => {
    const result = gateCommandArgs(["check", "--help"])
    expect(result.kind).toBe("help")
    const text = result.kind === "help" ? result.text : ""
    expect(text).toContain("When: Make one live call on the outward or inner lane")
    expect(text).toContain("Errors:")
    expect(text).not.toContain("--dry-run")
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(6000)
    for (const line of text.split("\n")) expect([...line].length).toBeLessThanOrEqual(100)
  })

  it("skips the value of a flag that takes one when it counts words", () => {
    expect(gateCommandArgs(["dns", "apply", "--binding", "dns.json", "--why", "they asked"])).toMatchObject({ kind: "pass" })
  })

  it("refuses extra words after a command other people see whose usage takes none", () => {
    const result = gateCommandArgs(["a2a", "serve", "serve", "--why", "they asked"])
    expect(result.kind === "refuse" && result.message).toContain("takes no words after its command")
    expect(result).toMatchObject({ code: "extra-words" })
  })
})

describe("one command's help and one-line errors, on the Ouro AX kit's width", () => {
  const widest = (text: string) => Math.max(...text.split("\n").map((line) => [...line].length))

  it("keeps a short line as it is and wraps a long one under its own indent", () => {
    expect(fitWidth("short\n  also short")).toBe("short\n  also short")
    const long = `    ${"word ".repeat(40).trim()}`
    const fitted = fitWidth(long)
    expect(widest(fitted)).toBeLessThanOrEqual(100)
    expect(fitted.split("\n").length).toBeGreaterThan(1)
    expect(fitted.split("\n")[1]).toMatch(/^ {6}word/)
  })

  it("builds help from the declaration when a command has no page of its own", () => {
    const bare: CliCommandDeclaration = { name: "zz-none", effect: "private", readOnly: true, summary: "A test command." }
    expect(commandHelp(bare)).toBe("ouro zz-none - A test command.\n\nUsage:\n  ouro zz-none")
    const carded = { ...bare, ax: { id: "cli:zz-none", group: "mind", effect: "read", when: "Pick this in a test.", errors: [] } } as CliCommandDeclaration
    const text = commandHelp(carded)
    expect(text).toContain("When: Pick this in a test.")
    expect(text).not.toContain("Errors:")
    const others = { ...bare, effect: "others" } as CliCommandDeclaration
    expect(commandHelp(others)).toContain("--dry-run")
  })

  it("turns the parser's whole-CLI usage into the usage of the command the words name", () => {
    const text = errorText(["check", "--lane"], "Usage\n  ouro check ...\n  ouro up")
    expect(text).toMatch(/^ouro check: these arguments don't fit its usage: ouro check/)
    expect(text).toContain("Fix: run ouro check --help")
    expect(text).not.toContain("\n")
  })

  it("points at the overview when the words name no command with usage", () => {
    const fallback = "ouro: these arguments don't fit any command's usage. Fix: run ouro --help for the commands."
    expect(errorText(["zz-none"], "Usage\nwhatever")).toBe(fallback)
    expect(errorText([], "Usage\nwhatever")).toBe(fallback)
  })

  it("folds any other message onto one line and puts the code on the end", () => {
    expect(errorText(["up"], "first part\n  second part")).toBe("first part second part")
    expect(errorText(["up"], "daemon unavailable", "daemon-down")).toBe("daemon unavailable (code: daemon-down)")
  })
})

describe("a command's own usage, and a group's answer to --json", () => {
  it("gives a command its usage lines, less the lines of the commands declared under it", () => {
    expect(ownUsageLines("check")).toEqual(["ouro check [--agent <name>] --lane outward|inner"])
    expect(ownUsageLines("logs")).not.toContainEqual(expect.stringContaining("logs prune"))
    expect(ownUsageLines("vault")).toEqual([])
  })

  it("answers a group that runs nothing itself with its commands as data", () => {
    const result = gateCommandArgs(["vault", "--json"])
    expect(result.kind).toBe("help")
    const doc = JSON.parse(result.kind === "help" ? result.text : "{}")
    expect(doc).toMatchObject({ tool: "ouro", group: "vault" })
    expect(doc.commands.map((command: { name: string }) => command.name)).toContain("vault status")
    expect(doc.commands.find((command: { name: string }) => command.name === "vault status").usage[0]).toMatch(/^ouro vault status \[--agent <name>\]/)
    expect(gateCommandArgs(["check", "--json"])).toMatchObject({ kind: "pass" })
  })
})

describe("usage lines narrowed to one command", () => {
  it("narrows a line several commands share to the one named, and drops a trailing note", () => {
    expect(ownUsageLines("status")).toEqual(["ouro status", "ouro status --agent <name>"])
    expect(ownUsageLines("task list")).toEqual(["ouro task list [<ouro desk task arguments>]"])
  })

  it("answers a group's mistake by pointing at the group's help, not every member's usage", () => {
    const text = errorText(["habit", "bogus"], "Usage\nwhatever")
    expect(text).toBe("ouro habit: these arguments don't fit any of its commands. Fix: run ouro habit --help for its commands and what each takes.")
  })

  it("answers -h like --help, with the command's own help", () => {
    const result = gateCommandArgs(["check", "-h"])
    expect(result.kind === "help" && result.text).toContain("When: Make one live call")
  })
})
