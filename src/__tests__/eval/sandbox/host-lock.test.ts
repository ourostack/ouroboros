// The eval's side of the host lock (deploy/unraid/ouro-host-lock.mjs): it holds the lock over one ssh session for the
// whole command, and each remote job checks that its token still holds it (#1760).
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { HOST_LOCK_SCRIPT, holdHostLock, localHostLock } from "../../../eval/sandbox/host-lock"
import type { RemoteProcess } from "../../../eval/sandbox/remote"

function fakeHold(script: (out: PassThrough, exit: (code: number) => void, stdin: PassThrough) => void, stderr = "") {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let exit!: (code: number) => void
  const exited = new Promise<number>((resolve) => { exit = resolve })
  const proc: RemoteProcess = { stdin, stdout, exited, stderr: () => stderr }
  setImmediate(() => script(stdout, exit, stdin))
  return () => proc
}

describe("holdHostLock", () => {
  it("returns the token once the remote holder says it has the lock, and release ends the session", async () => {
    let ended = false
    const held = await holdHostLock(fakeHold((out, exit, stdin) => {
      out.write("@@LOCK waiting butler:ship (on sanctuary) until x\n@@LOCK acq")
      out.write(`uired ${"a".repeat(32)}\n`)
      stdin.on("finish", () => { ended = true; exit(0) })
    }))
    expect(held.token).toBe("a".repeat(32))
    await held.release()
    expect(ended).toBe(true)
  })

  it("names the holder when the lock stayed held", async () => {
    await expect(holdHostLock(fakeHold((out, exit) => { out.write("@@LOCK waiting butler:ship 1.0.0 (on sanctuary) until T\n@@LOCK held butler:ship 1.0.0 (on sanctuary) until T\n"); setImmediate(() => exit(3)) })))
      .rejects.toThrow("the host lock is held by butler:ship 1.0.0 (on sanctuary) until T")
  })

  it("says why when the holder could not start", async () => {
    await expect(holdHostLock(fakeHold((_out, exit) => exit(255), "ssh: connect to host sanctuary port 22: Connection refused\n")))
      .rejects.toThrow("could not take the host lock: ssh: connect to host sanctuary port 22: Connection refused")
    await expect(holdHostLock(fakeHold((_out, exit) => exit(1)))).rejects.toThrow("could not take the host lock: exit 1")
  })
})

describe("localHostLock, with the real lock script", () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

  it("is held while the token holds the lock, and not after it is released", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-lock-eval-"))
    roots.push(root)
    const env = { ...process.env, OURO_HOST_LOCK_DIR: path.join(root, "ouro-host.d") }
    const holder = spawn(process.execPath, [HOST_LOCK_SCRIPT, "hold", "--holder", "eval test", "--ttl", "600"], { env, stdio: ["pipe", "pipe", "pipe"] })
    const proc: RemoteProcess = {
      stdin: holder.stdin, stdout: holder.stdout, stderr: () => "",
      exited: new Promise<number>((resolve) => holder.on("close", (code) => resolve(code ?? -1))),
    }
    const held = await holdHostLock(() => proc)
    expect(await localHostLock(held.token, env).held()).toBe(true)
    expect(await localHostLock("someone-else", env).held()).toBe(false)
    await held.release()
    expect(await localHostLock(held.token, env).held()).toBe(false)
  })
})
