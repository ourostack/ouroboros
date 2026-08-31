import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const roots: string[] = []
const assetRoot = path.resolve(__dirname, "../../../deploy/unraid/ouro-events")
const guardPath = path.join(assetRoot, "usenet-health.sh")
const adapterPath = path.join(assetRoot, "emit-usenet-event.sh")
const producerPath = path.join(assetRoot, "emit-event.mjs")
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
const active = fs.existsSync(${JSON.stringify(crontabFile)}) && fs.readFileSync(${JSON.stringify(crontabFile)}, "utf8").includes("usenet_health.sh # ouro:usenet-health")
fs.appendFileSync(${JSON.stringify(lifecycleLog)}, "event:" + (active ? "active" : "inactive") + "\\n")
`, { mode: 0o700 })
  return source
}

function transactionResidue(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { recursive: true }).map(String).filter((name) => name.includes(".ouro-next.") || name.includes(".ouro-usenet-stage.") || name.includes(".ouro-usenet-restore."))
}

function installerFunction(name: string): string {
  const source = fs.readFileSync(installerPath, "utf8")
  const start = source.indexOf(`${name}() {`)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf("\n}\n", start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end + 2)
}

const hostAssetRelatives = ["custom/usenet_health.sh", "custom/ouro-events/bootstrap-spool.sh", "custom/ouro-events/emit-event.mjs", "custom/ouro-events/emit-usenet-event.sh", "custom/ouro-events/install-usenet-guard.sh"]
const hostSnapshotRelatives = [...hostAssetRelatives, "go.butler-lines", "crontab.butler-lines", "global-state"]

function hostSnapshot(temp: string): string {
  const snapshot = path.join(temp, "host-snapshot")
  for (const relative of hostAssetRelatives) {
    const target = path.join(snapshot, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `snapshot:${relative}\n`, { mode: 0o600 })
  }
  fs.writeFileSync(path.join(snapshot, "go.butler-lines"), "/bin/bash /boot/config/custom/ouro-events/install-usenet-guard.sh --boot\n", { mode: 0o600 })
  fs.writeFileSync(path.join(snapshot, "crontab.butler-lines"), "*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh\n", { mode: 0o600 })
  fs.writeFileSync(path.join(snapshot, "global-state"), `go\tpresent\t${"a".repeat(64)}\t1\ncrontab\tpresent\t${"b".repeat(64)}\t1\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(snapshot, "inventory"), `${hostSnapshotRelatives.map((relative) => `present\t${relative}`).join("\n")}\n`, { mode: 0o600 })
  return snapshot
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("Unraid usenet guard cutover assets", () => {
  it("rejects non-canonical persisted paths before rendering boot or cron commands", () => {
    expect(() => execFileSync(installerPath, ["--install-root", "/boot/config/custom;touch-pwned"], { stdio: "ignore" })).toThrow()
    expect(() => execFileSync(installerPath, ["--install-root", "/boot/config/../custom"], { stdio: "ignore" })).toThrow()
    expect(() => execFileSync(installerPath, ["--install-root", "/boot/config/custom/"], { stdio: "ignore" })).toThrow()
    expect(() => execFileSync(installerPath, ["--crontab-file", "relative/cron"], { stdio: "ignore" })).toThrow()
  })

  it("preserves the article-success spend guard while leaving all routine notification to the Butler", () => {
    const source = fs.readFileSync(guardPath, "utf8")
    expect(source).toContain("MIN_ARTICLES=50000")
    expect(source).toContain("MIN_RATE=30")
    expect(source).toContain("RATE=$(( DELTA_OKAY * 100 / DELTA_TRIED ))")
    expect(source).toContain('if [ "${DELTA_TRIED:-0}" -ge "$MIN_ARTICLES" ]')
    expect(source).toContain('if [ "$RATE" -lt "$MIN_RATE" ]')
    expect(source).toContain("api?mode=pause&output=json")
    expect(source).not.toContain("apikey=$SAB_KEY")
    expect(source).toContain('curl --silent --fail --max-time "$timeout" --config - "$url"')
    expect(source).not.toMatch(/api\.telegram\.org|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|notify\.conf|sendMessage|notify_unraid|webGui\/scripts\/notify/u)
  })

  it("maintains the spool every detector tick and emits only after an independent paused-state read", () => {
    const source = fs.readFileSync(guardPath, "utf8")
    expect(source).toContain('/usr/local/bin/node "$EVENT_PRODUCER" --maintain')
    const pause = source.indexOf("api?mode=pause&output=json")
    const verify = source.indexOf("api?mode=queue&output=json", pause)
    const emit = source.indexOf('emit_transition "sabnzbd.pause"')
    expect(pause).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(pause)
    expect(emit).toBeGreaterThan(verify)
    expect(source).toContain('"spend-pause:${TODAY}:verified"')
    expect(source).toContain('"sabnzbd:pause:${TODAY}:spend-guard"')
  })

  it.each([
    ["transport failure", "exit 22"],
    ["authenticated API rejection", "printf '{\"status\":false,\"error\":\"API Key Incorrect\",\"warnings\":[],\"queue\":{\"status\":\"Downloading\",\"paused\":false,\"noofslots\":0},\"servers\":[],\"history\":{\"slots\":[]}}\\n'"],
    ["malformed JSON", "printf 'not-json\\n'"],
  ])("fails closed with one agent-owned observation on %s", (_label, response) => {
    const temp = root()
    const bin = path.join(temp, "bin")
    const calls = path.join(temp, "adapter.calls")
    const log = path.join(temp, "guard.log")
    const ini = path.join(temp, "sabnzbd.ini")
    fs.mkdirSync(bin)
    fs.writeFileSync(ini, "api_key = test-only-secret-123\n")
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
${response}
`, { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "producer"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "adapter"), `#!/bin/bash
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
`, { mode: 0o700 })

    expect(() => execFileSync(guardPath, ["--sab-ini", ini, "--log", log, "--producer", path.join(temp, "producer"), "--adapter", path.join(temp, "adapter")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" })).toThrow()

    const emitted = fs.readFileSync(calls, "utf8").trim().split("\n")
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toContain("usenet.observe provider-health indeterminate:")
    expect(emitted[0]).toContain(" false ")
    expect(emitted[0]).not.toContain("test-only-secret-123")
    expect(fs.readFileSync(log, "utf8")).not.toContain("test-only-secret-123")
  })

  it.each([
    ["missing credential", ""],
    ["unsafe credential syntax", "api_key = hostile\"\\nurl = https://example.invalid\n"],
  ])("fails closed before curl when SAB has a %s", (_label, iniBody) => {
    const temp = root()
    const bin = path.join(temp, "bin")
    const calls = path.join(temp, "adapter.calls")
    const curlMarker = path.join(temp, "curl.called")
    const log = path.join(temp, "guard.log")
    const ini = path.join(temp, "sabnzbd.ini")
    fs.mkdirSync(bin)
    fs.writeFileSync(ini, iniBody)
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash\ntouch ${JSON.stringify(curlMarker)}\n`, { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "producer"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "adapter"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`, { mode: 0o700 })

    expect(() => execFileSync(guardPath, ["--sab-ini", ini, "--log", log, "--producer", path.join(temp, "producer"), "--adapter", path.join(temp, "adapter")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" })).toThrow()

    expect(fs.existsSync(curlMarker)).toBe(false)
    expect(fs.readFileSync(calls, "utf8")).toContain("usenet.observe provider-health indeterminate:")
    expect(fs.readFileSync(calls, "utf8")).not.toContain("example.invalid")
    expect(fs.readFileSync(log, "utf8")).not.toContain("example.invalid")
  })

  it("keeps the SAB API key out of curl and shell process argv", () => {
    const temp = root()
    const bin = path.join(temp, "bin")
    const argv = path.join(temp, "argv")
    const configs = path.join(temp, "configs")
    const processes = path.join(temp, "processes")
    const log = path.join(temp, "guard.log")
    const ini = path.join(temp, "sabnzbd.ini")
    const secret = "hostile-secret-argv-987"
    fs.mkdirSync(bin)
    fs.writeFileSync(ini, `api_key = ${secret}\n`)
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
printf '%s\n' "$*" >> ${JSON.stringify(argv)}
cat >> ${JSON.stringify(configs)}
ps -o command= -p $$ -p $PPID >> ${JSON.stringify(processes)}
case "$*" in
  *mode=warnings*) printf '{"warnings":[]}\n' ;;
  *mode=server_stats*) printf '{"servers":[{"articles_tried":{},"articles_success":{},"daily":{}}]}\n' ;;
  *mode=history*) printf '{"history":{"slots":[]}}\n' ;;
  *mode=queue*) printf '{"queue":{"paused":false,"status":"Downloading","noofslots":0}}\n' ;;
  *) printf '{}\n' ;;
esac
`, { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "producer"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "adapter"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })

    execFileSync(guardPath, ["--sab-ini", ini, "--log", log, "--producer", path.join(temp, "producer"), "--adapter", path.join(temp, "adapter")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })

    expect(fs.readFileSync(argv, "utf8")).not.toContain(secret)
    expect(fs.readFileSync(configs, "utf8")).toContain(`apikey=${secret}`)
    expect(fs.readFileSync(processes, "utf8")).not.toContain(secret)
    expect(fs.readFileSync(log, "utf8")).not.toContain(secret)
  })

  it("never mutates Prowlarr and emits auth, stall, and recovery observations for Butler turns", () => {
    const source = fs.readFileSync(guardPath, "utf8")
    expect(source).not.toContain("/tmp/usenet_idx_off.json")
    expect(source).not.toContain(".enable = false")
    expect(source).not.toMatch(/-X PUT|-X POST|ApplicationIndexerSync|api\/v1\/indexer\/$IID/u)
    expect(source).not.toContain('emit_transition "prowlarr.disable-indexer"')
    expect(source).toContain("OBSERVED_SLOT=$(date -u '+%Y%m%dT%H%M%SZ')")
    expect(source).toContain('emit_transition "usenet.observe" "provider-health" "auth-failed:${OBSERVED_SLOT}"')
    expect(source).toContain('emit_transition "usenet.observe" "provider-health" "stalled:${OBSERVED_SLOT}"')
    expect(source).toContain('emit_transition "usenet.observe" "provider-health" "recovered:${OBSERVED_SLOT}"')
    expect(source).toContain("api?mode=history&limit=20&start=0&output=json")
    expect(source).toContain('RECENT_COMPLETED=$(echo "$HISTORY"')
    expect(source).toContain('[ "$FINAL_PAUSED" = "false" ] && [ "${DELTA_OKAY:-0}" -gt 0 ] && [ "${RECENT_COMPLETED:-0}" -gt 0 ]')
    expect(source).toContain("recent completed downloads")
    expect(source).toContain('((.time // 0) | tonumber) >= $since')
  })

  it.each([
    ["auth", "auth-failed:"],
    ["stall", "stalled:"],
    ["recovery", "recovered:"],
  ])("submits the %s observation on every materially verified detector run without consulting Prowlarr", (scenario, transition) => {
    const temp = root()
    const bin = path.join(temp, "bin")
    const calls = path.join(temp, "adapter.calls")
    const curlCalls = path.join(temp, "curl.calls")
    const log = path.join(temp, "guard.log")
    const ini = path.join(temp, "sabnzbd.ini")
    const producer = path.join(temp, "producer.mjs")
    const adapter = path.join(temp, "adapter")
    fs.mkdirSync(bin)
    fs.writeFileSync(ini, "api_key = test-only\n")
    const local = new Date()
    fs.writeFileSync(`${log}.baseline.json`, JSON.stringify({ day: `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`, tried: 0, okay: 0 }) + "\n")
    fs.writeFileSync(producer, "process.exit(0)\n")
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
printf '%s\n' "$*" >> ${JSON.stringify(curlCalls)}
printf '{}\n'
`, { mode: 0o700 })
    fs.writeFileSync(path.join(bin, "jq"), `#!/bin/bash
case "$*" in
  *valid_count*) echo true ;;
  *@tsv*) [ "$USENET_CASE" = recovery ] && printf '100\t100\t0\n' || printf '0\t0\t0\n' ;;
  *Authentication*last*) echo "502 Authentication Failed" ;;
  *Authentication*length*) [ "$USENET_CASE" = auth ] && echo 1 || echo 0 ;;
  *queue.status*) [ "$USENET_CASE" = stall ] && echo Idle || echo Downloading ;;
  *queue.noofslots*) [ "$USENET_CASE" = stall ] && echo 2 || echo 0 ;;
  *queue.paused*) echo false ;;
  *articles_tried*) [ "$USENET_CASE" = recovery ] && echo 100 || echo 0 ;;
  *articles_success*) [ "$USENET_CASE" = recovery ] && echo 100 || echo 0 ;;
  *history.slots*) [ "$USENET_CASE" = recovery ] && echo 1 || echo 0 ;;
  *daily*) echo 0 ;;
  *) echo 0 ;;
esac
`, { mode: 0o700 })
    fs.writeFileSync(adapter, `#!/bin/bash
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
`, { mode: 0o700 })

    execFileSync(guardPath, ["--sab-ini", ini, "--log", log, "--producer", producer, "--adapter", adapter], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, USENET_CASE: scenario } })

    const emitted = fs.readFileSync(calls, "utf8").trim().split("\n")
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toContain(`usenet.observe provider-health ${transition}`)
    const queried = fs.readFileSync(curlCalls, "utf8")
    expect(queried).not.toMatch(/9696|Prowlarr|api\/v1\/indexer/iu)
  })

  it("does not claim recovery when authentication clears but no recent download completed", () => {
    const temp = root()
    const bin = path.join(temp, "bin")
    const calls = path.join(temp, "adapter.calls")
    const log = path.join(temp, "guard.log")
    const ini = path.join(temp, "sabnzbd.ini")
    fs.mkdirSync(bin)
    fs.writeFileSync(ini, "api_key = test-only\n")
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/bash\nprintf '{}\\n'\n", { mode: 0o700 })
    fs.writeFileSync(path.join(bin, "jq"), `#!/bin/bash
case "$*" in
  *queue.status*) echo Downloading ;;
  *queue.noofslots*) echo 1 ;;
  *Authentication*) echo 0 ;;
  *) echo 0 ;;
esac
`, { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "producer"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "adapter"), `#!/bin/bash
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
`, { mode: 0o700 })

    execFileSync(guardPath, ["--sab-ini", ini, "--log", log, "--producer", path.join(temp, "producer"), "--adapter", path.join(temp, "adapter")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })

    expect(fs.existsSync(calls)).toBe(false)
    expect(fs.readFileSync(log, "utf8")).toContain("not yet whole-path recovery")
  })

  it.each([
    ["healthy new interval", 1_100_000, 160_000, "recovered", false, true, "array"],
    ["failing new interval", 1_100_000, 75_000, "sabnzbd.pause", true, true, "array"],
    ["first observation seed", 1_000_000, 70_000, "", false, false, "array"],
    ["multi-server array", 1_100_000, 160_000, "recovered", false, true, "multi-array"],
    ["live SAB multi-server object map", 1_100_000, 160_000, "recovered", false, true, "multi-object"],
    ["digit-string multi-server object map", 1_100_000, 160_000, "recovered", false, true, "multi-object-strings"],
  ] as const)("uses a rolling baseline after historical 7%% spend for a %s", (_label, tried, okay, expected, pausedAfter, seedBaseline, serverShape) => {
    const temp = root()
    const bin = path.join(temp, "bin")
    const calls = path.join(temp, "adapter.calls")
    const paused = path.join(temp, "paused")
    const state = path.join(temp, "baseline.json")
    const log = path.join(temp, "guard.log")
    const ini = path.join(temp, "sabnzbd.ini")
    fs.mkdirSync(bin)
    fs.writeFileSync(ini, "api_key = test-only\n")
    fs.writeFileSync(paused, "false\n")
    const local = new Date()
    const day = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`
    if (seedBaseline) fs.writeFileSync(state, JSON.stringify({ day, tried: 1_000_000, okay: 70_000 }) + "\n")
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
case "$*" in
  *mode=pause*) printf 'true\n' > ${JSON.stringify(paused)}; printf '{"status":true}\n' ;;
  *mode=warnings*) [ "$GUARD_HISTORICAL_AUTH" = 1 ] && printf '{"warnings":[{"text":"502 Authentication Failed","time":1}]}\n' || printf '{"warnings":[]}\n' ;;
  *mode=server_stats*)
    case "$GUARD_SERVER_SHAPE" in
      multi-array) printf '{"servers":[{"articles_tried":{"%s":%s},"articles_success":{"%s":%s},"daily":{"%s":0}},{"articles_tried":{"%s":%s},"articles_success":{"%s":%s},"daily":{"%s":0}}]}\n' "$(date +%Y-%m-%d)" "$((GUARD_TRIED / 2))" "$(date +%Y-%m-%d)" "$((GUARD_OKAY / 2))" "$(date +%Y-%m-%d)" "$(date +%Y-%m-%d)" "$((GUARD_TRIED - GUARD_TRIED / 2))" "$(date +%Y-%m-%d)" "$((GUARD_OKAY - GUARD_OKAY / 2))" "$(date +%Y-%m-%d)" ;;
      multi-object) printf '{"servers":{"primary":{"articles_tried":{"%s":%s},"articles_success":{"%s":%s},"daily":{"%s":0}},"fill":{"articles_tried":{"%s":%s},"articles_success":{"%s":%s},"daily":{"%s":0}}}}\n' "$(date +%Y-%m-%d)" "$((GUARD_TRIED / 2))" "$(date +%Y-%m-%d)" "$((GUARD_OKAY / 2))" "$(date +%Y-%m-%d)" "$(date +%Y-%m-%d)" "$((GUARD_TRIED - GUARD_TRIED / 2))" "$(date +%Y-%m-%d)" "$((GUARD_OKAY - GUARD_OKAY / 2))" "$(date +%Y-%m-%d)" ;;
      multi-object-strings) printf '{"servers":{"primary":{"articles_tried":{"%s":"%s"},"articles_success":{"%s":"%s"},"daily":{"%s":"0"}},"fill":{"articles_tried":{"%s":"%s"},"articles_success":{"%s":"%s"},"daily":{"%s":"0"}}}}\n' "$(date +%Y-%m-%d)" "$((GUARD_TRIED / 2))" "$(date +%Y-%m-%d)" "$((GUARD_OKAY / 2))" "$(date +%Y-%m-%d)" "$(date +%Y-%m-%d)" "$((GUARD_TRIED - GUARD_TRIED / 2))" "$(date +%Y-%m-%d)" "$((GUARD_OKAY - GUARD_OKAY / 2))" "$(date +%Y-%m-%d)" ;;
      *) printf '{"servers":[{"articles_tried":{"%s":%s},"articles_success":{"%s":%s},"daily":{"%s":0}}]}\n' "$(date +%Y-%m-%d)" "$GUARD_TRIED" "$(date +%Y-%m-%d)" "$GUARD_OKAY" "$(date +%Y-%m-%d)" ;;
    esac ;;
  *mode=history*) printf '{"history":{"slots":[{"status":"Completed","completed":%s}]}}\n' "$(date +%s)" ;;
  *mode=queue*) printf '{"queue":{"paused":%s,"status":"Downloading","noofslots":1}}\n' "$(cat ${JSON.stringify(paused)})" ;;
  *) printf '{}\n' ;;
esac
`, { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "producer"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "adapter"), `#!/bin/bash
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
`, { mode: 0o700 })

    execFileSync(guardPath, ["--sab-ini", ini, "--log", log, "--producer", path.join(temp, "producer"), "--adapter", path.join(temp, "adapter"), "--state", state], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GUARD_TRIED: String(tried), GUARD_OKAY: String(okay), GUARD_HISTORICAL_AUTH: pausedAfter ? "0" : "1", GUARD_SERVER_SHAPE: serverShape } })

    const emitted = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : ""
    if (expected) expect(emitted).toContain(expected)
    else expect(emitted).toBe("")
    if (expected) expect(emitted.includes("recovered")).toBe(!pausedAfter)
    expect(fs.readFileSync(paused, "utf8").trim()).toBe(String(pausedAfter))
  })

  it.each([
    ["empty array", '{"servers":[]}'],
    ["empty object", '{"servers":{}}'],
    ["malformed stats map", '{"servers":[{"articles_tried":[],"articles_success":{},"daily":{}}]}'],
    ["mixed invalid member", '{"servers":{"primary":{"articles_tried":{},"articles_success":{},"daily":{}},"fill":"invalid"}}'],
    ["invalid counter", '{"servers":{"primary":{"articles_tried":{"today":-1},"articles_success":{"today":9},"daily":{"today":100}}}}'],
    ["aggregate counter overflow", '{"servers":{"primary":{"articles_tried":{"today":9007199254740991},"articles_success":{"today":0},"daily":{"today":0}},"fill":{"articles_tried":{"today":9007199254740991},"articles_success":{"today":0},"daily":{"today":0}}}}'],
  ])("treats %s server stats as blind instead of healthy zeroes", (_label, serverStats) => {
    const temp = root()
    const bin = path.join(temp, "bin")
    const calls = path.join(temp, "adapter.calls")
    const log = path.join(temp, "guard.log")
    const ini = path.join(temp, "sabnzbd.ini")
    const stats = path.join(temp, "server-stats.json")
    fs.mkdirSync(bin)
    fs.writeFileSync(ini, "api_key = test-only\n")
    const local = new Date()
    const day = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`
    fs.writeFileSync(stats, `${serverStats.replaceAll('"today"', JSON.stringify(day))}\n`)
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
case "$*" in
  *mode=warnings*) printf '{"warnings":[]}\n' ;;
  *mode=queue*) printf '{"queue":{"paused":false,"status":"Downloading","noofslots":0}}\n' ;;
  *mode=server_stats*) cat ${JSON.stringify(stats)} ;;
  *) printf '{}\n' ;;
esac
`, { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "producer"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "adapter"), `#!/bin/bash
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
`, { mode: 0o700 })

    expect(() => execFileSync(guardPath, ["--sab-ini", ini, "--log", log, "--producer", path.join(temp, "producer"), "--adapter", path.join(temp, "adapter")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })).toThrow()
    expect(fs.readFileSync(log, "utf8")).toContain("server-stats-response")
    const emitted = fs.readFileSync(calls, "utf8")
    expect(emitted).toContain("usenet.observe provider-health indeterminate:")
    expect(emitted).not.toMatch(/recovered:|sabnzbd\.pause/u)
  })

  it("fails closed when validated server stats cannot be extracted", () => {
    const temp = root()
    const bin = path.join(temp, "bin")
    const calls = path.join(temp, "adapter.calls")
    const curlCalls = path.join(temp, "curl.calls")
    const log = path.join(temp, "guard.log")
    const state = path.join(temp, "baseline.json")
    const ini = path.join(temp, "sabnzbd.ini")
    const realJq = execFileSync("which", ["jq"], { encoding: "utf8" }).trim()
    fs.mkdirSync(bin)
    fs.writeFileSync(ini, "api_key = test-only\n")
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
printf '%s\n' "$*" >> ${JSON.stringify(curlCalls)}
case "$*" in
  *mode=warnings*) printf '{"warnings":[]}\n' ;;
  *mode=queue*) printf '{"queue":{"paused":false,"status":"Downloading","noofslots":0}}\n' ;;
  *mode=server_stats*) printf '{"servers":{"primary":{"articles_tried":{},"articles_success":{},"daily":{}}}}\n' ;;
  *) printf '{}\n' ;;
esac
`, { mode: 0o700 })
    fs.writeFileSync(path.join(bin, "jq"), `#!/bin/bash
case "$*" in
  *@tsv*) exit 1 ;;
  *) exec ${JSON.stringify(realJq)} "$@" ;;
esac
`, { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "producer"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "adapter"), `#!/bin/bash
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
`, { mode: 0o700 })

    expect(() => execFileSync(guardPath, ["--sab-ini", ini, "--log", log, "--producer", path.join(temp, "producer"), "--adapter", path.join(temp, "adapter"), "--state", state], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })).toThrow()

    const emitted = fs.readFileSync(calls, "utf8").trim().split("\n")
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toContain("usenet.observe provider-health indeterminate:")
    expect(fs.readFileSync(log, "utf8")).toContain("server-stats-response")
    expect(fs.readFileSync(curlCalls, "utf8")).not.toContain("mode=pause")
    expect(emitted[0]).not.toMatch(/recovered:|sabnzbd\.pause/u)
    expect(fs.existsSync(state)).toBe(false)
  })

  it("accumulates sub-threshold failing intervals until the spend guard can judge them", () => {
    const temp = root()
    const bin = path.join(temp, "bin")
    const calls = path.join(temp, "adapter.calls")
    const runCount = path.join(temp, "runs")
    const paused = path.join(temp, "paused")
    const state = path.join(temp, "baseline.json")
    const log = path.join(temp, "guard.log")
    const ini = path.join(temp, "sabnzbd.ini")
    fs.mkdirSync(bin)
    fs.writeFileSync(ini, "api_key = test-only\n")
    fs.writeFileSync(runCount, "0\n")
    fs.writeFileSync(paused, "false\n")
    const local = new Date()
    const day = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`
    fs.writeFileSync(state, JSON.stringify({ day, tried: 0, okay: 0 }) + "\n")
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
case "$*" in
  *mode=pause*) printf 'true\n' > ${JSON.stringify(paused)}; printf '{"status":true}\n' ;;
  *mode=warnings*) printf '{"warnings":[]}\n' ;;
  *mode=server_stats*) run=$(cat ${JSON.stringify(runCount)}); [ "$run" = 0 ] && tried=30000 || tried=60000; okay=$((tried * 7 / 100)); printf '{"servers":[{"articles_tried":{"%s":%s},"articles_success":{"%s":%s},"daily":{"%s":0}}]}\n' "$(date +%Y-%m-%d)" "$tried" "$(date +%Y-%m-%d)" "$okay" "$(date +%Y-%m-%d)" ;;
  *mode=history*) printf '{"history":{"slots":[]}}\n' ;;
  *mode=queue*) printf '{"queue":{"paused":%s,"status":"Downloading","noofslots":1}}\n' "$(cat ${JSON.stringify(paused)})" ;;
  *) printf '{}\n' ;;
esac
`, { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "producer"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })
    fs.writeFileSync(path.join(temp, "adapter"), `#!/bin/bash
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
`, { mode: 0o700 })
    const args = ["--sab-ini", ini, "--log", log, "--producer", path.join(temp, "producer"), "--adapter", path.join(temp, "adapter"), "--state", state]

    execFileSync(guardPath, args, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    expect(fs.existsSync(calls)).toBe(false)
    expect(JSON.parse(fs.readFileSync(state, "utf8"))).toMatchObject({ tried: 0, okay: 0 })
    fs.writeFileSync(runCount, "1\n")
    execFileSync(guardPath, args, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    expect(fs.readFileSync(calls, "utf8")).toContain("sabnzbd.pause")
    expect(fs.readFileSync(paused, "utf8").trim()).toBe("true")
    expect(JSON.parse(fs.readFileSync(state, "utf8"))).toMatchObject({ tried: 60000, okay: 4200 })
  })

  it("uses the canonical producer with a fixed bounded argv contract and no detector speech token", () => {
    const source = fs.readFileSync(adapterPath, "utf8")
    expect(source).toContain('exec /usr/local/bin/node "$PRODUCER"')
    expect(source).toContain('"--agent" "sanctuary"')
    expect(source).toContain('"--source" "sanctuary-usenet"')
    expect(source).toContain('EVENT_TYPE="usenet.protective_action"')
    expect(source).toContain('usenet.observe) EVENT_TYPE="usenet.health_observation"')
    expect(source).toContain('"--event-type" "$EVENT_TYPE"')
    expect(source).toContain('"--action" "$ACTION"')
    expect(source).toContain('"--evidence" "$EVIDENCE"')
    expect(source).toContain('"--protective-state-verified" "$VERIFIED"')
    expect(source).toContain('"--protective-state-digest" "$VERIFICATION_DIGEST"')
    expect(source).toContain('"--protective-state-observed-at" "$VERIFIED_AT"')
    expect(source).toContain('OBSERVED_STATE="${TRANSITION%%:*}"')
    expect(source).toContain("printf '%s\\0%s\\0%s' \"$ACTION\" \"$INCIDENT\" \"$OBSERVED_STATE\"")
    expect(source).not.toContain('"$OBSERVED_STATE" "$VERIFICATION_DIGEST"')
    expect(source).not.toContain("prowlarr.disable-indexer")
    expect(fs.readFileSync(producerPath, "utf8")).not.toContain("prowlarr.disable-indexer")
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
    const local = new Date()
    fs.writeFileSync(`${log}.baseline.json`, JSON.stringify({ day: `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`, tried: 0, okay: 0 }) + "\n")
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/bash\nprintf '{}\\n'\n", { mode: 0o700 })
    fs.writeFileSync(path.join(bin, "jq"), `#!/bin/bash\ncase "$*" in\n  *valid_count*) echo true ;;\n  *@tsv*) printf '50000\\t0\\t1000000000\\n' ;;\n  *articles_tried*) echo 50000 ;;\n  *articles_success*) echo 0 ;;\n  *daily*) echo 1000000000 ;;\n  *queue.paused*) echo false ;;\n  *queue.status*) echo Downloading ;;\n  *queue.noofslots*) echo 0 ;;\n  *Authentication*) echo 0 ;;\n  *) echo 0 ;;\nesac\n`, { mode: 0o700 })
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
    const legacyCronBootHook = '(crontab -l 2>/dev/null | grep -v usenet_health; echo "*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh") | crontab -'
    const hook = `/bin/bash ${installRoot}/ouro-events/install-usenet-guard.sh --boot --install-root ${installRoot} --crontab-file ${crontabFile}`
    const previousInstallerHook = `/bin/bash ${installRoot}/ouro-events/install-usenet-guard.sh --boot --crontab-file ${crontabFile}`
    const externalMarkerCron = "0 3 * * * /opt/team/health # ouro:usenet-health"
    fs.mkdirSync(path.join(installRoot, "ouro-events"), { recursive: true })
    const killedResidue = [path.join(installRoot, "usenet_health.sh.ouro-next.999"), `${goFile}.ouro-next.999`, `${crontabFile}.ouro-restore.999`]
    for (const residue of killedResidue) fs.writeFileSync(residue, "stranded-global-bytes\n", { mode: 0o600 })
    fs.writeFileSync(goFile, `#!/bin/bash\n${legacyHook}\n${legacyCronBootHook}\n${previousInstallerHook}\n${hook}\n${hook}\n/usr/local/sbin/emhttp &\n`)
    fs.writeFileSync(crontabFile, `${externalMarkerCron}\n`, { mode: 0o600 })

    for (let index = 0; index < 2; index += 1) {
      execFileSync(installerPath, ["--install-only", "--source-root", source, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile])
    }

    expect(fs.readFileSync(crontabFile, "utf8")).toContain(`${externalMarkerCron}\n`)
    fs.rmSync(crontabFile)
    const renderedHooks = fs.readFileSync(goFile, "utf8").split("\n").filter((line) => line.startsWith("/bin/bash ") && line.includes("install-usenet-guard.sh --boot"))
    expect(renderedHooks).toEqual([hook])
    execFileSync("/bin/bash", ["-c", renderedHooks[0]!])

    const go = fs.readFileSync(goFile, "utf8")
    expect(go.match(new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(1)
    expect(go).not.toContain(previousInstallerHook)
    expect(go).not.toContain(legacyHook)
    expect(go).not.toContain(legacyCronBootHook)
    expect(go.indexOf(hook)).toBeLessThan(go.indexOf("/usr/local/sbin/emhttp"))
    expect(fs.readFileSync(crontabFile, "utf8").match(/# ouro:usenet-health$/gmu)).toHaveLength(1)
    expect(fs.readFileSync(crontabFile, "utf8")).toContain(`*/15 * * * * /bin/bash ${installRoot}/usenet_health.sh # ouro:usenet-health`)
    expect(fs.readFileSync(lifecycleLog, "utf8")).toBe("spool:--mount\nspool:--self-test\nevent:inactive\nspool:--mount\nspool:--self-test\nevent:active\nspool:--mount\nspool:--self-test\nevent:inactive\n")
    expect(transactionResidue(installRoot)).toEqual([])
    for (const residue of killedResidue) expect(fs.existsSync(residue), residue).toBe(false)
    const installer = fs.readFileSync(installerPath, "utf8")
    expect(installer).toContain('private_transaction_workspace install')
    expect(installer).not.toContain('mktemp -d "$INSTALL_ROOT/.ouro-usenet-stage')
    for (const file of ["usenet_health.sh", "ouro-events/emit-event.mjs", "ouro-events/emit-usenet-event.sh", "ouro-events/bootstrap-spool.sh", "ouro-events/install-usenet-guard.sh"]) {
      expect(fs.statSync(path.join(installRoot, file)).mode & 0o777).toBe(0o700)
    }
    const template = fs.readFileSync(path.resolve(__dirname, "../../../deploy/unraid/sanctuary.xml"), "utf8")
    expect(template).toContain('Target="/run/ouro-events"')
    expect(template).toContain('Mode="ro"')
    expect(template).toContain('Target="/run/sanctuary/sabnzbd.ini"')
  })

  it("replaces the exact unmarked legacy Sanctuary cron without duplicating the detector", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const goFile = path.join(temp, "go")
    const crontabFile = path.join(temp, "crontab")
    const lifecycleLog = path.join(temp, "lifecycle.log")
    const source = transactionalSource(temp, crontabFile, lifecycleLog)
    const legacyLine = `*/15 * * * * /bin/bash ${installRoot}/usenet_health.sh`
    const installedLine = `${legacyLine} # ouro:usenet-health`
    fs.writeFileSync(goFile, "#!/bin/bash\n/usr/local/sbin/emhttp &\n")
    fs.writeFileSync(crontabFile, `${legacyLine}\n0 3 * * * /usr/local/bin/unrelated\n`, { mode: 0o600 })

    execFileSync(installerPath, ["--install-only", "--source-root", source, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile])
    execFileSync(installerPath, ["--install-only", "--source-root", source, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile])

    const cron = fs.readFileSync(crontabFile, "utf8").trim().split("\n")
    expect(cron.filter((line) => line.startsWith(legacyLine))).toEqual([installedLine])
    expect(cron).toContain("0 3 * * * /usr/local/bin/unrelated")
    expect(fs.readFileSync(lifecycleLog, "utf8")).not.toContain("event:active\nspool:")
  })

  it("boots through a private reserved workspace while preserving unrelated marker cron", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const eventRoot = path.join(installRoot, "ouro-events")
    const crontabFile = path.join(temp, "crontab")
    const external = "0 3 * * * /opt/team/health # ouro:usenet-health"
    fs.mkdirSync(eventRoot, { recursive: true })
    fs.writeFileSync(path.join(eventRoot, "bootstrap-spool.sh"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })
    fs.writeFileSync(path.join(eventRoot, "emit-usenet-event.sh"), "#!/bin/bash\nexit 0\n", { mode: 0o700 })
    fs.writeFileSync(path.join(eventRoot, "emit-event.mjs"), "process.exit(0)\n", { mode: 0o600 })
    fs.writeFileSync(crontabFile, `${external}\n*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh\n`, { mode: 0o600 })

    execFileSync(installerPath, ["--boot", "--install-root", installRoot, "--crontab-file", crontabFile])

    const cron = fs.readFileSync(crontabFile, "utf8")
    expect(cron).toContain(`${external}\n`)
    expect(cron).toContain(`*/15 * * * * /bin/bash ${installRoot}/usenet_health.sh # ouro:usenet-health\n`)
    expect(cron.match(/# ouro:usenet-health$/gmu)).toHaveLength(2)
    const boot = installerFunction("boot_activate")
    expect(boot).toContain('private_transaction_workspace boot')
    expect(boot).toContain('/usr/bin/install -m 0600 /dev/null "$current.error"')
    expect(boot).toContain('/usr/bin/install -m 0600 /dev/null "$candidate"')
    expect(boot).not.toContain("mktemp /tmp/ouro-usenet-cron")
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
    const legacyCron = `*/15 * * * * /bin/bash ${installRoot}/usenet_health.sh\n`
    fs.writeFileSync(crontabFile, legacyCron, { mode: 0o600 })
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
  -l) [ -f ${JSON.stringify(cronState)} ] || { echo "no crontab for $(id -un)" >&2; exit 1; }; cat ${JSON.stringify(cronState)} ;;
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
    const legacyCron = `*/15 * * * * /bin/bash ${installRoot}/usenet_health.sh\n`
    fs.writeFileSync(crontabFile, legacyCron, { mode: 0o600 })
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
    expect(fs.readFileSync(crontabFile, "utf8")).toBe(legacyCron)
    expect(transactionResidue(installRoot)).toEqual([])
  })

  it("restores the manifest-verified host allowlist idempotently", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const goFile = path.join(temp, "go")
    const crontabFile = path.join(temp, "crontab")
    const snapshot = hostSnapshot(temp)
    fs.mkdirSync(path.join(installRoot, "ouro-events"), { recursive: true })
    const killedResidue = [path.join(installRoot, "usenet_health.sh.ouro-next.998"), `${goFile}.ouro-restore.998`, `${crontabFile}.ouro-next.998`]
    for (const residue of killedResidue) fs.writeFileSync(residue, "stranded-global-bytes\n", { mode: 0o600 })
    const unrelatedHook = "/bin/bash /opt/team/ouro-events/install-usenet-guard.sh --boot"
    fs.writeFileSync(goFile, `#!/bin/bash\n${unrelatedHook}\ncurrent-go\n`)
    fs.writeFileSync(crontabFile, "current-cron # ouro:usenet-health\nunrelated-cron\n")

    for (let index = 0; index < 2; index += 1) execFileSync(installerPath, ["--restore-root", snapshot, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile])

    expect(fs.readFileSync(goFile, "utf8")).toBe(`#!/bin/bash\n/bin/bash /boot/config/custom/ouro-events/install-usenet-guard.sh --boot\n${unrelatedHook}\ncurrent-go\n`)
    expect(fs.readFileSync(crontabFile, "utf8")).toBe("current-cron # ouro:usenet-health\nunrelated-cron\n*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh\n")
    expect(fs.readFileSync(path.join(installRoot, "usenet_health.sh"), "utf8")).toBe("snapshot:custom/usenet_health.sh\n")
    expect(fs.readFileSync(path.join(installRoot, "ouro-events", "install-usenet-guard.sh"), "utf8")).toBe("snapshot:custom/ouro-events/install-usenet-guard.sh\n")
    expect(transactionResidue(installRoot)).toEqual([])
    for (const residue of killedResidue) expect(fs.existsSync(residue), residue).toBe(false)
    const installer = fs.readFileSync(installerPath, "utf8")
    expect(installer).toContain('private_transaction_workspace restore')
    expect(installer).not.toContain('mktemp -d "$INSTALL_ROOT/.ouro-usenet-restore')
  })

  it("rejects marker-bearing unrelated cron fragments before host mutation", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const goFile = path.join(temp, "go")
    const crontabFile = path.join(temp, "crontab")
    const snapshot = hostSnapshot(temp)
    fs.writeFileSync(path.join(snapshot, "crontab.butler-lines"), "* * * * * curl --token stolen-secret # ouro:usenet-health\n", { mode: 0o600 })
    fs.writeFileSync(goFile, "original-go\n")
    fs.writeFileSync(crontabFile, "original-cron\n")

    expect(() => execFileSync(installerPath, ["--restore-root", snapshot, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile], { stdio: "ignore" })).toThrow()
    expect(fs.readFileSync(goFile, "utf8")).toBe("original-go\n")
    expect(fs.readFileSync(crontabFile, "utf8")).toBe("original-cron\n")
    expect(fs.existsSync(installRoot)).toBe(false)
  })

  it("rejects a captured boot hook with any argument or shell-command suffix before mutation", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const goFile = path.join(temp, "go")
    const crontabFile = path.join(temp, "crontab")
    const snapshot = hostSnapshot(temp)
    const malicious = "/bin/bash /boot/config/custom/ouro-events/install-usenet-guard.sh --boot --token stolen-secret"
    fs.writeFileSync(path.join(snapshot, "go.butler-lines"), `${malicious}\n`, { mode: 0o600 })
    fs.mkdirSync(installRoot, { recursive: true })
    fs.writeFileSync(goFile, "original-go\n")
    fs.writeFileSync(crontabFile, "original-cron\n")

    expect(() => execFileSync(installerPath, ["--restore-root", snapshot, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile], { stdio: "ignore" })).toThrow()
    expect(fs.readFileSync(goFile, "utf8")).toBe("original-go\n")
    expect(fs.readFileSync(crontabFile, "utf8")).toBe("original-cron\n")
    expect(fs.existsSync(path.join(installRoot, "usenet_health.sh"))).toBe(false)
  })

  it("fails closed when system crontab cannot be read for an operational reason", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const goFile = path.join(temp, "go")
    const lifecycleLog = path.join(temp, "lifecycle.log")
    const source = transactionalSource(temp, path.join(temp, "unused-cron"), lifecycleLog)
    const bin = path.join(temp, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "crontab"), "#!/bin/bash\necho 'permission denied' >&2\nexit 2\n", { mode: 0o700 })
    fs.writeFileSync(goFile, "original-go\n", { mode: 0o700 })

    expect(() => execFileSync(installerPath, ["--install-only", "--source-root", source, "--install-root", installRoot, "--go-file", goFile], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" })).toThrow()
    expect(fs.readFileSync(goFile, "utf8")).toBe("original-go\n")
    expect(fs.existsSync(path.join(installRoot, "usenet_health.sh"))).toBe(false)
  })

  it("attempts every host compensation and surfaces rollback failure", () => {
    const helper = installerFunction("rollback_host_state")
    const temp = root()
    const log = path.join(temp, "attempts")
    const script = `${helper}
TARGET_PATHS=(asset-0 asset-1)
GO_FILE=go
CRONTAB_FILE=cron
restore_target() { printf '%s\n' "$1" >> "$LOG"; case "$1" in asset-0|go) return 41 ;; esac; }
rollback_host_state backup
exit $?
`
    expect(() => execFileSync("/bin/bash", ["-c", script], { env: { ...process.env, LOG: log }, stdio: "ignore" })).toThrow()
    expect(fs.readFileSync(log, "utf8")).toBe("asset-0\nasset-1\ngo\ncron\n")
  })

  it("rolls the complete live host allowlist back when snapshot activation fails", () => {
    const temp = root()
    const installRoot = path.join(temp, "custom")
    const eventRoot = path.join(installRoot, "ouro-events")
    const goFile = path.join(temp, "go")
    const crontabFile = path.join(temp, "crontab")
    const snapshot = hostSnapshot(temp)
    const bin = path.join(temp, "bin")
    fs.mkdirSync(eventRoot, { recursive: true })
    fs.mkdirSync(bin)
    const targets = [path.join(installRoot, "usenet_health.sh"), ...["bootstrap-spool.sh", "emit-event.mjs", "emit-usenet-event.sh", "install-usenet-guard.sh"].map((name) => path.join(eventRoot, name))]
    for (const [index, target] of targets.entries()) fs.writeFileSync(target, `current-${index}\n`, { mode: 0o700 })
    fs.writeFileSync(goFile, "current-go\n", { mode: 0o700 })
    fs.writeFileSync(crontabFile, "current-cron # ouro:usenet-health\n", { mode: 0o600 })
    const before = new Map([...targets, goFile, crontabFile].map((target) => [target, fs.readFileSync(target, "utf8")]))
    const failingTarget = crontabFile
    const failureMarker = path.join(temp, "mv.failed")
    fs.writeFileSync(path.join(bin, "mv"), `#!/bin/bash
if [ "$2" = ${JSON.stringify(failingTarget)} ] && [ ! -e ${JSON.stringify(failureMarker)} ]; then
  touch ${JSON.stringify(failureMarker)}
  exit 77
fi
exec /bin/mv "$@"
`, { mode: 0o700 })

    expect(() => execFileSync(installerPath, ["--restore-root", snapshot, "--install-root", installRoot, "--go-file", goFile, "--crontab-file", crontabFile], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" })).toThrow()
    for (const [target, content] of before) expect(fs.readFileSync(target, "utf8"), target).toBe(content)
    expect(transactionResidue(installRoot)).toEqual([])
  })
})
