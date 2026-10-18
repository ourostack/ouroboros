import { describe, expect, it } from "vitest"
import { shepherdInspectionCommand, shepherdRetirementCommand } from "../../../heart/shepherd/operation-commands"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"

const argv = (command: string) => command.match(/'[^']*'|\S+/g)!.slice(1).map(part => part.replace(/^'|'$/g, ""))
describe("dashboard local command contract", () => {
  it("round-trips exact readonly and retirement commands through the real CLI parser", () => {
    const id = "a".repeat(64)
    expect(parseOuroCommand(argv(shepherdInspectionCommand("ouro")!))).toEqual({ kind: "shepherd.status", agent: "ouro", json: true })
    expect(parseOuroCommand(argv(shepherdInspectionCommand("ouro", id)!))).toEqual({ kind: "shepherd.inspect", agent: "ouro", id, json: true, limit: 50 })
    expect(parseOuroCommand(argv(shepherdRetirementCommand("ouro", id, 3)!))).toMatchObject({
      kind: "shepherd.reconcile", agent: "ouro", id, expectedRevision: 3, resolution: "retired",
      requestId: `supervision-retire-${id}-r3`, json: true,
    })
  })
  it("never generates an executable command for unknown revisions or unsafe identities", () => {
    for (const owner of ["../ouro", "ouro; touch /tmp/x", "ouro\nnext", "o'ro"]) expect(shepherdInspectionCommand(owner)).toBeNull()
    expect(shepherdInspectionCommand("ouro", "not-a-claim")).toBeNull()
    for (const revision of [null, -1, 0.5, Infinity]) expect(shepherdRetirementCommand("ouro", "a".repeat(64), revision)).toBeNull()
  })
})
