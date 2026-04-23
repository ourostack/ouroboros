import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { provisionMailboxRegistry } from "../../mailroom/core"
import { FileMailroomStore, ingestRawMailToStore, type MailroomStore } from "../../mailroom/file-store"
import { cacheRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../heart/runtime-credentials"
import { resetIdentity } from "../../heart/identity"
import { startMailSenseApp } from "../../senses/mail"

const tempRoots: string[] = []
const originalHome = process.env.HOME

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-mail-sense-"))
  tempRoots.push(dir)
  return dir
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
}

function pendingBodies(agentRoot: string): string[] {
  const pendingDir = path.join(agentRoot, "state", "pending", "self", "inner", "dialog")
  return fs.readdirSync(pendingDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson<{ content?: string }>(path.join(pendingDir, name)).content ?? "")
}

afterEach(() => {
  vi.useRealTimers()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  resetIdentity()
  resetRuntimeCredentialConfigCache()
  vi.restoreAllMocks()
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("mail sense runtime", () => {
  it("starts ingress, scans Screener into inner pending attention, and writes runtime state", async () => {
    const homeRoot = tempDir()
    process.env.HOME = homeRoot
    const agentRoot = path.join(homeRoot, "AgentBundles", "slugger.ouro")
    const storePath = path.join(agentRoot, "state", "mailroom")
    const registryPath = path.join(storePath, "registry.json")
    fs.mkdirSync(storePath, { recursive: true })
    const { registry, keys } = provisionMailboxRegistry({ agentId: "slugger" })
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8")
    const store = new FileMailroomStore({ rootDir: storePath })
    await ingestRawMailToStore({
      registry,
      store,
      envelope: {
        mailFrom: "newperson@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from([
        "From: New Person <newperson@example.com>",
        "To: Slugger <slugger@ouro.bot>",
        "Subject: Hello",
        "",
        "PRIVATE BODY SHOULD NOT BE IN THE PENDING NUDGE.",
      ].join("\r\n")),
    })
    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        registryPath,
        storePath,
        privateKeys: keys,
        smtpPort: 0,
        httpPort: 0,
        attentionIntervalMs: 5_000,
      },
    })

    const interval = vi.fn(() => "timer")
    const clearInterval = vi.fn()
    const app = await startMailSenseApp({
      agentName: "slugger",
      now: () => 1_777_000_000_000,
      refreshRuntime: async () => ({
        ok: true,
        itemPath: "vault:slugger:runtime/config",
        config: {},
        revision: "test",
        updatedAt: new Date(0).toISOString(),
      }),
      setIntervalFn: interval,
      clearIntervalFn: clearInterval,
    })

    expect(typeof app.smtpPort).toBe("number")
    expect(typeof app.httpPort).toBe("number")
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 5_000)
    const runtime = readJson<{ status: string; mailboxAddress: string; lastQueuedCount: number }>(app.runtimeStatePath)
    expect(runtime).toEqual(expect.objectContaining({
      status: "running",
      mailboxAddress: "slugger@ouro.bot",
      lastQueuedCount: 1,
    }))
    expect(pendingBodies(agentRoot)[0]).toContain("newperson@example.com")
    expect(pendingBodies(agentRoot)[0]).not.toContain("PRIVATE BODY")

    await app.stop()
    expect(clearInterval).toHaveBeenCalledWith("timer")
    expect(readJson<{ status: string }>(app.runtimeStatePath).status).toBe("stopped")
  })

  it("keeps the process alive and emits a scan error when attention scanning fails", async () => {
    const homeRoot = tempDir()
    process.env.HOME = homeRoot
    const agentRoot = path.join(homeRoot, "AgentBundles", "slugger.ouro")
    const registryPath = path.join(agentRoot, "state", "mailroom", "registry.json")
    fs.mkdirSync(path.dirname(registryPath), { recursive: true })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8")
    let scans = 0
    let intervalCallback: (() => void) | undefined
    const store = {
      listScreenerCandidates: async () => {
        scans += 1
        return Promise.reject(scans === 1 ? "scan boom" : new Error("scan boom again"))
      },
    } as unknown as MailroomStore
    const close = vi.fn((callback: () => void) => callback())
    const fakeServer = (port: number) => ({
      address: () => ({ address: "127.0.0.1", family: "IPv4", port }),
      close,
    })
    const app = await startMailSenseApp({
      agentName: "slugger",
      now: () => 1_777_000_000_000,
      refreshRuntime: async () => ({
        ok: true,
        itemPath: "vault:slugger:runtime/config",
        config: {},
        revision: "test",
        updatedAt: new Date(0).toISOString(),
      }),
      resolveReader: () => ({
        ok: true,
        agentName: "slugger",
        config: {
          mailboxAddress: "slugger@ouro.bot",
          registryPath,
          privateKeys: { key: "secret" },
        },
        store,
        storeKind: "file",
        storeLabel: "fake",
      }),
      startIngress: () => ({
        smtp: fakeServer(2525),
        health: fakeServer(8080),
      }) as never,
      setIntervalFn: (callback) => {
        intervalCallback = callback
        return "timer"
      },
      clearIntervalFn: vi.fn(),
    })

    expect(app.smtpPort).toBe(2525)
    expect(app.httpPort).toBe(8080)
    intervalCallback?.()
    await new Promise((resolve) => setImmediate(resolve))
    await app.stop()
    expect(close).toHaveBeenCalledTimes(2)
  })

  it("fails fast when runtime mail config is unavailable or missing registryPath", async () => {
    await expect(startMailSenseApp({
      agentName: "slugger",
      refreshRuntime: async () => ({
        ok: false,
        itemPath: "vault:slugger:runtime/config",
        reason: "missing",
        error: "missing",
      }),
      resolveReader: () => ({
        ok: false,
        agentName: "slugger",
        reason: "auth-required",
        error: "AUTH_REQUIRED:mailroom -- missing runtime/config",
      }),
    })).rejects.toThrow("AUTH_REQUIRED:mailroom")

    await expect(startMailSenseApp({
      agentName: "slugger",
      refreshRuntime: async () => ({
        ok: true,
        itemPath: "vault:slugger:runtime/config",
        config: {},
        revision: "test",
        updatedAt: new Date(0).toISOString(),
      }),
      resolveReader: () => ({
        ok: true,
        agentName: "slugger",
        config: {
          mailboxAddress: "slugger@ouro.bot",
          privateKeys: { key: "secret" },
        },
        store: new FileMailroomStore({ rootDir: tempDir() }),
        storeKind: "file",
        storeLabel: "missing-registry",
      }),
    })).rejects.toThrow("missing mailroom.registryPath")
  })

  it("scans hosted Blob mail without starting local SMTP ingress", async () => {
    const homeRoot = tempDir()
    process.env.HOME = homeRoot
    const agentRoot = path.join(homeRoot, "AgentBundles", "slugger.ouro")
    const startIngress = vi.fn()
    const store = {
      listScreenerCandidates: async () => [{
        schemaVersion: 1,
        id: "candidate_hosted",
        agentId: "slugger",
        mailboxId: "mailbox_slugger",
        messageId: "mail_hosted",
        senderEmail: "newperson@example.com",
        senderDisplay: "New Person",
        recipient: "slugger@ouro.bot",
        placement: "screener",
        status: "pending",
        trustReason: "native agent mailbox default screener",
        firstSeenAt: "2026-04-22T20:00:00.000Z",
        lastSeenAt: "2026-04-22T20:00:00.000Z",
        messageCount: 1,
      }],
    } as unknown as MailroomStore

    const app = await startMailSenseApp({
      agentName: "slugger",
      now: () => 1_777_000_000_000,
      refreshRuntime: async () => ({
        ok: true,
        itemPath: "vault:slugger:runtime/config",
        config: {},
        revision: "test",
        updatedAt: new Date(0).toISOString(),
      }),
      resolveReader: () => ({
        ok: true,
        agentName: "slugger",
        config: {
          mailboxAddress: "slugger@ouro.bot",
          azureAccountUrl: "https://stourotest.blob.core.windows.net",
          azureContainer: "mailroom",
          privateKeys: { mail_slugger_native: "secret" },
          attentionIntervalMs: 5_000,
        },
        store,
        storeKind: "azure-blob",
        storeLabel: "https://stourotest.blob.core.windows.net/mailroom",
      }),
      startIngress,
      setIntervalFn: () => "timer",
      clearIntervalFn: vi.fn(),
    })

    expect(startIngress).not.toHaveBeenCalled()
    expect(app.smtpPort).toBeNull()
    expect(app.httpPort).toBeNull()
    const runtime = readJson<{ status: string; storeKind: string; storeLabel: string; lastQueuedCount: number }>(app.runtimeStatePath)
    expect(runtime).toEqual(expect.objectContaining({
      status: "running",
      storeKind: "azure-blob",
      storeLabel: "https://stourotest.blob.core.windows.net/mailroom",
      lastQueuedCount: 1,
    }))
    expect(pendingBodies(agentRoot)[0]).toContain("newperson@example.com")

    await app.stop()
  })

  it("supports servers without address helpers and scans on the interval callback", async () => {
    const homeRoot = tempDir()
    process.env.HOME = homeRoot
    const agentRoot = path.join(homeRoot, "AgentBundles", "slugger.ouro")
    const registryPath = path.join(agentRoot, "state", "mailroom", "registry.json")
    fs.mkdirSync(path.dirname(registryPath), { recursive: true })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8")
    const store = new FileMailroomStore({ rootDir: path.join(agentRoot, "state", "mailroom") })
    let intervalCallback: (() => void) | undefined
    const close = vi.fn((callback: () => void) => callback())
    const serverWithoutAddress = { close }

    const app = await startMailSenseApp({
      agentName: "slugger",
      now: () => 1_777_000_000_000,
      refreshRuntime: async () => ({
        ok: true,
        itemPath: "vault:slugger:runtime/config",
        config: {},
        revision: "test",
        updatedAt: new Date(0).toISOString(),
      }),
      resolveReader: () => ({
        ok: true,
        agentName: "slugger",
        config: {
          mailboxAddress: "slugger@ouro.bot",
          registryPath,
          privateKeys: { key: "secret" },
          smtpPort: -1,
          httpPort: 70000,
          host: "0.0.0.0",
          attentionIntervalMs: 1,
        },
        store,
        storeKind: "file",
        storeLabel: "no-address",
      }),
      startIngress: () => ({
        smtp: serverWithoutAddress,
        health: serverWithoutAddress,
      }) as never,
      setIntervalFn: (callback) => {
        intervalCallback = callback
        return "timer"
      },
      clearIntervalFn: vi.fn(),
    })

    expect(app.smtpPort).toBeNull()
    expect(app.httpPort).toBeNull()
    expect(intervalCallback).toBeTruthy()
    intervalCallback?.()
    await new Promise((resolve) => setImmediate(resolve))
    await app.stop()
    expect(close).toHaveBeenCalledTimes(2)
  })

  it("uses default interval wiring and rescans on the runtime timer", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-21T20:00:00.000Z"))
    const homeRoot = tempDir()
    process.env.HOME = homeRoot
    const agentRoot = path.join(homeRoot, "AgentBundles", "slugger.ouro")
    const registryPath = path.join(agentRoot, "state", "mailroom", "registry.json")
    fs.mkdirSync(path.dirname(registryPath), { recursive: true })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8")
    const store = {
      listScreenerCandidates: vi.fn(async () => []),
    } as unknown as MailroomStore
    const close = vi.fn((callback: () => void) => callback())
    const fakeServer = (port: number) => ({
      address: () => ({ address: "127.0.0.1", family: "IPv4", port }),
      close,
    })

    const app = await startMailSenseApp({
      agentName: "slugger",
      refreshRuntime: async () => {
        throw new Error("vault refresh unavailable")
      },
      resolveReader: () => ({
        ok: true,
        agentName: "slugger",
        config: {
          mailboxAddress: "slugger@ouro.bot",
          registryPath,
          privateKeys: { key: "secret" },
          attentionIntervalMs: 1,
        },
        store,
        storeKind: "file",
        storeLabel: "timer",
      }),
      startIngress: () => ({
        smtp: fakeServer(2525),
        health: fakeServer(8080),
      }) as never,
    })

    expect(store.listScreenerCandidates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.listScreenerCandidates).toHaveBeenCalledTimes(2)
    await app.stop()
    expect(close).toHaveBeenCalledTimes(2)
  })

  it("accepts listening server wrappers and address objects without numeric ports", async () => {
    const homeRoot = tempDir()
    process.env.HOME = homeRoot
    const agentRoot = path.join(homeRoot, "AgentBundles", "slugger.ouro")
    const registryPath = path.join(agentRoot, "state", "mailroom", "registry.json")
    fs.mkdirSync(path.dirname(registryPath), { recursive: true })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8")
    const store = new FileMailroomStore({ rootDir: path.join(agentRoot, "state", "mailroom") })
    const close = vi.fn((callback: () => void) => callback())
    const addressWithoutPort = {
      address: () => ({ address: "127.0.0.1", family: "IPv4" }),
      close,
    }
    const wrappedListening = {
      server: {
        listening: true,
        once: vi.fn(),
      },
      close,
    }

    const app = await startMailSenseApp({
      agentName: "slugger",
      now: () => 1_777_000_000_000,
      refreshRuntime: async () => ({
        ok: true,
        itemPath: "vault:slugger:runtime/config",
        config: {},
        revision: "test",
        updatedAt: new Date(0).toISOString(),
      }),
      resolveReader: () => ({
        ok: true,
        agentName: "slugger",
        config: {
          mailboxAddress: "slugger@ouro.bot",
          registryPath,
          privateKeys: { key: "secret" },
        },
        store,
        storeKind: "file",
        storeLabel: "wrapped",
      }),
      startIngress: () => ({
        smtp: addressWithoutPort,
        health: wrappedListening,
      }) as never,
      setIntervalFn: () => "timer",
      clearIntervalFn: vi.fn(),
    })

    expect(app.smtpPort).toBeNull()
    expect(app.httpPort).toBeNull()
    await app.stop()
    expect(wrappedListening.server.once).not.toHaveBeenCalled()
  })
})
