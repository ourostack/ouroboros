import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"
import { afterEach, describe, expect, it } from "vitest"

const script = path.resolve(__dirname, "../../../scripts/copy-action-doors.cjs")
const { ACTION_DOOR_FILES, copyActionDoors } = require(script) as { ACTION_DOOR_FILES: string[]; copyActionDoors(root: string): number }

const roots: string[] = []
function fakeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copy-action-doors-"))
  roots.push(root)
  for (const file of ACTION_DOOR_FILES) {
    const full = path.join(root, "actions", "generated", file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, JSON.stringify({ file }))
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("copy-action-doors", () => {
  it("copies each generated door into dist/actions/generated, byte for byte", () => {
    const root = fakeRepo()
    expect(copyActionDoors(root)).toBe(ACTION_DOOR_FILES.length)
    for (const file of ACTION_DOOR_FILES) {
      expect(fs.readFileSync(path.join(root, "dist", "actions", "generated", file), "utf8")).toBe(JSON.stringify({ file }))
    }
  })

  it("fails loudly when a generated door is missing", () => {
    const root = fakeRepo()
    fs.rmSync(path.join(root, "actions", "generated", ACTION_DOOR_FILES[0]!))
    expect(() => copyActionDoors(root)).toThrow(/ENOENT/)
  })

  it("runs as the build's step with the repository as its argument", () => {
    const root = fakeRepo()
    const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`copied ${ACTION_DOOR_FILES.length} generated action doors`)
    expect(fs.existsSync(path.join(root, "dist", "actions", "generated", ACTION_DOOR_FILES[3]!))).toBe(true)
  })
})
