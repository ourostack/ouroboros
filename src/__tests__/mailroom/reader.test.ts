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
      registryAzureAccountUrl: "https://registry.blob.core.windows.net",
      registryContainer: "mailroom",
      registryBlob: "registry/mailroom.json",
      smtpPort: 2525,
      httpPort: 8080,
      host: "0.0.0.0",
      attentionIntervalMs: 12_000,
      outbound: { transport: "local-sink", sinkPath: "/tmp/sent.jsonl" },
      autonomousSendPolicy: {
        schemaVersion: 1,
        policyId: "mail_auto_slugger",
        agentId: "slugger",
        mailboxAddress: "slugger@ouro.bot",
        enabled: true,
        killSwitch: false,
        allowedRecipients: ["ari@mendelow.me"],
        allowedDomains: ["trusted.example"],
        maxRecipientsPerMessage: 3,
        rateLimit: { maxSends: 2, windowMs: 60_000 },
      },
      privateKeys: { primary: "secret", empty: "   " },
    })).toEqual({
      mailboxAddress: "slugger@ouro.bot",
      registryPath: "/tmp/registry.json",
      storePath: "/tmp/mailroom",
      registryAzureAccountUrl: "https://registry.blob.core.windows.net",
      registryContainer: "mailroom",
      registryBlob: "registry/mailroom.json",
      smtpPort: 2525,
      httpPort: 8080,
      host: "0.0.0.0",
      attentionIntervalMs: 12_000,
      outbound: { transport: "local-sink", sinkPath: "/tmp/sent.jsonl" },
      autonomousSendPolicy: {
        schemaVersion: 1,
        policyId: "mail_auto_slugger",
        agentId: "slugger",
        mailboxAddress: "slugger@ouro.bot",
        enabled: true,
        killSwitch: false,
        allowedRecipients: ["ari@mendelow.me"],
        allowedDomains: ["trusted.example"],
        maxRecipientsPerMessage: 3,
        rateLimit: { maxSends: 2, windowMs: 60_000 },
      },
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

  it("reads hosted public registry blobs when no local registry path is present", async () => {
    const credentialOptions: unknown[] = []
    const registryJson = {
      schemaVersion: 1,
      domain: "ouro.bot",
      mailboxes: [{ agentId: "slugger", mailboxId: "mailbox_slugger", canonicalAddress: "slugger@ouro.bot", keyId: "mail_slugger", publicKeyPem: "pem", defaultPlacement: "screener" }],
      sourceGrants: [],
    }

    vi.doMock("@azure/identity", () => ({
      DefaultAzureCredential: class {
        constructor(options?: unknown) {
          credentialOptions.push(options ?? null)
        }
      },
    }))
    vi.doMock("@azure/storage-blob", () => ({
      BlobServiceClient: class {
        getContainerClient(containerName: string) {
          expect(containerName).toBe("mailroom")
          return {
            getBlockBlobClient(blobName: string) {
              expect(blobName).toBe("registry/mailroom.json")
              return {
                exists: async () => true,
                downloadToBuffer: async () => Buffer.from(`${JSON.stringify(registryJson)}\n`, "utf-8"),
              }
            },
          }
        }
      },
    }))

    const { readMailroomRegistry } = await import("../../mailroom/reader")

    await expect(readMailroomRegistry({
      mailboxAddress: "slugger@ouro.bot",
      azureAccountUrl: "https://mail.blob.core.windows.net",
      azureManagedIdentityClientId: "client-id",
      registryAzureAccountUrl: "https://registry.blob.core.windows.net",
      registryContainer: "mailroom",
      registryBlob: "registry/mailroom.json",
      privateKeys: { mail_slugger_primary: "secret" },
    })).resolves.toEqual(registryJson)
    expect(credentialOptions).toEqual([{ managedIdentityClientId: "client-id" }])
  })

  it("rejects hosted registry reads when runtime config omits hosted registry coordinates", async () => {
    const { readMailroomRegistry } = await import("../../mailroom/reader")

    await expect(readMailroomRegistry({
      mailboxAddress: "slugger@ouro.bot",
      privateKeys: { mail_slugger_primary: "secret" },
    })).rejects.toThrow("mailroom config is missing registryPath or hosted registry coordinates")
  })

  it("rejects hosted registry reads when the configured registry blob is missing", async () => {
    vi.doMock("@azure/storage-blob", () => ({
      BlobServiceClient: class {
        getContainerClient() {
          return {
            getBlockBlobClient() {
              return {
                exists: async () => false,
              }
            },
          }
        }
      },
    }))

    const { readMailroomRegistry } = await import("../../mailroom/reader")

    await expect(readMailroomRegistry({
      mailboxAddress: "slugger@ouro.bot",
      registryAzureAccountUrl: "https://registry.blob.core.windows.net",
      registryContainer: "mailroom",
      registryBlob: "registry/missing.json",
      privateKeys: { mail_slugger_primary: "secret" },
    })).rejects.toThrow("mailroom registry blob not found: https://registry.blob.core.windows.net/mailroom/registry/missing.json")
  })
})
