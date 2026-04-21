import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.doUnmock("@azure/identity")
  vi.doUnmock("@azure/storage-blob")
  vi.resetModules()
})

describe("mailroom reader", () => {
  it("resolves Azure Blob mailroom stores with managed identity and default container", async () => {
    const credentialOptions: unknown[] = []
    const serviceUrls: string[] = []

    vi.doMock("@azure/identity", () => ({
      DefaultAzureCredential: class {
        constructor(options?: unknown) {
          credentialOptions.push(options ?? null)
        }
      },
    }))
    vi.doMock("@azure/storage-blob", () => ({
      BlobServiceClient: class {
        constructor(url: string) {
          serviceUrls.push(url)
        }

        getContainerClient() {
          return {}
        }
      },
    }))

    const { cacheRuntimeCredentialConfig } = await import("../../heart/runtime-credentials")
    const { resolveMailroomReader } = await import("../../mailroom/reader")

    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        azureAccountUrl: "https://mail.blob.core.windows.net",
        azureManagedIdentityClientId: "client-id",
        privateKeys: { mail_slugger_primary: "secret" },
      },
    })

    const resolved = resolveMailroomReader("slugger")
    expect(resolved).toEqual(expect.objectContaining({
      ok: true,
      storeKind: "azure-blob",
      storeLabel: "https://mail.blob.core.windows.net/mailroom",
    }))
    expect(credentialOptions).toEqual([{ managedIdentityClientId: "client-id" }])
    expect(serviceUrls).toEqual(["https://mail.blob.core.windows.net"])
  })

  it("resolves Azure Blob mailroom stores with default credentials and explicit container", async () => {
    const credentialOptions: unknown[] = []

    vi.doMock("@azure/identity", () => ({
      DefaultAzureCredential: class {
        constructor(options?: unknown) {
          credentialOptions.push(options ?? null)
        }
      },
    }))
    vi.doMock("@azure/storage-blob", () => ({
      BlobServiceClient: class {
        getContainerClient() {
          return {}
        }
      },
    }))

    const { cacheRuntimeCredentialConfig } = await import("../../heart/runtime-credentials")
    const { resolveMailroomReader } = await import("../../mailroom/reader")

    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        azureAccountUrl: "https://mail.blob.core.windows.net",
        azureContainer: "proof",
        privateKeys: { mail_slugger_primary: "secret" },
      },
    })

    const resolved = resolveMailroomReader("slugger")
    expect(resolved).toEqual(expect.objectContaining({
      ok: true,
      storeKind: "azure-blob",
      storeLabel: "https://mail.blob.core.windows.net/proof",
    }))
    expect(credentialOptions).toEqual([null])
  })
})
