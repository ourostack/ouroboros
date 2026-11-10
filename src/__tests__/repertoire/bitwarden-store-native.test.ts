import { beforeEach, describe, expect, it, vi } from "vitest"

const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

vi.mock("../../repertoire/bw-installer", () => ({
  bwCommand: (file: string, args: string[]) => ({ file, args }),
  ensureBwCli: vi.fn().mockResolvedValue("/usr/local/bin/bw"),
  isBundledBw: () => false,
  isBwMissingModuleError: () => false,
  markBundledBwBroken: vi.fn(),
}))

const bwCalls: string[][] = []
let bwItems: unknown[] = []
const mockExecFile = vi.fn((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null, stdout: string, stderr: string) => void) => {
  bwCalls.push(args)
  if (args[0] === "status") cb(null, JSON.stringify({ status: "unlocked" }), "")
  else if (args[0] === "unlock") cb(null, "session-token", "")
  else if (args[0] === "list") cb(null, JSON.stringify(bwItems), "")
  else if (args[0] === "get") cb(null, JSON.stringify(bwItems[0]), "")
  else if (args[0] === "delete") cb(null, "", "")
  else if (args[0] === "create" || args[0] === "edit") {
    return { stdin: { end: vi.fn(() => cb(null, JSON.stringify({ id: "bw-1" }), "")) } }
  } else cb(null, "", "")
  return { stdin: { end: vi.fn() } }
})
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => (mockExecFile as (...a: unknown[]) => unknown)(...args) }))

import { BitwardenCredentialStore } from "../../repertoire/bitwarden-store"
import { NativeVaultReader, NativeVaultUnsupportedError, type NativeVaultItem } from "../../repertoire/bitwarden-native"

const ITEMS: NativeVaultItem[] = [
  { id: "1", name: "providers/github-copilot", login: { username: "github-copilot", password: "{\"token\":\"t\"}", uris: [] }, notes: "provider", revisionDate: "2026-11-09T00:00:00Z" },
  { id: "2", name: "runtime/config", login: { password: "{}" }, notes: null },
]

function fakeReader(items: () => Promise<NativeVaultItem[]>) {
  return { items: vi.fn(items), invalidate: vi.fn(), saveLogin: vi.fn(async () => "saved"), deleteItem: vi.fn(async () => undefined) }
}

/** A native client over an in-memory vault, so a write is visible to the read that verifies it. */
function memoryReader(initial: NativeVaultItem[]) {
  const vault = [...initial]
  const reader = fakeReader(async () => vault.map((item) => ({ ...item, login: item.login && { ...item.login } })))
  reader.saveLogin.mockImplementation(async (write: { name: string; username: string; password: string; notes: string | null; uri: string }, id?: string) => {
    const item: NativeVaultItem = { id: id ?? `n${vault.length + 1}`, name: write.name, login: { username: write.username, password: write.password, uris: [{ uri: write.uri }] }, notes: write.notes }
    const index = vault.findIndex((entry) => entry.id === id)
    if (index >= 0) vault[index] = item
    else vault.push(item)
    return item.id
  })
  reader.deleteItem.mockImplementation(async (id: string) => { vault.splice(vault.findIndex((entry) => entry.id === id), 1) })
  return { reader, vault }
}

function store(reader: ReturnType<typeof fakeReader> | null, onInvalidUnlockSecret?: () => void) {
  return new BitwardenCredentialStore("https://vault.ouro.bot", "agent@ouro.bot", "secret", { nativeReader: reader, onInvalidUnlockSecret })
}

describe("BitwardenCredentialStore native reads", () => {
  beforeEach(() => {
    bwCalls.length = 0
    nervesEvents.length = 0
    bwItems = []
    vi.unstubAllEnvs()
  })

  it("answers get, getRawSecret and list from the native reader without running bw", async () => {
    const reader = fakeReader(async () => ITEMS)
    const vault = store(reader)

    await expect(vault.getRawSecret("providers/github-copilot", "password")).resolves.toBe("{\"token\":\"t\"}")
    await expect(vault.get("runtime/config")).resolves.toMatchObject({ domain: "runtime/config", notes: undefined })
    await expect(vault.get("missing")).resolves.toBeNull()
    await expect(vault.getRawSecret("missing", "password")).rejects.toThrow("no credential found")
    await expect(vault.list()).resolves.toEqual([
      { domain: "providers/github-copilot", username: "github-copilot", notes: "provider", createdAt: "2026-11-09T00:00:00Z" },
      expect.objectContaining({ domain: "runtime/config", username: undefined, notes: undefined }),
    ])
    expect(bwCalls).toEqual([])
  })

  it("falls back to bw for good when the reader does not support this vault", async () => {
    const reader = fakeReader(async () => { throw new NativeVaultUnsupportedError("KDF 1 (only PBKDF2-SHA256)") })
    bwItems = [{ id: "b", name: "runtime/config", login: { password: "from-bw" } }]
    const vault = store(reader)

    await expect(vault.getRawSecret("runtime/config", "password")).resolves.toBe("from-bw")
    await expect(vault.list()).resolves.toHaveLength(1)
    expect(reader.items).toHaveBeenCalledTimes(1)
    expect(bwCalls.some((args) => args[0] === "list")).toBe(true)
    expect(nervesEvents).toContainEqual(expect.objectContaining({ event: "repertoire.native_vault_fallback", meta: expect.objectContaining({ reason: "native vault reads do not support KDF 1 (only PBKDF2-SHA256)" }) }))
  })

  it("reports a rejected secret to the unlock-secret owner and does not fall back", async () => {
    const onInvalid = vi.fn()
    const reader = fakeReader(async () => { throw new Error("vault login for agent@ouro.bot failed: username or password is incorrect (the saved vault unlock secret was rejected)") })
    await expect(store(reader, onInvalid).getRawSecret("runtime/config", "password")).rejects.toThrow("username or password is incorrect")
    expect(onInvalid).toHaveBeenCalledTimes(1)
    expect(bwCalls).toEqual([])
  })

  it("retries a transient reader failure", async () => {
    let calls = 0
    const reader = fakeReader(async () => {
      calls += 1
      if (calls === 1) throw new Error("vault request to /api/sync failed: fetch failed: ECONNRESET")
      return ITEMS
    })
    await expect(store(reader).getRawSecret("runtime/config", "password")).resolves.toBe("{}")
    expect(calls).toBe(2)
  })

  it("passes on a non-transient reader failure", async () => {
    const reader = fakeReader(async () => { throw new Error("vault sync returned no item list") })
    await expect(store(reader).get("runtime/config")).rejects.toThrow("vault sync returned no item list")
    expect(reader.items).toHaveBeenCalledTimes(1)
  })

  it("writes, updates and trashes natively, verifying each write by reading it back, without running bw", async () => {
    const { reader, vault } = memoryReader(ITEMS)
    const credentials = store(reader)

    await credentials.store("providers/github-copilot", { username: "github-copilot", password: "{\"pool\":2}", notes: "pool" })
    expect(reader.saveLogin).toHaveBeenLastCalledWith(
      { name: "providers/github-copilot", username: "github-copilot", password: "{\"pool\":2}", notes: "pool", uri: "https://providers/github-copilot" },
      "1",
    )
    await credentials.store("new/item", { password: "p" })
    expect(reader.saveLogin).toHaveBeenLastCalledWith({ name: "new/item", username: "", password: "p", notes: null, uri: "https://new/item" }, undefined)
    await expect(credentials.getRawSecret("new/item", "password")).resolves.toBe("p")

    await expect(credentials.delete("new/item")).resolves.toBe(true)
    expect(reader.deleteItem).toHaveBeenCalledWith("n3")
    await expect(credentials.delete("new/item")).resolves.toBe(false)
    expect(vault.map((item) => item.name)).toEqual(["providers/github-copilot", "runtime/config"])
    expect(bwCalls).toEqual([])
  })

  it("refuses a native write that did not read back as written", async () => {
    const reader = fakeReader(async () => ITEMS)
    await expect(store(reader).store("runtime/config", { password: "different" })).rejects.toThrow("credential save verification failed for runtime/config")
    await expect(store(reader).store("brand/new", { password: "p" })).rejects.toThrow("saved item could not be read back after write")
  })

  it("writes and deletes through bw when the native client does not support this vault", async () => {
    const reader = fakeReader(async () => { throw new NativeVaultUnsupportedError("two-step login") })
    const vault = store(reader)
    bwItems = [{ id: "bw-1", name: "runtime/config", login: { username: "", password: "new" }, notes: null }]

    await vault.store("runtime/config", { password: "new" })
    expect(bwCalls.some((args) => args[0] === "edit")).toBe(true)
    await expect(vault.delete("runtime/config")).resolves.toBe(true)
    expect(bwCalls.some((args) => args[0] === "delete")).toBe(true)
    expect(reader.saveLogin).not.toHaveBeenCalled()
    expect(reader.items).toHaveBeenCalledTimes(1)
  })

  it("passes on a failed native write without falling back to bw", async () => {
    const { reader } = memoryReader(ITEMS)
    reader.saveLogin.mockRejectedValueOnce(new Error("vault update for agent@ouro.bot failed: HTTP 400 The client copy of this cipher is out of date."))
    await expect(store(reader).store("runtime/config", { password: "x" })).rejects.toThrow("out of date")
    expect(bwCalls).toEqual([])
  })

  it("reads natively by default outside tests, and through bw when OURO_VAULT_NATIVE_READS=0", () => {
    const nativeReaderOf = (vault: BitwardenCredentialStore) => (vault as unknown as { nativeReader: unknown }).nativeReader
    expect(nativeReaderOf(new BitwardenCredentialStore("https://vault.ouro.bot", "agent@ouro.bot", "secret"))).toBeNull()

    vi.stubEnv("VITEST", undefined)
    expect(nativeReaderOf(new BitwardenCredentialStore("https://vault.ouro.bot", "agent@ouro.bot", "secret"))).toBeInstanceOf(NativeVaultReader)
    vi.stubEnv("OURO_VAULT_NATIVE_READS", "0")
    expect(nativeReaderOf(new BitwardenCredentialStore("https://vault.ouro.bot", "agent@ouro.bot", "secret"))).toBeNull()
  })
})
