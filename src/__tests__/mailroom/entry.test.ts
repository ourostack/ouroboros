import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { provisionMailboxRegistry } from "../../mailroom/core"
import { parseMailroomEntryArgs, runMailroomEntry } from "../../mailroom/entry"

const tempRoots: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-mail-entry-"))
  tempRoots.push(dir)
  return dir
}

function close(server: { close(callback: () => void): unknown }): Promise<void> {
  return new Promise((resolve) => server.close(resolve))
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("mailroom entry", () => {
  it("parses explicit args and rejects missing required paths", () => {
    expect(parseMailroomEntryArgs([
      "--registry", "/tmp/registry.json",
      "--store", "/tmp/store",
      "--smtp-port", "2526",
      "--http-port", "8081",
      "--host", "127.0.0.1",
    ])).toEqual({
      registryPath: "/tmp/registry.json",
      storePath: "/tmp/store",
      azureContainer: "mailroom",
      smtpPort: 2526,
      httpPort: 8081,
      host: "127.0.0.1",
    })
    expect(parseMailroomEntryArgs([
      "--registry-base64", Buffer.from(JSON.stringify({ schemaVersion: 1 })).toString("base64"),
      "--azure-account-url", "https://mail.blob.core.windows.net",
      "--azure-container", "proof",
    ])).toEqual(expect.objectContaining({
      registryBase64: Buffer.from(JSON.stringify({ schemaVersion: 1 })).toString("base64"),
      azureAccountUrl: "https://mail.blob.core.windows.net",
      azureContainer: "proof",
    }))
    expect(parseMailroomEntryArgs([
      `registry-base64=${Buffer.from(JSON.stringify({ schemaVersion: 1 })).toString("base64")}`,
      "azure-account-url=https://mail.blob.core.windows.net",
      "azure-container=proof",
      "azure-managed-identity-client-id=client-id",
      "smtp-port=2525",
      "http-port=8080",
      "host=0.0.0.0",
    ])).toEqual(expect.objectContaining({
      registryBase64: Buffer.from(JSON.stringify({ schemaVersion: 1 })).toString("base64"),
      azureAccountUrl: "https://mail.blob.core.windows.net",
      azureContainer: "proof",
      azureManagedIdentityClientId: "client-id",
      smtpPort: 2525,
      httpPort: 8080,
      host: "0.0.0.0",
    }))
    expect(() => parseMailroomEntryArgs(["--store", "/tmp/store"])).toThrow("Missing --registry or --registry-base64")
    expect(() => parseMailroomEntryArgs(["--registry", "/tmp/registry.json"])).toThrow("Missing --store or --azure-account-url")
  })

  it("starts ingress from a registry file", async () => {
    const root = tempDir()
    const registryPath = path.join(root, "registry.json")
    const storePath = path.join(root, "store")
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`, "utf-8")

    const servers = runMailroomEntry([
      "--registry", registryPath,
      "--store", storePath,
      "--smtp-port", "0",
      "--http-port", "0",
      "--host", "127.0.0.1",
    ])
    await close(servers.smtp)
    await close(servers.health)
  })
})
