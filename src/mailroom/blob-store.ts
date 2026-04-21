import { BlobServiceClient } from "@azure/storage-blob"
import { emitNervesEvent } from "../nerves/runtime"
import {
  buildStoredMailMessage,
  decryptStoredMailMessage,
  type DecryptedMailMessage,
  type EncryptedPayload,
  type MailEnvelopeInput,
  type ResolvedMailAddress,
  type StoredMailMessage,
} from "./core"
import type { MailAccessLogEntry, MailListFilters, MailroomStore } from "./file-store"

export interface AzureBlobMailroomStoreOptions {
  serviceClient: BlobServiceClient
  containerName: string
}

function compareNewestFirst(left: StoredMailMessage, right: StoredMailMessage): number {
  return Date.parse(right.receivedAt) - Date.parse(left.receivedAt)
}

function blobText(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

async function downloadJson<T>(blob: { exists(): Promise<boolean>; downloadToBuffer(): Promise<Buffer> }): Promise<T | null> {
  if (!await blob.exists()) return null
  return JSON.parse((await blob.downloadToBuffer()).toString("utf-8")) as T
}

export class AzureBlobMailroomStore implements MailroomStore {
  private readonly serviceClient: BlobServiceClient
  private readonly containerName: string
  private containerReady: Promise<void> | null = null

  constructor(options: AzureBlobMailroomStoreOptions) {
    this.serviceClient = options.serviceClient
    this.containerName = options.containerName
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_store_init",
      message: "azure blob mailroom store initialized",
      meta: { containerName: this.containerName },
    })
  }

  private get container() {
    return this.serviceClient.getContainerClient(this.containerName)
  }

  private async ensureContainer(): Promise<void> {
    if (!this.containerReady) {
      this.containerReady = this.container.createIfNotExists().then(() => undefined)
    }
    await this.containerReady
  }

  private messageBlob(id: string) {
    return this.container.getBlockBlobClient(`messages/${id}.json`)
  }

  private rawBlob(objectName: string) {
    return this.container.getBlockBlobClient(objectName)
  }

  private accessLogBlob(agentId: string) {
    return this.container.getBlockBlobClient(`access-log/${agentId}.jsonl`)
  }

  async putRawMessage(input: {
    resolved: ResolvedMailAddress
    envelope: MailEnvelopeInput
    rawMime: Buffer
    receivedAt?: Date
  }): Promise<{ created: boolean; message: StoredMailMessage }> {
    await this.ensureContainer()
    const { message, rawPayload } = await buildStoredMailMessage(input)
    const existing = await downloadJson<StoredMailMessage>(this.messageBlob(message.id))
    if (existing) {
      emitNervesEvent({
        component: "senses",
        event: "senses.mail_blob_store_dedupe",
        message: "azure blob mailroom store deduped existing message",
        meta: { id: message.id, agentId: message.agentId },
      })
      return { created: false, message: existing }
    }
    await this.rawBlob(message.rawObject).uploadData(blobText(rawPayload))
    await this.messageBlob(message.id).uploadData(blobText(message))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_store_message_written",
      message: "azure blob mailroom store wrote message",
      meta: { id: message.id, agentId: message.agentId },
    })
    return { created: true, message }
  }

  async getMessage(id: string): Promise<StoredMailMessage | null> {
    await this.ensureContainer()
    const message = await downloadJson<StoredMailMessage>(this.messageBlob(id))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_store_message_read",
      message: "azure blob mailroom store read message",
      meta: { id, found: message !== null },
    })
    return message
  }

  async listMessages(filters: MailListFilters): Promise<StoredMailMessage[]> {
    await this.ensureContainer()
    const messages: StoredMailMessage[] = []
    for await (const item of this.container.listBlobsFlat({ prefix: "messages/" })) {
      const message = await downloadJson<StoredMailMessage>(this.container.getBlockBlobClient(item.name))
      if (message) messages.push(message)
    }
    const filtered = messages
      .filter((message) => message.agentId === filters.agentId)
      .filter((message) => filters.placement ? message.placement === filters.placement : true)
      .filter((message) => filters.compartmentKind ? message.compartmentKind === filters.compartmentKind : true)
      .filter((message) => filters.source ? message.source === filters.source : true)
      .sort(compareNewestFirst)
      .slice(0, filters.limit ?? 20)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_store_messages_listed",
      message: "azure blob mailroom store listed messages",
      meta: { agentId: filters.agentId, count: filtered.length },
    })
    return filtered
  }

  async readRawPayload(objectName: string): Promise<EncryptedPayload | null> {
    await this.ensureContainer()
    const payload = await downloadJson<EncryptedPayload>(this.rawBlob(objectName))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_store_raw_read",
      message: "azure blob mailroom store read raw payload",
      meta: { objectName, found: payload !== null },
    })
    return payload
  }

  async recordAccess(entry: Omit<MailAccessLogEntry, "id" | "accessedAt">): Promise<MailAccessLogEntry> {
    await this.ensureContainer()
    const complete: MailAccessLogEntry = {
      ...entry,
      id: `access_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      accessedAt: new Date().toISOString(),
    }
    const blob = this.accessLogBlob(entry.agentId)
    const existing = await downloadJson<MailAccessLogEntry[]>(blob).catch(() => null)
    const entries = Array.isArray(existing) ? existing : []
    entries.push(complete)
    await blob.uploadData(blobText(entries))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_access_recorded",
      message: "azure blob mail access recorded",
      meta: { agentId: entry.agentId, messageId: entry.messageId ?? null, tool: entry.tool },
    })
    return complete
  }

  async listAccessLog(agentId: string): Promise<MailAccessLogEntry[]> {
    await this.ensureContainer()
    const entries = await downloadJson<MailAccessLogEntry[]>(this.accessLogBlob(agentId))
    const safeEntries = Array.isArray(entries) ? entries : []
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_access_log_listed",
      message: "azure blob mail access log listed",
      meta: { agentId, count: safeEntries.length },
    })
    return safeEntries
  }
}

export function decryptBlobMessages(messages: StoredMailMessage[], privateKeys: Record<string, string>): DecryptedMailMessage[] {
  return messages.map((message) => decryptStoredMailMessage(message, privateKeys))
}
