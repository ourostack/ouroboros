// The upgrade script's gate wiring: the decision (pass commits, pins and prunes; fail rolls back), argument parsing,
// and a source contract that pins the order the live host depends on (hold, preserve, gate, commit, pin, prune).
import * as fs from "node:fs"
import * as path from "node:path"
import { beforeAll, describe, expect, it } from "vitest"

const SCRIPT = path.resolve(__dirname, "../../../deploy/unraid/sanctuary-butler-upgrade.mjs")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let upgrade: any
let source = ""
beforeAll(async () => {
  upgrade = await import(/* @vite-ignore */ SCRIPT)
  source = fs.readFileSync(SCRIPT, "utf8")
})

function harness(gate: { ok: boolean; detail?: string }, failing: Partial<Record<"commit" | "rollback" | "confirmRollback", boolean>> = {}) {
  const calls: string[] = []
  const step = (name: keyof typeof failing, result?: unknown) => () => { calls.push(name); if (failing[name]) throw new Error(`${name} broke`); return result }
  return {
    calls,
    deps: {
      runGate: () => { calls.push("gate"); return gate },
      commit: step("commit"), rollback: step("rollback"), confirmRollback: step("confirmRollback", "image:prev"),
      pin: () => { calls.push("pin") }, prune: () => { calls.push("prune") },
      log: (line: string) => { calls.push(`log:${line}`) },
    },
  }
}

describe("completeGatedUpgrade", () => {
  it("commits, pins and prunes, in that order, only when the gate passes", () => {
    const h = harness({ ok: true })
    expect(upgrade.completeGatedUpgrade(h.deps)).toEqual({ passed: true })
    expect(h.calls).toEqual(["gate", "commit", "pin", "prune", "log:GATE PASS"])
  })

  it("rolls back and confirms the predecessor on a failed gate, without committing, pinning or pruning", () => {
    const h = harness({ ok: false, detail: "chef-question failed" })
    expect(upgrade.completeGatedUpgrade(h.deps)).toEqual({ passed: false, rolledBackTo: "image:prev" })
    expect(h.calls).toEqual(["gate", "log:gate failed: chef-question failed", "rollback", "confirmRollback", "log:GATE FAIL — ROLLED BACK to image:prev"])
  })

  it("names a failed gate even when it gave no detail", () => {
    const h = harness({ ok: false })
    upgrade.completeGatedUpgrade(h.deps)
    expect(h.calls[1]).toBe("log:gate failed: see the case lines above")
  })

  it("lets a failed rollback or commit propagate, so nothing is pinned or reported as passed", () => {
    const rollbackFails = harness({ ok: false }, { rollback: true })
    expect(() => upgrade.completeGatedUpgrade(rollbackFails.deps)).toThrow("rollback broke")
    expect(rollbackFails.calls).not.toContain("confirmRollback")
    const commitFails = harness({ ok: true }, { commit: true })
    expect(() => upgrade.completeGatedUpgrade(commitFails.deps)).toThrow("commit broke")
    expect(commitFails.calls).toEqual(["gate", "commit"])
    const confirmFails = harness({ ok: false }, { confirmRollback: true })
    expect(() => upgrade.completeGatedUpgrade(confirmFails.deps)).toThrow("confirmRollback broke")
  })

  it("logs to the console by default", () => {
    const h = harness({ ok: true })
    const original = console.log
    const lines: string[] = []
    console.log = (line: string) => { lines.push(line) }
    try { upgrade.completeGatedUpgrade({ ...h.deps, log: undefined }) } finally { console.log = original }
    expect(lines).toEqual(["GATE PASS"])
  })
})

describe("parseUpgradeArgs", () => {
  it("accepts the documented forms", () => {
    expect(upgrade.parseUpgradeArgs(["upgrade", "0.1.0-alpha.865"])).toMatchObject({ phase: "upgrade", version: "0.1.0-alpha.865", noGate: false, plant: undefined, rehearse: undefined })
    expect(upgrade.parseUpgradeArgs(["upgrade", "0.1.0-alpha.865", "--plant", "chef-question"])).toMatchObject({ plant: "chef-question" })
    expect(upgrade.parseUpgradeArgs(["upgrade", "0.1.0-alpha.865", "--no-gate"])).toMatchObject({ noGate: true })
    expect(upgrade.parseUpgradeArgs(["upgrade", "0.1.0-alpha.865", "--rehearse", "start"])).toMatchObject({ rehearse: "start" })
    expect(upgrade.parseUpgradeArgs(["verify"])).toMatchObject({ phase: "verify", gate: false })
    expect(upgrade.parseUpgradeArgs(["verify", "--gate"])).toMatchObject({ phase: "verify", gate: true })
    expect(upgrade.parseUpgradeArgs(["preflight", "0.1.0-alpha.865"])).toMatchObject({ phase: "preflight" })
  })

  it.each([
    [[]], [["bogus"]], [["upgrade"]], [["upgrade", "latest"]], [["upgrade", "0.1.0-alpha.865", "--plant"]], [["upgrade", "0.1.0-alpha.865", "--wat"]],
    [["upgrade", "0.1.0-alpha.865", "extra"]], [["verify", "--no-gate"]], [["verify", "0.1.0-alpha.865"]], [["preflight", "0.1.0-alpha.865", "--no-gate"]],
    [["upgrade", "0.1.0-alpha.865", "--no-gate", "--plant", "x"]], [["upgrade", "0.1.0-alpha.865", "--rehearse", "start", "--no-gate"]], [["upgrade", "0.1.0-alpha.865", "--rehearse", "start", "--plant", "x"]],
  ])("rejects %j", (argv) => {
    expect(() => upgrade.parseUpgradeArgs(argv)).toThrow()
  })
})

describe("upgrade script contract", () => {
  const at = (needle: string | RegExp, from = 0) => {
    const found = typeof needle === "string" ? source.indexOf(needle, from) : source.slice(from).search(needle) + (source.slice(from).search(needle) < 0 ? 0 : from)
    expect(found, `${needle} must appear`).toBeGreaterThanOrEqual(0)
    return found
  }

  it("holds the commit, preserves, then gates, and only the gate or --no-gate path pins and prunes", () => {
    const body = source.slice(at("function upgrade(version, rehearse"), at("// ---- verify"))
    expect(body).toContain('rehearse ? ["--fail-after", rehearse] : gated ? ["--hold-commit"] : []')
    const order = [body.indexOf('"--hold-commit"'), body.indexOf("resumeSupervision()\n  say(\"preservation\")"), body.indexOf("completeGatedUpgrade({")]
    expect(order.every((n) => n >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(body.match(/pinTemplate\(version\)/g)).toHaveLength(2)
    expect(body).toContain("} else if (!gated) { pinTemplate(version); pruneButlerImages() }")
    expect(body).toContain('"upgrade-rollback"')
    expect(body).toContain("pin: () => pinTemplate(version)")
    expect(body).toContain("--no-gate: this upgrade will NOT be replay-gated")
  })

  it("refuses a gated upgrade before touching anything when the replay peers are not provisioned", () => {
    const body = source.slice(at("function upgrade(version, rehearse"))
    expect(body.indexOf("replay peers are not provisioned")).toBeLessThan(body.indexOf("pauseSupervision()"))
  })

  it("runs the live package's gate and passes --plant through", () => {
    expect(source).toContain("const GATE_SCRIPT = `${ROOT}/package/deploy/unraid/sanctuary-replay-gate.mjs`")
    expect(source).toContain('[GATE_SCRIPT, "run", ...(plant ? ["--plant", plant] : [])]')
  })

  it("does nothing when imported, and the gate it calls ships in the same directory", () => {
    expect(source).toContain("if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) run(process.argv.slice(2))")
    expect(fs.existsSync(path.join(path.dirname(SCRIPT), "sanctuary-replay-gate.mjs"))).toBe(true)
  })
})
