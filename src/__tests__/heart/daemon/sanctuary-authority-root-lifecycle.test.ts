import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SANCTUARY_KEEPER_BOOT_LINES, SanctuaryAuthorityRootLifecycle, recordSanctuaryRootLifecycleFailure, runSanctuaryAuthorityRootCli } from "../../../heart/daemon/sanctuary-authority-root-lifecycle"
import { withSessionTurnLease } from "../../../mind/session-transaction"
import { createLogger, type LogEvent } from "../../../nerves"
import { setRuntimeLogger } from "../../../nerves/runtime"

const host = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn(), cursor: vi.fn(), close: vi.fn() }))
const vault = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ execFileSync: host.exec, spawn: host.spawn }))
vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }))
vi.mock("../../../heart/daemon/sanctuary-authority-vault-migration", () => ({ migrateSanctuaryAuthorityVault: vault }))
vi.mock("../../../mind/session-transaction", async (original) => ({ ...await original<typeof import("../../../mind/session-transaction")>() }))
vi.mock("../../../senses/sanctuary-authority-resident", () => ({ openSanctuaryResidentAuthority: () => ({ cursorSnapshot: host.cursor, authorityTransport: { api: { stop: host.close } } }) }))
const roots: string[] = []
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const rootPath = "/mnt/user/appdata/ouro-authority"
const bundle = "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro"
const runtime = "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli"
// #vault runs `sh -c "cp ... && exec node CLI vault <op>"`, so the operation is the last word of the final docker-run argument.
const vaultOp = (args: readonly unknown[]): string => String(args.at(-1)).trim().split(/\s+/u).at(-1)!
const oldToken = "123:oldTokenabcdefghijklmnopqrstuvwxyz"
const installSteps = ["freeze-resident", "stage-authority", "verify-token-rotation", "transfer-cursor", "remove-resident-token", "start-gateway", "configure-resident", "start-resident", "verify-install"]
const rollbackSteps = ["freeze-resident", "retire-registrations", "reconcile-executions", "stop-gateway", "end-epoch", "restore-token-cursor", "restore-resident", "verify-rollback"]
function alterDocker(mutate: (args: string[], value: string) => string) {
  const original = host.exec.getMockImplementation()!
  host.exec.mockImplementation((file, args, options) => {
    const value = original(file, args, options)
    return file === "/usr/bin/docker" ? mutate(args, value) : value
  })
}
async function transactionFixture(f: ReturnType<typeof fixture>) {
  const module = await import("../../../../deploy/unraid/docker-man-template-transaction.mjs")
  const journalPath = f.p("/boot/config/custom/ouro-butler/docker-man-template-transaction.json")
  const targetPath = f.p("/boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml")
  f.write("/source/sanctuary.xml", `<?xml version="1.0"?>\n<Container version="2"><Name>ouro-butler</Name><Repository>ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.816</Repository><TemplateURL>https://raw.githubusercontent.com/ourostack/ouroboros/main/deploy/unraid/sanctuary.xml</TemplateURL><Icon>https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png</Icon><WebUI/><Config Target="/run/ouro-authority" Type="Path" Mode="ro">/run/ouro-authority</Config></Container>`)
  f.write("/boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml", "old-template")
  fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 })
  const options = { targetPath, journalPath, expectedUid: process.getuid!(), expectedGid: process.getgid!(), withLease: withSessionTurnLease, RootLifecycle: SanctuaryAuthorityRootLifecycle, rootLifecycleOptions: f.rootOptions }
  module.prepareDockerManTemplateTransaction({ ...f.transaction, sourceTemplatePath: f.p("/source/sanctuary.xml"), reviewedManifestDigest: digest("manifest"), canonicalVersionTag: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.816" }, options)
  return { module, options, journalPath }
}
function fixture() {
  const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "root-lifecycle-")))
  roots.push(prefix)
  const p = (name: string) => `${prefix}${name}`
  const write = (name: string, value: unknown) => {
    fs.mkdirSync(path.dirname(p(name)), { recursive: true, mode: 0o700 })
    fs.writeFileSync(p(name), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 })
  }
  const request = {
    schemaVersion: 1, epochId: "fixture-epoch", botId: "123", ownerUserId: "42", ownerChatId: "42",
    packageDigest: digest("manifest"), nodeDigest: digest("node"), prlimitDigest: digest("prlimit"),
    setsidDigest: digest("setsid"), shellDigest: digest("shell"),
  }
  write(`${rootPath}/request.json`, request)
  write(`${bundle}/state/senses/telegram/offset.json`, { nextUpdateId: 87 })
  let running = true
  let target = false
  let tokenPresent = true
  let currentToken = oldToken
  host.exec.mockImplementation((file: string, args: string[], options?: { input?: string }) => {
    if (file === "/usr/sbin/sysctl") return "fixture-boot"
    if (file === "/bin/ps") return "fixture-process-start"
    if (file.endsWith("/usr/local/bin/node") && args.includes("--retire-only")) {
      const epoch = JSON.parse(fs.readFileSync(p(`${rootPath}/epochs/fixture-epoch/epoch.json`), "utf8"))
      write(`${rootPath}/epochs/fixture-epoch/retirement.json`, { schemaVersion: 1, keyId: "fixture-epoch", publicKeyDigest: epoch.publicKeyDigest, quiescent: true, cursor: 91 })
      return ""
    }
    expect(file).toBe("/usr/bin/docker")
    if (args[0] === "container") return JSON.stringify({ name: "/jellyfin", containerId: "1".repeat(64), imageId: digest("jellyfin"), state: "running", restartCount: 0 })
    if (args[0] === "ps") return JSON.stringify({ Names: "ouro-butler" }) + "\n"
    if (args[0] === "inspect") return JSON.stringify([{
      Name: "/ouro-butler", Image: digest(target ? "new-image" : "old-image"), State: { Running: running, Health: { Status: "healthy" } },
      Config: { User: "10001:10001", Env: [] },
      Mounts: [{ Source: bundle, Destination: "/home/ouro/AgentBundles/sanctuary.ouro" }, ...(target ? [{ Source: "/run/ouro-authority", Destination: "/run/ouro-authority", RW: false }] : [])],
    }])
    if (args[0] === "stop") { running = false; return "" }
    if (args[0] === "update") return ""
    if (args[0] === "start") { running = true; return "" }
    if (args[0] === "run") {
      // #vault now runs `sh -c "cp ... && exec node CLI vault <op>"`, so the
      // operation is the last word of the final command argument.
      const operation = String(args.at(-1)).trim().split(/\s+/u).at(-1)
      if (operation === "presence") return JSON.stringify({ tokenPresent })
      if (operation === "remove") { tokenPresent = false; return JSON.stringify({ tokenAbsent: true }) }
      if (operation === "restore") { tokenPresent = true; currentToken = JSON.parse(options!.input!).token; return JSON.stringify({ restored: true }) }
      return JSON.stringify({ token: currentToken, botId: "123", ownerUserId: "42", ownerChatId: "42" })
    }
    throw new Error(`unexpected command ${args.join(" ")}`)
  })
  const transaction = { targetImageId: digest("new-image"), rollbackImageId: digest("old-image") }
  const rootOptions = { prefix, expectedUid: process.getuid!(), expectedGid: process.getgid!(), socketGroupId: process.getgid!() }
  const lifecycle = new SanctuaryAuthorityRootLifecycle(transaction, rootOptions)
  write("/var/lib/docker/unraid-autostart", "jellyfin 0\nunrelated 5\n")
  fs.chmodSync(p("/var/lib/docker/unraid-autostart"), 0o644)
  function staged() {
    const files = Object.fromEntries([
      "dist/heart/daemon/sanctuary-telegram-authority-entry.js",
      "dist/heart/daemon/sanctuary-host-supervisor-entry.js",
      "dist/heart/daemon/sanctuary-authority-root-lifecycle.js",
      "deploy/unraid/sanctuary-host-launcher.sh",
      "deploy/unraid/sanctuary-authority-service.sh",
    ].map((name) => {
      write(`${rootPath}/incoming-package/${name}`, name)
      fs.chmodSync(p(`${rootPath}/incoming-package/${name}`), 0o700)
      return [name, { digest: digest(name), mode: 0o700 }]
    }))
    const manifest = JSON.stringify({ schemaVersion: 1, files })
    write(`${rootPath}/package-manifest.json`, manifest)
    request.packageDigest = digest(manifest)
    for (const [file, bytes] of [["/usr/local/bin/node", "node"], ["/usr/bin/prlimit", "prlimit"], ["/usr/bin/setsid", "setsid"], ["/bin/sh", "shell"]]) {
      write(file!, bytes!)
      fs.chmodSync(p(file!), 0o755)
    }
    write("/boot/config/go", "#!/bin/sh\n# preserve unrelated boot state\n")
    for (const name of ["cgroup.controllers", "cgroup.subtree_control"]) write(`/sys/fs/cgroup/ouro-authority/${name}`, "cpu memory pids")
    write("/sys/fs/cgroup/ouro-authority/cgroup.type", "domain")
    write("/sys/fs/cgroup/ouro-authority/cgroup.procs", "")
    write("/proc/self/mountinfo", `1 0 0:1 / ${prefix} rw - rootfs rootfs rw\n2 1 0:2 / ${p("/sys/fs/cgroup")} rw - cgroup2 cgroup rw\n`)
    write(`${rootPath}/request.json`, request)
    return new SanctuaryAuthorityRootLifecycle(transaction, { prefix, expectedUid: process.getuid!(), expectedGid: process.getgid!(), socketGroupId: process.getgid!() })
  }
  return { lifecycle, request, write, p, staged, rootOptions, transaction, setRunning: (value: boolean) => { running = value }, createTarget: () => { target = true; running = false }, createRollback: () => { target = false; running = false } }
}
async function preparedFixture() {
  const f = fixture()
  const lifecycle = f.staged()
  f.write(`${rootPath}/incoming-token`, "123:newTokenabcdefghijklmnopqrstuvwxyz")
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("oldToken") ? { ok: false } : { ok: true, result: { id: 123 } }), { status: String(url).includes("oldToken") ? 401 : 200 }))
  for (const step of ["freeze-resident", "stage-authority", "verify-token-rotation", "transfer-cursor", "remove-resident-token"]) await lifecycle.effect(step).apply()
  const epochRoot = `${rootPath}/epochs/fixture-epoch`
  const epoch = JSON.parse(fs.readFileSync(f.p(`${epochRoot}/epoch.json`), "utf8"))
  host.cursor.mockResolvedValue({ keyId: "fixture-epoch", botId: "123", publicKeyDigest: epoch.publicKeyDigest, cursor: 87 })
  const publish = () => {
    f.write(`${epochRoot}/authority.lock`, "45678")
    f.write("/proc/45678/status", `Uid:\t${process.getuid!()}\t${process.getuid!()}\t${process.getuid!()}\t${process.getuid!()}\n`)
    f.write("/proc/45678/cmdline", `${f.p("/usr/local/bin/node")}\0${f.p(`${rootPath}/package/dist/heart/daemon/sanctuary-telegram-authority-entry.js`)}\0--config\0${f.p(`${rootPath}/active.json`)}\0`)
    f.write(`${epochRoot}/readiness.json`, { status: "ready", botId: "123", publicKeyDigest: epoch.publicKeyDigest })
  }
  host.spawn.mockImplementation(() => { publish(); return { unref: vi.fn(), once: vi.fn() } })
  return { ...f, lifecycle, epochRoot, epoch, publish }
}
async function installedStoppedGatewayFixture() {
  const f = await preparedFixture()
  await f.lifecycle.effect("start-gateway").apply()
  f.createTarget()
  for (const step of ["configure-resident", "start-resident", "verify-install"]) await f.lifecycle.effect(step).apply()
  fs.rmSync(f.p("/proc/45678"), { recursive: true })
  return f
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
describe("fixed root installation effects", () => {
  it("refreshes only explicitly reviewed execution pins and preserves authority, cursor and owner state", async () => {
    const f = await installedStoppedGatewayFixture()
    const beforeRequest = JSON.parse(fs.readFileSync(f.p(`${rootPath}/request.json`), "utf8"))
    const beforeConfig = JSON.parse(fs.readFileSync(f.p(`${rootPath}/active.json`), "utf8"))
    const retained = ["epoch.json", "issuer.pem", "current-token", "agent/authority/telegram-state.json"]
    const before = retained.map(name => fs.readFileSync(f.p(`${f.epochRoot}/${name}`), "utf8"))
    f.write("/usr/bin/prlimit", "reviewed-prlimit")
    f.write("/usr/bin/setsid", "reviewed-setsid")
    for (const name of ["executions", "supervisors"]) fs.mkdirSync(f.p(`${f.epochRoot}/${name}`), { mode: 0o700 })
    host.spawn.mockClear()
    host.exec.mockClear()
    const pins = [digest("reviewed-prlimit"), digest("reviewed-setsid")] as const
    f.lifecycle.repinExecution(...pins)
    f.lifecycle.repinExecution(...pins)
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/request.json`), "utf8"))).toEqual({ ...beforeRequest, prlimitDigest: pins[0], setsidDigest: pins[1] })
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/active.json`), "utf8"))).toEqual({ ...beforeConfig, hostPrlimitDigest: pins[0], hostSetsidDigest: pins[1] })
    expect(retained.map(name => fs.readFileSync(f.p(`${f.epochRoot}/${name}`), "utf8"))).toEqual(before)
    expect(host.spawn).not.toHaveBeenCalled()
    expect(host.exec).not.toHaveBeenCalled()
  })

  it.each(["live", "journal", "executions", "supervisors", "cgroup", "digest", "hash", "request", "config"])("refuses execution re-pinning with %s ambiguity before writing", async (fault) => {
    const f = await installedStoppedGatewayFixture()
    if (fault === "live") f.publish()
    if (fault === "journal") f.write("/boot/config/custom/ouro-butler/docker-man-template-transaction.json", "pending")
    if (fault === "executions" || fault === "supervisors") f.write(`${f.epochRoot}/${fault}/unresolved`, "pending")
    if (fault === "cgroup") fs.mkdirSync(f.p("/sys/fs/cgroup/ouro-authority/unresolved"))
    if (fault === "request") f.write(`${rootPath}/request.json`, { ...f.request, prlimitDigest: digest("concurrent request") })
    if (fault === "config") {
      const config = JSON.parse(fs.readFileSync(f.p(`${rootPath}/active.json`), "utf8"))
      f.write(`${rootPath}/active.json`, { ...config, ownerUserId: "43" })
    }
    const before = ["/request.json", "/active.json"].map(name => fs.readFileSync(f.p(`${rootPath}${name}`), "utf8"))
    expect(() => f.lifecycle.repinExecution(fault === "digest" ? "bad" : fault === "hash" ? digest("not current") : f.request.prlimitDigest, f.request.setsidDigest)).toThrow()
    expect(["/request.json", "/active.json"].map(name => fs.readFileSync(f.p(`${rootPath}${name}`), "utf8"))).toEqual(before)
  })

  it("retries interrupted execution-pin publication without changing its reviewed values", async () => {
    const f = await installedStoppedGatewayFixture()
    f.write("/usr/bin/prlimit", "reviewed-prlimit")
    const rename = fs.renameSync
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === f.p(`${rootPath}/active.json`)) throw new Error("interrupted config write")
      return rename(source, destination)
    })
    const pins = [digest("reviewed-prlimit"), f.request.setsidDigest] as const
    expect(() => f.lifecycle.repinExecution(...pins)).toThrow("interrupted config write")
    failure.mockRestore()
    new SanctuaryAuthorityRootLifecycle(f.transaction, f.rootOptions).repinExecution(...pins)
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/active.json`), "utf8")).hostPrlimitDigest).toBe(pins[0])
  })

  it.each(["/usr/bin/prlimit", "/usr/bin/setsid"])("boots and retires the installed gateway after %s changes without executing it", async (primitive) => {
    const f = await preparedFixture()
    await f.lifecycle.effect("start-gateway").apply()
    f.createTarget()
    for (const step of ["configure-resident", "start-resident", "verify-install"]) await f.lifecycle.effect(step).apply()
    f.write(primitive, "updated by the OS")
    for (let cycle = 0; cycle < 2; cycle++) {
      fs.rmSync(f.p("/proc/45678"), { recursive: true })
      await expect(f.lifecycle.boot()).resolves.toBe(true)
      expect(host.spawn).toHaveBeenLastCalledWith(f.p("/usr/local/bin/node"), [
        f.p(`${rootPath}/package/dist/heart/daemon/sanctuary-telegram-authority-entry.js`), "--config", f.p(`${rootPath}/active.json`),
      ], expect.objectContaining({ detached: true }))
    }
    await f.lifecycle.effect("rollback:freeze-resident").apply()
    fs.rmSync(f.p("/proc/45678"), { recursive: true })
    await f.lifecycle.effect("rollback:retire-registrations").apply()
    expect(JSON.parse(fs.readFileSync(f.p(`${f.epochRoot}/retirement.json`), "utf8")).quiescent).toBe(true)
  })

  it("retires a staged pre-epoch migration after execution primitives change", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    f.write(`${rootPath}/incoming-token`, "123:newTokenabcdefghijklmnopqrstuvwxyz")
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("oldToken") ? { ok: false } : { ok: true, result: { id: 123 } }), { status: String(url).includes("oldToken") ? 401 : 200 }))
    await lifecycle.effect("freeze-resident").apply()
    await lifecycle.effect("stage-authority").apply()
    f.write("/usr/bin/prlimit", "updated by the OS")
    await lifecycle.effect("rollback:retire-registrations").apply()
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/epochs/fixture-epoch/retirement.json`), "utf8")).quiescent).toBe(true)
  })

  it("publishes the boot hook through a safe public boot parent without weakening private state parents", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    await lifecycle.effect("freeze-resident").apply()
    fs.chmodSync(f.p("/boot/config"), 0o755)
    await lifecycle.effect("stage-authority").apply()
    expect(fs.statSync(f.p("/boot/config")).mode & 0o777).toBe(0o755)
    expect(fs.readFileSync(f.p("/boot/config/go"), "utf8")).toContain("# ouro-authority")
    fs.chmodSync(f.p("/boot/config"), 0o777)
    fs.writeFileSync(f.p("/boot/config/go"), "#!/bin/sh\n")
    await expect(lifecycle.effect("stage-authority").apply()).rejects.toThrow(/parent/u)
  })

  it("retires the current epoch when re-enable is interrupted before replacing the predecessor configuration", async () => {
    const f = await preparedFixture()
    for (const step of rollbackSteps.slice(0, 6)) await f.lifecycle.effect(`rollback:${step}`).apply()
    f.request.epochId = "second-epoch"
    f.write(`${rootPath}/request.json`, f.request)
    f.write(`${rootPath}/incoming-token`, "123:thirdTokenabcdefghijklmnopqrstuvwxyz")
    vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("newToken") ? { ok: false } : { ok: true, result: { id: 123 } }), { status: String(url).includes("newToken") ? 401 : 200 }))
    const lifecycle = new SanctuaryAuthorityRootLifecycle(f.transaction, f.rootOptions)
    await lifecycle.effect("freeze-resident").apply()
    const original = host.exec.getMockImplementation()!
    host.exec.mockImplementation((file, args, options) => {
      if (args.includes("--retire-only")) {
        const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"))
        expect(config.keyId).toBe("second-epoch")
        expect(fs.existsSync(config.tokenPath)).toBe(true)
        fs.writeFileSync(path.join(config.epochRoot, "retirement.json"), JSON.stringify({ schemaVersion: 1, keyId: config.keyId, publicKeyDigest: config.publicKeyDigest, quiescent: true, cursor: 91 }), { mode: 0o600 })
        return ""
      }
      return original(file, args, options)
    })
    await lifecycle.effect("rollback:retire-registrations").apply()
    expect(await lifecycle.effect("rollback:retire-registrations").readback()).toBe(lifecycle.effect("rollback:retire-registrations").afterDigest)
  })
  it("accepts legitimate rollback cursor progress but never rewinds or accepts regression", async () => {
    const f = await preparedFixture()
    for (const step of rollbackSteps.slice(0, 6)) await f.lifecycle.effect(`rollback:${step}`).apply()
    f.createRollback()
    await f.lifecycle.effect("rollback:restore-resident").apply()
    const offset = `${bundle}/state/senses/telegram/offset.json`
    f.write(offset, { nextUpdateId: 92 })
    await f.lifecycle.effect("rollback:verify-rollback").apply()
    expect(await f.lifecycle.effect("rollback:verify-rollback").readback()).toBe(f.lifecycle.effect("rollback:verify-rollback").afterDigest)
    await expect(f.lifecycle.effect("rollback:restore-token-cursor").apply()).rejects.toThrow(/stopped/u)
    expect(JSON.parse(fs.readFileSync(f.p(offset), "utf8")).nextUpdateId).toBe(92)
    f.write(offset, { nextUpdateId: 90 })
    await expect(f.lifecycle.effect("rollback:verify-rollback").apply()).rejects.toThrow(/rollback/u)
  })
  it.each([4_396_757, 8_388_609])("keeps a separate bounded capacity for a complete package manifest of %i bytes", async (size) => {
    const f = fixture()
    f.staged()
    const manifestPath = `${rootPath}/package-manifest.json`
    const original = fs.readFileSync(f.p(manifestPath), "utf8")
    const manifest = original.padEnd(size, " ")
    f.write(manifestPath, manifest)
    f.request.packageDigest = digest(manifest)
    f.write(`${rootPath}/request.json`, f.request)
    const lifecycle = new SanctuaryAuthorityRootLifecycle(f.transaction, f.rootOptions)
    await lifecycle.effect("freeze-resident").apply()
    if (size <= 8_388_608) {
      await lifecycle.effect("stage-authority").apply()
      expect(await lifecycle.effect("stage-authority").readback()).toBe(lifecycle.effect("stage-authority").afterDigest)
    } else {
      await expect(lifecycle.effect("stage-authority").apply()).rejects.toThrow("Sanctuary root lifecycle private file is unsafe")
    }
  })
  it.each([0o644, 0o700, 0o755])("preserves go-script mode %i under a private umask and refuses unsafe boot metadata", async (mode) => {
    const f = fixture()
    const lifecycle = f.staged()
    await lifecycle.effect("freeze-resident").apply()
    fs.chmodSync(f.p("/boot/config/go"), mode)
    const mask = process.umask(0o077)
    try { await lifecycle.effect("stage-authority").apply() } finally { process.umask(mask) }
    expect(fs.statSync(f.p("/boot/config/go")).mode & 0o777).toBe(mode)
    expect(await lifecycle.effect("stage-authority").readback()).toBe(lifecycle.effect("stage-authority").afterDigest)
    fs.chmodSync(f.p("/boot/config/go"), 0o777)
    await expect(lifecycle.effect("stage-authority").readback()).rejects.toThrow(/boot/u)
    expect(fs.statSync(f.p("/boot/config/go")).mode & 0o777).toBe(0o777)
  })
  it("emits a non-secret audit event for the bound root lifecycle", () => {
    const events: LogEvent[] = []
    setRuntimeLogger(createLogger({ sinks: [(event) => { events.push(event) }] }))
    try {
      fixture()
      expect(events).toContainEqual(expect.objectContaining({ event: "daemon.sanctuary_root_lifecycle_loaded", meta: { epochId: "fixture-epoch", targetImageId: digest("new-image") } }))
      expect(JSON.stringify(events)).not.toContain(oldToken)
    } finally { setRuntimeLogger(null) }
  })
  it("drives install, activation, retirement and restoration through the actual CLI without replaying historical steps", async () => {
    const f = await preparedFixture()
    const tx = await transactionFixture(f)
    const write = vi.fn()
    await expect(tx.module.runDockerManTemplateTransactionCli(["authority-activate"], tx.options, write)).rejects.toThrow(/installation must finish/u)
    await expect(tx.module.runDockerManTemplateTransactionCli(["authority-restore"], tx.options, write)).rejects.toThrow(/retirement must finish/u)
    await tx.module.runDockerManTemplateTransactionCli(["authority-install"], tx.options, write)
    f.createTarget()
    await tx.module.runDockerManTemplateTransactionCli(["authority-activate"], tx.options, write)
    await tx.module.runDockerManTemplateTransactionCli(["authority-install"], tx.options, write)
    await tx.module.runDockerManTemplateTransactionCli(["authority-activate"], tx.options, write)
    expect(host.exec.mock.calls.filter((call) => call[1][0] === "start")).toHaveLength(1)
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGUSR2") {
        f.write(`${f.epochRoot}/retirement.json`, { schemaVersion: 1, keyId: f.epoch.epochId, publicKeyDigest: f.epoch.publicKeyDigest, cursor: 91, quiescent: true })
        fs.rmSync(f.p("/proc/45678"), { recursive: true })
      }
      return true
    })
    await tx.module.runDockerManTemplateTransactionCli(["authority-retire"], tx.options, write)
    await tx.module.runDockerManTemplateTransactionCli(["authority-retire"], tx.options, write)
    f.createRollback()
    await tx.module.runDockerManTemplateTransactionCli(["authority-restore"], tx.options, write)
    await tx.module.runDockerManTemplateTransactionCli(["authority-restore"], tx.options, write)
    expect(JSON.parse(write.mock.calls.at(-1)![0]).state).toBe("retired")
    await expect(tx.module.runDockerManTemplateTransactionCli(["authority-install"], tx.options, write)).rejects.toThrow(/retired/u)
    await expect(tx.module.runDockerManTemplateTransactionCli(["authority-unknown"], tx.options, write)).rejects.toThrow(/operation/u)
    fs.unlinkSync(tx.journalPath)
    await expect(tx.module.runDockerManTemplateTransactionCli(["authority-install"], tx.options, write)).rejects.toThrow(/prepared deployment/u)
  })
  it("retires through the CLI after interruption before an incoming token was available", async () => {
    const f = fixture()
    f.staged()
    const tx = await transactionFixture(f)
    await expect(tx.module.runDockerManTemplateTransactionCli(["authority-install"], tx.options, () => undefined)).rejects.toThrow(/ENOENT/u)
    f.write(`${rootPath}/incoming-token`, "123:newTokenabcdefghijklmnopqrstuvwxyz")
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("oldToken") ? { ok: false } : { ok: true, result: { id: 123 } }), { status: String(url).includes("oldToken") ? 401 : 200 }))
    await tx.module.runDockerManTemplateTransactionCli(["authority-retire"], tx.options, () => undefined)
    expect(JSON.parse(fs.readFileSync(tx.journalPath, "utf8")).authority.cancelled).toHaveLength(1)
    expect(host.spawn).not.toHaveBeenCalled()
  })
  it("returns the restored offset to uid/gid 10001 at the production root boundary", async () => {
    const f = await preparedFixture()
    for (const step of rollbackSteps.slice(0, 5)) await f.lifecycle.effect(`rollback:${step}`).apply()
    const lstat = fs.lstatSync, fstat = fs.fstatSync
    vi.spyOn(fs, "lstatSync").mockImplementation(((file, options) => Object.assign(lstat(file, options), { uid: 0, gid: 0 })) as typeof fs.lstatSync)
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd, options) => Object.assign(fstat(fd, options), { uid: 0, gid: 0 })) as typeof fs.fstatSync)
    vi.spyOn(process, "getuid").mockReturnValue(0)
    vi.spyOn(process, "getgid").mockReturnValue(0)
    const chown = vi.spyOn(fs, "chownSync").mockImplementation(() => undefined)
    const lifecycle = new SanctuaryAuthorityRootLifecycle(f.transaction, { ...f.rootOptions, expectedUid: 0, expectedGid: 0 })
    await lifecycle.effect("rollback:restore-token-cursor").apply()
    expect(chown).toHaveBeenCalledWith(f.p(`${bundle}/state/senses/telegram/offset.json`), 10001, 10001)
  })
  it("dispatches root-only CLI vault operations through private stdin/stdout and refuses all other arguments", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(10001)
    await expect(runSanctuaryAuthorityRootCli(["vault", "snapshot"])).rejects.toThrow(/root/u)
    vi.mocked(process.getuid!).mockReturnValue(0)
    vi.spyOn(process, "getgid").mockReturnValue(10001)
    await expect(runSanctuaryAuthorityRootCli(["vault", "snapshot"])).rejects.toThrow(/root/u)
    vi.mocked(process.getgid!).mockReturnValue(0)
    for (const args of [[], ["unexpected"], ["boot", "extra"], ["other", "two"], ["repin-execution"], ["repin-execution", digest("one")], ["repin-execution", digest("one"), digest("two"), "extra"]]) await expect(runSanctuaryAuthorityRootCli(args)).rejects.toThrow(/Usage/u)
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    vault.mockResolvedValue({ tokenPresent: false })
    await runSanctuaryAuthorityRootCli(["vault", "presence"])
    expect(output).toHaveBeenCalledWith('{"tokenPresent":false}\n')
    const read = fs.readFileSync
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, options) => file === 0 ? '{"fixture":"private"}' : read(file, options)) as typeof fs.readFileSync)
    await runSanctuaryAuthorityRootCli(["vault", "restore"], () => undefined)
    expect(vault).toHaveBeenLastCalledWith("restore", { fixture: "private" })
  })

  it("refuses a bare vault removal and admits it only from inside the install transaction", async () => {
    fixture()
    vi.spyOn(process, "getuid").mockReturnValue(0)
    vi.spyOn(process, "getgid").mockReturnValue(0)
    const previous = process.env.OURO_AUTHORITY_REMOVE_INTERLOCK
    delete process.env.OURO_AUTHORITY_REMOVE_INTERLOCK
    try {
      await expect(runSanctuaryAuthorityRootCli(["vault", "remove"], () => undefined)).rejects.toThrow(/only inside the authority install transaction/u)
      expect(vault).not.toHaveBeenCalledWith("remove", undefined)

      process.env.OURO_AUTHORITY_REMOVE_INTERLOCK = "epoch-under-test"
      vault.mockResolvedValue({ tokenAbsent: true })
      await runSanctuaryAuthorityRootCli(["vault", "remove"], () => undefined)
      expect(vault).toHaveBeenLastCalledWith("remove", undefined)
    } finally {
      if (previous === undefined) delete process.env.OURO_AUTHORITY_REMOVE_INTERLOCK
      else process.env.OURO_AUTHORITY_REMOVE_INTERLOCK = previous
    }
  })
  it("fences boot under the existing deployment lease and constructs the root default owner only with an activation", async () => {
    const f = fixture()
    const sessions = await import("../../../mind/session-transaction")
    const boot = vi.spyOn(SanctuaryAuthorityRootLifecycle.prototype, "boot").mockResolvedValue(true)
    const repin = vi.spyOn(SanctuaryAuthorityRootLifecycle.prototype, "repinExecution").mockImplementation(() => undefined)
    vi.spyOn(sessions, "withSessionTurnLease").mockImplementation(async (_file, work) => work({} as never))
    vi.spyOn(process, "getuid").mockReturnValue(0)
    vi.spyOn(process, "getgid").mockReturnValue(0)
    const exists = fs.existsSync
    const existsMock = vi.spyOn(fs, "existsSync").mockImplementation((file) => String(file) === `${rootPath}/activation.json` ? false : exists(file))
    await runSanctuaryAuthorityRootCli(["boot"])
    await expect(runSanctuaryAuthorityRootCli(["repin-execution", digest("prlimit"), digest("setsid")])).rejects.toThrow(/not active/u)
    expect(boot).not.toHaveBeenCalled()
    existsMock.mockRestore()
    f.write(`${rootPath}/activation.json`, f.transaction)
    const lstat = fs.lstatSync, open = fs.openSync, read = fs.readFileSync, realpath = fs.realpathSync, fstat = fs.fstatSync
    const mapped = (file: fs.PathLike) => String(file).startsWith(rootPath) ? f.p(String(file)) : file
    vi.spyOn(fs, "existsSync").mockImplementation((file) => exists(mapped(file)))
    vi.spyOn(fs, "lstatSync").mockImplementation(((file, options) => Object.assign(lstat(mapped(file), options), { uid: 0, gid: 0 })) as typeof fs.lstatSync)
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => open(mapped(file), flags, mode))
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd, options) => Object.assign(fstat(fd, options), { uid: 0, gid: 0 })) as typeof fs.fstatSync)
    vi.spyOn(fs, "realpathSync").mockImplementation(((file, options) => String(file).startsWith(rootPath) ? file : realpath(file, options)) as typeof fs.realpathSync)
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, options) => read(typeof file === "number" ? file : mapped(file), options)) as typeof fs.readFileSync)
    await runSanctuaryAuthorityRootCli(["boot"])
    expect(boot).toHaveBeenCalledOnce()
    const write = vi.fn()
    await runSanctuaryAuthorityRootCli(["repin-execution", digest("prlimit"), digest("setsid")], write)
    expect(repin).toHaveBeenCalledWith(digest("prlimit"), digest("setsid"))
    expect(write).toHaveBeenCalledWith('{"repinned":true,"gatewayRestartRequired":true}\n')
    expect(sessions.withSessionTurnLease).toHaveBeenCalledWith("/boot/config/custom/ouro-butler/docker-man-template-transaction.json", expect.any(Function), { timeoutMs: 0, confinementRoot: "/boot/config/custom/ouro-butler" })
  })
  it("preserves unrelated running containers and refuses rollback before the token and health are restored", async () => {
    const f = await preparedFixture()
    const original = host.exec.getMockImplementation()!
    host.exec.mockImplementation((file, args, options) => {
      if (args[0] === "ps") return `${original(file, args, options)}{"Names":"unrelated"}\n`
      if (args[0] === "inspect" && args[1] === "unrelated") return JSON.stringify([{ Name: "/unrelated", Mounts: [{ Source: "/unrelated" }] }])
      return original(file, args, options)
    })
    await f.lifecycle.effect("freeze-resident").apply()
    await expect(f.lifecycle.effect("rollback:restore-resident").apply()).rejects.toThrow(/incomplete/u)
    await expect(f.lifecycle.effect("rollback:verify-rollback").apply()).rejects.toThrow(/readback/u)
    f.publish()
    f.createTarget()
    await f.lifecycle.effect("configure-resident").apply()
    await f.lifecycle.effect("start-resident").apply()
    await f.lifecycle.effect("start-resident").apply()
    expect(host.exec.mock.calls.filter((call) => call[1][0] === "start")).toHaveLength(1)
  })
  it("refuses re-enable until the predecessor epoch is retired and handed off", async () => {
    const f = await preparedFixture()
    f.request.epochId = "second-epoch"
    f.write(`${rootPath}/request.json`, f.request)
    const next = new SanctuaryAuthorityRootLifecycle(f.transaction, f.rootOptions)
    await expect(next.effect("freeze-resident").apply()).rejects.toThrow(/previous epoch/u)
  })
  it("does not accept a wrong vault snapshot or an unpersisted restoration as a successful token handoff", async () => {
    const f = await preparedFixture()
    for (const step of rollbackSteps.slice(0, 5)) await f.lifecycle.effect(`rollback:${step}`).apply()
    const original = host.exec.getMockImplementation()!
    alterDocker((args, value) => vaultOp(args) === "snapshot" ? value.replace(/"token":"[^"]*"/u, '"token":"123:wrongTokenabcdefghijklmnopqrstuvwxyz"') : value)
    await expect(f.lifecycle.effect("rollback:restore-token-cursor").apply()).rejects.toThrow(/readback/u)
    host.exec.mockImplementation(original)
    await f.lifecycle.effect("rollback:restore-token-cursor").apply()
    fs.unlinkSync(f.p(`${f.epochRoot}/restored.json`))
    alterDocker((args, value) => vaultOp(args) === "snapshot" ? value.replace(/"token":"[^"]*"/u, '"token":"123:wrongTokenabcdefghijklmnopqrstuvwxyz"') : value)
    await expect(f.lifecycle.effect("rollback:restore-token-cursor").apply()).rejects.toThrow(/identity/u)
  })
  it.each([...installSteps, ...rollbackSteps.map((step) => `rollback:${step}`)])("recovers the concrete %s side effect after interruption without a second mutation", async (interrupted) => {
    const f = await preparedFixture()
    const tx = await transactionFixture(f)
    tx.module.beginDockerManAuthorityHandoff(f.lifecycle.plan(), tx.options)
    let lifecycle = f.lifecycle
    for (const name of [...installSteps, ...rollbackSteps.map((step) => `rollback:${step}`)]) {
      if (name === "configure-resident") f.createTarget()
      if (name === "rollback:freeze-resident") {
        await tx.module.beginDockerManAuthorityRollback(async () => null, tx.options)
        // Model root retirement signals without signalling a host process.
        vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
          if (signal === "SIGUSR2") {
            f.write(`${f.epochRoot}/retirement.json`, { schemaVersion: 1, keyId: f.epoch.epochId, publicKeyDigest: f.epoch.publicKeyDigest, cursor: 91, quiescent: true })
            fs.rmSync(f.p("/proc/45678"), { recursive: true })
          }
          return true
        })
      }
      if (name === "rollback:restore-resident") f.createRollback()
      const effect = lifecycle.effect(name)
      if (name !== interrupted) { await tx.module.runDockerManAuthorityEffect(name, effect, tx.options); continue }
      const apply = vi.fn(async () => { await effect.apply(); throw new Error("crash after concrete effect") })
      // Initial preparation already materialized the first five effects.
      if (await effect.readback() === effect.afterDigest) {
        await tx.module.runDockerManAuthorityEffect(name, effect, tx.options)
        expect(apply).not.toHaveBeenCalled()
      } else {
        await expect(tx.module.runDockerManAuthorityEffect(name, { ...effect, apply }, tx.options)).rejects.toThrow("crash after concrete effect")
        expect(JSON.parse(fs.readFileSync(tx.journalPath, "utf8")).authority.pending.step).toBe(name.replace("rollback:", ""))
        lifecycle = new SanctuaryAuthorityRootLifecycle(f.transaction, f.rootOptions)
        await tx.module.runDockerManAuthorityEffect(name, { ...lifecycle.effect(name), apply }, tx.options)
        expect(apply).toHaveBeenCalledOnce()
      }
    }
    expect(JSON.parse(fs.readFileSync(tx.journalPath, "utf8")).authority.state).toBe("retired")
    expect(fs.existsSync(f.p(`${f.epochRoot}/current-token`))).toBe(false)
    expect(fs.existsSync(f.p(`${rootPath}/activation.json`))).toBe(false)
  })
  it.each(["freeze-resident", "stage-authority", "verify-token-rotation", "transfer-cursor", "remove-resident-token"])("recovers interruption of initial concrete %s, including partial durable writes", async (interrupted) => {
    const f = fixture()
    const lifecycle = f.staged()
    const tx = await transactionFixture(f)
    tx.module.beginDockerManAuthorityHandoff(lifecycle.plan(), tx.options)
    f.write(`${rootPath}/incoming-token`, "123:newTokenabcdefghijklmnopqrstuvwxyz")
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("oldToken") ? { ok: false } : { ok: true, result: { id: 123 } }), { status: String(url).includes("oldToken") ? 401 : 200 }))
    for (const name of installSteps.slice(0, 5)) {
      const effect = lifecycle.effect(name)
      if (name !== interrupted) { await tx.module.runDockerManAuthorityEffect(name, effect, tx.options); continue }
      const apply = vi.fn(async () => { await effect.apply(); throw new Error("crash after concrete effect") })
      await expect(tx.module.runDockerManAuthorityEffect(name, { ...effect, apply }, tx.options)).rejects.toThrow("crash after concrete effect")
      const restarted = new SanctuaryAuthorityRootLifecycle(f.transaction, f.rootOptions)
      await tx.module.runDockerManAuthorityEffect(name, { ...restarted.effect(name), apply }, tx.options)
      expect(apply).toHaveBeenCalledOnce()
    }
  })
  it.each(installSteps.slice(0, 5))("can retire an installation interrupted before %s without starting any ingress", async (interrupted) => {
    const f = fixture()
    const lifecycle = f.staged()
    f.write(`${rootPath}/incoming-token`, "123:newTokenabcdefghijklmnopqrstuvwxyz")
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("oldToken") ? { ok: false } : { ok: true, result: { id: 123 } }), { status: String(url).includes("oldToken") ? 401 : 200 }))
    for (const name of installSteps.slice(0, installSteps.indexOf(interrupted))) await lifecycle.effect(name).apply()
    for (const step of rollbackSteps.slice(0, 6)) await lifecycle.effect(`rollback:${step}`).apply()
    expect(host.spawn).not.toHaveBeenCalled()
    expect(host.exec.mock.calls.some((call) => call[1][0] === "start")).toBe(false)
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/epochs/fixture-epoch/epoch.json`), "utf8")).state).toBe("retired")
  })
  it("refuses unsafe request, root and immutable image identities", () => {
    const f = fixture()
    for (const transaction of [{ ...f.transaction, targetImageId: "bad" }, { ...f.transaction, rollbackImageId: f.transaction.targetImageId }]) {
      expect(() => new SanctuaryAuthorityRootLifecycle(transaction, f.rootOptions)).toThrow(/image/u)
    }
    expect(() => new SanctuaryAuthorityRootLifecycle(f.transaction, { ...f.rootOptions, expectedUid: process.getuid!() + 1 })).toThrow(/root/u)
    expect(() => new SanctuaryAuthorityRootLifecycle(f.transaction, { ...f.rootOptions, expectedGid: process.getgid!() + 1 })).toThrow(/root/u)
    for (const request of [null, {}, { ...f.request, epochId: "" }, { ...f.request, ownerChatId: "43" }, { ...f.request, botId: 123 }, { ...f.request, nodeDigest: "bad" }]) {
      f.write(`${rootPath}/request.json`, request)
      expect(() => new SanctuaryAuthorityRootLifecycle(f.transaction, f.rootOptions)).toThrow(/request/u)
    }
    f.write(`${rootPath}/request.json`, f.request)
    fs.chmodSync(f.p(`${rootPath}/request.json`), 0o644)
    expect(() => new SanctuaryAuthorityRootLifecycle(f.transaction, f.rootOptions)).toThrow(/private/u)
  })
  it("rejects changed images, predecessor identity, cursor and migration records on a frozen retry", async () => {
    const f = fixture()
    const original = host.exec.getMockImplementation()!
    alterDocker((args, value) => args[0] === "inspect" ? value.replace(digest("old-image"), digest("unknown-image")) : value)
    await expect(f.lifecycle.effect("freeze-resident").apply()).rejects.toThrow(/image/u)
    host.exec.mockImplementation(original)
    alterDocker((args, value) => vaultOp(args) === "snapshot" ? value.replace('"42"', '"43"') : value)
    await expect(f.lifecycle.effect("freeze-resident").apply()).rejects.toThrow(/identity/u)
    host.exec.mockImplementation(original)
    await f.lifecycle.effect("freeze-resident").apply()
    const file = `${rootPath}/epochs/fixture-epoch/migration.json`
    const migration = JSON.parse(fs.readFileSync(f.p(file), "utf8"))
    f.write(file, { ...migration, predecessorCursor: -1 })
    await expect(f.lifecycle.effect("freeze-resident").apply()).rejects.toThrow(/cursor/u)
    f.write(file, { ...migration, botId: "999" })
    await expect(f.lifecycle.effect("freeze-resident").readback()).rejects.toThrow(/identity/u)
  })
  it("refuses a resident which fails to stop, and a token removal attempted while running", async () => {
    const f = fixture()
    await expect(f.lifecycle.effect("remove-resident-token").apply()).rejects.toThrow(/stopped/u)
    alterDocker((args, value) => args[0] === "inspect" ? value.replace('"Running":false', '"Running":true') : value)
    await expect(f.lifecycle.effect("freeze-resident").apply()).rejects.toThrow(/did not stop/u)
  })
  it("requires all handoff prerequisites and validates presence readback", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    await expect(lifecycle.effect("verify-token-rotation").apply()).rejects.toThrow(/frozen/u)
    await expect(lifecycle.effect("transfer-cursor").apply()).rejects.toThrow(/ready/u)
    expect(await lifecycle.boot()).toBe(false)
    for (const step of ["verify-install", "configure-resident", "rollback:verify-rollback"]) expect(await lifecycle.effect(step).readback()).toBe(lifecycle.effect(step).beforeDigest)
    await expect(lifecycle.effect("start-resident").apply()).rejects.toThrow(/ready/u)
    await expect(lifecycle.effect("verify-install").apply()).rejects.toThrow(/readback/u)
    alterDocker((args, value) => vaultOp(args) === "presence" ? '{"tokenPresent":"false"}' : value)
    await expect(lifecycle.effect("remove-resident-token").readback()).rejects.toThrow(/presence/u)
  })
  it("keeps the gateway's own output in a capped root-only log instead of discarding it (D-036)", async () => {
    const f = await preparedFixture()
    await f.lifecycle.effect("start-gateway").apply()
    const options = host.spawn.mock.calls.at(-1)![2] as { stdio: [string, number, number] }
    expect(options.stdio[0]).toBe("ignore")
    expect(options.stdio[1]).toBe(options.stdio[2])
    const log = f.p(`${rootPath}/gateway.log`)
    expect(fs.statSync(log).mode & 0o777).toBe(0o600)
    fs.writeFileSync(log, "x".repeat(5 * 1024 * 1024 + 1))
    fs.rmSync(f.p("/proc/45678"), { recursive: true })
    await f.lifecycle.effect("start-gateway").apply()
    expect(fs.statSync(`${log}.1`).size).toBe(5 * 1024 * 1024 + 1)
    expect(fs.statSync(log).size).toBe(0)
  })

  it("accepts the host keeper as the boot owner and refuses two owners (D-045)", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    await lifecycle.effect("freeze-resident").apply()
    const keeper = `#!/bin/sh\n${SANCTUARY_KEEPER_BOOT_LINES.supervisor}\n${SANCTUARY_KEEPER_BOOT_LINES.watchdog}\n`
    f.write("/boot/config/go", keeper)
    await lifecycle.effect("stage-authority").apply()
    expect(fs.readFileSync(f.p("/boot/config/go"), "utf8")).toBe(keeper)
    expect(await lifecycle.effect("stage-authority").readback()).toBe(lifecycle.effect("stage-authority").afterDigest)
    f.write("/boot/config/go", `${keeper}/bin/sh /boot/config/custom/ouro-authority/start.sh --boot & # ouro-authority\n`)
    await expect(lifecycle.effect("stage-authority").readback()).rejects.toThrow(/boot/u)
  })

  it("names the keeper boot lines exactly as the upgrade orchestrator writes them", () => {
    const source = fs.readFileSync("deploy/unraid/sanctuary-butler-upgrade.mjs", "utf8")
    const custom = source.match(/const AUTHORITY_CUSTOM = "([^"]+)"/u)![1]
    const supervisor = `${custom}/gateway-supervisor.sh`
    const watchdog = `${custom}/gateway-keeper-watchdog.sh`
    const cron = source.match(/const WATCHDOG_CRON = `([^`]+)`/u)![1].replace("${GATEWAY_WATCHDOG}", watchdog)
    const written = [...source.matchAll(/g \+= `([^`]+)\\n`/gu)].map((match) => match[1]!.replace("${GATEWAY_SUPERVISOR}", supervisor).replace("${WATCHDOG_CRON}", cron))
    expect(written).toEqual([SANCTUARY_KEEPER_BOOT_LINES.supervisor, SANCTUARY_KEEPER_BOOT_LINES.watchdog])
  })

  it("rejects changed boot ownership, host primitive pins, and conflicting installed bytes", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    await lifecycle.effect("freeze-resident").apply()
    f.write("/usr/bin/prlimit", "changed")
    await expect(lifecycle.effect("stage-authority").apply()).rejects.toThrow(/primitive/u)
    f.write("/usr/bin/prlimit", "prlimit")
    f.write("/boot/config/go", "#!/bin/sh\n# unknown ouro-authority hook\n")
    await expect(lifecycle.effect("stage-authority").apply()).rejects.toThrow(/ambiguous/u)
    f.write("/boot/config/go", "#!/bin/sh")
    await lifecycle.effect("stage-authority").apply()
    f.write("/boot/config/go", "#!/bin/sh\n")
    await expect(lifecycle.effect("stage-authority").readback()).rejects.toThrow(/boot/u)
    f.write(`${rootPath}/package/deploy/unraid/sanctuary-authority-service.sh`, "conflict")
    await expect(lifecycle.effect("stage-authority").apply()).rejects.toThrow(/conflicts/u)
  })
  it("adds missing cgroup controllers without replacing enabled unrelated controllers", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    await lifecycle.effect("freeze-resident").apply()
    f.write("/sys/fs/cgroup/cgroup.subtree_control", "io")
    await lifecycle.effect("stage-authority").apply()
    expect(fs.readFileSync(f.p("/sys/fs/cgroup/cgroup.subtree_control"), "utf8")).toBe("+cpu +memory +pids")
  })
  it("rejects unsafe temporary files and parents without deleting another owner's file", async () => {
    const f = fixture()
    const token = `${rootPath}/epochs/fixture-epoch/previous-token`
    f.write(`${token}.tmp`, "unrelated")
    fs.chmodSync(f.p(`${token}.tmp`), 0o644)
    await expect(f.lifecycle.effect("freeze-resident").apply()).rejects.toThrow(/temporary/u)
    expect(fs.readFileSync(f.p(`${token}.tmp`), "utf8")).toBe("unrelated")
    fs.chmodSync(path.dirname(f.p(token)), 0o755)
    await expect(f.lifecycle.effect("freeze-resident").apply()).rejects.toThrow(/parent/u)
  })
  it("removes only its own secret temporary after failed publication and retries the fenced handoff", async () => {
    const f = fixture()
    const rename = fs.renameSync
    const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("/previous-token")) throw new Error("publication interrupted")
      return rename(from, to)
    })
    await expect(f.lifecycle.effect("freeze-resident").apply()).rejects.toThrow("publication interrupted")
    expect(fs.existsSync(f.p(`${rootPath}/epochs/fixture-epoch/previous-token.tmp`))).toBe(false)
    fault.mockRestore()
    await f.lifecycle.effect("freeze-resident").apply()
    expect(await f.lifecycle.effect("freeze-resident").readback()).toBe(f.lifecycle.effect("freeze-resident").afterDigest)
  })
    it.each(["missing", "invalid", "dead", "foreign", "readiness", "signed"])("refuses %s gateway readiness without starting the resident", async (kind) => {
      const f = await preparedFixture()
      const effect = f.lifecycle.effect("start-gateway")
      expect(await effect.readback()).toBe(effect.beforeDigest)
      f.publish()
      if (kind === "missing") fs.unlinkSync(f.p(`${f.epochRoot}/authority.lock`))
      if (kind === "invalid") f.write(`${f.epochRoot}/authority.lock`, "invalid")
      if (kind === "dead") fs.rmSync(f.p("/proc/45678"), { recursive: true })
      if (kind === "foreign") f.write("/proc/45678/cmdline", "unrelated")
      if (kind === "readiness") f.write(`${f.epochRoot}/readiness.json`, { status: "ready", botId: "999" })
      if (kind === "signed") host.cursor.mockResolvedValue({ keyId: "substituted" })
      await expect(effect.readback()).rejects.toThrow(/process|readiness|lock/u)
      expect(host.exec.mock.calls.some((call) => call[1][0] === "start")).toBe(false)
    })
    it("surfaces spawn failure and bounded absent-gateway timeout without resident startup", async () => {
      const f = await preparedFixture()
      host.spawn.mockImplementation(() => ({ unref: vi.fn(), once: (_event: string, listener: () => void) => { listener() } }))
      await expect(f.lifecycle.effect("start-gateway").apply()).rejects.toThrow(/launch/u)
      vi.useFakeTimers()
      host.spawn.mockImplementation(() => ({ unref: vi.fn(), once: vi.fn() }))
      const pending = f.lifecycle.effect("start-gateway").apply()
      const failure = expect(pending).rejects.toThrow(/timed out/u)
      // Readiness has a 15-minute budget: a cold Unraid page cache makes the gateway's
      // package verification take minutes.
      await vi.advanceTimersByTimeAsync(900_100)
      await failure
      expect(host.exec.mock.calls.some((call) => call[1][0] === "start")).toBe(false)
    })
    it("adopts one already-live gateway and refuses changed token custody before starting another", async () => {
      const f = await preparedFixture()
      f.publish()
      await f.lifecycle.effect("start-gateway").apply()
      expect(host.spawn).not.toHaveBeenCalled()
      alterDocker((args, value) => vaultOp(args) === "presence" ? '{"tokenPresent":true}' : value)
      await expect(f.lifecycle.effect("start-gateway").apply()).rejects.toThrow(/custody/u)
    })
    it("validates epoch and exact transferred cursor rather than trusting files", async () => {
      const f = await preparedFixture()
      const migrationFile = `${f.epochRoot}/migration.json`
      const migration = JSON.parse(fs.readFileSync(f.p(migrationFile), "utf8"))
      f.write(migrationFile, { ...migration, predecessorCursor: 88 })
      await expect(f.lifecycle.effect("verify-token-rotation").readback()).rejects.toThrow(/epoch identity/u)
      f.write(migrationFile, migration)
      const { FileSanctuaryTelegramAuthorityGateway } = await import("../../../heart/daemon/sanctuary-telegram-authority-gateway")
      vi.spyOn(FileSanctuaryTelegramAuthorityGateway.prototype, "cursor").mockReturnValue(88)
      await expect(f.lifecycle.effect("transfer-cursor").readback()).rejects.toThrow(/cursor/u)
    })
    it.each(["autostart", "autostart-mode", "mount", "token", "rollback", "unhealthy"])("blocks installation activation for %s", async (kind) => {
      const f = await preparedFixture()
      f.publish()
      f.createTarget()
      if (kind === "autostart") f.write("/var/lib/docker/unraid-autostart", "ouro-butler 0\njellyfin 0\n")
      if (kind === "autostart-mode") fs.chmodSync(f.p("/var/lib/docker/unraid-autostart"), 0o666)
      if (kind === "mount") alterDocker((args, value) => args[0] === "inspect" ? value.replace('"RW":false', '"RW":true') : value)
      if (kind === "token") alterDocker((args, value) => args[0] === "inspect" ? value.replace('"Env":[]', '"Env":["TELEGRAM_BOT_TOKEN=forbidden"]') : value)
      if (["autostart", "autostart-mode", "mount", "token"].includes(kind)) {
        await expect(f.lifecycle.effect("configure-resident").apply()).rejects.toThrow()
        return
      }
      await f.lifecycle.effect("configure-resident").apply()
      if (kind === "rollback") alterDocker((args, value) => {
        if (args[0] === "inspect") { const list = JSON.parse(value); list.push({ ...list[0], Name: "/ouro-butler-rollback", State: { Running: true } }); return JSON.stringify(list) }
        return value
      })
      if (kind === "unhealthy") {
        f.setRunning(true)
        alterDocker((args, value) => args[0] === "inspect" ? value.replace('"healthy"', '"unhealthy"') : value)
        await expect(f.lifecycle.effect("verify-install").apply()).rejects.toThrow(/readback/u)
      } else await expect(f.lifecycle.effect("start-resident").apply()).rejects.toThrow(/rollback/u)
    })
    it("refuses boot during a pending transaction and a rollback epoch without touching Docker", async () => {
      const f = await preparedFixture()
      f.write(`${rootPath}/activation.json`, { ...f.transaction, state: "active", epochId: f.request.epochId })
      f.write("/boot/config/custom/ouro-butler/docker-man-template-transaction.json", "{}")
      await expect(f.lifecycle.boot()).rejects.toThrow(/recovery/u)
      fs.unlinkSync(f.p("/boot/config/custom/ouro-butler/docker-man-template-transaction.json"))
      f.createTarget()
      alterDocker((args, value) => {
        if (args[0] === "inspect") { const list = JSON.parse(value); list.push({ ...list[0], Name: "/ouro-butler-rollback", State: { Running: true } }); return JSON.stringify(list) }
        return value
      })
      await expect(f.lifecycle.boot()).rejects.toThrow(/rollback/u)
    })
    it("retires a live gateway, waits for exact cleanup, and stops only its bound PID", async () => {
      const f = await preparedFixture()
      f.publish()
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect(pid).toBe(45678)
        if (signal === "SIGUSR2") f.write(`${f.epochRoot}/retirement.json`, { schemaVersion: 1, keyId: f.epoch.epochId, publicKeyDigest: f.epoch.publicKeyDigest, quiescent: true, cursor: 91 })
        if (signal === "SIGTERM") fs.rmSync(f.p("/proc/45678"), { recursive: true })
        return true
      })
      await expect(f.lifecycle.effect("rollback:stop-gateway").apply()).rejects.toThrow(/retire/u)
      await f.lifecycle.effect("rollback:retire-registrations").apply()
      await expect(f.lifecycle.effect("rollback:end-epoch").apply()).rejects.toThrow(/stop/u)
      await f.lifecycle.effect("rollback:stop-gateway").apply()
      await f.lifecycle.effect("rollback:end-epoch").apply()
      expect(kill.mock.calls).toEqual([[45678, "SIGUSR2"], [45678, "SIGTERM"]])
      await expect(f.lifecycle.effect("verify-token-rotation").readback()).rejects.toThrow(/retired/u)
    })
    it("refuses incomplete or changed retirement and offline reconciliation failure", async () => {
      const f = await preparedFixture()
      await expect(f.lifecycle.effect("rollback:end-epoch").apply()).rejects.toThrow(/retire/u)
      f.write(`${f.epochRoot}/retirement.json`, { schemaVersion: 1, keyId: f.epoch.epochId, publicKeyDigest: f.epoch.publicKeyDigest, quiescent: true, cursor: 91 })
      fs.mkdirSync(f.p("/sys/fs/cgroup/ouro-authority/live-attempt"), { mode: 0o700 })
      await expect(f.lifecycle.effect("rollback:retire-registrations").readback()).rejects.toThrow(/cleanup/u)
      fs.rmdirSync(f.p("/sys/fs/cgroup/ouro-authority/live-attempt"))
      fs.unlinkSync(f.p(`${f.epochRoot}/retirement.json`))
      const original = host.exec.getMockImplementation()!
      host.exec.mockImplementation((file, args, options) => args.includes("--retire-only") ? "" : original(file, args, options))
      await expect(f.lifecycle.effect("rollback:retire-registrations").apply()).rejects.toThrow(/readback/u)
    })
    it("recovers an interrupted token handoff after root-token unlink and rejects changed custody", async () => {
      const f = await preparedFixture()
      for (const step of rollbackSteps.slice(0, 5)) await f.lifecycle.effect(`rollback:${step}`).apply()
      const restored = f.lifecycle.effect("rollback:restore-token-cursor")
      await restored.apply()
      await restored.apply()
      fs.unlinkSync(f.p(`${f.epochRoot}/restored.json`))
      await restored.apply()
      expect(await restored.readback()).toBe(restored.afterDigest)
      f.write(`${rootPath}/incoming-token`, "123:differentTokenabcdefghijklmnopqrstuvwxyz")
      await expect(restored.apply()).rejects.toThrow(/incoming token/u)
      fs.unlinkSync(f.p(`${rootPath}/incoming-token`))
      f.createTarget()
      await expect(f.lifecycle.effect("rollback:verify-rollback").apply()).rejects.toThrow(/rollback/u)
      f.createRollback()
      await f.lifecycle.effect("rollback:restore-resident").apply()
      await f.lifecycle.effect("rollback:restore-resident").apply()
      await f.lifecycle.effect("rollback:verify-rollback").apply()
      expect(await f.lifecycle.effect("rollback:verify-rollback").readback()).toBe(f.lifecycle.effect("rollback:verify-rollback").afterDigest)
    })
  it.each(["stage.json", "configured.json", "activation.json"])("rejects changed %s metadata instead of trusting a marker's existence", async (marker) => {
    const f = await preparedFixture()
    await f.lifecycle.effect("start-gateway").apply()
    f.createTarget()
    for (const step of ["configure-resident", "start-resident", "verify-install"]) await f.lifecycle.effect(step).apply()
    const file = marker === "activation.json" ? `${rootPath}/${marker}` : `${f.epochRoot}/${marker}`
    f.write(file, { ...JSON.parse(fs.readFileSync(f.p(file), "utf8")), targetImageId: digest("substitution") })
    const step = marker === "stage.json" ? "stage-authority" : marker === "configured.json" ? "configure-resident" : "verify-install"
    await expect(f.lifecycle.effect(step).readback()).rejects.toThrow(/identity|record/u)
  })
  it("rejects mode drift in installed package files instead of chmod-repairing them", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    await lifecycle.effect("freeze-resident").apply()
    await lifecycle.effect("stage-authority").apply()
    const file = f.p(`${rootPath}/package/deploy/unraid/sanctuary-authority-service.sh`)
    fs.chmodSync(file, 0o777)
    await expect(lifecycle.effect("stage-authority").apply()).rejects.toThrow(/unsafe/u)
    expect(fs.statSync(file).mode & 0o777).toBe(0o777)
  })
  it("refuses a hash-correct package missing the lifecycle executable", async () => {
    const f = fixture()
    f.staged()
    const name = "dist/heart/daemon/sanctuary-authority-root-lifecycle.js"
    const manifest = JSON.parse(fs.readFileSync(f.p(`${rootPath}/package-manifest.json`), "utf8"))
    delete manifest.files[name]
    fs.unlinkSync(f.p(`${rootPath}/incoming-package/${name}`))
    f.request.packageDigest = digest(JSON.stringify(manifest))
    f.write(`${rootPath}/package-manifest.json`, manifest)
    f.write(`${rootPath}/request.json`, f.request)
    const lifecycle = new SanctuaryAuthorityRootLifecycle(f.transaction, f.rootOptions)
    await lifecycle.effect("freeze-resident").apply()
    await expect(lifecycle.effect("stage-authority").apply()).rejects.toThrow(/program/u)
  })
  it("starts only the gateway on two cold boots with delayed readiness, leaving tokenless Docker recovery and autostart untouched", async () => {
    const f = await preparedFixture()
    await f.lifecycle.effect("start-gateway").apply()
    f.createTarget()
    for (const step of ["configure-resident", "start-resident", "verify-install"]) await f.lifecycle.effect(step).apply()
    f.write("/var/lib/docker/unraid-autostart", "jellyfin 0\nouro-butler 0\nunrelated 5\n")
    vi.useFakeTimers()
    for (let cycle = 0; cycle < 2; cycle++) {
      fs.rmSync(f.p("/proc/45678"), { recursive: true })
      // Persistent readiness is stale after a cold boot; /run is empty.
      host.spawn.mockImplementation(() => { setTimeout(f.publish, 300); return { unref: vi.fn(), once: vi.fn() } })
      host.exec.mockClear()
      host.cursor.mockClear()
      const boot = f.lifecycle.boot()
      await vi.advanceTimersByTimeAsync(200)
      expect(host.cursor).not.toHaveBeenCalled()
      expect(host.exec.mock.calls.some((call) => ["start", "stop", "update"].includes(call[1][0]))).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      await expect(boot).resolves.toBe(true)
      expect(host.exec.mock.calls.some((call) => ["start", "stop", "update"].includes(call[1][0]))).toBe(false)
      expect(fs.readFileSync(f.p("/var/lib/docker/unraid-autostart"), "utf8")).toBe("jellyfin 0\nouro-butler 0\nunrelated 5\n")
    }
  })
  it("requires a fresh issuer/token epoch after rollback and preserves the retired epoch history", async () => {
    const f = await preparedFixture()
    for (const step of ["freeze-resident", "retire-registrations", "reconcile-executions", "stop-gateway", "end-epoch", "restore-token-cursor"]) await f.lifecycle.effect(`rollback:${step}`).apply()
    const previousEpoch = fs.readFileSync(f.p(`${f.epochRoot}/epoch.json`), "utf8")
    const previousKey = fs.readFileSync(f.p(`${f.epochRoot}/issuer.pem`), "utf8")
    f.request.epochId = "second-epoch"
    f.write(`${rootPath}/request.json`, f.request)
    f.write(`${rootPath}/incoming-token`, "123:thirdTokenabcdefghijklmnopqrstuvwxyz")
    vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("newToken") ? { ok: false } : { ok: true, result: { id: 123 } }), { status: String(url).includes("newToken") ? 401 : 200 }))
    const lifecycle = new SanctuaryAuthorityRootLifecycle(f.transaction, f.rootOptions)
    for (const step of ["freeze-resident", "stage-authority", "verify-token-rotation", "transfer-cursor", "remove-resident-token"]) {
      const effect = lifecycle.effect(step)
      expect(await effect.readback()).toBe(effect.beforeDigest)
      await effect.apply()
      expect(await effect.readback()).toBe(effect.afterDigest)
    }
    const epoch = JSON.parse(fs.readFileSync(f.p(`${rootPath}/epochs/second-epoch/epoch.json`), "utf8"))
    expect(epoch).toMatchObject({ state: "prepared", predecessorCursor: 91 })
    expect(epoch.publicKeyDigest).not.toBe(f.epoch.publicKeyDigest)
    expect(epoch.tokenDigest).not.toBe(f.epoch.tokenDigest)
    expect(fs.readFileSync(f.p(`${f.epochRoot}/epoch.json`), "utf8")).toBe(previousEpoch)
    expect(fs.readFileSync(f.p(`${f.epochRoot}/issuer.pem`), "utf8")).toBe(previousKey)
  })
  it("refuses mutable root ownership instead of repairing it", () => {
    const f = fixture()
    fs.chmodSync(f.p(rootPath), 0o770)
    expect(() => new SanctuaryAuthorityRootLifecycle(f.transaction, f.rootOptions)).toThrow(/directory/u)
    expect(fs.statSync(f.p(rootPath)).mode & 0o777).toBe(0o770)
  })
  it("binds its plan to root-only same-bot coordinates and the reviewed package", () => {
    const f = fixture()
    expect(f.lifecycle.plan()).toEqual({
      schemaVersion: 1, epochId: "fixture-epoch", botId: "123", ownerUserId: "42", ownerChatId: "42",
      packageDigest: digest("manifest"), publicKeyDigest: null, predecessorContract: "canonical-pre-gateway", targetContract: "canonical-gateway",
    })
  })
  it("stops the exact resident before the private vault snapshot and transfers the exact offset without touching history", async () => {
    const f = fixture()
    f.write(`${bundle}/policy.json`, "preserved")
    f.write(`${bundle}/state/history.json`, "preserved-history")
    const effect = f.lifecycle.effect("freeze-resident")
    expect(await effect.readback()).toBe(effect.beforeDigest)
    await effect.apply()
    expect(await effect.readback()).toBe(effect.afterDigest)
    const calls = host.exec.mock.calls.map((call) => call[1][0])
    expect(calls.indexOf("stop")).toBeLessThan(calls.indexOf("run"))
    const vaultArgs = host.exec.mock.calls.find((call) => call[1][0] === "run")![1] as string[]
    expect(vaultArgs).toContain(`type=bind,src=${bundle},dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly`)
    expect(vaultArgs).toContain("/home/ouro/.ouro-cli/bitwarden:rw,nosuid,nodev,noexec,mode=0700")
    // D-018: a bare cap-dropped root cannot read the resident-owned credential
    // files. The fenced read restores exactly CAP_DAC_OVERRIDE and copies the
    // read-only bitwarden data into a writable tmpfs before running the CLI.
    expect(vaultArgs).toContain("--cap-drop=ALL")
    expect(vaultArgs).toContain("--cap-add=DAC_OVERRIDE")
    expect(vaultArgs).toContain(`type=bind,src=${runtime}/bitwarden,dst=/home/ouro/.bw-src,readonly`)
    expect(vaultArgs.at(-1)).toMatch(/^cp -r \/home\/ouro\/\.bw-src\/\. \/home\/ouro\/\.ouro-cli\/bitwarden\/ && exec \/usr\/local\/bin\/node \S+ vault snapshot$/u)
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/epochs/fixture-epoch/migration.json`), "utf8"))).toMatchObject({ predecessorCursor: 87, botId: "123" })
    expect(fs.readFileSync(f.p(`${rootPath}/epochs/fixture-epoch/previous-token`), "utf8")).toBe(oldToken)
    expect(fs.readFileSync(f.p(`${bundle}/policy.json`), "utf8")).toBe("preserved")
    expect(fs.readFileSync(f.p(`${bundle}/state/history.json`), "utf8")).toBe("preserved-history")
    expect(fs.readFileSync(f.p(`${rootPath}/epochs/fixture-epoch/migration.json`), "utf8")).not.toContain(oldToken)
    host.exec.mockClear()
    expect(await effect.readback()).toBe(effect.afterDigest)
    expect(host.exec.mock.calls.some((call) => call[1][0] === "run")).toBe(false)
  })
  it("persists vault writes: remove-resident-token binds the real store writable, never a throwaway copy (D-021)", async () => {
    await preparedFixture()
    // snapshot/presence are reads (copied into a tmpfs); remove is a write whose
    // whole point is to change the vault, so it must bind the real store writable.
    // Copying to tmpfs here silently discards the removal and fails the readback.
    const runArgs = host.exec.mock.calls.find((call) => call[1][0] === "run" && String((call[1] as string[]).at(-1)).endsWith("vault remove"))![1] as string[]
    expect(runArgs).toContain(`type=bind,src=${runtime}/bitwarden,dst=/home/ouro/.ouro-cli/bitwarden`)
    expect(runArgs).not.toContain(`type=bind,src=${runtime}/bitwarden,dst=/home/ouro/.bw-src,readonly`)
    expect(runArgs).not.toContain("/home/ouro/.ouro-cli/bitwarden:rw,nosuid,nodev,noexec,mode=0700")
    expect(runArgs).toContain("--cap-add=DAC_OVERRIDE")
    expect(String(runArgs.at(-1))).toMatch(/^exec \/usr\/local\/bin\/node \S+ vault remove$/u)
  })
  it("refuses an unrelated direct poller sharing the resident bundle without stopping it", async () => {
    const f = fixture()
    host.exec.mockImplementation((_file, args) => args[0] === "ps" ? '{"Names":"rogue"}\n' : JSON.stringify([{ Name: "/rogue", State: { Running: true }, Mounts: [{ Source: bundle }] }]))
    await expect(f.lifecycle.effect("freeze-resident").apply()).rejects.toThrow(/poller/u)
    expect(host.exec.mock.calls.some((call) => call[1][0] === "stop")).toBe(false)
  })
  it("refuses unsafe requests, changed bot identity, corrupt cursor and unknown effects", async () => {
    const f = fixture()
    expect(() => f.lifecycle.effect("arbitrary-root-command")).toThrow(/effect/u)
    f.write(`${bundle}/state/senses/telegram/offset.json`, { nextUpdateId: -1 })
    await expect(f.lifecycle.effect("freeze-resident").apply()).rejects.toThrow(/offset/u)
    expect(fs.existsSync(f.p(`${rootPath}/epochs/fixture-epoch/migration.json`))).toBe(false)
  })
  it("installs the exact package and persistent boot hook while preserving unrelated boot bytes", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    await lifecycle.effect("freeze-resident").apply()
    const effect = lifecycle.effect("stage-authority")
    expect(await effect.readback()).toBe(effect.beforeDigest)
    await effect.apply()
    expect(await effect.readback()).toBe(effect.afterDigest)
    expect(fs.readFileSync(f.p("/boot/config/go"), "utf8")).toContain("# preserve unrelated boot state\n")
    expect(fs.readFileSync(f.p("/boot/config/go"), "utf8")).toContain("/boot/config/custom/ouro-authority/start.sh")
    await effect.apply()
    expect(fs.readFileSync(f.p("/boot/config/go"), "utf8").match(/start.sh/gu)).toHaveLength(1)
    f.write(`${rootPath}/package/dist/heart/daemon/sanctuary-host-supervisor-entry.js`, "tampered")
    await expect(effect.readback()).rejects.toThrow(/metadata|digest/u)
  })
  it("refuses a pre-existing package symlink before chmod can mutate its external target", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    await lifecycle.effect("freeze-resident").apply()
    await lifecycle.effect("stage-authority").apply()
    const name = "deploy/unraid/sanctuary-authority-service.sh"
    f.write("/unrelated-file", name)
    fs.unlinkSync(f.p(`${rootPath}/package/${name}`))
    fs.symlinkSync(f.p("/unrelated-file"), f.p(`${rootPath}/package/${name}`))
    await expect(lifecycle.effect("stage-authority").apply()).rejects.toThrow()
    expect(fs.lstatSync(f.p("/unrelated-file")).mode & 0o777).toBe(0o600)
  })
  it("prepares a fresh same-bot issuer, initializes the exact cursor and writes bound root configuration", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    f.write(`${rootPath}/incoming-token`, "123:newTokenabcdefghijklmnopqrstuvwxyz")
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("oldToken") ? { ok: false } : { ok: true, result: { id: 123 } }), { status: String(url).includes("oldToken") ? 401 : 200 }))
    await lifecycle.effect("freeze-resident").apply()
    await lifecycle.effect("stage-authority").apply()
    const rotation = lifecycle.effect("verify-token-rotation")
    await rotation.apply()
    expect(await rotation.readback()).toBe(rotation.afterDigest)
    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
      `https://api.telegram.org/bot${oldToken}/getMe`,
      "https://api.telegram.org/bot123:newTokenabcdefghijklmnopqrstuvwxyz/getMe",
    ])
    const transfer = lifecycle.effect("transfer-cursor")
    await transfer.apply()
    expect(await transfer.readback()).toBe(transfer.afterDigest)
    const config = JSON.parse(fs.readFileSync(f.p(`${rootPath}/active.json`), "utf8"))
    expect(config).toMatchObject({ keyId: "fixture-epoch", botId: "123", packageManifestDigest: f.request.packageDigest })
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/epochs/fixture-epoch/epoch.json`), "utf8")).predecessorCursor).toBe(87)
    f.write(`${rootPath}/active.json`, { ...config, hostShellDigest: digest("substituted-shell") })
    await expect(transfer.readback()).rejects.toThrow(/configuration/u)
  })
  it("proves both vault owners empty and starts a pinned gateway before activating the target resident", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    f.write(`${rootPath}/incoming-token`, "123:newTokenabcdefghijklmnopqrstuvwxyz")
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("oldToken") ? { ok: false } : { ok: true, result: { id: 123 } }), { status: String(url).includes("oldToken") ? 401 : 200 }))
    for (const step of ["freeze-resident", "stage-authority", "verify-token-rotation", "transfer-cursor", "remove-resident-token"]) {
      await lifecycle.effect(step).apply()
      expect(await lifecycle.effect(step).readback()).toBe(lifecycle.effect(step).afterDigest)
    }
    const epochRoot = `${rootPath}/epochs/fixture-epoch`
    const epoch = JSON.parse(fs.readFileSync(f.p(`${epochRoot}/epoch.json`), "utf8"))
    host.cursor.mockResolvedValue({ ...lifecycle.plan(), keyId: "fixture-epoch", publicKeyDigest: epoch.publicKeyDigest, cursor: 87 })
    host.spawn.mockImplementation(() => {
      f.write(`${epochRoot}/authority.lock`, "45678")
      f.write("/proc/45678/status", `Uid:\t${process.getuid!()}\t${process.getuid!()}\t${process.getuid!()}\t${process.getuid!()}\n`)
      f.write("/proc/45678/cmdline", `${f.p("/usr/local/bin/node")}\0${f.p(`${rootPath}/package/dist/heart/daemon/sanctuary-telegram-authority-entry.js`)}\0--config\0${f.p(`${rootPath}/active.json`)}\0`)
      f.write(`${epochRoot}/readiness.json`, { status: "ready", botId: "123", publicKeyDigest: epoch.publicKeyDigest })
      return { unref: vi.fn(), once: vi.fn() }
    })
    await lifecycle.effect("start-gateway").apply()
    expect(await lifecycle.effect("start-gateway").readback()).toBe(lifecycle.effect("start-gateway").afterDigest)
    expect(host.close).toHaveBeenCalledTimes(host.cursor.mock.calls.length)
    await expect(lifecycle.effect("configure-resident").apply()).rejects.toThrow(/target/u)
    f.createTarget()
    await lifecycle.effect("configure-resident").apply()
    await lifecycle.effect("start-resident").apply()
    await lifecycle.effect("verify-install").apply()
    expect(host.exec.mock.calls.some((call) => call[1][0] === "update")).toBe(false)
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/activation.json`), "utf8"))).toMatchObject({ state: "active", epochId: "fixture-epoch" })
    expect(host.spawn).toHaveBeenCalledOnce()
    expect(host.exec.mock.calls.find((call) => call[1][0] === "start")![1]).toEqual(["start", "ouro-butler"])
    // Boot uses installed assets, not an operator's disposable extraction stage.
    fs.rmSync(f.p(`${rootPath}/incoming-package`), { recursive: true })
    fs.rmSync(f.p("/proc/45678"), { recursive: true })
    fs.unlinkSync(f.p(`${epochRoot}/authority.lock`))
    fs.unlinkSync(f.p(`${epochRoot}/readiness.json`))
    await lifecycle.boot()
    expect(host.spawn).toHaveBeenCalledTimes(2)
  })
  it("retires and reconciles before current-token/cursor handoff, then starts only the restored three-mount image", async () => {
    const f = fixture()
    const lifecycle = f.staged()
    f.write(`${rootPath}/incoming-token`, "123:newTokenabcdefghijklmnopqrstuvwxyz")
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("oldToken") ? { ok: false } : { ok: true, result: { id: 123 } }), { status: String(url).includes("oldToken") ? 401 : 200 }))
    for (const step of ["freeze-resident", "stage-authority", "verify-token-rotation", "transfer-cursor", "remove-resident-token"]) await lifecycle.effect(step).apply()
    await expect(lifecycle.effect("rollback:restore-token-cursor").apply()).rejects.toThrow(/retire/u)
    f.createTarget()
    for (const step of ["freeze-resident", "retire-registrations", "reconcile-executions", "stop-gateway", "end-epoch", "restore-token-cursor"]) {
      const effect = lifecycle.effect(`rollback:${step}`)
      await effect.apply()
      expect(await effect.readback()).toBe(effect.afterDigest)
    }
    const epoch = JSON.parse(fs.readFileSync(f.p(`${rootPath}/epochs/fixture-epoch/epoch.json`), "utf8"))
    expect(epoch).toMatchObject({ state: "retired", terminalCursor: 91 })
    expect(JSON.parse(fs.readFileSync(f.p(`${bundle}/state/senses/telegram/offset.json`), "utf8"))).toEqual({ nextUpdateId: 91 })
    await expect(lifecycle.effect("rollback:restore-resident").apply()).rejects.toThrow(/rollback/u)
    f.createRollback()
    await lifecycle.effect("rollback:restore-resident").apply()
    await lifecycle.effect("rollback:verify-rollback").apply()
    const restore = host.exec.mock.calls.findIndex((call) => vaultOp(call[1]) === "restore")
    const reconcile = host.exec.mock.calls.findIndex((call) => call[1].includes("--retire-only"))
    expect(restore).toBeGreaterThan(reconcile)
    expect(fs.readFileSync(f.p("/boot/config/go"), "utf8")).toContain("# preserve unrelated boot state")
    expect(fs.existsSync(f.p(`${rootPath}/activation.json`))).toBe(false)
  })
  it("invokes the fixed root effects through the established installer's CLI and existing journal", async () => {
    const f = fixture()
    f.staged()
    const module = await import("../../../../deploy/unraid/docker-man-template-transaction.mjs")
    const journalPath = f.p("/boot/config/custom/ouro-butler/docker-man-template-transaction.json")
    const targetPath = f.p("/boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml")
    f.write("/source/sanctuary.xml", `<?xml version="1.0"?>\n<Container version="2"><Name>ouro-butler</Name><Repository>ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.816</Repository><TemplateURL>https://raw.githubusercontent.com/ourostack/ouroboros/main/deploy/unraid/sanctuary.xml</TemplateURL><Icon>https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png</Icon><WebUI/><Config Target="/run/ouro-authority" Type="Path" Mode="ro">/run/ouro-authority</Config></Container>`)
    f.write("/boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml", "old-template")
    fs.mkdirSync(path.dirname(path.dirname(journalPath)), { recursive: true, mode: 0o700 })
    const options = { targetPath, journalPath, expectedUid: process.getuid!(), expectedGid: process.getgid!(), withLease: withSessionTurnLease, RootLifecycle: SanctuaryAuthorityRootLifecycle, rootLifecycleOptions: f.rootOptions }
    module.prepareDockerManTemplateTransaction({ ...f.transaction, sourceTemplatePath: f.p("/source/sanctuary.xml"), reviewedManifestDigest: digest("manifest"), canonicalVersionTag: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.816" }, options)
    await expect(module.runDockerManTemplateTransactionCli(["authority-install"], { ...options, withLease: async () => { throw new Error("root driver busy") } }, () => undefined)).rejects.toThrow("root driver busy")
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8")).authority).toBeUndefined()
    // Missing human-entered token interrupts the concrete third effect. Its
    // pending intent, not a mock effect log, must survive for exact retry.
    await expect(module.runDockerManTemplateTransactionCli(["authority-install"], options, () => undefined)).rejects.toThrow(/ENOENT/u)
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"))
    expect(journal.authority.completed.map((entry: { step: string }) => entry.step)).toEqual(["freeze-resident", "stage-authority"])
    expect(journal.authority.pending.step).toBe("verify-token-rotation")
    expect(() => module.markDockerManTemplateTransactionCommitting(options)).toThrow(/authority/u)
  })
})

describe("in-place authority upgrade", () => {
  const currentReference = "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.830"
  const nextReference = "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.835"
  const programs = [
    "dist/heart/daemon/sanctuary-telegram-authority-entry.js",
    "dist/heart/daemon/sanctuary-host-supervisor-entry.js",
    "dist/heart/daemon/sanctuary-authority-root-lifecycle.js",
    "dist/heart/daemon/sanctuary-authority-installation.js",
    "deploy/unraid/sanctuary-host-launcher.sh",
    "deploy/unraid/sanctuary-authority-service.sh",
  ]
  // The upgraded package understands the cgroup keep child (0.1.0-alpha.837+); the
  // fixture's installed predecessor package does not.
  const next = (name: string) => `next ${name} ouro-keep`
  const steps = ["stop", "switch", "resident", "migrate", "start"] as const
  const records = ["request.json", "package-manifest.json", "active.json", "activation.json", "epochs/fixture-epoch/migration.json", "epochs/fixture-epoch/stage.json", "epochs/fixture-epoch/configured.json"]
  async function upgradeFixture() {
    const f = await installedStoppedGatewayFixture()
    f.publish()
    const resident = { image: digest("new-image"), reference: currentReference, running: true, exists: true, healthy: "healthy" }
    const bundleOps: string[] = []
    let pendingMigration = false
    const original = host.exec.getMockImplementation()!
    host.exec.mockImplementation((file: string, args: string[], options?: { input?: string }) => {
      if (file === "/bin/chown") return ""
      if (file.endsWith("/usr/local/bin/node") && String(args[0]).endsWith("migrate-sanctuary-bundle.mjs")) {
        const operation = args[args.indexOf("--operation") + 1]!
        bundleOps.push(operation)
        if (operation === "migrate") pendingMigration = true
        else if (!pendingMigration) throw new Error(`${operation} found no pending Sanctuary bundle transaction`)
        else pendingMigration = false
        return "{}"
      }
      if (file === "/usr/bin/docker") {
        if (args[0] === "image") return `${digest("next-image")}\n`
        if (args[0] === "rm") { resident.exists = false; return "" }
        if (args[0] === "create") {
          resident.exists = true
          resident.running = false
          resident.reference = String(args.at(-1))
          resident.image = resident.reference === nextReference ? digest("next-image") : digest("new-image")
          return "created\n"
        }
        if (args[0] === "ps") return resident.exists ? `${JSON.stringify({ Names: "ouro-butler" })}\n` : ""
        if (args[0] === "inspect") return JSON.stringify([{
          Name: "/ouro-butler", Image: resident.image, State: { Running: resident.running, Health: { Status: resident.healthy } },
          Config: { User: "10001:10001", Env: [], Image: resident.reference },
          Mounts: [{ Source: bundle, Destination: "/home/ouro/AgentBundles/sanctuary.ouro", RW: true }, { Source: "/run/ouro-authority", Destination: "/run/ouro-authority", RW: false }],
        }])
        if (args[0] === "stop") { resident.running = false; return "" }
        if (args[0] === "start") { resident.running = true; return "" }
      }
      return original(file, args, options)
    })
    vi.spyOn(process, "kill").mockImplementation(() => { fs.rmSync(f.p("/proc/45678"), { recursive: true, force: true }); return true })
    const files = Object.fromEntries(programs.map((name) => {
      f.write(`${rootPath}/incoming-package/${name}`, next(name))
      fs.chmodSync(f.p(`${rootPath}/incoming-package/${name}`), 0o700)
      return [name, { digest: digest(next(name)), mode: 0o700 }]
    }))
    const manifest = JSON.stringify({ schemaVersion: 1, files })
    const nextRequest = { ...f.request, packageDigest: digest(manifest) }
    f.write(`${rootPath}/incoming-package-manifest.json`, manifest)
    f.write(`${rootPath}/incoming-request.json`, nextRequest)
    const snapshot = () => ({
      records: records.map((name) => fs.readFileSync(f.p(`${rootPath}/${name}`), "utf8")),
      packages: programs.map((name) => fs.existsSync(f.p(`${rootPath}/package/${name}`)) ? fs.readFileSync(f.p(`${rootPath}/package/${name}`), "utf8") : null),
      boot: fs.readFileSync(f.p("/boot/config/custom/ouro-authority/start.sh"), "utf8"),
      epoch: readEpoch(f),
    })
    const lifecycleFor = () => new SanctuaryAuthorityRootLifecycle(JSON.parse(fs.readFileSync(f.p(`${rootPath}/activation.json`), "utf8")), f.rootOptions)
    return { ...f, resident, bundleOps, nextRequest, manifest, snapshot, lifecycleFor, setPending: (value: boolean) => { pendingMigration = value } }
  }
  function readEpoch(f: { p: (name: string) => string }) {
    const epoch = JSON.parse(fs.readFileSync(f.p(`${rootPath}/epochs/fixture-epoch/epoch.json`), "utf8"))
    return { packageDigest: epoch.packageDigest, tokenDigest: epoch.tokenDigest, publicKeyDigest: epoch.publicKeyDigest, predecessorCursor: epoch.predecessorCursor, state: epoch.state }
  }

  it("moves the installed authority to the new package and image, keeping its epoch, token and cursor", async () => {
    const f = await upgradeFixture()
    const before = f.snapshot()
    f.write(`${rootPath}/incoming-token`, "123:staleCopyabcdefghijklmnopqrstuvwxyz")
    await f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/activation.json`), "utf8"))).toEqual({ targetImageId: digest("next-image"), rollbackImageId: digest("new-image"), state: "active", epochId: "fixture-epoch" })
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/request.json`), "utf8"))).toEqual(f.nextRequest)
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/active.json`), "utf8")).packageManifestDigest).toBe(f.nextRequest.packageDigest)
    expect(readEpoch(f)).toEqual({ ...before.epoch, packageDigest: f.nextRequest.packageDigest })
    expect(programs.map((name) => fs.readFileSync(f.p(`${rootPath}/package/${name}`), "utf8"))).toEqual(programs.map(next))
    expect(fs.readFileSync(f.p("/boot/config/custom/ouro-authority/start.sh"), "utf8")).toBe(next("deploy/unraid/sanctuary-authority-service.sh"))
    expect(f.resident).toMatchObject({ image: digest("next-image"), reference: nextReference, running: true })
    expect(f.bundleOps).toEqual(["migrate", "commit"])
    for (const leftover of ["upgrade.json", "upgrade-previous", "package-next", "incoming-token"]) expect(fs.existsSync(f.p(`${rootPath}/${leftover}`))).toBe(false)
    fs.rmSync(f.p("/proc/45678"), { recursive: true })
    await expect(f.lifecycleFor().boot()).resolves.toBe(true)
  })

  it.each(steps)("rolls back exactly after the %s step and can upgrade again", async (step) => {
    const f = await upgradeFixture()
    const before = f.snapshot()
    await expect(f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, failAfter: step })).rejects.toThrow(`stopped after ${step}`)
    await expect(f.lifecycleFor().rollbackUpgrade()).resolves.toBe(true)
    expect(f.snapshot()).toEqual(before)
    expect(f.resident).toMatchObject({ image: digest("new-image"), reference: currentReference, running: true })
    for (const leftover of ["upgrade.json", "upgrade-previous", "package-next"]) expect(fs.existsSync(f.p(`${rootPath}/${leftover}`))).toBe(false)
    await expect(f.lifecycleFor().rollbackUpgrade()).resolves.toBe(false)
    await f.lifecycleFor().upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })
    expect(f.resident.image).toBe(digest("next-image"))
  })

  it("rolls an interrupted upgrade back at boot and resumes one when rerun", async () => {
    const f = await upgradeFixture()
    const before = f.snapshot()
    await expect(f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, failAfter: "resident" })).rejects.toThrow(/resident/u)
    await expect(f.lifecycleFor().boot()).resolves.toBe(true)
    expect(f.snapshot()).toEqual(before)
    await expect(f.lifecycleFor().upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, failAfter: "switch" })).rejects.toThrow(/switch/u)
    await f.lifecycleFor().upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })
    expect(readEpoch(f).packageDigest).toBe(f.nextRequest.packageDigest)
  })

  it("lets only a rollback continue a rollback that stopped partway", async () => {
    const f = await upgradeFixture()
    const before = f.snapshot()
    await expect(f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, failAfter: "start" })).rejects.toThrow(/start/u)
    host.cursor.mockRejectedValueOnce(new Error("gateway not ready yet"))
    await expect(f.lifecycleFor().rollbackUpgrade()).rejects.toThrow(/not ready/u)
    expect(JSON.parse(fs.readFileSync(f.p(`${rootPath}/upgrade.json`), "utf8")).rollingBack).toBe(true)
    await expect(f.lifecycleFor().upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })).rejects.toThrow(/rollback is pending/u)
    await expect(f.lifecycleFor().rollbackUpgrade()).resolves.toBe(true)
    expect(f.snapshot()).toEqual(before)
  })

  it("refuses a journal whose rollback marker is not the literal true", async () => {
    const f = await upgradeFixture()
    await expect(f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, failAfter: "stop" })).rejects.toThrow(/stop/u)
    const journal = JSON.parse(fs.readFileSync(f.p(`${rootPath}/upgrade.json`), "utf8"))
    f.write(`${rootPath}/upgrade.json`, { ...journal, rollingBack: "yes" })
    await expect(f.lifecycleFor().rollbackUpgrade()).rejects.toThrow(/journal is invalid/u)
  })

  it("keeps a recorded bundle migration authoritative and retries a rollback whose bundle is already back", async () => {
    const f = await upgradeFixture()
    await expect(f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, failAfter: "migrate" })).rejects.toThrow(/migrate/u)
    f.setPending(false)
    await expect(f.lifecycleFor().rollbackUpgrade()).rejects.toThrow(/no pending/u)
    f.setPending(true)
    host.cursor.mockRejectedValueOnce(new Error("gateway not ready yet"))
    await expect(f.lifecycleFor().rollbackUpgrade()).rejects.toThrow(/not ready/u)
    await expect(f.lifecycleFor().rollbackUpgrade()).resolves.toBe(true)
    expect(f.bundleOps.filter((operation) => operation === "finalize-rollback")).toHaveLength(3)
  })

  it("resumes a switch interrupted after the package moved and a recreation interrupted after removal", async () => {
    const f = await upgradeFixture()
    const rename = fs.renameSync
    let failConfig = true
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (failConfig && String(destination) === f.p(`${rootPath}/active.json`)) { failConfig = false; throw new Error("interrupted config write") }
      return rename(source, destination)
    })
    await expect(f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })).rejects.toThrow("interrupted config write")
    failure.mockRestore()
    expect(fs.existsSync(f.p(`${rootPath}/upgrade-previous/package`))).toBe(true)
    const original = host.exec.getMockImplementation()!
    let failCreate = true
    host.exec.mockImplementation((file: string, args: string[], options?: { input?: string }) => {
      if (failCreate && file === "/usr/bin/docker" && args[0] === "create") { failCreate = false; throw new Error("interrupted create") }
      return original(file, args, options)
    })
    await expect(f.lifecycleFor().upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })).rejects.toThrow("interrupted create")
    expect(f.resident.exists).toBe(false)
    await f.lifecycleFor().upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })
    expect(f.resident).toMatchObject({ image: digest("next-image"), running: true })
    expect(programs.map((name) => fs.readFileSync(f.p(`${rootPath}/package/${name}`), "utf8"))).toEqual(programs.map(next))
  })

  describe("cgroup keep child (D-026)", () => {
    const keep = "/sys/fs/cgroup/ouro-authority/ouro-keep"
    async function keepAware() {
      const f = await upgradeFixture()
      await f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })
      fs.rmSync(f.p("/proc/45678"), { recursive: true, force: true })
      return f
    }
    it("keeps the child once the installed package understands it, retrying a reaper race at boot", async () => {
      const f = await keepAware()
      expect(fs.statSync(f.p(keep)).isDirectory()).toBe(true)
      fs.rmSync(f.p(keep), { recursive: true, force: true })
      const mkdir = fs.mkdirSync
      let raced = false
      vi.spyOn(fs, "mkdirSync").mockImplementation(((file, options) => {
        if (!raced && String(file) === f.p(keep)) { raced = true; throw Object.assign(new Error("reaped"), { code: "ENOENT" }) }
        return mkdir(file, options)
      }) as typeof fs.mkdirSync)
      await expect(f.lifecycleFor().boot()).resolves.toBe(true)
      expect(raced).toBe(true)
      expect(fs.statSync(f.p(keep)).isDirectory()).toBe(true)
    })

    it.each([["ENOENT", /reaped/u], ["EACCES", /denied/u]])("stops after repeated %s failures instead of looping", async (code, error) => {
      const f = await keepAware()
      fs.rmSync(f.p(keep), { recursive: true, force: true })
      const mkdir = fs.mkdirSync
      vi.spyOn(fs, "mkdirSync").mockImplementation(((file, options) => {
        if (String(file) === f.p(keep)) throw Object.assign(new Error(code === "ENOENT" ? "reaped" : "denied"), { code })
        return mkdir(file, options)
      }) as typeof fs.mkdirSync)
      await expect(f.lifecycleFor().boot()).rejects.toThrow(error)
    })

    it("removes the child and holds Unraid's reaper before starting a predecessor that predates it", async () => {
      const f = await upgradeFixture()
      await expect(f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, failAfter: "start" })).rejects.toThrow(/start/u)
      expect(fs.existsSync(f.p(keep))).toBe(true)
      f.write("/run/cgroup2-unraid.pid", "4242\n")
      await expect(f.lifecycleFor().rollbackUpgrade()).resolves.toBe(true)
      expect(fs.existsSync(f.p(keep))).toBe(false)
      expect(process.kill).toHaveBeenCalledWith(4242, "SIGSTOP")
    })

    it.each([[null], ["not-a-pid"], ["4343"]])("tolerates a reaper pid file of %j while holding it", async (pid) => {
      const f = await upgradeFixture()
      await expect(f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, failAfter: "start" })).rejects.toThrow(/start/u)
      if (pid !== null) f.write("/run/cgroup2-unraid.pid", pid)
      const kill = vi.mocked(process.kill).getMockImplementation()!
      vi.mocked(process.kill).mockImplementation(((target: number, signal?: string) => {
        if (target === 4343) throw Object.assign(new Error("no such process"), { code: "ESRCH" })
        return kill(target, signal)
      }) as typeof process.kill)
      await expect(f.lifecycleFor().rollbackUpgrade()).resolves.toBe(true)
      expect(fs.existsSync(f.p(keep))).toBe(false)
    })
  })

  it.each([
    ["an invalid image id", { targetImageId: "bad" }, /invalid/u],
    ["an unreviewed image reference", { imageReference: "local/butler:dev" }, /invalid/u],
    ["an unknown rehearsal step", { failAfter: "teleport" }, /invalid/u],
    ["the running image", { targetImageId: digest("new-image") }, /already runs/u],
    ["an image whose identity differs from its reference", { targetImageId: digest("other-image") }, /identity/u],
  ])("refuses %s before changing anything", async (_label, override, error) => {
    const f = await upgradeFixture()
    const before = f.snapshot()
    await expect(f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, ...override })).rejects.toThrow(error)
    expect(f.snapshot()).toEqual(before)
    expect(fs.existsSync(f.p(`${rootPath}/upgrade.json`))).toBe(false)
  })

  it.each(["identity", "package", "journal", "template", "reference", "different"])("refuses an upgrade with %s ambiguity", async (fault) => {
    const f = await upgradeFixture()
    if (fault === "identity") f.write(`${rootPath}/incoming-request.json`, { ...f.nextRequest, botId: "124" })
    if (fault === "package") f.write(`${rootPath}/incoming-request.json`, f.request)
    if (fault === "journal") f.write(`${rootPath}/upgrade.json`, { schemaVersion: 1, epochId: "fixture-epoch", completed: ["teleport"] })
    if (fault === "template") f.write("/boot/config/custom/ouro-butler/docker-man-template-transaction.json", "pending")
    if (fault === "reference") f.resident.reference = "local/butler:dev"
    if (fault === "different") await expect(f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, failAfter: "stop" })).rejects.toThrow(/stop/u)
    const reference = fault === "different" ? "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.836" : nextReference
    await expect(f.lifecycleFor().upgrade({ targetImageId: digest("next-image"), imageReference: reference })).rejects.toThrow(/identity|installed|journal|installation|reviewed|different/u)
  })

  it("refuses unsafe progress: a resident that will not stop, a wrong recreated image, a changed pin and a bad cursor", async () => {
    const stuck = await upgradeFixture()
    const original = host.exec.getMockImplementation()!
    host.exec.mockImplementation((file: string, args: string[], options?: { input?: string }) => file === "/usr/bin/docker" && args[0] === "stop" ? "" : original(file, args, options))
    await expect(stuck.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })).rejects.toThrow(/did not stop/u)

    const wrong = await upgradeFixture()
    const recreate = host.exec.getMockImplementation()!
    host.exec.mockImplementation((file: string, args: string[], options?: { input?: string }) => {
      const value = recreate(file, args, options)
      if (file === "/usr/bin/docker" && args[0] === "create") wrong.resident.image = digest("other-image")
      return value
    })
    await expect(wrong.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })).rejects.toThrow(/recreation/u)

    const pin = await upgradeFixture()
    await expect(pin.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, failAfter: "stop" })).rejects.toThrow(/stop/u)
    pin.write(`${rootPath}/incoming-package/${programs[0]}`, "tampered")
    fs.chmodSync(pin.p(`${rootPath}/incoming-package/${programs[0]}`), 0o700)
    await expect(pin.lifecycleFor().upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })).rejects.toThrow(/pin/u)

    const cursor = await upgradeFixture()
    const migration = JSON.parse(fs.readFileSync(cursor.p(`${rootPath}/epochs/fixture-epoch/migration.json`), "utf8"))
    await expect(cursor.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference, failAfter: "stop" })).rejects.toThrow(/stop/u)
    cursor.write(`${rootPath}/epochs/fixture-epoch/migration.json`, { ...migration, predecessorCursor: -1 })
    await expect(cursor.lifecycleFor().upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })).rejects.toThrow(/cursor/u)
  })

  it("upgrades a host whose keeper replaced the direct boot line, leaving the go file alone", async () => {
    const f = await upgradeFixture()
    f.write("/boot/config/go", "#!/bin/sh\nsetsid /bin/sh /boot/config/custom/ouro-authority/gateway-supervisor.sh & # ouro-authority-gateway\n")
    await f.lifecycle.upgrade({ targetImageId: digest("next-image"), imageReference: nextReference })
    expect(fs.readFileSync(f.p("/boot/config/go"), "utf8")).not.toContain("start.sh --boot")
    expect(fs.readFileSync(f.p("/boot/config/custom/ouro-authority/start.sh"), "utf8")).toBe(next("deploy/unraid/sanctuary-authority-service.sh"))
  })

  it("dispatches upgrade and upgrade-rollback from the root CLI under a waiting deployment lease", async () => {
    const f = fixture()
    const sessions = await import("../../../mind/session-transaction")
    const upgrade = vi.spyOn(SanctuaryAuthorityRootLifecycle.prototype, "upgrade").mockResolvedValue(undefined)
    const rollback = vi.spyOn(SanctuaryAuthorityRootLifecycle.prototype, "rollbackUpgrade").mockResolvedValue(true)
    vi.spyOn(sessions, "withSessionTurnLease").mockImplementation(async (_file, work) => work({} as never))
    vi.spyOn(process, "getuid").mockReturnValue(0)
    vi.spyOn(process, "getgid").mockReturnValue(0)
    for (const args of [["upgrade"], ["upgrade", digest("x")], ["upgrade", digest("x"), nextReference, "--fail-after"], ["upgrade", digest("x"), nextReference, "--other", "stop"], ["upgrade-rollback", "extra"]]) await expect(runSanctuaryAuthorityRootCli(args)).rejects.toThrow(/Usage/u)
    const exists = fs.existsSync
    const existsMock = vi.spyOn(fs, "existsSync").mockImplementation((file) => String(file) === `${rootPath}/activation.json` ? false : exists(file))
    await expect(runSanctuaryAuthorityRootCli(["upgrade", digest("x"), nextReference])).rejects.toThrow(/not active/u)
    await expect(runSanctuaryAuthorityRootCli(["upgrade-rollback"])).rejects.toThrow(/not active/u)
    existsMock.mockRestore()
    f.write(`${rootPath}/activation.json`, f.transaction)
    const lstat = fs.lstatSync, open = fs.openSync, read = fs.readFileSync, realpath = fs.realpathSync, fstat = fs.fstatSync
    const mapped = (file: fs.PathLike) => String(file).startsWith(rootPath) ? f.p(String(file)) : file
    vi.spyOn(fs, "existsSync").mockImplementation((file) => exists(mapped(file)))
    vi.spyOn(fs, "lstatSync").mockImplementation(((file, options) => Object.assign(lstat(mapped(file), options), { uid: 0, gid: 0 })) as typeof fs.lstatSync)
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => open(mapped(file), flags, mode))
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd, options) => Object.assign(fstat(fd, options), { uid: 0, gid: 0 })) as typeof fs.fstatSync)
    vi.spyOn(fs, "realpathSync").mockImplementation(((file, options) => String(file).startsWith(rootPath) ? file : realpath(file, options)) as typeof fs.realpathSync)
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, options) => read(typeof file === "number" ? file : mapped(file), options)) as typeof fs.readFileSync)
    const write = vi.fn()
    await runSanctuaryAuthorityRootCli(["upgrade", digest("x"), nextReference], write)
    expect(upgrade).toHaveBeenLastCalledWith({ targetImageId: digest("x"), imageReference: nextReference })
    await runSanctuaryAuthorityRootCli(["upgrade", digest("x"), nextReference, "--fail-after", "switch"], write)
    expect(upgrade).toHaveBeenLastCalledWith({ targetImageId: digest("x"), imageReference: nextReference, failAfter: "switch" })
    await runSanctuaryAuthorityRootCli(["upgrade-rollback"], write)
    expect(rollback).toHaveBeenCalledOnce()
    expect(write.mock.calls).toEqual([[`{"upgraded":"${nextReference}"}\n`], [`{"upgraded":"${nextReference}"}\n`], ['{"rolledBack":true}\n']])
    expect(sessions.withSessionTurnLease).toHaveBeenLastCalledWith("/boot/config/custom/ouro-butler/docker-man-template-transaction.json", expect.any(Function), { timeoutMs: 600_000, confinementRoot: "/boot/config/custom/ouro-butler" })
  })
})

describe("root lifecycle failure detail", () => {
  it("keeps the real failure in a root-only file and only names that file", () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "root-failure-")))
    roots.push(directory)
    const file = path.join(directory, "lifecycle-failure.log")
    expect(recordSanctuaryRootLifecycleFailure(new Error("boundary failed"), file)).toBe(` Details (root-only): ${file}`)
    expect(recordSanctuaryRootLifecycleFailure("plain failure", file)).toBe(` Details (root-only): ${file}`)
    const text = fs.readFileSync(file, "utf8")
    expect(text).toContain("Error: boundary failed")
    expect(text).toContain(" plain failure\n")
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(recordSanctuaryRootLifecycleFailure(new Error("x"), path.join(directory, "missing", "log"))).toBe("")
  })
})
