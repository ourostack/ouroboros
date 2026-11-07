import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const WRAPPER = fs.readFileSync("deploy/unraid/ouro-sync-ssh", "utf8")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-sync-ssh-"))
const recorder = path.join(root, "ssh")
const record = path.join(root, "argv")
const wrapper = path.join(root, "ouro-sync-ssh")
fs.writeFileSync(recorder, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done >"${record}"\n`, { mode: 0o755 })
fs.writeFileSync(wrapper, WRAPPER.replace("exec /usr/bin/ssh ", `exec ${recorder} `))

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function run(args: string[]) {
  fs.rmSync(record, { force: true })
  const result = spawnSync("sh", [wrapper, ...args], { encoding: "utf8" })
  const argv = fs.existsSync(record) ? fs.readFileSync(record, "utf8").trimEnd().split("\n") : null
  return { status: result.status, stderr: result.stderr, argv }
}

const SSH_PREFIX = [
  "-i", "/run/ouro-sync/deploy_key",
  "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "UserKnownHostsFile=/etc/ouro/github_known_hosts",
  "-o", "BatchMode=yes",
  "-F", "/dev/null",
  "git@github.com",
]

describe("ouro-sync-ssh", () => {
  it("is a root-owned-at-install POSIX sh script that execs ssh with the fixed key, host keys and host", () => {
    expect(WRAPPER.startsWith("#!/bin/sh\n")).toBe(true)
    expect(WRAPPER).toContain("exec /usr/bin/ssh -i /run/ouro-sync/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \\\n  -o UserKnownHostsFile=/etc/ouro/github_known_hosts -o BatchMode=yes -F /dev/null git@github.com \"$command\"\n")
    expect(fs.statSync("deploy/unraid/ouro-sync-ssh").mode & 0o777).toBe(0o755)
    const check = spawnSync("sh", ["-n", "deploy/unraid/ouro-sync-ssh"], { encoding: "utf8" })
    expect(check.status, check.stderr).toBe(0)
  })

  it.each([
    [["git@github.com", "git-upload-pack 'ourostack/sanctuary.git'"]],
    [["-o", "SendEnv=GIT_PROTOCOL", "git@github.com", "git-receive-pack 'ourostack/sanctuary.git'"]],
    [["-o", "SendEnv=GIT_PROTOCOL", "-p", "22", "git@github.com", "git-upload-pack 'ourostack/sanctuary'"]],
    [["-p", "22", "-l", "git", "github.com", "git-receive-pack ourostack/sanctuary.git"]],
    [["-l", "git", "github.com", "git-upload-pack 'a-b_c.d/e.f-g_h'"]],
  ])("accepts git's ssh call %j", (args) => {
    const result = run(args)
    expect(result.status, result.stderr).toBe(0)
    expect(result.argv).toEqual([...SSH_PREFIX, args.at(-1)])
  })

  it.each([
    [["-o", "ProxyCommand=sh -c id", "git@github.com", "git-upload-pack 'o/r.git'"], "only -o SendEnv=GIT_PROTOCOL is allowed"],
    [["-oProxyCommand=sh", "git@github.com", "git-upload-pack 'o/r.git'"], "option -oProxyCommand=sh is not allowed"],
    [["-o"], "only -o SendEnv=GIT_PROTOCOL is allowed"],
    [["-p", "2222", "git@github.com", "git-upload-pack 'o/r.git'"], "only -p 22 is allowed"],
    [["-l", "root", "github.com", "git-upload-pack 'o/r.git'"], "only -l git is allowed"],
    [["-G", "git@github.com"], "option -G is not allowed"],
    [["git@github.com", "git-upload-pack 'o/r.git'", "extra.example.com"], "too many arguments"],
    [["git@evil.example.com", "git-upload-pack 'o/r.git'"], "host must be git@github.com"],
    [["github.com", "git-upload-pack 'o/r.git'"], "host must be git@github.com"],
    [["-l", "git", "git@github.com", "git-upload-pack 'o/r.git'"], "host must be git@github.com"],
    [[], "host must be git@github.com"],
    [["git@github.com"], "a git command is required"],
    [["git@github.com", "git-upload-pack 'o/r.git';id"], "only git-upload-pack or git-receive-pack for one repository is allowed"],
    [["git@github.com", "git-upload-pack 'o/r;id.git'"], "only git-upload-pack or git-receive-pack for one repository is allowed"],
    [["git@github.com", "git-upload-pack 'o/r.git'\nid"], "the git command must be one line"],
    [["git@github.com", "git-upload-archive 'o/r.git'"], "only git-upload-pack or git-receive-pack for one repository is allowed"],
    [["git@github.com", "sh -c id"], "only git-upload-pack or git-receive-pack for one repository is allowed"],
    [["git@github.com", "git-upload-pack 'o/r/x.git'"], "only git-upload-pack or git-receive-pack for one repository is allowed"],
    [["git@github.com", "git-upload-pack  'o/r.git'"], "only git-upload-pack or git-receive-pack for one repository is allowed"],
  ])("refuses %j", (args, reason) => {
    const result = run(args)
    expect(result.status).toBe(2)
    expect(result.stderr).toBe(`ouro-sync-ssh: refused: ${reason}\n`)
    expect(result.argv).toBeNull()
  })
})
