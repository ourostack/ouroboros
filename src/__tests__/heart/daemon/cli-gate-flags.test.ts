import { readFileSync } from "fs"
import { join, resolve } from "path"
import { describe, expect, it } from "vitest"
import { gateCommandArgs, PARSER_FLAGS } from "../../../heart/daemon/cli-gate"
import { SHEPHERD_OPERATION_FLAGS } from "../../../heart/shepherd/operations"

describe("the gate's flag list", () => {
  it("holds exactly the flag literals the CLI's parser and dispatcher read", () => {
    const root = resolve(__dirname, "../../../heart/daemon")
    const literals = new Set<string>()
    // cli-desk.ts and desk-admin.ts parse the desk commands cli-parse.ts hands them.
    for (const file of ["cli-parse.ts", "cli-exec.ts", "cli-help.ts", "cli-defaults.ts", "cli-desk.ts", "desk-admin.ts"]) {
      const text = readFileSync(join(root, file), "utf8")
      for (const match of text.matchAll(/"(--[a-z][a-z0-9-]*)"/g)) literals.add(match[1]!)
    }
    expect([...PARSER_FLAGS].sort()).toEqual([...literals].sort())
  })

  it("lets through every flag a Shepherd operation reads, now that Shepherd's commands are declared", () => {
    for (const [operation, flags] of Object.entries(SHEPHERD_OPERATION_FLAGS)) {
      const words = ["shepherd", ...operation.split(".")]
      const changes = operation !== "status" && operation !== "inspect"
      for (const flag of [...flags, ...(changes ? ["expected-revision", "request-id"] : [])]) {
        expect(gateCommandArgs([...words, `--${flag}`, "x"]), `${operation} --${flag}`).not.toMatchObject({ code: "unknown-flag" })
        expect(gateCommandArgs(["shepherd", operation, `--${flag}`, "x"]), `${operation} --${flag}`).not.toMatchObject({ code: "unknown-flag" })
      }
    }
  })
})
