import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { blobHostedMailCopies } from "../../mailroom/blob-store"

function notFound(): Error {
  return Object.assign(new Error("The specified blob does not exist."), { statusCode: 404 })
}

function fakeContainer(blobs: Record<string, { body?: string; size?: number; error?: Error }>) {
  const names: string[] = []
  return {
    names,
    getBlockBlobClient(name: string) {
      names.push(name)
      const blob = blobs[name]
      return {
        name,
        exists: async () => blob !== undefined,
        downloadToBuffer: async () => {
          if (blob?.error) throw blob.error
          if (!blob || blob.body === undefined) throw notFound()
          return Buffer.from(blob.body)
        },
        getProperties: async () => {
          if (blob?.error) throw blob.error
          if (!blob) throw notFound()
          return { contentLength: blob.size }
        },
      }
    },
  }
}

describe("blobHostedMailCopies", () => {
  it("reads messages/<id>.json and a raw object's size", async () => {
    const container = fakeContainer({
      "messages/mail_a.json": { body: JSON.stringify({ rawSha256: "h", rawSize: 3, rawObject: "raw/mail_a.k.json" }) },
      "raw/mail_a.k.json": { size: 512 },
      "raw/no-length.json": {},
    })
    const copies = blobHostedMailCopies(container)
    expect(await copies.readMessage("mail_a")).toEqual({ rawSha256: "h", rawSize: 3, rawObject: "raw/mail_a.k.json" })
    expect(await copies.rawObjectSize("raw/mail_a.k.json")).toBe(512)
    expect(await copies.rawObjectSize("raw/no-length.json")).toBeNull()
    expect(container.names).toContain("messages/mail_a.json")
  })

  it("says null for a blob that doesn't exist", async () => {
    const copies = blobHostedMailCopies(fakeContainer({}))
    expect(await copies.readMessage("mail_missing")).toBeNull()
    expect(await copies.rawObjectSize("raw/missing.json")).toBeNull()
  })

  it("throws when Blob can't say", async () => {
    const denied = Object.assign(new Error("AuthorizationFailure"), { statusCode: 403 })
    const copies = blobHostedMailCopies(fakeContainer({ "messages/mail_a.json": { error: denied }, "raw/a.json": { error: denied } }))
    await expect(copies.readMessage("mail_a")).rejects.toThrow()
    await expect(copies.rawObjectSize("raw/a.json")).rejects.toThrow("AuthorizationFailure")
  })
})

describe("openHostedMailCopies", () => {
  beforeEach(() => {
    vi.doMock("../../mailroom/azure-sdk", () => ({
      loadAzureBlobSdk: () => ({
        BlobServiceClient: class {
          constructor(public url: string) {}
          getContainerClient(name: string) { return fakeContainer({ [`messages/${name}.json`]: { body: "{}" } }) }
        },
        DefaultAzureCredential: class {},
      }),
    }))
  })
  afterEach(() => {
    vi.doUnmock("../../mailroom/azure-sdk")
    vi.doUnmock("../../heart/runtime-credentials")
    vi.resetModules()
  })

  async function open(runtime: unknown) {
    vi.resetModules()
    vi.doMock("../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: () => runtime,
      refreshRuntimeCredentialConfig: async () => runtime,
    }))
    const { openHostedMailCopies } = await import("../../mailroom/reader")
    return openHostedMailCopies("slugger")
  }

  it("opens the agent's hosted container", async () => {
    const copies = await open({ ok: true, config: { mailroom: { azureAccountUrl: "https://acct.blob.core.windows.net", azureContainer: "box", azureManagedIdentityClientId: "mi" } } })
    expect(await copies?.readMessage("box")).toEqual({})
  })

  it("defaults the container to mailroom", async () => {
    const copies = await open({ ok: true, config: { mailroom: { azureAccountUrl: "https://acct.blob.core.windows.net" } } })
    expect(await copies?.readMessage("mailroom")).toEqual({})
  })

  it("is null when mail isn't hosted or the config can't be read", async () => {
    expect(await open({ ok: false, reason: "locked" })).toBeNull()
    expect(await open({ ok: true, config: { mailroom: { storePath: "/x" } } })).toBeNull()
    expect(await open({ ok: true, config: {} })).toBeNull()
  })
})
