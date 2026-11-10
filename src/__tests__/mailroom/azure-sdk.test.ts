import { describe, expect, it } from "vitest"
import { loadAzureBlobSdk } from "../../mailroom/azure-sdk"

describe("loadAzureBlobSdk", () => {
  it("loads the Azure storage and identity SDKs once, on first use", () => {
    const first = loadAzureBlobSdk()
    expect(first.BlobServiceClient.name).toBe("BlobServiceClient")
    expect(first.DefaultAzureCredential.name).toBe("DefaultAzureCredential")
    const client = new first.BlobServiceClient("https://example.blob.core.windows.net", new first.DefaultAzureCredential())
    expect(client.url).toBe("https://example.blob.core.windows.net/")
    expect(loadAzureBlobSdk()).toBe(first)
  })
})
