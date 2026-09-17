#!/usr/bin/env node
import { createPrivateKey, createPublicKey } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

import { createTelegramBotApi, type TelegramBotApi } from "../../senses/telegram-client"
import { FileSanctuaryTelegramAuthorityGateway, sanctuaryTelegramAuthorityStatePath } from "./sanctuary-telegram-authority-gateway"
import { FileSanctuaryHostAuthority } from "./sanctuary-host-authority"
import { FileSanctuaryAuthorityLedger } from "./sanctuary-authority-ledger"
import { authorityArtifactDigest, type SignedAuthorityPayload } from "./sanctuary-authority-codec"
import { DetachedSanctuaryHostSupervisor } from "./sanctuary-host-detached-supervisor"
import { SanctuaryHostPermitExecutor } from "./sanctuary-host-executor"
import { verifySanctuaryAuthorityInstallation } from "./sanctuary-authority-installation"
import { readSanctuaryAuthorityEpoch } from "./sanctuary-authority-epoch"
import {
  createSanctuaryTelegramAuthorityServer,
  SanctuaryTelegramAuthorityService,
  type SanctuaryTelegramAuthorityServer,
} from "./sanctuary-telegram-authority-service"

const MAX_PRIVATE_FILE_BYTES = 64 * 1024
const MAX_ATTACHMENT_BYTES = 20_000_000

export interface SanctuaryTelegramAuthorityConfig {
  schemaVersion: 1
  agentRoot: string
  targetHost: string
  botId: string
  ownerUserId: string
  ownerChatId: string
  keyId: string
  publicKeyDigest: string
  tokenPath: string
  privateKeyPath: string
  socketPath: string
  socketGroupId: number
  readinessPath: string
  lockPath: string
  hostStagingRoot: string
  hostExecutionStateRoot: string
  hostSupervisorStateRoot: string
  hostCgroupRoot: string
  hostSupervisorProgramPath: string
  hostSupervisorProgramDigest: string
  hostLauncherPath: string
  hostLauncherDigest: string
  hostPrlimitPath: string
  hostPrlimitDigest: string
  hostSetsidPath: string
  hostSetsidDigest: string
  hostShellPath: string
  hostShellDigest: string
  epochRoot: string
  packageRoot: string
  packageManifestPath: string
  packageManifestDigest: string
}

export interface SanctuaryTelegramAuthorityProcess {
  close(): Promise<void>
  retire(): Promise<void>
}

interface StartOptions {
  configPath: string
  retireOnly?: boolean
  expectedUid?: number
  createApi?: (token: string) => TelegramBotApi
  createServer?: (options: {
    socketPath: string
    service: SanctuaryTelegramAuthorityService
    gateway: FileSanctuaryTelegramAuthorityGateway
  }) => SanctuaryTelegramAuthorityServer
  fetch?: typeof globalThis.fetch
  now?: () => string
  processAlive?: (pid: number) => boolean
  setSocketOwnership?: (config: SanctuaryTelegramAuthorityConfig) => void
  loadConfig?: (configPath: string, expectedUid: number) => SanctuaryTelegramAuthorityConfig
  readPrivateText?: (filePath: string, expectedUid: number) => string
  createHostExecutor?: (input: {
    config: SanctuaryTelegramAuthorityConfig
    privateKey: ReturnType<typeof createPrivateKey>
    publicKey: ReturnType<typeof createPublicKey>
    expectedUid: number
  }) => {
    execute: SanctuaryHostPermitExecutor["execute"]
    reconcile?: SanctuaryHostPermitExecutor["reconcile"]
    acknowledge?: SanctuaryHostPermitExecutor["acknowledge"]
    isHealthy?: SanctuaryHostPermitExecutor["isHealthy"]
  }
  chown?: typeof fs.chownSync
  chmod?: typeof fs.chmodSync
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function readPrivateFile(filePath: string, expectedUid: number): string {
  if (!path.isAbsolute(filePath)) throw new Error("Sanctuary Telegram authority private path must be absolute")
  const handle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(handle)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== expectedUid || stat.gid !== (expectedUid === 0 ? 0 : process.getgid!())
      || (stat.mode & 0o7777) !== 0o600 || fs.realpathSync(filePath) !== filePath || stat.size < 1 || stat.size > MAX_PRIVATE_FILE_BYTES) throw new Error("Sanctuary Telegram authority private file is unsafe")
    return fs.readFileSync(handle, "utf8")
  } finally {
    fs.closeSync(handle)
  }
}

export function loadSanctuaryTelegramAuthorityConfig(
  configPath: string,
  options: { expectedUid?: number } = {},
): SanctuaryTelegramAuthorityConfig {
  const expectedUid = options.expectedUid ?? 0
  const value = JSON.parse(readPrivateFile(configPath, expectedUid)) as unknown
  const keys = [
    "schemaVersion", "agentRoot", "targetHost", "botId", "ownerUserId", "ownerChatId", "keyId",
    "publicKeyDigest", "tokenPath", "privateKeyPath", "socketPath", "socketGroupId", "readinessPath", "lockPath",
    "hostStagingRoot", "hostExecutionStateRoot", "hostSupervisorStateRoot", "hostCgroupRoot", "hostSupervisorProgramPath",
    "hostSupervisorProgramDigest", "hostLauncherPath", "hostLauncherDigest", "hostPrlimitPath",
    "hostPrlimitDigest", "hostSetsidPath", "hostSetsidDigest",
    "hostShellPath", "hostShellDigest",
    "epochRoot", "packageRoot", "packageManifestPath", "packageManifestDigest",
  ]
  if (
    !isObject(value)
    || !exactKeys(value, keys)
    || value.schemaVersion !== 1
    || ![
      "agentRoot", "tokenPath", "privateKeyPath", "socketPath", "readinessPath", "lockPath",
      "hostStagingRoot", "hostExecutionStateRoot", "hostSupervisorStateRoot", "hostCgroupRoot", "hostSupervisorProgramPath",
      "hostLauncherPath", "hostPrlimitPath", "hostSetsidPath",
      "hostShellPath",
      "epochRoot", "packageRoot", "packageManifestPath",
    ]
      .every((key) => typeof value[key] === "string" && path.isAbsolute(value[key] as string))
    || !["targetHost", "keyId"].every((key) => typeof value[key] === "string" && (value[key] as string).length > 0)
    || !["botId", "ownerUserId", "ownerChatId"].every((key) => typeof value[key] === "string" && /^[1-9][0-9]*$/u.test(value[key] as string))
    || typeof value.publicKeyDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.publicKeyDigest)
    || !["hostSupervisorProgramDigest", "hostLauncherDigest", "hostPrlimitDigest", "hostSetsidDigest", "hostShellDigest", "packageManifestDigest"]
      .every((key) => typeof value[key] === "string" && /^sha256:[a-f0-9]{64}$/u.test(value[key] as string))
    || !Number.isSafeInteger(value.socketGroupId)
    || (value.socketGroupId as number) < 1
  ) {
    throw new Error("Sanctuary Telegram authority configuration is invalid")
  }
  readPrivateFile(value.tokenPath as string, expectedUid)
  readPrivateFile(value.privateKeyPath as string, expectedUid)
  return value as unknown as SanctuaryTelegramAuthorityConfig
}

function privateDirectory(directory: string, mode: number): void {
  fs.mkdirSync(directory, { recursive: true, mode })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || fs.realpathSync(directory) !== directory || (stat.mode & 0o7777) !== mode) throw new Error("Sanctuary Telegram authority directory is unsafe")
}

function writePrivateJson(filePath: string, value: unknown, mode = 0o600): void {
  const directoryMode = mode === 0o600 ? 0o700 : 0o750
  privateDirectory(path.dirname(filePath), directoryMode)
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  const handle = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
  try {
    try {
      fs.writeFileSync(handle, `${JSON.stringify(value)}\n`, "utf8")
      fs.fsyncSync(handle)
    } finally { fs.closeSync(handle) }
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    fs.unlinkSync(temporaryPath)
    throw error
  }
  fs.chmodSync(filePath, mode)
  const directory = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}

function acquireProcessLock(
  lockPath: string,
  expectedUid: number,
  processAlive: (pid: number) => boolean,
): () => void {
  privateDirectory(path.dirname(lockPath), 0o700)
  try {
    const existing = readPrivateFile(lockPath, expectedUid).trim()
    const pid = Number(existing)
    if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) {
      throw new Error("Sanctuary Telegram authority is already running")
    }
    fs.unlinkSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof Error && error.message.includes("already running")) throw error
      throw error
    }
  }
  const handle = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
  fs.writeFileSync(handle, String(process.pid), "utf8")
  fs.fsyncSync(handle)
  fs.closeSync(handle)
  return () => fs.rmSync(lockPath, { force: true })
}

async function readBoundedFileResponse(response: Response): Promise<{ body: Buffer; contentType?: string }> {
  if (!response.ok) throw new Error(`Sanctuary Telegram file download failed with HTTP ${response.status}`)
  const advertised = Number(response.headers.get("content-length"))
  if (Number.isFinite(advertised) && advertised > MAX_ATTACHMENT_BYTES) {
    throw new Error("Sanctuary Telegram file download exceeds its limit")
  }
  if (!response.body) throw new Error("Sanctuary Telegram file download is empty")
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_ATTACHMENT_BYTES) throw new Error("Sanctuary Telegram file download exceeds its limit")
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const contentType = response.headers.get("content-type")
  return { body: Buffer.concat(chunks, total), ...(contentType ? { contentType } : {}) }
}

export async function startSanctuaryTelegramAuthority(options: StartOptions): Promise<SanctuaryTelegramAuthorityProcess> {
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_authority_boot_requested", message: "Sanctuary authority boot requested; prerequisite verification pending" })
  const expectedUid = options.expectedUid ?? 0
  if ((process.getuid as () => number)() !== expectedUid) {
    throw new Error("Sanctuary Telegram authority must run as the configured root owner")
  }
  const config = options.loadConfig
    ? options.loadConfig(options.configPath, expectedUid)
    : loadSanctuaryTelegramAuthorityConfig(options.configPath, { expectedUid })
  const expectedGid = expectedUid === 0 ? 0 : (process.getgid as () => number)()
  verifySanctuaryAuthorityInstallation({
    packageRoot: config.packageRoot, manifestPath: config.packageManifestPath, manifestDigest: config.packageManifestDigest,
    stateRoot: config.epochRoot, stagingRoot: config.hostStagingRoot, socketRoot: path.dirname(config.socketPath),
    cgroupRoot: config.hostCgroupRoot, expectedUid, expectedGid, socketGroupId: config.socketGroupId,
  })
  const epoch = readSanctuaryAuthorityEpoch(config.epochRoot, { expectedUid, expectedGid })
  if (epoch.state !== "prepared" || epoch.epochId !== config.keyId || epoch.botId !== config.botId
    || epoch.ownerUserId !== config.ownerUserId || epoch.ownerChatId !== config.ownerChatId || epoch.publicKeyDigest !== config.publicKeyDigest
    || epoch.tokenPath !== config.tokenPath || epoch.packageDigest !== config.packageManifestDigest) throw new Error("Sanctuary authority epoch is retired or does not match its installation")
  if (!options.retireOnly && fs.existsSync(path.join(config.epochRoot, "retiring.json"))) throw new Error("Sanctuary authority retirement must finish before restart")
  const readPrivateText = options.readPrivateText ?? readPrivateFile
  const processAlive = options.processAlive ?? ((pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  })
  const releaseLock = acquireProcessLock(config.lockPath, expectedUid, processAlive)
  let api: TelegramBotApi | undefined
  let server: SanctuaryTelegramAuthorityServer | undefined
  let service: SanctuaryTelegramAuthorityService | undefined
  let closed = false
  try {
    const token = readPrivateText(config.tokenPath, expectedUid).trim()
    if (!/^[1-9][0-9]*:[A-Za-z0-9_-]{20,}$/u.test(token)) {
      throw new Error("Sanctuary Telegram authority token is invalid")
    }
    const privateKey = createPrivateKey(readPrivateText(config.privateKeyPath, expectedUid))
    const publicKey = createPublicKey(privateKey)
    if (!options.retireOnly) {
      api = (options.createApi ?? ((value) => createTelegramBotApi({ token: value })))(token)
      const identity = await api.request<{ id?: unknown }>("getMe", {})
      if (!isObject(identity) || String(identity.id) !== config.botId) {
        throw new Error("Sanctuary Telegram authority bot identity changed")
      }
    }
    const gateway = new FileSanctuaryTelegramAuthorityGateway(config.agentRoot, {
      targetHost: config.targetHost,
      botId: config.botId,
      ownerUserId: config.ownerUserId,
      ownerChatId: config.ownerChatId,
      keyId: config.keyId,
      publicKeyDigest: config.publicKeyDigest,
      privateKey,
      now: options.now,
    })
    if (!fs.existsSync(sanctuaryTelegramAuthorityStatePath(config.agentRoot))) throw new Error("Sanctuary authority cursor state is absent")
    if (gateway.cursor() < epoch.predecessorCursor) throw new Error("Sanctuary authority cursor precedes its epoch")
    const hostAuthority = new FileSanctuaryHostAuthority(config.agentRoot, {
      targetHost: config.targetHost,
      botId: config.botId,
      ownerUserId: config.ownerUserId,
      ownerChatId: config.ownerChatId,
      keyId: config.keyId,
      publicKeyDigest: config.publicKeyDigest,
      publicKey,
      privateKey,
      now: options.now,
      resolveOwnerObservation: (input) => gateway.ownerObservation(input),
    })
    hostAuthority.reconcilePrepared()
    const hostExecutor = options.createHostExecutor?.({ config, privateKey, publicKey, expectedUid }) ?? (() => {
      const hostSupervisor = new DetachedSanctuaryHostSupervisor({
        stateRoot: config.hostSupervisorStateRoot,
        cgroupRoot: config.hostCgroupRoot,
        programPath: config.hostSupervisorProgramPath,
        programDigest: config.hostSupervisorProgramDigest,
        launcherPath: config.hostLauncherPath,
        launcherDigest: config.hostLauncherDigest,
        prlimitPath: config.hostPrlimitPath,
        prlimitDigest: config.hostPrlimitDigest,
        setsidPath: config.hostSetsidPath,
        setsidDigest: config.hostSetsidDigest,
        shellPath: config.hostShellPath,
        shellDigest: config.hostShellDigest,
        expectedUid,
        keyId: config.keyId,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      })
      return new SanctuaryHostPermitExecutor({
        ledger: new FileSanctuaryAuthorityLedger(config.agentRoot),
        expectedTargetHost: config.targetHost,
        expectedOwnerUserId: config.ownerUserId,
        expectedOwnerChatId: config.ownerChatId,
        expectedKeyId: config.keyId,
        expectedPublicKeyDigest: config.publicKeyDigest,
        publicKey,
        privateKey,
        stagingRoot: config.hostStagingRoot,
        stateRoot: config.hostExecutionStateRoot,
        supervisor: hostSupervisor,
        now: options.now,
      })
    })()
    async function reconcileExecutions() {
      for (const receipt of await hostExecutor.reconcile?.() ?? []) {
      const registrationId = String(receipt.payload.registrationId)
      const status = hostAuthority.status(registrationId)
      if (status?.state === "permitted") {
        hostAuthority.completeExecution(registrationId, receipt)
      } else if (
        status?.state !== "executed"
        || !sameSignedReceipt(status.receipt, receipt)
      ) {
        throw new Error("Sanctuary host execution receipt is not incorporated into authority state")
      }
        hostExecutor.acknowledge?.(String(receipt.payload.permitId))
      }
    }
    const ledger = new FileSanctuaryAuthorityLedger(config.agentRoot)
    const control: SanctuaryTelegramAuthorityProcess = {
      close: async () => {
        if (closed) return
        closed = true
        fs.rmSync(config.readinessPath, { force: true })
        await server?.close()
        api?.stop()
        releaseLock()
      },
      retire: async () => {
        writePrivateJson(path.join(config.epochRoot, "retiring.json"), { schemaVersion: 1, keyId: config.keyId })
        fs.rmSync(config.readinessPath, { force: true })
        await server?.close()
        server = undefined
        await service?.drainHostExecutions()
        api?.stop()
        api = undefined
        hostAuthority.retireRegistrations(ledger)
        await reconcileExecutions()
        if (hostAuthority.retireRegistrations(ledger).length !== 0
          || fs.readdirSync(config.hostCgroupRoot).some((entry) => fs.lstatSync(path.join(config.hostCgroupRoot, entry)).isDirectory())) throw new Error("Sanctuary authority retirement cleanup is unproven")
        writePrivateJson(path.join(config.epochRoot, "retirement.json"), {
          schemaVersion: 1, keyId: config.keyId, publicKeyDigest: config.publicKeyDigest,
          cursor: gateway.cursor(), quiescent: true,
        })
        await control.close()
      },
    }
    if (options.retireOnly) {
      await control.retire()
      return control
    }
    await reconcileExecutions()

    function sameSignedReceipt(
      left: unknown,
      right: SignedAuthorityPayload<Record<string, unknown>>,
    ): boolean {
      return isObject(left)
        && typeof left.domain === "string"
        && typeof left.keyId === "string"
        && typeof left.signature === "string"
        && isObject(left.payload)
        && left.domain === right.domain
        && left.keyId === right.keyId
        && left.signature === right.signature
        && authorityArtifactDigest(left.domain, left.payload) === authorityArtifactDigest(right.domain, right.payload)
    }
    const fetchImpl = options.fetch ?? globalThis.fetch
    service = new SanctuaryTelegramAuthorityService({
      api: api!,
      gateway,
      hostAuthority,
      hostExecutor,
      downloadFile: async (filePath) => readBoundedFileResponse(await fetchImpl(
        `https://api.telegram.org/file/bot${token}/${filePath}`,
        { signal: AbortSignal.timeout(30_000) },
      )),
    })
    server = (options.createServer ?? ((value) => createSanctuaryTelegramAuthorityServer({
      socketPath: value.socketPath,
      dispatch: (method, params) => value.service.dispatch(method, params),
    })))({ socketPath: config.socketPath, service, gateway })
    await server.listen()
    const residentPinsPath = path.join(path.dirname(config.socketPath), "resident.json")
    writePrivateJson(residentPinsPath, {
      schemaVersion: 1, ...gateway.identity(), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    }, 0o640)
    if (options.setSocketOwnership) {
      options.setSocketOwnership(config)
    } else if (expectedUid === 0) {
      ;(options.chown ?? fs.chownSync)(path.dirname(config.socketPath), 0, config.socketGroupId)
      ;(options.chmod ?? fs.chmodSync)(path.dirname(config.socketPath), 0o750)
      ;(options.chown ?? fs.chownSync)(config.socketPath, 0, config.socketGroupId)
      ;(options.chmod ?? fs.chmodSync)(config.socketPath, 0o660)
      ;(options.chown ?? fs.chownSync)(residentPinsPath, 0, config.socketGroupId)
    }
    const startedAt = options.now?.() ?? new Date().toISOString()
    writePrivateJson(config.readinessPath, {
      schemaVersion: 1,
      status: "ready",
      botId: config.botId,
      socketPath: config.socketPath,
      publicKeyDigest: config.publicKeyDigest,
      startedAt,
    })
    return control
  } catch (error) {
    await server?.close().catch(() => undefined)
    api?.stop()
    fs.rmSync(config.readinessPath, { force: true })
    releaseLock()
    throw error
  }
}

export async function runSanctuaryTelegramAuthorityCli(options: {
  argv?: string[]
  start?: typeof startSanctuaryTelegramAuthority
  once?: (event: "SIGINT" | "SIGTERM" | "SIGUSR2", listener: () => void) => void
  exit?: (code: number) => void
} = {}): Promise<void> {
  const argv = options.argv ?? process.argv
  const configIndex = argv.indexOf("--config")
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : undefined
  if (!configPath) throw new Error("Sanctuary Telegram authority requires --config")
  const authority = await (options.start ?? startSanctuaryTelegramAuthority)({ configPath, ...(argv.includes("--retire-only") ? { retireOnly: true } : {}) })
  const close = async () => {
    await authority.close()
    const exit = options.exit ?? process.exit
    exit(0)
  }
  const once = options.once ?? ((event, listener) => { process.once(event, listener) })
  once("SIGINT", () => { void close() })
  once("SIGTERM", () => { void close() })
  once("SIGUSR2", () => {
    void authority.retire().then(() => (options.exit ?? process.exit)(0)).catch(() => (options.exit ?? process.exit)(1))
  })
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === __filename) {
  void runSanctuaryTelegramAuthorityCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Sanctuary Telegram authority failed"}\n`)
    process.exitCode = 1
  })
}
