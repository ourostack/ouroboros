import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { registerGlobalLogSink } from "../../nerves"
import { __testHooks, fetchRemote, SYNC_KNOWN_HOSTS, SYNC_SECRET_DIR, syncNetworkEnv, syncSecretDir } from "../../heart/sync"

// A fake `ssh` first on PATH records how git called it, then fails the
// connection, so a fetch from an ssh:// remote shows the ssh command line.

const SAVED = ["PATH", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_CONFIG_NOSYSTEM"] as const
let root: string
let saved: Record<string, string | undefined>
let unregister: () => void

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()
}

function bundleWithSshRemote(): { bundle: string; record: string } {
  const bin = path.join(root, "bin")
  const record = path.join(root, "ssh-calls.txt")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "LC_ALL=$LC_ALL $*" >> '${record}'\nexit 255\n`, { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`
  const bundle = path.join(root, "agent.ouro")
  git(root, ["init", "-q", "-b", "main", bundle])
  git(bundle, ["remote", "add", "origin", "ssh://git@github.invalid/owner/agent.ouro.git"])
  return { bundle, record }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-ssh-key-")))
  saved = Object.fromEntries(SAVED.map((key) => [key, process.env[key]]))
  delete process.env.GIT_SSH_COMMAND
  delete process.env.GIT_SSH
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  unregister = registerGlobalLogSink(() => undefined)
})

afterEach(() => {
  unregister()
  delete __testHooks.syncSecretDir
  for (const key of SAVED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe("the sync deploy key", () => {
  it("GIT_SSH_COMMAND is set only when the key exists", async () => {
    expect(SYNC_SECRET_DIR).toBe("/run/ouro-sync")
    expect(syncSecretDir()).toBe("/run/ouro-sync")
    const secret = path.join(root, "ouro-sync")
    fs.mkdirSync(secret)
    __testHooks.syncSecretDir = secret
    const { bundle, record } = bundleWithSshRemote()
    const config = { enabled: true, remote: "origin", branch: "main" }

    expect(syncNetworkEnv().GIT_SSH_COMMAND).toBeUndefined()
    const withoutKey = await fetchRemote(bundle, config)
    expect(withoutKey.ok).toBe(false)
    const plain = fs.readFileSync(record, "utf-8")
    expect(plain).toContain("LC_ALL=C ")
    expect(plain).not.toContain("-i ")
    expect(plain).not.toContain("IdentitiesOnly")
    fs.rmSync(record)

    fs.writeFileSync(path.join(secret, "deploy_key"), "not a real key\n", { mode: 0o600 })
    const key = path.join(secret, "deploy_key")
    expect(syncNetworkEnv().GIT_SSH_COMMAND).toBe(`ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/ssh/ssh_known_hosts`)
    expect(syncNetworkEnv().LC_ALL).toBe("C")
    expect(SYNC_KNOWN_HOSTS).toBe("/etc/ssh/ssh_known_hosts")
    const withKey = await fetchRemote(bundle, config)
    expect(withKey.ok).toBe(false)
    const keyed = fs.readFileSync(record, "utf-8")
    expect(keyed).toContain("LC_ALL=C ")
    expect(keyed).toContain(`-i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/ssh/ssh_known_hosts`)
    expect(keyed).toContain("github.invalid")
  })
})
