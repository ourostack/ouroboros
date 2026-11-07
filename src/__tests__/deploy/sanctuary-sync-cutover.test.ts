// The host-side cutover (deploy/unraid/sanctuary-sync-cutover.sh), run for real against a fake appdata tree with a real
// bare remote standing in for GitHub. docker, update_cron, iptables (and flock where the host has none) are stubs on PATH.
// A test that is not root owns every role (OURO_CUTOVER_OWNER); the Linux root test uses the real uids.
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SANCTUARY_PACKAGE_MANAGED_FILES, sanctuaryGitExcludeText } from "../../heart/daemon/sanctuary-bundle-migration"

const SCRIPT = path.resolve(__dirname, "../../../deploy/unraid/sanctuary-sync-cutover.sh")
const GATE = path.resolve(__dirname, "../../../deploy/unraid/sanctuary-replay-gate.mjs")
const SOURCE = fs.readFileSync(SCRIPT, "utf8")
const BUNDLE_REMOTE = "git@github.com:arimendelow/sanctuary.ouro.git"
const OLD_REMOTE = "git@github-backup:arimendelow/sanctuary.ouro.git"
const IMAGE = `sha256:${"a".repeat(64)}`
const isRootLinux = process.platform === "linux" && process.getuid?.() === 0
const hasFlock = spawnSync("sh", ["-c", "command -v flock"]).status === 0
const OLD_EXCLUDE = "**/credentials.json\nstate/\ninbox/\n"
const PSYCHE = ["ASPIRATIONS.md", "IDENTITY.md", "LORE.md", "SOUL.md", "TACIT.md"]

let T: string
let remote: string
let env: NodeJS.ProcessEnv

const appdata = () => path.join(T, "mnt/user/appdata/ouro-butler")
const bundle = () => path.join(appdata(), "agent/sanctuary.ouro")
const backup = () => path.join(appdata(), "bundle-backup")
const repoGit = () => path.join(backup(), "repo.git")
const cronFile = () => path.join(T, "boot/config/plugins/dynamix/sanctuary-bundle-backup.cron")
const cronTable = () => path.join(T, "etc/cron.d/root")

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

function stub(name: string, body: string) {
  write(path.join(T, "stub-bin", name), `#!/bin/sh\n${body}\n`, 0o755)
}

/** Points both remote URLs at the bare remote, the way GitHub would answer them. */
function redirect(target = `file://${remote}`) {
  env.GIT_CONFIG_COUNT = "2"
  env.GIT_CONFIG_KEY_0 = `url.${target}.insteadOf`
  env.GIT_CONFIG_VALUE_0 = BUNDLE_REMOTE
  env.GIT_CONFIG_KEY_1 = `url.file://${remote}.insteadOf`
  env.GIT_CONFIG_VALUE_1 = OLD_REMOTE
}

function setup() {
  T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-cutover-")))
  remote = path.join(T, "github/sanctuary.ouro.git")
  env = {
    PATH: `${path.join(T, "stub-bin")}:${process.env.PATH}`,
    HOME: path.join(T, "home"),
    GIT_CONFIG_NOSYSTEM: "1",
    TMPDIR: path.join(T, "tmp"),
    OURO_CUTOVER_ROOT: T,
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
  write(cronFile(), "17 * * * * /mnt/user/appdata/ouro-butler/bundle-backup/backup.sh >/dev/null 2>&1\n")
  write(cronTable(), "# generated\n17 * * * * /mnt/user/appdata/ouro-butler/bundle-backup/backup.sh >/dev/null 2>&1\n")
  write(path.join(T, "exclude.txt"), sanctuaryGitExcludeText())
  fs.mkdirSync(path.join(T, "usr/local/bin"), { recursive: true })
  fs.symlinkSync(process.execPath, path.join(T, "usr/local/bin/node"))
  write(path.join(T, "container"), "running\n")

  // docker: records each call; the container's state, the release's exclude list, the git timing and the audit come from files and env.
  stub("docker", `printf '%s\\n' "$*" >>"${T}/docker.log"
if [ -n "\${STUB_FAIL_MATCH:-}" ] && printf '%s' "$*" | grep -Eq "$STUB_FAIL_MATCH"; then echo "stub: failing $1" >&2; exit 1; fi
case "$*" in
  "inspect --format {{.Image}} ouro-butler") echo ${IMAGE} ;;
  "inspect --format {{.Config.Image}} ouro-butler") echo ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.990 ;;
  "inspect --format {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}} ouro-butler") echo "\${STUB_IP-172.17.0.5} " ;;
  "inspect ouro-butler" | "image inspect ${IMAGE}") echo '[{}]' ;;
  "stop ouro-butler") echo stopped >"${T}/container"; echo ouro-butler ;;
  "start ouro-butler") echo running >"${T}/container"; echo ouro-butler ;;
  run*"sanctuary git-exclude --print") cat "${T}/exclude.txt"; echo ;;
  run*"--user 10001:10001"*) echo "\${STUB_TIMINGS:-12 34}" ;;
  run*audit-container-spec.sh*) exit "\${STUB_AUDIT_STATUS:-0}" ;;
  "exec -u 10001 ouro-butler test -r /run/ouro-sync/deploy_key") exit "\${STUB_KEY_READABLE:-1}" ;;
  "exec -u 10001 ouro-butler cat /run/ouro-sync/deploy_key") exit "\${STUB_KEY_READABLE:-1}" ;;
  "exec -u 10001 -e GIT_SSH_COMMAND=sudo -n -u ouro-sync /usr/local/libexec/ouro-sync-ssh -e GIT_SSH_VARIANT=ssh ouro-butler git ls-remote ${BUNDLE_REMOTE} refs/heads/main") echo "\${STUB_LS_REMOTE-0123abcd	refs/heads/main}" ;;
  "exec -u 10001 ouro-butler timeout 60 node /opt/ouro/dist/heart/daemon/ouro-entry.js sync --agent sanctuary")
    if grep -q DROP "${T}/iptables" 2>/dev/null; then sleep "\${STUB_STALL_S:-0}"; exit "\${STUB_STALLED_STATUS:-1}"; fi
    echo "synced sanctuary" ;;
  "exec ouro-butler ps -u 10002 -o pid=") printf '%s' "\${STUB_LEFTOVER:-}" ;;
  *) echo "stub docker: unexpected: $*" >&2; exit 97 ;;
esac`)
  // update_cron regenerates the table from the cron files, as Unraid's does.
  stub("update_cron", `echo "# generated" >"${cronTable()}"; cat "${path.dirname(cronFile())}"/*.cron >>"${cronTable()}" 2>/dev/null; echo update_cron >>"${T}/docker.log"; exit 0`)
  stub("iptables", `printf 'iptables %s\\n' "$*" >>"${T}/docker.log"
case "$1" in
  -I) shift; printf '%s\\n' "$*" >>"${T}/iptables" ;;
  -D) shift; grep -vxF "$*" "${T}/iptables" >"${T}/iptables.new" || true; mv "${T}/iptables.new" "${T}/iptables" ;;
esac`)
  if (!hasFlock) stub("flock", "exit 0")
}

function run(mode?: string, extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync("bash", [SCRIPT, ...(mode ? [mode] : [])], { encoding: "utf8", env: { ...env, ...extra }, timeout: 60_000 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const dockerLog = () => (fs.existsSync(path.join(T, "docker.log")) ? fs.readFileSync(path.join(T, "docker.log"), "utf8").trim().split("\n") : [])

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

/** What a rollback must put back: the backup repository's config, branch, upstream and exclude, the cron, and the layout. */
function beforeState() {
  return {
    config: bg(["config", "--local", "--list"]).split("\n").sort(),
    branch: bg(["symbolic-ref", "--short", "HEAD"]),
    exclude: fs.readFileSync(path.join(repoGit(), "info/exclude"), "utf8"),
    owners: [...new Set(Object.values(snapshot(repoGit())).map((entry) => entry.split(" ")[2]))],
    cron: fs.readFileSync(cronFile(), "utf8"),
    cronTable: fs.readFileSync(cronTable(), "utf8"),
    bundleGit: fs.existsSync(path.join(bundle(), ".git")),
    marker: fs.existsSync(path.join(backup(), "cutover-done")),
    disabledCron: fs.existsSync(path.join(backup(), "sanctuary-bundle-backup.cron.disabled")),
    container: fs.readFileSync(path.join(T, "container"), "utf8"),
    syncKey: fs.existsSync(path.join(appdata(), "sync/deploy_key")),
  }
}

beforeEach(() => setup())
afterEach(() => fs.rmSync(T, { recursive: true, force: true }))

describe("sanctuary-sync-cutover.sh", () => {
  it("is bash, passes bash -n, and names the repository and branch once at the top", () => {
    expect(SOURCE.startsWith("#!/bin/bash\n")).toBe(true)
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0)
    expect(fs.statSync(SCRIPT).mode & 0o777).toBe(0o755)
    expect(SOURCE).toContain("\nBUNDLE_REPO_OWNER=arimendelow\nBUNDLE_REPO_NAME=sanctuary.ouro\nBUNDLE_REMOTE=\"git@github.com:${BUNDLE_REPO_OWNER}/${BUNDLE_REPO_NAME}.git\"\nBUNDLE_BRANCH=main\n")
    expect(SOURCE).toContain("\nBUTLER_OWNER=10001:10001\nSYNC_OWNER=10002:10002\nROOT_OWNER=0:0\n")
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
    const gate = fs.readFileSync(GATE, "utf8")
    const gateCalls = code(gate).filter((line) => /["'`]git["'`]/u.test(line))
    expect(gateCalls).toHaveLength(1)
    expect(gateCalls[0]).toMatch(/--git-dir=/u)
    expect(gateCalls[0]).toMatch(/--work-tree=/u)
  })

  it("lists the same package-managed files as the release", () => {
    const listed = /\nPACKAGE_MANAGED_FILES="([^"]+)"\n/u.exec(SOURCE)![1]!.split(" ")
    expect(listed).toEqual([...SANCTUARY_PACKAGE_MANAGED_FILES, "bundle-meta.json"])
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
    it("changes nothing, and prints and saves the before-state", () => {
      const before = snapshot(T, (rel) => rel === "docker.log" || rel.startsWith("tmp"))
      const result = run()
      expect(result.status, result.stderr).toBe(0)
      expect(snapshot(T, (rel) => rel === "docker.log" || rel.startsWith("tmp") || rel.endsWith("cutover-before.txt"))).toEqual(before)
      const saved = fs.readFileSync(path.join(backup(), "cutover-before.txt"), "utf8")
      expect(result.stdout).toContain(saved)
      for (const line of [
        `origin.url: ${OLD_REMOTE}`,
        `target.url: ${BUNDLE_REMOTE}`,
        `image: ${IMAGE}`,
        "branch: master",
        "upstream: (none)",
        "branch.remote: (unset)",
        `core.bare: false`,
        `core.worktree: ${bundle()}`,
        `core.sshCommand: ssh -i ${backup()}/deploy_key`,
        "core.untrackedCache: (unset)",
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
      expect(result.stdout).toContain(`dry run ok; saved ${backup()}/cutover-before.txt`)
      // Timed inside the release image as the Butler's uid, read-only, on the live bundle; the list comes from the release's own code.
      const log = dockerLog()
      expect(log).toContain(`run --rm --pull=never --network none --entrypoint node ${IMAGE} /opt/ouro/dist/heart/daemon/ouro-entry.js sanctuary git-exclude --print`)
      const timing = log.find((line) => line.includes("--user 10001:10001"))!
      expect(timing).toContain(`--mount type=bind,src=${repoGit()},dst=/cutover/repo.git,readonly`)
      expect(timing).toContain(`--mount type=bind,src=${bundle()},dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly`)
      expect(log.some((line) => /^(stop|start|exec)\b/u.test(line))).toBe(false)
    })

    it("fails on a secret-named tracked file and still changes nothing", () => {
      write(path.join(bundle(), "notes/api-token.txt"), "x\n")
      bg(["add", "-A"])
      bg(["-c", "user.name=backup", "-c", "user.email=backup@example.invalid", "commit", "-q", "-m", "hourly backup"])
      const before = snapshot(T, (rel) => rel === "docker.log" || rel.startsWith("tmp"))
      const result = run("--dry-run")
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("secret-named tracked paths: 1\n  notes/api-token.txt\n")
      expect(result.stderr).toContain("FAIL: tracked paths look like secrets")
      expect(result.stderr).toContain("cutover: the dry run found problems; nothing was changed")
      expect(snapshot(T, (rel) => rel === "docker.log" || rel.startsWith("tmp") || rel.endsWith("cutover-before.txt"))).toEqual(before)
    })

    it.each([
      ["400 10", "git status took 400 ms"],
      ["10 301", "git add -A --dry-run 301 ms"],
    ])("fails when the git timing is %s", (timings, message) => {
      const result = run(undefined, { STUB_TIMINGS: timings })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(message)
    })

    it("fails closed on a garbled timing, a missing piece, or a cutover already done", () => {
      expect(run(undefined, { STUB_TIMINGS: "fast" }).stderr).toContain('the git timing inside the image printed "fast"')
      fs.writeFileSync(path.join(T, "exclude.txt"), "inbox/\n")
      expect(run().stderr).toContain("has no state/ entry")
      fs.writeFileSync(path.join(T, "exclude.txt"), "state/\n")
      expect(run().stderr).toContain("has no **/*.key entry")
      fs.writeFileSync(path.join(T, "exclude.txt"), sanctuaryGitExcludeText())
      expect(run(undefined, { STUB_FAIL_MATCH: "^inspect --format \\{\\{\\.Image" }).status).toBe(1)
      fs.writeFileSync(path.join(backup(), "cutover-done"), "x\n")
      expect(run().stderr).toContain("the cutover is already done")
      fs.rmSync(path.join(backup(), "cutover-done"))
      fs.renameSync(cronFile(), `${cronFile()}.off`)
      expect(run().stderr).toContain("the backup cron file")
    })
  })

  describe("apply", () => {
    it("leaves main tracking origin/main with the backup history, nothing excluded tracked, sync on, the key installed and .git the Butler's", () => {
      const backupHead = bg(["rev-parse", "HEAD"])
      // A change since the last hourly run: the final backup commit carries it.
      write(path.join(bundle(), "friends/f2.json"), "{\"new\":true}\n")
      const result = run("--apply")
      expect(result.status, result.stderr + result.stdout).toBe(0)
      expect(result.stdout).toContain("cutover done. Run --verify-live next.")

      expect(fs.existsSync(repoGit())).toBe(false)
      expect(ng(["symbolic-ref", "--short", "HEAD"])).toBe("main")
      expect(ng(["config", "branch.main.remote"])).toBe("origin")
      expect(ng(["config", "branch.main.merge"])).toBe("refs/heads/main")
      expect(ng(["config", "remote.origin.url"])).toBe(BUNDLE_REMOTE)
      const head = ng(["rev-parse", "HEAD"])
      expect(ng(["rev-parse", "origin/main"])).toBe(head)
      expect(rg(["rev-parse", "main"])).toBe(head)
      expect(spawnSync("git", [`--git-dir=${bundle()}/.git`, "merge-base", "--is-ancestor", backupHead, head], { env }).status).toBe(0)
      expect(ng(["log", "--format=%s|%ae", "-2"]).split("\n")).toEqual([
        "sync: stop tracking package-managed and excluded files|sanctuary@ouro.local",
        "backup: last hourly backup before bundle sync|sanctuary@ouro.local",
      ])
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

      expect(fs.existsSync(path.join(backup(), "cutover-done"))).toBe(true)
      expect(fs.existsSync(cronFile())).toBe(false)
      expect(fs.existsSync(path.join(backup(), "sanctuary-bundle-backup.cron.disabled"))).toBe(true)
      expect(fs.readFileSync(cronTable(), "utf8")).not.toContain("backup.sh")
      expect(fs.readFileSync(path.join(T, "container"), "utf8")).toBe("running\n")
      const log = dockerLog()
      const order = ["stop ouro-butler", "update_cron", "start ouro-butler"].map((entry) => log.indexOf(entry))
      expect(order).toEqual([...order].sort((a, b) => a - b))
      const audit = log.find((line) => line.includes("audit-container-spec.sh"))!
      expect(audit).toMatch(/--mount-contract canonical-gateway --expected-image-reference ghcr\.io\/ourostack\/ouroboros-butler:0\.1\.0-alpha\.990 --expected-icon \S+ --sync-enabled true$/u)
      expect(log.indexOf(audit)).toBeGreaterThan(log.indexOf("start ouro-butler"))
      expect(log.at(-1)).toBe("exec -u 10001 ouro-butler test -r /run/ouro-sync/deploy_key")
      // The script never prints the key.
      expect(result.stdout + result.stderr).not.toMatch(/PRIVATE KEY|throwaway test key/u)
    })

    it("hands .git to the Butler's uid as the last write and the key to ouro-sync, as root", () => {
      expect(SOURCE).toContain('  chown -R -h "$BUTLER_OWNER" "$BUNDLE/.git"\n  assert_owned_by_butler\n')
      expect(SOURCE).toContain('  chown "$SYNC_OWNER" "$SYNC_DIR/.deploy_key.cutover"\n  chmod 0400 "$SYNC_DIR/.deploy_key.cutover"\n')
      const steps = ["STEP=12;", "STEP=13;", "STEP=14;", "STEP=15;"].map((marker) => SOURCE.indexOf(marker))
      expect(steps).toEqual([...steps].sort((a, b) => a - b))
      expect(SOURCE.slice(SOURCE.indexOf("STEP=13;"), SOURCE.indexOf("STEP=15;"))).not.toMatch(/bundle_git|backup_git/u)
    })

    it("apply failing at step 7 rolls back to the exact before-state", () => {
      const before = beforeState()
      const agentBefore = fs.readFileSync(path.join(bundle(), "agent.json"))
      redirect(`file://${path.join(T, "github/missing.git")}`)
      const result = run("--apply")
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("cutover failed at step 7")
      expect(result.stderr).toContain("rolled back: the hourly backup owns the bundle again")
      expect(beforeState()).toEqual(before)
      expect(fs.readFileSync(path.join(bundle(), "agent.json")).equals(agentBefore)).toBe(true)
      expect(dockerLog().filter((line) => /^(stop|start) /u.test(line))).toEqual(["stop ouro-butler", "start ouro-butler"])
      // The rollback leaves a state the next dry run accepts.
      redirect()
      expect(run().status).toBe(0)
    })

    it.each([
      ["the audit of the started container", { STUB_AUDIT_STATUS: "1" }, 15],
      ["the Butler's uid reading the key", { STUB_KEY_READABLE: "0" }, 15],
    ])("rolls back everything when %s fails after the start", (_name, extra, step) => {
      const before = beforeState()
      const result = run("--apply", extra)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`cutover failed at step ${step}`)
      expect(beforeState()).toEqual(before)
      const agent = JSON.parse(fs.readFileSync(path.join(bundle(), "agent.json"), "utf8"))
      expect(agent.sync).toEqual({ enabled: false, branch: "main" })
      expect(fs.readFileSync(path.join(T, "container"), "utf8")).toBe("running\n")
    })

    it("stops before changing anything when the dry run fails, and when the backup cron cannot be disabled", () => {
      const before = beforeState()
      expect(run("--apply", { STUB_TIMINGS: "999 1" }).status).toBe(1)
      expect(beforeState()).toEqual(before)
      expect(dockerLog().some((line) => line.startsWith("stop"))).toBe(false)
      stub("update_cron", "exit 0")
      const stuck = run("--apply")
      expect(stuck.stderr).toContain("still runs backup.sh")
      expect(beforeState()).toEqual(before)
    })
  })

  describe("rollback", () => {
    it("restores the before-state exactly after a full apply, and keeps the pushed commits", () => {
      const before = beforeState()
      expect(run("--apply").status).toBe(0)
      const pushed = rg(["rev-parse", "main"])
      const result = run("--rollback")
      expect(result.status, result.stderr).toBe(0)
      const after = beforeState()
      expect({ ...after, syncKey: false }).toEqual(before)
      expect(after.syncKey).toBe(true)
      expect(rg(["rev-parse", "main"])).toBe(pushed)
      expect(JSON.parse(fs.readFileSync(path.join(bundle(), "agent.json"), "utf8")).sync).toEqual({ enabled: false, branch: "main" })
      expect(dockerLog().slice(-2)).toEqual(["update_cron", "start ouro-butler"])
    })

    it("refuses without a saved before-state, and reports a restore that fails", () => {
      expect(run("--rollback").stderr).toContain("cutover-before.txt is missing")
      expect(run("--apply").status).toBe(0)
      const saved = path.join(backup(), "cutover-before.txt")
      fs.writeFileSync(saved, fs.readFileSync(saved, "utf8").replace(/^core\.bare: .*\n/mu, ""))
      const result = run("--rollback")
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('cutover: cutover-before.txt has no "core.bare" line')
      expect(result.stderr).toContain("rollback: failed: restore_backup_repo")
      expect(result.stderr).toContain("rollback finished with failures")
    })
  })

  describe("verify-live", () => {
    beforeEach(() => {
      expect(run("--apply").status).toBe(0)
      fs.writeFileSync(path.join(T, "docker.log"), "")
    })

    it("reaches GitHub through the sync path, proves the key unreadable, stalls a fetch behind one scoped rule, and syncs again", () => {
      const result = run("--verify-live")
      expect(result.status, result.stderr).toBe(0)
      expect(dockerLog()).toEqual([
        `exec -u 10001 -e GIT_SSH_COMMAND=sudo -n -u ouro-sync /usr/local/libexec/ouro-sync-ssh -e GIT_SSH_VARIANT=ssh ouro-butler git ls-remote ${BUNDLE_REMOTE} refs/heads/main`,
        "exec -u 10001 ouro-butler cat /run/ouro-sync/deploy_key",
        "exec -u 10001 ouro-butler test -r /run/ouro-sync/deploy_key",
        "inspect --format {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}} ouro-butler",
        "iptables -I FORWARD -s 172.17.0.5 -p tcp --dport 22 -j DROP",
        "exec -u 10001 ouro-butler timeout 60 node /opt/ouro/dist/heart/daemon/ouro-entry.js sync --agent sanctuary",
        "iptables -D FORWARD -s 172.17.0.5 -p tcp --dport 22 -j DROP",
        "exec ouro-butler ps -u 10002 -o pid=",
        "exec -u 10001 ouro-butler timeout 60 node /opt/ouro/dist/heart/daemon/ouro-entry.js sync --agent sanctuary",
      ])
      expect(result.stdout).toContain("verify-live ok")
      expect(fs.readFileSync(path.join(T, "iptables"), "utf8")).toBe("")
    })

    it.each([
      ["a sync that does not stall", { STUB_STALLED_STATUS: "0" }, "ouro sync succeeded while TCP 22 was dropped"],
      ["ouro-sync processes left running", { STUB_LEFTOVER: "4242" }, "ouro-sync processes outlived the stalled sync: 4242"],
      ["an unreachable GitHub", { STUB_LS_REMOTE: "" }, "returned no main"],
      ["a readable key", { STUB_KEY_READABLE: "0" }, "the Butler's uid can read /run/ouro-sync/deploy_key"],
      ["a container with no IP", { STUB_IP: "" }, "the container has no IP address"],
    ])("fails on %s and never leaves the rule behind", (_name, extra, message) => {
      const result = run("--verify-live", extra)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(message)
      expect(fs.existsSync(path.join(T, "iptables")) ? fs.readFileSync(path.join(T, "iptables"), "utf8") : "").toBe("")
    })

    it("fails a stalled sync that runs past the limit", () => {
      expect(SOURCE).toContain("\nSTALL_LIMIT_S=25\n")
      const late = run("--verify-live", { STUB_STALL_S: "2", OURO_CUTOVER_STALL_LIMIT_S: "1" })
      expect(late.status).toBe(1)
      expect(late.stderr).toMatch(/the stalled ouro sync took [2-9]s; it must end within 1s/u)
      expect(fs.readFileSync(path.join(T, "iptables"), "utf8")).toBe("")
    })

    it("refuses before the cutover", () => {
      fs.rmSync(path.join(backup(), "cutover-done"))
      expect(run("--verify-live").stderr).toContain("the cutover is not done")
    })
  })

  it.skipIf(!isRootLinux)("as root, applies over a work tree another uid owns and leaves .git and the key with the real owners", () => {
    spawnSync("chown", ["-R", "10001:10001", bundle()])
    const result = run("--apply")
    expect(result.status, result.stderr).toBe(0)
    expect(spawnSync("find", [path.join(bundle(), ".git"), "!", "-uid", "10001"], { encoding: "utf8" }).stdout).toBe("")
    const key = fs.statSync(path.join(appdata(), "sync/deploy_key"))
    expect([key.uid, key.gid, key.mode & 0o7777]).toEqual([10002, 10002, 0o400])
    expect(fs.statSync(path.join(appdata(), "sync")).uid).toBe(0)
    expect(run("--rollback").status).toBe(0)
    expect(spawnSync("find", [repoGit(), "!", "-uid", "0"], { encoding: "utf8" }).stdout).toBe("")
  })
})
