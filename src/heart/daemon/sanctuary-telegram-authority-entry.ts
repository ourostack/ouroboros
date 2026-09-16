#!/usr/bin/env node
import { createPrivateKey } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { createTelegramBotApi, type TelegramBotApi } from "../../senses/telegram-client"
import { FileSanctuaryTelegramAuthorityGateway } from "./sanctuary-telegram-authority-gateway"
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
}

export interface SanctuaryTelegramAuthorityProcess {
  close(): Promise<void>
}

interface StartOptions {
  configPath: string
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
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600
    || stat.size < 1 || stat.size > MAX_PRIVATE_FILE_BYTES) {
    throw new Error("Sanctuary Telegram authority private file is unsafe")
  }
  const handle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
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
  ]
  if (
    !isObject(value)
    || !exactKeys(value, keys)
    || value.schemaVersion !== 1
    || !["agentRoot", "tokenPath", "privateKeyPath", "socketPath", "readinessPath", "lockPath"]
      .every((key) => typeof value[key] === "string" && path.isAbsolute(value[key] as string))
    || !["targetHost", "keyId"].every((key) => typeof value[key] === "string" && (value[key] as string).length > 0)
    || !["botId", "ownerUserId", "ownerChatId"].every((key) => typeof value[key] === "string" && /^[1-9][0-9]*$/u.test(value[key] as string))
    || typeof value.publicKeyDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.publicKeyDigest)
    || !Number.isSafeInteger(value.socketGroupId)
    || (value.socketGroupId as number) < 1
  ) {
    throw new Error("Sanctuary Telegram authority configuration is invalid")
  }
  readPrivateFile(value.tokenPath as string, expectedUid)
  readPrivateFile(value.privateKeyPath as string, expectedUid)
  return value as unknown as SanctuaryTelegramAuthorityConfig
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(filePath), 0o700)
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  const handle = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value)}\n`, "utf8")
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  fs.renameSync(temporaryPath, filePath)
  fs.chmodSync(filePath, 0o600)
}

function acquireProcessLock(
  lockPath: string,
  expectedUid: number,
  processAlive: (pid: number) => boolean,
): () => void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(lockPath), 0o700)
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
  const expectedUid = options.expectedUid ?? 0
  if ((process.getuid as () => number)() !== expectedUid) {
    throw new Error("Sanctuary Telegram authority must run as the configured root owner")
  }
  const config = options.loadConfig
    ? options.loadConfig(options.configPath, expectedUid)
    : loadSanctuaryTelegramAuthorityConfig(options.configPath, { expectedUid })
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
  let closed = false
  try {
    const token = readPrivateText(config.tokenPath, expectedUid).trim()
    if (!/^[1-9][0-9]*:[A-Za-z0-9_-]{20,}$/u.test(token)) {
      throw new Error("Sanctuary Telegram authority token is invalid")
    }
    const privateKey = createPrivateKey(readPrivateText(config.privateKeyPath, expectedUid))
    api = (options.createApi ?? ((value) => createTelegramBotApi({ token: value })))(token)
    const identity = await api.request<{ id?: unknown }>("getMe", {})
    if (!isObject(identity) || String(identity.id) !== config.botId) {
      throw new Error("Sanctuary Telegram authority bot identity changed")
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
    const fetchImpl = options.fetch ?? globalThis.fetch
    const service = new SanctuaryTelegramAuthorityService({
      api,
      gateway,
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
    if (options.setSocketOwnership) {
      options.setSocketOwnership(config)
    /* v8 ignore next -- the root-owned production branch is live-verified by the deployment slice @preserve */
    } else if (expectedUid === 0) {
      /* v8 ignore start -- root-only ownership syscalls are live-verified by the deployment slice @preserve */
      ;(options.chown ?? fs.chownSync)(path.dirname(config.socketPath), 0, config.socketGroupId)
      ;(options.chmod ?? fs.chmodSync)(path.dirname(config.socketPath), 0o750)
      ;(options.chown ?? fs.chownSync)(config.socketPath, 0, config.socketGroupId)
      ;(options.chmod ?? fs.chmodSync)(config.socketPath, 0o660)
      /* v8 ignore stop */
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
    return {
      close: async () => {
        if (closed) return
        closed = true
        fs.rmSync(config.readinessPath, { force: true })
        await server?.close()
        api?.stop()
        releaseLock()
      },
    }
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
  once?: (event: "SIGINT" | "SIGTERM", listener: () => void) => void
  exit?: (code: number) => void
} = {}): Promise<void> {
  const argv = options.argv ?? process.argv
  const configIndex = argv.indexOf("--config")
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : undefined
  if (!configPath) throw new Error("Sanctuary Telegram authority requires --config")
  const authority = await (options.start ?? startSanctuaryTelegramAuthority)({ configPath })
  const close = async () => {
    await authority.close()
    const exit = options.exit ?? process.exit
    exit(0)
  }
  const once = options.once ?? ((event, listener) => { process.once(event, listener) })
  once("SIGINT", () => { void close() })
  once("SIGTERM", () => { void close() })
}

/* v8 ignore next 6 -- executable guard delegates to the fully tested CLI runner @preserve */
if (require.main === module) {
  void runSanctuaryTelegramAuthorityCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Sanctuary Telegram authority failed"}\n`)
    process.exitCode = 1
  })
}
