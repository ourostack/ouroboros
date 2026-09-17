import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  loadSanctuaryTelegramAuthorityConfig,
  runSanctuaryTelegramAuthorityCli,
  startSanctuaryTelegramAuthority,
} from "../../../heart/daemon/sanctuary-telegram-authority-entry"
import {
  FileSanctuaryTelegramAuthorityGateway,
  sanctuaryTelegramAuthorityStatePath,
  sanctuaryAuthorityPublicKeyDigest,
} from "../../../heart/daemon/sanctuary-telegram-authority-gateway"
import { FileSanctuaryHostAuthority } from "../../../heart/daemon/sanctuary-host-authority"
import { authorityArtifactDigest, signAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"
import { SocketSanctuaryTelegramAuthorityClient } from "../../../heart/daemon/sanctuary-telegram-authority-service"

const roots: string[] = []
const installation = vi.hoisted(() => ({ verify: vi.fn(), epoch: vi.fn() }))
vi.mock("../../../heart/daemon/sanctuary-authority-installation", () => ({ verifySanctuaryAuthorityInstallation: installation.verify }))
vi.mock("../../../heart/daemon/sanctuary-authority-epoch", () => ({ readSanctuaryAuthorityEpoch: installation.epoch }))
vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }))

function fixture(predecessorCursor = 0) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sta-")))
  roots.push(root)
  const keys = generateKeyPairSync("ed25519")
  const tokenPath = path.join(root, "token")
  const privateKeyPath = path.join(root, "issuer.pem")
  const configPath = path.join(root, "config.json")
  fs.writeFileSync(tokenPath, "123456:abcdefghijklmnopqrstuvwxyz\n", { mode: 0o600 })
  fs.writeFileSync(privateKeyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
  const hostFiles = Object.fromEntries(["supervisor", "launcher", "prlimit", "setsid", "shell"].map((name) => {
    const filePath = path.join(root, name)
    fs.writeFileSync(filePath, name, { mode: 0o755 })
    return [name, filePath]
  })) as Record<"supervisor" | "launcher" | "prlimit" | "setsid" | "shell", string>
  const fileDigest = (name: keyof typeof hostFiles) => `sha256:${createHash("sha256").update(name).digest("hex")}`
  const config = {
    schemaVersion: 1,
    agentRoot: path.join(root, "agent"),
    targetHost: "sanctuary",
    botId: "123456",
    ownerUserId: "42",
    ownerChatId: "42",
    keyId: "sanctuary-root-2026-09-16",
    publicKeyDigest: sanctuaryAuthorityPublicKeyDigest(keys.privateKey),
    tokenPath,
    privateKeyPath,
    socketPath: path.join(root, "run", "authority.sock"),
    socketGroupId: 10001,
    readinessPath: path.join(root, "state", "readiness.json"),
    lockPath: path.join(root, "state", "authority.lock"),
    hostStagingRoot: path.join(root, "host-staging"),
    hostExecutionStateRoot: path.join(root, "host-executions"),
    hostSupervisorStateRoot: path.join(root, "host-supervisors"),
    hostCgroupRoot: path.join(root, "cgroup"),
    hostSupervisorProgramPath: hostFiles.supervisor,
    hostSupervisorProgramDigest: fileDigest("supervisor"),
    hostLauncherPath: hostFiles.launcher,
    hostLauncherDigest: fileDigest("launcher"),
    hostPrlimitPath: hostFiles.prlimit,
    hostPrlimitDigest: fileDigest("prlimit"),
    hostSetsidPath: hostFiles.setsid,
    hostSetsidDigest: fileDigest("setsid"),
    hostShellPath: hostFiles.shell,
    hostShellDigest: fileDigest("shell"),
    epochRoot: root,
    packageRoot: path.join(root, "package"),
    packageManifestPath: path.join(root, "manifest.json"),
    packageManifestDigest: fileDigest("supervisor"),
  }
  installation.verify.mockReset()
  installation.epoch.mockReset().mockReturnValue({
    state: "prepared", epochId: config.keyId, botId: config.botId, ownerUserId: config.ownerUserId, ownerChatId: config.ownerChatId,
    publicKeyDigest: config.publicKeyDigest, tokenPath: config.tokenPath, packageDigest: config.packageManifestDigest,
    predecessorCursor,
  })
  fs.mkdirSync(config.hostCgroupRoot)
  fs.mkdirSync(path.dirname(config.socketPath), { mode: 0o750 })
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
  new FileSanctuaryTelegramAuthorityGateway(config.agentRoot, { ...config, privateKey: keys.privateKey }).initializeCursor(predecessorCursor)
  return { root, config, configPath, keys }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Sanctuary Telegram authority process", () => {
  it.each(["hostPrlimitPath", "hostSetsidPath"] as const)("keeps Telegram and rollback available after an OS update changes %s", async (primitive) => {
    const f = fixture()
    fs.writeFileSync(f.config[primitive], "updated by the OS")
    let service!: import("../../../heart/daemon/sanctuary-telegram-authority-service").SanctuaryTelegramAuthorityService
    const authority = await startSanctuaryTelegramAuthority({
      configPath: f.configPath, expectedUid: process.getuid!(),
      createApi: () => ({ request: vi.fn(async (method) => method === "getUpdates" ? [] : { id: 123456 }), stop: vi.fn() }),
      createServer: (input) => { service = input.service; return { listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) } },
    })
    try {
      await expect(service.dispatch("telegram.request", { method: "getMe", body: {} })).resolves.toEqual({ id: 123456 })
      await expect(service.dispatch("host.status", { registrationId: null })).resolves.toMatchObject({ health: { payload: { healthy: false } } })
      await expect(service.dispatch("host.approval", { proposal: {} })).rejects.toThrow(/unavailable/u)
      await expect(service.dispatch("host.execute", { correlation: {} })).rejects.toThrow(/unavailable/u)
      await authority.retire()
      expect(JSON.parse(fs.readFileSync(path.join(f.config.epochRoot, "retirement.json"), "utf8")).quiescent).toBe(true)
    } finally { await authority.close() }
  })

  it.each([false, true])("refuses missing persisted cursor state during startup or retirement (%s)", async (retireOnly) => {
    const f = fixture()
    fs.unlinkSync(sanctuaryTelegramAuthorityStatePath(f.config.agentRoot))
    await expect(startSanctuaryTelegramAuthority({
      configPath: f.configPath, expectedUid: process.getuid!(), retireOnly,
      createApi: () => ({ request: vi.fn(async () => ({ id: 123456 })), stop: vi.fn() }),
      createServer: () => ({ listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }),
    })).rejects.toThrow(/cursor state is absent/u)
    expect(fs.existsSync(sanctuaryTelegramAuthorityStatePath(f.config.agentRoot))).toBe(false)
    expect(fs.existsSync(f.config.readinessPath)).toBe(false)
  })

  it("drains an in-flight execution before attempting retirement reconciliation", async () => {
    const f = fixture()
    let finish!: () => void
    let active = false
    const executing = new Promise<void>((resolve) => { finish = resolve })
    const executor = {
      execute: vi.fn(async () => { active = true; await executing; active = false; throw new Error("attempt must reconcile") }),
      reconcile: vi.fn(async () => { if (active) throw new Error("already active"); return [] }),
    }
    vi.spyOn(FileSanctuaryHostAuthority.prototype, "issuePermit").mockReturnValue({ payload: { permitId: "attempt" } } as never)
    let service!: import("../../../heart/daemon/sanctuary-telegram-authority-service").SanctuaryTelegramAuthorityService
    const server = { listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }
    const authority = await startSanctuaryTelegramAuthority({
      configPath: f.configPath, expectedUid: process.getuid!(), createHostExecutor: () => executor,
      createApi: () => ({ request: vi.fn(async () => ({ id: 123456 })), stop: vi.fn() }),
      createServer: (input) => { service = input.service; return server },
    })
    await service.dispatch("host.execute", { correlation: { registrationId: "registration" } })
    let settled = false
    const retirement = authority.retire().finally(() => { settled = true })
    const observed = retirement.catch((error) => error)
    await new Promise((resolve) => setImmediate(resolve))
    const drainedPrematurely = settled
    finish()
    expect(await observed).toBeUndefined()
    expect(drainedPrematurely).toBe(false)
    expect(executor.reconcile).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fs.readFileSync(path.join(f.config.epochRoot, "retirement.json"), "utf8")).quiescent).toBe(true)
  })
  it("leaves interrupted retirement fail-closed until known executions and cgroups are reconciled", async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.config.hostCgroupRoot, "cgroup.procs"), "")
    const options = { configPath: f.configPath, expectedUid: process.getuid!(), retireOnly: true, createHostExecutor: () => ({ execute: vi.fn(), reconcile: vi.fn(async () => []) }) }
    const retire = vi.spyOn(FileSanctuaryHostAuthority.prototype, "retireRegistrations").mockReturnValueOnce([]).mockReturnValueOnce(["unfinished"])
    await expect(startSanctuaryTelegramAuthority(options)).rejects.toThrow(/cleanup/u)
    retire.mockRestore()
    await expect(startSanctuaryTelegramAuthority({ ...options, retireOnly: false })).rejects.toThrow(/retirement must finish/u)
    fs.mkdirSync(path.join(f.config.hostCgroupRoot, "still-populated"))
    await expect(startSanctuaryTelegramAuthority(options)).rejects.toThrow(/cleanup/u)
    fs.rmdirSync(path.join(f.config.hostCgroupRoot, "still-populated"))
    await startSanctuaryTelegramAuthority(options)
    expect(JSON.parse(fs.readFileSync(path.join(f.config.epochRoot, "retirement.json"), "utf8")).quiescent).toBe(true)
  })
  it("refuses a gateway cursor that precedes its epoch before publishing readiness", async () => {
    const f = fixture()
    installation.epoch.mockReturnValue({ ...installation.epoch(), predecessorCursor: 80 })
    vi.spyOn(FileSanctuaryTelegramAuthorityGateway.prototype, "cursor").mockReturnValue(79)
    await expect(startSanctuaryTelegramAuthority({ configPath: f.configPath, expectedUid: process.getuid!(), retireOnly: true })).rejects.toThrow(/precedes/u)
  })
  it("rejects linked private files and immutable parent mode drift without repairing either", async () => {
    const f = fixture()
    fs.linkSync(f.config.tokenPath, path.join(f.root, "token-alias"))
    expect(() => loadSanctuaryTelegramAuthorityConfig(f.configPath, { expectedUid: process.getuid!() })).toThrow(/private/u)
    fs.unlinkSync(path.join(f.root, "token-alias"))
    fs.mkdirSync(path.dirname(f.config.lockPath), { mode: 0o777 })
    fs.chmodSync(path.dirname(f.config.lockPath), 0o777)
    await expect(startSanctuaryTelegramAuthority({ configPath: f.configPath, expectedUid: process.getuid!() })).rejects.toThrow(/directory/u)
    expect(fs.statSync(path.dirname(f.config.lockPath)).mode & 0o777).toBe(0o777)
  })
  it("removes its own unpublished readiness temporary after an interrupted write", async () => {
    const f = fixture()
    const rename = fs.renameSync
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === f.config.readinessPath) throw new Error("readiness publication interrupted")
      return rename(from, to)
    })
    await expect(startSanctuaryTelegramAuthority({
      configPath: f.configPath, expectedUid: process.getuid!(),
      createApi: () => ({ request: vi.fn(async () => ({ id: 123456 })), stop: vi.fn() }),
      createServer: () => ({ listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }),
    })).rejects.toThrow("readiness publication interrupted")
    expect(fs.existsSync(`${f.config.readinessPath}.${process.pid}.tmp`)).toBe(false)
  })
  it("quiesces ingress, retires authority and reconciles executions before publishing stop proof", async () => {
    const f = fixture()
    const api = { request: vi.fn(async () => ({ id: 123456 })), stop: vi.fn() }
    const server = { listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }
    const authority = await startSanctuaryTelegramAuthority({ configPath: f.configPath, expectedUid: process.getuid!(), createApi: () => api, createServer: () => server, setSocketOwnership: () => undefined })
    await authority.retire()
    expect(JSON.parse(fs.readFileSync(path.join(f.config.epochRoot, "retirement.json"), "utf8"))).toMatchObject({ schemaVersion: 1, keyId: f.config.keyId, cursor: 0, quiescent: true })
    expect(fs.existsSync(f.config.lockPath)).toBe(false)
    expect(fs.existsSync(f.config.readinessPath)).toBe(false)
    expect(server.close).toHaveBeenCalledOnce()
    expect(api.stop).toHaveBeenCalledOnce()
  })
  it("can finish retirement after a gateway crash without acquiring Telegram ingress", async () => {
    const f = fixture()
    const createApi = vi.fn()
    const createServer = vi.fn()
    const authority = await startSanctuaryTelegramAuthority({ configPath: f.configPath, expectedUid: process.getuid!(), retireOnly: true, createApi, createServer })
    expect(createApi).not.toHaveBeenCalled()
    expect(createServer).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(path.join(f.config.epochRoot, "retirement.json"), "utf8")).quiescent).toBe(true)
    await authority.close()
  })
  it("refuses an unsafe installation or retired/mismatched epoch before acquiring Telegram ingress", async () => {
    for (const mutate of [
      () => installation.verify.mockImplementation(() => { throw new Error("installation changed") }),
      () => installation.epoch.mockReturnValue({ state: "retired" }),
      () => installation.epoch.mockReturnValue({ state: "prepared", epochId: "another-epoch" }),
    ]) {
      const f = fixture()
      mutate()
      const createApi = vi.fn()
      await expect(startSanctuaryTelegramAuthority({ configPath: f.configPath, expectedUid: process.getuid!(), createApi })).rejects.toThrow(/installation|epoch/u)
      expect(createApi).not.toHaveBeenCalled()
      expect(fs.existsSync(f.config.readinessPath)).toBe(false)
    }
  })
  it("loads only exact private root configuration and owns startup through graceful close", async () => {
    const f = fixture(80)
    const uid = process.getuid?.() ?? 0
    expect(loadSanctuaryTelegramAuthorityConfig(f.configPath, { expectedUid: uid })).toEqual(f.config)
    if (uid !== 0) expect(() => loadSanctuaryTelegramAuthorityConfig(f.configPath)).toThrow(/private/u)
    const api = {
      request: vi.fn(async (method: string) => method === "getMe" ? { id: 123456 } : []),
      stop: vi.fn(),
    }
    const server = { listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }
    const setSocketOwnership = vi.fn()
    let observedCursor: number | undefined
    const authority = await startSanctuaryTelegramAuthority({
      configPath: f.configPath,
      expectedUid: uid,
      createApi: () => api,
      createServer: ({ gateway }) => { observedCursor = gateway.cursor(); return server },
      now: () => "2026-09-16T23:00:00.000Z",
      setSocketOwnership,
    })

    expect(api.request).toHaveBeenCalledWith("getMe", {})
    expect(observedCursor).toBe(80)
    expect(server.listen).toHaveBeenCalledOnce()
    expect(setSocketOwnership).toHaveBeenCalledWith(f.config)
    const residentPinsPath = path.join(path.dirname(f.config.socketPath), "resident.json")
    const residentPins = JSON.parse(fs.readFileSync(residentPinsPath, "utf8"))
    expect(residentPins).toMatchObject({ schemaVersion: 1, targetHost: "sanctuary", botId: "123456", ownerUserId: "42", ownerChatId: "42", keyId: f.config.keyId, publicKeyDigest: f.config.publicKeyDigest })
    expect(Object.keys(residentPins).sort()).toEqual(["schemaVersion", "targetHost", "botId", "ownerUserId", "ownerChatId", "keyId", "publicKeyDigest", "publicKeyPem"].sort())
    expect(fs.lstatSync(residentPinsPath).mode & 0o777).toBe(0o640)
    expect(fs.lstatSync(path.dirname(f.config.socketPath)).mode & 0o777).toBe(0o750)
    expect(JSON.parse(fs.readFileSync(f.config.readinessPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      status: "ready",
      botId: "123456",
      socketPath: f.config.socketPath,
      startedAt: "2026-09-16T23:00:00.000Z",
    })
    await authority.close()
    await authority.close()
    expect(server.close).toHaveBeenCalledOnce()
    expect(api.stop).toHaveBeenCalledOnce()
    expect(fs.existsSync(f.config.readinessPath)).toBe(false)
    expect(fs.existsSync(f.config.lockPath)).toBe(false)
  })

  it("refuses non-root startup, unsafe private files, changed bot identity, and a live singleton", async () => {
    const f = fixture()
    const uid = process.getuid?.() ?? 0
    await expect(startSanctuaryTelegramAuthority({ configPath: f.configPath, expectedUid: uid + 1 })).rejects.toThrow(/root/u)
    fs.chmodSync(f.config.tokenPath, 0o644)
    expect(() => loadSanctuaryTelegramAuthorityConfig(f.configPath, { expectedUid: uid })).toThrow(/private/u)
    fs.chmodSync(f.config.tokenPath, 0o600)
    await expect(startSanctuaryTelegramAuthority({
      configPath: f.configPath,
      expectedUid: uid,
      createApi: () => ({ request: vi.fn(async () => ({ id: 999 })), stop: vi.fn() }),
    })).rejects.toThrow(/identity/u)
    fs.mkdirSync(path.dirname(f.config.lockPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(f.config.lockPath, String(process.pid), { mode: 0o600 })
    await expect(startSanctuaryTelegramAuthority({
      configPath: f.configPath,
      expectedUid: uid,
      processAlive: () => true,
    })).rejects.toThrow(/already running/u)
  })

  it("refuses malformed configuration and stale-lock ambiguity", async () => {
    const f = fixture()
    const uid = process.getuid?.() ?? 0
    const write = (value: unknown) => {
      fs.writeFileSync(f.configPath, JSON.stringify(value), { mode: 0o600 })
      fs.chmodSync(f.configPath, 0o600)
    }
    expect(() => loadSanctuaryTelegramAuthorityConfig("relative.json", { expectedUid: uid })).toThrow(/absolute/u)
    for (const invalid of [
      null,
      [],
      { ...f.config, extra: true },
      { ...f.config, schemaVersion: 2 },
      { ...f.config, agentRoot: "relative" },
      { ...f.config, targetHost: "" },
      { ...f.config, botId: "0" },
      { ...f.config, publicKeyDigest: "bad" },
      { ...f.config, socketGroupId: 0 },
    ]) {
      write(invalid)
      expect(() => loadSanctuaryTelegramAuthorityConfig(f.configPath, { expectedUid: uid })).toThrow(/configuration/u)
    }
    write(f.config)
    fs.mkdirSync(path.dirname(f.config.lockPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(f.config.lockPath, "not-a-pid", { mode: 0o600 })
    expect(fs.readFileSync(f.config.lockPath, "utf8")).toBe("not-a-pid")
    fs.chmodSync(f.config.lockPath, 0o644)
    await expect(startSanctuaryTelegramAuthority({
      configPath: f.configPath,
      expectedUid: uid,
      processAlive: () => false,
    })).rejects.toThrow(/private/u)
  })

  it("bounds root-owned Telegram file downloads before buffering", async () => {
    const f = fixture()
    const uid = process.getuid?.() ?? 0
    let createServerOptions: any
    const fetch = vi.fn(async () => new Response(Buffer.from("data"), {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": "4" },
    }))
    const authority = await startSanctuaryTelegramAuthority({
      configPath: f.configPath,
      expectedUid: uid,
      createApi: () => ({
        request: vi.fn(async (method: string) => method === "getMe"
          ? { id: 123456 }
          : method === "getFile"
            ? { file_path: "documents/file.bin", file_size: 4 }
            : []),
        stop: vi.fn(),
      }),
      createServer: (options) => {
        createServerOptions = options
        return { listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }
      },
      fetch,
    })
    createServerOptions.gateway.capture([{
      update_id: 1,
      message: {
        message_id: 2,
        from: { id: 42 },
        chat: { id: 42, type: "private" },
        document: { file_id: "file-1" },
      },
    }])
    await createServerOptions.service.dispatch("telegram.request", { method: "getFile", body: { file_id: "file-1" } })
    await expect(createServerOptions.service.dispatch("telegram.file", { filePath: "documents/file.bin" })).resolves.toEqual({
      bodyBase64: Buffer.from("data").toString("base64"),
      contentType: "application/octet-stream",
    })
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bot123456:abcdefghijklmnopqrstuvwxyz/documents/file.bin",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    fetch.mockResolvedValueOnce(new Response("no", { status: 500 }))
    await expect(createServerOptions.service.dispatch("telegram.file", { filePath: "documents/file.bin" })).rejects.toThrow(/HTTP 500/u)
    fetch.mockResolvedValueOnce(new Response("x", { status: 200, headers: { "content-length": "20000001" } }))
    await expect(createServerOptions.service.dispatch("telegram.file", { filePath: "documents/file.bin" })).rejects.toThrow(/limit/u)
    fetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    await expect(createServerOptions.service.dispatch("telegram.file", { filePath: "documents/file.bin" })).rejects.toThrow(/empty/u)
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(20_000_001)) },
      cancel() { throw new Error("cancel failed") },
    }), { status: 200 }))
    await expect(createServerOptions.service.dispatch("telegram.file", { filePath: "documents/file.bin" })).rejects.toThrow(/limit/u)
    fetch.mockResolvedValueOnce(new Response(Buffer.from("data"), { status: 200 }))
    await expect(createServerOptions.service.dispatch("telegram.file", { filePath: "documents/file.bin" })).resolves.toEqual({
      bodyBase64: Buffer.from("data").toString("base64"),
    })
    await authority.close()
  })

  it("uses the default Bot API and socket owners and removes a stale singleton", async () => {
    const f = fixture()
    const uid = process.getuid?.() ?? 0
    fs.mkdirSync(path.dirname(f.config.lockPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(f.config.lockPath, "99999999", { mode: 0o600 })
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({
      ok: true,
      result: url.endsWith("/getMe") ? { id: 123456 } : [],
    }), { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const authority = await startSanctuaryTelegramAuthority({
      configPath: f.configPath,
      expectedUid: uid,
    })
    expect(fs.statSync(f.config.socketPath).isSocket()).toBe(true)
    const client = new SocketSanctuaryTelegramAuthorityClient(f.config.socketPath)
    await expect(client.request("telegram.cursor", {})).resolves.toEqual({ cursor: 0 })
    client.close()
    await authority.close()
    vi.unstubAllGlobals()
  })

  it("applies root socket ownership when running as uid zero", async () => {
    const f = fixture()
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0)
    const chown = vi.fn()
    const chmod = vi.fn()
    try {
      const privateKey = fs.readFileSync(f.config.privateKeyPath, "utf8")
      const authority = await startSanctuaryTelegramAuthority({
        configPath: f.configPath,
        expectedUid: 0,
        loadConfig: () => f.config,
        readPrivateText: (filePath) => filePath === f.config.tokenPath ? "123456:abcdefghijklmnopqrstuvwxyz" : privateKey,
        createApi: () => ({ request: vi.fn(async () => ({ id: 123456 })), stop: vi.fn() }),
        createServer: () => ({ listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }),
        createHostExecutor: () => ({ execute: vi.fn() }),
        chown,
        chmod,
      })
      expect(chown).toHaveBeenCalledWith(path.dirname(f.config.socketPath), 0, 10001)
      expect(chown).toHaveBeenCalledWith(f.config.socketPath, 0, 10001)
      expect(chmod).toHaveBeenCalledWith(path.dirname(f.config.socketPath), 0o750)
      expect(chmod).toHaveBeenCalledWith(f.config.socketPath, 0o660)
      await authority.close()
      vi.spyOn(fs, "chownSync").mockImplementation(chown)
      vi.spyOn(fs, "chmodSync").mockImplementation(chmod)
      const defaults = await startSanctuaryTelegramAuthority({
        configPath: f.configPath,
        loadConfig: () => f.config,
        readPrivateText: (filePath) => filePath === f.config.tokenPath ? "123456:abcdefghijklmnopqrstuvwxyz" : privateKey,
        createApi: () => ({ request: vi.fn(async () => ({ id: 123456 })), stop: vi.fn() }),
        createServer: () => ({ listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }),
        createHostExecutor: () => ({ execute: vi.fn() }),
      })
      await defaults.close()
    } finally {
      getuid.mockRestore()
    }
  })

  it("closes partial startup and refuses invalid token or failed socket startup", async () => {
    const f = fixture()
    const uid = process.getuid?.() ?? 0
    fs.writeFileSync(f.config.tokenPath, "invalid", { mode: 0o600 })
    await expect(startSanctuaryTelegramAuthority({ configPath: f.configPath, expectedUid: uid })).rejects.toThrow(/token/u)
    expect(fs.existsSync(f.config.lockPath)).toBe(false)

    fs.writeFileSync(f.config.tokenPath, "123456:abcdefghijklmnopqrstuvwxyz", { mode: 0o600 })
    const api = { request: vi.fn(async () => ({ id: 123456 })), stop: vi.fn() }
    const close = vi.fn(async () => { throw new Error("close failed") })
    await expect(startSanctuaryTelegramAuthority({
      configPath: f.configPath,
      expectedUid: uid,
      createApi: () => api,
      createServer: () => ({ listen: vi.fn(async () => { throw new Error("listen failed") }), close }),
    })).rejects.toThrow("listen failed")
    expect(close).toHaveBeenCalledOnce()
    expect(api.stop).toHaveBeenCalledOnce()
    expect(fs.existsSync(f.config.lockPath)).toBe(false)
  })

  it("reconciles a durable terminal receipt before readiness and preserves the live observation resolver", async () => {
    const f = fixture()
    const uid = process.getuid?.() ?? 0
    let nonce = 0
    const privateKey = f.keys.privateKey
    const gateway = new FileSanctuaryTelegramAuthorityGateway(f.config.agentRoot, {
      targetHost: f.config.targetHost,
      botId: f.config.botId,
      ownerUserId: f.config.ownerUserId,
      ownerChatId: f.config.ownerChatId,
      keyId: f.config.keyId,
      publicKeyDigest: f.config.publicKeyDigest,
      privateKey,
      now: () => "2026-09-16T22:00:00.000Z",
      nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
    })
    gateway.capture([{
      update_id: 1,
      message: { message_id: 101, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "approve" },
    }])
    const observation = gateway.poll()!
    const hostAuthority = new FileSanctuaryHostAuthority(f.config.agentRoot, {
      targetHost: f.config.targetHost,
      botId: f.config.botId,
      ownerUserId: f.config.ownerUserId,
      ownerChatId: f.config.ownerChatId,
      keyId: f.config.keyId,
      publicKeyDigest: f.config.publicKeyDigest,
      publicKey: f.keys.publicKey,
      privateKey,
      now: () => "2026-09-16T22:00:00.000Z",
      nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
      resolveOwnerObservation: (input) => gateway.ownerObservation(input),
    })
    const prepared = hostAuthority.prepare({
      targetHost: "sanctuary",
      targetResource: "host",
      command: { kind: "executable", executable: "/usr/bin/id", arguments: ["-u"] },
      workingDirectoryProfile: "host.root.v1",
      environmentProfile: "host.clean.v1",
      timeoutMs: 60_000,
      ownerObservation: {
        updateId: 1,
        digest: authorityArtifactDigest(observation.domain, observation.payload),
        userId: "42",
        chatId: "42",
        messageId: "101",
      },
      verification: null,
    })
    hostAuthority.commit({ registrationId: prepared.registrationId, telegramMessageId: 501 })
    hostAuthority.decide({
      callbackQueryId: "callback-1",
      callbackData: prepared.replyMarkup.inline_keyboard[0]![0]!.callback_data,
      telegramMessageId: 501,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"d".repeat(64)}`,
      decidedAt: "2026-09-16T22:00:00.000Z",
    })
    const permit = hostAuthority.issuePermit({
      registrationId: prepared.registrationId,
      residentFriendId: "friend",
      relationshipProfileId: "owner",
      relationshipProfileVersion: 1,
      requestId: "request",
      sessionKey: "session",
      sessionEventId: "event",
      residentApprovalId: "approval",
      stewardPolicy: null,
    })
    const receipt = signAuthorityPayload({
      domain: "ouro.sanctuary.host-receipt.v1",
      keyId: f.config.keyId,
      privateKey: f.keys.privateKey,
      payload: {
        targetHost: f.config.targetHost,
        registrationId: prepared.registrationId,
        permitId: permit.payload.permitId,
        permitDigest: authorityArtifactDigest(permit.domain, permit.payload),
        state: "verified",
        startedAt: "2026-09-16T22:00:00.000Z",
        completedAt: "2026-09-16T22:00:01.000Z",
        publicKeyDigest: f.config.publicKeyDigest,
      },
    })
    const alreadySettledReceipt = signAuthorityPayload({
      domain: receipt.domain,
      keyId: receipt.keyId,
      privateKey: f.keys.privateKey,
      payload: {
        ...receipt.payload,
        registrationId: `hostreg-${"z".repeat(43)}`,
        permitId: `permit-${"y".repeat(43)}`,
      },
    })
    const acknowledge = vi.fn()
    let serverOptions: any
    const api = {
      request: vi.fn(async (method: string) => method === "getMe"
        ? { id: 123456 }
        : method === "sendMessage"
          ? { message_id: 502 }
          : []),
      stop: vi.fn(),
    }
    const authority = await startSanctuaryTelegramAuthority({
      configPath: f.configPath,
      expectedUid: uid,
      createApi: () => api,
      createHostExecutor: () => ({
        execute: vi.fn(),
        reconcile: vi.fn(async () => [receipt]),
        acknowledge,
      }),
      createServer: (options) => {
        serverOptions = options
        return { listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }
      },
      setSocketOwnership: vi.fn(),
      now: () => "2026-09-16T22:00:00.000Z",
    })
    expect(acknowledge).toHaveBeenCalledWith(permit.payload.permitId)
    expect(acknowledge).toHaveBeenCalledOnce()
    expect(hostAuthority.status(prepared.registrationId)).toMatchObject({ state: "executed" })

    gateway.settle({
      updateId: 1,
      observationDigest: authorityArtifactDigest(observation.domain, observation.payload),
      outcome: "completed",
    })
    serverOptions.gateway.capture([{
      update_id: 2,
      message: { message_id: 102, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "approve next" },
    }])
    const next = serverOptions.gateway.poll()
    await expect(serverOptions.service.dispatch("host.approval", {
      proposal: {
        targetHost: "sanctuary",
        targetResource: "host",
        command: { kind: "executable", executable: "/usr/bin/id", arguments: [] },
        workingDirectoryProfile: "host.root.v1",
        environmentProfile: "host.clean.v1",
        timeoutMs: 60_000,
        ownerObservation: {
          updateId: 2,
          digest: authorityArtifactDigest(next.domain, next.payload),
          userId: "42",
          chatId: "42",
          messageId: "102",
        },
        verification: null,
      },
    })).resolves.toMatchObject({ telegramMessageId: 502 })
    await authority.close()

    acknowledge.mockClear()
    const restarted = await startSanctuaryTelegramAuthority({
      configPath: f.configPath,
      expectedUid: uid,
      createApi: () => api,
      createHostExecutor: () => ({
        execute: vi.fn(),
        reconcile: vi.fn(async () => [receipt]),
        acknowledge,
      }),
      createServer: () => ({ listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }),
      setSocketOwnership: vi.fn(),
      now: () => "2026-09-17T00:00:00.000Z",
    })
    expect(acknowledge).toHaveBeenCalledWith(permit.payload.permitId)
    await restarted.close()

    acknowledge.mockClear()
    await expect(startSanctuaryTelegramAuthority({
      configPath: f.configPath,
      expectedUid: uid,
      createApi: () => api,
      createHostExecutor: () => ({
        execute: vi.fn(),
        reconcile: vi.fn(async () => [alreadySettledReceipt]),
        acknowledge,
      }),
      createServer: () => ({ listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }),
      setSocketOwnership: vi.fn(),
      now: () => "2026-09-17T00:00:00.000Z",
    })).rejects.toThrow(/not incorporated/u)
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it("runs the CLI contract and closes on either termination signal", async () => {
    await expect(runSanctuaryTelegramAuthorityCli({ argv: ["node", "entry"] })).rejects.toThrow(/--config/u)
    const originalArgv = process.argv
    process.argv = ["node", "entry"]
    await expect(runSanctuaryTelegramAuthorityCli()).rejects.toThrow(/--config/u)
    process.argv = originalArgv
    const close = vi.fn(async () => undefined)
    const retire = vi.fn(async () => undefined)
    const start = vi.fn(async () => ({ close, retire }))
    const listeners = new Map<string, () => void>()
    const exit = vi.fn()
    await runSanctuaryTelegramAuthorityCli({
      argv: ["node", "entry", "--config", "/root/authority.json"],
      start,
      once: (event, listener) => { listeners.set(event, listener) },
      exit,
    })
    expect(start).toHaveBeenCalledWith({ configPath: "/root/authority.json" })
    listeners.get("SIGTERM")!()
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(exit).toHaveBeenCalledWith(0)
    listeners.get("SIGINT")!()
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2))

    await expect(runSanctuaryTelegramAuthorityCli({
      argv: ["node", "entry", "--config", "/missing/config.json"],
    })).rejects.toThrow()

    const processOnce = vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
      listeners.set("default", listener)
      listeners.set(event, listener)
      return process
    }) as never)
    const processExit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    await runSanctuaryTelegramAuthorityCli({
      argv: ["node", "entry", "--config", "/root/authority.json"],
      start,
    })
    listeners.get("default")!()
    await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(0))
    listeners.get("SIGTERM")!()
    await vi.waitFor(() => expect(processExit).toHaveBeenCalledTimes(2))
    retire.mockRejectedValue(new Error("cleanup unproven"))
    listeners.get("SIGUSR2")!()
    await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(1))
    await runSanctuaryTelegramAuthorityCli({
      argv: ["node", "entry", "--config", "/root/authority.json", "--retire-only"], start,
      once: (event, listener) => { listeners.set(event, listener) }, exit,
    })
    expect(start).toHaveBeenLastCalledWith({ configPath: "/root/authority.json", retireOnly: true })
    listeners.get("SIGUSR2")!()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    retire.mockResolvedValue(undefined)
    listeners.get("SIGUSR2")!()
    await vi.waitFor(() => expect(exit.mock.calls.filter(([code]) => code === 0).length).toBeGreaterThan(2))
    processOnce.mockRestore()
    processExit.mockRestore()
  })
})
