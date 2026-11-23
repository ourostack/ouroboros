import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { LIFECYCLE_COMMANDS } from "../../../heart/daemon/cli-commands/lifecycle"
import { getCommandHelp } from "../../../heart/daemon/cli-help"
import { usage } from "../../../heart/daemon/cli-parse"

const gitCommands = Object.fromEntries(LIFECYCLE_COMMANDS.filter((c) => c.name === "git" || c.name.startsWith("git ")).map((c) => [c.name, c]))

describe("ouro git commands", () => {
  it("each declare an Ouro AX card in the lifecycle group", () => {
    expect(Object.keys(gitCommands).sort()).toEqual(["git", "git install", "git status"])
    expect(gitCommands["git"].ax).toMatchObject({ id: "cli:git", group: "lifecycle", effect: "read" })
    expect(gitCommands["git status"].ax).toMatchObject({ id: "cli:git status", group: "lifecycle", effect: "read" })
    expect(gitCommands["git install"].ax).toMatchObject({ id: "cli:git install", group: "lifecycle", effect: "write" })
  })

  it("marks status read-only and install as a change", () => {
    expect(gitCommands["git"].readOnly).toBe(true)
    expect(gitCommands["git status"].readOnly).toBe(true)
    expect(gitCommands["git install"].readOnly).toBeUndefined()
  })

  it("cards the parser's usage refusal and the flag gate's refusal on each", () => {
    for (const command of Object.values(gitCommands)) {
      expect(command.ax?.errors?.map((e) => e.code)).toEqual(["usage", "unknown-flag"])
    }
  })

  it("lists both subcommands in ouro's usage text", () => {
    expect(usage()).toContain("ouro git install [--force]")
    expect(usage()).toContain("ouro git status")
  })

  it("each has its own --help, headed by the command an installed ouro runs", () => {
    expect(getCommandHelp("git status")).toMatch(/^ouro git status - Show which git sync and clone use/)
    expect(getCommandHelp("git status")).toContain("Usage: ouro git status")
    expect(getCommandHelp("git install")).toMatch(/^ouro git install - Install a portable git/)
    expect(getCommandHelp("git install")).toContain("Usage: ouro git install [--force]")
  })

  it("is off the census baseline", () => {
    const baseline = JSON.parse(readFileSync(join(__dirname, "../../../../ax/census.baseline.json"), "utf8")) as { gaps: string[] }
    expect(baseline.gaps.filter((id) => id.startsWith("cli:git"))).toEqual([])
  })
})
