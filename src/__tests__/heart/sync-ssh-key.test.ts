import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { registerGlobalLogSink } from "../../nerves"
import { __testHooks, fetchRemote, SYNC_SECRET_DIR, SYNC_SSH_COMMAND, syncNetworkEnv, syncSecretDir } from "../../heart/sync"

// Fakes first on PATH: `ssh` records a plain call; `sudo` records its own
// arguments and runs the real wrapper (with /usr/bin/ssh swapped for a
// recorder), so a fetch shows exactly what git hands the wrapper and what the
// wrapper hands ssh. Every connection fails with 255.

const SAVED = ["PATH", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT", "GIT_CONFIG_NOSYSTEM"] as const
let root: string
let saved: Record<string, string | undefined>
let unregister: () => void

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()
}

function setUp(): { bundle: string; sshRecord: string; sudoRecord: string; wrappedSshRecord: string } {
  const bin = path.join(root, "bin")
  const sshRecord = path.join(root, "ssh-calls.txt")
  const sudoRecord = path.join(root, "sudo-calls.txt")
  const wrappedSshRecord = path.join(root, "wrapped-ssh-argv.txt")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "LC_ALL=$LC_ALL $*" >> '${sshRecord}'\nexit 255\n`, { mode: 0o755 })
  const wrappedSsh = path.join(root, "wrapped-ssh")
  fs.writeFileSync(wrappedSsh, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > '${wrappedSshRecord}'\nexit 255\n`, { mode: 0o755 })
  const wrapper = path.join(root, "ouro-sync-ssh")
  fs.writeFileSync(wrapper, fs.readFileSync(path.resolve(__dirname, "../../../deploy/unraid/ouro-sync-ssh"), "utf8").replace("exec /usr/bin/ssh ", `exec ${wrappedSsh} `))
  fs.writeFileSync(path.join(bin, "sudo"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${sudoRecord}'`,
    'test "$1 $2 $3 $4" = "-n -u ouro-sync /usr/local/libexec/ouro-sync-ssh" || exit 1',
    "shift 4",
    `exec sh '${wrapper}' "$@"`,
    "",
  ].join("\n"), { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`
  const bundle = path.join(root, "agent.ouro")
  git(root, ["init", "-q", "-b", "main", bundle])
  git(bundle, ["remote", "add", "origin", "git@github.com:owner/agent.ouro.git"])
  return { bundle, sshRecord, sudoRecord, wrappedSshRecord }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-ssh-key-")))
  saved = Object.fromEntries(SAVED.map((key) => [key, process.env[key]]))
  delete process.env.GIT_SSH_COMMAND
  delete process.env.GIT_SSH
  delete process.env.GIT_SSH_VARIANT
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
  it("git reaches ssh through the sudo wrapper only when the key mount exists", async () => {
    expect(SYNC_SECRET_DIR).toBe("/run/ouro-sync")
    expect(syncSecretDir()).toBe("/run/ouro-sync")
    expect(SYNC_SSH_COMMAND).toBe("sudo -n -u ouro-sync /usr/local/libexec/ouro-sync-ssh")
    const secret = path.join(root, "ouro-sync")
    __testHooks.syncSecretDir = secret
    const { bundle, sshRecord, sudoRecord, wrappedSshRecord } = setUp()
    const config = { enabled: true, remote: "origin", branch: "main" }

    expect(syncNetworkEnv().GIT_SSH_COMMAND).toBeUndefined()
    expect(syncNetworkEnv().GIT_SSH_VARIANT).toBeUndefined()
    const withoutMount = await fetchRemote(bundle, config)
    expect(withoutMount.ok).toBe(false)
    expect(fs.readFileSync(sshRecord, "utf-8")).toContain("LC_ALL=C ")
    expect(fs.existsSync(sudoRecord)).toBe(false)

    // The agent's uid cannot read the key, so only the directory is checked.
    fs.mkdirSync(secret)
    expect(syncNetworkEnv()).toMatchObject({ GIT_SSH_COMMAND: SYNC_SSH_COMMAND, GIT_SSH_VARIANT: "ssh", LC_ALL: "C" })
    fs.rmSync(sshRecord)
    const withMount = await fetchRemote(bundle, config)
    expect(withMount.ok).toBe(false)
    expect(fs.existsSync(sshRecord)).toBe(false)
    expect(fs.readFileSync(sudoRecord, "utf-8")).toMatch(/^-n -u ouro-sync \/usr\/local\/libexec\/ouro-sync-ssh (-o SendEnv=GIT_PROTOCOL )?git@github\.com git-upload-pack 'owner\/agent\.ouro\.git'\n$/u)
    expect(fs.readFileSync(wrappedSshRecord, "utf-8").trimEnd().split("\n")).toEqual([
      "-i", "/run/ouro-sync/deploy_key",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "UserKnownHostsFile=/etc/ouro/github_known_hosts",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=5",
      "-o", "ServerAliveCountMax=2",
      "-F", "/dev/null",
      "git@github.com",
      "git-upload-pack 'owner/agent.ouro.git'",
    ])
  })
})
