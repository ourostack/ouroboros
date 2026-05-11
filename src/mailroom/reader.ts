import * as fs from "node:fs"
import * as path from "node:path"
import { BlobServiceClient } from "@azure/storage-blob"
import { DefaultAzureCredential } from "@azure/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentMailroomRoot, getAgentName, getAgentRoot } from "../heart/identity"
import { readRuntimeCredentialConfig, refreshRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { AzureBlobMailroomStore } from "./blob-store"
import { FileMailroomStore, type MailroomStore } from "./file-store"
import type { MailroomRegistry } from "./core"
import type { MailAutonomyPolicy } from "./core"

export interface MailroomRuntimeConfig {
  mailboxAddress: string
  registryPath?: string
  storePath?: string
  azureAccountUrl?: string
  azureContainer?: string
  registryAzureAccountUrl?: string
  registryContainer?: string
  registryBlob?: string
  azureManagedIdentityClientId?: string
  smtpPort?: number
  httpPort?: number
  host?: string
  attentionIntervalMs?: number
  outbound?: Record<string, unknown>
  autonomousSendPolicy?: MailAutonomyPolicy
  privateKeys: Record<string, string>
}

export type MailroomReaderStoreKind = "file" | "azure-blob"

export type MailroomReaderResolution =
  | {
      ok: true
      agentName: string
      config: MailroomRuntimeConfig
      store: MailroomStore
      storeKind: MailroomReaderStoreKind
      storeLabel: string
    }
  | {
      ok: false
      agentName: string
      reason: "auth-required" | "misconfigured"
      error: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function textField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key]
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key]
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined
}

export function parseMailroomConfig(value: unknown): MailroomRuntimeConfig | null {
  if (!isRecord(value)) return null
  const mailboxAddress = textField(value, "mailboxAddress")
  if (!mailboxAddress) return null
  if (!isRecord(value.privateKeys)) return null
  const privateKeys = Object.fromEntries(
    Object.entries(value.privateKeys).filter((entry): entry is [string, string] => {
      return typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0
    }),
  )
  if (Object.keys(privateKeys).length === 0) return null
  const registryPath = textField(value, "registryPath")
  const storePath = textField(value, "storePath")
  const azureAccountUrl = textField(value, "azureAccountUrl")
  const azureContainer = textField(value, "azureContainer")
  const registryAzureAccountUrl = textField(value, "registryAzureAccountUrl")
  const registryContainer = textField(value, "registryContainer")
  const registryBlob = textField(value, "registryBlob")
  const azureManagedIdentityClientId = textField(value, "azureManagedIdentityClientId")
  const smtpPort = numberField(value, "smtpPort")
  const httpPort = numberField(value, "httpPort")
  const host = textField(value, "host")
  const attentionIntervalMs = numberField(value, "attentionIntervalMs")
  const outbound = isRecord(value.outbound) ? { ...value.outbound } : undefined
  const autonomousSendPolicy = isRecord(value.autonomousSendPolicy)
    ? ({ ...value.autonomousSendPolicy } as unknown as MailAutonomyPolicy)
    : undefined
  return {
    mailboxAddress,
    ...(registryPath ? { registryPath } : {}),
    ...(storePath ? { storePath } : {}),
    ...(azureAccountUrl ? { azureAccountUrl } : {}),
    ...(azureContainer ? { azureContainer } : {}),
    ...(registryAzureAccountUrl ? { registryAzureAccountUrl } : {}),
    ...(registryContainer ? { registryContainer } : {}),
    ...(registryBlob ? { registryBlob } : {}),
    ...(azureManagedIdentityClientId ? { azureManagedIdentityClientId } : {}),
    ...(smtpPort !== undefined ? { smtpPort } : {}),
    ...(httpPort !== undefined ? { httpPort } : {}),
    ...(host ? { host } : {}),
    ...(attentionIntervalMs !== undefined ? { attentionIntervalMs } : {}),
    ...(outbound ? { outbound } : {}),
    ...(autonomousSendPolicy ? { autonomousSendPolicy } : {}),
    privateKeys,
  }
}

function createBlobCredential(config: MailroomRuntimeConfig): DefaultAzureCredential {
  return config.azureManagedIdentityClientId
    ? new DefaultAzureCredential({ managedIdentityClientId: config.azureManagedIdentityClientId })
    : new DefaultAzureCredential()
}

function createMailroomStore(config: MailroomRuntimeConfig, agentName: string): {
  store: MailroomStore
  storeKind: MailroomReaderStoreKind
  storeLabel: string
} {
  if (config.azureAccountUrl) {
    const containerName = config.azureContainer ?? "mailroom"
    return {
      store: new AzureBlobMailroomStore({
        serviceClient: new BlobServiceClient(config.azureAccountUrl, createBlobCredential(config)),
        containerName,
        mailSearchCache: {
          cacheDirForAgent: (agentId) => path.join(getAgentRoot(agentId), "state", "mail-search"),
        },
      }),
      storeKind: "azure-blob",
      storeLabel: `${config.azureAccountUrl}/${containerName}`,
    }
  }

  const storePath = config.storePath ?? getAgentMailroomRoot(agentName)
  return {
    store: new FileMailroomStore({ rootDir: storePath, migrateAgentId: agentName }),
    storeKind: "file",
    storeLabel: storePath,
  }
}

export async function readMailroomRegistry(config: MailroomRuntimeConfig): Promise<MailroomRegistry> {
  if (config.registryPath) {
    return JSON.parse(fs.readFileSync(config.registryPath, "utf-8")) as MailroomRegistry
  }

  const registryAzureAccountUrl = config.registryAzureAccountUrl ?? config.azureAccountUrl
  const registryContainer = config.registryContainer ?? config.azureContainer ?? "mailroom"
  const registryBlob = config.registryBlob
  if (!registryAzureAccountUrl || !registryBlob) {
    throw new Error("mailroom config is missing registryPath or hosted registry coordinates")
  }

  const serviceClient = new BlobServiceClient(registryAzureAccountUrl, createBlobCredential(config))
  const blobClient = serviceClient.getContainerClient(registryContainer).getBlockBlobClient(registryBlob)
  if (!await blobClient.exists()) {
    throw new Error(`mailroom registry blob not found: ${registryAzureAccountUrl}/${registryContainer}/${registryBlob}`)
  }
  return JSON.parse((await blobClient.downloadToBuffer()).toString("utf-8")) as MailroomRegistry
}

export async function writeMailroomRegistry(config: MailroomRuntimeConfig, registry: MailroomRegistry): Promise<void> {
  const serialized = `${JSON.stringify(registry, null, 2)}\n`
  if (config.registryPath) {
    fs.mkdirSync(path.dirname(config.registryPath), { recursive: true })
    fs.writeFileSync(config.registryPath, serialized, "utf-8")
    return
  }

  const registryAzureAccountUrl = config.registryAzureAccountUrl ?? config.azureAccountUrl
  const registryContainer = config.registryContainer ?? config.azureContainer ?? "mailroom"
  const registryBlob = config.registryBlob
  if (!registryAzureAccountUrl || !registryBlob) {
    throw new Error("mailroom config is missing registryPath or hosted registry coordinates")
  }

  const serviceClient = new BlobServiceClient(registryAzureAccountUrl, createBlobCredential(config))
  const blobClient = serviceClient.getContainerClient(registryContainer).getBlockBlobClient(registryBlob)
  await blobClient.upload(serialized, Buffer.byteLength(serialized), {
    blobHTTPHeaders: {
      blobContentType: "application/json; charset=utf-8",
    },
  })
}

export function resolveMailroomReader(agentName: string = getAgentName()): MailroomReaderResolution {
  const runtime = readRuntimeCredentialConfig(agentName)
  if (!runtime.ok) {
    const result: MailroomReaderResolution = {
      ok: false,
      agentName,
      reason: "auth-required",
      error: `AUTH_REQUIRED:mailroom -- Mail is not available because ${runtime.itemPath} is ${runtime.reason}. Agent-runnable repair after vault unlock: 'ouro connect mail --agent ${agentName}'.`,
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_reader_resolved",
      message: "mailroom reader resolved",
      meta: { agentName, status: result.reason },
    })
    return result
  }

  const config = parseMailroomConfig(runtime.config.mailroom)
  if (!config) {
    const result: MailroomReaderResolution = {
      ok: false,
      agentName,
      reason: "misconfigured",
      error: `AUTH_REQUIRED:mailroom -- Missing mailroom mailbox/private key config in vault runtime/config for ${agentName}.`,
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_reader_resolved",
      message: "mailroom reader resolved",
      meta: { agentName, status: result.reason },
    })
    return result
  }

  const store = createMailroomStore(config, agentName)
  const result: MailroomReaderResolution = {
    ok: true,
    agentName,
    config,
    store: store.store,
    storeKind: store.storeKind,
    storeLabel: store.storeLabel,
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_reader_resolved",
    message: "mailroom reader resolved",
    meta: { agentName, status: "ready", mailboxAddress: config.mailboxAddress, storeKind: store.storeKind },
  })
  return result
}

export async function resolveMailroomReaderWithRefresh(agentName: string = getAgentName()): Promise<MailroomReaderResolution> {
  const resolved = resolveMailroomReader(agentName)
  if (
    resolved.ok
    || resolved.reason !== "auth-required"
    || (!resolved.error.includes(" is unavailable") && !resolved.error.includes(" is missing"))
  ) {
    return resolved
  }

  await refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true }).catch(() => undefined)
  return resolveMailroomReader(agentName)
}
