import { describe, expect, it } from "vitest"
import { gateCommandArgs } from "../../../heart/daemon/cli-gate"

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

  it("passes a command the person sees its help unchanged", () => {
    expect(gateCommandArgs(["check", "--help"])).toMatchObject({ kind: "pass" })
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
