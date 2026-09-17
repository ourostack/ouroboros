import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { executeSanctuaryAcceptanceAdapter, type SanctuaryAcceptanceAdapterDependencies } from "../../../heart/daemon/sanctuary-acceptance-adapter"

describe("Unit16 gateway launcher contract", () => {
  it("executes every materializer and harness branch with the exact readonly gateway mount", () => {
    const source = fs.readFileSync("deploy/unraid/sanctuary-unit16-run.sh", "utf8")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-shell-"))
    const extract = (name: string) => {
      const start = source.indexOf(`${name}() {`)
      const end = source.indexOf("\n}", start)
      expect(start).toBeGreaterThan(-1)
      return source.slice(start, end + 2).replaceAll("/usr/bin/timeout", "fixture_timeout").replaceAll("/usr/bin/docker", "fixture_docker").replaceAll("/usr/local/bin/node", JSON.stringify(process.execPath))
    }
    const traces: unknown[] = []
    try {
      fs.writeFileSync(path.join(root, "inventory"), "{}")
      for (const [kind, command, phase, broker] of [
        ["materialize", "unraid-key-rotate", "", "no"], ["materialize", "cursor-snapshot", "before", "no"], ["materialize", "telegram-bootstrap", "", "no"],
        ["harness", "telegram-bootstrap", "", "no"], ["harness", "callback-inject", "", "no"], ["harness", "evidence-snapshot", "", "yes"],
        ["harness", "reboot-request", "", "yes"], ["harness", "cursor-delta", "", "no"],
      ]) {
        const argsPath = path.join(root, "args")
        fs.writeFileSync(argsPath, "")
        const script = `
set -eu
ROOT=${JSON.stringify(root)}
ARGS=${JSON.stringify(argsPath)}
fixture_timeout() { shift 3; "$@"; }
fixture_docker() { printf '%s\\n' "$@" >>"$ARGS"; printf '%s\\n' '{"allowedRoot":"/evidence"}'; }
install() { :; }
PRIVATE_ROOT=$ROOT
CLOSED_INVENTORY=$ROOT/inventory
COMMAND=${command}
BROKER=${broker}
TIME_LIMIT=900
NETWORK=none
BUNDLE_MODE=readonly
EVIDENCE_ROOT=$ROOT
RUNTIME_ROOT=$ROOT
BUNDLE_ROOT=$ROOT
CONFIG_PATH=$ROOT/config
SOCKET_ROOT=$ROOT/socket
IMAGE_FACT=$ROOT/image
CONTAINER_FACT=$ROOT/container
PROCESS_BINDING_FACT=$ROOT/process
HEALTH_FACT=$ROOT/health
CONTAINER_INSPECT_FACT=$ROOT/inspect
ACCEPTANCE_PIN_ROOT=$ROOT/acceptance
IMAGE_ID=sha256:${"a".repeat(64)}
exec 3</dev/null
${extract(kind === "materialize" ? "materialize_config" : "run_harness")}
${kind === "materialize" ? `materialize_config "$ROOT/output" "${phase}"` : "run_harness"}
`
        const result = spawnSync("/bin/sh", ["-xc", script], { encoding: "utf8" })
        expect(result.status, result.stderr).toBe(0)
        const args = fs.readFileSync(argsPath, "utf8").split("\n")
        expect(args.filter((arg) => arg === "type=bind,src=/run/ouro-authority,dst=/run/ouro-authority,readonly")).toHaveLength(1)
        expect(args).toContain("10001:10001")
        expect(args).toContain("--read-only")
        traces.push({ kind, command, phase, args, trace: result.stderr })
      }
      fs.writeFileSync("coverage/s6-acceptance-finish-shell-trace.json", `${JSON.stringify(traces, null, 2)}\n`)
      expect(extract("materialize_config")).not.toContain("fixture_timeout -s KILL 30")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  it("gives every config and acceptance container the exact readonly authority socket mount", () => {
    const source = fs.readFileSync("deploy/unraid/sanctuary-unit16-run.sh", "utf8")
    const containers = source.split("/usr/bin/docker run").slice(1).map((part) => part.split(/\n(?=\s*(?:elif |else|fi|;;))/u)[0]!).filter((part) => part.includes("--user 10001:10001"))
    expect(containers).toHaveLength(8)
    for (const container of containers) expect(container.match(/--mount "type=bind,src=\/run\/ouro-authority,dst=\/run\/ouro-authority,readonly"/gu)).toHaveLength(1)
    expect(source).not.toContain('{"activePollers":0,"productionContainerStopped":true}')
    expect(source).not.toContain("telegram-poller-count.json")
    expect(source).toContain("telegram-bootstrap) TIME_LIMIT=900; NETWORK=none")
    expect(source).not.toContain('--mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli"')
    const contract = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary-acceptance-contract.json", "utf8"))
    expect(contract.scenarioSources["telegram-offset"]).toEqual({ kind: "signed-gateway-cursor", operation: "telegram.cursor.snapshot", redaction: "stable-logical-progress-digest-only" })
    expect(JSON.stringify(contract)).not.toContain("/state/senses/telegram/offset.json")
  })

  function fixture() {
    const now = Date.now()
    const cursor = { cursor: 42, pendingUpdateIds: [], keyId: "epoch-1", publicKeyDigest: `sha256:${"b".repeat(64)}`, botId: "123", progressDigest: `sha256:${"a".repeat(64)}` }
    const proof = { schemaVersion: 1, activePollers: 1, residentStopped: true, processBindingDigest: "c".repeat(64), keyId: cursor.keyId, publicKeyDigest: cursor.publicKeyDigest, botId: cursor.botId, observedAt: new Date(now).toISOString() }
    const calls: unknown[] = []
    const dependencies = {
      now: () => now,
      hostRequest: async (payload: unknown) => { calls.push(payload); return proof },
      gateway: () => ({ credentials: { botId: "123" }, cursorSnapshot: async () => cursor, authorityTransport: { hostApproval: { refresh: async () => true }, api: { stop: () => calls.push("closed") } } }),
      readFixedFile: () => '{"activePollers":0,"productionContainerStopped":true}',
    } as unknown as SanctuaryAcceptanceAdapterDependencies
    return { dependencies, proof, calls }
  }
  it("requires one real root poller and a stopped resident rather than a zero-poller file", async () => {
    const f = fixture()
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "quiesce_telegram_poller", expectedState: "stopped" }, f.dependencies)).resolves.toEqual({ quiesced: true, activePollers: 1 })
    expect(f.calls).toEqual([{ operation: "telegram_gateway_quiescence", targetId: "sanctuary" }, "closed"])
  })
  it("refuses missing root health and uses receipt-time freshness by default", async () => {
    const f = fixture()
    f.dependencies.now = undefined
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "quiesce_telegram_poller", expectedState: "stopped" }, f.dependencies)).resolves.toMatchObject({ activePollers: 1 })
    const gateway = f.dependencies.gateway!()
    gateway.authorityTransport.hostApproval = undefined
    f.dependencies.gateway = () => gateway
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "quiesce_telegram_poller", expectedState: "stopped" }, f.dependencies)).rejects.toThrow(/health/u)
  })
  it.each([
    { activePollers: 0 }, { activePollers: 2 }, { residentStopped: false }, { keyId: "other" }, { publicKeyDigest: `sha256:${"0".repeat(64)}` },
    { botId: "other" }, { processBindingDigest: "bad" }, { observedAt: "2000-01-01T00:00:00.000Z" }, { observedAt: "2999-01-01T00:00:00.000Z" }, { extra: true },
  ])("refuses changed root quiescence proof %j", async (patch) => {
    const f = fixture()
    Object.assign(f.proof, patch)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "quiesce_telegram_poller", expectedState: "stopped" }, f.dependencies)).rejects.toThrow()
  })
})
