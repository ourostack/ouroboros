import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.doUnmock("@azure/identity")
  vi.doUnmock("@azure/storage-blob")
  vi.doUnmock("../../heart/runtime-credentials")
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

  it("refreshes runtime credentials once when the cached mail reader config is unavailable", async () => {
    let refreshed = false
    const refreshRuntimeCredentialConfig = vi.fn(async (agentName: string) => {
      refreshed = true
      return {
        ok: true,
        itemPath: `vault:${agentName}:runtime/config`,
        config: {
          mailroom: {
            mailboxAddress: "slugger@ouro.bot",
            storePath: "/tmp/mailroom",
            privateKeys: { mail_slugger_primary: "secret" },
          },
        },
        revision: "runtime_refreshed",
        updatedAt: "2026-04-28T00:00:00.000Z",
      }
    })

    vi.doMock("../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: (agentName: string) => refreshed
        ? {
            ok: true,
            itemPath: `vault:${agentName}:runtime/config`,
            config: {
              mailroom: {
                mailboxAddress: "slugger@ouro.bot",
                storePath: "/tmp/mailroom",
                privateKeys: { mail_slugger_primary: "secret" },
              },
            },
            revision: "runtime_refreshed",
            updatedAt: "2026-04-28T00:00:00.000Z",
          }
        : {
            ok: false,
            reason: "unavailable",
            itemPath: `vault:${agentName}:runtime/config`,
            error: "runtime config is unavailable",
          },
      refreshRuntimeCredentialConfig,
    }))

    const { resolveMailroomReaderWithRefresh } = await import("../../mailroom/reader")

    const resolved = await resolveMailroomReaderWithRefresh("slugger")
    expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
    expect(resolved).toEqual(expect.objectContaining({
      ok: true,
      storeKind: "file",
      storeLabel: "/tmp/mailroom",
    }))
  })

  it("returns an already-resolved mail reader without refreshing", async () => {
    const refreshRuntimeCredentialConfig = vi.fn()
    vi.doMock("../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: (agentName: string) => ({
        ok: true,
        itemPath: `vault:${agentName}:runtime/config`,
        config: {
          mailroom: {
            mailboxAddress: "slugger@ouro.bot",
            storePath: "/tmp/mailroom",
            privateKeys: { mail_slugger_primary: "secret" },
          },
        },
        revision: "runtime_cached",
        updatedAt: "2026-04-28T00:00:00.000Z",
      }),
      refreshRuntimeCredentialConfig,
    }))

    const { resolveMailroomReaderWithRefresh } = await import("../../mailroom/reader")

    await expect(resolveMailroomReaderWithRefresh("slugger")).resolves.toEqual(expect.objectContaining({
      ok: true,
      storeKind: "file",
    }))
    expect(refreshRuntimeCredentialConfig).not.toHaveBeenCalled()
  })

  it("does not refresh malformed cached mail reader config", async () => {
    const refreshRuntimeCredentialConfig = vi.fn()
    vi.doMock("../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: (agentName: string) => ({
        ok: true,
        itemPath: `vault:${agentName}:runtime/config`,
        config: { mailroom: { mailboxAddress: "slugger@ouro.bot", privateKeys: null } },
        revision: "runtime_bad",
        updatedAt: "2026-04-28T00:00:00.000Z",
      }),
      refreshRuntimeCredentialConfig,
    }))

    const { resolveMailroomReaderWithRefresh } = await import("../../mailroom/reader")

    await expect(resolveMailroomReaderWithRefresh("slugger")).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: "misconfigured",
    }))
    expect(refreshRuntimeCredentialConfig).not.toHaveBeenCalled()
  })

  it("refreshes a missing local runtime credential cache before giving up", async () => {
    let refreshed = false
    const refreshRuntimeCredentialConfig = vi.fn(async (agentName: string) => {
      refreshed = true
      return {
        ok: true,
        itemPath: `vault:${agentName}:runtime/config`,
        config: {
          mailroom: {
            mailboxAddress: "slugger@ouro.bot",
            storePath: "/tmp/mailroom",
            privateKeys: { mail_slugger_primary: "secret" },
          },
        },
        revision: "runtime_loaded_after_missing_cache",
        updatedAt: "2026-04-28T00:00:00.000Z",
      }
    })
    vi.doMock("../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: (agentName: string) => refreshed
        ? {
            ok: true,
            itemPath: `vault:${agentName}:runtime/config`,
            config: {
              mailroom: {
                mailboxAddress: "slugger@ouro.bot",
                storePath: "/tmp/mailroom",
                privateKeys: { mail_slugger_primary: "secret" },
              },
            },
            revision: "runtime_loaded_after_missing_cache",
            updatedAt: "2026-04-28T00:00:00.000Z",
          }
        : {
            ok: false,
            reason: "missing",
            itemPath: `vault:${agentName}:runtime/config`,
            error: "runtime config is missing",
          },
      refreshRuntimeCredentialConfig,
    }))

    const { resolveMailroomReaderWithRefresh } = await import("../../mailroom/reader")

    await expect(resolveMailroomReaderWithRefresh("slugger")).resolves.toEqual(expect.objectContaining({
      ok: true,
      storeKind: "file",
      storeLabel: "/tmp/mailroom",
    }))
    expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
  })

  it("keeps the original auth-required reader error when refresh fails", async () => {
    const refreshRuntimeCredentialConfig = vi.fn(async () => {
      throw new Error("vault unavailable")
    })
    vi.doMock("../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: (agentName: string) => ({
        ok: false,
        reason: "unavailable",
        itemPath: `vault:${agentName}:runtime/config`,
        error: "vault unavailable",
      }),
      refreshRuntimeCredentialConfig,
    }))

    const { resolveMailroomReaderWithRefresh } = await import("../../mailroom/reader")

    await expect(resolveMailroomReaderWithRefresh("slugger")).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: "auth-required",
    }))
    expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
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

  it("writes hosted registry blobs when no local registry path is present", async () => {
    const uploads: Array<{ contentType: string | undefined; body: string }> = []

    vi.doMock("@azure/storage-blob", () => ({
      BlobServiceClient: class {
        getContainerClient(containerName: string) {
          expect(containerName).toBe("mailroom")
          return {
            getBlockBlobClient(blobName: string) {
              expect(blobName).toBe("registry/mailroom.json")
              return {
                upload: async (body: string | Buffer, _byteLength: number, options?: { blobHTTPHeaders?: { blobContentType?: string } }) => {
                  uploads.push({
                    contentType: options?.blobHTTPHeaders?.blobContentType,
                    body: Buffer.isBuffer(body) ? body.toString("utf-8") : body,
                  })
                },
              }
            },
          }
        }
      },
    }))

    const { writeMailroomRegistry } = await import("../../mailroom/reader")
    const registry = {
      schemaVersion: 1,
      domain: "ouro.bot",
      mailboxes: [{ agentId: "slugger", mailboxId: "mailbox_slugger", canonicalAddress: "slugger@ouro.bot", keyId: "mail_slugger", publicKeyPem: "pem", defaultPlacement: "screener" }],
      sourceGrants: [],
      senderPolicies: [],
    }

    await expect(writeMailroomRegistry({
      mailboxAddress: "slugger@ouro.bot",
      registryAzureAccountUrl: "https://registry.blob.core.windows.net",
      registryContainer: "mailroom",
      registryBlob: "registry/mailroom.json",
      privateKeys: { mail_slugger_primary: "secret" },
    }, registry as any)).resolves.toBeUndefined()

    expect(uploads).toEqual([{
      contentType: "application/json; charset=utf-8",
      body: `${JSON.stringify(registry, null, 2)}\n`,
    }])
  })

  it("rejects hosted registry writes when runtime config omits hosted registry coordinates", async () => {
    const { writeMailroomRegistry } = await import("../../mailroom/reader")

    await expect(writeMailroomRegistry({
      mailboxAddress: "slugger@ouro.bot",
      privateKeys: { mail_slugger_primary: "secret" },
    }, {
      schemaVersion: 1,
      domain: "ouro.bot",
      mailboxes: [],
      sourceGrants: [],
    } as any)).rejects.toThrow("mailroom config is missing registryPath or hosted registry coordinates")
  })
})
