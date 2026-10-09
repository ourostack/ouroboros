import { readFileSync } from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"

type Res = { code: number; stdout: string; stderr: string }
type Lib = Record<string, any>
const fixture = (name: string) => readFileSync(path.resolve("src/__tests__/scripts/fixtures", name), "utf8")
const lib = (): Promise<Lib> => import(pathToFileURL(path.resolve("scripts/butler-ship-lib.mjs")).href)
const cli = (): Promise<Lib> => import(pathToFileURL(path.resolve("scripts/butler-ship.mjs")).href)

const ok = (stdout = ""): Res => ({ code: 0, stdout, stderr: "" })
const nok = (stderr = "boom", code = 1): Res => ({ code, stdout: "", stderr })

describe("butler-ship pure logic", () => {
  it("parses args with defaults, env host and flags", async () => {
    const { parseShipArgs } = await lib()
    expect(parseShipArgs(["0.1.0-alpha.873"], {})).toEqual({ version: "0.1.0-alpha.873", host: "sanctuary", noGate: false, plant: undefined, dryRun: false })
    expect(parseShipArgs(["0.1.0-alpha.873"], { BUTLER_HOST: "tower" }).host).toBe("tower")
    expect(parseShipArgs(["--host", "h", "1.2.3", "--plant", "books-up", "--dry-run"], { BUTLER_HOST: "x" })).toMatchObject({ host: "h", plant: "books-up", dryRun: true })
    expect(parseShipArgs(["1.2.3", "--no-gate"]).noGate).toBe(true)
  })

  it("rejects bad args", async () => {
    const { parseShipArgs } = await lib()
    expect(() => parseShipArgs([])).toThrow(/semver/)
    expect(() => parseShipArgs(["1.2.3; rm -rf"])).toThrow(/semver/)
    expect(() => parseShipArgs(["1.2.3", "--bogus"])).toThrow(/Usage/)
    expect(() => parseShipArgs(["1.2.3", "2.0.0"])).toThrow(/Usage/)
    expect(() => parseShipArgs(["1.2.3", "--host", "a b"])).toThrow(/alias/)
    expect(() => parseShipArgs(["1.2.3", "--plant", "x;y"])).toThrow(/case id/)
    expect(() => parseShipArgs(["1.2.3", "--no-gate", "--plant", "books-up"])).toThrow(/cannot be combined/)
  })

  it("maps a version to its merge commit", async () => {
    const { findReleaseCommit } = await lib()
    const commits = [{ sha: "a", commit: { message: "Idempotent steward (0.1.0-alpha.871) (#1053)\n\nbody" } }, { sha: "b", commit: { message: "Other (0.1.0-alpha.870) (#1052)" } }, { sha: "c", commit: {} }]
    expect(findReleaseCommit(commits, "0.1.0-alpha.870")).toBe("b")
    expect(findReleaseCommit(commits, "0.1.0-alpha.871")).toBe("a")
    expect(findReleaseCommit(commits, "0.1.0-alpha.9")).toBeUndefined()
    expect(findReleaseCommit(undefined, "1.0.0")).toBeUndefined()
  })

  it("reads coverage-gate state", async () => {
    const { coverageState } = await lib()
    expect(coverageState([{ status: "completed", conclusion: "failure" }, { status: "completed", conclusion: "success" }])).toBe("success")
    expect(coverageState([{ status: "completed", conclusion: "failure" }])).toBe("failure")
    expect(coverageState([{ status: "in_progress", conclusion: "" }])).toBe("pending")
    expect(coverageState([])).toBe("pending")
    expect(coverageState(null)).toBe("pending")
  })

  it("extracts the version from a container image reference", async () => {
    const { imageFromConfig } = await lib()
    expect(imageFromConfig("ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.868\n")).toBe("0.1.0-alpha.868")
    expect(imageFromConfig("ouroboros-butler:1.0.0")).toBe("1.0.0")
    expect(imageFromConfig("sha256:abc")).toBeUndefined()
  })

  it("classifies terminal lines from real logs", async () => {
    const { classifyLog } = await lib()
    expect(classifyLog(fixture("butler-upgrade-868-gate-fail.log"))).toEqual({ terminal: "rolled_back" })
    expect(classifyLog(fixture("butler-upgrade-870-gate-pass.log"))).toEqual({ terminal: "kept", gated: true })
    expect(classifyLog("UPGRADE done — 1.0.0 live (NOT gate-verified). Run verify.")).toEqual({ terminal: "kept", gated: false })
    expect(classifyLog("\nREFUSING: replay peers are not provisioned")).toEqual({ terminal: "refused" })
    expect(classifyLog("!! upgrade FAILED: x\nROLLBACK FAILED: y")).toEqual({ terminal: "failed" })
    expect(classifyLog(fixture("butler-upgrade-failed-rolled-back.log"))).toEqual({ terminal: "rolled_back" })
    expect(classifyLog(fixture("butler-upgrade-rollback-failed.log"))).toEqual({ terminal: "failed" })
    expect(classifyLog("!! upgrade FAILED: x\n!! rolling back to the predecessor")).toEqual({ terminal: "failed" })
    expect(classifyLog(fixture("butler-upgrade-process-gone.log"))).toEqual({ terminal: undefined })
    expect(classifyLog("== upgrade\n  ok   step")).toEqual({ terminal: undefined })
  })

  it("parses case lines and the summary", async () => {
    const { parseCases } = await lib()
    const failed = parseCases(fixture("butler-upgrade-868-gate-fail.log"))
    expect(failed.cases).toHaveLength(8)
    expect(failed.cases[1]).toMatchObject({ id: "books-up", status: "fail" })
    expect(failed.summary).toEqual({ ok: false, passed: 7, skipped: 0, failed: ["books-up"] })
    expect(parseCases("nothing").summary).toBeUndefined()
    expect(parseCases('{"id":"broken').cases).toEqual([{ raw: '{"id":"broken' }])
  })

  it("parses verify output and the rolled-back image", async () => {
    const { parseVerify, rolledBackImage } = await lib()
    const v = parseVerify(fixture("butler-verify-868.log"))
    expect(v.running_image).toBe("ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.868")
    expect(v.checks).toHaveLength(2)
    expect(parseVerify("  FAIL butler: down\r\n")).toEqual({ checks: [{ ok: false, line: "FAIL butler: down" }], running_image: undefined })
    expect(rolledBackImage(fixture("butler-upgrade-868-gate-fail.log"))).toBe("ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.868")
    expect(rolledBackImage("none")).toBeUndefined()
  })

  it("builds the result JSON and exit code", async () => {
    const { buildResult } = await lib()
    const kept = buildResult({ version: "0.1.0-alpha.870", terminal: "kept", log: "/l", logText: fixture("butler-upgrade-870-gate-pass.log"), verifyText: fixture("butler-verify-868.log"), verifyCode: 0 })
    expect(kept.exitCode).toBe(0)
    expect(kept.result).toMatchObject({ result: "kept", running_image: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.868", verify_green: true, log: "/l" })
    expect(kept.result.summary.ok).toBe(true)
    const rolled = buildResult({ version: "v", terminal: "rolled_back", log: "/l", logText: fixture("butler-upgrade-868-gate-fail.log"), verifyText: undefined, verifyCode: 1 })
    expect(rolled.exitCode).toBe(1)
    expect(rolled.result.running_image).toBe("ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.868")
    const bare = buildResult({ version: "v", terminal: "failed", log: "/l", logText: "", verifyText: "", verifyCode: 1 })
    expect(bare.result.running_image).toBeNull()
    expect(bare.result).not.toHaveProperty("summary")
    expect(buildResult({ version: "v", terminal: "kept", log: "/l", logText: "", verifyText: "  FAIL x", verifyCode: 0 }).exitCode).toBe(1)
  })
})

const V = "0.1.0-alpha.870"
const SHA = "abc123"

type Script = { gh?: (a: string[]) => Res; ssh?: (cmd: string, n: number) => Res }

async function harness(script: Script = {}, opts: Record<string, unknown> = {}, timing: Record<string, number> = { poll: 1 }) {
  const { ship } = await lib()
  const calls: string[] = []
  const out: string[] = []
  const scp: string[] = []
  const mergedAt = Date.parse("2026-10-08T12:00:00Z")
  let clock = mergedAt + 60_000
  let sshN = 0
  const commits = JSON.stringify([{ sha: SHA, commit: { message: `Thing (${V}) (#1)`, committer: { date: "2026-10-08T12:00:00Z" } } }])
  const deps = {
    gh: async (a: string[]) => {
      calls.push(`gh ${a.join(" ")}`)
      if (script.gh) { const r = script.gh(a); if (r) return r }
      if (a[0] === "api" && a[1].includes("commits?")) return ok(commits)
      if (a[0] === "run") return ok(JSON.stringify([{ status: "completed", conclusion: "success" }]))
      return ok("FILE BODY")
    },
    ssh: async (_h: string, cmd: string) => {
      calls.push(`ssh ${cmd}`)
      sshN += 1
      if (script.ssh) { const r = script.ssh(cmd, sshN); if (r) return r }
      if (cmd.includes("manifest inspect")) return ok()
      if (cmd.includes("docker inspect")) return ok("ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.868\n")
      if (cmd.includes(" preflight ")) return ok("PREFLIGHT GREEN — run `upgrade` (detached).\n")
      if (cmd.includes("cat /var/log")) return ok(`${fixture("butler-upgrade-870-gate-pass.log")}\n@@RUNNING:0\n`)
      if (cmd.endsWith(" verify")) return ok(fixture("butler-verify-868.log"))
      return ok("started")
    },
    scp: async (l: string, h: string, r: string) => { scp.push(`${path.basename(l)}->${h}:${r}`); return ok() },
    writeTemp: (name: string, content: string) => `/tmp/${name}:${content}`.split(":")[0],
    sleep: async (ms: number) => { clock += ms },
    now: () => clock,
    log: (l: string) => out.push(l),
  }
  const options = { version: V, host: "sanctuary", noGate: false, plant: undefined, dryRun: false, ...opts }
  return { run: () => ship(options, deps, timing), calls, out, scp, tick: (ms: number) => { clock += ms } }
}

describe("butler-ship orchestrator", () => {
  it("ships a release end to end and reports kept", async () => {
    const h = await harness()
    const r = await h.run()
    expect(r.exitCode).toBe(0)
    expect(r.result).toMatchObject({ version: V, result: "kept", log: `/var/log/ouro-upgrade-${V}.log` })
    expect(h.scp).toEqual(["sanctuary-butler-upgrade.mjs->sanctuary:/tmp/butler-upgrade.mjs", "sanctuary-replay-gate.mjs->sanctuary:/tmp/sanctuary-replay-gate.mjs"])
    expect(h.calls.some((c) => c.includes(".bak-0.1.0-alpha.868"))).toBe(true)
    expect(h.calls.some((c) => c.includes("contents/deploy/unraid/sanctuary-butler-upgrade.mjs?ref=abc123"))).toBe(true)
    const start = h.calls.find((c) => c.includes("setsid nohup"))!
    expect(start).toContain(`upgrade ${V} > /var/log/ouro-upgrade-${V}.log`)
    expect(start).not.toContain("--no-gate")
    expect(h.calls.some((c) => c.includes("pgrep -f '[b]utler-upgrade.mjs upgrade'"))).toBe(true)
    expect(h.out.some((l) => l.startsWith('{"id":"books-up"'))).toBe(true)
    expect(h.out.at(-1)).toContain('"result":"kept"')
  })

  it("passes --no-gate and --plant through", async () => {
    const a = await harness({}, { noGate: true })
    await a.run()
    expect(a.calls.find((c) => c.includes("setsid nohup"))).toContain("upgrade 0.1.0-alpha.870 --no-gate >")
    const b = await harness({}, { plant: "books-up" })
    await b.run()
    expect(b.calls.find((c) => c.includes("setsid nohup"))).toContain("--plant books-up")
  })

  it("reports a rollback with exit 1", async () => {
    const h = await harness({ ssh: (cmd) => (cmd.includes("cat /var/log") ? ok(`${fixture("butler-upgrade-868-gate-fail.log")}\n@@RUNNING:0\n`) : (undefined as unknown as Res)) })
    const r = await h.run()
    expect(r.exitCode).toBe(1)
    expect(r.result.result).toBe("rolled_back")
    expect(r.result.summary.failed).toEqual(["books-up"])
  })

  it("streams new case lines across polls and waits while running", async () => {
    const lines = fixture("butler-upgrade-870-gate-pass.log").split("\n")
    const partial = lines.slice(0, 5).join("\n")
    const h = await harness({ ssh: (cmd, n) => {
      if (!cmd.includes("cat /var/log")) return undefined as unknown as Res
      return n % 2 ? ok(`${partial}\n@@RUNNING:1\n`) : ok(`${lines.join("\n")}\n@@RUNNING:0\n`)
    } })
    const r = await h.run()
    expect(r.result.result).toBe("kept")
    expect(h.out.filter((l) => l.startsWith('{"id":"chef-question"'))).toHaveLength(1)
  })

  it("does not verify or conclude while a failed upgrade is still rolling back", async () => {
    let polls = 0
    const mid = "!! upgrade FAILED: x\n!! rolling back to the predecessor"
    const h = await harness({ ssh: (cmd) => {
      if (!cmd.includes("cat /var/log")) return undefined as unknown as Res
      polls += 1
      return polls < 3 ? ok(`${mid}\n@@RUNNING:1\n`) : ok(`${fixture("butler-upgrade-failed-rolled-back.log")}\n@@RUNNING:0\n`)
    } })
    const r = await h.run()
    expect(polls).toBe(3)
    expect(r.result.result).toBe("rolled_back")
    expect(r.exitCode).toBe(1)
    const verifyIdx = h.calls.findIndex((c) => c.endsWith(" verify"))
    expect(h.calls.filter((c) => c.includes("cat /var/log")).length).toBe(3)
    expect(verifyIdx).toBeGreaterThan(h.calls.map((c, i) => (c.includes("cat /var/log") ? i : -1)).pop()!)
  })

  it("reports failed when the rollback failed", async () => {
    const h = await harness({ ssh: (cmd) => (cmd.includes("cat /var/log") ? ok(`${fixture("butler-upgrade-rollback-failed.log")}\n@@RUNNING:0\n`) : (undefined as unknown as Res)) })
    expect((await h.run()).result.result).toBe("failed")
  })

  it("reports refused", async () => {
    const h = await harness({ ssh: (cmd) => (cmd.includes("cat /var/log") ? ok("\nREFUSING: no peers\n@@RUNNING:0\n") : (undefined as unknown as Res)) })
    expect((await h.run()).result.result).toBe("refused")
  })

  it("treats an exited process with no terminal line as failed", async () => {
    const h = await harness({ ssh: (cmd) => (cmd.includes("cat /var/log") ? ok(`${fixture("butler-upgrade-process-gone.log")}\n@@RUNNING:0\n`) : (undefined as unknown as Res)) })
    const r = await h.run()
    expect(r.result.result).toBe("failed")
    expect(h.out.some((l) => l.includes("without a terminal line"))).toBe(true)
  })

  it("gives a slow-starting process a few polls before judging an empty log", async () => {
    let polls = 0
    const h = await harness({ ssh: (cmd) => {
      if (!cmd.includes("cat /var/log")) return undefined as unknown as Res
      polls += 1
      return polls < 3 ? ok("@@RUNNING:0\n") : ok(`${fixture("butler-upgrade-870-gate-pass.log")}\n@@RUNNING:0\n`)
    } })
    expect((await h.run()).result.result).toBe("kept")
    const never = await harness({ ssh: (cmd) => (cmd.includes("cat /var/log") ? ok("@@RUNNING:0\n") : (undefined as unknown as Res)) })
    expect((await never.run()).result.result).toBe("failed")
  })

  it("fails closed when the log cannot be read or never finishes", async () => {
    const bad = await harness({ ssh: (cmd) => (cmd.includes("cat /var/log") ? nok("ssh down", 255) : (undefined as unknown as Res)) })
    await expect(bad.run()).rejects.toThrow(/could not read the upgrade log/)
    const slow = await harness({ ssh: (cmd) => (cmd.includes("cat /var/log") ? ok("== upgrade\n@@RUNNING:1\n") : (undefined as unknown as Res)) }, {}, { poll: 10, upgrade: 25 })
    await expect(slow.run()).rejects.toThrow(/timed out following/)
  })

  it("dry run runs only the read-only steps", async () => {
    const h = await harness({}, { dryRun: true })
    const r = await h.run()
    expect(r).toEqual({ dryRun: true, exitCode: 0 })
    expect(h.scp).toEqual([])
    expect(h.calls.some((c) => c.includes("setsid") || c.includes("cp -p"))).toBe(false)
  })

  it("falls back to package.json: the oldest commit of the newest run carrying the version", async () => {
    const { findReleaseCommitByPackage } = await lib()
    const commits = [{ sha: "n4" }, { sha: "n3" }, {}, { sha: "n2" }, { sha: "n1" }, { sha: "n0" }]
    const versions: Record<string, string | undefined> = { n4: "9.9.9", n3: "1.0.0", n2: "1.0.0", n1: "0.9.0", n0: "1.0.0" }
    const seen: string[] = []
    const read = async (sha: string) => { seen.push(sha); return versions[sha] }
    expect(await findReleaseCommitByPackage(commits, "1.0.0", read)).toBe("n2")
    expect(seen).toEqual(["n4", "n3", "n2", "n1"])
    expect(await findReleaseCommitByPackage(commits, "2.0.0", read)).toBeUndefined()
    expect(await findReleaseCommitByPackage(commits, "1.0.0", read, 1)).toBeUndefined()
    expect(await findReleaseCommitByPackage(undefined, "1.0.0", read)).toBeUndefined()
  })

  it("ship uses the package.json fallback when a stale PR title hides the version", async () => {
    const stale = JSON.stringify([
      { sha: "newer", commit: { message: "Later thing (0.1.0-alpha.871) (#2)" } },
      { sha: SHA, commit: { message: "Stale title (0.1.0-alpha.868) (#1)", committer: { date: "2026-10-08T12:00:00Z" } } },
      { sha: "older", commit: { message: "Before (0.1.0-alpha.867) (#0)" } },
    ])
    const pkg = (ref: string) => (ref === "newer" || ref === SHA ? ok(JSON.stringify({ version: V })) : ref === "older" ? nok("gone") : ok("not json"))
    const h = await harness({ gh: (a) => {
      if (a[0] === "api" && a[1].includes("commits?")) return ok(stale)
      const m = /contents\/package\.json\?ref=(\S+)/.exec(a.join(" "))
      return m ? pkg(m[1]) : undefined
    } })
    await h.run()
    expect(h.out.some((l) => l.includes(`${V} is ${SHA}`))).toBe(true)
    expect(h.calls.some((c) => c.includes("contents/package.json?ref=newer"))).toBe(true)
  })

  it("stops when no commit names the release", async () => {
    const h = await harness({ gh: (a) => (a[1]?.includes("commits?") ? ok("[]") : (undefined as unknown as Res)) })
    await expect(h.run()).rejects.toThrow(/no commit on main names/)
  })

  it("fails on gh errors and a failed coverage-gate", async () => {
    const e = await harness({ gh: (a) => (a[0] === "api" ? nok("api down") : (undefined as unknown as Res)) })
    await expect(e.run()).rejects.toThrow(/listing main commits failed \(exit 1\): api down/)
    const f = await harness({ gh: (a) => (a[0] === "run" ? ok(JSON.stringify([{ status: "completed", conclusion: "failure" }])) : (undefined as unknown as Res)) })
    await expect(f.run()).rejects.toThrow(/coverage-gate failed on abc123/)
  })

  it("only counts push-event coverage-gate runs and fails fast when none appears within 10 minutes", async () => {
    const h = await harness()
    await h.run()
    expect(h.calls.find((c) => c.startsWith("gh run list"))).toContain("--event push")
    const waiting = await harness({ gh: (a) => (a[0] === "run" ? ok("[]") : (undefined as unknown as Res)) }, {}, { poll: 4 * 60_000 })
    await expect(waiting.run()).rejects.toThrow(/no push-triggered coverage-gate run exists for abc123 1[0-9] minutes after the merge.*never publish.*alpha\.870.*workflow_dispatch/)
  })

  it("keeps waiting when the merge commit has no readable date", async () => {
    let n = 0
    const h = await harness({ gh: (a) => {
      if (a[0] === "api" && a[1].includes("commits?")) return ok(JSON.stringify([{ sha: SHA, commit: { message: `Thing (${V})`, committer: { date: "garbage" } } }]))
      if (a[0] === "run") return ok(++n < 3 ? "[]" : JSON.stringify([{ status: "completed", conclusion: "success" }]))
      return undefined as unknown as Res
    } })
    await h.run()
    expect(n).toBe(3)
  })

  it("polls a pending coverage-gate and times out", async () => {
    let n = 0
    const h = await harness({ gh: (a) => (a[0] === "run" ? ok(JSON.stringify(++n < 3 ? [{ status: "in_progress", conclusion: "" }] : [{ status: "completed", conclusion: "success" }])) : (undefined as unknown as Res)) })
    await h.run()
    expect(n).toBe(3)
    const t = await harness({ gh: (a) => (a[0] === "run" ? ok("[]") : (undefined as unknown as Res)) }, {}, { poll: 10, coverage: 25 })
    await expect(t.run()).rejects.toThrow(/timed out waiting for coverage-gate/)
  })

  it("waits on the image itself and times out if it never appears", async () => {
    let n = 0
    const h = await harness({ ssh: (cmd) => (cmd.includes("manifest inspect") ? (++n < 3 ? nok("", 1) : ok()) : (undefined as unknown as Res)) })
    await h.run()
    expect(n).toBe(3)
    const t = await harness({ ssh: (cmd) => (cmd.includes("manifest inspect") ? nok("", 1) : (undefined as unknown as Res)) }, {}, { poll: 10, image: 25 })
    await expect(t.run()).rejects.toThrow(/timed out waiting for ghcr.io/)
  })

  it("falls back to a generic backup suffix when the running image is unknown", async () => {
    const h = await harness({ ssh: (cmd) => (cmd.includes("docker inspect") ? nok("none") : (undefined as unknown as Res)) })
    await h.run()
    expect(h.calls.some((c) => c.includes(".bak-previous"))).toBe(true)
  })

  it("fails closed on backup, fetch and copy errors", async () => {
    const a = await harness({ ssh: (cmd) => (cmd.includes("cp -p") ? nok("ro fs") : (undefined as unknown as Res)) })
    await expect(a.run()).rejects.toThrow(/backing up host scripts failed/)
    const b = await harness({ gh: (a2) => (a2.includes("Accept: application/vnd.github.raw") ? nok("404") : (undefined as unknown as Res)) })
    await expect(b.run()).rejects.toThrow(/fetching deploy\/unraid\/sanctuary-butler-upgrade.mjs at abc123 failed/)
  })

  it("stops on a red or unreadable preflight and on a start failure", async () => {
    const red = await harness({ ssh: (cmd) => (cmd.includes(" preflight ") ? { code: 1, stdout: "PREFLIGHT RED — 1 blocker(s)\n", stderr: "" } : (undefined as unknown as Res)) })
    await expect(red.run()).rejects.toThrow(/preflight is not green/)
    const odd = await harness({ ssh: (cmd) => (cmd.includes(" preflight ") ? ok("nothing\n") : (undefined as unknown as Res)) })
    await expect(odd.run()).rejects.toThrow(/preflight is not green/)
    const start = await harness({ ssh: (cmd) => (cmd.includes("setsid nohup") ? nok("no setsid") : (undefined as unknown as Res)) })
    await expect(start.run()).rejects.toThrow(/starting the upgrade failed/)
  })

  it("reports the stderr tail when a failure has no stdout", async () => {
    const h = await harness({ gh: (a) => (a[0] === "api" ? { code: 2, stdout: "out text", stderr: "" } : (undefined as unknown as Res)) })
    await expect(h.run()).rejects.toThrow(/out text/)
  })
})

describe("butler-ship CLI", () => {
  const baseDeps = (over: Record<string, unknown> = {}) => ({
    gh: async () => ok(),
    ssh: async () => ok(),
    scp: async () => ok(),
    writeTemp: () => "/tmp/x",
    sleep: async () => undefined,
    now: () => 0,
    log: () => undefined,
    ...over,
  })

  it("returns 2 on bad args", async () => {
    const { main } = await cli()
    const err = console.error
    const lines: string[] = []
    console.error = (m: string) => lines.push(m)
    try { expect(await main([], {}, baseDeps())).toBe(2) } finally { console.error = err }
    expect(lines.join("")).toMatch(/semver/)
  })

  it("turns a ShipError into a failed JSON line and exit 1, and rethrows others", async () => {
    const { main } = await cli()
    const logs: string[] = []
    const log = console.log
    const err = console.error
    console.log = (m: string) => logs.push(m)
    console.error = () => undefined
    try {
      expect(await main(["0.1.0-alpha.870"], {}, baseDeps({ gh: async () => ok("[]") }))).toBe(1)
      await expect(main(["0.1.0-alpha.870"], {}, baseDeps({ gh: async () => ok("not json") }))).rejects.toThrow()
    } finally { console.log = log; console.error = err }
    expect(JSON.parse(logs[0])).toMatchObject({ version: "0.1.0-alpha.870", result: "failed" })
  })

  it("returns the ship exit code on success", async () => {
    const { main } = await cli()
    const dry = await main(["0.1.0-alpha.870", "--dry-run"], {}, baseDeps({
      gh: async (a: string[]) => (a[0] === "api" ? ok(JSON.stringify([{ sha: "s", commit: { message: "x (0.1.0-alpha.870)" } }])) : ok(JSON.stringify([{ status: "completed", conclusion: "success" }]))),
      ssh: async (_h: string, cmd: string) => (cmd.includes("preflight") ? ok("PREFLIGHT GREEN\n") : ok()),
    }))
    expect(dry).toBe(0)
  })

  it("wires real deps without running anything", async () => {
    const { realDeps } = await cli()
    const d = realDeps()
    const p = d.writeTemp("f.txt", "hi")
    expect(readFileSync(p, "utf8")).toBe("hi")
    expect(d.now()).toBeGreaterThan(0)
    await d.sleep(1)
    const g = d.gh(["--version"])
    expect(typeof g.code).toBe("number")
  })
})
