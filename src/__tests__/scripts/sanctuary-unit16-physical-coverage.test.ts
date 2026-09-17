import * as fs from "node:fs"
import * as path from "node:path"
import * as vm from "node:vm"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

const brokerPath = path.resolve("deploy/unraid/sanctuary-unit16-host-broker.mjs")
const require = createRequire(brokerPath)
const deploymentTarget = await import(pathToFileURL(path.resolve("deploy/unraid/sanctuary-deployment-target.mjs")).href)
const source = fs.readFileSync(brokerPath, "utf8")
// Preserve every executable byte offset: V8 reports this script against the original MJS.
const compiled = source.replace(/^import \{ ([^\n]+) \} from ("[^"]+")$/gmu, (original, names: string, module: string) => {
  const binding = `var{${names.replaceAll(" ", "")}}=require(${module});`
  if (binding.length > original.length) throw new Error("physical import mapping changed executable offsets")
  return binding.padEnd(original.length, " ")
}).replace(/^export \{$/mu, "out =  {")
if (compiled.length !== source.length || compiled.split("\n").some((line, index) => line.length !== source.split("\n")[index]!.length)) throw new Error("physical source mapping changed")

function load(overrides: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
  const context = vm.createContext({
    out: {}, Buffer, console, URL, AbortSignal, setTimeout, clearTimeout, fetch,
    process: { argv: ["node", "physical-test"], pid: 999, getuid: () => 0, getgid: () => 0, once: vi.fn() },
    require: (name: string) => name in overrides ? overrides[name] : name === "./sanctuary-deployment-target.mjs" ? deploymentTarget : require(name),
    ...globals,
  })
  vm.runInContext(compiled, context, { filename: brokerPath })
  return {
    call: (expression: string): any => vm.runInContext(expression, context),
    exports: context.out as Record<string, (...args: any[]) => any>,
  }
}

function memoryFilesystem() {
  type Entry = { data: string; uid: number; gid: number; mode: number; nlink: number; directory: boolean; size?: number }
  const files = new Map<string, Entry>()
  const descriptors = new Map<number, string>()
  let next = 10
  const missing = () => Object.assign(new Error("fixture missing"), { code: "ENOENT" })
  const put = (file: string, data: unknown = {}, uid = 0, mode = 0o600, directory = false) => {
    files.set(file, { data: typeof data === "string" ? data : JSON.stringify(data), uid, gid: uid, mode, nlink: 1, directory })
  }
  const resolve = (file: string | number) => typeof file === "number" ? descriptors.get(file)! : file
  const get = (file: string | number) => { const value = files.get(resolve(file)); if (!value) throw missing(); return value }
  const stat = (file: string | number) => {
    const entry = get(file)
    return { ...entry, size: entry.size ?? Buffer.byteLength(entry.data), ino: 1, isFile: () => !entry.directory, isDirectory: () => entry.directory }
  }
  const api = {
    ...fs,
    realpathSync: (file: string) => file,
    mkdirSync: (file: string) => { if (!files.has(file)) put(file, "", 0, 0o700, true) },
    chmodSync: (file: string, mode: number) => { get(file).mode = mode },
    chownSync: (file: string, uid: number, gid: number) => Object.assign(get(file), { uid, gid }),
    openSync: (file: string, flags: number, mode?: number) => {
      if (flags & fs.constants.O_CREAT) {
        if (files.has(file) && flags & fs.constants.O_EXCL) throw Object.assign(new Error("fixture exists"), { code: "EEXIST" })
        if (!files.has(file)) put(file, "", 0, mode)
      }
      get(file)
      const fd = next++
      descriptors.set(fd, file)
      return fd
    },
    closeSync: (fd: number) => { if (!descriptors.delete(fd)) throw new Error("closing an unowned fixture descriptor") },
    fstatSync: stat,
    statSync: stat,
    readFileSync: (file: string | number) => get(file).data,
    readSync: (fd: number, buffer: Buffer) => buffer.write(get(fd).data),
    writeFileSync: (file: string | number, data: string) => { get(file).data = data },
    fsyncSync: (fd: number) => { get(fd) },
    renameSync: (from: string, to: string) => { files.set(to, get(from)); files.delete(from) },
    unlinkSync: (file: string) => { if (!files.delete(file)) throw missing() },
    rmSync: (file: string) => { files.delete(file) },
    readdirSync: (root: string, options?: unknown) => {
      get(root)
      const names = [...files.keys()].filter((file) => file.startsWith(`${root}/`) && !file.slice(root.length + 1).includes("/")).map((file) => file.slice(root.length + 1))
      return options ? names.map((name) => ({ name, isFile: () => !get(`${root}/${name}`).directory })) : names
    },
    opendirSync: (root: string) => {
      get(root)
      return { readSync: () => [...files.keys()].some((file) => file.startsWith(`${root}/`)) ? { name: "fixture" } : null, closeSync: vi.fn() }
    },
  }
  return { files, put, get, api, descriptors }
}

function healthFixture() {
  const m = memoryFilesystem()
  const input = { label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64), ownerImageDigest: "b".repeat(64), ownerContainerDigest: "c".repeat(64) }
  const request = { label: input.label, scenarioHandleDigest: input.scenarioHandleDigest }
  const snapshot = { imageId: `sha256:${input.ownerImageDigest}`, containerId: input.ownerContainerDigest, running: true, health: "healthy" }
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, unref: vi.fn(), kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0); return true }) })
  let clock = 0
  class Clock extends Date { static now() { return clock } }
  const spawn = vi.fn(() => { m.put(paths.process, {}, 10001); return child })
  const spawnSync = vi.fn((_exe: string, args: string[]) => {
    if (args.includes("stop")) m.files.delete(paths.process)
    if (args.includes("recover")) { m.files.delete(paths.pending); m.files.delete(paths.workspace) }
    if (args.includes("finalize")) m.put(paths.receipt, receipt, 10001)
    return { status: 0 as number | null, error: undefined as Error | undefined }
  })
  const f = load({ "node:fs": m.api, "node:child_process": { spawn, spawnSync } }, {
    Date: Clock,
    setTimeout: (callback: () => void, delay: number) => setTimeout(() => { clock += delay; callback() }, 0),
  })
  const paths = Object.fromEntries(["receipt", "workspace", "pending", "process"].map((name) => [name, f.call(`healthProbe${name[0]!.toUpperCase()}${name.slice(1)}Path`)(input.scenarioHandleDigest)])) as Record<string, string>
  const receipt = Object.fromEntries(f.call("HEALTH_PROBE_RECEIPT_KEYS").map((key: string) => [key, null]))
  Object.assign(receipt, { schemaVersion: "sanctuary-health-probe-receipt-v1", ...request, phases: [], ownerImageDigestBefore: input.ownerImageDigest, ownerImageDigestAfter: input.ownerImageDigest, ownerContainerDigestBefore: input.ownerContainerDigest, ownerContainerDigestAfter: input.ownerContainerDigest })
  f.call(`containerSnapshot = async () => (${JSON.stringify(snapshot)})`)
  return { ...f, m, input, request, snapshot, child, spawn, spawnSync, paths, receipt }
}

function containerFixture() {
  const m = memoryFilesystem()
  const inspection: Record<string, any> = {
    containerId: "0".repeat(64), name: "/ouro-butler", imageId: `sha256:${"a".repeat(64)}`, pid: 4242, running: true, health: "healthy",
    startedAt: "2026-09-17T00:00:00.000Z", restartCount: 0, user: "10001:10001", readOnlyRoot: false, networkMode: "host", ports: {},
    privileged: false, capAdd: null, capDrop: null, securityOpt: null, restartPolicy: "unless-stopped",
    mounts: [
      ["/mnt/user/appdata/ouro-butler/runtime/.ouro-cli", "/home/ouro/.ouro-cli", true],
      ["/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro", "/home/ouro/AgentBundles/sanctuary.ouro", true],
      ["/boot/config/custom/ouro-events/spool", "/run/ouro-events", false], ["/run/ouro-authority", "/run/ouro-authority", false],
    ].map(([Source, Destination, RW]) => ({ Source, Destination, RW, Type: "bind", Mode: "", Propagation: "rprivate" })),
  }
  m.put("/proc/4242/status", "Uid:\t10001\t10001\t10001\t10001\nGid:\t10001\t10001\t10001\t10001\n")
  m.put("/proc/4242/stat", `4242 (node) S ${Array(18).fill("0").join(" ")} 9001`)
  m.put("/proc/sys/kernel/random/boot_id", "fixture-boot")
  m.put("/var/lib/docker/unraid-autostart", "ouro-butler\n")
  const keys = "/boot/config/plugins/dynamix.my.servers/keys"
  m.put(keys, "", 0, 0o700, true)
  const readPermissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"].map((resource) => ({ resource, actions: ["READ_ANY"] }))
  m.put(`${keys}/ro.json`, { id: "ro", name: "Butler RO", key: "fixture", permissions: readPermissions, roles: [] })
  const spawnSync = vi.fn((executable: string, args: string[]) => {
    if (executable === "/usr/bin/docker" && args[0] === "inspect") return { status: 0, stdout: JSON.stringify(inspection) }
    if (executable === "/usr/bin/docker" && args[0] === "run") return { status: 0, stdout: '{"scheduler":"supercronic","updates":"disabled"}' }
    if (executable === "/usr/bin/docker" && args[0] === "exec") return { status: 0, stdout: "local unlock: available\nruntime credentials: identitySeed (revision)\n  minimax: credential fields apiKey, config fields baseUrl\n" }
    if (executable === "/usr/bin/docker" && args[0] === "stop") { inspection.running = false; inspection.pid = 0; return { status: 0, stdout: "" } }
    if (executable === "/usr/local/sbin/mdcmd") return { status: 0, stdout: "mdState=STARTED\nmdResync=0\n" }
    if (executable === "/usr/local/sbin/tailscale") return { status: 0, stdout: '{"BackendState":"Running"}' }
    if (executable === "/usr/bin/pgrep") return { status: args.includes("mover") ? 1 : 0, stdout: "42\n" }
    throw new Error(`unexpected fixture command ${executable}`)
  })
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: { vars: { id: `${"f".repeat(64)}:vars` }, docker: { containers: [{ id: `${"f".repeat(64)}:${inspection.containerId}`, names: [inspection.name], autoStart: true }] } } }) }))
  const f = load({ "node:fs": m.api, "node:child_process": { spawnSync } }, { fetch })
  f.call(`expectedImageId = ${JSON.stringify(inspection.imageId)}`)
  return { ...f, m, inspection, spawnSync, fetch }
}

function quiescenceFixture() {
  const root = "/mnt/user/appdata/ouro-authority"
  const config = { keyId: "epoch-1", botId: "123", publicKeyDigest: `sha256:${"b".repeat(64)}`, lockPath: `${root}/epochs/epoch-1/authority.lock` }
  const records = new Map<string | number, string>([
    [`${root}/active.json`, JSON.stringify(config)],
    [config.lockPath, "500"],
    [`${root}/epochs/epoch-1/epoch.json`, JSON.stringify({ schemaVersion: 1, state: "prepared", epochId: config.keyId, botId: config.botId, publicKeyDigest: config.publicKeyDigest, revokedTokenStatus: 401, tokenDigest: `sha256:${"1".repeat(64)}`, previousTokenDigest: `sha256:${"2".repeat(64)}` })],
    ["/proc/500/status", "Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n"],
    ["/proc/500/stat", `500 (node) S ${Array(18).fill("0").join(" ")} 9001`],
    ["/proc/500/cmdline", ["/usr/local/bin/node", `${root}/package/dist/heart/daemon/sanctuary-telegram-authority-entry.js`, "--config", `${root}/active.json`, ""].join("\0")],
    ["/proc/sys/kernel/random/boot_id", "fixture-boot"],
  ])
  const owner = { containerId: "0".repeat(64), name: "/ouro-butler", imageId: `sha256:${"a".repeat(64)}`, running: false, pid: 0, startedAt: "start", restartCount: 1 }
  let pids = "500\n"
  const stat = { isFile: () => true, uid: 0, gid: 0, nlink: 1, mode: 0o600, size: 1024, ino: 1n }
  const read = (file: string | number) => {
    const value = records.get(file)
    if (value === undefined) throw Object.assign(new Error(`fixture absent: ${file}`), { code: "ENOENT" })
    return value
  }
  const filesystem = {
    ...fs,
    openSync: (file: string) => { read(file); return file },
    fstatSync: () => stat,
    closeSync: vi.fn(),
    realpathSync: (file: string) => file,
    readFileSync: read,
    readSync: (fd: string, buffer: Buffer) => buffer.write(read(fd)),
  }
  const spawnSync = vi.fn((executable: string, args: string[]) => {
    if (executable === "/usr/bin/docker" && args[0] === "inspect") return { status: 0, stdout: JSON.stringify(owner) }
    if (executable === "/usr/bin/pgrep") return { status: 0, stdout: pids }
    throw new Error(`unexpected physical fixture command ${executable}`)
  })
  const loaded = load({ "node:fs": filesystem, "node:child_process": { spawnSync } })
  loaded.call(`expectedImageId = ${JSON.stringify(owner.imageId)}`)
  return { ...loaded, records, owner, stat, config, spawnSync, pids: (value: string) => { pids = value } }
}

describe("native ordinary restart continuation", () => {
  it("uses the default snapshot and bounded wait wrappers for a single resident restart", async () => {
    const f = load({ "node:child_process": { spawnSync: () => ({ status: 0 }) } }, { setTimeout: (callback: () => void) => { queueMicrotask(callback); return 1 } })
    const input = { label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64) }
    const owner = { imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy", restartCount: 0 }
    f.call(`var observations = 0; containerRestartSnapshot = () => ({...${JSON.stringify(owner)}, restartCount: ++observations > 2 ? 1 : 0})`)
    await expect(f.call("restartButlerForAcceptance")(input)).resolves.toMatchObject({ restarted: true, restartInvocationCount: 1 })
    for (const fault of ["spawn", "count", "timeout"]) {
      const dependencies = { snapshot: () => ({ ...owner, restartCount: fault === "count" ? -1 : 0 }), run: () => ({ status: fault === "spawn" ? 1 : 0 }), sleep: async () => undefined }
      await expect(f.call("restartButlerForAcceptance")(input, dependencies)).rejects.toThrow()
    }
  })
  it("executes ordinary continuation defaults and retains exact failed restart boundaries", async () => {
    const m = memoryFilesystem()
    const f = load({ "node:fs": m.api }, { setTimeout: (callback: () => void) => { queueMicrotask(callback); return 1 } })
    const input = { label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64) }
    const prepared = {
      schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "prepared", ...input,
      approvalIdDigest: "b".repeat(64), checkpointDigest: "c".repeat(64), suspendedSessionRevisionDigest: "d".repeat(64),
      approvalEpochBefore: 0, pendingDigestBefore: "1".repeat(64), indeterminateRecoveryObserved: true, attemptedRecoveryReopened: true,
      attemptedRecordDigest: "7".repeat(64), recoveredRecordDigest: "8".repeat(64),
    }
    const owner = { imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy", restartCount: 0 }
    const restarted = { restarted: true, restartInvocationCount: 1, ownerImageDigest: "b".repeat(64), ownerContainerDigest: "c".repeat(64), restartCountBefore: 0, restartCountAfter: 1 }
    const reconciled = { approvalEpochAfterRestart: 0, continuationEpochAfter: 1, pendingDigestAfter: "1".repeat(64), pendingRestored: true, callbackAttempts: 1, mutationCount: 1, indeterminateRetryCount: 0 }
    f.call(`var readyChecks=0; containerRestartSnapshot=()=>(${JSON.stringify(owner)}); restartButlerForAcceptance=async()=>(${JSON.stringify(restarted)}); runInteractiveRuntimeOperation=async(operation)=>operation==="prepare_restart_continuation"?(${JSON.stringify(prepared)}):operation==="interactive_runtime_ready"?{ready:++readyChecks>1}:(${JSON.stringify(reconciled)})`)
    const complete = await f.call("driveRestartContinuation")(input)
    expect(complete).toMatchObject({ phase: "complete", mutationCount: 1, indeterminateRetryCount: 0 })
    expect(await f.call("driveRestartContinuation")(input)).toEqual(complete)
    for (const field of ["schemaVersion", "ownerImageDigest"]) expect(() => f.call("requireInteractiveReceipt")({ ...complete, [field]: "bad" }, input)).toThrow()
    for (const fault of ["throw", "prepared", "owner", "restart"]) {
      const dependencies = {
        readReceipt: () => null, persistReceipt: vi.fn(),
        runtime: async () => { if (fault === "throw") throw new Error("runtime"); return { ...prepared, ...(fault === "prepared" ? { phase: "bad" } : {}) } },
        snapshot: async () => ({ ...owner, running: fault !== "owner" }), restart: async () => ({ ...restarted, restarted: fault !== "restart" }), sleep: async () => undefined,
      }
      await expect(f.call("driveRestartContinuation")(input, dependencies)).rejects.toThrow()
      expect(dependencies.persistReceipt.mock.calls.at(-1)?.[1]).toMatchObject({ phase: "attempted_or_indeterminate" })
    }
    const recovery = { ...prepared, phase: "attempted_or_indeterminate", ownerImageDigest: "b".repeat(64), ownerContainerDigest: "c".repeat(64), restartCountBefore: 0 }
    await expect(f.call("driveRestartContinuation")(input, { readReceipt: () => recovery, snapshot: async () => owner })).rejects.toThrow(/inspect-before-retry/u)
    f.call("requirePreparedRestartReceipt")(recovery, input)
    for (const response of [{ ready: null }, { ready: false }]) await expect(f.call("waitForInteractiveRuntimeReady")(input, { runtime: async () => response, sleep: async () => undefined })).rejects.toThrow()
    expect(() => f.call("canonicalInteractiveRequest")(input, "unit-16l-duplicate-callback")).toThrow(/label/u)
    const timeout = { label: "unit-16k-timeout-stale", scenarioHandleDigest: input.scenarioHandleDigest }
    await expect(f.call("driveTimeoutStale")(timeout, { readReceipt: () => ({ phase: "waiting" }), persistReceipt: vi.fn(), runtime: async () => { throw new Error("failure") } })).rejects.toThrow("failure")
    const duplicateInput = { label: "unit-16l-duplicate-callback", scenarioHandleDigest: input.scenarioHandleDigest }
    const duplicate = { schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "complete", ...duplicateInput, approvalIdDigest: "b".repeat(64), checkpointDigest: "c".repeat(64), suspendedSessionRevisionDigest: "d".repeat(64), approvalEpochBefore: 0, callbackDataDigest: "e".repeat(64), callbackAttempts: 2, distinctQueryCount: 2, barrierObserved: true, settledCount: 2, claimCount: 1, mutationCount: 1, staleReplayAttempts: 1, staleReplaySettled: true, staleReplayMutationCount: 0, promptTerminal: true, writeCredentialObserved: false }
    const dependencies = { readReceipt: () => null, persistReceipt: vi.fn(), runtime: async () => duplicate }
    expect(await f.call("driveDuplicateCallbacks")(duplicateInput, dependencies)).toEqual(duplicate)
    expect(await f.call("driveDuplicateCallbacks")(duplicateInput, { ...dependencies, readReceipt: () => duplicate })).toEqual(duplicate)
    const driver = f.call("createInteractiveRestartDriver()")
    const routed = await f.exports.dispatch!({ operation: "drive_restart_continuation", targetId: "sanctuary", ...input }, { driveRestartContinuation: async () => complete, interactiveRestartDriver: driver, ownerMutationCoordinator: f.call("createOwnerMutationCoordinator()") })
    expect(routed.state).toBe("waiting")
    driver.arm(input.scenarioHandleDigest)
    await driver.stopAndDrain()
    expect(driver.poll(input, () => null)).toMatchObject({ state: "complete" })
  })
})

describe("physical root gateway quiescence", () => {
  it("observes the exact stopped resident and one root process bound to its private lock", async () => {
    const f = quiescenceFixture()
    const result = await f.exports.dispatch!({ operation: "telegram_gateway_quiescence", targetId: "sanctuary" })
    expect(result).toMatchObject({ schemaVersion: 1, activePollers: 1, residentStopped: true, keyId: "epoch-1", botId: "123", publicKeyDigest: f.config.publicKeyDigest, processBindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(f.spawnSync.mock.calls.filter(([executable]) => executable === "/usr/bin/pgrep")).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain("token")
  })
  it.each(["running", "pid", "name", "image", "duplicate", "foreign-root", "missing-lock", "stale-lock", "command", "changed-stat", "unsafe", "foreign-lock", "target", "extra"])("refuses %s instead of trusting a count file", async (fault) => {
    const f = quiescenceFixture()
    if (fault === "running") f.owner.running = true
    if (fault === "pid") f.owner.pid = 42
    if (fault === "name") f.owner.name = "/other"
    if (fault === "image") f.owner.imageId = `sha256:${"c".repeat(64)}`
    if (fault === "duplicate") f.pids("500\n501\n")
    if (fault === "foreign-root") f.records.set("/proc/500/status", "Uid:\t10001\t10001\t10001\t10001\n")
    if (fault === "missing-lock") f.records.delete(f.config.lockPath)
    if (fault === "stale-lock") f.records.set(f.config.lockPath, "501")
    if (fault === "command") f.records.set("/proc/500/cmdline", "unrelated")
    if (fault === "changed-stat") f.records.set("/proc/500/stat", "invalid")
    if (fault === "unsafe") f.stat.mode = 0o644
    if (fault === "foreign-lock") f.records.set("/mnt/user/appdata/ouro-authority/active.json", JSON.stringify({ ...f.config, lockPath: "/untrusted" }))
    const request = { operation: "telegram_gateway_quiescence", targetId: fault === "target" ? "other" : "sanctuary", ...(fault === "extra" ? { count: 1 } : {}) }
    await expect(f.exports.dispatch!(request)).rejects.toThrow()
  })
})

describe("physical broker persistence and process boundaries", () => {
  it("round-trips root-only recovery, creation and rejection records with exact durable cleanup", () => {
    const m = memoryFilesystem()
    const f = load({ "node:fs": m.api })
    const invoke = (name: string, ...args: unknown[]) => f.call(name)(...args)
    const record = { id: "key-1", name: "Butler RO", key: "fixture-key", roles: [], permissions: [{ resource: "ARRAY", actions: ["READ_ANY"] }] }
    expect(invoke("optionalRecoveryRecord", record.id)).toBeNull()
    expect(invoke("optionalCreateIntent", record.name)).toBeNull()
    expect(invoke("optionalRejectionReceipt", record.id)).toBeNull()
    invoke("persistRecovery", record)
    expect(invoke("optionalRecoveryRecord", record.id)).toEqual(record)
    invoke("persistCreateIntent", record.name, ["ARRAY:READ_ANY"])
    expect(invoke("optionalCreateIntent", record.name)).toEqual({ name: record.name, permissions: ["ARRAY:READ_ANY"] })
    for (const status of [401, 403]) {
      invoke("persistRejectionReceipt", record.id, status)
      expect(invoke("optionalRejectionReceipt", record.id)).toEqual({ valid: false, id: record.id, status })
    }
    for (const patch of [{ schemaVersion: 2 }, { id: "other" }, { status: 200 }, { proofDigest: "wrong" }]) {
      invoke("persistRejectionReceipt", record.id, 401)
      const file = invoke("rejectionReceiptPath", record.id)
      m.put(file, { ...JSON.parse(m.get(file).data), ...patch })
      expect(() => invoke("optionalRejectionReceipt", record.id)).toThrow(/invalid/u)
    }
    for (const patch of [{ schemaVersion: 2 }, { name: "other" }, { permissions: [] }, { permissions: ["ARRAY:READ_ANY", "ARRAY:READ_ANY"] }]) {
      const file = invoke("createIntentPath", record.name)
      m.put(file, { schemaVersion: 1, name: record.name, permissions: ["ARRAY:READ_ANY"], ...patch })
      expect(() => invoke("optionalCreateIntent", record.name)).toThrow()
    }
    for (const reader of ["optionalRecoveryRecord", "optionalCreateIntent", "optionalRejectionReceipt"]) {
      f.call("readPrivateJson = () => { throw Object.assign(new Error('denied'), {code:'EACCES'}) }")
      expect(() => invoke(reader, record.id)).toThrow("denied")
    }
    invoke("removeCreateIntent", record.name)
    invoke("removeCreateIntent", record.name)
    invoke("removeRecovery", record.id)
    expect(m.descriptors.size).toBe(0)
    const denied = load({ "node:fs": { ...m.api, unlinkSync: () => { throw new Error("denied") } } })
    expect(() => denied.call("removePrivateFile")("/fixture")).toThrow("denied")
  })

  it("rejects untrusted key directory entries and every malformed key record boundary", () => {
    const m = memoryFilesystem()
    const root = "/boot/config/plugins/dynamix.my.servers/keys"
    const record = { id: "key", name: "Butler RO", key: "secret", roles: [], permissions: [{ resource: "ARRAY", actions: ["READ_ANY"] }] }
    m.put(root, "", 0, 0o700, true)
    m.put(`${root}/key.json`, record)
    const f = load({ "node:fs": m.api })
    expect(f.call("inventoryRecords()")).toEqual([record])
    for (const patch of [{ directory: false }, { uid: 1 }, { mode: 0o755 }]) {
      Object.assign(m.get(root), patch)
      expect(() => f.call("inventoryRecords()")).toThrow(/directory/u)
      m.put(root, "", 0, 0o700, true)
    }
    for (const patch of [{ directory: true }, { uid: 1 }, { mode: 0o644 }]) {
      Object.assign(m.get(`${root}/key.json`), patch)
      expect(() => f.call("inventoryRecords()")).toThrow()
      m.put(`${root}/key.json`, record)
    }
    m.put(`${root}/extra.txt`, "other")
    expect(() => f.call("inventoryRecords()")).toThrow(/entry/u)
    m.files.delete(`${root}/extra.txt`)
    for (const patch of [{ permissions: null }, { roles: null }, { permissions: [{ resource: "ARRAY", actions: [] }] }, { permissions: [{ resource: "ARRAY", actions: ["READ_ANY", "READ_ANY"] }] }, { roles: [1] }]) {
      expect(() => f.call("normalizeRecord")({ ...record, ...patch })).toThrow()
    }
    m.put(`${root}/second.json`, { ...record, id: "second" })
    expect(() => f.call("inventoryRecords()")).toThrow(/ambiguous/u)
    m.put(`${root}/second.json`, { ...record, name: "second" })
    expect(() => f.call("inventoryRecords()")).toThrow(/ambiguous/u)
  })

  it("executes bounded inspection and CLI readers and rejects errors and identity drift", () => {
    const image = `sha256:${"a".repeat(64)}`
    const owner = { containerId: "0".repeat(64), imageId: image, restartCount: 0, running: true, health: "healthy" }
    const response = { status: 0 as number | null, stdout: JSON.stringify(owner), error: undefined as Error | undefined }
    const run = vi.fn(() => response)
    const f = load({ "node:child_process": { spawnSync: run } })
    for (const name of ["containerOwnerSnapshot", "containerRestartSnapshot"]) {
      expect(f.call(name)(image)).toMatchObject({ containerId: owner.containerId, imageId: image })
      for (const fault of [{ error: new Error("unavailable") }, { status: 1 }]) {
        Object.assign(response, fault)
        expect(() => f.call(name)(image)).toThrow(/inspection failed/u)
        Object.assign(response, { status: 0, error: undefined })
      }
      for (const patch of [{ containerId: "other" }, { imageId: `sha256:${"b".repeat(64)}` }, ...(name === "containerRestartSnapshot" ? [{ restartCount: -1 }, { restartCount: 0.5 }, { running: false, health: "missing" }] : [])]) {
        response.stdout = JSON.stringify({ ...owner, ...patch })
        if ("running" in patch) expect(f.call(name)(image)).toMatchObject({ running: false, health: "missing" })
        else expect(() => f.call(name)(image)).toThrow(/identity/u)
      }
      response.stdout = JSON.stringify(owner)
    }
    response.stdout = '{"exact":true}'
    expect(f.call("runUnraid")(["apikey", "--json"])).toEqual({ exact: true })
    expect(run.mock.calls.length).toBeGreaterThan(1)
    response.status = 1
    expect(() => f.call("runUnraid")([])).toThrow()
    response.status = 0
    response.error = new Error("unavailable")
    expect(() => f.call("runUnraid")([])).toThrow()
  })

  it("keeps root quiescence proof strict across metadata, epoch, singleton and generation failures", async () => {
    for (const [field, value] of [["uid", 1], ["gid", 1], ["nlink", 2], ["size", 0], ["size", 65537]] as const) {
      const f = quiescenceFixture()
      Object.assign(f.stat, { [field]: value })
      await expect(f.exports.dispatch!({ operation: "telegram_gateway_quiescence", targetId: "sanctuary" })).rejects.toThrow(/metadata/u)
    }
    for (const patch of [{ schemaVersion: 2 }, { state: "retired" }, { epochId: "other" }, { botId: "other" }, { publicKeyDigest: "bad" }, { revokedTokenStatus: 200 }, { tokenDigest: "bad" }, { previousTokenDigest: "bad" }, { previousTokenDigest: `sha256:${"1".repeat(64)}` }]) {
      const f = quiescenceFixture()
      const file = "/mnt/user/appdata/ouro-authority/epochs/epoch-1/epoch.json"
      f.records.set(file, JSON.stringify({ ...JSON.parse(f.records.get(file)!), ...patch }))
      await expect(f.exports.dispatch!({ operation: "telegram_gateway_quiescence", targetId: "sanctuary" })).rejects.toThrow(/epoch/u)
    }
    for (const pid of ["0", "-1", "1.5", "4194305"]) {
      const f = quiescenceFixture()
      f.records.set(f.config.lockPath, pid)
      await expect(f.exports.dispatch!({ operation: "telegram_gateway_quiescence", targetId: "sanctuary" })).rejects.toThrow(/PID/u)
    }
    const f = quiescenceFixture()
    let observations = 0
    const old = f.spawnSync.getMockImplementation()!
    f.spawnSync.mockImplementation((exe, args) => {
      const result = old(exe, args)
      if (exe === "/usr/bin/docker" && ++observations === 1) f.records.set("/proc/500/stat", `500 (node) S ${Array(18).fill("0").join(" ")} 9002`)
      return result
    })
    await expect(f.exports.dispatch!({ operation: "telegram_gateway_quiescence", targetId: "sanctuary" })).rejects.toThrow(/generation/u)
  })
})

describe("physical health probe lifecycle", () => {
  it("launches the exact packaged child, observes its marker, and reports all process states", async () => {
    const f = healthFixture()
    await expect(f.exports.startHealthProbe?.(f.input) ?? f.call("startHealthProbe")(f.input)).resolves.toMatchObject({ state: "started", operationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(f.spawn).toHaveBeenCalledOnce()
    expect(f.child.unref).toHaveBeenCalledOnce()
    expect(f.call("healthOwnerMutationActive()")).toBe(true)
    await expect(f.call("startHealthProbe")(f.input)).rejects.toThrow(/inspect-before-retry/u)
    for (const [state, expected] of [["running", "running"], ["failed", "failed"], ["terminating", "recovery_required"], ["terminated", "recovery_required"], ["recovering", "recovery_required"]]) {
      f.call(`activeHealthProbes.get("${f.input.scenarioHandleDigest}").state = "${state}"`)
      await expect(f.call("healthProbeStatus")(f.request)).resolves.toEqual({ state: expected })
    }
    for (const state of ["running", "terminating"]) {
      const fresh = healthFixture()
      await fresh.call("startHealthProbe")(fresh.input)
      fresh.call(`activeHealthProbes.get("${fresh.input.scenarioHandleDigest}").state = "${state}"`)
      fresh.child.emit("error", new Error("fixture child error"))
      expect(fresh.call(`activeHealthProbes.get("${fresh.input.scenarioHandleDigest}").state`)).toBe(state === "terminating" ? "terminating" : "failed")
      fresh.child.emit("exit", 0)
      expect(fresh.call(`activeHealthProbes.get("${fresh.input.scenarioHandleDigest}").state`)).toBe(state === "terminating" ? "terminated" : "exited")
    }
    f.child.emit("exit", 1)
    expect(f.call(`activeHealthProbes.get("${f.input.scenarioHandleDigest}").state`)).toBe("failed")
    await expect(f.call("healthProbeStatus")({ ...f.request, label: "unit-16h-acceptance-delivery-probe" })).rejects.toThrow(/binding/u)
  })

  it("requires safe, timely process registration before a start succeeds", async () => {
    for (const fault of ["directory", "uid", "mode", "exited", "timeout"]) {
      const f = healthFixture()
      f.spawn.mockImplementation(() => {
        if (fault !== "timeout" && fault !== "exited") {
          f.m.put(f.paths.process!, {}, fault === "uid" ? 0 : 10001, fault === "mode" ? 0o644 : 0o600, fault === "directory")
        }
        if (fault === "exited") queueMicrotask(() => f.child.emit("exit", 1))
        return f.child
      })
      await expect(f.call("startHealthProbe")(f.input)).rejects.toThrow(/marker|registration|exited/u)
    }
  })

  it("distinguishes absent, durable-recovery and complete receipt states", async () => {
    const f = healthFixture()
    await expect(f.call("healthProbeStatus")(f.request)).resolves.toEqual({ state: "absent" })
    for (const kind of ["workspace", "pending"]) {
      f.m.put(f.paths[kind]!, {}, 10001)
      await expect(f.call("healthProbeStatus")(f.request)).resolves.toEqual({ state: "recovery_required" })
      f.m.files.delete(f.paths[kind]!)
    }
    f.m.put(f.paths.receipt!, f.receipt, 10001)
    await expect(f.call("healthProbeStatus")(f.request)).resolves.toEqual({ state: "complete", containerSnapshot: f.snapshot })
    for (const patch of [{ directory: true }, { uid: 0 }, { mode: 0o644 }]) {
      Object.assign(f.m.get(f.paths.receipt!), patch)
      await expect(f.call("healthProbeStatus")(f.request)).rejects.toThrow(/metadata/u)
      f.m.put(f.paths.receipt!, f.receipt, 10001)
    }
    expect(f.m.descriptors.size).toBe(0)
  })

  it("finalizes only a matching exited owner and a newly attested private receipt", async () => {
    for (const fault of ["none", "status", "error", "missing", "directory", "uid", "mode", "changed-owner"]) {
      const f = healthFixture()
      await f.call("startHealthProbe")(f.input)
      f.child.emit("exit", 0)
      f.m.put(f.paths.pending!, { schemaVersion: "sanctuary-health-probe-pending-v1", receipt: f.receipt }, 10001)
      const original = f.spawnSync.getMockImplementation()!
      f.spawnSync.mockImplementation((exe, args) => {
        const result = original(exe, args)
        if (fault === "status") result.status = 1
        if (fault === "error") result.error = new Error("spawn failed")
        if (fault === "missing") f.m.files.delete(f.paths.receipt!)
        if (fault === "directory") f.m.get(f.paths.receipt!).directory = true
        if (fault === "uid") f.m.get(f.paths.receipt!).uid = 0
        if (fault === "mode") f.m.get(f.paths.receipt!).mode = 0o644
        return result
      })
      if (fault === "changed-owner") f.snapshot.imageId = `sha256:${"d".repeat(64)}`
      const result = f.call("healthProbeStatus")(f.request, () => f.snapshot)
      if (fault === "none") {
        await expect(result).resolves.toEqual({ state: "complete", containerSnapshot: f.snapshot })
        expect(f.spawnSync.mock.calls[0]![1]).toContain("finalize")
      } else await expect(result).rejects.toThrow()
    }
  })

  it("recovers exact health ownership, terminates first, and retains failed recovery for retry", async () => {
    for (const started of [false, true]) for (const kind of ["absent", "workspace", "pending"]) {
      const f = healthFixture()
      if (started) await f.call("startHealthProbe")(f.input)
      if (kind !== "absent") f.m.put(f.paths[kind]!, {}, 10001)
      const result = f.call("recoverHealthProbe")(f.input)
      if (started) await expect(f.call("recoverHealthProbe")(f.input)).resolves.toEqual({ recovered: true })
      await expect(result).resolves.toEqual({ recovered: true })
      expect(f.spawnSync.mock.calls[0]![1]).toContain("stop")
      expect(f.call("activeHealthProbes.size")).toBe(0)
    }
    for (const fault of ["owner", "unready", "directory", "uid", "mode", "spawn", "status", "workspace-remains", "pending-remains"]) {
      const f = healthFixture()
      await f.call("startHealthProbe")(f.input)
      if (fault === "unready") f.call(`activeHealthProbes.get("${f.input.scenarioHandleDigest}").readyPromise = Promise.reject(new Error("unready"))`)
      if (fault === "directory") f.m.get(f.paths.process!).directory = true
      if (fault === "uid") f.m.get(f.paths.process!).uid = 0
      if (fault === "mode") f.m.get(f.paths.process!).mode = 0o644
      f.m.put(f.paths.workspace!, {}, 10001)
      const original = f.spawnSync.getMockImplementation()!
      f.spawnSync.mockImplementation((exe, args) => {
        const result = original(exe, args)
        if (args.includes("recover")) {
          if (fault === "spawn") result.error = new Error("spawn")
          if (fault === "status") result.status = 1
          if (fault === "workspace-remains") f.m.put(f.paths.workspace!, {}, 10001)
          if (fault === "pending-remains") f.m.put(f.paths.pending!, {}, 10001)
        }
        return result
      })
      const result = f.call("recoverHealthProbe")(fault === "owner" ? { ...f.input, ownerImageDigest: "d".repeat(64) } : f.input)
      if (fault === "unready") await expect(result).resolves.toEqual({ recovered: true })
      else await expect(result).rejects.toThrow()
    }
  })

  it("rejects private receipt metadata and malformed pending envelopes without leaking descriptors", () => {
    const f = healthFixture()
    f.m.put(f.paths.pending!, { schemaVersion: "sanctuary-health-probe-pending-v1", receipt: {} }, 10001)
    expect(f.call("readHealthProbePendingReceipt")(f.paths.pending)).toEqual({})
    for (const patch of [{ directory: true }, { uid: 0 }, { mode: 0o644 }, { size: 262145 }]) {
      Object.assign(f.m.get(f.paths.pending!), patch)
      expect(() => f.call("readHealthProbePendingReceipt")(f.paths.pending)).toThrow(/metadata/u)
      f.m.put(f.paths.pending!, { schemaVersion: "sanctuary-health-probe-pending-v1", receipt: {} }, 10001)
    }
    f.m.put(f.paths.pending!, { schemaVersion: "other", receipt: {} }, 10001)
    expect(() => f.call("readHealthProbePendingReceipt")(f.paths.pending)).toThrow(/envelope/u)
    const identity = "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro/state/senses/telegram/identity.key"
    f.m.put(identity, "k".repeat(43), 10001)
    expect(() => f.call("requireHealthProbeCompleteAttestation")({ ...f.receipt, label: "unit-16f-cron-fingerprint", schedulerReceipt: {} }, f.snapshot, { ...f.request, label: "unit-16f-cron-fingerprint" })).toThrow()
    expect(f.m.descriptors.size).toBe(0)
  })

  it("observes durable health artifacts and propagates directory faults", () => {
    const f = healthFixture()
    expect(f.call("healthOwnerMutationActive()")).toBe(false)
    const root = "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro/state/acceptance/health-probe-workspaces"
    f.m.put(root, "", 10001, 0o700, true)
    expect(f.call("healthOwnerMutationActive()")).toBe(false)
    f.m.put(`${root}/active`, {}, 10001)
    expect(f.call("healthOwnerMutationActive()")).toBe(true)
    const denied = load({ "node:fs": { ...f.m.api, opendirSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) }, statSync: () => { throw new Error("stat denied") } } })
    expect(() => denied.call("healthOwnerMutationActive()")).toThrow("denied")
    expect(() => denied.call("statIfPresent('/fixture')")).toThrow("stat denied")
  })
})

describe("native container and root owner observations", () => {
  it("observes one exact four-mount gateway container and all root readiness owners", async () => {
    const f = containerFixture()
    const snapshot = await f.call("containerSnapshot")(f.inspection.imageId)
    expect(snapshot).toMatchObject({ mountCount: 4, mountsExact: true, securityExact: true, readOnlyRoot: false, vaultUnlocked: true, updaterDisabled: true, autostartExact: true })
    expect(f.call("observeRebootPreflight()")).toMatchObject({ safe: true, mutationActive: false })
    expect(f.fetch).toHaveBeenCalledOnce()
    expect(f.m.descriptors.size).toBe(0)
  })
  it("accepts tokenless runtime inventory and rejects old direct transport even with provider credentials", () => {
    const f = containerFixture()
    const output = "local unlock: available\nruntime credentials: identitySeed (revision)\n  minimax: credential fields apiKey, config fields baseUrl\n"
    expect(f.call("parseVaultStatus")(output, true)).toEqual({ vaultUnlocked: true, manualAuthRequired: false })
    expect(f.call("parseVaultStatus")(output.replace("identitySeed", "telegramBotToken"), true)).toEqual({ vaultUnlocked: false, manualAuthRequired: true })
  })
  it("stops only the exact production process generation and rejects changed stopped ownership", () => {
    const f = containerFixture()
    const before = f.call("runningRebootOwnerGeneration()")
    const proof = f.call("stopExactRebootOwner")(before.processBindingDigest)
    expect(proof).toMatchObject({ containerId: f.inspection.containerId, processBindingDigest: before.processBindingDigest })
    expect(f.spawnSync.mock.calls.some(([, args]) => args[0] === "stop")).toBe(true)
    for (const patch of [{ containerId: "other" }, { name: "/other" }, { imageId: "other" }, { restartCount: 2 }, { startedAt: "changed" }, { running: true }, { pid: 1 }]) {
      const original = { ...f.inspection }
      Object.assign(f.inspection, patch)
      expect(() => f.call("verifyStoppedRebootOwner")(proof)).toThrow(/generation/u)
      Object.assign(f.inspection, original)
    }
  })
  it("projects strict mounts, native empty security arrays, ports, autostart and degraded observations", async () => {
    for (const patch of [
      { mounts: null }, { mounts: [] }, { ports: null }, { ports: { "80/tcp": [1], "81/tcp": null } },
      { privileged: true }, { capAdd: [] }, { capDrop: [] }, { securityOpt: [] }, { capAdd: ["SYS_ADMIN"] }, { capDrop: ["ALL"] }, { securityOpt: ["other"] },
      { health: "starting" },
    ]) {
      const f = containerFixture()
      Object.assign(f.inspection, patch)
      const result = await f.call("containerSnapshot")(f.inspection.imageId)
      if ("mounts" in patch) expect(result.mountsExact).toBe(false)
      if ("privileged" in patch) expect(result.securityExact).toBe(false)
      if (patch.health) expect(result.manualAuthRequired).toBe(true)
    }
    for (const field of ["Source", "Destination", "Type", "Propagation", "RW"]) {
      const f = containerFixture()
      f.inspection.mounts[3][field] = field === "RW" ? true : "changed"
      expect((await f.call("containerSnapshot")(f.inspection.imageId)).mountsExact).toBe(false)
    }
    for (const name of ["/var/run/docker.sock", "/boot/config/plugins/dynamix.my.servers/keys"]) {
      const f = containerFixture()
      f.inspection.mounts[3].Destination = name
      expect((await f.call("containerSnapshot")(f.inspection.imageId)).writableKeyExposure).toBe(true)
    }
    const f = containerFixture()
    for (const profile of ["final", "staging"]) for (const content of ["", "ouro-butler", "ouro-butler-staging", "ouro-butler-rollback", "ouro-butler-legacy-evidence", "ouro-butler\nouro-butler", "other"]) {
      f.call(`activeProfile = targetProfile("${profile}")`)
      f.m.put("/var/lib/docker/unraid-autostart", content)
      expect(f.call("autostartFileExact()")).toBe(content === (profile === "final" ? "ouro-butler" : "ouro-butler-staging"))
    }
    f.m.get("/var/lib/docker/unraid-autostart").directory = true
    expect(() => f.call("autostartFileExact()")).toThrow(/invalid/u)
  })
  it("rejects bounded inspection failures and malformed process, policy and recovery state", async () => {
    for (const patch of [{ containerId: "other" }, { imageId: "other" }, { pid: 0 }, { pid: 4194305 }, { pid: 1.5 }, { restartCount: -1 }, { restartCount: 0.5 }, { startedAt: 1 }, { startedAt: "" }, { readOnlyRoot: null }, { running: false }, { user: "0:0" }]) {
      const f = containerFixture()
      const image = f.inspection.imageId
      Object.assign(f.inspection, patch)
      await expect(f.call("containerSnapshot")(image)).rejects.toThrow()
    }
    for (const rebound of [false, true]) for (const error of [false, true]) {
      const f = containerFixture()
      const original = f.spawnSync.getMockImplementation()!
      let calls = 0
      f.spawnSync.mockImplementation((exe, args) => exe === "/usr/bin/docker" && args[0] === "inspect" && ++calls === (rebound ? 2 : 1)
        ? { status: error ? 0 : 1, stdout: "", ...(error ? { error: new Error("unavailable") } : {}) } : original(exe, args))
      await expect(f.call("containerSnapshot")(f.inspection.imageId)).rejects.toThrow(/inspection failed/u)
    }
    for (const name of ["readBoundedProcStatus", "readBoundedProcIdentityFile"]) {
      const f = containerFixture()
      f.m.get("/proc/4242/status").directory = true
      expect(() => f.call(name)("/proc/4242/status")).toThrow()
      f.m.put("/proc/4242/status", "x".repeat(131073))
      expect(() => f.call(name)("/proc/4242/status")).toThrow(/bound/u)
    }
    for (const result of [{ status: 1 }, { status: 0, error: new Error("unavailable") }, { status: 0, stdout: '{"scheduler":"other","updates":"disabled"}' }, { status: 0, stdout: '{"scheduler":"supercronic","updates":"enabled"}' }]) {
      const f = load({ "node:child_process": { spawnSync: () => result } })
      if (result.status !== 0 || result.error) expect(() => f.call("updaterDisabled")(`sha256:${"a".repeat(64)}`)).toThrow()
      else expect(f.call("updaterDisabled")(`sha256:${"a".repeat(64)}`)).toBe(false)
      expect(f.call("vaultStatus")(true, true)).toMatchObject({ manualAuthRequired: true })
    }
    const f = containerFixture()
    expect(f.call("vaultStatus")(false, true)).toMatchObject({ manualAuthRequired: true })
    f.spawnSync.mockReturnValue({ status: 1, stdout: "not-json" })
    expect(f.call("recoveryMilestones")(false, false)).toMatchObject({ arrayReady: false, tailscaleReady: false, sshReady: false })
    f.spawnSync.mockReturnValue({ status: 0, stdout: "{}" })
    expect(f.call("recoveryMilestones")(true, true)).toMatchObject({ tailscaleReady: false })
  })
})

describe("native dispatch and durable interactive wrappers", () => {
  it("routes the default root inventory, key lifecycle and protected host request validators", async () => {
    const f = containerFixture()
    const request = (operation: string, extra = {}) => f.exports.dispatch!({ operation, targetServerId: "sanctuary-unraid", ...extra })
    await expect(request("inventory_keys")).resolves.toMatchObject({ keys: [{ id: "ro" }] })
    await expect(request("read_key_record", { keyId: "ro" })).resolves.toMatchObject({ id: "ro", key: "fixture" })
    await expect(request("read_key_record", { keyId: "missing" })).rejects.toThrow(/absent/u)
    f.call("createUnraidKey = async (name, permissions) => ({id:'created', name, permissions})")
    await expect(request("create_key", { name: "Butler RO", permissions: ["ARRAY:READ_ANY"] })).resolves.toMatchObject({ id: "created" })
    await expect(request("create_key", { name: "Butler RO", permissions: [] })).rejects.toThrow(/permissions/u)
    f.call("acknowledgeStoredUnraidKey = (id) => ({acknowledged:true,id})")
    await expect(request("acknowledge_key_storage", { keyId: "ro" })).resolves.toEqual({ acknowledged: true, id: "ro" })
    f.call("runUnraid = () => ({deleted:1,keys:[{id:'ro',name:'Butler RO'}]})")
    await expect(request("revoke_key", { keyId: "ro" })).resolves.toEqual({ revoked: true, id: "ro" })
    for (const result of [{ deleted: 0 }, { deleted: 1, keys: null }, { deleted: 1, keys: [] }, { deleted: 1, keys: [null] }, { deleted: 1, keys: [{ id: "wrong" }] }, { deleted: 1, keys: [{ id: "ro", name: "wrong" }] }]) {
      f.call(`runUnraid = () => (${JSON.stringify(result)})`)
      await expect(request("revoke_key", { keyId: "ro" })).rejects.toThrow(/attestation/u)
    }
    await expect(request("revoke_key", { keyId: "missing" })).rejects.toThrow(/absent/u)
    f.call("probeRevokedUnraidKey = async (id) => ({valid:false,status:401,id})")
    await expect(request("probe_revoked_key", { keyId: "ro" })).resolves.toMatchObject({ valid: false, id: "ro" })
    for (const operation of ["inventory_keys", "read_key_record", "create_key", "acknowledge_key_storage", "revoke_key", "probe_revoked_key"]) {
      const extra = operation === "inventory_keys" ? {} : operation === "create_key" ? { name: "Butler RO", permissions: ["ARRAY:READ_ANY"] } : { keyId: "ro" }
      await expect(request(operation, { ...extra, targetServerId: "other" })).rejects.toThrow(/target/u)
    }
    for (const [operation, params] of [
      ["container_snapshot", {}], ["denial_target_snapshot", {}],
      ["request_reboot", { idempotencyKey: "a".repeat(32), preflightDigest: "b".repeat(64), processBindingDigest: "c".repeat(64) }],
      ["stop_reboot_owner", { requestId: "a".repeat(64), reservationId: "b".repeat(64), processBindingDigest: "c".repeat(64) }],
      ["commit_reboot", { requestId: "a".repeat(64), reservationId: "b".repeat(64), processBindingDigest: "c".repeat(64) }],
      ["reboot_preflight_snapshot", { processBindingDigest: "a".repeat(64) }],
      ["start_health_probe", { label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64) }],
      ["drive_duplicate_callbacks", { label: "unit-16l-duplicate-callback", scenarioHandleDigest: "a".repeat(64) }],
    ] as const) await expect(f.exports.dispatch!({ operation, ...params, targetId: "other" })).rejects.toThrow(/target/u)
  })

  it("drives the default reboot coordinator to an observed spawn, and makes an ambiguous spawn nonrepeatable", async () => {
    for (const failed of [false, true]) {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
      const spawn = vi.fn(() => { queueMicrotask(() => child.emit(failed ? "error" : "spawn", new Error("spawn"))); return child })
      const f = load({ "node:child_process": { spawn }, "node:fs": { ...fs, readFileSync: () => "fixture-boot" } })
      const binding = "f".repeat(64)
      const preflight = { safe: true, arrayReady: true, parityActive: false, moverActive: false, mutationActive: false, digest: "e".repeat(64) }
      f.call(`containerSnapshot = async () => ({processBindingDigest:"${binding}"}); observeRebootPreflight = () => (${JSON.stringify(preflight)}); stopExactRebootOwner = () => ({processBindingDigest:"${binding}"}); verifyStoppedRebootOwner = () => undefined`)
      const staged = await f.exports.dispatch!({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "a".repeat(32), preflightDigest: preflight.digest, processBindingDigest: binding })
      const commit = { targetId: "sanctuary", requestId: staged.requestId, reservationId: staged.reservationId, processBindingDigest: binding }
      await f.exports.dispatch!({ operation: "stop_reboot_owner", ...commit })
      const result = f.exports.dispatch!({ operation: "commit_reboot", ...commit })
      if (failed) await expect(result).rejects.toThrow("spawn")
      else { await expect(result).resolves.toMatchObject({ committed: true }); expect(child.unref).toHaveBeenCalledOnce() }
      await expect(f.exports.dispatch!({ operation: "commit_reboot", ...commit })).rejects.toThrow(/attempted/u)
      expect(spawn).toHaveBeenCalledOnce()
    }
  })

  it("persists private interactive receipts and refuses unsafe files and directories", () => {
    const m = memoryFilesystem()
    const f = load({ "node:fs": m.api })
    const input = { scenarioHandleDigest: "a".repeat(64) }
    const file = f.call("interactiveReceiptPath")(input.scenarioHandleDigest)
    expect(f.call("readInteractiveReceipt")(input)).toBeNull()
    f.call("persistInteractiveReceipt")(input, { phase: "prepared" })
    expect(f.call("readInteractiveReceipt")(input)).toEqual({ phase: "prepared" })
    for (const patch of [{ directory: true }, { uid: 0 }, { mode: 0o644 }, { size: 262145 }]) {
      Object.assign(m.get(file), patch)
      expect(() => f.call("readInteractiveReceipt")(input)).toThrow(/metadata/u)
      m.put(file, {}, 10001)
    }
    expect(m.descriptors.size).toBe(0)
    const bad = load({ "node:fs": { ...m.api, openSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) } } })
    expect(() => bad.call("readInteractiveReceipt")(input)).toThrow("denied")
    for (const patch of [{ isDirectory: () => false }, { uid: 0 }, { mode: 0o755 }]) {
      const invalid = load({ "node:fs": { ...m.api, fstatSync: (fd: number) => ({ ...m.api.fstatSync(fd), ...patch }) } })
      expect(() => invalid.call("persistInteractiveReceipt")(input, {})).toThrow(/directory/u)
    }
  })

  it("executes the ordinary timeout callback wrapper and validates every receipt field", async () => {
    const m = memoryFilesystem()
    const input = { label: "unit-16k-timeout-stale", scenarioHandleDigest: "a".repeat(64) }
    const receipt = {
      schemaVersion: "sanctuary-timeout-stale-driver-receipt-v1", phase: "complete", ...input, approvalIdDigest: "b".repeat(64), checkpointDigest: "c".repeat(64), suspendedSessionRevisionDigest: "d".repeat(64),
      callbackDataDigest: "e".repeat(64), approvalEpochBefore: 0, callbackAttempts: 1, distinctQueryCount: 1, settledCount: 1, claimCount: 0, mutationCount: 0, staleAcknowledged: true, promptTerminal: true,
    }
    const result = { status: 0, stdout: JSON.stringify(receipt) }
    const f = load({ "node:fs": m.api, "node:child_process": { spawnSync: () => result } })
    expect(f.call("runTimeoutStaleDriver")(input)).toEqual(receipt)
    result.stdout = '{"state":"waiting"}'
    expect(f.call("runTimeoutStaleDriver")(input)).toEqual({ state: "waiting" })
    result.stdout = JSON.stringify(receipt)
    expect(await f.call("driveTimeoutStale")(input)).toEqual(receipt)
    expect(await f.call("driveTimeoutStale")(input)).toEqual(receipt)
    for (const key of Object.keys(receipt)) {
      expect(() => f.call("requireTimeoutReceipt")({ ...receipt, [key]: null }, input)).toThrow()
    }
    result.stdout = ""
    expect(() => f.call("runTimeoutStaleDriver")(input)).toThrow(/receipt/u)
  })

  it("registers both termination handlers and drains exact native broker ownership once", async () => {
    for (const failure of [false, true]) {
      const f = containerFixture()
      const socket = "/fixture.sock"
      f.m.put(socket, "")
      const process = new EventEmitter() as EventEmitter & { argv: string[]; pid: number; getuid: () => number; exitCode?: number }
      Object.assign(process, { argv: ["node", "test", "final", "0".repeat(64), socket, "/closed.json", f.inspection.imageId, "/snapshot.json"], pid: 99, getuid: () => 0 })
      const server = { listen: vi.fn((file: string, callback: () => void) => { f.m.put(file, "socket"); callback() }), close: vi.fn() }
      const loaded = load({ "node:fs": f.m.api, "node:net": { createServer: () => server } }, { process })
      loaded.call(`containerSnapshot = async () => (${JSON.stringify(f.inspection)}); recoverHealthProbe = async () => {${failure ? "throw new Error('recovery')" : "return {recovered:true}"} }; activeHealthProbes.set("fixture", {input:{}})`)
      await loaded.call("main()")
      expect(JSON.parse(f.m.get("/closed.json").data).keys).toHaveLength(1)
      process.emit("SIGTERM")
      process.emit("SIGINT")
      await vi.waitFor(() => expect(process.exitCode).toBe(failure ? 1 : 0))
      expect(server.close).toHaveBeenCalledOnce()
    }
    for (const argv of [[], ["node", "test", "final"], ["node", "test", "", "", "", "", "", ""]]) {
      const f = load({}, { process: { argv, getuid: () => 0 } })
      await expect(f.call("main()")).rejects.toThrow(/usage/u)
    }
    const unprivileged = load({}, { process: { argv: [], getuid: () => 1 } })
    await expect(unprivileged.call("main()")).rejects.toThrow(/root/u)
    const entered = { argv: ["node", "sanctuary-unit16-host-broker.mjs"], getuid: () => 1, exitCode: undefined }
    load({}, { process: entered })
    await vi.waitFor(() => expect(entered.exitCode).toBe(1))
  })
})

describe("native failure contract matrix", () => {
  it("rejects malformed topology and optional rollback observations", async () => {
    const f = containerFixture()
    const records = f.call("inventoryRecords()")
    const run = f.call("queryGraphqlAutostart")
    const envelope = { data: { vars: { id: `${"f".repeat(64)}:vars` }, docker: { containers: [{ id: `${"f".repeat(64)}:${"0".repeat(64)}`, names: ["/ouro-butler"], autoStart: true }] } } }
    const response = (value: unknown, ok = true) => async () => ({ ok, json: async () => value })
    await expect(run([], response(envelope))).rejects.toThrow(/key/u)
    await expect(run(records, response(envelope, false))).rejects.toThrow(/query failed/u)
    for (const value of [{}, { errors: [] }, { data: { vars: { id: "bad" } } }, { data: { ...envelope.data, docker: { containers: null } } }, { data: { ...envelope.data, docker: { containers: [{ names: null }] } } }, { data: { ...envelope.data, docker: { containers: [{ names: [1] }] } } }]) {
      await expect(run(records, response(value))).rejects.toThrow()
    }
    for (const containers of [
      [{ ...envelope.data.docker.containers[0], names: ["ouro-butler", "ouro-butler-staging"] }],
      [{ ...envelope.data.docker.containers[0], id: null }],
      [{ ...envelope.data.docker.containers[0], id: `${"e".repeat(64)}:${"0".repeat(64)}` }],
      [{ ...envelope.data.docker.containers[0], autoStart: null }],
      [envelope.data.docker.containers[0], envelope.data.docker.containers[0]],
    ]) expect(await run(records, response({ data: { ...envelope.data, docker: { containers } } }))).toBe(false)
    expect(await run(records, response({ data: { ...envelope.data, docker: { containers: [{ names: ["other"] }, ...envelope.data.docker.containers] } } }))).toBe(true)
    const optional = f.call("optionalStoppedContainerExact")
    expect(optional("other", "0".repeat(64))).toBe(false)
    expect(optional("ouro-butler-rollback", "bad")).toBe(false)
    for (const result of [{ status: 1 }, { error: new Error("failed") }, { status: 0 }, { status: 0, stdout: "bad" }]) expect(optional("ouro-butler-rollback", "0".repeat(64), () => result)).toBe(false)
    f.m.put("/boot/config/plugins/dynamix.my.servers/keys/second.json", { ...records[0], id: "second", name: "other" })
    expect(f.call("inventoryRecords()").map((entry: { id: string }) => entry.id)).toEqual(["ro", "second"])
  })
  it("refuses invalid process identity, root paths, missing output and preflight failures", async () => {
    const f = containerFixture()
    for (const value of [null, "x".repeat(131073), "1 (node) S"]) expect(() => f.call("parseProcStartTime")(value)).toThrow()
    for (const pid of [0, 4194305]) expect(() => f.call("liveContainerProcessIdentity")(pid)).toThrow()
    for (const raw of [null, "x".repeat(131073), "Uid:\tx\nGid:\t10001\t10001\t10001\t10001"]) expect(() => f.call("liveContainerProcessUser")(1, { readFile: () => raw })).toThrow()
    const generation = f.call("runningRebootOwnerGeneration()")
    for (const patch of [{ pid: 0 }, { restartCount: -1 }]) expect(() => f.call("productionProcessBindingDigest")({ ...generation, ...patch })).toThrow()
    for (const patch of [{ name: "/other" }, { imageId: "other" }, { running: false }, { health: "unhealthy" }, { pid: 0 }, { restartCount: -1 }]) {
      const original = { ...f.inspection }
      Object.assign(f.inspection, patch)
      expect(() => f.call("runningRebootOwnerGeneration()")).toThrow()
      Object.assign(f.inspection, original)
    }
    expect(() => f.call("stopExactRebootOwner")("a".repeat(64))).toThrow(/changed/u)
    expect(() => f.call("readAuthorityText")("/untrusted")).toThrow(/path/u)
    f.call("realpathSync = () => '/elsewhere'")
    expect(() => f.call("readAuthorityText")("/mnt/user/appdata/ouro-authority/active.json")).toThrow(/path/u)
    for (const result of [{ error: new Error("failed"), status: 0 }, { status: 1 }, { status: 0 }]) {
      const bad = load({ "node:child_process": { spawnSync: () => result } })
      expect(() => bad.call("inspectRebootOwner()")).toThrow()
      expect(() => bad.call("denialTargetSnapshot()")).toThrow()
      expect(() => bad.call("observeRebootPreflight()")).toThrow()
      expect(() => bad.call("runInteractiveRuntimeOperation")("op", {})).toThrow()
    }
    for (const raw of ["invalid-line", "mdState=STARTED"]) expect(() => f.call("observeRebootPreflight")({ readArrayStatus: () => raw, readMoverStatus: () => ({ status: 1 }), mutationActive: () => false })).toThrow()
    for (const patch of [{ running: null }, { restartCount: -1 }]) {
      const bad = load({ "node:child_process": { spawnSync: () => ({ status: 0, stdout: JSON.stringify({ ...f.inspection, status: "running", ...patch }) }) } })
      expect(() => bad.call("denialTargetSnapshot()")).toThrow()
    }
    const stopFailure = containerFixture()
    const stopBinding = stopFailure.call("runningRebootOwnerGeneration()").processBindingDigest
    const old = stopFailure.spawnSync.getMockImplementation()!
    stopFailure.spawnSync.mockImplementation((exe, args) => args[0] === "stop" ? { status: 1, stdout: "" } : old(exe, args))
    expect(() => stopFailure.call("stopExactRebootOwner")(stopBinding)).toThrow(/stop failed/u)
    const missingRebound = containerFixture()
    let count = 0
    missingRebound.spawnSync.mockImplementation(() => ++count === 1 ? { status: 0, stdout: JSON.stringify(missingRebound.inspection) } : { status: 0 } as never)
    await expect(missingRebound.call("containerSnapshot")(missingRebound.inspection.imageId)).rejects.toThrow()
  })
  it("validates health routing bounds, absent actors and root coordinator status", async () => {
    const f = healthFixture()
    expect(() => f.call("canonicalHealthProbeInput")({ ...f.input, label: "unknown" })).toThrow()
    expect(() => f.call("healthProbeDockerArgs")("unknown", f.input)).toThrow()
    expect(() => f.call("requireStableHealthProbeOwner")(f.input, { ...f.input, label: "unit-16f-cron-fingerprint" })).toThrow()
    expect(f.call("safeMacEqual")(1, "a")).toBe(false)
    f.call("requireHealthProbeCompleteAttestation")({ ...f.receipt, phases: null }, f.snapshot, f.request)
    for (const payload of [{ targetId: "other", ...f.request }, { targetId: "sanctuary", ...f.request, label: "bad" }]) expect(() => f.call("healthProbeCoordinates")(payload, f.snapshot)).toThrow()
    f.call(`expectedImageId = "sha256:${"a".repeat(64)}"`)
    expect(() => f.call("healthProbeCoordinates")({ targetId: "sanctuary", ...f.request }, f.snapshot)).toThrow()
    f.call('expectedImageId = ""')
    for (const operation of ["start_health_probe", "health_probe_status", "recover_health_probe"]) {
      const dependencies = { containerSnapshot: async () => f.snapshot, readBootId: () => "boot" }
      await expect(f.exports.dispatch!({ operation, targetId: "sanctuary", ...f.request }, dependencies)).rejects.toThrow(/unavailable/u)
    }
    await expect(f.call("healthProbeCoordinator.start")("a".repeat(64), async () => 1)).resolves.toBe(1)
    await expect(f.call("healthProbeCoordinator.recover")("a".repeat(64), async () => 2)).resolves.toBe(2)
    await expect(f.exports.dispatch!({ operation: "health_probe_status", targetId: "sanctuary", ...f.request }, { ownerMutationCoordinator: f.call("ownerMutationCoordinator"), healthProbeStatus: async () => ({ state: "running" }) })).resolves.toEqual({ state: "running" })
    const root = containerFixture()
    root.call("recoverHealthProbe = async () => ({recovered:true})")
    await expect(root.exports.dispatch!({ operation: "recover_health_probe", targetId: "sanctuary", ...f.request })).resolves.toEqual({ recovered: true })
    await expect(f.exports.dispatch!({ operation: "denial_target_snapshot", targetId: "sanctuary" }, {})).rejects.toThrow(/unavailable/u)
    await expect(f.exports.dispatch!({ operation: "drive_duplicate_callbacks", targetId: "sanctuary", label: "unit-16l-duplicate-callback", scenarioHandleDigest: "a".repeat(64) }, {})).rejects.toThrow(/unavailable/u)
  })
  it("preserves coordinator fencing on invalid and repeated stop/commit transitions", async () => {
    const f = load()
    const id = "a".repeat(64), binding = "b".repeat(64)
    const coordinator = f.call("createOwnerMutationCoordinator()")
    await expect(coordinator.stopRebootOwner(id, binding, () => ({}))).rejects.toThrow(/absent/u)
    await expect(coordinator.commitReboot(id, binding, () => ({}))).rejects.toThrow(/absent/u)
    await coordinator.reserveReboot(id, binding, () => true)
    await expect(coordinator.reserveReboot(id, binding, () => true)).rejects.toThrow(/exists/u)
    await expect(coordinator.stopRebootOwner(id, "c".repeat(64), () => ({}))).rejects.toThrow(/binding/u)
    await expect(coordinator.stopRebootOwner(id, binding, () => ({}))).rejects.toThrow(/binding/u)
    await coordinator.stopRebootOwner(id, binding, () => ({ processBindingDigest: binding }))
    await expect(coordinator.stopRebootOwner(id, binding, () => ({}))).rejects.toThrow(/already/u)
    await expect(coordinator.commitReboot(id, "c".repeat(64), () => ({}))).rejects.toThrow(/mismatched/u)
    await expect(coordinator.commitReboot(id, binding, () => true)).rejects.toThrow(/not attempted/u)
    await expect(coordinator.commitReboot(id, binding, (_proof: unknown, mark: () => void) => { mark(); mark() })).rejects.toThrow(/already/u)
    const health = f.call("createOwnerMutationCoordinator()")
    await health.healthStart(id, () => true)
    await expect(health.healthStart(id, () => true)).rejects.toThrow(/active/u)
    await expect(health.reserveReboot(id, binding, () => true)).rejects.toThrow(/drain/u)
    const serial = f.call("createHealthProbeOperationCoordinator()")
    const first = serial.start(id, () => { throw new Error("first") })
    const observed = expect(first).rejects.toThrow("first")
    const second = serial.start(id, () => 2)
    await observed
    await expect(second).resolves.toBe(2)
    for (const text of ["inspect-before-retry", "production runtime", "prepared receipt", "reconciliation", "receipt"]) expect(f.call("interactiveFailureCategory")(f.call(`new Error(${JSON.stringify(text)})`))).not.toBe("operation-failed")
    expect(typeof f.call("interactiveFailureCategory")(null)).toBe("string")
    const driver = f.call("createInteractiveRestartDriver()")
    const input = { scenarioHandleDigest: id }
    driver.arm(id)
    expect(driver.poll(input, () => true)).toEqual({ state: "waiting" })
    expect(driver.poll(input, () => true)).toEqual({ state: "waiting" })
    driver.arm(id)
    driver.arm(id)
    await driver.stopAndDrain()
    driver.arm(id)
  })
})

describe("native terminal boundary coverage", () => {
  it("handles exited children and failures without a prior in-memory or durable operation", async () => {
    const f = healthFixture()
    const record = { state: "running", child: { exitCode: 0, signalCode: null, kill: vi.fn() } }
    await f.call("terminateHealthProbeChild")(record)
    expect(record.child.kill).not.toHaveBeenCalled()
    expect(record.state).toBe("terminated")
    f.spawnSync.mockReturnValue({ status: 1, error: undefined })
    await expect(f.call("recoverHealthProbe")(f.input)).rejects.toThrow()
    const write = vi.fn()
    await expect(f.call("driveTimeoutStale")({ label: "unit-16k-timeout-stale", scenarioHandleDigest: "a".repeat(64) }, {
      readReceipt: () => null, persistReceipt: write, runtime: async () => { throw new Error("unavailable") },
    })).rejects.toThrow("unavailable")
    expect(write.mock.calls.at(-1)?.[1]).toMatchObject({ phase: "preparation_indeterminate" })
  })
  it("reconciles key downgrade ambiguity only with exact recovery and live readback", async () => {
    const f = load()
    const provisional = { id: "created", name: "Butler RO", key: "fixture-key", permissions: [{ resource: "API_KEY", actions: ["UPDATE_ANY"] }, { resource: "ARRAY", actions: ["READ_ANY"] }], roles: ["GUEST"] }
    const final = { ...provisional, permissions: [{ resource: "ARRAY", actions: ["READ_ANY"] }], roles: [] }
    for (const fault of ["intent", "recovery", "ambiguous", "downgrade", "convergence", "probe"]) {
      let records = fault === "recovery" ? [final] : fault === "ambiguous" ? [provisional, provisional] : []
      const dependencies = {
        inventoryRecords: () => records,
        readIntent: () => fault === "intent" ? { name: "wrong", permissions: [] } : { name: provisional.name, permissions: ["API_KEY:UPDATE_ANY", "ARRAY:READ_ANY"] },
        persistIntent: vi.fn(), persistRecovery: vi.fn(), readRecovery: () => null,
        runUnraid: () => { records = [provisional]; return { id: provisional.id, name: provisional.name, key: provisional.key } },
        fetchImpl: async (_url: string, options: RequestInit) => {
          const downgrade = String(options.body).includes("Downgrade")
          if (downgrade && fault !== "convergence") records = [final]
          return { ok: fault !== (downgrade ? "downgrade" : "probe"), json: async () => ({ data: {} }) }
        },
      }
      const result = f.call("createUnraidKey")("Butler RO", ["ARRAY:READ_ANY"], dependencies)
      if (fault === "downgrade") await expect(result).resolves.toEqual(final)
      else await expect(result).rejects.toThrow()
    }
    const probe = f.call("probeRevokedUnraidKey")
    for (const variant of [
      { readReceipt: () => ({}), readRecovery: () => ({ id: "wrong" }) },
      { readReceipt: () => null, readRecovery: () => null },
      { readReceipt: () => null, readRecovery: () => ({ id: "id", key: "fixture" }), fetchImpl: async () => ({ status: 200 }) },
    ]) await expect(probe("id", variant)).rejects.toThrow()
    const permissions = [...f.call("RO_PERMISSIONS"), "DOCKER:UPDATE_ANY"].sort().map((value: string) => { const [resource, action] = value.split(":"); return { resource, actions: [action] } })
    expect(f.call("acknowledgeStoredUnraidKey")("rw", { inventoryRecords: () => [{ ...final, id: "rw", name: "Butler RW", permissions }], readRecovery: () => null })).toEqual({ acknowledged: true, id: "rw" })
  })
  it("covers remaining readiness, host-observation and descriptor refusal paths", () => {
    const f = healthFixture()
    expect(f.call("parseVaultStatus")("local unlock: available\nruntime credentials: identitySeed (revision)\n", true).vaultUnlocked).toBe(false)
    expect(f.call("canonicalIso")(null)).toBe(false)
    expect(() => f.call("attestHealthProbeProcessAbsent")(f.input, { run: () => ({ status: 1 }), markerPresent: () => false })).toThrow()
    expect(() => f.call("attestHealthProbeProcessAbsent")(f.input, { run: () => ({ status: 0 }), markerPresent: () => true })).toThrow()
    const result = { containerId: "0".repeat(64), imageId: `sha256:${"a".repeat(64)}`, running: null, status: "running", restartCount: -1, startedAt: "2026-09-17T00:00:00.000Z" }
    expect(() => f.call("denialTargetSnapshot")({ run: () => ({ status: 0, stdout: JSON.stringify(result) }) })).toThrow(/lifecycle/u)
  })
  it("settles early child exits and reports failed process termination instead of cleanup success", async () => {
    const callbacks: Array<() => void> = []
    const f = load({}, { setTimeout: (callback: () => void) => { callbacks.push(callback); return 1 }, clearTimeout: () => undefined })
    const child = { exitCode: null as number | null, signalCode: null, once: (_name: string, callback: () => void) => { child.exitCode = 0; callback() }, removeListener: () => undefined }
    await expect(f.call("waitForHealthProbeChildExit")(child, 10)).resolves.toBe(true)
    callbacks[0]!()
    for (const state of ["failed", "exited"]) await expect(f.call("terminateHealthProbeChild")({ state })).resolves.toBeUndefined()
    const slow = load({}, { setTimeout: (callback: () => void) => { queueMicrotask(callback); return 1 }, clearTimeout: () => undefined })
    const record = { state: "running", child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() }) }
    await expect(slow.call("terminateHealthProbeChild")(record, { termGraceMs: 1, killGraceMs: 1 })).rejects.toThrow(/did not exit/u)
    expect(record.state).toBe("failed")
  })
  it("guards socket timeout and input bounds and arms restart only after response closure", async () => {
    let handle!: (socket: any) => void
    const f = load({ "node:net": { createServer: (_options: unknown, callback: typeof handle) => { handle = callback; return {} } } })
    const symbol = f.call("ASYNC_RESTART_SCENARIO")
    f.call(`interactiveRestartDriver.poll({scenarioHandleDigest:"${"a".repeat(64)}"}, () => ({}))`)
    f.call("createBrokerServer")(() => ({ state: "waiting", [symbol]: "a".repeat(64) }))
    let timeout!: () => void
    const socket = Object.assign(new EventEmitter(), {
      setTimeout: (_delay: number, callback: () => void) => { timeout = callback }, setEncoding: () => undefined,
      destroy: vi.fn(), end: vi.fn((_body: string, callback?: () => void) => { callback?.(); socket.emit("close") }),
    })
    handle(socket)
    timeout()
    expect(socket.destroy).toHaveBeenCalledOnce()
    socket.emit("data", "x".repeat(262145))
    expect(socket.destroy).toHaveBeenCalledTimes(2)
    const next = Object.assign(new EventEmitter(), { setTimeout: socket.setTimeout, setEncoding: socket.setEncoding, destroy: vi.fn(), end: vi.fn((_body: string, callback?: () => void) => { callback?.(); next.emit("close") }) })
    handle(next)
    next.emit("data", "{}")
    next.emit("end")
    await vi.waitFor(() => expect(next.end).toHaveBeenCalledOnce())
    await f.call("interactiveRestartDriver.stopAndDrain()")
  })
  it("refuses missing reboot actors, changed reservations and unsafe final observations", async () => {
    const f = load()
    const binding = "b".repeat(64), requestId = "a".repeat(64)
    const reservationId = f.call(`createHash("sha256").update("sanctuary-reboot-reservation\\0${requestId}").digest("hex")`)
    const request = { targetId: "sanctuary", requestId, reservationId, processBindingDigest: binding }
    const stage = { operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "a".repeat(32), preflightDigest: "e".repeat(64), processBindingDigest: binding }
    await expect(f.exports.dispatch!(stage, {})).rejects.toThrow(/unavailable/u)
    await expect(f.exports.dispatch!(stage, { ownerMutationCoordinator: { reserveReboot: (_id: string, _binding: string, operation: () => unknown) => operation() }, rebootPreflightSnapshot: () => ({ digest: stage.preflightDigest, safe: false }) })).rejects.toThrow(/unsafe/u)
    for (const operation of ["stop_reboot_owner", "commit_reboot"]) {
      await expect(f.exports.dispatch!({ operation, ...request, reservationId: "c".repeat(64) }, {})).rejects.toThrow(/binding/u)
      await expect(f.exports.dispatch!({ operation, ...request }, {})).rejects.toThrow(/unavailable/u)
    }
    await expect(f.exports.dispatch!({ operation: "commit_reboot", ...request }, { ownerMutationCoordinator: { commitReboot: (_id: string, _binding: string, operation: (value: unknown) => unknown) => operation({}) }, verifyStoppedRebootOwner: () => undefined, rebootPreflightSnapshot: () => ({ safe: false }) })).rejects.toThrow(/unsafe/u)
    for (const changed of [false, true]) {
      const dependencies = { containerSnapshot: async () => ({ processBindingDigest: changed ? "c".repeat(64) : binding }), rebootPreflightSnapshot: () => ({ safe: true }) }
      const result = f.exports.dispatch!({ operation: "reboot_preflight_snapshot", targetId: "sanctuary", processBindingDigest: binding }, dependencies)
      if (changed) await expect(result).rejects.toThrow(/changed/u)
      else await expect(result).resolves.toMatchObject({ safe: true, processBindingDigest: binding })
    }
    await expect(f.exports.dispatch!({ operation: "drive_restart_continuation", targetId: "sanctuary", label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64) }, { driveRestartContinuation: () => ({}) })).rejects.toThrow(/unavailable/u)
  })
})
