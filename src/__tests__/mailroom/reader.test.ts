import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.doUnmock("@azure/identity")
  vi.doUnmock("@azure/storage-blob")
  vi.resetModules()
})

describe("mailroom reader", () => {
  it("parses optional runtime knobs without requiring Azure storage", async () => {
    const { parseMailroomConfig } = await import("../../mailroom/reader")

    expect(parseMailroomConfig({
      mailboxAddress: "slugger@ouro.bot",
      registryPath: "/tmp/registry.json",
      storePath: "/tmp/mailroom",
      smtpPort: 2525,
      httpPort: 8080,
      host: "0.0.0.0",
      attentionIntervalMs: 12_000,
      outbound: { transport: "local-sink", sinkPath: "/tmp/sent.jsonl" },
      privateKeys: { primary: "secret", empty: "   " },
    })).toEqual({
      mailboxAddress: "slugger@ouro.bot",
      registryPath: "/tmp/registry.json",
      storePath: "/tmp/mailroom",
      smtpPort: 2525,
      httpPort: 8080,
      host: "0.0.0.0",
      attentionIntervalMs: 12_000,
      outbound: { transport: "local-sink", sinkPath: "/tmp/sent.jsonl" },
      privateKeys: { primary: "secret" },
    })
  })

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
