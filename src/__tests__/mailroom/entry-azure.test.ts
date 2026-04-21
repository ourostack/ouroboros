import { afterEach, describe, expect, it, vi } from "vitest"
import { provisionMailboxRegistry } from "../../mailroom/core"

function close(server: { close(callback: () => void): unknown }): Promise<void> {
  return new Promise((resolve) => server.close(resolve))
}

afterEach(() => {
  vi.doUnmock("@azure/identity")
  vi.doUnmock("@azure/storage-blob")
  vi.resetModules()
})

describe("mailroom Azure entry", () => {
  it("starts with Azure Blob storage from key=value args and managed identity", async () => {
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
          return {
            async createIfNotExists() {
              return undefined
            },
            getBlockBlobClient() {
              return {
                async exists() {
                  return false
                },
              }
            },
          }
        }
      },
    }))

    const { runMailroomEntry } = await import("../../mailroom/entry")
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const servers = runMailroomEntry([
      `registry-base64=${Buffer.from(JSON.stringify(registry)).toString("base64")}`,
      "azure-account-url=https://mail.blob.core.windows.net",
      "azure-container=proof",
      "azure-managed-identity-client-id=client-id",
      "smtp-port=0",
      "http-port=0",
      "host=127.0.0.1",
    ])

    expect(credentialOptions).toEqual([{ managedIdentityClientId: "client-id" }])
    expect(serviceUrls).toEqual(["https://mail.blob.core.windows.net"])
    await close(servers.smtp)
    await close(servers.health)
  })

  it("starts with Azure Blob storage without a managed identity client id", async () => {
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
          return {
            async createIfNotExists() {
              return undefined
            },
          }
        }
      },
    }))

    const { runMailroomEntry } = await import("../../mailroom/entry")
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const servers = runMailroomEntry([
      `registry-base64=${Buffer.from(JSON.stringify(registry)).toString("base64")}`,
      "azure-account-url=https://mail.blob.core.windows.net",
      "smtp-port=0",
      "http-port=0",
      "host=127.0.0.1",
    ])

    expect(credentialOptions).toEqual([null])
    await close(servers.smtp)
    await close(servers.health)
  })
})
