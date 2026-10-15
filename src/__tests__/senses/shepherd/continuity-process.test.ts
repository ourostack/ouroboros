import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  inspectContinuityProcess, observeContinuityTermination, prepareContinuityProcessProof, resolveContinuityCaller,
} from "../../../senses/shepherd/continuity-process"
import type { ProcessProofDeps, ProcessProofObservation } from "../../../senses/shepherd/continuity-process"
import type { ContinuityBinding, ContinuityProfile } from "../../../senses/shepherd/continuity-types"

function home() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "continuity-process-")))
}
function present(pid: number, parentPid: number, executable = "/trusted/copilot"): ProcessProofObservation {
  return {
    state: "present", generation: { pid, birth: `darwin:100:${pid}`, uid: process.getuid!() },
    parentPid, processGroupId: 10, foregroundProcessGroupId: 10, ttyDevice: 1,
    executable, entryScript: null, cwd: "/desk",
  }
}
function profile(): ContinuityProfile {
  return {
    id: "worker", runner: "copilot", launcher: "direct", executable: "/trusted/copilot",
    argv: ["--allow-all"], rootIds: ["desk"], settingsPath: "/settings", version: "1.0.97",
    executableIdentity: { dev: 1, ino: 2 }, fingerprint: "a".repeat(64),
  }
}
function binding(): ContinuityBinding {
  return {
    id: "binding", agent: "ouro", host: "cmux", incarnation: "host-1", surfaceId: "surface",
    surfaceGeneration: "surface-1", nativeSessionId: "native", runner: "copilot",
    process: { pid: 10, birth: "darwin:100:10", uid: process.getuid!() }, wrapper: null,
    launchCwd: "/desk", worktree: "/code", rootId: "desk", taskRef: "track/task", taskKey: "root:track/task",
    root: { id: "desk", path: "/desk", namespace: "track", receiptBase: ".receipts", launchRoots: ["/desk"],
      worktreeRoots: ["/code"], identity: { dev: 1, ino: 2 } },
    profileId: "worker", profileFingerprint: "a".repeat(64), configFingerprint: "b".repeat(64), enrollmentEpoch: "epoch",
  }
}
function deps(observations: ProcessProofObservation[], complete = true): ProcessProofDeps {
  return {
    platform: "darwin",
    inspect: async pid => observations.find(observation => observation.state === "present" && observation.generation.pid === pid) ?? { state: "absent" },
    knownOwners: async () => ({ complete, owners: [] }),
  }
}

function helperFixture() {
  const h = home()
  const helperPath = path.join(h, "helper")
  fs.writeFileSync(helperPath, "synthetic-owned-helper", { mode: 0o700 })
  return {
    supported: true as const, platform: "darwin" as const, helperPath,
    helperSha256: createHash("sha256").update(fs.readFileSync(helperPath)).digest("hex"),
    sourceSha256: "a".repeat(64), architecture: process.arch,
  }
}

function linuxFixture() {
  const root = home()
  fs.mkdirSync(path.join(root, "sys/kernel/random"), { recursive: true })
  fs.writeFileSync(path.join(root, "sys/kernel/random/boot_id"), "ff197ddf-bce8-4fa9-9de0-faf6399e1234\n")
  fs.mkdirSync(path.join(root, "10"))
  const tail = ["S", "1", "10", "10", "1", "10", ...Array.from({ length: 13 }, () => "0"), "123456789", "0"]
  fs.writeFileSync(path.join(root, "10/stat"), `10 (fixture (native)) ${tail.join(" ")}\n`)
  fs.writeFileSync(path.join(root, "10/status"), `Uid:\t${process.getuid!()}\t${process.getuid!()}\t0\t0\n`)
  fs.writeFileSync(path.join(root, "10/cmdline"), "/usr/bin/node\0/registered/cli-main.js\0--synthetic\0")
  fs.symlinkSync("/usr/bin/node", path.join(root, "10/exe"))
  fs.symlinkSync("/desk", path.join(root, "10/cwd"))
  return root
}

describe("passive kernel process identity", () => {
  afterEach(() => { vi.restoreAllMocks() })
  it("refuses missing capability, malformed helper evidence and invalid PID without sending signals", async () => {
    for (const pid of [-1, 0, 1.5, NaN, 2147483648]) {
      expect(await inspectContinuityProcess(pid, { platform: "darwin" })).toMatchObject({ state: "unknown" })
    }
    expect(await inspectContinuityProcess(10, { platform: "darwin" })).toMatchObject({ state: "unknown" })
    for (const output of ["not-json", "x".repeat(32769), '{"state":"present"}', '{"state":"absent","argv":["secret"]}']) {
      expect(await inspectContinuityProcess(10, { platform: "darwin", inspect: async () => JSON.parse(output) }))
        .toMatchObject({ state: "unknown" })
    }
    expect(await inspectContinuityProcess(10, { platform: "darwin", inspect: async () => { throw new Error("private inspector payload") } }))
      .toEqual({ state: "unknown", reason: "inspection-failed" })
  })

  it("rejects an observation for another PID or missing precise birth identity", async () => {
    expect(await inspectContinuityProcess(10, deps([present(20, 1)]))).toEqual({ state: "absent" })
    expect(await inspectContinuityProcess(10, { platform: "darwin", inspect: async () => present(20, 1) })).toMatchObject({ state: "unknown" })
    const wrong = present(10, 1)
    if (wrong.state === "present") wrong.generation.birth = ""
    expect(await inspectContinuityProcess(10, { platform: "darwin", inspect: async () => wrong })).toMatchObject({ state: "unknown" })
    if (wrong.state === "present") wrong.generation.birth = "not-kernel-birth"
    expect(await inspectContinuityProcess(10, { platform: "darwin", inspect: async () => wrong })).toMatchObject({ state: "unknown" })
  })

  it("resolves the native foreground ancestor even when the hook child has no TTY", async () => {
    const adapter = present(30, 10, "/trusted/ouro")
    if (adapter.state === "present") {
      adapter.ttyDevice = null
      adapter.foregroundProcessGroupId = null
    }
    const result = await resolveContinuityCaller({ adapterPid: 30, nativeSessionId: "native", runner: "copilot", profiles: [profile()] }, deps([adapter, present(10, 1)]))
    expect(result).toMatchObject({ state: "verified", profileId: "worker", generation: binding().process, wrapper: null })
    expect(result).toMatchObject({ lineage: [
      { pid: 30, birth: "darwin:100:30", uid: process.getuid!() },
      { pid: 10, birth: "darwin:100:10", uid: process.getuid!() },
    ] })
  })

  it("blocks nested/ambiguous native ancestors, background harnesses and wrong UID", async () => {
    const input = { adapterPid: 30, nativeSessionId: "native", runner: "copilot" as const, profiles: [profile()] }
    expect(await resolveContinuityCaller(input, deps([present(30, 20, "/trusted/ouro"), present(20, 10), present(10, 1)])))
      .toMatchObject({ state: "blocked" })
    const background = present(10, 1)
    if (background.state === "present") background.foregroundProcessGroupId = 99
    expect(await resolveContinuityCaller(input, deps([present(30, 10, "/trusted/ouro"), background]))).toMatchObject({ state: "blocked" })
    const foreign = present(10, 1)
    if (foreign.state === "present") foreign.generation.uid++
    expect(await resolveContinuityCaller(input, deps([present(30, 10, "/trusted/ouro"), foreign]))).toMatchObject({ state: "blocked" })
  })

  it("does not infer runner identity from a generic node executable", async () => {
    const input = { adapterPid: 30, nativeSessionId: "native", runner: "copilot" as const, profiles: [profile()] }
    expect(await resolveContinuityCaller(input, deps([present(30, 10, "/trusted/ouro"), present(10, 1, "/usr/bin/node")]))).toMatchObject({ state: "unsupported" })
    const node = present(10, 1, "/usr/bin/node")
    if (node.state === "present") node.entryScript = "/registered/cli-main.js"
    const registered = { ...profile(), executable: "/registered/cli-main.js" }
    expect(await resolveContinuityCaller({ ...input, profiles: [registered] }, deps([present(30, 10, "/trusted/ouro"), node]))).toMatchObject({ state: "verified" })
  })

  it("requires a trusted native-entry inventory plus the exact Agency ancestor", async () => {
    const native = present(10, 20, "/native/copilot")
    const wrapper = present(20, 1, "/trusted/agency")
    const agency = { ...profile(), launcher: "agency" as const, executable: "/trusted/agency", argv: ["copilot", "--allow-all"] }
    const input = { adapterPid: 30, nativeSessionId: "native", runner: "copilot" as const, profiles: [agency] }
    const d = deps([present(30, 10, "/trusted/ouro"), native, wrapper])
    expect(await resolveContinuityCaller(input, d)).toMatchObject({ state: "unsupported" })
    d.nativeEntries = [{ runner: "copilot", executable: "/native/copilot", entryScript: null, version: "1.0.97" }]
    expect(await resolveContinuityCaller(input, d)).toMatchObject({ state: "verified", wrapper: { pid: 20, birth: "darwin:100:20" } })
    d.nativeEntries[0].version = "wrong"
    expect(await resolveContinuityCaller(input, d)).toMatchObject({ state: "unsupported" })
  })

  it("refuses reparenting, PID reuse during ancestry observation and incomplete ancestry", async () => {
    const input = { adapterPid: 30, nativeSessionId: "native", runner: "copilot" as const, profiles: [profile()] }
    let nativeReads = 0
    const d = deps([present(30, 10, "/trusted/ouro"), present(10, 1)])
    const initial = d.inspect!
    d.inspect = async pid => {
      const value = await initial(pid)
      if (pid === 10 && value.state === "present" && ++nativeReads > 1) value.parentPid = 999
      return value
    }
    expect(await resolveContinuityCaller(input, d)).toMatchObject({ state: "blocked" })
    d.inspect = async () => ({ state: "unknown", reason: "permission-denied" })
    expect(await resolveContinuityCaller(input, d)).toMatchObject({ state: "unsupported" })
  })

  it("does not certify a harness that loses foreground ownership during the proof round", async () => {
    let reads = 0
    const d = deps([present(30, 10, "/trusted/ouro"), present(10, 1)])
    const inspect = d.inspect!
    d.inspect = async pid => {
      const value = await inspect(pid)
      if (pid === 10 && value.state === "present" && ++reads > 1) value.foregroundProcessGroupId = 99
      return value
    }
    expect(await resolveContinuityCaller({ adapterPid: 30, nativeSessionId: "native", runner: "copilot", profiles: [profile()] }, d))
      .toMatchObject({ state: "blocked" })
  })

  it("does not publish a compiled helper until its native wire smoke probe succeeds", async () => {
    const h = home()
    const compiler = path.join(h, "clang")
    const sdk = path.join(h, "sdk")
    fs.writeFileSync(compiler, "fixture", { mode: 0o700 })
    fs.mkdirSync(sdk)
    const capability = await prepareContinuityProcessProof({
      homeDir: h, platform: "darwin", sourcePath: path.resolve("assets/shepherd-process-proof.c"),
    }, {
      compilerPath: compiler, sdkPath: sdk,
      run: async (command, args) => {
        if (command === compiler) {
          fs.writeFileSync(args[args.indexOf("-o") + 1], "wrong helper", { mode: 0o700 })
          return ""
        }
        return "not native JSON"
      },
    })
    expect(capability).toMatchObject({ supported: false })
  })

  it("distinguishes exact source end, reused PID, live wrapper and unknown surviving-owner coverage", async () => {
    const b = binding()
    expect(await observeContinuityTermination(b, deps([present(10, 1)]))).toMatchObject({ source: "live", survivingOwners: "unknown", eligible: false })
    expect(await observeContinuityTermination(b, deps([]))).toMatchObject({ source: "ended", survivingOwners: "clear", eligible: true })
    const reused = present(10, 1)
    if (reused.state === "present") reused.generation.birth = "darwin:101:10"
    expect(await observeContinuityTermination(b, deps([reused]))).toMatchObject({ source: "ended", eligible: true })
    expect(await observeContinuityTermination(b, deps([], false))).toMatchObject({ source: "ended", survivingOwners: "unknown", eligible: false })
    b.wrapper = { pid: 20, birth: "darwin:100:20", uid: process.getuid!() }
    expect(await observeContinuityTermination(b, deps([present(20, 1, "/agency")]))).toMatchObject({ source: "ended", survivingOwners: "present", eligible: false })
    const d = deps([])
    d.knownOwners = async () => ({ complete: true, owners: [{ pid: 40, birth: "darwin:100:40", uid: process.getuid!() }] })
    d.inspect = async pid => pid === 40 ? present(40, 1, "/watcher") : { state: "absent" }
    expect(await observeContinuityTermination(binding(), d)).toMatchObject({ survivingOwners: "present", eligible: false })
  })

  it("never promotes a permission/inspection failure to a terminated source", async () => {
    expect(await observeContinuityTermination(binding(), { platform: "darwin", inspect: async () => ({ state: "unknown", reason: "denied" }) }))
      .toMatchObject({ source: "unknown", eligible: false })
  })

  it("does not compile at inspection time or use an unsupported platform", async () => {
    expect(await prepareContinuityProcessProof({ homeDir: home(), platform: "win32", sourcePath: "missing" }))
      .toMatchObject({ supported: false })
    expect(await inspectContinuityProcess(10, { platform: "win32" })).toMatchObject({ state: "unknown" })
    expect(await prepareContinuityProcessProof({ homeDir: home(), platform: "linux", sourcePath: "unused" }))
      .toMatchObject({ supported: true, platform: "linux", helperPath: null })
  })

  it("compiles a private source-keyed helper explicitly and proves only an owned disposable process", async () => {
    if (process.platform !== "darwin") return
    const h = home()
    const capability = await prepareContinuityProcessProof({
      homeDir: h, platform: "darwin", sourcePath: path.resolve("assets/shepherd-process-proof.c"),
    })
    expect(capability.supported).toBe(true)
    if (!capability.supported) throw new Error(capability.reason)
    expect(fs.statSync(capability.helperPath!).mode & 0o777).toBe(0o700)
    const cached = await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath: path.resolve("assets/shepherd-process-proof.c") })
    expect(cached).toEqual(capability)
    const child = spawn(process.execPath, ["-e", 'process.stdout.write("owned\\n");setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "pipe"] })
    await once(child.stdout!, "data")
    try {
      const timings: Array<{ command: string; ms: number; status: string }> = []
      const execute = promisify(execFile)
      const observation = await inspectContinuityProcess(child.pid!, {
        platform: "darwin", capability,
        run: async (command, args, timeout) => {
          const start = Date.now()
          try {
            const result = await execute(command, args, { timeout, maxBuffer: 32768, encoding: "utf8" })
            timings.push({ command: path.basename(command), ms: Date.now() - start, status: "ok" })
            return result.stdout
          } catch {
            timings.push({ command: path.basename(command), ms: Date.now() - start, status: "failed" })
            throw new Error("owned inspector command failed")
          }
        },
      })
      if (observation.state !== "present") throw new Error(`Owned process proof failed: ${JSON.stringify({ observation, timings })}`)
      expect(await inspectContinuityProcess(child.pid!, { platform: "darwin", capability }))
        .toMatchObject({ state: "present", generation: observation.generation })
      expect(observation.generation).toMatchObject({ pid: child.pid, uid: process.getuid!() })
      expect(observation.generation.birth).toMatch(/^darwin:\d+:\d+$/)
      const b = { ...binding(), process: observation.generation }
      process.kill(child.pid!, "SIGTERM")
      await once(child, "exit")
      expect(await observeContinuityTermination(b, { platform: "darwin", capability, knownOwners: async () => ({ complete: true, owners: [] }) }))
        .toMatchObject({ source: "ended", survivingOwners: "clear", eligible: true })
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(child.pid!, "SIGKILL")
        await once(child, "exit")
      }
    }
  })

  it("rejects every malformed kernel field and never forwards unknown inspector payloads", async () => {
    const good = present(10, 1)
    for (const value of [
      null, [], 1, { state: "unknown", reason: "\0secret" },
      { ...good, generation: null }, { ...good, generation: [] },
      { ...good, generation: { pid: 10, birth: "b", uid: -1 } },
      { ...good, parentPid: -1 }, { ...good, processGroupId: 0 },
      { ...good, foregroundProcessGroupId: -1 }, { ...good, ttyDevice: -1 },
      { ...good, executable: "relative" }, { ...good, entryScript: "relative" }, { ...good, cwd: "relative" },
    ]) {
      const capability = helperFixture()
      expect(await inspectContinuityProcess(10, { platform: "darwin", capability, run: async () => JSON.stringify(value) }))
        .toMatchObject({ state: "unknown" })
    }
    expect(await inspectContinuityProcess(10, { platform: "darwin", inspect: async () => ({ state: "unknown", reason: "synthetic-private-payload" }) }))
      .toEqual({ state: "unknown", reason: "native-inspection-unavailable" })
  })

  it("rejects expired budgets, oversized/invalid native output and tampered executable bytes", async () => {
    const capability = helperFixture()
    expect(await inspectContinuityProcess(10, { platform: "darwin", deadline: Date.now() - 1, capability }))
      .toMatchObject({ state: "unknown", reason: "inspection-deadline" })
    for (const output of ["x".repeat(32769), "not-json"]) {
      expect(await inspectContinuityProcess(10, { platform: "darwin", capability, run: async () => output }))
        .toMatchObject({ state: "unknown" })
    }
    fs.appendFileSync(capability.helperPath, "tamper")
    expect(await inspectContinuityProcess(10, { platform: "darwin", capability })).toMatchObject({ reason: "helper-integrity-failed" })
  })

  it("requires exact first-position Node entry paths and rejects ambiguous argv spelling", async () => {
    const capability = helperFixture()
    const node = present(10, 1, "/usr/bin/node")
    for (const [argv, expected] of [
      ["/usr/bin/node /registered/cli-main.js --synthetic\n", "/registered/cli-main.js"],
      ["node /registered/cli-main.js\n", "/registered/cli-main.js"],
      ["node --prompt /registered/cli-main.js\n", null],
      ["other /registered/cli-main.js\n", null],
      ['node "/registered/space name.js"\n', null],
    ] as const) {
      expect(await inspectContinuityProcess(10, {
        platform: "darwin", capability,
        run: async command => command === "/bin/ps" ? argv : JSON.stringify(node),
      })).toMatchObject({ state: "present", entryScript: expected })
    }
  })

  it("uses Linux boot identity plus unrounded start ticks and does not invent absence from a missing field", async () => {
    const root = linuxFixture()
    const observation = await inspectContinuityProcess(10, { platform: "linux", procRoot: root })
    expect(observation).toMatchObject({
      state: "present", generation: { pid: 10, birth: "linux:ff197ddf-bce8-4fa9-9de0-faf6399e1234:123456789", uid: process.getuid!() },
      entryScript: "/registered/cli-main.js", cwd: "/desk",
    })
    expect(await inspectContinuityProcess(11, { platform: "linux", procRoot: root })).toEqual({ state: "absent" })
    fs.renameSync(path.join(root, "10/status"), path.join(root, "10/status.old"))
    expect(await inspectContinuityProcess(10, { platform: "linux", procRoot: root })).toMatchObject({ state: "unknown" })
    fs.renameSync(path.join(root, "10/status.old"), path.join(root, "10/status"))
    fs.writeFileSync(path.join(root, "10/status"), "Uid: malformed")
    expect(await inspectContinuityProcess(10, { platform: "linux", procRoot: root })).toMatchObject({ state: "unknown" })
    fs.writeFileSync(path.join(root, "sys/kernel/random/boot_id"), "invalid")
    expect(await inspectContinuityProcess(10, { platform: "linux", procRoot: root })).toMatchObject({ state: "unknown" })
  })

  it("rejects oversized Linux observations and detects a generation change mid-read", async () => {
    const root = linuxFixture()
    const originalStat = fs.readFileSync(path.join(root, "10/stat"), "utf8")
    fs.writeFileSync(path.join(root, "10/stat"), "x".repeat(16385))
    expect(await inspectContinuityProcess(10, { platform: "linux", procRoot: root })).toMatchObject({ state: "unknown" })
    fs.writeFileSync(path.join(root, "10/stat"), originalStat)
    const read = fs.readSync.bind(fs)
    let reads = 0
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const value = read(...args)
      if (++reads === 4) fs.writeFileSync(path.join(root, "10/stat"), originalStat.replace("123456789", "123456790"))
      return value
    })
    expect(await inspectContinuityProcess(10, { platform: "linux", procRoot: root })).toMatchObject({ state: "unknown" })
  })

  it("requires complete ownership inventory and treats different-UID owners as unknown", async () => {
    const source = binding()
    const foreign = present(10, 1)
    if (foreign.state === "present") foreign.generation.uid++
    expect(await observeContinuityTermination(source, deps([foreign]))).toMatchObject({ source: "unknown", eligible: false })
    const d = deps([])
    expect(await observeContinuityTermination(source, { ...d, knownOwners: undefined })).toMatchObject({ survivingOwners: "unknown" })
    d.knownOwners = async () => { throw new Error("inventory denied") }
    expect(await observeContinuityTermination(source, d)).toMatchObject({ survivingOwners: "unknown", reasons: ["owner-inventory-unavailable"] })
    d.knownOwners = async () => ({ complete: true, owners: [{ pid: 40, birth: "b", uid: process.getuid!() }] })
    d.inspect = async pid => pid === 40 ? { state: "unknown", reason: "denied" } : { state: "absent" }
    expect(await observeContinuityTermination(source, d)).toMatchObject({ survivingOwners: "unknown" })
  })

  it("bounds native ancestry and requires the adapter's own UID and a nonempty session", async () => {
    const input = { adapterPid: 30, nativeSessionId: "native", runner: "copilot" as const, profiles: [profile()] }
    expect(await resolveContinuityCaller({ ...input, nativeSessionId: "" }, deps([]))).toMatchObject({ state: "blocked" })
    expect(await resolveContinuityCaller(input, deps([present(30, 30)]))).toMatchObject({ reason: "ancestry-cycle" })
    const deep = deps([])
    deep.inspect = async pid => present(pid, pid + 1, "/unknown")
    expect(await resolveContinuityCaller(input, deep)).toMatchObject({ reason: "ancestry-too-deep" })
    const foreign = present(30, 10, "/trusted/ouro")
    if (foreign.state === "present") foreign.generation.uid++
    expect(await resolveContinuityCaller(input, deps([foreign, present(10, 1)]))).toMatchObject({ reason: "adapter-owner-mismatch" })
    expect(await resolveContinuityCaller({ ...input, runner: "claude" }, deps([present(30, 10, "/trusted/ouro"), present(10, 1)]))).toMatchObject({ state: "unsupported" })
  })

  it("refuses missing compiler/SDK, source overflow and ambiguous or tampered build receipts", async () => {
    const sourcePath = path.resolve("assets/shepherd-process-proof.c")
    const h = home()
    for (const compilerPath of ["/missing/compiler", "/usr/bin/clang", "relative"]) {
      expect(await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath }, { compilerPath })).toMatchObject({ supported: false })
    }
    const large = path.join(h, "large.c")
    fs.writeFileSync(large, "x".repeat(65537))
    expect(await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath: large })).toMatchObject({ supported: false })
    const empty = path.join(h, "empty.c")
    fs.writeFileSync(empty, "")
    expect(await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath: empty })).toMatchObject({ supported: false })
    const sourceHash = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex")
    const directory = path.join(h, ".ouro-cli/state/shepherd-continuity-process", `${sourceHash}-${process.arch}`)
    const compilerPath = path.join(h, "compiler")
    fs.writeFileSync(compilerPath, "fixture", { mode: 0o777 })
    expect(await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath }, { compilerPath })).toMatchObject({ supported: false })
    fs.chmodSync(compilerPath, 0o700)
    expect(await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath }, { compilerPath, sdkPath: compilerPath })).toMatchObject({ supported: false })
    fs.writeFileSync(path.join(directory, "process-proof"), "synthetic", { mode: 0o700 })
    fs.writeFileSync(path.join(directory, "build.json"), "[]", { mode: 0o600 })
    expect(await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath })).toMatchObject({ supported: false })
    fs.writeFileSync(path.join(directory, "build.json"), JSON.stringify({ architecture: process.arch, helperSha256: "bad", sourceSha256: sourceHash }))
    expect(await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath })).toMatchObject({ supported: false })
  })

  it("compiles captured source bytes rather than rereading a changed source pathname", async () => {
    const h = home()
    const sourcePath = path.join(h, "source.c")
    const compiler = path.join(h, "compiler")
    const sdk = path.join(h, "sdk")
    const original = "synthetic-original-source\n"
    fs.writeFileSync(sourcePath, original)
    fs.writeFileSync(compiler, "fixture", { mode: 0o700 })
    fs.mkdirSync(sdk)
    const capability = await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath }, {
      compilerPath: compiler, sdkPath: sdk,
      run: async (command, args) => {
        if (command === compiler) {
          fs.writeFileSync(sourcePath, "substituted-source")
          const input = args[args.indexOf("-o") - 1]
          fs.writeFileSync(args[args.indexOf("-o") + 1], fs.readFileSync(input, "utf8") === original ? "correct" : "incorrect", { mode: 0o700 })
          return ""
        }
        return fs.readFileSync(command, "utf8") === "correct" ? '{"state":"unknown","reason":"pid-invalid"}' : "incorrect wire"
      },
    })
    expect(capability).toMatchObject({ supported: true, sourceSha256: createHash("sha256").update(original).digest("hex") })
  })

  it("does not accept a Linux stat record for a different PID", async () => {
    const root = linuxFixture()
    const file = path.join(root, "10/stat")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^10 /, "11 "))
    expect(await inspectContinuityProcess(10, { platform: "linux", procRoot: root })).toMatchObject({ state: "unknown" })
  })

  it("rejects unsafe homes/cache directories and cached helpers with failed smoke probes", async () => {
    const sourcePath = path.resolve("assets/shepherd-process-proof.c")
    expect(await prepareContinuityProcessProof({ homeDir: "relative", platform: "darwin", sourcePath })).toMatchObject({ supported: false })
    const h = home()
    fs.chmodSync(h, 0o770)
    expect(await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath })).toMatchObject({ supported: false })
    fs.chmodSync(h, 0o700)
    fs.mkdirSync(path.join(h, "other"))
    fs.symlinkSync(path.join(h, "other"), path.join(h, ".ouro-cli"))
    expect(await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath })).toMatchObject({ supported: false })
    const g = home()
    const hash = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex")
    const cache = path.join(g, ".ouro-cli/state/shepherd-continuity-process", `${hash}-${process.arch}`)
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
    fs.chmodSync(cache, 0o750)
    expect(await prepareContinuityProcessProof({ homeDir: g, platform: "darwin", sourcePath })).toMatchObject({ supported: false })
    fs.chmodSync(cache, 0o700)
    const helper = path.join(cache, "process-proof")
    fs.writeFileSync(helper, "synthetic", { mode: 0o700 })
    const receipt = path.join(cache, "build.json")
    fs.writeFileSync(receipt, JSON.stringify({ architecture: process.arch, helperSha256: createHash("sha256").update("synthetic").digest("hex"), sourceSha256: hash }), { mode: 0o600 })
    expect(await prepareContinuityProcessProof({ homeDir: g, platform: "darwin", sourcePath }, { run: async () => "wrong wire" }))
      .toMatchObject({ supported: false, reason: "helper-probe-failed" })
  })

  it("refuses cache mode, ownership, links, bounds and changed descriptor evidence", async () => {
    for (const change of [
      (file: string) => fs.chmodSync(file, 0o755),
      (file: string) => fs.chmodSync(file, 0o600),
      (file: string) => fs.appendFileSync(file, "x".repeat(1024 * 1024 + 1)),
      (file: string) => fs.linkSync(file, `${file}.second-link`),
    ]) {
      const capability = helperFixture()
      change(capability.helperPath)
      expect(await inspectContinuityProcess(10, { platform: "darwin", capability })).toMatchObject({ state: "unknown" })
    }
    const capability = helperFixture()
    const fstat = fs.fstatSync.bind(fs)
    vi.spyOn(fs, "fstatSync").mockImplementation((...args: Parameters<typeof fs.fstatSync>) => {
      const stat = fstat(...args)
      if (stat instanceof fs.Stats) stat.uid = process.getuid!() + 100
      return stat
    })
    expect(await inspectContinuityProcess(10, { platform: "darwin", capability })).toMatchObject({ state: "unknown" })
    vi.restoreAllMocks()
    let reads = 0
    vi.spyOn(fs, "fstatSync").mockImplementation((...args: Parameters<typeof fs.fstatSync>) => {
      const stat = fstat(...args)
      if (stat instanceof fs.Stats && ++reads === 2) stat.mtimeMs++
      return stat
    })
    expect(await inspectContinuityProcess(10, { platform: "darwin", capability })).toMatchObject({ state: "unknown" })
  })

  it("refuses invalid compilers and retains a competing build without overwriting it", async () => {
    const h = home()
    const sourcePath = path.resolve("assets/shepherd-process-proof.c")
    const compilerPath = path.join(h, "compiler")
    const sdkPath = path.join(h, "sdk")
    fs.mkdirSync(sdkPath)
    fs.writeFileSync(compilerPath, "fixture", { mode: 0o600 })
    expect(await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath }, { compilerPath, sdkPath })).toMatchObject({ supported: false })
    fs.chmodSync(compilerPath, 0o700)
    const stat = fs.statSync.bind(fs)
    vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      const value = stat(...args)
      if (value instanceof fs.Stats && args[0] === compilerPath) value.uid = process.getuid!() + 100
      return value
    })
    expect(await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath }, { compilerPath, sdkPath })).toMatchObject({ supported: false })
    vi.restoreAllMocks()
    const cap = await prepareContinuityProcessProof({ homeDir: h, platform: "darwin", sourcePath }, {
      compilerPath, sdkPath,
      run: async (command, args) => {
        if (command === compilerPath) fs.writeFileSync(args[args.indexOf("-o") + 1], "fixture", { mode: 0o700 })
        else fs.writeFileSync(path.join(path.dirname(command), "process-proof"), "successor", { mode: 0o700 })
        return '{"state":"unknown","reason":"pid-invalid"}'
      },
    })
    expect(cap).toMatchObject({ supported: false, reason: "concurrent-build" })
  })

  it("preserves empty/no-TTY Linux evidence and native executables without guessing a Node script", async () => {
    const root = linuxFixture()
    const file = path.join(root, "10/stat")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("S 1 10 10 1 10", "S 1 10 10 0 -1"))
    fs.writeFileSync(path.join(root, "10/cmdline"), "node\0-e\0fixture\0")
    expect(await inspectContinuityProcess(10, { platform: "linux", procRoot: root })).toMatchObject({ state: "present", ttyDevice: null, foregroundProcessGroupId: null, entryScript: null })
    fs.renameSync(path.join(root, "10/exe"), path.join(root, "10/node-exe"))
    fs.symlinkSync("/trusted/copilot", path.join(root, "10/exe"))
    expect(await inspectContinuityProcess(10, { platform: "linux", procRoot: root })).toMatchObject({ state: "present", entryScript: null })
    const real = await inspectContinuityProcess(2147483647, { platform: "linux" })
    expect(real.state).toBe(process.platform === "linux" ? "absent" : "unknown")
  })

  it("never downgrades a known live surviving owner because another owner is unknown or ended", async () => {
    const d = deps([])
    d.knownOwners = async () => ({ complete: true, owners: [40, 41, 42].map(pid => ({ pid, birth: `darwin:100:${pid}`, uid: process.getuid!() })) })
    d.inspect = async pid => pid === 40 ? present(40, 1) : pid === 41 ? { state: "unknown", reason: "denied" } : { state: "absent" }
    expect(await observeContinuityTermination(binding(), d)).toMatchObject({ survivingOwners: "present", eligible: false })
  })
})
