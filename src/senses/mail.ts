import * as fs from "node:fs"
import * as path from "node:path"
import type { AddressInfo } from "node:net"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentRoot } from "../heart/identity"
import { refreshRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { getInnerDialogPendingDir } from "../mind/pending"
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
  if (!resolved.config.registryPath) {
    throw new Error(`missing mailroom.registryPath for ${options.agentName}; run 'ouro connect mail --agent ${options.agentName}' again`)
  }

  const registry = readRegistry(resolved.config.registryPath)
  const host = resolved.config.host ?? "127.0.0.1"
  const ingress = (options.startIngress ?? startMailroomIngress)({
    registry,
    store: resolved.store,
    smtpPort: validPort(resolved.config.smtpPort),
    httpPort: validPort(resolved.config.httpPort),
    host,
  })
  await Promise.all([
    waitForListening(ingress.smtp),
    waitForListening(ingress.health),
  ])
  const runtimePath = runtimeStatePath(options.agentName)
  const attentionPath = attentionStatePath(options.agentName)
  let lastScanAt: string | null = null
  let lastQueuedCount = 0

  const scan = async () => {
    try {
      const scanStartedAt = new Date(now()).toISOString()
      const result = await scanMailScreenerAttention({
        agentName: options.agentName,
        store: resolved.store,
        pendingDir: getInnerDialogPendingDir(options.agentName),
        statePath: attentionPath,
        now,
      })
      lastScanAt = scanStartedAt
      lastQueuedCount = result.queued.length
      writeRuntimeState(runtimePath, {
        schemaVersion: 1,
        agentName: options.agentName,
        status: "running",
        mailboxAddress: resolved.config.mailboxAddress,
        smtpPort: serverPort(ingress.smtp),
        httpPort: serverPort(ingress.health),
        host,
        storeKind: resolved.storeKind,
        storeLabel: resolved.storeLabel,
        lastScanAt,
        lastQueuedCount,
        updatedAt: new Date(now()).toISOString(),
      })
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.mail_sense_scan_error",
        message: "mail sense attention scan failed",
        meta: { agentName: options.agentName, error: error instanceof Error ? error.message : String(error) },
      })
    }
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
      smtpPort: serverPort(ingress.smtp),
      httpPort: serverPort(ingress.health),
      intervalMs,
    },
  })

  return {
    runtimeStatePath: runtimePath,
    attentionStatePath: attentionPath,
    smtpPort: serverPort(ingress.smtp),
    httpPort: serverPort(ingress.health),
    async stop() {
      ;(options.clearIntervalFn ?? ((activeTimer) => clearInterval(activeTimer as NodeJS.Timeout)))(timer)
      await Promise.all([
        closeServer(ingress.smtp),
        closeServer(ingress.health),
      ])
      writeRuntimeState(runtimePath, {
        schemaVersion: 1,
        agentName: options.agentName,
        status: "stopped",
        mailboxAddress: resolved.config.mailboxAddress,
        smtpPort: serverPort(ingress.smtp),
        httpPort: serverPort(ingress.health),
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
