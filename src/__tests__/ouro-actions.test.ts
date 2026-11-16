import { createHash } from "crypto"
import { execFileSync } from "child_process"
import { readFileSync } from "fs"
import { join, resolve } from "path"
import { describe, expect, it } from "vitest"
import { usage } from "../heart/daemon/cli-parse"

const root = resolve(__dirname, "../..")

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(join(root, path))).digest("hex")
}

describe("vendored ouro-actions generator", () => {
  const manifest = JSON.parse(readFileSync(join(root, "tools/ouro-actions/dist-manifest.json"), "utf8")) as {
    files: Record<string, string>
  }

  it.each([
    ["tools/ouro-actions/ouro-actions.mts", "dist/actions/ouro-actions.mts"],
    ["tools/ouro-actions/actions.claims.json", "dist/ax/actions.claims.json"],
  ])("%s matches its hash in the core release manifest", (path, manifestKey) => {
    expect(sha256(path)).toBe(manifest.files[manifestKey])
  })

  it("has generated projections that match their declarations", () => {
    const out = execFileSync(
      process.execPath,
      ["tools/ouro-actions/ouro-actions.mts", "check", "actions/ouro.actions.mts", "actions/generated"],
      { cwd: root, encoding: "utf8" },
    )
    expect(out).toContain("every projection matches its declaration")
  })

  it("names only commands the CLI's usage lists", () => {
    const commands = JSON.parse(readFileSync(join(root, "actions/generated/commands.json"), "utf8")) as {
      commands: Array<{ name: string }>
    }
    const help = usage()
    for (const command of commands.commands) {
      expect(help).toContain(`ouro ${command.name}`)
    }
  })
})
