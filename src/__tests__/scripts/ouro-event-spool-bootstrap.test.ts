import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const roots: string[] = []
const scriptPath = path.resolve(__dirname, "../../../deploy/unraid/ouro-events/bootstrap-spool.sh")

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-spool-bootstrap-"))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("Unraid privileged spool bootstrap", () => {
  it("installs one boot-persistent hook before emhttp and preserves the canonical path", () => {
    const tempRoot = root()
    const goFile = path.join(tempRoot, "go")
    const installPath = path.join(tempRoot, "boot", "config", "custom", "ouro-events", "bootstrap-spool.sh")
    fs.writeFileSync(goFile, "#!/bin/bash\n/usr/local/sbin/emhttp &\n")

    execFileSync(scriptPath, ["--install-only", "--go-file", goFile, "--install-path", installPath])
    execFileSync(scriptPath, ["--install-only", "--go-file", goFile, "--install-path", installPath])

    const installed = fs.readFileSync(installPath, "utf8")
    const go = fs.readFileSync(goFile, "utf8")
    const hook = "/boot/config/custom/ouro-events/bootstrap-spool.sh --mount"
    expect(installed).toContain('SPOOL_ROOT="/boot/config/custom/ouro-events/spool"')
    expect(go.match(new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(1)
    expect(go.indexOf(hook)).toBeLessThan(go.indexOf("/usr/local/sbin/emhttp"))
    expect(fs.statSync(installPath).mode & 0o777).toBe(0o700)
  })

  it("defines the production tmpfs and read-only uid-10001 traversal proof", () => {
    const source = fs.readFileSync(scriptPath, "utf8")
    const template = fs.readFileSync(path.resolve(__dirname, "../../../deploy/unraid/sanctuary.xml"), "utf8")
    expect(source).toContain("size=4m,mode=0755,uid=0,gid=0,nodev,nosuid,noexec")
    expect(source).toContain("mount --bind")
    expect(source).toContain("remount,bind,ro,nodev,nosuid,noexec")
    expect(source).toContain("--reuid=10001 --regid=10001 --clear-groups")
    expect(source).not.toContain("remount,rw")
    expect(template).toContain('Target="/boot/config/custom/ouro-events/spool"')
    expect(template).toContain('Mode="ro"')
  })

  it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0 || spawnSync("sh", ["-c", "command -v setpriv >/dev/null"]).status !== 0)("mounts the production-identical bounded tmpfs and proves uid 10001 reads through its RO bind", () => {
    expect(execFileSync(scriptPath, ["--self-test"], { encoding: "utf8" })).toContain("uid10001-ro-bind: pass")
  })
})
