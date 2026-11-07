// The host-side cutover (deploy/unraid/sanctuary-sync-cutover.sh), run for real against a fake appdata tree with a real
// bare remote standing in for GitHub. docker, update_cron, iptables, pgrep (and setsid and flock where the host has none)
// are stubs on PATH. A test that is not root owns every role (OURO_CUTOVER_OWNER); the Linux root test uses the real uids.
import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sanctuaryGitExcludeText } from "../../heart/daemon/sanctuary-bundle-migration"

const SCRIPT = path.resolve(__dirname, "../../../deploy/unraid/sanctuary-sync-cutover.sh")
const GATE = path.resolve(__dirname, "../../../deploy/unraid/sanctuary-replay-gate.mjs")
const SOURCE = fs.readFileSync(SCRIPT, "utf8")
const BUNDLE_REMOTE = "git@github.com:arimendelow/sanctuary.ouro.git"
const OLD_REMOTE = "git@github-backup:arimendelow/sanctuary.ouro.git"
const IMAGE = `sha256:${"a".repeat(64)}`
const isRootLinux = process.platform === "linux" && process.getuid?.() === 0
const has = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0
const hasFlock = has("flock")
const hasSetsid = has("setsid")
const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
const OLD_EXCLUDE = "**/credentials.json\nstate/\ninbox/\n"
const PSYCHE = ["ASPIRATIONS.md", "IDENTITY.md", "LORE.md", "SOUL.md", "TACIT.md"]
const RULE = "OUTPUT -m owner --uid-owner 10002 -p tcp --dport 22 -m comment --comment sanctuary-sync-cutover-probe -j DROP"
const BACKUP_EMAIL = "16390116+arimendelow@users.noreply.github.com"

let T: string
let remote: string
let env: NodeJS.ProcessEnv

const appdata = () => path.join(T, "mnt/user/appdata/ouro-butler")
const bundle = () => path.join(appdata(), "agent/sanctuary.ouro")
const backup = () => path.join(appdata(), "bundle-backup")
const repoGit = () => path.join(backup(), "repo.git")
const cronFile = () => path.join(T, "boot/config/plugins/dynamix/sanctuary-bundle-backup.cron")
const cronTable = () => path.join(T, "etc/cron.d/root")
const incomplete = () => path.join(backup(), "cutover-ROLLBACK-INCOMPLETE")

function git(args: string[], cwd = T): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}
const bg = (args: string[]) => git([`--git-dir=${repoGit()}`, `--work-tree=${bundle()}`, ...args])
const ng = (args: string[]) => git([`--git-dir=${bundle()}/.git`, `--work-tree=${bundle()}`, ...args])
const rg = (args: string[]) => git([`--git-dir=${remote}`, ...args])

function write(file: string, text: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, mode === undefined ? undefined : { mode })
}

function stub(name: string, body: string, shebang = "#!/bin/sh") {
  write(path.join(T, "stub-bin", name), `${shebang}\n${body}\n`, 0o755)
}

/** Points both remote URLs at the bare remote, the way GitHub would answer them. */
function redirect(target = `file://${remote}`) {
  env.GIT_CONFIG_COUNT = "2"
  env.GIT_CONFIG_KEY_0 = `url.${target}.insteadOf`
  env.GIT_CONFIG_VALUE_0 = BUNDLE_REMOTE
  env.GIT_CONFIG_KEY_1 = `url.file://${remote}.insteadOf`
  env.GIT_CONFIG_VALUE_1 = OLD_REMOTE
}

// Sends $STUB_SIGNAL once to the detached run (its pid is in the newest log's .pid file) when a stub call matches.
const SIGNAL_HOOK = `if [ -n "\${STUB_SIGNAL_MATCH:-}" ] && [ ! -e "$T_ROOT/signalled" ] && printf '%s' "$*" | grep -Eq "$STUB_SIGNAL_MATCH"; then
  : >"$T_ROOT/signalled"
  kill -s "$STUB_SIGNAL" "$(cat "$(ls -t "$T_BACKUP"/*.log.pid | head -1)")"
fi`

function setup() {
  T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-cutover-")))
  remote = path.join(T, "github/sanctuary.ouro.git")
  env = {
    PATH: `${path.join(T, "stub-bin")}:${process.env.PATH}`,
    HOME: path.join(T, "home"),
    GIT_CONFIG_NOSYSTEM: "1",
    TMPDIR: path.join(T, "tmp"),
    OURO_CUTOVER_ROOT: T,
    T_ROOT: T,
    T_BACKUP: backup(),
    ...(isRootLinux ? {} : { OURO_CUTOVER_OWNER: `${process.getuid!()}:${process.getgid!()}` }),
  }
  fs.mkdirSync(env.HOME!, { recursive: true })
  fs.mkdirSync(env.TMPDIR!, { recursive: true })
  redirect()
  git(["init", "-q", "--bare", "-b", "main", remote])

  // The live bundle, and the hourly backup's repository beside it.
  for (const name of PSYCHE) write(path.join(bundle(), "psyche", name), `# ${name}\n`)
  write(path.join(bundle(), "agent.json"), `${JSON.stringify({ name: "sanctuary", provider: "anthropic" }, null, 2)}\n`, 0o640)
  write(path.join(bundle(), "tool-profiles.json"), "{}\n")
  write(path.join(bundle(), "arc/obligations/o1.md"), "an obligation\n")
  write(path.join(bundle(), "friends/f1.json"), "{}\n")
  write(path.join(bundle(), "state/sessions/s.json"), "{}\n")
  write(path.join(bundle(), "mcp/credentials.json"), "{\"not\":\"tracked\"}\n")
  git(["init", "-q", "--bare", "-b", "master", repoGit()])
  bg(["config", "core.bare", "false"])
  bg(["config", "core.worktree", bundle()])
  bg(["config", "core.sshCommand", `ssh -i ${backup()}/deploy_key`])
  bg(["remote", "add", "origin", OLD_REMOTE])
  write(path.join(repoGit(), "info/exclude"), OLD_EXCLUDE)
  bg(["add", "-A"])
  bg(["-c", "user.name=backup", "-c", "user.email=backup@example.invalid", "commit", "-q", "-m", "hourly backup"])
  bg(["push", "-q", "origin", "HEAD:main"])
  const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "throwaway", "-f", path.join(backup(), "deploy_key")])
  if (keygen.status !== 0) write(path.join(backup(), "deploy_key"), "throwaway test key\n", 0o600)
  write(path.join(backup(), "known_hosts"), "github.com ssh-ed25519 AAAAthrowaway\n")
  write(cronFile(), "17 * * * * /mnt/user/appdata/ouro-butler/bundle-backup/backup.sh >/dev/null 2>&1\n")
  write(cronTable(), "# generated\n17 * * * * /mnt/user/appdata/ouro-butler/bundle-backup/backup.sh >/dev/null 2>&1\n")
  write(path.join(T, "exclude.txt"), sanctuaryGitExcludeText())
  fs.mkdirSync(path.join(T, "usr/local/bin"), { recursive: true })
  fs.symlinkSync(process.execPath, path.join(T, "usr/local/bin/node"))
  write(path.join(T, "container"), "running\n")

  // docker: records each call; the container's state, the release's exclude list, the git timing and the audit come from files and env.
  stub("docker", `printf '%s\\n' "$*" >>"${T}/docker.log"
${SIGNAL_HOOK}
if [ -n "\${STUB_FAIL_MATCH:-}" ] && printf '%s' "$*" | grep -Eq "$STUB_FAIL_MATCH"; then echo "stub: failing $1" >&2; exit 1; fi
if [ -n "\${STUB_SLEEP_MATCH:-}" ] && printf '%s' "$*" | grep -Eq "$STUB_SLEEP_MATCH"; then sleep 2; fi
if [ "$1" = exec ] && [ -n "\${STUB_EXEC_STDERR:-}" ]; then echo "$STUB_EXEC_STDERR" >&2; fi
case "$*" in
  "inspect --format {{.Image}} ouro-butler") echo ${IMAGE} ;;
  "inspect --format {{.Config.Image}} ouro-butler") echo ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.990 ;;
  "inspect --format {{.State.Running}} ouro-butler") if grep -q running "${T}/container"; then echo true; else echo false; fi ;;
  "inspect ouro-butler" | "image inspect ${IMAGE}") echo '[{}]' ;;
  "stop ouro-butler") echo stopped >"${T}/container"; echo ouro-butler ;;
  "start ouro-butler") echo running >"${T}/container"; echo ouro-butler ;;
  run*"sanctuary git-exclude --print") cat "${T}/exclude.txt"; echo ;;
  run*"--user 10001:10001"*) echo "\${STUB_TIMINGS:-12 34}" ;;
  "run --rm -i --pull=never --network none --entrypoint node ${IMAGE} /opt/ouro/deploy/unraid/sanctuary-replay-gate.mjs status-scan") exec "${process.execPath}" "${GATE}" status-scan ;;
  run*audit-container-spec.sh*) [ -z "\${STUB_AUDIT_HOOK:-}" ] || sh -c "$STUB_AUDIT_HOOK"; exit "\${STUB_AUDIT_STATUS:-0}" ;;
  "exec -u 10001 ouro-butler test -r /run/ouro-sync/deploy_key") exit "\${STUB_KEY_READABLE:-1}" ;;
  "exec -u 10001 ouro-butler cat /run/ouro-sync/deploy_key") exit "\${STUB_KEY_READABLE:-1}" ;;
  "exec ouro-butler id -u ouro-sync") echo "\${STUB_SYNC_UID:-10002}" ;;
  "exec ouro-butler pgrep -x git") exit "\${STUB_CONTAINER_PGREP:-1}" ;;
  "exec -u 10001 -e GIT_SSH_COMMAND=sudo -n -u ouro-sync /usr/local/libexec/ouro-sync-ssh -e GIT_SSH_VARIANT=ssh ouro-butler git ls-remote ${BUNDLE_REMOTE} refs/heads/main") echo "\${STUB_LS_REMOTE-0123abcd	refs/heads/main}" ;;
  "exec -u 10001 ouro-butler timeout 60 node /opt/ouro/dist/heart/daemon/ouro-entry.js sync --agent sanctuary")
    if grep -q DROP "${T}/iptables" 2>/dev/null; then
      sleep "\${STUB_STALL_S:-0}"
      echo "\${STUB_STALL_OUTPUT-ssh: connect to host github.com port 22: Operation timed out}" >&2
      exit "\${STUB_STALLED_STATUS:-1}"
    fi
    echo "synced sanctuary" ;;
  "exec ouro-butler ps -u 10002 -o pid=") printf '%s' "\${STUB_LEFTOVER:-}"; [ -n "\${STUB_LEFTOVER:-}" ] ;;
  *) echo "stub docker: unexpected: $*" >&2; exit 97 ;;
esac`)
  // update_cron regenerates the table from the cron files, as Unraid's does.
  stub("update_cron", `${SIGNAL_HOOK}
echo "# generated" >"${cronTable()}"; cat "${path.dirname(cronFile())}"/*.cron >>"${cronTable()}" 2>/dev/null; echo update_cron >>"${T}/docker.log"; exit 0`)
  stub("iptables", `printf 'iptables %s\\n' "$*" >>"${T}/docker.log"
touch "${T}/iptables"
case "$1" in
  -I) shift; printf '%s\\n' "$*" >>"${T}/iptables" ;;
  -D) shift; [ -n "\${STUB_IPTABLES_STUCK:-}" ] || { grep -vxF "$*" "${T}/iptables" >"${T}/iptables.new" || true; mv "${T}/iptables.new" "${T}/iptables"; } ;;
  -C) shift; grep -qxF "$*" "${T}/iptables" ;;
esac`)
  stub("pgrep", `exit "\${STUB_PGREP:-1}"`)
  // Without flock on the host, only the cutover lock (`flock -n 8`) can be made busy, through the env.
  if (!hasFlock) stub("flock", `[ "$*" = "-n 8" ] && exit "\${STUB_CUTOVER_LOCK_BUSY:-0}"; exit 0`)
  // setsid -f: a new session in a child that outlives this process, as util-linux's does.
  if (!hasSetsid) {
    stub("setsid", `import os, sys
args = sys.argv[1:]
if args and args[0] == "-f":
    args = args[1:]
if os.fork() == 0:
    os.setsid()
    os.execvp(args[0], args)`, "#!/usr/bin/env python3")
  }
}

function run(mode?: string, extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync("bash", [SCRIPT, ...(mode ? [mode] : [])], { encoding: "utf8", env: { ...env, ...extra }, timeout: 90_000 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: result.stdout + result.stderr }
}

const dockerLog = () => (fs.existsSync(path.join(T, "docker.log")) ? fs.readFileSync(path.join(T, "docker.log"), "utf8").trim().split("\n") : [])
const beforeFiles = () => fs.readdirSync(backup()).filter((name) => /^cutover-before-.*\.txt$/u.test(name)).sort()
const readBefore = () => fs.readFileSync(path.join(backup(), beforeFiles().at(-1)!), "utf8")
const logs = () => fs.readdirSync(backup()).filter((name) => /^cutover-.*\.log$/u.test(name))
const noise = (rel: string) => rel === "docker.log" || rel.startsWith("tmp") || /(^|\/)cutover-[^/]*$/u.test(rel) || rel.endsWith("bundle-backup/lock") || rel === "signalled"

/** Every file and link under the tree, with its bytes, mode and owner. */
function snapshot(root: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const rel = path.relative(root, full)
      if (skip(rel)) continue
      const stat = fs.lstatSync(full)
      if (stat.isDirectory()) { out[rel] = `dir ${stat.mode & 0o7777} ${stat.uid}`; walk(full) } else if (stat.isSymbolicLink()) out[rel] = `link ${fs.readlinkSync(full)}`
      else out[rel] = `file ${stat.mode & 0o7777} ${stat.uid} ${fs.readFileSync(full).toString("base64")}`
    }
  }
  walk(root)
  return out
}

/** What a rollback must put back: the backup repository's config, branch, upstream, exclude, owner and mode, the cron, agent.json and the layout. */
function beforeState() {
  return {
    config: bg(["config", "--local", "--list"]).split("\n").sort(),
    branch: bg(["symbolic-ref", "--short", "HEAD"]),
    exclude: fs.readFileSync(path.join(repoGit(), "info/exclude"), "utf8"),
    owners: [...new Set(Object.values(snapshot(repoGit())).map((entry) => entry.split(" ")[2]))],
    mode: fs.statSync(repoGit()).mode & 0o7777,
    cron: fs.readFileSync(cronFile(), "utf8"),
    cronTable: fs.readFileSync(cronTable(), "utf8"),
    agentJson: fs.readFileSync(path.join(bundle(), "agent.json"), "utf8"),
    agentMode: fs.statSync(path.join(bundle(), "agent.json")).mode & 0o7777,
    bundleGit: fs.existsSync(path.join(bundle(), ".git")),
    marker: fs.existsSync(path.join(backup(), "cutover-done")),
    applying: fs.existsSync(path.join(backup(), "cutover-applying")),
    incomplete: fs.existsSync(incomplete()),
    disabledCron: fs.existsSync(path.join(backup(), "sanctuary-bundle-backup.cron.disabled")),
    container: fs.readFileSync(path.join(T, "container"), "utf8"),
    syncKey: fs.existsSync(path.join(appdata(), "sync/deploy_key")),
  }
}

async function waitFor(check: () => boolean, ms = 60_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

beforeEach(() => setup())
afterEach(() => fs.rmSync(T, { recursive: true, force: true }))

// Each test runs the script several times with spawnSync; under a loaded full suite one can pass 5 s.
describe("sanctuary-sync-cutover.sh", { timeout: 60_000 }, () => {
  it("is bash, passes bash -n, and names the repository and branch once at the top", () => {
    expect(SOURCE.startsWith("#!/bin/bash\n")).toBe(true)
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0)
    expect(fs.statSync(SCRIPT).mode & 0o777).toBe(0o755)
    expect(SOURCE).toContain("\nBUNDLE_REPO_OWNER=arimendelow\nBUNDLE_REPO_NAME=sanctuary.ouro\nBUNDLE_REMOTE=\"git@github.com:${BUNDLE_REPO_OWNER}/${BUNDLE_REPO_NAME}.git\"\nBUNDLE_BRANCH=main\n")
    expect(SOURCE).toContain("\nBUTLER_OWNER=10001:10001\nSYNC_OWNER=10002:10002\nROOT_OWNER=0:0\n")
    expect(SOURCE).toContain("\nSYNC_CONTAINER_UID=10002\n")
    expect(SOURCE).not.toMatch(/\bjq\b/u)
  })

  it("makes no bare git call: every host-side git names its repository and work tree, in the script and in the gate", () => {
    const code = (text: string) => text.split("\n").filter((line) => !/^\s*(#|\/\/)/u.test(line))
    // git as a command word: at the start of a line, after ; | & ( { or $(, or after then/do/if/!.
    const scriptCalls = code(SOURCE).filter((line) => /(^|[;|&({]|\$\(|\b(?:then|do|if)\b|!)\s*git\s/u.test(line))
    expect(scriptCalls.length).toBeGreaterThan(0)
    for (const line of scriptCalls) {
      // The one container-side call without a repository: ls-remote of a URL, through the sync path, inside the Butler's container.
      if (/git ls-remote "\$BUNDLE_REMOTE"/u.test(line)) continue
      expect(line, line).toMatch(/--git-dir=/u)
    }
    // The gate runs no host-side git at all: its one git call runs inside the container as the Butler, on the bundle (C1).
    const gate = fs.readFileSync(GATE, "utf8")
    const gateCalls = code(gate).filter((line) => /["'`]git["'`]/u.test(line))
    expect(gateCalls).toHaveLength(1)
    expect(gateCalls[0]).toMatch(/run\("docker", \["exec", "-u", BUTLER_USER, .*CONTAINER, "git", "-c", "core\.hooksPath=\/dev\/null", "-c", "core\.fsmonitor=false", "-C", CONTAINER_BUNDLE/u)
    expect(gate).not.toMatch(/--git-dir|--work-tree/u)
  })

  it("names secrets with the gate's pattern, and every host-side ssh uses backup.sh's key and known_hosts with strict checking", async () => {
    const gate = await import(GATE)
    const pattern = /\nSECRET_NAME_PATTERN='([^']+)'\n/u.exec(SOURCE)![1]!
    expect(pattern).toBe(gate.SECRET_PATH.source.replaceAll("\\/", "/"))
    expect(SOURCE).toContain('\nBACKUP_SSH="ssh -i $BACKUP_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS -o BatchMode=yes"\n')
    const sshUses = SOURCE.split("\n").filter((line) => /GIT_SSH_COMMAND=/u.test(line) && !/^\s*#/u.test(line))
    expect(sshUses.length).toBe(6)
    for (const line of sshUses) expect(line).toMatch(/GIT_SSH_COMMAND=\$BACKUP_SSH |GIT_SSH_COMMAND=sudo -n -u ouro-sync \$SYNC_SSH_WRAPPER/u)
  })

  it("refuses an unknown mode and a non-root run on the real host", () => {
    expect(run("--now").status).toBe(1)
    expect(run("--now").stderr).toContain("usage: sanctuary-sync-cutover.sh")
    const real = spawnSync("bash", [SCRIPT, "--dry-run", "extra"], { encoding: "utf8", env: { ...env, OURO_CUTOVER_ROOT: "" } })
    expect(real.status).toBe(1)
    if (!isRootLinux) {
      const nonRoot = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...env, OURO_CUTOVER_ROOT: "" } })
      expect(nonRoot.stderr).toBe("cutover: run this as root on the host\n")
    }
  })

  describe("dry run", () => {
    it("changes nothing, and prints and saves the before-state to a new file each time", () => {
      fs.chmodSync(repoGit(), 0o750)
      const before = snapshot(T, noise)
      const result = run()
      expect(result.status, result.out).toBe(0)
      expect(snapshot(T, noise)).toEqual(before)
      expect(beforeFiles()).toHaveLength(1)
      const saved = readBefore()
      expect(result.stdout).toContain(saved)
      const uid = isRootLinux ? 0 : process.getuid!()
      const gid = isRootLinux ? 0 : process.getgid!()
      for (const line of [
        `origin.url: ${OLD_REMOTE}`,
        `target.url: ${BUNDLE_REMOTE}`,
        "remote.origin.fetch: +refs/heads/*:refs/remotes/origin/*",
        `image: ${IMAGE}`,
        "branch: master",
        "upstream: (none)",
        "branch.remote: (unset)",
        `core.bare: false`,
        `core.worktree: ${bundle()}`,
        `core.sshCommand: ssh -i ${backup()}/deploy_key`,
        "core.untrackedCache: (unset)",
        `repo.git owner: ${uid}:${gid}`,
        "repo.git mode: 750",
        "agent.json sync: (absent)",
        "sync key: absent",
        `known_hosts: ${backup()}/known_hosts`,
        "stash count: 0",
        "git status ms: 12",
        "git add -A --dry-run ms: 34",
        "tracked paths the new exclude matches: 2",
        "  arc/obligations/o1.md",
        "  tool-profiles.json",
        "secret-named tracked paths: 0",
        `cron file: ${cronFile()}`,
        "info/exclude:",
        "  | state/",
        `info/exclude.base64: ${Buffer.from(OLD_EXCLUDE).toString("base64")}`,
      ]) expect(saved.split("\n"), line).toContain(line)
      expect(result.stdout).toContain(`dry run ok; saved ${path.join(backup(), beforeFiles()[0]!)}`)
      // Timed inside the release image as the Butler's uid, read-only, on the live bundle; the list comes from the release's own code.
      const log = dockerLog()
      expect(log).toContain(`run --rm --pull=never --network none --entrypoint node ${IMAGE} /opt/ouro/dist/heart/daemon/ouro-entry.js sanctuary git-exclude --print`)
      const timing = log.find((line) => line.includes("--user 10001:10001"))!
      expect(timing).toContain(`--mount type=bind,src=${repoGit()},dst=/cutover/repo.git,readonly`)
      expect(timing).toContain(`--mount type=bind,src=${bundle()},dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly`)
      expect(log.some((line) => /^(stop|start|exec)\b/u.test(line))).toBe(false)
      // A second dry run never overwrites the first file.
      expect(run().status).toBe(0)
      expect(beforeFiles()).toHaveLength(2)
      expect(fs.readFileSync(path.join(backup(), beforeFiles()[0]!), "utf8")).toBe(saved)
    })

    it("records the sync value agent.json already has", () => {
      write(path.join(bundle(), "agent.json"), `${JSON.stringify({ name: "sanctuary", sync: { enabled: false, branch: "main" } }, null, 2)}\n`, 0o640)
      expect(run().status).toBe(0)
      expect(readBefore().split("\n")).toContain('agent.json sync: {"enabled":false,"branch":"main"}')
    })

    it("fails on a secret-named tracked file and still changes nothing", () => {
      write(path.join(bundle(), "notes/api-token.txt"), "x\n")
      bg(["add", "-A"])
      bg(["-c", "user.name=backup", "-c", "user.email=backup@example.invalid", "commit", "-q", "-m", "hourly backup"])
      const before = snapshot(T, noise)
      const result = run("--dry-run")
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("secret-named tracked paths: 1\n  notes/api-token.txt\n")
      expect(result.stderr).toContain("FAIL: tracked paths look like secrets")
      expect(result.stderr).toContain("cutover: the dry run found problems; nothing was changed")
      expect(snapshot(T, noise)).toEqual(before)
    })

    it.each([
      ["400 10", "git status took 400 ms"],
      ["10 301", "git add -A --dry-run 301 ms"],
    ])("fails when the git timing is %s", (timings, message) => {
      const result = run(undefined, { STUB_TIMINGS: timings })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(message)
    })

    it("fails closed on a garbled timing, a missing piece, a git config that fails, or a cutover already done or under way", () => {
      expect(run(undefined, { STUB_TIMINGS: "fast" }).stderr).toContain('the git timing inside the image printed "fast"')
      fs.writeFileSync(path.join(T, "exclude.txt"), "inbox/\n")
      expect(run().stderr).toContain("has no state/ entry")
      fs.writeFileSync(path.join(T, "exclude.txt"), "state/\n")
      expect(run().stderr).toContain("has no **/*.key entry")
      fs.writeFileSync(path.join(T, "exclude.txt"), sanctuaryGitExcludeText())
      expect(run(undefined, { STUB_FAIL_MATCH: "^inspect --format \\{\\{\\.Image" }).status).toBe(1)
      // git config exiting anything but 0 or 1 is a failure, never "(unset)".
      stub("git", `case "$*" in *"config --get core.sshCommand") exit 3 ;; esac\nexec "${REAL_GIT}" "$@"`)
      expect(run().stderr).toContain("git config --get core.sshCommand failed (exit 3)")
      fs.rmSync(path.join(T, "stub-bin/git"))
      fs.rmSync(path.join(backup(), "known_hosts"))
      expect(run().stderr).toContain("known_hosts is missing")
      write(path.join(backup(), "known_hosts"), "github.com ssh-ed25519 AAAAthrowaway\n")
      for (const [file, message] of [
        ["cutover-done", "the cutover is already done"],
        ["cutover-applying", "an apply is running or was interrupted"],
        ["cutover-ROLLBACK-INCOMPLETE", "a rollback did not finish"],
      ] as const) {
        fs.writeFileSync(path.join(backup(), file), "x\n")
        expect(run().stderr).toContain(message)
        fs.rmSync(path.join(backup(), file))
      }
      fs.renameSync(cronFile(), `${cronFile()}.off`)
      expect(run().stderr).toContain("the backup cron file")
      expect(beforeFiles()).toEqual([])
    })
  })

  describe("the git timing", () => {
    it("measures a read-only repository and work tree for real, and writes nothing", () => {
      const script = /\nMEASURE_GIT_SCRIPT='([^']*)'\n/u.exec(SOURCE)![1]!
      const ro = path.join(T, "ro")
      fs.cpSync(repoGit(), path.join(ro, "repo.git"), { recursive: true })
      fs.cpSync(bundle(), path.join(ro, "bundle"), { recursive: true })
      write(path.join(ro, "exclude"), sanctuaryGitExcludeText())
      stub("date", `if [ "$1" = "+%s%N" ]; then exec perl -MTime::HiRes=time -e 'printf "%d\\n", time() * 1e9'; fi\nexec /bin/date "$@"`)
      spawnSync("chmod", ["-R", "a-w", ro])
      try {
        const before = snapshot(ro)
        const result = spawnSync("sh", ["-c", script, "sh", path.join(ro, "repo.git"), path.join(ro, "bundle"), path.join(ro, "exclude")], { encoding: "utf8", env })
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toMatch(/^\d+ \d+\n$/u)
        expect(snapshot(ro)).toEqual(before)
        expect(fs.readdirSync(env.TMPDIR!)).toEqual([])
      } finally {
        spawnSync("chmod", ["-R", "u+w", ro])
      }
    })
  })

  describe("apply", () => {
    it("leaves main tracking origin/main with the backup history, nothing excluded tracked, sync on, the key installed and .git the Butler's", () => {
      const backupHead = bg(["rev-parse", "HEAD"])
      // A change since the last hourly run: the final backup commit carries it.
      write(path.join(bundle(), "friends/f2.json"), "{\"new\":true}\n")
      const result = run("--apply")
      expect(result.status, result.out).toBe(0)
      expect(result.stdout).toMatch(/running detached; its log is \S+\/bundle-backup\/cutover-\d{8}T\d{6}Z-\d+\.log/u)
      expect(result.stdout).toContain("cutover done. Run --verify-live next.")
      // The whole run is in the log the foreground followed.
      expect(logs()).toHaveLength(1)
      expect(fs.readFileSync(path.join(backup(), logs()[0]!), "utf8")).toContain("cutover done.")
      expect(fs.readFileSync(path.join(backup(), `${logs()[0]!}.status`), "utf8")).toBe("0\n")

      expect(fs.existsSync(repoGit())).toBe(false)
      expect(ng(["symbolic-ref", "--short", "HEAD"])).toBe("main")
      expect(ng(["config", "branch.main.remote"])).toBe("origin")
      expect(ng(["config", "branch.main.merge"])).toBe("refs/heads/main")
      expect(ng(["config", "remote.origin.url"])).toBe(BUNDLE_REMOTE)
      const head = ng(["rev-parse", "HEAD"])
      expect(ng(["rev-parse", "origin/main"])).toBe(head)
      expect(rg(["rev-parse", "main"])).toBe(head)
      expect(spawnSync("git", [`--git-dir=${bundle()}/.git`, "merge-base", "--is-ancestor", backupHead, head], { env }).status).toBe(0)
      const [untrack, last] = ng(["log", "--format=%s|%an|%ae", "-2"]).split("\n")
      expect(untrack).toBe("sync: stop tracking package-managed and excluded files|sanctuary|sanctuary@ouro.local")
      // The last backup commit is backup.sh's: its identity and its message format.
      expect(last).toMatch(new RegExp(`^backup \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z\\|Sanctuary backup\\|${BACKUP_EMAIL.replace("+", "\\+")}$`, "u"))
      expect(rg(["ls-tree", "-r", "--name-only", "main"]).split("\n")).toEqual(["agent.json", "friends/f1.json", "friends/f2.json", ...PSYCHE.map((name) => `psyche/${name}`)])
      expect(ng(["ls-files", "-ci", "--exclude-standard"])).toBe("")
      expect(fs.readFileSync(path.join(bundle(), ".git/info/exclude"), "utf8")).toBe(sanctuaryGitExcludeText())
      for (const key of ["core.bare", "core.worktree", "core.sshCommand"]) expect(spawnSync("git", [`--git-dir=${bundle()}/.git`, "config", key], { env }).status).toBe(1)
      expect(ng(["config", "core.untrackedCache"])).toBe("true")
      expect(ng(["config", "feature.manyFiles"])).toBe("true")

      const agent = JSON.parse(fs.readFileSync(path.join(bundle(), "agent.json"), "utf8"))
      expect(agent).toEqual({ name: "sanctuary", provider: "anthropic", sync: { enabled: true, branch: "main" } })
      expect(fs.statSync(path.join(bundle(), "agent.json")).mode & 0o7777).toBe(0o640)

      const key = path.join(appdata(), "sync/deploy_key")
      expect(fs.statSync(key).mode & 0o7777).toBe(0o400)
      expect(fs.statSync(path.dirname(key)).mode & 0o7777).toBe(0o755)
      expect(fs.readFileSync(key).equals(fs.readFileSync(path.join(backup(), "deploy_key")))).toBe(true)
      const butlerUid = isRootLinux ? 10001 : process.getuid!()
      expect(Object.entries(snapshot(path.join(bundle(), ".git"))).filter(([, entry]) => !entry.startsWith("link") && entry.split(" ")[2] !== String(butlerUid))).toEqual([])
      if (isRootLinux) expect(fs.statSync(key).uid).toBe(10002)

      const marker = fs.readFileSync(path.join(backup(), "cutover-done"), "utf8")
      expect(marker).toContain(`before: ${path.join(backup(), beforeFiles()[0]!)}\n`)
      expect(fs.existsSync(path.join(backup(), "cutover-applying"))).toBe(false)
      expect(fs.existsSync(cronFile())).toBe(false)
      expect(fs.existsSync(path.join(backup(), "sanctuary-bundle-backup.cron.disabled"))).toBe(true)
      expect(fs.readFileSync(cronTable(), "utf8")).not.toContain("backup.sh")
      expect(fs.readFileSync(path.join(T, "container"), "utf8")).toBe("running\n")
      const log = dockerLog()
      const order = ["stop ouro-butler", "update_cron", "start ouro-butler"].map((entry) => log.indexOf(entry))
      expect(order).toEqual([...order].sort((a, b) => a - b))
      expect(log).toContain(`run --rm -i --pull=never --network none --entrypoint node ${IMAGE} /opt/ouro/deploy/unraid/sanctuary-replay-gate.mjs status-scan`)
      const audit = log.find((line) => line.includes("audit-container-spec.sh"))!
      expect(audit).toMatch(/--mount-contract canonical-gateway --expected-image-reference ghcr\.io\/ourostack\/ouroboros-butler:0\.1\.0-alpha\.990 --expected-icon \S+ --sync-enabled true$/u)
      expect(log.indexOf(audit)).toBeGreaterThan(log.indexOf("start ouro-butler"))
      expect(log.at(-1)).toBe("exec -u 10001 ouro-butler test -r /run/ouro-sync/deploy_key")
      // The script never prints the key.
      expect(result.out + fs.readFileSync(path.join(backup(), logs()[0]!), "utf8")).not.toMatch(/PRIVATE KEY|throwaway test key/u)
    })

    it("hands .git to the Butler's uid as the last write and the key to ouro-sync, as root, from a copy born 0600", () => {
      expect(SOURCE).toContain('  chown -R -h "$BUTLER_OWNER" "$BUNDLE/.git"\n  assert_owned_by_butler\n')
      expect(SOURCE).toContain('  (umask 077; cp -- "$BACKUP_KEY" "$SYNC_DIR/.deploy_key.cutover")\n  chown "$SYNC_OWNER" "$SYNC_DIR/.deploy_key.cutover"\n  chmod 0400 "$SYNC_DIR/.deploy_key.cutover"\n')
      const steps = ["STEP=12;", "STEP=13;", "STEP=14;", "STEP=15;"].map((marker) => SOURCE.indexOf(marker))
      expect(steps).toEqual([...steps].sort((a, b) => a - b))
      expect(SOURCE.slice(SOURCE.indexOf("STEP=13;"), SOURCE.indexOf("STEP=15;"))).not.toMatch(/bundle_git|backup_git/u)
    })

    it("apply failing at step 7 rolls back to the exact before-state", () => {
      const before = beforeState()
      redirect(`file://${path.join(T, "github/missing.git")}`)
      const result = run("--apply")
      expect(result.status).toBe(1)
      expect(result.out).toContain("cutover failed at step 7")
      expect(result.out).toContain("rolled back: the hourly backup owns the bundle again")
      expect(result.out).toContain("The Butler is running.")
      expect(beforeState()).toEqual(before)
      expect(dockerLog().filter((line) => /^(stop|start) /u.test(line))).toEqual(["stop ouro-butler", "start ouro-butler"])
      // The rollback leaves a state the next dry run accepts.
      redirect()
      expect(run().status).toBe(0)
    })

    it.each([
      ["the audit of the started container", { STUB_AUDIT_STATUS: "1" }, "cutover failed at step 15"],
      ["the Butler's uid reading the key", { STUB_KEY_READABLE: "0" }, "the Butler's uid can read"],
      ["a key check that could not run", { STUB_KEY_READABLE: "126" }, "the check could not run: docker exec -u 10001 ouro-butler test -r"],
      ["a key check against a missing container", { STUB_EXEC_STDERR: "Error: No such container: ouro-butler" }, "the check could not run"],
    ])("rolls back everything when %s fails after the start", (_name, extra, message) => {
      const before = beforeState()
      const result = run("--apply", extra)
      expect(result.status).toBe(1)
      expect(result.out).toContain("cutover failed at step 15")
      expect(result.out).toContain(message)
      expect(beforeState()).toEqual(before)
      expect(JSON.parse(fs.readFileSync(path.join(bundle(), "agent.json"), "utf8")).sync).toBeUndefined()
    })

    it("stops before changing anything when the dry run fails, the fetch refspec is not the default, or the backup cron cannot be disabled", () => {
      const before = beforeState()
      expect(run("--apply", { STUB_TIMINGS: "999 1" }).status).toBe(1)
      expect(beforeState()).toEqual(before)
      expect(dockerLog().some((line) => line.startsWith("stop"))).toBe(false)

      bg(["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"])
      const narrow = beforeState()
      const refspec = run("--apply")
      expect(refspec.status).toBe(1)
      expect(refspec.out).toContain('remote.origin.fetch is "+refs/heads/main:refs/remotes/origin/main", not "+refs/heads/*:refs/remotes/origin/*"; nothing was changed')
      expect(beforeState()).toEqual(narrow)
      expect(dockerLog().some((line) => line.startsWith("stop"))).toBe(false)
      bg(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"])

      stub("update_cron", "exit 0")
      const stuck = run("--apply")
      expect(stuck.out).toContain("still runs backup.sh")
      expect(beforeState()).toEqual(before)
    })

    it("pushes over ssh with backup.sh's key and known_hosts, host key checking strict", () => {
      env.GIT_CONFIG_COUNT = "0"
      stub("ssh", `printf '%s\\n' "$*" >>"${T}/ssh.log"; echo "stub ssh: no network" >&2; exit 255`)
      const before = beforeState()
      const result = run("--apply")
      expect(result.status).toBe(1)
      expect(result.out).toContain("cutover failed at step 4")
      // Everything is put back, and the rollback says plainly that the hourly backup cannot push either.
      expect(result.out).toContain("rollback: check the hourly backup can push: FAILED")
      expect(result.out).toContain("the hourly backup can't push: ")
      expect(fs.readFileSync(incomplete(), "utf8")).toContain("failed: check the hourly backup can push\n")
      expect({ ...beforeState(), incomplete: false, applying: false }).toEqual(before)
      const calls = fs.readFileSync(path.join(T, "ssh.log"), "utf8").trim().split("\n")
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call).toContain(`-i ${backup()}/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${backup()}/known_hosts -o BatchMode=yes`)
      }
    })

    it("fails step 10 on a secret in a new untracked directory, and rolls back", () => {
      // An exclude only the backup had: the last backup never commits it, and the release's list does not exclude it.
      write(path.join(repoGit(), "info/exclude"), `${OLD_EXCLUDE}drafts/\n`)
      write(path.join(bundle(), "drafts/new/api-token.txt"), "x\n")
      const before = beforeState()
      const result = run("--apply")
      expect(result.status).toBe(1)
      expect(result.out).toContain("cutover failed at step 10")
      expect(result.out).toContain("git status shows package-managed or secret paths: drafts/new/api-token.txt")
      expect(beforeState()).toEqual(before)
    })

    it("aborts before the push when untracking would drop a psyche file, and drops the unpushed commit", () => {
      write(path.join(T, "exclude.txt"), `${sanctuaryGitExcludeText()}psyche/LORE.md\n`)
      const before = beforeState()
      const headBefore = bg(["rev-parse", "HEAD"])
      const remoteBefore = rg(["rev-parse", "main"])
      const result = run("--apply")
      expect(result.status).toBe(1)
      expect(result.out).toContain("cutover failed at step 9")
      expect(result.out).toContain("psyche/LORE.md would no longer be tracked; nothing was pushed")
      expect(result.out).toContain(`reset the branch to ${headBefore}, dropping a commit GitHub never got`)
      expect(rg(["rev-parse", "main"])).toBe(remoteBefore)
      expect(bg(["rev-parse", "HEAD"])).toBe(headBefore)
      expect(beforeState()).toEqual(before)
      expect(bg(["ls-files", "psyche/LORE.md"])).toBe("psyche/LORE.md")
    })
  })

  describe("the branch on rollback", () => {
    const head = () => bg(["rev-parse", "HEAD"])
    // An owner commit straight onto GitHub's main.
    const ownerPush = `t=$(git --git-dir="${"$"}{T_ROOT}/github/sanctuary.ouro.git" rev-parse "main^{tree}") && c=$(git -c user.name=owner -c user.email=owner@example.invalid --git-dir="${"$"}{T_ROOT}/github/sanctuary.ouro.git" commit-tree "$t" -p main -m owner) && git --git-dir="${"$"}{T_ROOT}/github/sanctuary.ouro.git" update-ref refs/heads/main "$c"`

    it("keeps a commit that reached GitHub although its push failed on the host", () => {
      const start = head()
      // GitHub takes step 9's push, then the connection dies before the host hears back.
      write(path.join(remote, "hooks/reference-transaction"), `#!/bin/sh
[ "$1" = committed ] || exit 0
grep -q "^${start} " || exit 0
kill -9 $PPID
`, 0o755)
      const result = run("--apply")
      expect(result.status).toBe(1)
      expect(result.out).toContain("cutover failed at step 9")
      const github = rg(["rev-parse", "main"])
      expect(github).not.toBe(start)
      expect(result.out).toContain(`kept the branch: GitHub already has ${github}`)
      expect(result.out).toContain("rolled back:")
      expect(head()).toBe(github)
      expect(fs.existsSync(incomplete())).toBe(false)
    })

    it("keeps the branch when GitHub moved on, and flags that the hourly backup cannot push", () => {
      const result = run("--apply", { STUB_AUDIT_STATUS: "1", STUB_AUDIT_HOOK: ownerPush })
      expect(result.status).toBe(1)
      expect(result.out).toContain("cutover failed at step 15")
      const github = rg(["rev-parse", "main"])
      expect(rg(["log", "-1", "--format=%an", "main"])).toBe("owner")
      expect(result.out).toContain(`kept the branch: GitHub already has ${github}`)
      expect(head()).toBe(rg(["rev-parse", "main~1"]))
      expect(result.out).toContain("the hourly backup can't push; GitHub has commits the host doesn't")
      expect(result.out).toContain("ROLLBACK INCOMPLETE: these steps failed: check the hourly backup can push. The Butler is running.")
    })

    it("leaves the branch and records why when GitHub cannot be read", () => {
      stub("git", `case "$*" in *" ls-remote origin refs/heads/main") echo "stub: no route" >&2; exit 128 ;; esac\nexec "${REAL_GIT}" "$@"`)
      const result = run("--apply", { STUB_AUDIT_STATUS: "1" })
      expect(result.status).toBe(1)
      const pushed = rg(["rev-parse", "main"])
      expect(head()).toBe(pushed)
      expect(result.out).toContain(`could not read GitHub's main (ls-remote failed), so the branch was left at ${pushed}`)
      expect(fs.readFileSync(incomplete(), "utf8")).toContain("failed: drop an apply commit GitHub never got\n")
    })

    it("still drops an unpushed commit when GitHub's main is the step-4 head", () => {
      write(path.join(T, "exclude.txt"), `${sanctuaryGitExcludeText()}psyche/LORE.md\n`)
      const start = head()
      const result = run("--apply")
      expect(result.out).toContain(`reset the branch to ${start}, dropping a commit GitHub never got`)
      expect(head()).toBe(start)
      expect(rg(["rev-parse", "main"])).toBe(start)
      expect(result.out).toContain("rollback: check the hourly backup can push: ok")
    })
  })

  describe("signals", () => {
    it.each([
      ["SIGINT", "^stop ouro-butler", "step 1"],
      ["SIGTERM", "^run --rm -i", "step 10"],
      ["SIGTERM", "^start ouro-butler", "step 15"],
    ])("%s during the apply (%s) rolls back to the exact before-state", (signal, match, step) => {
      const before = beforeState()
      const result = run("--apply", { STUB_SIGNAL_MATCH: match, STUB_SIGNAL: signal.replace("SIG", "") })
      expect(fs.existsSync(path.join(T, "signalled"))).toBe(true)
      expect(result.status).toBe(1)
      expect(result.out).toContain(`cutover failed at ${step} (exit 130); rolling back`)
      expect(result.out).toContain("rolled back:")
      expect(beforeState()).toEqual(before)
    })

    it.each([
      ["SIGTERM", "^inspect --format \\{\\{\\.State\\.Running"],
      ["SIGINT", "^inspect --format \\{\\{\\.State\\.Running"],
      ["SIGHUP", "^inspect --format \\{\\{\\.State\\.Running"],
    ])("%s during an apply's rollback is ignored, and the rollback finishes", (signal, match) => {
      const before = beforeState()
      const result = run("--apply", { STUB_AUDIT_STATUS: "1", STUB_SIGNAL_MATCH: match, STUB_SIGNAL: signal.replace("SIG", "") })
      expect(fs.existsSync(path.join(T, "signalled"))).toBe(true)
      expect(result.status).toBe(1)
      expect(result.out).toContain("rolled back:")
      expect(beforeState()).toEqual(before)
    })

    it.each(["TERM", "INT"])("SIG%s during --rollback is ignored, and the rollback finishes", (signal) => {
      const before = beforeState()
      expect(run("--apply").status).toBe(0)
      const result = run("--rollback", { STUB_SIGNAL_MATCH: "^stop ouro-butler", STUB_SIGNAL: signal })
      expect(fs.existsSync(path.join(T, "signalled"))).toBe(true)
      expect(result.status, result.out).toBe(0)
      expect(beforeState()).toEqual(before)
    })

    it("losing the foreground never stops the detached apply", async () => {
      const child = spawn("bash", [SCRIPT, "--apply"], { env: { ...env, STUB_SLEEP_MATCH: "^stop ouro-butler" }, stdio: ["ignore", "pipe", "pipe"] })
      let out = ""
      child.stdout.on("data", (data) => { out += data })
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
      await waitFor(() => out.includes("1. stopping"))
      child.kill("SIGHUP")
      expect(await exited).toBe(130)
      expect(out).toContain("stopped following. The run continues detached")
      const log = path.join(backup(), logs()[0]!)
      await waitFor(() => fs.existsSync(`${log}.status`))
      expect(fs.readFileSync(`${log}.status`, "utf8")).toBe("0\n")
      expect(fs.readFileSync(log, "utf8")).toContain("cutover done.")
      expect(fs.existsSync(path.join(backup(), "cutover-done"))).toBe(true)
      expect(fs.readFileSync(path.join(T, "container"), "utf8")).toBe("running\n")
      // The detached run is its own session, not the foreground's child.
      expect(Number(fs.readFileSync(`${log}.pid`, "utf8"))).not.toBe(child.pid)
    })
  })

  describe("rollback", () => {
    it("refuses at once while an apply holds the cutover lock, and changes nothing", async () => {
      expect(run("--apply").status).toBe(0)
      write(path.join(backup(), "cutover-applying"), "before: x\nlog: /the/apply.log\n")
      const holder = hasFlock ? spawn("flock", [path.join(backup(), "cutover.lock"), "-c", "sleep 30"], { stdio: "ignore" }) : undefined
      try {
        if (holder) await waitFor(() => spawnSync("flock", ["-n", path.join(backup(), "cutover.lock"), "true"]).status !== 0)
        const before = snapshot(T, noise)
        const started = Date.now()
        const result = run("--rollback", { STUB_CUTOVER_LOCK_BUSY: "1" })
        expect(result.status).toBe(1)
        expect(result.out).toContain("an apply is running (log: /the/apply.log); it rolls itself back on failure. Run --rollback after it ends")
        expect(Date.now() - started).toBeLessThan(15_000)
        expect(snapshot(T, noise)).toEqual(before)
      } finally {
        holder?.kill()
      }
    })

    it("refuses --apply and --rollback read from stdin, before any change", () => {
      const before = snapshot(T, noise)
      for (const mode of ["--apply", "--rollback"]) {
        const result = spawnSync("bash", ["-s", "--", mode], { input: SOURCE, encoding: "utf8", env })
        expect(result.status).toBe(1)
        expect(result.stderr).toBe("cutover: run this script from a file, not stdin\n")
      }
      expect(snapshot(T, noise)).toEqual(before)
      expect(dockerLog()).toEqual([])
    })

    it("says there is nothing to roll back, and touches nothing, before any cutover", () => {
      const before = snapshot(T, (rel) => rel === "docker.log")
      const result = run("--rollback")
      expect(result.status).toBe(0)
      expect(result.stdout).toBe("nothing to roll back: no cutover marker and no .git in the bundle\n")
      expect(snapshot(T, (rel) => rel === "docker.log")).toEqual(before)
      expect(dockerLog()).toEqual([])
    })

    it("restores the before-state exactly after a full apply, and keeps the pushed commits", () => {
      fs.chmodSync(repoGit(), 0o750)
      const before = beforeState()
      expect(before.mode).toBe(0o750)
      expect(run("--apply").status).toBe(0)
      const pushed = rg(["rev-parse", "main"])
      const result = run("--rollback")
      expect(result.status, result.out).toBe(0)
      expect(result.out).toContain("The Butler is running.")
      expect(beforeState()).toEqual(before)
      expect(rg(["rev-parse", "main"])).toBe(pushed)
      expect(dockerLog().filter((line) => /^(stop|start) /u.test(line)).slice(-2)).toEqual(["stop ouro-butler", "start ouro-butler"])
      expect(fs.existsSync(path.join(appdata(), "sync/deploy_key"))).toBe(false)
    })

    it("puts back repo.git's config, hooks and attributes before any git, so nothing the Butler planted in .git runs as root (C1)", () => {
      const configBefore = fs.readFileSync(path.join(repoGit(), "config"))
      const hooksBefore = fs.readdirSync(path.join(repoGit(), "hooks")).sort()
      const before = beforeState()
      expect(run("--apply").status).toBe(0)
      const snapshots = fs.readdirSync(backup()).filter((name) => /^cutover-git-snapshot-.*\.tar$/u.test(name))
      expect(snapshots).toHaveLength(1)
      expect(fs.statSync(path.join(backup(), snapshots[0]!)).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(path.join(backup(), "cutover-done"), "utf8")).toContain(`git snapshot: ${path.join(backup(), snapshots[0]!)}\ngit snapshot hooks: present\ngit snapshot attributes: absent\n`)

      // What a prompt-injected Butler could write into the .git it owns from step 13: a clean filter (in config and through an
      // [include]), an ext:: push URL, a worktree config, and hooks.
      const gitDir = path.join(bundle(), ".git")
      const marker = (name: string) => path.join(T, `planted-${name}`)
      const markers = ["filter", "include", "ext", "worktree", "hook-pre-push", "hook-reference-transaction", "hook-pre-commit", "hook-post-commit"]
      write(path.join(T, "planted.inc"), `[filter "inc"]\n\tclean = touch ${marker("include")} && cat\n`)
      fs.appendFileSync(path.join(gitDir, "config"), [
        `[filter "pwn"]\n\tclean = touch ${marker("filter")} && cat\n`,
        `[include]\n\tpath = ${path.join(T, "planted.inc")}\n`,
        `[protocol "ext"]\n\tallow = always\n`,
        `[remote "origin"]\n\tpushurl = ext::sh -c touch% ${marker("ext")}\n`,
        `[extensions]\n\tworktreeConfig = true\n`,
      ].join(""))
      write(path.join(gitDir, "config.worktree"), `[filter "wt"]\n\tclean = touch ${marker("worktree")} && cat\n`)
      write(path.join(gitDir, "info/attributes"), "*.json filter=pwn\n*.md filter=inc\nagent.json filter=wt\n")
      for (const hook of ["pre-push", "reference-transaction", "pre-commit", "post-commit"]) write(path.join(gitDir, "hooks", hook), `#!/bin/sh\ntouch ${marker(`hook-${hook}`)}\n`, 0o755)
      write(path.join(bundle(), "psyche/SOUL.md"), "# SOUL.md\nchanged by a turn\n")
      write(path.join(bundle(), "friends/f1.json"), "{\"changed\":true}\n")

      // The plants work: root's own git calls, hooks off, on a copy of the planted .git, run every config route.
      const copy = path.join(T, "planted-copy.git")
      fs.cpSync(gitDir, copy, { recursive: true })
      git(["-c", "core.hooksPath=/dev/null", `--git-dir=${copy}`, `--work-tree=${bundle()}`, "add", "-A"])
      spawnSync("git", ["-c", "core.hooksPath=/dev/null", `--git-dir=${copy}`, `--work-tree=${bundle()}`, "push", "--dry-run", "origin", "HEAD:main"], { env, encoding: "utf8" })
      fs.rmSync(copy, { recursive: true, force: true })
      expect(markers.filter((name) => fs.existsSync(marker(name)))).toEqual(["filter", "include", "ext", "worktree"])
      for (const name of markers) fs.rmSync(marker(name), { force: true })

      const result = run("--rollback")
      expect(result.status, result.out).toBe(0)
      expect(markers.filter((name) => fs.existsSync(marker(name)))).toEqual([])
      // The restore runs right after the move, before the first step that runs git.
      const order = ["move .git back to repo.git: ok", "give repo.git back to root and put back its config, hooks and attributes: ok", "restore repo.git's config, branch and exclude: ok", "check the hourly backup can push: ok"]
      expect(order.map((line) => result.out.indexOf(`rollback: ${line}`))).toEqual([...order.map((line) => result.out.indexOf(`rollback: ${line}`))].sort((a, b) => a - b))
      expect(order.every((line) => result.out.includes(`rollback: ${line}`))).toBe(true)

      // config byte for byte, no worktree config or attributes, and every planted hook moved aside, not deleted.
      expect(fs.readFileSync(path.join(repoGit(), "config")).equals(configBefore)).toBe(true)
      expect(fs.existsSync(path.join(repoGit(), "config.worktree"))).toBe(false)
      expect(fs.existsSync(path.join(repoGit(), "info/attributes"))).toBe(false)
      const hooks = fs.readdirSync(path.join(repoGit(), "hooks")).sort()
      expect(hooks.filter((name) => !name.includes(".disabled-"))).toEqual(hooksBefore)
      for (const hook of ["pre-push", "reference-transaction", "pre-commit", "post-commit"]) {
        expect(hooks.filter((name) => name.startsWith(`${hook}.disabled-`)), hook).toHaveLength(1)
      }
      expect(beforeState()).toEqual(before)

      // backup.sh's next run: root's git with hooks on, on the restored repo, runs nothing the Butler planted.
      bg(["add", "-A"])
      bg(["-c", "user.name=backup", "-c", "user.email=backup@example.invalid", "commit", "-q", "-m", "hourly backup"])
      bg(["push", "-q", "--dry-run", "origin", "HEAD:main"])
      expect(markers.filter((name) => fs.existsSync(marker(name)))).toEqual([])
    })

    it("moves aside a commondir before any git (C1)", () => {
      expect(run("--apply").status).toBe(0)
      const elsewhere = path.join(T, "elsewhere")
      fs.mkdirSync(elsewhere, { recursive: true })
      write(path.join(bundle(), ".git/commondir"), `${elsewhere}\n`)
      const result = run("--rollback")
      expect(result.status, result.out).toBe(0)
      expect(fs.readdirSync(repoGit()).filter((entry) => entry.startsWith("commondir.disabled-"))).toHaveLength(1)
      expect(fs.existsSync(path.join(repoGit(), "commondir"))).toBe(false)
      expect(fs.readFileSync(path.join(repoGit(), "info/exclude"), "utf8")).toBe(OLD_EXCLUDE)
      expect(result.out).toContain("rollback: restore the backup cron: ok")
      expect(fs.readFileSync(cronTable(), "utf8")).toContain("backup.sh")
      expect(fs.readdirSync(elsewhere)).toEqual([])
    })

    /** Plants links in the Butler-owned .git, rolls back with host git logged, and checks nothing ran on repo.git (N1). */
    function rollBackOverLinks(plant: (gitDir: string) => void): ReturnType<typeof run> {
      expect(run("--apply").status).toBe(0)
      plant(path.join(bundle(), ".git"))
      stub("git", `printf '%s\\n' "$*" >>"${T}/host-git.log"\nexec "${REAL_GIT}" "$@"`)
      const result = run("--rollback")
      expect(result.status).toBe(1)
      expect(result.out).toContain("a real repo.git holds no links), then run --rollback again")
      expect(result.out).toContain("rollback: give repo.git back to root and put back its config, hooks and attributes: FAILED")
      for (const step of ["restore repo.git's config, branch and exclude", "drop an apply commit GitHub never got", "restore the backup cron", "check the hourly backup can push"]) {
        expect(result.out).toContain(`rollback: ${step}: FAILED`)
      }
      expect(result.out.match(/skipped: repo\.git's config and hooks were not put back, so no git runs on it/gu)).toHaveLength(4)
      expect(fs.existsSync(path.join(T, "host-git.log"))).toBe(false)
      expect(fs.existsSync(incomplete())).toBe(true)
      // The hourly root backup stays off.
      expect(fs.existsSync(cronFile())).toBe(false)
      expect(fs.readFileSync(cronTable(), "utf8")).not.toContain("backup.sh")
      return result
    }

    it("refuses a repo.git with a link in objects/ (or a hooks or info link): no git, nothing written outside, no cron (N1)", () => {
      const outside = path.join(T, "outside-dir")
      const elsewhere = path.join(T, "elsewhere")
      fs.mkdirSync(outside, { recursive: true })
      write(path.join(elsewhere, "hooks/pre-push"), `#!/bin/sh\ntouch ${path.join(T, "planted-linked-hook")}\n`, 0o755)
      const result = rollBackOverLinks((gitDir) => {
        fs.symlinkSync(outside, path.join(gitDir, "objects/xx"))
        fs.renameSync(path.join(gitDir, "hooks"), path.join(T, "real-hooks"))
        fs.symlinkSync(path.join(elsewhere, "hooks"), path.join(gitDir, "hooks"))
        fs.renameSync(path.join(gitDir, "info"), path.join(T, "real-info"))
        fs.symlinkSync(elsewhere, path.join(gitDir, "info"))
      })
      expect(result.out).toContain(`${repoGit()} holds a symbolic link, ${repoGit()}/`)
      expect(result.out).toMatch(/holds a symbolic link, \S+\/(objects\/xx|hooks|info): move it aside/u)
      expect(fs.readdirSync(outside)).toEqual([])
      expect(fs.readdirSync(elsewhere).sort()).toEqual(["hooks"])
      expect(fs.readdirSync(path.join(elsewhere, "hooks"))).toEqual(["pre-push"])
      expect(fs.existsSync(path.join(T, "planted-linked-hook"))).toBe(false)
    })

    it("refuses a repo.git whose logs/HEAD links to a host file, and leaves that file as it was (N1)", () => {
      const hostFile = path.join(T, "host-file")
      write(hostFile, "the host's own content\n", 0o644)
      const result = rollBackOverLinks((gitDir) => {
        fs.rmSync(path.join(gitDir, "logs/HEAD"), { force: true })
        fs.mkdirSync(path.join(gitDir, "logs"), { recursive: true })
        fs.symlinkSync(hostFile, path.join(gitDir, "logs/HEAD"))
      })
      expect(result.out).toContain(`${repoGit()} holds a symbolic link, ${repoGit()}/logs/HEAD: move it aside`)
      expect(fs.readFileSync(hostFile, "utf8")).toBe("the host's own content\n")
    })

    it("runs no git at all when the snapshot to restore from is gone, and the rollback is incomplete (C1)", () => {
      expect(run("--apply").status).toBe(0)
      const done = path.join(backup(), "cutover-done")
      const snapshot = /^git snapshot: (.*)$/mu.exec(fs.readFileSync(done, "utf8"))![1]!
      fs.rmSync(snapshot)
      write(path.join(bundle(), ".git/hooks/pre-push"), `#!/bin/sh\ntouch ${path.join(T, "planted-late-hook")}\n`, 0o755)
      const blind = run("--rollback")
      expect(blind.status).toBe(1)
      expect(blind.out).toContain(`the git snapshot ${snapshot} is missing, so no git runs on ${repoGit()}`)
      for (const step of ["restore repo.git's config, branch and exclude", "drop an apply commit GitHub never got", "restore the backup cron", "check the hourly backup can push"]) {
        expect(blind.out).toContain(`rollback: ${step}: FAILED`)
      }
      expect(blind.out.match(/skipped: repo\.git's config and hooks were not put back, so no git runs on it/gu)).toHaveLength(4)
      expect(fs.readFileSync(cronTable(), "utf8")).not.toContain("backup.sh")
      expect(fs.readFileSync(incomplete(), "utf8")).toContain(`git snapshot: ${snapshot}\n`)
      expect(fs.existsSync(path.join(T, "planted-late-hook"))).toBe(false)
    })

    it("keeps a sync key and a sync value that were there before", () => {
      const original = `${JSON.stringify({ name: "sanctuary", sync: { enabled: false, branch: "main", extra: 1 } }, null, 2)}\n`
      write(path.join(bundle(), "agent.json"), original, 0o640)
      write(path.join(appdata(), "sync/deploy_key"), "an older throwaway\n", 0o400)
      expect(run("--apply").status).toBe(0)
      expect(JSON.parse(fs.readFileSync(path.join(bundle(), "agent.json"), "utf8")).sync).toEqual({ enabled: true, branch: "main", extra: 1 })
      expect(run("--rollback").status).toBe(0)
      expect(fs.readFileSync(path.join(bundle(), "agent.json"), "utf8")).toBe(original)
      expect(fs.existsSync(path.join(appdata(), "sync/deploy_key"))).toBe(true)
    })

    it("writes ROLLBACK-INCOMPLETE and says loudly whether the Butler runs when a step fails, and a second --rollback finishes", () => {
      const before = beforeState()
      expect(run("--apply").status).toBe(0)
      const saved = path.join(backup(), beforeFiles()[0]!)
      const text = fs.readFileSync(saved, "utf8")
      fs.writeFileSync(saved, text.replace(/^core\.bare: .*\n/mu, ""))
      const result = run("--rollback")
      expect(result.status).toBe(1)
      expect(result.out).toContain("rollback: restore repo.git's config, branch and exclude: FAILED")
      expect(result.out).toContain("ROLLBACK INCOMPLETE: these steps failed: restore repo.git's config, branch and exclude. The Butler is running.")
      // Every other step still ran.
      expect(result.out).toContain("rollback: restore the backup cron: ok")
      const record = fs.readFileSync(incomplete(), "utf8")
      expect(record).toContain(`before: ${saved}\n`)
      expect(record).toContain("failed: restore repo.git's config, branch and exclude\n")
      expect(record).toContain("butler: running\n")
      // A dry run and an apply refuse until the rollback finishes.
      expect(run("--apply").out).toContain("a rollback did not finish")

      fs.writeFileSync(saved, text)
      const again = run("--rollback")
      expect(again.status, again.out).toBe(0)
      expect(fs.existsSync(incomplete())).toBe(false)
      expect(beforeState()).toEqual(before)
    })

    it("says the Butler is STOPPED when it cannot start it", () => {
      expect(run("--apply").status).toBe(0)
      const result = run("--rollback", { STUB_FAIL_MATCH: "^start ouro-butler" })
      expect(result.status).toBe(1)
      expect(result.out).toContain("ROLLBACK INCOMPLETE: these steps failed: start the Butler, check the Butler is running. The Butler is STOPPED.")
      expect(fs.readFileSync(incomplete(), "utf8")).toContain("butler: STOPPED\n")
      const again = run("--rollback")
      expect(again.status, again.out).toBe(0)
      expect(fs.readFileSync(path.join(T, "container"), "utf8")).toBe("running\n")
    })

    it("removes a stale index.lock only when no git runs on the host or in the container", () => {
      expect(run("--apply").status).toBe(0)
      write(path.join(bundle(), ".git/index.lock"), "")
      const busy = run("--rollback", { STUB_PGREP: "0" })
      expect(busy.status).toBe(1)
      expect(busy.out).toContain("a git process is running on the host")
      expect(fs.existsSync(path.join(repoGit(), "index.lock"))).toBe(true)
      const clear = run("--rollback")
      expect(clear.status, clear.out).toBe(0)
      expect(clear.out).toContain(`removed a stale ${repoGit()}/index.lock (no git was running)`)
      expect(fs.existsSync(path.join(repoGit(), "index.lock"))).toBe(false)
    })
  })

  describe("verify-live", () => {
    beforeEach(() => {
      expect(run("--apply").status).toBe(0)
      fs.writeFileSync(path.join(T, "docker.log"), "")
    })

    it("runs no host git once the Butler owns .git: not in --verify-live, a dry run or an apply run again (C1)", () => {
      stub("git", `printf '%s\\n' "$*" >>"${T}/host-git.log"\nexec "${REAL_GIT}" "$@"`)
      expect(run("--verify-live").status).toBe(0)
      expect(run().status).toBe(1)
      const again = run("--apply")
      expect(again.status).toBe(1)
      expect(again.out).toContain(`${repoGit()} is missing`)
      expect(fs.existsSync(path.join(T, "host-git.log"))).toBe(false)
    })

    it("reaches GitHub through the sync path, proves the key unreadable, stalls a fetch behind one owner-scoped rule, and syncs again", () => {
      const result = run("--verify-live")
      expect(result.status, result.out).toBe(0)
      expect(dockerLog()).toEqual([
        `exec -u 10001 -e GIT_SSH_COMMAND=sudo -n -u ouro-sync /usr/local/libexec/ouro-sync-ssh -e GIT_SSH_VARIANT=ssh ouro-butler git ls-remote ${BUNDLE_REMOTE} refs/heads/main`,
        "exec -u 10001 ouro-butler cat /run/ouro-sync/deploy_key",
        "exec -u 10001 ouro-butler test -r /run/ouro-sync/deploy_key",
        "exec ouro-butler id -u ouro-sync",
        `iptables -I ${RULE}`,
        "exec -u 10001 ouro-butler timeout 60 node /opt/ouro/dist/heart/daemon/ouro-entry.js sync --agent sanctuary",
        `iptables -D ${RULE}`,
        `iptables -C ${RULE}`,
        "exec ouro-butler ps -u 10002 -o pid=",
        "exec -u 10001 ouro-butler timeout 60 node /opt/ouro/dist/heart/daemon/ouro-entry.js sync --agent sanctuary",
      ])
      expect(result.stdout).toContain("verify-live ok")
      expect(fs.readFileSync(path.join(T, "iptables"), "utf8")).toBe("")
    })

    it.each([
      ["a sync that does not stall", { STUB_STALLED_STATUS: "0" }, "ouro sync succeeded while TCP 22 was dropped"],
      ["a paused sync", { STUB_STALL_OUTPUT: "sync paused (state/sync-paused); not syncing" }, "ouro sync was paused, so the stall proves nothing"],
      ["a fast failure that is not a stall", { STUB_STALL_OUTPUT: "fatal: not a git repository" }, "failed without a timeout or a connect failure"],
      ["ouro-sync processes left running", { STUB_LEFTOVER: "4242" }, "ouro-sync processes outlived the stalled sync: 4242"],
      ["an unreachable GitHub", { STUB_LS_REMOTE: "" }, "returned no main"],
      ["a readable key", { STUB_KEY_READABLE: "0" }, "the Butler's uid can read /run/ouro-sync/deploy_key"],
      ["a key check that could not run", { STUB_KEY_READABLE: "127" }, "the check could not run: docker exec -u 10001 ouro-butler cat"],
      ["a sync user with another uid", { STUB_SYNC_UID: "1234" }, 'the image\'s ouro-sync uid is "1234", not 10002'],
      ["a rule that will not go", { STUB_IPTABLES_STUCK: "1" }, "THE IPTABLES RULE IS STILL IN PLACE"],
    ])("fails on %s", (_name, extra, message) => {
      const result = run("--verify-live", extra)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(message)
      if (!("STUB_IPTABLES_STUCK" in extra)) expect(fs.existsSync(path.join(T, "iptables")) ? fs.readFileSync(path.join(T, "iptables"), "utf8") : "").toBe("")
    })

    it("fails a stalled sync that runs past the limit", () => {
      expect(SOURCE).toContain("\nSTALL_LIMIT_S=25\n")
      const late = run("--verify-live", { STUB_STALL_S: "2", OURO_CUTOVER_STALL_LIMIT_S: "1" })
      expect(late.status).toBe(1)
      expect(late.stderr).toMatch(/the stalled ouro sync took [2-9]s; it must end within 1s/u)
      expect(fs.readFileSync(path.join(T, "iptables"), "utf8")).toBe("")
    })

    it("removes the rule when interrupted mid-stall", () => {
      const result = spawnSync("bash", ["-c", `bash "${SCRIPT}" --verify-live & pid=$!; while ! grep -q DROP "${T}/iptables" 2>/dev/null; do sleep 0.1; done; kill -TERM $pid; wait $pid`], { encoding: "utf8", env: { ...env, STUB_STALL_S: "2" }, timeout: 30_000 })
      expect(result.status).toBe(130)
      expect(fs.readFileSync(path.join(T, "iptables"), "utf8")).toBe("")
      expect(dockerLog()).toContain(`iptables -C ${RULE}`)
    })

    it("refuses before the cutover", () => {
      fs.rmSync(path.join(backup(), "cutover-done"))
      expect(run("--verify-live").stderr).toContain("the cutover is not done")
    })
  })

  it.skipIf(!isRootLinux)("as root, applies over a work tree another uid owns and leaves .git and the key with the real owners", () => {
    spawnSync("chown", ["-R", "10001:10001", bundle()])
    const result = run("--apply")
    expect(result.status, result.out).toBe(0)
    expect(spawnSync("find", [path.join(bundle(), ".git"), "!", "-uid", "10001"], { encoding: "utf8" }).stdout).toBe("")
    const key = fs.statSync(path.join(appdata(), "sync/deploy_key"))
    expect([key.uid, key.gid, key.mode & 0o7777]).toEqual([10002, 10002, 0o400])
    expect(fs.statSync(path.join(appdata(), "sync")).uid).toBe(0)
    expect(run("--rollback").status).toBe(0)
    expect(spawnSync("find", [repoGit(), "!", "-uid", "0"], { encoding: "utf8" }).stdout).toBe("")
  })
})
