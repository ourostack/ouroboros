import * as fs from "node:fs"
import * as path from "node:path"
import type { AddressInfo } from "node:net"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentRoot, getRepoRoot } from "../heart/identity"
import { refreshRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { getInnerDialogPendingDir, queuePendingMessage } from "../mind/pending"
import { requestInnerWake } from "../heart/daemon/socket-client"
import { listBackgroundOperations } from "../heart/background-operations"
import { listAmbientMailImportOperations } from "../heart/mail-import-discovery"
import { scanMailScreenerAttention } from "../mailroom/attention"
import { resolveMailroomReader, type MailroomReaderResolution } from "../mailroom/reader"
import { startMailroomIngress, type MailroomIngressServers, type MailroomSmtpIngressOptions } from "../mailroom/smtp-ingress"
import type { MailroomRegistry } from "../mailroom/core"

export interface MailSenseRuntimeState {
  schemaVersion: 1
  agentName: string
  status: "running" | "stopped"
  mailboxAddress: string
  smtpPort: number | null
  httpPort: number | null
  host: string
  storeKind: string
  storeLabel: string
  lastScanAt: string | null
  lastQueuedCount: number
  updatedAt: string
}

export interface MailSenseApp {
  runtimeStatePath: string
  attentionStatePath: string
  smtpPort: number | null
  httpPort: number | null
  stop(): Promise<void>
}

export interface MailSenseAppOptions {
  agentName: string
  now?: () => number
  refreshRuntime?: typeof refreshRuntimeCredentialConfig
  resolveReader?: (agentName: string) => MailroomReaderResolution
  startIngress?: (options: MailroomSmtpIngressOptions & { smtpPort: number; httpPort: number; host?: string }) => MailroomIngressServers
  setIntervalFn?: (callback: () => void, ms: number) => unknown
  clearIntervalFn?: (timer: unknown) => void
}

interface MailImportDiscoveryState {
  schemaVersion: 1
  lastNotifiedFingerprint: string | null
  updatedAt: string
}

interface MailImportDiscoveryScanResult {
  queued: boolean
  fingerprint: string | null
  candidatePaths: string[]
}

interface ImportDiscoveryCandidateDescriptor {
  path: string
  originKind?: string
  originLabel?: string
}

function readRegistry(registryPath: string): MailroomRegistry {
  return JSON.parse(fs.readFileSync(registryPath, "utf-8")) as MailroomRegistry
}

function validPort(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535 ? value : 0
}

function serverAddress(server: unknown): string | AddressInfo | null {
  const direct = server as { address?: () => string | AddressInfo | null }
  if (typeof direct.address === "function") return direct.address()
  const wrapped = server as { server?: { address?: () => string | AddressInfo | null } }
  if (typeof wrapped.server?.address === "function") return wrapped.server.address()
  return null
}

function serverPort(server: unknown): number | null {
  const address = serverAddress(server)
  if (!address || typeof address !== "object") return null
  return typeof address.port === "number" ? address.port : null
}

function listeningServer(server: unknown): { listening?: boolean; once?: (event: string, callback: () => void) => void } | null {
  const wrapped = server as { server?: { listening?: boolean; once?: (event: string, callback: () => void) => void } }
  if (typeof wrapped.server?.once === "function") return wrapped.server
  const direct = server as { listening?: boolean; once?: (event: string, callback: () => void) => void }
  return typeof direct.once === "function" ? direct : null
}

function waitForListening(server: unknown): Promise<void> {
  if (serverAddress(server)) return Promise.resolve()
  const listening = listeningServer(server)
  if (!listening) return new Promise((resolve) => setImmediate(resolve))
  if (listening.listening) return Promise.resolve()
  return new Promise((resolve) => listening.once?.("listening", resolve))
}

function runtimeStatePath(agentName: string): string {
  return path.join(getAgentRoot(agentName), "state", "senses", "mail", "runtime.json")
}

function attentionStatePath(agentName: string): string {
  return path.join(getAgentRoot(agentName), "state", "senses", "mail", "attention.json")
}

function importDiscoveryStatePath(agentName: string): string {
  return path.join(getAgentRoot(agentName), "state", "senses", "mail", "import-discovery.json")
}

function writeRuntimeState(filePath: string, state: MailSenseRuntimeState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8")
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_sense_runtime_state_written",
    message: "mail sense runtime state written",
    meta: { agentName: state.agentName, status: state.status, lastQueuedCount: state.lastQueuedCount },
  })
}

function emptyImportDiscoveryState(updatedAt: string): MailImportDiscoveryState {
  return {
    schemaVersion: 1,
    lastNotifiedFingerprint: null,
    updatedAt,
  }
}

function readImportDiscoveryState(filePath: string, updatedAt: string): MailImportDiscoveryState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<MailImportDiscoveryState>
    return {
      schemaVersion: 1,
      lastNotifiedFingerprint: typeof parsed.lastNotifiedFingerprint === "string" && parsed.lastNotifiedFingerprint.trim().length > 0
        ? parsed.lastNotifiedFingerprint
        : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : updatedAt,
    }
  } catch {
    return emptyImportDiscoveryState(updatedAt)
  }
}

function writeImportDiscoveryState(filePath: string, state: MailImportDiscoveryState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8")
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
}

function candidateDescriptors(value: unknown): ImportDiscoveryCandidateDescriptor[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      path: typeof entry.path === "string" ? entry.path : "",
      originKind: typeof entry.originKind === "string" ? entry.originKind : undefined,
      originLabel: typeof entry.originLabel === "string" ? entry.originLabel : undefined,
    }))
    .filter((entry) => entry.path.trim().length > 0)
}

function renderImportDiscoveryContent(
  candidatePaths: string[],
  descriptors: ImportDiscoveryCandidateDescriptor[],
): string {
  const renderedCandidates = descriptors.length > 0
    ? descriptors.map((descriptor) => `- [${descriptor.originLabel ?? descriptor.originKind ?? "filesystem"}] ${descriptor.path}`)
    : candidatePaths.map((candidatePath) => `- ${candidatePath}`)
  return [
    "[Mail Import Ready]",
    "A local MBOX archive is ready for delegated-mail backfill.",
    "This may live in a worktree-local Playwright sandbox rather than ~/Downloads.",
    "",
    "recent candidates:",
    ...renderedCandidates,
    "",
    "If this matches an expected mailbox backfill, run `ouro mail import-mbox --discover --owner-email <email> --source hey --agent <agent>` first so Ouro can pick the matching archive or report ambiguity.",
  ].join("\n")
}

export async function scanMailImportDiscoveryAttention(input: {
  agentName: string
  pendingDir?: string
  statePath?: string
  now?: () => number
}): Promise<MailImportDiscoveryScanResult> {
  const nowMs = input.now?.() ?? Date.now()
  const updatedAt = new Date(nowMs).toISOString()
  const statePath = input.statePath ?? importDiscoveryStatePath(input.agentName)
  const pendingDir = input.pendingDir ?? getInnerDialogPendingDir(input.agentName)
  const state = readImportDiscoveryState(statePath, updatedAt)
  const existingOperations = listBackgroundOperations({
    agentName: input.agentName,
    agentRoot: getAgentRoot(input.agentName),
    limit: 10,
  })
  const discovered = listAmbientMailImportOperations({
    agentName: input.agentName,
    agentRoot: getAgentRoot(input.agentName),
    existingOperations,
    repoRoot: getRepoRoot(),
    homeDir: process.env.HOME,
    nowMs,
  })[0] ?? null
  const fingerprint = typeof discovered?.spec?.fingerprint === "string" && discovered.spec.fingerprint.trim().length > 0
    ? discovered.spec.fingerprint
    : null
  const candidatePaths = stringArray(discovered?.spec?.candidatePaths)
  const descriptors = candidateDescriptors(discovered?.spec?.candidateDescriptors)
  const shouldQueue = Boolean(discovered && fingerprint && fingerprint !== state.lastNotifiedFingerprint)

  if (shouldQueue) {
    queuePendingMessage(pendingDir, {
      from: "mailroom",
      friendId: "self",
      channel: "mail",
      key: "import-ready",
      content: renderImportDiscoveryContent(candidatePaths, descriptors),
      timestamp: nowMs,
      mode: "reflect",
    })
    await requestInnerWake(input.agentName).catch(() => undefined)
  }

  writeImportDiscoveryState(statePath, {
    schemaVersion: 1,
    lastNotifiedFingerprint: shouldQueue ? fingerprint : state.lastNotifiedFingerprint,
    updatedAt,
  })

  emitNervesEvent({
    component: "senses",
    event: "senses.mail_import_discovery_scanned",
    message: "mail import discovery scanned",
    meta: {
      agentName: input.agentName,
      queued: shouldQueue,
      candidateCount: candidatePaths.length,
      fingerprint,
    },
  })

  return {
    queued: shouldQueue,
    fingerprint,
    candidatePaths,
  }
}

function closeServer(server: { close(callback: () => void): unknown }): Promise<void> {
  return new Promise((resolve) => {
    server.close(resolve)
  })
}

export async function startMailSenseApp(options: MailSenseAppOptions): Promise<MailSenseApp> {
  const now = options.now ?? (() => Date.now())
  /* v8 ignore next -- production wiring uses the default vault refresh; tests inject a deterministic refresh. @preserve */
  const refreshRuntime = options.refreshRuntime ?? refreshRuntimeCredentialConfig
  await refreshRuntime(options.agentName, { preserveCachedOnFailure: true }).catch(() => undefined)
  const resolved = options.resolveReader
    ? options.resolveReader(options.agentName)
    : resolveMailroomReader(options.agentName)
  if (!resolved.ok) {
    throw new Error(resolved.error)
  }
  const hostedReaderOnly = resolved.storeKind === "azure-blob" && !resolved.config.registryPath
  if (!resolved.config.registryPath && !hostedReaderOnly) {
    throw new Error(`missing mailroom.registryPath for ${options.agentName}; agent-runnable repair: 'ouro connect mail --agent ${options.agentName}'`)
  }

  const host = resolved.config.host ?? "127.0.0.1"
  const ingress = hostedReaderOnly
    ? null
    : (options.startIngress ?? startMailroomIngress)({
        registry: readRegistry(resolved.config.registryPath!),
        store: resolved.store,
        smtpPort: validPort(resolved.config.smtpPort),
        httpPort: validPort(resolved.config.httpPort),
        host,
      })
  if (ingress) {
    await Promise.all([
      waitForListening(ingress.smtp),
      waitForListening(ingress.health),
    ])
  }
  const activeSmtpPort = () => ingress ? serverPort(ingress.smtp) : null
  const activeHttpPort = () => ingress ? serverPort(ingress.health) : null
  const runtimePath = runtimeStatePath(options.agentName)
  const attentionPath = attentionStatePath(options.agentName)
  const importDiscoveryPath = importDiscoveryStatePath(options.agentName)
  let lastScanAt: string | null = null
  let lastQueuedCount = 0

  const scan = async () => {
    const scanStartedAt = new Date(now()).toISOString()
    let queuedCount = 0

    try {
      const screener = await scanMailScreenerAttention({
        agentName: options.agentName,
        store: resolved.store,
        pendingDir: getInnerDialogPendingDir(options.agentName),
        statePath: attentionPath,
        now,
      })
      queuedCount += screener.queued.length
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.mail_sense_scan_error",
        message: "mail sense attention scan failed",
        meta: { agentName: options.agentName, error: error instanceof Error ? error.message : String(error) },
      })
    }

    try {
      const importDiscovery = await scanMailImportDiscoveryAttention({
        agentName: options.agentName,
        pendingDir: getInnerDialogPendingDir(options.agentName),
        statePath: importDiscoveryPath,
        now,
      })
      if (importDiscovery.queued) {
        queuedCount += 1
      }
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.mail_import_discovery_scan_error",
        message: "mail import discovery scan failed",
        meta: { agentName: options.agentName, error: error instanceof Error ? error.message : String(error) },
      })
    }

    lastScanAt = scanStartedAt
    lastQueuedCount = queuedCount
    writeRuntimeState(runtimePath, {
      schemaVersion: 1,
      agentName: options.agentName,
      status: "running",
      mailboxAddress: resolved.config.mailboxAddress,
      smtpPort: activeSmtpPort(),
      httpPort: activeHttpPort(),
      host,
      storeKind: resolved.storeKind,
      storeLabel: resolved.storeLabel,
      lastScanAt,
      lastQueuedCount,
      updatedAt: new Date(now()).toISOString(),
    })
  }

  await scan()
  const intervalMs = Math.max(5_000, resolved.config.attentionIntervalMs ?? 30_000)
  const timer = (options.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms)))(() => {
    void scan()
  }, intervalMs)

  emitNervesEvent({
    component: "senses",
    event: "senses.mail_sense_started",
    message: "mail sense started",
    meta: {
      agentName: options.agentName,
      mailboxAddress: resolved.config.mailboxAddress,
      smtpPort: activeSmtpPort(),
      httpPort: activeHttpPort(),
      intervalMs,
    },
  })

  return {
    runtimeStatePath: runtimePath,
    attentionStatePath: attentionPath,
    smtpPort: activeSmtpPort(),
    httpPort: activeHttpPort(),
    async stop() {
      ;(options.clearIntervalFn ?? ((activeTimer) => clearInterval(activeTimer as NodeJS.Timeout)))(timer)
      if (ingress) {
        await Promise.all([
          closeServer(ingress.smtp),
          closeServer(ingress.health),
        ])
      }
      writeRuntimeState(runtimePath, {
        schemaVersion: 1,
        agentName: options.agentName,
        status: "stopped",
        mailboxAddress: resolved.config.mailboxAddress,
        smtpPort: activeSmtpPort(),
        httpPort: activeHttpPort(),
        host,
        storeKind: resolved.storeKind,
        storeLabel: resolved.storeLabel,
        lastScanAt,
        lastQueuedCount,
        updatedAt: new Date(now()).toISOString(),
      })
      emitNervesEvent({
        component: "senses",
        event: "senses.mail_sense_stopped",
        message: "mail sense stopped",
        meta: { agentName: options.agentName },
      })
    },
  }
}
