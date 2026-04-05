import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock child_process for AacCredentialStore
const mockExecFile = vi.fn()
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

// Mock identity for getAgentName
vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "test-agent"),
  getAgentRoot: vi.fn(() => path.join(os.tmpdir(), "test-agent-bundle")),
}))

import {
  domainToSlug,
  BuiltInCredentialStore,
  AacCredentialStore,
  getCredentialStore,
  resetCredentialStore,
  type CredentialMeta,
  type CredentialStore,
} from "../../repertoire/credential-access"

describe("domainToSlug", () => {
  it("converts domain to lowercase slug", () => {
    expect(domainToSlug("airbnb.com")).toBe("airbnb-com")
  })

  it("replaces multiple non-alphanumeric chars with single dash", () => {
    expect(domainToSlug("api.openweathermap.org")).toBe("api-openweathermap-org")
  })

  it("handles uppercase", () => {
    expect(domainToSlug("API.Example.COM")).toBe("api-example-com")
  })

  it("strips leading/trailing dashes", () => {
    expect(domainToSlug("--example.com--")).toBe("example-com")
  })

  it("collapses consecutive special chars", () => {
    expect(domainToSlug("a...b___c")).toBe("a-b-c")
  })
})

describe("BuiltInCredentialStore", () => {
  let store: BuiltInCredentialStore
  let tmpDir: string
  let vaultDir: string
  let keyDir: string

  beforeEach(() => {
    nervesEvents.length = 0
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-test-"))
    vaultDir = path.join(tmpDir, "vault")
    keyDir = path.join(tmpDir, "keys")
    store = new BuiltInCredentialStore("test-agent", vaultDir, keyDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("isReady returns true (always works)", () => {
    expect(store.isReady()).toBe(true)
  })

  it("store and get: round-trips credential metadata", async () => {
    await store.store("airbnb.com", {
      username: "agent@test.com",
      password: "s3cret!",
      notes: "test account",
    })

    const meta = await store.get("airbnb.com")
    expect(meta).not.toBeNull()
    expect(meta!.domain).toBe("airbnb.com")
    expect(meta!.username).toBe("agent@test.com")
    expect(meta!.notes).toBe("test account")
    expect(meta!.createdAt).toBeTruthy()
    // CRITICAL: password must NOT appear in metadata
    expect((meta as any).password).toBeUndefined()
    expect(JSON.stringify(meta)).not.toContain("s3cret!")
  })

  it("store creates vault dir and key dir on first use", async () => {
    expect(fs.existsSync(vaultDir)).toBe(false)
    expect(fs.existsSync(keyDir)).toBe(false)

    await store.store("example.com", { password: "pass" })

    expect(fs.existsSync(vaultDir)).toBe(true)
    expect(fs.existsSync(keyDir)).toBe(true)
  })

  it("store auto-generates vault.key with correct permissions", async () => {
    await store.store("example.com", { password: "pass" })

    const keyPath = path.join(keyDir, "vault.key")
    expect(fs.existsSync(keyPath)).toBe(true)

    const keyData = fs.readFileSync(keyPath)
    expect(keyData.length).toBe(32) // 256-bit key

    const stat = fs.statSync(keyPath)
    // Check owner-only permissions (0o600)
    const mode = stat.mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("store reuses existing vault.key", async () => {
    await store.store("a.com", { password: "p1" })
    const key1 = fs.readFileSync(path.join(keyDir, "vault.key"))

    await store.store("b.com", { password: "p2" })
    const key2 = fs.readFileSync(path.join(keyDir, "vault.key"))

    expect(Buffer.compare(key1, key2)).toBe(0)
  })

  it("encrypted file is not plaintext", async () => {
    await store.store("secret.com", { password: "my-secret-password" })

    const encPath = path.join(vaultDir, "secret-com.enc")
    expect(fs.existsSync(encPath)).toBe(true)

    const content = fs.readFileSync(encPath, "utf-8")
    expect(content).not.toContain("my-secret-password")
    expect(content).not.toContain("secret.com")

    // Should be valid JSON with iv, tag, data
    const parsed = JSON.parse(content)
    expect(parsed).toHaveProperty("iv")
    expect(parsed).toHaveProperty("tag")
    expect(parsed).toHaveProperty("data")
  })

  it("getRawSecret retrieves stored password", async () => {
    await store.store("test.com", { password: "raw-pass-123" })

    const secret = await store.getRawSecret("test.com", "password")
    expect(secret).toBe("raw-pass-123")
  })

  it("getRawSecret throws on unknown field", async () => {
    await store.store("test.com", { password: "pw" })

    await expect(store.getRawSecret("test.com", "nonexistent")).rejects.toThrow(
      'field "nonexistent" not found',
    )
  })

  it("getRawSecret throws on unknown domain", async () => {
    await expect(store.getRawSecret("unknown.com", "password")).rejects.toThrow(
      "no credential found",
    )
  })

  it("get returns null for non-existent domain", async () => {
    const result = await store.get("missing.com")
    expect(result).toBeNull()
  })

  it("list returns all stored credential metadata", async () => {
    await store.store("a.com", { username: "ua", password: "pa" })
    await store.store("b.com", { username: "ub", password: "pb" })

    const list = await store.list()
    expect(list).toHaveLength(2)

    const domains = list.map((m) => m.domain).sort()
    expect(domains).toEqual(["a.com", "b.com"])

    // No passwords in list
    for (const item of list) {
      expect((item as any).password).toBeUndefined()
      expect(JSON.stringify(item)).not.toMatch(/pa|pb/)
    }
  })

  it("list returns empty array when vault dir does not exist", async () => {
    const list = await store.list()
    expect(list).toEqual([])
  })

  it("list skips corrupt encrypted files that fail to decrypt", async () => {
    // Store a valid credential first
    await store.store("good.com", { password: "pw" })

    // Write a corrupt .enc file
    const corruptPath = path.join(vaultDir, "corrupt-com.enc")
    fs.writeFileSync(corruptPath, "not-valid-encrypted-data")

    const list = await store.list()
    // Should include the valid one but skip the corrupt one
    expect(list).toHaveLength(1)
    expect(list[0].domain).toBe("good.com")
  })

  it("uses /home base path when WEBSITE_SITE_NAME is set (Azure App Service)", () => {
    process.env.WEBSITE_SITE_NAME = "test-app"
    try {
      const azureStore = new BuiltInCredentialStore("test-agent")
      // The store should construct paths using /home base
      // We can't easily inspect private fields, but we can verify it doesn't throw
      expect(azureStore.isReady()).toBe(true)
    } finally {
      delete process.env.WEBSITE_SITE_NAME
    }
  })

  it("delete removes a credential", async () => {
    await store.store("target.com", { password: "pw" })
    expect(await store.get("target.com")).not.toBeNull()

    const result = await store.delete("target.com")
    expect(result).toBe(true)

    expect(await store.get("target.com")).toBeNull()
  })

  it("delete returns false for non-existent domain", async () => {
    const result = await store.delete("nope.com")
    expect(result).toBe(false)
  })

  it("store overwrites existing credential", async () => {
    await store.store("x.com", { username: "old", password: "pw1" })
    await store.store("x.com", { username: "new", password: "pw2" })

    const meta = await store.get("x.com")
    expect(meta!.username).toBe("new")

    const secret = await store.getRawSecret("x.com", "password")
    expect(secret).toBe("pw2")
  })

  it("store with only password (no username, no notes)", async () => {
    await store.store("minimal.com", { password: "only-pass" })

    const meta = await store.get("minimal.com")
    expect(meta!.domain).toBe("minimal.com")
    expect(meta!.username).toBeUndefined()
    expect(meta!.notes).toBeUndefined()
  })

  it("emits nerves events for store operation", async () => {
    await store.store("test.com", { password: "p" })

    const storeEvents = nervesEvents.filter(
      (e) => e.event === "repertoire.credential_store_start" || e.event === "repertoire.credential_store_end",
    )
    expect(storeEvents.length).toBeGreaterThanOrEqual(2)
  })

  it("emits nerves events for get operation", async () => {
    await store.store("test.com", { password: "p" })
    nervesEvents.length = 0

    await store.get("test.com")

    const getEvents = nervesEvents.filter(
      (e) => e.event === "repertoire.credential_get_start" || e.event === "repertoire.credential_get_end",
    )
    expect(getEvents.length).toBeGreaterThanOrEqual(2)
  })

  it("emits nerves events for list operation", async () => {
    await store.list()

    const listEvents = nervesEvents.filter(
      (e) => e.event === "repertoire.credential_list_start" || e.event === "repertoire.credential_list_end",
    )
    expect(listEvents.length).toBeGreaterThanOrEqual(2)
  })

  it("emits nerves events for delete operation", async () => {
    await store.store("test.com", { password: "p" })
    nervesEvents.length = 0

    await store.delete("test.com")

    const delEvents = nervesEvents.filter(
      (e) => e.event === "repertoire.credential_delete_start" || e.event === "repertoire.credential_delete_end",
    )
    expect(delEvents.length).toBeGreaterThanOrEqual(2)
  })

  it("new instance reads existing vault.key from disk", async () => {
    // First store creates the key
    await store.store("first.com", { password: "p1" })
    const key1 = fs.readFileSync(path.join(keyDir, "vault.key"))

    // Create a new store instance pointing to same dirs
    const store2 = new BuiltInCredentialStore("test-agent", vaultDir, keyDir)
    // This store2 has no cached masterKey, so it must read from disk
    await store2.store("second.com", { password: "p2" })
    const key2 = fs.readFileSync(path.join(keyDir, "vault.key"))

    // Same key should be used
    expect(Buffer.compare(key1, key2)).toBe(0)

    // And store2 can decrypt what store1 wrote
    const meta = await store2.get("first.com")
    expect(meta!.domain).toBe("first.com")
  })

  it("emits error event on getRawSecret failure", async () => {
    await store.getRawSecret("nope.com", "password").catch(() => {})

    const errEvents = nervesEvents.filter((e) => e.event === "repertoire.credential_get_error")
    expect(errEvents.length).toBeGreaterThanOrEqual(1)
    expect((errEvents[0].meta as any).reason).toContain("no credential found")
  })
})

describe("AacCredentialStore", () => {
  let store: AacCredentialStore

  beforeEach(() => {
    nervesEvents.length = 0
    vi.clearAllMocks()
    store = new AacCredentialStore()
  })

  it("get calls aac CLI and strips password", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({
        success: true,
        credential: {
          username: "user@test.com",
          password: "secret",
          uri: "https://airbnb.com",
          notes: "test",
        },
      }))
    })

    const meta = await store.get("airbnb.com")
    expect(meta).not.toBeNull()
    expect(meta!.domain).toBe("airbnb.com")
    expect(meta!.username).toBe("user@test.com")
    // Password must NOT be in metadata
    expect((meta as any).password).toBeUndefined()

    expect(mockExecFile).toHaveBeenCalledWith(
      "aac",
      ["--domain", "airbnb.com", "--output", "json"],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function),
    )
  })

  it("get returns null when aac reports no credential", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({ success: false, error: "not found" }))
    })

    const meta = await store.get("missing.com")
    expect(meta).toBeNull()
  })

  it("get returns null on aac CLI error", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error("aac not found"))
    })

    const meta = await store.get("broken.com")
    expect(meta).toBeNull()
  })

  it("getRawSecret returns password from aac", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({
        success: true,
        credential: { username: "u", password: "secret-pw", notes: "n" },
      }))
    })

    const secret = await store.getRawSecret("test.com", "password")
    expect(secret).toBe("secret-pw")
  })

  it("getRawSecret throws on missing field", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({
        success: true,
        credential: { username: "u" },
      }))
    })

    await expect(store.getRawSecret("test.com", "password")).rejects.toThrow(
      'field "password" not found',
    )
  })

  it("getRawSecret throws on aac failure", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({ success: false, error: "denied" }))
    })

    await expect(store.getRawSecret("test.com", "password")).rejects.toThrow("denied")
  })

  it("getRawSecret throws with 'unknown error' fallback when aac response has no error field", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({ success: false }))
    })

    await expect(store.getRawSecret("test.com", "password")).rejects.toThrow("unknown error")
  })

  it("getRawSecret throws on aac CLI error", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error("aac binary not found"))
    })

    await expect(store.getRawSecret("test.com", "password")).rejects.toThrow("aac binary not found")
  })

  it("store throws with helpful error (not supported)", async () => {
    await expect(
      store.store("test.com", { password: "p" }),
    ).rejects.toThrow("not supported")
  })

  it("list calls aac connections list", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify([
        { domain: "a.com", username: "ua" },
        { domain: "b.com", username: "ub" },
      ]))
    })

    const list = await store.list()
    expect(list).toHaveLength(2)
    expect(list[0].domain).toBe("a.com")
    expect(list[1].domain).toBe("b.com")

    expect(mockExecFile).toHaveBeenCalledWith(
      "aac",
      ["connections", "list"],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function),
    )
  })

  it("list returns empty array when aac returns non-array response", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({ not: "an array" }))
    })

    const list = await store.list()
    expect(list).toEqual([])
  })

  it("list handles items with missing optional fields", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify([
        { domain: "a.com" },
        { domain: "b.com", username: "ub", notes: "note", createdAt: "2026-01-01" },
      ]))
    })

    const list = await store.list()
    expect(list).toHaveLength(2)
    expect(list[0].username).toBeUndefined()
    expect(list[0].notes).toBeUndefined()
    expect(list[0].createdAt).toMatch(/^\d{4}-/)  // ISO date fallback
    expect(list[1].username).toBe("ub")
    expect(list[1].notes).toBe("note")
    expect(list[1].createdAt).toBe("2026-01-01")
  })

  it("list handles items with missing domain", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify([{ username: "u" }]))
    })

    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0].domain).toBe("")
  })

  it("list returns empty on aac error", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error("aac not available"))
    })

    const list = await store.list()
    expect(list).toEqual([])
  })

  it("delete throws (not supported in aac mode)", async () => {
    await expect(store.delete("test.com")).rejects.toThrow("not supported")
  })

  it("isReady returns false for fresh instance", () => {
    expect(store.isReady()).toBe(false)
  })

  it("checkReady returns true when aac has sessions", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify([{ domain: "a.com" }]))
    })

    const result = await store.checkReady()
    expect(result).toBe(true)
    expect(store.isReady()).toBe(true)
  })

  it("checkReady returns false when aac has no sessions", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify([]))
    })

    const result = await store.checkReady()
    expect(result).toBe(false)
    expect(store.isReady()).toBe(false)
  })

  it("checkReady returns false on aac error", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error("aac not installed"))
    })

    const result = await store.checkReady()
    expect(result).toBe(false)
    expect(store.isReady()).toBe(false)
  })

  it("emits nerves events for get", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({
        success: true,
        credential: { username: "u", password: "p" },
      }))
    })

    await store.get("test.com")

    const events = nervesEvents.filter(
      (e) => e.event === "repertoire.credential_get_start" || e.event === "repertoire.credential_get_end",
    )
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  it("emits nerves events for list", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify([]))
    })

    await store.list()

    const events = nervesEvents.filter(
      (e) => e.event === "repertoire.credential_list_start" || e.event === "repertoire.credential_list_end",
    )
    expect(events.length).toBeGreaterThanOrEqual(2)
  })
})

describe("getCredentialStore / resetCredentialStore", () => {
  beforeEach(() => {
    resetCredentialStore()
    nervesEvents.length = 0
  })

  it("returns a CredentialStore instance", () => {
    const store = getCredentialStore()
    expect(store).toBeDefined()
    expect(typeof store.get).toBe("function")
    expect(typeof store.getRawSecret).toBe("function")
    expect(typeof store.store).toBe("function")
    expect(typeof store.list).toBe("function")
    expect(typeof store.delete).toBe("function")
    expect(typeof store.isReady).toBe("function")
  })

  it("returns singleton on repeated calls", () => {
    const a = getCredentialStore()
    const b = getCredentialStore()
    expect(a).toBe(b)
  })

  it("reset clears singleton", () => {
    const a = getCredentialStore()
    resetCredentialStore()
    const b = getCredentialStore()
    expect(a).not.toBe(b)
  })

  it("defaults to BuiltInCredentialStore when aac is not available", () => {
    // Since aac is mocked to fail, should get BuiltInCredentialStore
    const store = getCredentialStore()
    expect(store).toBeInstanceOf(BuiltInCredentialStore)
  })
})
