import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const roots: string[] = []
const assetRoot = path.resolve(__dirname, "../../../deploy/unraid/ouro-events")
const guardPath = path.join(assetRoot, "usenet-health.sh")
const adapterPath = path.join(assetRoot, "emit-usenet-event.sh")
const installerPath = path.join(assetRoot, "install-usenet-guard.sh")

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-usenet-cutover-"))
  roots.push(value)
  return value
}

function transactionalSource(temp: string, crontabFile: string, lifecycleLog: string): string {
  const source = path.join(temp, "source")
  fs.cpSync(assetRoot, source, { recursive: true })
  fs.writeFileSync(path.join(source, "bootstrap-spool.sh"), `#!/bin/bash
printf 'spool:%s\n' "$1" >> ${JSON.stringify(lifecycleLog)}
`, { mode: 0o700 })
  fs.writeFileSync(path.join(source, "emit-event.mjs"), `import fs from "node:fs"
if (!process.argv.includes("--maintain")) process.exit(2)
const active = fs.existsSync(${JSON.stringify(crontabFile)}) && fs.readFileSync(${JSON.stringify(crontabFile)}, "utf8").includes("# ouro:usenet-health")
fs.appendFileSync(${JSON.stringify(lifecycleLog)}, "event:" + (active ? "active" : "inactive") + "\\n")
`, { mode: 0o700 })
  return source
}

function transactionResidue(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { recursive: true }).map(String).filter((name) => name.includes(".ouro-next.") || name.includes(".ouro-usenet-stage."))
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("Unraid usenet guard cutover assets", () => {
  it("preserves the article-success spend guard while removing direct Telegram delivery", () => {
    const source = fs.readFileSync(guardPath, "utf8")
    expect(source).toContain("MIN_ARTICLES=50000")
    expect(source).toContain("MIN_RATE=30")
    expect(source).toContain("RATE=$(( OKAY * 100 / TRIED ))")
    expect(source).toContain('if [ "${TRIED:-0}" -ge "$MIN_ARTICLES" ]')
    expect(source).toContain('if [ "$RATE" -lt "$MIN_RATE" ]')
    expect(source).toContain("api?mode=pause&apikey=$SAB_KEY")
    expect(source).not.toMatch(/api\.telegram\.org|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|notify\.conf|sendMessage/u)
    expect(source).toContain("/usr/local/emhttp/webGui/scripts/notify")
  })

  it("maintains the spool every detector tick and emits only after an independent paused-state read", () => {
    const source = fs.readFileSync(guardPath, "utf8")
    expect(source).toContain('/usr/local/bin/node "$EVENT_PRODUCER" --maintain')
    const pause = source.indexOf("api?mode=pause&apikey=$SAB_KEY")
    const verify = source.indexOf('jq -r \'.queue.paused // false\'')
    const emit = source.indexOf('emit_transition "sabnzbd.pause"')
    expect(pause).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(pause)
    expect(emit).toBeGreaterThan(verify)
    expect(source).toContain('"spend-pause:${TODAY}:verified"')
    expect(source).toContain('"sabnzbd:pause:${TODAY}:spend-guard"')
  })

  it("never stages Prowlarr JSON in a predictable temporary file", () => {
    const source = fs.readFileSync(guardPath, "utf8")
    expect(source).not.toContain("/tmp/usenet_idx_off.json")
    expect(source).toContain("jq -c '.enable = false'")
    expect(source).toContain("--data-binary @-")
  })

  it("uses the canonical producer with a fixed bounded argv contract and no detector speech token", () => {
    const source = fs.readFileSync(adapterPath, "utf8")
    expect(source).toContain('exec /usr/local/bin/node "$PRODUCER"')
    expect(source).toContain('"--agent" "sanctuary"')
    expect(source).toContain('"--source" "sanctuary-usenet"')
    expect(source).toContain('"--event-type" "usenet.protective_action"')
    expect(source).toContain('"--action" "$ACTION"')
    expect(source).toContain('"--evidence" "$EVIDENCE"')
    expect(source).toContain('"--protective-state-verified" "$VERIFIED"')
    expect(source).toContain('"--protective-state-digest" "$VERIFICATION_DIGEST"')
    expect(source).toContain('"--protective-state-observed-at" "$VERIFIED_AT"')
    expect(source).not.toMatch(/TELEGRAM|token|sendMessage|api\.telegram/iu)
  })

  it("emits an agent-visible unverified transition and no direct report when SAB says the requested pause did not take", () => {
    const temp = root()
    const bin = path.join(temp, "bin")
    const calls = path.join(temp, "adapter.calls")
    const log = path.join(temp, "guard.log")
    const ini = path.join(temp, "sabnzbd.ini")
    fs.mkdirSync(bin)
    fs.writeFileSync(ini, "api_key = test-only\n")
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/bash\nprintf '{}\\n'\n", { mode: 0o700 })
    fs.writeFileSync(path.join(bin, "jq"), `#!/bin/bash\ncase "$*" in\n  *articles_tried*) echo 50000 ;;\n  *articles_success*) echo 0 ;;\n  *daily*) echo 1000000000 ;;\n  *queue.paused*) echo false ;;\n  *queue.status*) echo Downloading ;;\n  *queue.noofslots*) echo 0 ;;\n  *Authentication*) echo 0 ;;\n  *) echo 0 ;;\nesac\n`, { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "producer"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "adapter"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`, { mode: 0o700 })

    execFileSync(guardPath, ["--sab-ini", ini, "--log", log, "--producer", path.join(temp, "producer"), "--adapter", path.join(temp, "adapter")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })

    const emitted = fs.readFileSync(calls, "utf8")
    expect(emitted).toContain("sabnzbd.pause spend-guard")
    expect(emitted).toContain("spend-pause:")
    expect(emitted).toContain(":unverified")
    expect(emitted).toContain(" false ")
    expect(fs.readFileSync(log, "utf8")).toContain("only a verification-failure event was emitted")
  })

  it("preflights a fresh-host spool and event path before installing root-only assets and activating cron", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const goFile = path.join(temp, "go")
    const crontabFile = path.join(temp, "crontab")
    const lifecycleLog = path.join(temp, "lifecycle.log")
    const source = transactionalSource(temp, crontabFile, lifecycleLog)
    const legacyHook = "/boot/config/custom/ouro-events/bootstrap-spool.sh --mount"
    const hook = `/bin/bash ${installRoot}/ouro-events/install-usenet-guard.sh --boot --crontab-file ${crontabFile}`
    fs.writeFileSync(goFile, `#!/bin/bash\n${legacyHook}\n${hook}\n${hook}\n/usr/local/sbin/emhttp &\n`)

    for (let index = 0; index < 2; index += 1) {
      execFileSync(installerPath, ["--install-only", "--source-root", source, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile])
    }

    const go = fs.readFileSync(goFile, "utf8")
    expect(go.match(new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(1)
    expect(go).not.toContain(legacyHook)
    expect(go.indexOf(hook)).toBeLessThan(go.indexOf("/usr/local/sbin/emhttp"))
    expect(fs.readFileSync(crontabFile, "utf8").match(/# ouro:usenet-health$/gmu)).toHaveLength(1)
    expect(fs.readFileSync(crontabFile, "utf8")).toContain(`*/15 * * * * /bin/bash ${installRoot}/usenet_health.sh # ouro:usenet-health`)
    expect(fs.readFileSync(lifecycleLog, "utf8")).toBe("spool:--mount\nspool:--self-test\nevent:inactive\nspool:--mount\nspool:--self-test\nevent:active\n")
    expect(transactionResidue(installRoot)).toEqual([])
    for (const file of ["usenet_health.sh", "ouro-events/emit-event.mjs", "ouro-events/emit-usenet-event.sh", "ouro-events/bootstrap-spool.sh", "ouro-events/install-usenet-guard.sh"]) {
      expect(fs.statSync(path.join(installRoot, file)).mode & 0o777).toBe(0o700)
    }
    const template = fs.readFileSync(path.resolve(__dirname, "../../../deploy/unraid/sanctuary.xml"), "utf8")
    expect(template).toContain('Target="/run/ouro-events"')
    expect(template).toContain('Mode="ro"')
    expect(template).toContain('Target="/run/sanctuary/sabnzbd.ini"')
  })

  it("rejects an incomplete source set before touching a fresh host", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const goFile = path.join(temp, "go")
    const crontabFile = path.join(temp, "crontab")
    const source = transactionalSource(temp, crontabFile, path.join(temp, "lifecycle.log"))
    fs.writeFileSync(goFile, "#!/bin/bash\nprior-go\n")
    fs.writeFileSync(crontabFile, "prior-cron\n")
    fs.rmSync(path.join(source, "usenet-health.sh"))

    expect(() => execFileSync(installerPath, ["--install-only", "--source-root", source, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile], { stdio: "ignore" })).toThrow()
    expect(fs.existsSync(installRoot)).toBe(false)
    expect(fs.readFileSync(goFile, "utf8")).toBe("#!/bin/bash\nprior-go\n")
    expect(fs.readFileSync(crontabFile, "utf8")).toBe("prior-cron\n")
  })

  it("removes forward temporary files and leaves a fresh host untouched when a rename fails", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const goFile = path.join(temp, "go")
    const crontabFile = path.join(temp, "crontab")
    const source = transactionalSource(temp, crontabFile, path.join(temp, "lifecycle.log"))
    const bin = path.join(temp, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "mv"), `#!/bin/bash
source="$1"
target="$2"
case "$source:$target" in
  *.ouro-next.*:${JSON.stringify(path.join(installRoot, "usenet_health.sh"))}) exit 74 ;;
esac
exec /bin/mv "$@"
`, { mode: 0o700 })

    expect(() => execFileSync(installerPath, ["--install-only", "--source-root", source, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" })).toThrow()
    expect(fs.existsSync(goFile)).toBe(false)
    expect(fs.existsSync(crontabFile)).toBe(false)
    for (const target of [path.join(installRoot, "usenet_health.sh"), ...["bootstrap-spool.sh", "emit-event.mjs", "emit-usenet-event.sh", "install-usenet-guard.sh"].map((name) => path.join(installRoot, "ouro-events", name))]) expect(fs.existsSync(target), target).toBe(false)
    expect(transactionResidue(installRoot)).toEqual([])
  })

  it("removes a created forward temporary file and restores an existing host when install reports failure", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const eventRoot = path.join(installRoot, "ouro-events")
    const goFile = path.join(temp, "go")
    const crontabFile = path.join(temp, "crontab")
    const source = transactionalSource(temp, crontabFile, path.join(temp, "lifecycle.log"))
    const bin = path.join(temp, "bin")
    fs.mkdirSync(eventRoot, { recursive: true })
    fs.mkdirSync(bin)
    const targets = [path.join(installRoot, "usenet_health.sh"), ...["bootstrap-spool.sh", "emit-event.mjs", "emit-usenet-event.sh", "install-usenet-guard.sh"].map((name) => path.join(eventRoot, name))]
    for (const [index, target] of targets.entries()) fs.writeFileSync(target, `prior-${index}\n`, { mode: 0o700 })
    fs.writeFileSync(goFile, "#!/bin/bash\n/boot/config/custom/ouro-events/bootstrap-spool.sh --mount\n/usr/local/sbin/emhttp &\n", { mode: 0o700 })
    fs.writeFileSync(crontabFile, "*/15 * * * * prior-guard # ouro:usenet-health\n", { mode: 0o600 })
    const before = new Map([...targets, goFile, crontabFile].map((target) => [target, fs.readFileSync(target, "utf8")]))
    const failingTarget = path.join(eventRoot, "emit-event.mjs")
    fs.writeFileSync(path.join(bin, "install"), `#!/bin/bash
target="\${!#}"
/usr/bin/install "$@" || exit $?
case "$target" in
  ${JSON.stringify(`${failingTarget}.ouro-next.`)}*) exit 76 ;;
esac
`, { mode: 0o700 })

    expect(() => execFileSync(installerPath, ["--install-only", "--source-root", source, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" })).toThrow()
    for (const [target, content] of before) expect(fs.readFileSync(target, "utf8"), target).toBe(content)
    expect(transactionResidue(installRoot)).toEqual([])
  })

  it("restores an absent system crontab when final cron activation fails", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const goFile = path.join(temp, "go")
    const cronState = path.join(temp, "system.crontab")
    const cronCalls = path.join(temp, "crontab.calls")
    const source = transactionalSource(temp, cronState, path.join(temp, "lifecycle.log"))
    const bin = path.join(temp, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/bash
printf '%s\n' "$*" >> ${JSON.stringify(cronCalls)}
case "$1" in
  -l) [ -f ${JSON.stringify(cronState)} ] || exit 1; cat ${JSON.stringify(cronState)} ;;
  -r) rm -f ${JSON.stringify(cronState)} ;;
  *) cp "$1" ${JSON.stringify(cronState)}; grep -q '# ouro:usenet-health' "$1" && exit 75 ;;
esac
`, { mode: 0o700 })

    expect(() => execFileSync(installerPath, ["--install-only", "--source-root", source, "--install-root", installRoot, "--go-file", goFile], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" })).toThrow()
    expect(fs.existsSync(cronState)).toBe(false)
    expect(fs.existsSync(goFile)).toBe(false)
    expect(fs.readFileSync(cronCalls, "utf8")).toContain("-l")
    expect(fs.readFileSync(cronCalls, "utf8")).toContain("-r")
    expect(transactionResidue(installRoot)).toEqual([])
  })

  it("restores the prior guard, assets, go hook, and cron when cron activation fails after asset and go swaps", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const eventRoot = path.join(installRoot, "ouro-events")
    const goFile = path.join(temp, "go")
    const crontabFile = path.join(temp, "crontab")
    const lifecycleLog = path.join(temp, "lifecycle.log")
    const source = transactionalSource(temp, crontabFile, lifecycleLog)
    const bin = path.join(temp, "bin")
    fs.mkdirSync(eventRoot, { recursive: true })
    fs.mkdirSync(bin)
    const targets = [path.join(installRoot, "usenet_health.sh"), ...["bootstrap-spool.sh", "emit-event.mjs", "emit-usenet-event.sh", "install-usenet-guard.sh"].map((name) => path.join(eventRoot, name))]
    for (const [index, target] of targets.entries()) fs.writeFileSync(target, `prior-${index}\n`, { mode: 0o700 })
    fs.writeFileSync(goFile, "#!/bin/bash\n/boot/config/custom/ouro-events/bootstrap-spool.sh --mount\n/usr/local/sbin/emhttp &\n", { mode: 0o700 })
    fs.writeFileSync(crontabFile, "*/15 * * * * prior-guard # ouro:usenet-health\n", { mode: 0o600 })
    const before = new Map([...targets, goFile, crontabFile].map((target) => [target, fs.readFileSync(target, "utf8")]))
    const failingTarget = crontabFile
    const installCount = path.join(temp, "install.count")
    fs.writeFileSync(path.join(bin, "install"), `#!/bin/bash
target="\${!#}"
case "$target" in
  ${JSON.stringify(`${installRoot}/`)}*.ouro-next.*)
    grep -q '# ouro:usenet-health' ${JSON.stringify(crontabFile)} 2>/dev/null && exit 92
    ;;
esac
case "$target" in
  ${JSON.stringify(`${failingTarget}.ouro-next.`)}*)
    count=0
    [ ! -f ${JSON.stringify(installCount)} ] || count=$(cat ${JSON.stringify(installCount)})
    count=$((count + 1))
    printf '%s\n' "$count" > ${JSON.stringify(installCount)}
    [ "$count" -lt 2 ] || exit 73
    ;;
esac
exec /usr/bin/install "$@"
`, { mode: 0o700 })

    expect(() => execFileSync(installerPath, ["--install-only", "--source-root", source, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })).toThrow()
    for (const [target, content] of before) expect(fs.readFileSync(target, "utf8"), target).toBe(content)
    expect(fs.readFileSync(crontabFile, "utf8")).toContain("prior-guard # ouro:usenet-health")
    expect(transactionResidue(installRoot)).toEqual([])
  })
})
