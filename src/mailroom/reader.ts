import * as path from "node:path"
import { BlobServiceClient } from "@azure/storage-blob"
import { DefaultAzureCredential } from "@azure/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentName, getAgentRoot } from "../heart/identity"
import { readRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { AzureBlobMailroomStore } from "./blob-store"
import { FileMailroomStore, type MailroomStore } from "./file-store"

export interface MailroomRuntimeConfig {
  mailboxAddress: string
  registryPath?: string
  storePath?: string
  azureAccountUrl?: string
  azureContainer?: string
  azureManagedIdentityClientId?: string
  smtpPort?: number
  httpPort?: number
  host?: string
  attentionIntervalMs?: number
  outbound?: Record<string, unknown>
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
  const azureManagedIdentityClientId = textField(value, "azureManagedIdentityClientId")
  const smtpPort = numberField(value, "smtpPort")
  const httpPort = numberField(value, "httpPort")
  const host = textField(value, "host")
  const attentionIntervalMs = numberField(value, "attentionIntervalMs")
  const outbound = isRecord(value.outbound) ? { ...value.outbound } : undefined
  return {
    mailboxAddress,
    ...(registryPath ? { registryPath } : {}),
    ...(storePath ? { storePath } : {}),
    ...(azureAccountUrl ? { azureAccountUrl } : {}),
    ...(azureContainer ? { azureContainer } : {}),
    ...(azureManagedIdentityClientId ? { azureManagedIdentityClientId } : {}),
    ...(smtpPort !== undefined ? { smtpPort } : {}),
    ...(httpPort !== undefined ? { httpPort } : {}),
    ...(host ? { host } : {}),
    ...(attentionIntervalMs !== undefined ? { attentionIntervalMs } : {}),
    ...(outbound ? { outbound } : {}),
    privateKeys,
  }
}

function createMailroomStore(config: MailroomRuntimeConfig, agentName: string): {
  store: MailroomStore
  storeKind: MailroomReaderStoreKind
  storeLabel: string
} {
  if (config.azureAccountUrl) {
    const credential = config.azureManagedIdentityClientId
      ? new DefaultAzureCredential({ managedIdentityClientId: config.azureManagedIdentityClientId })
      : new DefaultAzureCredential()
    const containerName = config.azureContainer ?? "mailroom"
    return {
      store: new AzureBlobMailroomStore({
        serviceClient: new BlobServiceClient(config.azureAccountUrl, credential),
        containerName,
      }),
      storeKind: "azure-blob",
      storeLabel: `${config.azureAccountUrl}/${containerName}`,
    }
  }

  const storePath = config.storePath ?? path.join(getAgentRoot(agentName), "state", "mailroom")
  return {
    store: new FileMailroomStore({ rootDir: storePath }),
    storeKind: "file",
    storeLabel: storePath,
  }
}

export function resolveMailroomReader(agentName: string = getAgentName()): MailroomReaderResolution {
  const runtime = readRuntimeCredentialConfig(agentName)
  if (!runtime.ok) {
    const result: MailroomReaderResolution = {
      ok: false,
      agentName,
      reason: "auth-required",
      error: `AUTH_REQUIRED:mailroom -- Mail is not available because ${runtime.itemPath} is ${runtime.reason}. Run 'ouro connect mail --agent ${agentName}' after the vault is unlocked.`,
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
