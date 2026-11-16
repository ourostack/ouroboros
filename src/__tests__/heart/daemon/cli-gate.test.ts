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
  })

  it("refuses an unknown flag with no near match, pointing at help", () => {
    const result = gateCommandArgs(["check", "--zzzzzzzzzz"])
    expect(result.kind === "refuse" && result.message).toContain("drop --zzzzzzzzzz; `ouro check --help` lists its flags")
  })

  it("passes flags the usage lists, including those on a second usage line", () => {
    expect(gateCommandArgs(["check", "--lane", "inner"])).toMatchObject({ kind: "pass" })
    expect(
      gateCommandArgs(["auth", "--agent", "inbox-agent", "--provider", "anthropic", "--api-key-file", "key.txt"]),
    ).toMatchObject({ kind: "pass" })
  })

  it("passes a flag the parser reads even when no usage line lists it for that command", () => {
    expect(gateCommandArgs(["hatch", "--human", "--answers", "answers.json"])).toMatchObject({ kind: "pass" })
  })

  it("requires --why on a command other people see, and removes it before the dispatcher reads the words", () => {
    expect(gateCommandArgs(["msg", "--to", "inbox-agent", "hello"])).toMatchObject({ kind: "refuse" })
    const result = gateCommandArgs(["msg", "--to", "inbox-agent", "hello", "--why", "they asked"])
    expect(result).toEqual({ kind: "pass", args: ["msg", "--to", "inbox-agent", "hello"] })
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

  it("skips the value of a flag that takes one when it counts words", () => {
    expect(gateCommandArgs(["dns", "apply", "--binding", "dns.json", "--why", "they asked"])).toMatchObject({ kind: "pass" })
  })

  it("refuses extra words after a command other people see whose usage takes none", () => {
    const result = gateCommandArgs(["a2a", "serve", "serve", "--why", "they asked"])
    expect(result.kind === "refuse" && result.message).toContain("takes no words after its command")
  })
})
