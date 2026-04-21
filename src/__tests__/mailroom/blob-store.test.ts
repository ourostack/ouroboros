import { describe, expect, it } from "vitest"
import type { BlobServiceClient } from "@azure/storage-blob"
import { provisionMailboxRegistry, resolveMailAddress } from "../../mailroom/core"
import { AzureBlobMailroomStore } from "../../mailroom/blob-store"
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

    const listed = await store.listMessages({ agentId: "slugger" })
    expect(decryptMessages(listed, keys)[0].private.subject).toBe("Blob proof")
    expect(await store.readRawPayload(created.message.rawObject)).toEqual(expect.objectContaining({
      algorithm: "RSA-OAEP-SHA256+A256GCM",
    }))

    await store.recordAccess({
      agentId: "slugger",
      messageId: created.message.id,
      tool: "mail_thread",
      reason: "blob store proof",
    })
    expect(await store.listAccessLog("slugger")).toEqual([
      expect.objectContaining({ tool: "mail_thread", reason: "blob store proof" }),
    ])
  })
})
