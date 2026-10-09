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

  it("puts the escalation grant's directory and file back to root after the recursive chown to the resident", () => {
    const migrate = source.slice(source.indexOf("function migrateBundle("), source.indexOf("// Host supervision for the root-authority"))
    expect(migrate.indexOf('["-R", "10001:10001", BUNDLE]')).toBeGreaterThanOrEqual(0)
    expect(migrate.indexOf('["-R", "10001:10001", BUNDLE]')).toBeLessThan(migrate.indexOf("restoreEscalationGrantRoot()"))
    const restore = source.slice(source.indexOf("function restoreEscalationGrantRoot()"), source.indexOf("function migrateBundle("))
    expect(restore).toContain("`${BUNDLE}/state/a2a`")
    expect(restore).toContain('sh("/bin/chown", ["-h", "0:0", dir])')
    expect(restore).toContain("chmodSync(dir, 0o755)")
    expect(restore).toContain("`${dir}/escalation-grants.json`")
    expect(restore).toContain('sh("/bin/chown", ["-h", "0:0", grants])')
    expect(restore).toContain("chmodSync(grants, 0o644)")
    // the resident's own subdirectories stay writable to it
    expect(restore).toContain('["tasks", "pins", "seen"]')
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
    const check = body.indexOf("await checkTelegramBeforePause(")
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(body.indexOf("pauseSupervision()"))
    expect(body.slice(check, body.indexOf("pauseSupervision()"))).toContain("Nothing was paused or changed")
  })
})

describe("checkTelegramBeforePause", () => {
  it("probes Telegram on a fresh upgrade", async () => {
    const probe = vi.fn(async () => ({ ok: true, detail: "HTTP 200" }))
    await expect(upgrade.checkTelegramBeforePause({ journalExists: false, probe })).resolves.toEqual({ skipped: false, ok: true, detail: "HTTP 200" })
    expect(probe).toHaveBeenCalledOnce()
  })
  it("passes a failed probe through", async () => {
    const probe = async () => ({ ok: false, detail: "down (3 attempts)" })
    await expect(upgrade.checkTelegramBeforePause({ journalExists: false, probe })).resolves.toEqual({ skipped: false, ok: false, detail: "down (3 attempts)" })
  })
  it("skips the probe when an upgrade journal exists, so a resume or rollback is never blocked by it", async () => {
    const probe = vi.fn()
    await expect(upgrade.checkTelegramBeforePause({ journalExists: true, probe })).resolves.toEqual({ skipped: true, ok: true, detail: "upgrade journal present" })
    expect(probe).not.toHaveBeenCalled()
  })
  it("defaults to the real probe", async () => {
    const real = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 })) as never
    try { await expect(upgrade.checkTelegramBeforePause({ journalExists: false })).resolves.toMatchObject({ skipped: false, ok: true }) } finally { globalThis.fetch = real }
  })
  it("is what the upgrade calls before pausing, keyed on the upgrade journal", () => {
    const body = source.slice(source.indexOf("async function upgrade(version, rehearse"))
    const check = body.indexOf("await checkTelegramBeforePause({ journalExists: existsSync(UPGRADE_JOURNAL)")
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(body.indexOf("pauseSupervision()"))
  })
})

describe("the psyche folder is resident-owned 0600 and read-only through the mount", () => {
  const node = (uid: number, mode: number, kind: "dir" | "file" | "link", children: Record<string, ReturnType<typeof node>> = {}) => ({ uid, mode, kind, children })
  const fsFor = (tree: ReturnType<typeof node>) => {
    const find = (p: string) => p.split("/").filter(Boolean).slice(1).reduce((cur, part) => cur.children[part]!, tree)
    return {
      lstat: (p: string) => { const n = find(p); return { uid: n.uid, mode: n.mode, isSymbolicLink: () => n.kind === "link", isDirectory: () => n.kind === "dir" } },
      readdir: (p: string) => Object.keys(find(p).children),
    }
  }
  const sound = () => node(10001, 0o755, "dir", { "SOUL.md": node(10001, 0o600, "file"), sub: node(10001, 0o755, "dir", { "LORE.md": node(10001, 0o600, "file") }) })

  it("finds nothing wrong with a resident-owned 0755/0600 tree", () => {
    expect(upgrade.psycheProblems("/p", fsFor(sound()))).toEqual([])
  })
  it("reports a root-owned file, a 0644 file, a group-writable directory and a symlink", () => {
    const tree = sound()
    tree.children["SOUL.md"] = node(0, 0o644, "file")
    tree.children.sub!.mode = 0o775
    tree.children.link = node(10001, 0o777, "link")
    const problems = upgrade.psycheProblems("/p", fsFor(tree))
    expect(problems).toEqual(expect.arrayContaining(["/p/SOUL.md is owned by uid 0, not the resident (10001)", "/p/SOUL.md is mode 644, not 600", "/p/sub is writable by group or others (mode 775)", "/p/link is a symlink"]))
    expect(problems).toHaveLength(4)
  })
  it("uses the real filesystem by default", () => {
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "psyche-own-"))
    fs.writeFileSync(path.join(dir, "a.md"), "x")
    fs.chmodSync(path.join(dir, "a.md"), 0o666)
    expect(upgrade.psycheProblems(dir).some((line: string) => line.includes("not 600"))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  it("is restored after the bundle is handed back to the resident, and checked by verify", () => {
    const migrate = source.slice(source.indexOf("function migrateBundle("), source.indexOf("// Host supervision for the root-authority gateway"))
    expect(migrate.indexOf('"-R", "10001:10001", BUNDLE')).toBeLessThan(migrate.indexOf("restorePsycheRoot()"))
    expect(source).not.toContain('"-R", "-h", "0:0", dir')
    const verifyBody = source.slice(source.indexOf("function verify("), source.indexOf("function fail("))
    expect(verifyBody).toContain("psycheProblems(psycheDir)")
    expect(verifyBody).toContain("psyche files are resident-owned 0600")
  })
  it("restorePsycheModes sets directories 0755 and files 0600 and leaves symlinks alone", () => {
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "psyche-modes-"))
    fs.mkdirSync(path.join(dir, "sub"))
    fs.writeFileSync(path.join(dir, "sub", "a.md"), "x"); fs.chmodSync(path.join(dir, "sub", "a.md"), 0o644)
    fs.chmodSync(path.join(dir, "sub"), 0o700)
    fs.symlinkSync("sub/a.md", path.join(dir, "link"))
    upgrade.restorePsycheModes(dir)
    expect(fs.statSync(path.join(dir, "sub")).mode & 0o777).toBe(0o755)
    expect(fs.statSync(path.join(dir, "sub", "a.md")).mode & 0o777).toBe(0o600)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("the resident mounts psyche read-only over the writable bundle", () => {
  const dest = "/home/ouro/AgentBundles/sanctuary.ouro/psyche"
  it("passes the mount argument to docker create", () => {
    expect(upgrade.PSYCHE_MOUNT).toMatch(/\/psyche:\/home\/ouro\/AgentBundles\/sanctuary\.ouro\/psyche:ro$/)
    const recreate = source.slice(source.indexOf("function recreateResident("), source.indexOf("export function psycheProblems"))
    expect(recreate).toContain('"-v", PSYCHE_MOUNT')
    expect(recreate.indexOf('"-v", PSYCHE_MOUNT')).toBeLessThan(recreate.indexOf("image(version)])"))
  })
  it("reports nothing for a read-only psyche mount", () => {
    expect(upgrade.psycheMountIssue([{ Destination: dest, RW: false }, { Destination: "/other", RW: true }])).toBeNull()
  })
  it("reports a read-write psyche mount", () => {
    expect(upgrade.psycheMountIssue([{ Destination: dest, RW: true }])).toBe("psyche is mounted read-write in the resident")
  })
  it("reports a missing mount, including for malformed input", () => {
    const missing = "psyche is not mounted separately in the resident, so it could be renamed or replaced"
    expect(upgrade.psycheMountIssue([{ Destination: "/other", RW: false }])).toBe(missing)
    expect(upgrade.psycheMountIssue([])).toBe(missing)
    expect(upgrade.psycheMountIssue(null)).toBe(missing)
    expect(upgrade.psycheMountIssue([null, undefined])).toBe(missing)
  })
  it("is checked by verify", () => {
    const verifyBody = source.slice(source.indexOf("function verify("), source.indexOf("function fail("))
    expect(verifyBody).toContain("psycheMountIssue(psycheMount)")
    expect(verifyBody).toContain("psyche is mounted read-only in the resident")
  })
})
