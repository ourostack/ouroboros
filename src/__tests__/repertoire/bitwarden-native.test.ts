import * as crypto from "node:crypto"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import {
  NATIVE_VAULT_ITEMS_FRESH_MS,
  NATIVE_VAULT_LOGIN_FAILURE_RETRY_MS,
  NativeVaultReader,
  NativeVaultUnsupportedError,
  decryptCipherString,
  decryptSyncItems,
  nodeVaultRequest,
  sharedNativeVaultReader,
} from "../../repertoire/bitwarden-native"
import { deriveMasterKey, deriveMasterPasswordHash, deriveStretchedMasterKey } from "../../repertoire/vault-setup"

const SERVER = "https://vault.example.test"
const EMAIL = "Agent@Example.test"
const PASSWORD = "correct horse battery staple"
const ITERATIONS = 1000

function encrypt(data: Buffer | string, key: Buffer): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv("aes-256-cbc", key.subarray(0, 32), iv)
  const ct = Buffer.concat([cipher.update(typeof data === "string" ? Buffer.from(data, "utf8") : data), cipher.final()])
  const mac = crypto.createHmac("sha256", key.subarray(32, 64)).update(iv).update(ct).digest()
  return `2.${iv.toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`
}

async function vaultKeys() {
  const masterKey = await deriveMasterKey(PASSWORD, EMAIL, ITERATIONS)
  return {
    hash: await deriveMasterPasswordHash(masterKey, PASSWORD),
    stretched: deriveStretchedMasterKey(masterKey),
    userKey: crypto.randomBytes(64),
  }
}

type Keys = Awaited<ReturnType<typeof vaultKeys>>

function personalCiphers(userKey: Buffer) {
  const itemKey = crypto.randomBytes(64)
  return [
    {
      id: "a",
      type: 1,
      name: encrypt("providers/github-copilot", userKey),
      notes: encrypt("provider credential", userKey),
      revisionDate: "2026-11-09T00:00:00Z",
      login: { username: encrypt("github-copilot", userKey), password: encrypt("{\"token\":\"t\"}", userKey), uris: [{ uri: encrypt("https://providers/github-copilot", userKey) }, { uri: null }] },
    },
    { id: "b", type: 1, key: encrypt(itemKey, userKey), name: encrypt("runtime/config", itemKey), login: { password: encrypt("{}", itemKey) } },
    { id: "c", type: 2, name: encrypt("a note", userKey), notes: encrypt("ünïcödé", userKey) },
    { id: "d", type: 1, organizationId: "org", name: encrypt("org item", userKey) },
    { id: "e", type: 1, deletedDate: "2026-11-01T00:00:00Z", name: encrypt("trashed", userKey) },
    { id: "f", type: 1, name: encrypt("tampered", userKey).replace(/\|[^|]+$/, `|${Buffer.alloc(32).toString("base64")}`) },
  ]
}

interface FakeServer {
  fetch: ReturnType<typeof vi.fn>
  calls: string[]
  bodies: string[]
}

function fakeServer(keys: Keys, options: {
  prelogin?: () => Response
  token?: (call: number) => Response
  sync?: (call: number) => Response
  pascalCase?: boolean
} = {}): FakeServer {
  const calls: string[] = []
  const bodies: string[] = []
  let tokenCalls = 0
  let syncCalls = 0
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const fetchImpl = vi.fn(async (url: string, init: { body?: string }) => {
    const pathname = url.slice(SERVER.length)
    calls.push(pathname)
    bodies.push(String(init.body ?? ""))
    if (pathname === "/identity/accounts/prelogin") {
      return options.prelogin?.() ?? json(200, options.pascalCase ? { Kdf: 0, KdfIterations: ITERATIONS } : { kdf: 0, kdfIterations: ITERATIONS })
    }
    if (pathname === "/identity/connect/token") {
      tokenCalls += 1
      if (options.token) return options.token(tokenCalls)
      const form = new URLSearchParams(String(init.body))
      if (form.get("password") !== keys.hash) return json(400, { error: "invalid_grant", error_description: "invalid_username_or_password", ErrorModel: { Message: "Username or password is incorrect. Try again" } })
      return json(200, { access_token: `token-${tokenCalls}`, expires_in: 3600, Key: encrypt(keys.userKey, keys.stretched) })
    }
    if (pathname === "/api/sync?excludeDomains=true") {
      syncCalls += 1
      if (options.sync) return options.sync(syncCalls)
      const ciphers = personalCiphers(keys.userKey)
      return json(200, options.pascalCase ? { Ciphers: ciphers.map((c) => ({ Id: c.id, Type: c.type, Name: c.name, Notes: (c as { notes?: string }).notes, Key: (c as { key?: string }).key, Login: (c as { login?: unknown }).login, OrganizationId: (c as { organizationId?: string }).organizationId ?? null, DeletedDate: (c as { deletedDate?: string }).deletedDate ?? null })) } : { ciphers })
    }
    return json(404, {})
  })
  return { fetch: fetchImpl, calls, bodies }
}

function reader(server: FakeServer, overrides: { now?: () => number; platform?: NodeJS.Platform; password?: string } = {}) {
  return new NativeVaultReader(`${SERVER}/`, EMAIL, overrides.password ?? PASSWORD, {
    request: async (url, init) => {
      const response = (await server.fetch(url, init)) as Response
      return { status: response.status, body: await response.text() }
    },
    now: overrides.now ?? (() => 1_000_000),
    hostname: () => "host-a",
    platform: overrides.platform ?? "linux",
  })
}

describe("NativeVaultReader", () => {
  it("logs in, syncs and decrypts the personal items, leaving out organization, trashed and unreadable ones", async () => {
    const keys = await vaultKeys()
    const server = fakeServer(keys)
    const items = await reader(server).items()

    expect(items).toEqual([
      {
        id: "a",
        name: "providers/github-copilot",
        login: { username: "github-copilot", password: "{\"token\":\"t\"}", uris: [{ uri: "https://providers/github-copilot" }] },
        notes: "provider credential",
        revisionDate: "2026-11-09T00:00:00Z",
      },
      { id: "b", name: "runtime/config", login: { username: undefined, password: "{}", uris: [] }, notes: null, revisionDate: undefined },
      { id: "c", name: "a note", notes: "ünïcödé", revisionDate: undefined },
    ])
    expect(server.calls).toEqual(["/identity/accounts/prelogin", "/identity/connect/token", "/api/sync?excludeDomains=true"])
    const form = new URLSearchParams(server.bodies[1])
    expect(form.get("username")).toBe(EMAIL)
    expect(form.get("password")).toBe(keys.hash)
    expect(form.get("deviceType")).toBe("25")
    expect(form.get("deviceIdentifier")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it("reads Bitwarden's PascalCase responses too", async () => {
    const keys = await vaultKeys()
    const items = await reader(fakeServer(keys, { pascalCase: true })).items()
    expect(items.map((item) => item.name)).toEqual(["providers/github-copilot", "runtime/config", "a note"])
  })

  it("serves reads from one sync until it goes stale or is invalidated, reusing the access token", async () => {
    const keys = await vaultKeys()
    const server = fakeServer(keys)
    let now = 1_000_000
    const vault = reader(server, { now: () => now })

    await vault.items()
    await vault.items()
    expect(server.calls.filter((call) => call.startsWith("/api/sync"))).toHaveLength(1)

    now += NATIVE_VAULT_ITEMS_FRESH_MS
    await vault.items()
    vault.invalidate()
    await vault.items()
    expect(server.calls.filter((call) => call.startsWith("/api/sync"))).toHaveLength(3)
    expect(server.calls.filter((call) => call === "/identity/connect/token")).toHaveLength(1)
    expect(server.calls.filter((call) => call === "/identity/accounts/prelogin")).toHaveLength(1)
  })

  it("logs in again when the access token nears expiry, without deriving the keys again", async () => {
    const keys = await vaultKeys()
    const server = fakeServer(keys)
    let now = 1_000_000
    const vault = reader(server, { now: () => now })
    await vault.items()
    now += 3600 * 1000
    vault.invalidate()
    await vault.items()
    expect(server.calls.filter((call) => call === "/identity/connect/token")).toHaveLength(2)
    expect(server.calls.filter((call) => call === "/identity/accounts/prelogin")).toHaveLength(1)
  })

  it("defaults the token lifetime to an hour when the server gives none", async () => {
    const keys = await vaultKeys()
    const server = fakeServer(keys, { token: () => new Response(JSON.stringify({ access_token: "t", key: encrypt(keys.userKey, keys.stretched) }), { status: 200 }) })
    let now = 1_000_000
    const vault = reader(server, { now: () => now })
    await vault.items()
    now += 3000 * 1000
    vault.invalidate()
    await vault.items()
    expect(server.calls.filter((call) => call === "/identity/connect/token")).toHaveLength(1)
  })

  it("logs in once more when sync rejects the token, and gives up when a fresh token is rejected too", async () => {
    const keys = await vaultKeys()
    const recovered = fakeServer(keys, { sync: (call) => call === 1 ? new Response("", { status: 401 }) : new Response(JSON.stringify({ ciphers: [] }), { status: 200 }) })
    await expect(reader(recovered).items()).resolves.toEqual([])
    expect(recovered.calls.filter((call) => call === "/identity/connect/token")).toHaveLength(2)

    const rejected = fakeServer(keys, { sync: () => new Response("", { status: 401 }) })
    await expect(reader(rejected).items()).rejects.toThrow("vault sync rejected a fresh access token (HTTP 401)")
  })

  it("reports a rejected secret in the words the store recognises, and does not retry it for a while", async () => {
    const keys = await vaultKeys()
    const server = fakeServer(keys)
    let now = 1_000_000
    const vault = reader(server, { now: () => now, password: "wrong" })

    await expect(vault.items()).rejects.toThrow(/username or password is incorrect/)
    await expect(vault.items()).rejects.toThrow(/username or password is incorrect/)
    expect(server.calls.filter((call) => call === "/identity/connect/token")).toHaveLength(1)

    now += NATIVE_VAULT_LOGIN_FAILURE_RETRY_MS
    await expect(vault.items()).rejects.toThrow(/username or password is incorrect/)
    expect(server.calls.filter((call) => call === "/identity/connect/token")).toHaveLength(2)
  })

  it("recognises Vaultwarden's rejected-password message without invalid_grant", async () => {
    const keys = await vaultKeys()
    const server = fakeServer(keys, { token: () => new Response(JSON.stringify({ error: "", ErrorModel: { Message: "Username or password is incorrect. Try again" } }), { status: 400 }) })
    await expect(reader(server).items()).rejects.toThrow("failed: username or password is incorrect")
  })

  it("refuses what it does not implement, so the store can fall back to bw", async () => {
    const keys = await vaultKeys()
    const argon = fakeServer(keys, { prelogin: () => new Response(JSON.stringify({ kdf: 1, kdfIterations: 3 }), { status: 200 }) })
    await expect(reader(argon).items()).rejects.toThrow(new NativeVaultUnsupportedError("KDF 1 (only PBKDF2-SHA256)"))
    const unknownKdf = fakeServer(keys, { prelogin: () => new Response("{}", { status: 200 }) })
    await expect(reader(unknownKdf).items()).rejects.toThrow("KDF unknown")

    const twoStep = fakeServer(keys, { token: () => new Response(JSON.stringify({ error: "invalid_grant", TwoFactorProviders: [0] }), { status: 400 }) })
    await expect(reader(twoStep).items()).rejects.toBeInstanceOf(NativeVaultUnsupportedError)
    const twoStep2 = fakeServer(keys, { token: () => new Response(JSON.stringify({ twoFactorProviders2: { 0: null } }), { status: 400 }) })
    await expect(reader(twoStep2).items()).rejects.toThrow("two-step login")

    const newDevice = fakeServer(keys, { token: () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "new device verification required" }), { status: 400 }) })
    await expect(reader(newDevice).items()).rejects.toThrow("new-device verification")

    const shortKey = fakeServer(keys, { token: () => new Response(JSON.stringify({ access_token: "t", Key: encrypt(crypto.randomBytes(32), keys.stretched) }), { status: 200 }) })
    await expect(reader(shortKey).items()).rejects.toThrow("a 32-byte user key")
  })

  it("names server and network failures, worded so transient ones are retried", async () => {
    const keys = await vaultKeys()
    await expect(reader(fakeServer(keys, { prelogin: () => new Response("", { status: 503 }) })).items()).rejects.toThrow("vault prelogin for Agent@Example.test failed: HTTP 503")
    await expect(reader(fakeServer(keys, { prelogin: () => new Response(JSON.stringify({ kdf: 0 }), { status: 200 }) })).items()).rejects.toThrow("no KDF iteration count")

    const busy = fakeServer(keys, { token: () => new Response("<html>busy</html>", { status: 502 }) })
    const busyVault = reader(busy)
    await expect(busyVault.items()).rejects.toThrow("vault login for Agent@Example.test failed: HTTP 502")
    await expect(busyVault.items()).rejects.toThrow("HTTP 502")
    expect(busy.calls.filter((call) => call === "/identity/connect/token")).toHaveLength(2)

    await expect(reader(fakeServer(keys, { token: () => new Response(JSON.stringify({ access_token: "t" }), { status: 200 }) })).items()).rejects.toThrow("no access token or user key")
    await expect(reader(fakeServer(keys, { token: () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 }) })).items()).rejects.toThrow("failed: HTTP 500 server_error")
    await expect(reader(fakeServer(keys, { sync: () => new Response("", { status: 502 }) })).items()).rejects.toThrow("vault sync for Agent@Example.test failed: HTTP 502")
    await expect(reader(fakeServer(keys, { sync: () => new Response("null", { status: 200 }) })).items()).rejects.toThrow("vault sync returned no item list")

    const timeout = { fetch: vi.fn(async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) }), calls: [], bodies: [] }
    await expect(reader(timeout).items()).rejects.toThrow("vault request to /identity/accounts/prelogin timed out")
    const offline = { fetch: vi.fn(async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND vault.example.test") }) }), calls: [], bodies: [] }
    await expect(reader(offline).items()).rejects.toThrow("vault request to /identity/accounts/prelogin failed: fetch failed: getaddrinfo ENOTFOUND vault.example.test")
    const odd = { fetch: vi.fn(async () => { throw "boom" }), calls: [], bodies: [] }
    await expect(reader(odd).items()).rejects.toThrow("vault request to /identity/accounts/prelogin failed: boom")
  })

  it("talks to a real server over node:http with the clock and this host by default", async () => {
    const keys = await vaultKeys()
    const fake = fakeServer(keys)
    const server = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => { body += chunk })
      req.on("end", async () => {
        const answer = (await fake.fetch(`${SERVER}${req.url}`, { body })) as Response
        res.writeHead(answer.status, { "content-type": "application/json" })
        res.end(await answer.text())
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      await expect(new NativeVaultReader(url, EMAIL, PASSWORD).items()).resolves.toHaveLength(3)
      expect(fake.calls).toEqual(["/identity/accounts/prelogin", "/identity/connect/token", "/api/sync?excludeDomains=true"])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("times out a request that never answers, and reports https connection failures", async () => {
    const server = http.createServer(() => undefined)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as AddressInfo).port
      await expect(nodeVaultRequest(`http://127.0.0.1:${port}/alive`, { method: "GET", headers: {} }, 50)).rejects.toMatchObject({ name: "TimeoutError" })
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    await expect(nodeVaultRequest("https://127.0.0.1:1/alive", { method: "GET", headers: {} })).rejects.toThrow(/ECONNREFUSED/)
  })

  it("shares one reader per vault account and secret", () => {
    const first = sharedNativeVaultReader(`${SERVER}/`, EMAIL, PASSWORD)
    expect(sharedNativeVaultReader(SERVER, EMAIL.toLowerCase(), PASSWORD)).toBe(first)
    expect(sharedNativeVaultReader(SERVER, EMAIL, "another secret")).not.toBe(first)
  })

  it("names the CLI device type for each platform", async () => {
    const keys = await vaultKeys()
    for (const [platform, type] of [["win32", "23"], ["darwin", "24"], ["linux", "25"]] as const) {
      const server = fakeServer(keys)
      await reader(server, { platform }).items()
      expect(new URLSearchParams(server.bodies[1]).get("deviceType")).toBe(type)
    }
  })
})

describe("vault cipher strings", () => {
  const key = crypto.randomBytes(64)

  it("decrypts a type-2 string and refuses anything else", () => {
    expect(decryptCipherString(encrypt("hello", key), key).toString()).toBe("hello")
    expect(() => decryptCipherString("0.abc|def", key)).toThrow(new NativeVaultUnsupportedError("cipher strings of type 0"))
    expect(() => decryptCipherString("plain", key)).toThrow("type unknown")
    expect(() => decryptCipherString("2.a|b", key)).toThrow("malformed cipher string")
    expect(() => decryptCipherString(`2.${Buffer.alloc(8).toString("base64")}|AA==|${Buffer.alloc(32).toString("base64")}`, key)).toThrow("malformed cipher string")
    expect(() => decryptCipherString(encrypt("hello", crypto.randomBytes(64)), key)).toThrow("failed its integrity check")
  })

  it("propagates an unsupported item key instead of skipping the item", () => {
    const sync = { ciphers: [{ id: "x", type: 1, key: encrypt(crypto.randomBytes(32), key), name: encrypt("n", key) }] }
    expect(() => decryptSyncItems(sync, key)).toThrow("a 32-byte item key")
  })

  it("keeps an item with no name, and a login with no uri list", () => {
    const sync = { ciphers: [{ id: "x", type: 1, login: { username: encrypt("u", key), uris: null } }] }
    expect(decryptSyncItems(sync, key)).toEqual({
      items: [{ id: "x", name: "", login: { username: "u", password: undefined, uris: [] }, notes: null, revisionDate: undefined }],
      skipped: 0,
      unreadable: 0,
    })
  })
})
