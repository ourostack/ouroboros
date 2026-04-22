import { describe, expect, it } from "vitest"
import type { BlobServiceClient } from "@azure/storage-blob"
import { provisionMailboxRegistry, resolveMailAddress } from "../../mailroom/core"
import { AzureBlobMailroomStore, decryptBlobMessages } from "../../mailroom/blob-store"
import { decryptMessages } from "../../mailroom/file-store"

class FakeBlockBlobClient {
  constructor(private readonly blobs: Map<string, Buffer>, readonly name: string) {}

  async exists(): Promise<boolean> {
    return this.blobs.has(this.name)
  }

  async downloadToBuffer(): Promise<Buffer> {
    const value = this.blobs.get(this.name)
    if (!value) throw new Error(`missing blob ${this.name}`)
    return value
  }

  async uploadData(data: Buffer): Promise<void> {
    this.blobs.set(this.name, data)
  }
}

class FakeContainerClient {
  readonly blobs = new Map<string, Buffer>()

  async createIfNotExists(): Promise<void> {
    return undefined
  }

  getBlockBlobClient(name: string): FakeBlockBlobClient {
    return new FakeBlockBlobClient(this.blobs, name)
  }

  async *listBlobsFlat(options: { prefix?: string } = {}): AsyncGenerator<{ name: string }> {
    for (const name of [...this.blobs.keys()].sort()) {
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
    expect(serviceClient.container.blobs.has(`messages/${created.message.id}.json`)).toBe(true)
    expect(serviceClient.container.blobs.has(created.message.rawObject)).toBe(true)

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

    serviceClient.container.blobs.set("messages/null.json", Buffer.from("null\n"))
    const listed = await store.listMessages({ agentId: "slugger", placement: "screener", compartmentKind: "native", limit: 10 })
    expect(listed.map((message) => message.id)).toEqual([second.message.id, created.message.id])
    expect(await store.listMessages({ agentId: "slugger", source: "hey" })).toEqual([])
    expect(decryptMessages(listed, keys).map((message) => message.private.subject)).toEqual(["Later blob", "Blob proof"])
    expect(decryptBlobMessages(listed, keys)).toHaveLength(2)
    serviceClient.container.blobs.set("candidates/null.json", Buffer.from("null\n"))
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
    expect(await store.getMessage("missing")).toBeNull()
    expect(await store.updateMessagePlacement("missing", "discarded")).toBeNull()
    expect(await store.updateMessagePlacement(created.message.id, "imbox")).toEqual(expect.objectContaining({
      id: created.message.id,
      placement: "imbox",
    }))
    expect(await store.readRawPayload(created.message.rawObject)).toEqual(expect.objectContaining({
      algorithm: "RSA-OAEP-SHA256+A256GCM",
    }))
    expect(await store.readRawPayload("raw/missing.json")).toBeNull()
    expect(await store.listAccessLog("nobody")).toEqual([])

    serviceClient.container.blobs.set("access-log/slugger.jsonl", Buffer.from("{not json"))
    await store.recordAccess({
      agentId: "slugger",
      messageId: created.message.id,
      tool: "mail_thread",
      reason: "blob store proof",
    })
    await store.recordAccess({
      agentId: "slugger",
      tool: "mail_recent",
      reason: "blob mailbox overview",
    })
    expect(await store.listAccessLog("slugger")).toEqual([
      expect.objectContaining({ tool: "mail_thread", reason: "blob store proof" }),
      expect.objectContaining({ tool: "mail_recent", reason: "blob mailbox overview" }),
    ])

    serviceClient.container.blobs.set("decisions/slugger.json", Buffer.from("{not json"))
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
    serviceClient.container.blobs.set("outbound/null.json", Buffer.from("null\n"))
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
})
