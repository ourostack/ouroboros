// The upgrade script's gate wiring: the decision (pass commits, pins and prunes; fail rolls back), argument parsing,
// and a source contract that pins the order the live host depends on (hold, preserve, gate, commit, pin, prune).
import * as fs from "node:fs"
import * as path from "node:path"
import { beforeAll, describe, expect, it, vi } from "vitest"

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

describe("heldUpgradeProblem", () => {
  it("is empty only while the journal exists and the new image is live", () => {
    expect(upgrade.heldUpgradeProblem({ journalExists: true, liveImage: "img:865", expectedImage: "img:865" })).toBeNull()
    expect(upgrade.heldUpgradeProblem({ journalExists: false, liveImage: "img:865", expectedImage: "img:865" })).toMatch(/journal is gone/)
    expect(upgrade.heldUpgradeProblem({ journalExists: true, liveImage: "img:864", expectedImage: "img:865" })).toMatch(/img:864.*img:865/)
  })
})

describe("runReplayGate", () => {
  const spawned: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = []
  const spawn = (status: number | null, signal: string | null = null) => (file: string, args: string[], options: Record<string, unknown>) => { spawned.push({ file, args, options }); return { status, signal } }

  it("runs the live package's gate with an overall timeout and passes --plant through", () => {
    spawned.length = 0
    expect(upgrade.runReplayGate("chef-question", { spawn: spawn(0), exists: () => true })).toEqual({ ok: true })
    expect(spawned[0]!.args.slice(1)).toEqual(["run", "--plant", "chef-question"])
    expect(spawned[0]!.options).toMatchObject({ stdio: "inherit", timeout: upgrade.GATE_TIMEOUT_MS, killSignal: "SIGKILL" })
    expect(upgrade.GATE_TIMEOUT_MS).toBeGreaterThan(20 * 60 * 1000)
  })

  it("fails on a non-zero exit, a timeout kill, or a missing gate", () => {
    expect(upgrade.runReplayGate(undefined, { spawn: spawn(1), exists: () => true })).toMatchObject({ ok: false, detail: expect.stringContaining("exited 1") })
    expect(upgrade.runReplayGate(undefined, { spawn: spawn(null, "SIGKILL"), exists: () => true })).toMatchObject({ ok: false, detail: expect.stringContaining("SIGKILL") })
    expect(upgrade.runReplayGate(undefined, { spawn: spawn(0), exists: () => false })).toMatchObject({ ok: false, detail: expect.stringContaining("missing") })
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
    const body = source.slice(source.indexOf("function upgrade(version, rehearse"))
    // the held upgrade must still be the live one right before the gate may commit it, and again inside commit
    expect(body).toContain("const stillHeld = () => heldUpgradeProblem(")
    expect(body).toContain("expectedImage: image(version)")
    expect(body.slice(body.indexOf("runGate: () => {"), body.indexOf("commit: () => {"))).toContain("stillHeld()")
    expect(body.slice(body.indexOf("commit: () => {"), body.indexOf("rollback: () => {"))).toContain("stillHeld()")
  })

  it("does nothing when imported, and the gate it calls ships in the same directory", () => {
    expect(source).toContain("if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) run(process.argv.slice(2)).catch(")
    expect(fs.existsSync(path.join(path.dirname(SCRIPT), "sanctuary-replay-gate.mjs"))).toBe(true)
  })
})

describe("telegramApiReachable", () => {
  const sleeps: number[] = []
  const sleep = async (ms: number) => { sleeps.push(ms) }
  it("is reachable on any HTTP answer, probing the bare API host without a token", async () => {
    sleeps.length = 0
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }))
    await expect(upgrade.telegramApiReachable({ fetchImpl, sleep })).resolves.toEqual({ ok: true, detail: "HTTP 404" })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.telegram.org/")
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "GET" })
    expect(sleeps).toEqual([])
  })
  it("retries a transient failure and then succeeds", async () => {
    sleeps.length = 0
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("getaddrinfo EAI_AGAIN api.telegram.org") }))
      .mockResolvedValueOnce(new Response("", { status: 302 }))
    await expect(upgrade.telegramApiReachable({ fetchImpl, sleep, retryDelayMs: 7 })).resolves.toEqual({ ok: true, detail: "HTTP 302" })
    expect(sleeps).toEqual([7])
  })
  it("reports unreachable after every try, with the underlying cause", async () => {
    sleeps.length = 0
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo EAI_AGAIN api.telegram.org") }) })
    const result = await upgrade.telegramApiReachable({ fetchImpl, sleep, tries: 3, retryDelayMs: 5 })
    expect(result).toEqual({ ok: false, detail: "fetch failed: getaddrinfo EAI_AGAIN api.telegram.org (3 attempts)" })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([5, 5])
  })
  it("describes non-Error and cause-less failures, and never claims reachability with zero tries", async () => {
    const strings = await upgrade.telegramApiReachable({ fetchImpl: async () => { throw "boom" }, sleep, tries: 1 })
    expect(strings).toEqual({ ok: false, detail: "boom (1 attempts)" })
    const plain = await upgrade.telegramApiReachable({ fetchImpl: async () => { throw new Error("timed out") }, sleep, tries: 1 })
    expect(plain.detail).toBe("timed out (1 attempts)")
    expect((await upgrade.telegramApiReachable({ tries: 0 })).ok).toBe(false)
  })
  it("uses the real timer and fetch by default", async () => {
    const real = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(new Response("", { status: 200 })) as never
    try { await expect(upgrade.telegramApiReachable({ retryDelayMs: 1 })).resolves.toMatchObject({ ok: true }) } finally { globalThis.fetch = real }
  })
  it("is checked in the upgrade before host supervision is paused", () => {
    const body = source.slice(source.indexOf("async function upgrade(version, rehearse"))
    const check = body.indexOf("await telegramApiReachable()")
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(body.indexOf("pauseSupervision()"))
    expect(body.slice(check, body.indexOf("pauseSupervision()"))).toContain("Nothing was paused or changed")
  })
})
