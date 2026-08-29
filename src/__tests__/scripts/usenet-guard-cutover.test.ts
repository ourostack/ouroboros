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
    expect(source).toContain('"$EVENT_PRODUCER" --maintain')
    const pause = source.indexOf("api?mode=pause&apikey=$SAB_KEY")
    const verify = source.indexOf('jq -r \'.queue.paused // false\'')
    const emit = source.indexOf('emit_transition "sabnzbd.pause"')
    expect(pause).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(pause)
    expect(emit).toBeGreaterThan(verify)
    expect(source).toContain('"spend-pause:${TODAY}:verified"')
    expect(source).toContain('"sabnzbd:pause:${TODAY}:spend-guard"')
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

  it("installs root-only assets and one boot-persistent cron registration without disturbing the read-only Community Apps mapping", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const goFile = path.join(temp, "go")
    const crontabFile = path.join(temp, "crontab")
    fs.writeFileSync(goFile, "#!/bin/bash\n/usr/local/sbin/emhttp &\n")
    fs.writeFileSync(crontabFile, "0 0 * * * /usr/bin/true\n")

    for (let index = 0; index < 2; index += 1) {
      execFileSync(installerPath, ["--install-only", "--source-root", assetRoot, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile])
    }

    const hook = `${installRoot}/ouro-events/install-usenet-guard.sh --boot --crontab-file ${crontabFile}`
    const go = fs.readFileSync(goFile, "utf8")
    expect(go.match(new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(1)
    expect(go.indexOf(hook)).toBeLessThan(go.indexOf("/usr/local/sbin/emhttp"))
    expect(fs.readFileSync(crontabFile, "utf8").match(/# ouro:usenet-health$/gmu)).toHaveLength(1)
    expect(fs.readFileSync(crontabFile, "utf8")).toContain(`*/15 * * * * ${installRoot}/usenet_health.sh # ouro:usenet-health`)
    for (const file of ["usenet_health.sh", "ouro-events/emit-event.mjs", "ouro-events/emit-usenet-event.sh", "ouro-events/bootstrap-spool.sh", "ouro-events/install-usenet-guard.sh"]) {
      expect(fs.statSync(path.join(installRoot, file)).mode & 0o777).toBe(0o700)
    }
    const template = fs.readFileSync(path.resolve(__dirname, "../../../deploy/unraid/sanctuary.xml"), "utf8")
    expect(template).toContain('Target="/run/ouro-events"')
    expect(template).toContain('Mode="ro"')
    expect(template).toContain('Target="/run/sanctuary/sabnzbd.ini"')
  })
})
