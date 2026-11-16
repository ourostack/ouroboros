import { readFileSync } from "fs"
import { join, resolve } from "path"
import { describe, expect, it } from "vitest"
import { PARSER_FLAGS } from "../../../heart/daemon/cli-gate"

describe("the gate's flag list", () => {
  it("holds exactly the flag literals the CLI's parser and dispatcher read", () => {
    const root = resolve(__dirname, "../../../heart/daemon")
    const literals = new Set<string>()
    for (const file of ["cli-parse.ts", "cli-exec.ts", "cli-help.ts", "cli-defaults.ts"]) {
      const text = readFileSync(join(root, file), "utf8")
      for (const match of text.matchAll(/"(--[a-z][a-z0-9-]*)"/g)) literals.add(match[1]!)
    }
    expect([...PARSER_FLAGS].sort()).toEqual([...literals].sort())
  })
})
