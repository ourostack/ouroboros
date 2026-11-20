import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { OURO_WRAPPER_SCRIPT } from "../../../heart/versioning/ouro-recovery-launcher"

describe("ouro wrapper node selection", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-wrapper-"))
    fs.mkdirSync(path.join(root, "home", ".ouro-cli", "bin"), { recursive: true })
    fs.writeFileSync(path.join(root, "wrapper.sh"), OURO_WRAPPER_SCRIPT, { mode: 0o755 })
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  function stubNode(dir: string, major: number): string {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
    const file = path.join(root, dir, "node")
    fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo ${major}; else echo "ran node ${major}"; fi\n`, { mode: 0o755 })
    return path.join(root, dir)
  }

  function run(pathDirs: string[]) {
    return spawnSync("/bin/sh", [path.join(root, "wrapper.sh")], {
      env: { PATH: [...pathDirs, "/usr/bin", "/bin"].join(":"), HOME: path.join(root, "home") },
      encoding: "utf8",
    })
  }

  it("skips an old node first on PATH and runs a Node 22 found later", () => {
    const result = run([stubNode("old", 16), stubNode("new", 22)])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("ran node 22")
  })

  it("exits with a clear message naming the Node found when none qualifies", () => {
    const result = run([stubNode("old", 16)])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/needs Node 22 or newer, but found: .*old\/node \(Node 16\)/)
  })
})
