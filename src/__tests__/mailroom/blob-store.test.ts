import { describe, expect, it } from "vitest"
import type { BlobServiceClient } from "@azure/storage-blob"
import { provisionMailboxRegistry, resolveMailAddress, type StoredMailMessage } from "../../mailroom/core"
import { AzureBlobMailroomStore, decryptBlobMessages } from "../../mailroom/blob-store"
import { decryptMessages } from "../../mailroom/file-store"

interface FakeBlobState {
  data?: Buffer
  downloads: number
  uploads: number
  deletes: number
	  stall?: boolean
	  downloadDelayMs?: number
	  downloadFailuresRemaining?: number
	  downloadFailureMessage?: string
	  downloadFailureError?: unknown
	}

class FakeBlockBlobClient {
  constructor(private readonly container: FakeContainerClient, readonly name: string) {}

  private state(): FakeBlobState {
    const existing = this.container.blobs.get(this.name)
    if (existing) return existing
    const created: FakeBlobState = { downloads: 0, uploads: 0, deletes: 0 }
    this.container.blobs.set(this.name, created)
    return created
  }

  async exists(): Promise<boolean> {
    return this.state().data !== undefined
  }

  async downloadToBuffer(_offset?: number, _count?: number, options?: { abortSignal?: AbortSignal }): Promise<Buffer> {
    const state = this.state()
    state.downloads += 1
    this.container.activeDownloads += 1
    this.container.maxConcurrentDownloads = Math.max(this.container.maxConcurrentDownloads, this.container.activeDownloads)
    try {
	      if (state.downloadFailuresRemaining && state.downloadFailuresRemaining > 0) {
	        state.downloadFailuresRemaining -= 1
	        throw state.downloadFailureError ?? new Error(state.downloadFailureMessage ?? "synthetic download failure")
	      }
      if (state.stall) {
        await new Promise<never>((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true })
        })
      }
      if (state.downloadDelayMs && state.downloadDelayMs > 0) {
        await waitForAbortableDelay(state.downloadDelayMs, options?.abortSignal)
      }
      if (!state.data) throw new Error(`missing blob ${this.name}`)
      return Buffer.from(state.data)
    } finally {
      this.container.activeDownloads -= 1
    }
  }

  async uploadData(data: Buffer, _options?: { abortSignal?: AbortSignal }): Promise<void> {
    const state = this.state()
    state.uploads += 1
    state.data = Buffer.from(data)
  }

  async deleteIfExists(): Promise<boolean> {
    const state = this.state()
    state.deletes += 1
    const existed = state.data !== undefined
    this.container.blobs.delete(this.name)
    return existed
  }
}

class FakeContainerClient {
  readonly blobs = new Map<string, FakeBlobState>()
  activeDownloads = 0
  maxConcurrentDownloads = 0

  async createIfNotExists(): Promise<void> {
    return undefined
  }

  getBlockBlobClient(name: string): FakeBlockBlobClient {
    return new FakeBlockBlobClient(this, name)
  }

  async *listBlobsFlat(options: { prefix?: string } = {}): AsyncGenerator<{ name: string }> {
    for (const [name, state] of [...this.blobs.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      if (!state.data) continue
      if (!options.prefix || name.startsWith(options.prefix)) {
        yield { name }
      }
    }
  }
}

class FakeBlobServiceClient {
  readonly container = new FakeContainerClient()

  getContainerClient(): FakeContainerClient {
    return this.container
  }
}

function resetBlobCounters(container: FakeContainerClient): void {
  for (const state of container.blobs.values()) {
    state.downloads = 0
    state.uploads = 0
    state.deletes = 0
  }
}

function totalDownloads(container: FakeContainerClient, prefix: string): number {
  return [...container.blobs.entries()]
    .filter(([name, state]) => name.startsWith(prefix) && state.data)
    .reduce((sum, [, state]) => sum + state.downloads, 0)
}

async function waitForAbortableDelay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("The operation was aborted.", "AbortError"))
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true })
  })
}

describe("AzureBlobMailroomStore", () => {
  it("stores encrypted raw mail, metadata, and access logs in blob-shaped storage", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })
    const { registry, keys } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    const created = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Ari <ari@mendelow.me>\r\nTo: slugger@ouro.bot\r\nSubject: Blob proof\r\n\r\nHello from Blob.\r\n"),
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    })
    expect(created.created).toBe(true)
    expect(serviceClient.container.blobs.get(`messages/${created.message.id}.json`)?.data).toBeDefined()
    expect(serviceClient.container.blobs.get(created.message.rawObject)?.data).toBeDefined()
    expect([...serviceClient.container.blobs.keys()].some((name) => {
      return name.startsWith("message-index/slugger/") && name.endsWith(`__${created.message.id}.json`)
    })).toBe(true)
    for (const name of [...serviceClient.container.blobs.keys()]) {
      if (name.startsWith("message-index/slugger/") && name.endsWith(`__${created.message.id}.json`)) {
        serviceClient.container.blobs.delete(name)
      }
    }

    const duplicate = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Ari <ari@mendelow.me>\r\nTo: slugger@ouro.bot\r\nSubject: Blob proof\r\n\r\nHello from Blob.\r\n"),
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    })
    expect(duplicate.created).toBe(false)
    expect([...serviceClient.container.blobs.keys()].some((name) => {
      return name.startsWith("message-index/slugger/") && name.endsWith(`__${created.message.id}.json`)
    })).toBe(true)

    const duplicateState = serviceClient.container.blobs.get(`messages/${created.message.id}.json`)
    if (!duplicateState) throw new Error("expected duplicate blob state")
    duplicateState.downloadFailuresRemaining = 1
    duplicateState.downloadFailureMessage = "socket closed early"
    const duplicateAfterRetry = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Ari <ari@mendelow.me>\r\nTo: slugger@ouro.bot\r\nSubject: Blob proof\r\n\r\nHello from Blob.\r\n"),
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    })
    expect(duplicateAfterRetry.created).toBe(false)
    expect(duplicateAfterRetry.message.id).toBe(created.message.id)
    expect(duplicateState.downloads).toBe(3)

    const second = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "later@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Later <later@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: Later blob\r\n\r\nHello later.\r\n"),
      receivedAt: new Date("2024-01-02T00:00:00Z"),
    })
    const imbox = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "known@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Known <known@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: Known blob\r\n\r\nAlready screened.\r\n"),
      classification: {
        placement: "imbox",
        candidate: false,
        trustReason: "known sender proof",
      },
      receivedAt: new Date("2024-01-03T00:00:00Z"),
    })
    expect(imbox.message.placement).toBe("imbox")

    serviceClient.container.blobs.set("messages/null.json", {
      data: Buffer.from("null\n"),
      downloads: 0,
      uploads: 0,
      deletes: 0,
    })
    const listed = await store.listMessages({ agentId: "slugger", placement: "screener", compartmentKind: "native", limit: 10 })
    expect(listed.map((message) => message.id)).toEqual([second.message.id, created.message.id])
    expect(await store.listMessages({ agentId: "slugger", source: "hey" })).toEqual([])
    expect(decryptMessages(listed, keys).map((message) => message.private.subject)).toEqual(["Later blob", "Blob proof"])
    expect(decryptBlobMessages(listed, keys)).toHaveLength(2)
    serviceClient.container.blobs.set("candidates/null.json", {
      data: Buffer.from("null\n"),
      downloads: 0,
      uploads: 0,
      deletes: 0,
    })
    expect(await store.listScreenerCandidates({ agentId: "slugger" })).toHaveLength(2)
    const candidates = await store.listScreenerCandidates({ agentId: "slugger", status: "pending", placement: "screener", limit: 1 })
    expect(candidates).toEqual([
      expect.objectContaining({ messageId: second.message.id, senderEmail: "later@example.com" }),
    ])
    const updatedCandidate = await store.updateScreenerCandidate({
      ...candidates[0],
      status: "discarded",
      placement: "discarded",
      resolvedByDecisionId: "decision_blob",
    })
    expect(updatedCandidate.status).toBe("discarded")
    expect(await store.listScreenerCandidates({ agentId: "slugger", status: "discarded", placement: "discarded" })).toEqual([
      expect.objectContaining({ id: candidates[0].id, resolvedByDecisionId: "decision_blob" }),
    ])
	    expect(await store.listScreenerCandidates({ agentId: "nobody" })).toEqual([])
	    expect(await store.getMessage(created.message.id)).toEqual(expect.objectContaining({ id: created.message.id }))
	    expect(await store.getIndexedMessageById(created.message.id)).toEqual(expect.objectContaining({ id: created.message.id }))
	    expect(await store.getIndexedMessageById("missing")).toBeNull()
	    duplicateState.downloadFailuresRemaining = 1
	    duplicateState.downloadFailureError = { statusCode: 404 }
	    expect(await store.getIndexedMessageById(created.message.id)).toBeNull()
	    duplicateState.downloadFailuresRemaining = 1
	    duplicateState.downloadFailureError = "BlobNotFound: vanished"
	    expect(await store.getIndexedMessageById(created.message.id)).toBeNull()
	    duplicateState.downloadFailureError = undefined
	    duplicateState.downloadFailuresRemaining = 1
	    duplicateState.downloadFailureMessage = "socket closed early"
	    expect(await store.getIndexedMessageById(created.message.id)).toEqual(expect.objectContaining({ id: created.message.id }))
	    duplicateState.downloadFailuresRemaining = 1
	    duplicateState.downloadFailureMessage = "permission denied"
	    await expect(store.getIndexedMessageById(created.message.id)).rejects.toThrow(/permission denied/)
	    expect(await store.getMessage("missing")).toBeNull()
	    expect(await store.updateMessagePlacement("missing", "discarded")).toBeNull()
    expect(await store.updateMessagePlacement(created.message.id, "imbox")).toEqual(expect.objectContaining({
      id: created.message.id,
      placement: "imbox",
    }))
    expect((await store.listMessages({ agentId: "slugger", placement: "imbox" })).map((message) => message.id)).toContain(created.message.id)
    expect((await store.listMessages({ agentId: "slugger", placement: "screener" })).map((message) => message.id)).not.toContain(created.message.id)
    expect(await store.readRawPayload(created.message.rawObject)).toEqual(expect.objectContaining({
      algorithm: "RSA-OAEP-SHA256+A256GCM",
    }))
    expect(await store.readRawPayload("raw/missing.json")).toBeNull()
    expect(await store.listAccessLog("nobody")).toEqual([])

    serviceClient.container.blobs.set("access-log/slugger.jsonl", {
      data: Buffer.from("{not json"),
      downloads: 0,
      uploads: 0,
      deletes: 0,
    })
    await store.recordAccess({
      agentId: "slugger",
      messageId: created.message.id,
      tool: "mail_body",
      reason: "blob store proof",
    })
    await store.recordAccess({
      agentId: "slugger",
      tool: "mail_recent",
      reason: "blob mailbox overview",
    })
    expect(await store.listAccessLog("slugger")).toEqual([
      expect.objectContaining({ tool: "mail_body", reason: "blob store proof" }),
      expect.objectContaining({ tool: "mail_recent", reason: "blob mailbox overview" }),
    ])

    serviceClient.container.blobs.set("decisions/slugger.json", {
      data: Buffer.from("{not json"),
      downloads: 0,
      uploads: 0,
      deletes: 0,
    })
    const decision = await store.recordMailDecision({
      agentId: "slugger",
      messageId: created.message.id,
      action: "discard",
      actor: { kind: "human", friendId: "ari", trustLevel: "family", channel: "cli" },
      reason: "blob decision proof",
      previousPlacement: "screener",
      nextPlacement: "discarded",
    })
    expect(decision).toEqual(expect.objectContaining({ action: "discard", reason: "blob decision proof" }))
    expect(await store.listMailDecisions("slugger")).toEqual([
      expect.objectContaining({ id: decision.id, action: "discard" }),
    ])
    await store.recordMailDecision({
      id: "decision_blob_restore",
      createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "slugger",
      messageId: created.message.id,
      action: "restore",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "blob existing decisions proof",
      previousPlacement: "discarded",
      nextPlacement: "imbox",
    })
    expect(await store.listMailDecisions("slugger")).toHaveLength(2)
    expect(await store.listMailDecisions("nobody")).toEqual([])

    await store.upsertMailOutbound({
      schemaVersion: 1,
      id: "draft_blob",
      agentId: "slugger",
      status: "draft",
      from: "slugger@ouro.bot",
      to: ["ari@example.com"],
      cc: [],
      bcc: [],
      subject: "Blob draft",
      text: "Hello from outbound blob storage.",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "blob outbound proof",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    })
    await store.upsertMailOutbound({
      schemaVersion: 1,
      id: "draft_blob_later",
      agentId: "slugger",
      status: "draft",
      from: "slugger@ouro.bot",
      to: ["ari@example.com"],
      cc: [],
      bcc: [],
      subject: "Later blob draft",
      text: "A later outbound record.",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "blob outbound sort proof",
      createdAt: "2026-04-21T00:01:00.000Z",
      updatedAt: "2026-04-21T00:01:00.000Z",
    })
    await store.upsertMailOutbound({
      schemaVersion: 1,
      id: "draft_other_agent",
      agentId: "other",
      status: "draft",
      from: "other@ouro.bot",
      to: ["ari@example.com"],
      cc: [],
      bcc: [],
      subject: "Other agent",
      text: "Filtered out.",
      actor: { kind: "agent", agentId: "other" },
      reason: "filter proof",
      createdAt: "2026-04-21T00:02:00.000Z",
      updatedAt: "2026-04-21T00:02:00.000Z",
    })
    serviceClient.container.blobs.set("outbound/null.json", {
      data: Buffer.from("null\n"),
      downloads: 0,
      uploads: 0,
      deletes: 0,
    })
    expect(await store.getMailOutbound("draft_blob")).toEqual(expect.objectContaining({
      id: "draft_blob",
      status: "draft",
    }))
    expect(await store.getMailOutbound("missing")).toBeNull()
    expect(await store.listMailOutbound("slugger")).toEqual([
      expect.objectContaining({ id: "draft_blob_later", subject: "Later blob draft" }),
      expect.objectContaining({ id: "draft_blob", subject: "Blob draft" }),
    ])
  })

  it("treats unreadable existing message blobs as duplicates during import reruns", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    const created = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Ari <ari@mendelow.me>\r\nTo: slugger@ouro.bot\r\nSubject: Blob proof\r\n\r\nHello from Blob.\r\n"),
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    })

    for (const name of [...serviceClient.container.blobs.keys()]) {
      if (name.startsWith("message-index/slugger/") && name.endsWith(`__${created.message.id}.json`)) {
        serviceClient.container.blobs.delete(name)
      }
    }
    resetBlobCounters(serviceClient.container)

    const duplicateState = serviceClient.container.blobs.get(`messages/${created.message.id}.json`)
    if (!duplicateState) throw new Error("expected duplicate blob state")
    duplicateState.downloadFailuresRemaining = 4
    duplicateState.downloadFailureMessage = "download messages/existing.json timed out after 60000ms"

    const duplicate = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Ari <ari@mendelow.me>\r\nTo: slugger@ouro.bot\r\nSubject: Blob proof\r\n\r\nHello from Blob.\r\n"),
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    })

    expect(duplicate.created).toBe(false)
    expect(duplicate.message.id).toBe(created.message.id)
    expect(duplicateState.downloads).toBe(2)
    expect([...serviceClient.container.blobs.keys()].some((name) => {
      return name.startsWith("message-index/slugger/") && name.endsWith(`__${created.message.id}.json`)
    })).toBe(false)
  })

  it("still throws when an existing duplicate blob fails with a non-retryable read error", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    const created = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Ari <ari@mendelow.me>\r\nTo: slugger@ouro.bot\r\nSubject: Blob proof\r\n\r\nHello from Blob.\r\n"),
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    })

    const duplicateState = serviceClient.container.blobs.get(`messages/${created.message.id}.json`)
    if (!duplicateState) throw new Error("expected duplicate blob state")
    duplicateState.downloadFailuresRemaining = 1
    duplicateState.downloadFailureMessage = "permission denied"

    await expect(store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Ari <ari@mendelow.me>\r\nTo: slugger@ouro.bot\r\nSubject: Blob proof\r\n\r\nHello from Blob.\r\n"),
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    })).rejects.toThrow("permission denied")
    expect(duplicateState.downloads).toBe(1)
  })

  it("treats retryable raw existence failures as degraded duplicates when the blob is confirmed on retry", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    const created = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Ari <ari@mendelow.me>\r\nTo: slugger@ouro.bot\r\nSubject: Blob proof\r\n\r\nHello from Blob.\r\n"),
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    })

    const originalGetBlockBlobClient = serviceClient.container.getBlockBlobClient.bind(serviceClient.container)
    let existsCalls = 0
    serviceClient.container.getBlockBlobClient = ((name: string) => {
      const blob = originalGetBlockBlobClient(name)
      if (name !== `messages/${created.message.id}.json`) return blob
      return {
        ...blob,
        name,
        exists: async () => {
          existsCalls += 1
          if (existsCalls === 1) throw "socket closed early"
          return true
        },
        downloadToBuffer: blob.downloadToBuffer.bind(blob),
      }
    }) as typeof serviceClient.container.getBlockBlobClient

    const duplicate = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Ari <ari@mendelow.me>\r\nTo: slugger@ouro.bot\r\nSubject: Blob proof\r\n\r\nHello from Blob.\r\n"),
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    })

    expect(duplicate.created).toBe(false)
    expect(duplicate.message.id).toBe(created.message.id)
    expect(existsCalls).toBe(2)
  })

  it("still throws retryable duplicate read errors when confirming blob existence also fails", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    const created = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Ari <ari@mendelow.me>\r\nTo: slugger@ouro.bot\r\nSubject: Blob proof\r\n\r\nHello from Blob.\r\n"),
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    })

    const originalGetBlockBlobClient = serviceClient.container.getBlockBlobClient.bind(serviceClient.container)
    let existsCalls = 0
    serviceClient.container.getBlockBlobClient = ((name: string) => {
      const blob = originalGetBlockBlobClient(name)
      if (name !== `messages/${created.message.id}.json`) return blob
      return {
        ...blob,
        name,
        exists: async () => {
          existsCalls += 1
          if (existsCalls === 1) return true
          throw new Error("existence probe timed out")
        },
        downloadToBuffer: async () => {
          throw new Error("socket closed early")
        },
      }
    }) as typeof serviceClient.container.getBlockBlobClient

    await expect(store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Ari <ari@mendelow.me>\r\nTo: slugger@ouro.bot\r\nSubject: Blob proof\r\n\r\nHello from Blob.\r\n"),
      receivedAt: new Date("2024-01-01T00:00:00Z"),
    })).rejects.toThrow("socket closed early")
    expect(existsCalls).toBe(2)
  })

  it("lists recent hosted mail by walking message indexes instead of downloading the whole mailbox", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })
    const { registry, keys } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    for (let index = 0; index < 8; index += 1) {
      const day = `${index + 1}`.padStart(2, "0")
      await store.putRawMessage({
        resolved,
        envelope: {
          mailFrom: `sender-${index}@example.com`,
          rcptTo: ["slugger@ouro.bot"],
        },
        rawMime: Buffer.from(
          `From: Sender ${index} <sender-${index}@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: Indexed ${index}\r\n\r\nHello ${index}.\r\n`,
        ),
        receivedAt: new Date(`2024-01-${day}T00:00:00Z`),
      })
    }

    resetBlobCounters(serviceClient.container)
    const listed = await store.listMessages({ agentId: "slugger", limit: 3 })
    expect(decryptMessages(listed, keys).map((message) => message.private.subject)).toEqual([
      "Indexed 7",
      "Indexed 6",
      "Indexed 5",
    ])
    expect(totalDownloads(serviceClient.container, "message-index/")).toBe(0)
    expect(totalDownloads(serviceClient.container, "messages/")).toBe(3)
  })

  it("limits indexed hosted message downloads to the configured concurrency", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
      messageFetchConcurrency: 2,
    })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    for (let index = 0; index < 5; index += 1) {
      const created = await store.putRawMessage({
        resolved,
        envelope: {
          mailFrom: `slow-${index}@example.com`,
          rcptTo: ["slugger@ouro.bot"],
        },
        rawMime: Buffer.from(
          `From: Slow ${index} <slow-${index}@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: Slow ${index}\r\n\r\nHello ${index}.\r\n`,
        ),
        receivedAt: new Date(`2024-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`),
      })
      const blobState = serviceClient.container.blobs.get(`messages/${created.message.id}.json`)
      if (!blobState) throw new Error("expected stored message blob")
      blobState.downloadDelayMs = 10
    }

    await store.listMessages({ agentId: "slugger", limit: 5 })
    expect(serviceClient.container.maxConcurrentDownloads).toBeLessThanOrEqual(2)
  })

  it("falls back to default hosted message fetch concurrency when options are non-positive", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
      messageFetchConcurrency: 0,
    })
    const { registry, keys } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "fallback@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Fallback <fallback@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: Fallback fetch\r\n\r\nHello.\r\n"),
      receivedAt: new Date("2024-02-01T00:00:00Z"),
    })

    const listed = await store.listMessages({ agentId: "slugger", limit: 1 })
    expect(decryptMessages(listed, keys).map((message) => message.private.subject)).toEqual(["Fallback fetch"])
  })

  it("backfills missing hosted message indexes for legacy mailboxes", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })
    const { registry, keys } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    for (let index = 0; index < 3; index += 1) {
      const day = `${index + 1}`.padStart(2, "0")
      await store.putRawMessage({
        resolved,
        envelope: {
          mailFrom: `legacy-${index}@example.com`,
          rcptTo: ["slugger@ouro.bot"],
        },
        rawMime: Buffer.from(
          `From: Legacy ${index} <legacy-${index}@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: Legacy ${index}\r\n\r\nHello ${index}.\r\n`,
        ),
        receivedAt: new Date(`2024-02-${day}T00:00:00Z`),
      })
    }

    for (const name of [...serviceClient.container.blobs.keys()]) {
      if (name.startsWith("message-index/")) {
        serviceClient.container.blobs.delete(name)
      }
    }

    const legacyPass = await store.listMessages({ agentId: "slugger", limit: 2 })
    expect(decryptMessages(legacyPass, keys).map((message) => message.private.subject)).toEqual([
      "Legacy 2",
      "Legacy 1",
    ])
    expect([...serviceClient.container.blobs.keys()].some((name) => name.startsWith("message-index/slugger/"))).toBe(false)

    await store.backfillMessageIndexes("slugger")
    expect([...serviceClient.container.blobs.keys()].some((name) => name.startsWith("message-index/slugger/"))).toBe(true)

    resetBlobCounters(serviceClient.container)
    const secondPass = await store.listMessages({ agentId: "slugger", limit: 1 })
    expect(decryptMessages(secondPass, keys).map((message) => message.private.subject)).toEqual(["Legacy 2"])
    expect(totalDownloads(serviceClient.container, "messages/")).toBe(1)
  })

  it("fails hosted index backfill with a timeout instead of waiting forever on stalled blobs", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
      blobOperationTimeoutMs: 5,
      backfillConcurrency: 1,
    })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    for (let index = 0; index < 2; index += 1) {
      await store.putRawMessage({
        resolved,
        envelope: {
          mailFrom: `legacy-timeout-${index}@example.com`,
          rcptTo: ["slugger@ouro.bot"],
        },
        rawMime: Buffer.from(
          `From: Legacy Timeout ${index} <legacy-timeout-${index}@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: Legacy timeout ${index}\r\n\r\nHello ${index}.\r\n`,
        ),
        receivedAt: new Date(`2024-03-${String(index + 1).padStart(2, "0")}T00:00:00Z`),
      })
    }

    for (const name of [...serviceClient.container.blobs.keys()]) {
      if (name.startsWith("message-index/")) {
        serviceClient.container.blobs.delete(name)
      }
    }

    const messageBlobNames = [...serviceClient.container.blobs.keys()].filter((name) => name.startsWith("messages/")).sort()
    const stalledBlob = messageBlobNames[1]
    if (!stalledBlob) throw new Error("expected stalled message blob")
    const stalledState = serviceClient.container.blobs.get(stalledBlob)
    if (!stalledState) throw new Error("expected stalled message blob state")
    stalledState.stall = true

    await expect(store.backfillMessageIndexes("slugger")).rejects.toThrow(
      `first failure(s): download ${stalledBlob} timed out after 5ms`,
    )
    expect([...serviceClient.container.blobs.keys()].filter((name) => name.startsWith("message-index/slugger/"))).toHaveLength(1)
  })

  it("uses manual abort timers and fallback blob labels when hosted download timeouts cannot use AbortSignal.timeout", async () => {
    const originalTimeout = AbortSignal.timeout
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true })
    try {
      const serviceClient = new FakeBlobServiceClient()
      const originalGetBlockBlobClient = serviceClient.container.getBlockBlobClient.bind(serviceClient.container)
      serviceClient.container.getBlockBlobClient = ((name: string) => {
        const client = originalGetBlockBlobClient(name)
        if (name !== "messages/stalled.json") return client
        return {
          name: "   ",
          exists: () => client.exists(),
          downloadToBuffer: (offset?: number, count?: number, options?: { abortSignal?: AbortSignal }) => {
            return client.downloadToBuffer(offset, count, options)
          },
          uploadData: (data: Buffer, options?: { abortSignal?: AbortSignal }) => client.uploadData(data, options),
          deleteIfExists: () => client.deleteIfExists(),
        }
      }) as typeof serviceClient.container.getBlockBlobClient

      serviceClient.container.blobs.set("messages/stalled.json", {
        data: Buffer.from("{}\n"),
        downloads: 0,
        uploads: 0,
        deletes: 0,
        stall: true,
      })
      const store = new AzureBlobMailroomStore({
        serviceClient: serviceClient as unknown as BlobServiceClient,
        containerName: "mailroom",
        blobOperationTimeoutMs: 5,
      })

      await expect(store.getMessage("stalled")).rejects.toThrow("download <unknown-blob> timed out after 5ms")
    } finally {
      Object.defineProperty(AbortSignal, "timeout", { value: originalTimeout, configurable: true })
    }
  })

  it("normalizes aborted hosted upload failures during backfill", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
      blobOperationTimeoutMs: 5,
    })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    const created = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "upload-timeout@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Upload Timeout <upload-timeout@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: Upload timeout\r\n\r\nHello.\r\n"),
      receivedAt: new Date("2024-03-04T00:00:00Z"),
    })

    const indexBlobName = [...serviceClient.container.blobs.keys()].find((name) => {
      return name.startsWith("message-index/slugger/") && name.endsWith(`__${created.message.id}.json`)
    })
    if (!indexBlobName) throw new Error("expected hosted index blob")

    for (const name of [...serviceClient.container.blobs.keys()]) {
      if (name.startsWith("message-index/")) {
        serviceClient.container.blobs.delete(name)
      }
    }

    const originalGetBlockBlobClient = serviceClient.container.getBlockBlobClient.bind(serviceClient.container)
    serviceClient.container.getBlockBlobClient = ((name: string) => {
      if (name !== indexBlobName) return originalGetBlockBlobClient(name)
      return {
        name,
        exists: async () => false,
        downloadToBuffer: async () => Buffer.from(""),
        uploadData: async () => {
          throw new Error("upload aborted by upstream")
        },
        deleteIfExists: async () => false,
      }
    }) as typeof serviceClient.container.getBlockBlobClient

    await expect(store.backfillMessageIndexes("slugger")).rejects.toThrow(
      `first failure(s): upload ${indexBlobName} timed out after 5ms`,
    )
  })

  it("records non-Error hosted blob client failures during backfill", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    const created = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "string-failure@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: String Failure <string-failure@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: String failure\r\n\r\nHello.\r\n"),
      receivedAt: new Date("2024-03-05T00:00:00Z"),
    })

    for (const name of [...serviceClient.container.blobs.keys()]) {
      if (name.startsWith("message-index/")) {
        serviceClient.container.blobs.delete(name)
      }
    }

    const messageBlobName = `messages/${created.message.id}.json`
    const originalGetBlockBlobClient = serviceClient.container.getBlockBlobClient.bind(serviceClient.container)
    serviceClient.container.getBlockBlobClient = ((name: string) => {
      if (name === messageBlobName) throw "blob client string failure"
      return originalGetBlockBlobClient(name)
    }) as typeof serviceClient.container.getBlockBlobClient

    await expect(store.backfillMessageIndexes("slugger")).rejects.toThrow(
      "first failure(s): blob client string failure",
    )
  })

  it("normalizes non-Error hosted download failures", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const originalGetBlockBlobClient = serviceClient.container.getBlockBlobClient.bind(serviceClient.container)
    serviceClient.container.getBlockBlobClient = ((name: string) => {
      if (name !== "messages/non-error.json") return originalGetBlockBlobClient(name)
      return {
        name,
        exists: async () => true,
        downloadToBuffer: async () => {
          throw "socket closed early"
        },
        uploadData: async () => undefined,
        deleteIfExists: async () => false,
      }
    }) as typeof serviceClient.container.getBlockBlobClient

    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })

    await expect(store.getMessage("non-error")).rejects.toThrow(
      "download messages/non-error.json failed: socket closed early",
    )
  })

  it("indexes delegated source tokens and skips malformed hosted index names", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })
    const { registry, keys } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "HEY/Primary Lane",
      sourceTag: "hey",
    })
    const delegatedAlias = registry.sourceGrants[0]?.aliasAddress
    if (!delegatedAlias) throw new Error("expected delegated alias")
    const resolved = resolveMailAddress(registry, delegatedAlias)
    if (!resolved) throw new Error("expected delegated mailbox")

    const delegated = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "friend@example.com",
        rcptTo: [delegatedAlias],
      },
      rawMime: Buffer.from(
        `From: Friend <friend@example.com>\r\nTo: ${delegatedAlias}\r\nSubject: Delegated indexed\r\n\r\nHello delegated.\r\n`,
      ),
      classification: {
        placement: "imbox",
        trustReason: "delegated proof",
        candidate: false,
      },
      receivedAt: new Date("2024-04-01T00:00:00Z"),
    })

    const delegatedIndexName = [...serviceClient.container.blobs.keys()].find((name) => {
      return name.startsWith("message-index/slugger/") && name.endsWith(`__${delegated.message.id}.json`)
    })
    expect(delegatedIndexName).toContain("__delegated__imbox__hey%2Fprimary%20lane__")

    serviceClient.container.blobs.set("message-index/slugger/not-json.txt", {
      data: Buffer.from("{}\n"),
      downloads: 0,
      uploads: 0,
      deletes: 0,
    })
    serviceClient.container.blobs.set("message-index/slugger/0000000000000__other__imbox__~__bad-compartment.json", {
      data: Buffer.from("{}\n"),
      downloads: 0,
      uploads: 0,
      deletes: 0,
    })
    serviceClient.container.blobs.set("message-index/slugger/short.json", {
      data: Buffer.from("{}\n"),
      downloads: 0,
      uploads: 0,
      deletes: 0,
    })
    serviceClient.container.blobs.set("message-index/slugger/nested/extra.json", {
      data: Buffer.from("{}\n"),
      downloads: 0,
      uploads: 0,
      deletes: 0,
    })
    serviceClient.container.blobs.set("message-index/slugger/not-a-number__delegated__imbox__hey%2Fprimary%20lane__ghost.json", {
      data: Buffer.from("{}\n"),
      downloads: 0,
      uploads: 0,
      deletes: 0,
    })

    resetBlobCounters(serviceClient.container)
    const listed = await store.listMessages({
      agentId: "slugger",
      compartmentKind: "delegated",
      placement: "imbox",
      source: "hey/primary lane",
      limit: 5,
    })

    expect(decryptMessages(listed, keys).map((message) => message.private.subject)).toEqual(["Delegated indexed"])
    expect(listed[0]?.source).toBe("HEY/Primary Lane")
    expect(totalDownloads(serviceClient.container, "messages/")).toBe(1)
  })

  it("backfills legacy hosted indexes even when stored timestamps are malformed", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")

    const created = await store.putRawMessage({
      resolved,
      envelope: {
        mailFrom: "legacy@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from("From: Legacy <legacy@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: Legacy invalid date\r\n\r\nHello.\r\n"),
      receivedAt: new Date("2024-04-02T00:00:00Z"),
    })

    for (const name of [...serviceClient.container.blobs.keys()]) {
      if (name.startsWith("message-index/")) {
        serviceClient.container.blobs.delete(name)
      }
    }

    const messageBlob = serviceClient.container.blobs.get(`messages/${created.message.id}.json`)
    if (!messageBlob?.data) throw new Error("expected stored message blob")
    const stored = JSON.parse(messageBlob.data.toString("utf-8")) as StoredMailMessage
    serviceClient.container.blobs.set(`messages/${created.message.id}.json`, {
      data: Buffer.from(`${JSON.stringify({ ...stored, receivedAt: "not-a-date" }, null, 2)}\n`),
      downloads: messageBlob.downloads,
      uploads: messageBlob.uploads,
      deletes: messageBlob.deletes,
    })

    expect(await store.backfillMessageIndexes("slugger")).toBe(1)
    expect([...serviceClient.container.blobs.keys()]).toContain(
      `message-index/slugger/9999999999999__native__screener__~__${created.message.id}.json`,
    )
  })

  it("exercises legacy scan and explicit index maintenance helpers for hosted stores", async () => {
    const serviceClient = new FakeBlobServiceClient()
    const store = new AzureBlobMailroomStore({
      serviceClient: serviceClient as unknown as BlobServiceClient,
      containerName: "mailroom",
    })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const resolved = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!resolved) throw new Error("expected slugger mailbox")
    const otherRegistry = provisionMailboxRegistry({ agentId: "other" }).registry
    const otherResolved = resolveMailAddress(otherRegistry, "other@ouro.bot")
    if (!otherResolved) throw new Error("expected other mailbox")

    const first = await store.putRawMessage({
      resolved,
      envelope: { mailFrom: "first@example.com", rcptTo: ["slugger@ouro.bot"] },
      rawMime: Buffer.from("From: First <first@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: First\r\n\r\nHello one.\r\n"),
      classification: { placement: "imbox", trustReason: "trusted", candidate: false },
      receivedAt: new Date("2024-03-01T00:00:00Z"),
    })
    const second = await store.putRawMessage({
      resolved,
      envelope: { mailFrom: "second@example.com", rcptTo: ["slugger@ouro.bot"] },
      rawMime: Buffer.from("From: Second <second@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: Second\r\n\r\nHello two.\r\n"),
      classification: { placement: "screener", trustReason: "new", candidate: true },
      receivedAt: new Date("2024-03-02T00:00:00Z"),
    })
    await store.putRawMessage({
      resolved: otherResolved,
      envelope: { mailFrom: "third@example.com", rcptTo: ["other@ouro.bot"] },
      rawMime: Buffer.from("From: Third <third@example.com>\r\nTo: other@ouro.bot\r\nSubject: Other\r\n\r\nHello three.\r\n"),
      classification: { placement: "imbox", trustReason: "trusted", candidate: false },
      receivedAt: new Date("2024-03-03T00:00:00Z"),
    })

    serviceClient.container.blobs.set("messages/null.json", {
      data: Buffer.from("null\n"),
      downloads: 0,
      uploads: 0,
      deletes: 0,
    })
    for (const name of [...serviceClient.container.blobs.keys()]) {
      if (name.startsWith("message-index/")) {
        serviceClient.container.blobs.delete(name)
      }
    }

    const legacy = await (store as any).listMessagesLegacy({ agentId: "slugger" })
    expect(legacy.map((message: StoredMailMessage) => message.id)).toEqual([second.message.id, first.message.id])

    const indexed = await store.backfillMessageIndexes("slugger")
    expect(indexed).toBe(2)
    expect([...serviceClient.container.blobs.keys()].some((name) => name.startsWith("message-index/other/"))).toBe(false)
    expect(await store.backfillMessageIndexes()).toBe(3)

    await (store as any).removeMessageIndex(second.message)
    expect([...serviceClient.container.blobs.keys()].some((name) => {
      return name.startsWith("message-index/slugger/") && name.endsWith(`__${second.message.id}.json`)
    })).toBe(false)
  })
})
