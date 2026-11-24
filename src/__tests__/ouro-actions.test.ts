import { createHash } from "crypto"
import { execFileSync, spawnSync } from "child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { describe, expect, it } from "vitest"
import { usage } from "../heart/daemon/cli-parse"

const root = resolve(__dirname, "../..")

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex")
}

describe("vendored ouro-actions generator", () => {
  const manifest = JSON.parse(readFileSync(join(root, "tools/ouro-actions/dist-manifest.json"), "utf8")) as {
    files: Record<string, string>
  }

  it.each([
    ["tools/ouro-actions/ouro-actions.mts", "dist/actions/ouro-actions.mts"],
    ["tools/ouro-actions/actions.claims.json", "dist/ax/actions.claims.json"],
    ["tools/ouro-actions/ouro-actions-tools.mts", "dist/actions/ouro-actions-tools.mts"],
  ])("%s matches its hash in the core release manifest", (path, manifestKey) => {
    expect(sha256(path)).toBe(manifest.files[manifestKey])
  })

  it.each([
    ["tools/ouro-actions/ouro-actions.mts", "actions/generated/mailbox", "every projection matches its declaration"],
    ["tools/ouro-actions/ouro-actions-tools.mts", "actions/generated/mailbox-tools", "every in-turn tool matches its declaration"],
  ])("%s's mailbox projection in %s matches its declaration", (generator, dir, clean) => {
    const out = execFileSync(process.execPath, [generator, "check", "actions/mailbox.actions.mts", dir], { cwd: root, encoding: "utf8" })
    expect(out).toContain(clean)
  })

  it("fails the check when a generated in-turn tool was edited by hand", () => {
    const scratch = mkdtempSync(join(tmpdir(), "c21-tools-drift-"))
    try {
      cpSync(join(root, "actions/generated/mailbox-tools"), scratch, { recursive: true })
      const file = join(scratch, "tools.json")
      writeFileSync(file, readFileSync(file, "utf8").replace("Read only.", "Read only, by hand."))
      const run = spawnSync(process.execPath, ["tools/ouro-actions/ouro-actions-tools.mts", "check", "actions/mailbox.actions.mts", scratch], { cwd: root, encoding: "utf8" })
      expect(run.status).toBe(1)
      expect(run.stderr).toContain("drifted from its declaration")
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
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
    const commands = ["actions/generated/commands.json", "actions/generated/mailbox/commands.json"].flatMap((file) =>
      (JSON.parse(readFileSync(join(root, file), "utf8")) as { commands: Array<{ name: string }> }).commands)
    const help = usage()
    for (const command of commands) {
      expect(help).toContain(`ouro ${command.name}`)
    }
  })
})
