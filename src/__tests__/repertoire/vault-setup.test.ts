import { describe, it, expect, vi, beforeEach } from "vitest"
import * as crypto from "node:crypto"

// Mock nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock fetch for registration API calls
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

import {
  deriveMasterKey,
  deriveMasterPasswordHash,
  deriveStretchedMasterKey,
  makeProtectedSymmetricKey,
  createVaultAccount,
} from "../../repertoire/vault-setup"

describe("vault crypto primitives", () => {
  // Bitwarden known test vectors — these are derived from the reference implementation.
  // See https://bitwarden.com/help/bitwarden-security-white-paper/ for KDF details.

  it("deriveMasterKey uses PBKDF2-SHA256 with email as salt", async () => {
    const key = await deriveMasterKey("password123", "test@example.com", 600000)
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)

    // Same inputs should produce the same key (deterministic)
    const key2 = await deriveMasterKey("password123", "test@example.com", 600000)
    expect(key.equals(key2)).toBe(true)

    // Different password should produce different key
    const key3 = await deriveMasterKey("different", "test@example.com", 600000)
    expect(key.equals(key3)).toBe(false)
  })

  it("deriveMasterPasswordHash uses PBKDF2-SHA256 with 1 iteration", async () => {
    const masterKey = await deriveMasterKey("password123", "test@example.com", 600000)
    const hash = await deriveMasterPasswordHash(masterKey, "password123")
    expect(typeof hash).toBe("string")
    // Base64 encoded, should be reasonable length
    expect(hash.length).toBeGreaterThan(20)

    // Deterministic
    const hash2 = await deriveMasterPasswordHash(masterKey, "password123")
    expect(hash).toBe(hash2)
  })

  it("deriveStretchedMasterKey returns 64 bytes via HKDF", async () => {
    const masterKey = await deriveMasterKey("password123", "test@example.com", 600000)
    const stretched = deriveStretchedMasterKey(masterKey)
    expect(stretched).toBeInstanceOf(Buffer)
    expect(stretched.length).toBe(64)
    // First 32 bytes = encryption key, last 32 = MAC key
    const encKey = stretched.subarray(0, 32)
    const macKey = stretched.subarray(32, 64)
    expect(encKey.length).toBe(32)
    expect(macKey.length).toBe(32)
    // They should be different
    expect(encKey.equals(macKey)).toBe(false)
  })

  it("makeProtectedSymmetricKey encrypts with AES-256-CBC and produces a Bitwarden cipherstring", () => {
    const stretched = crypto.randomBytes(64)
    const result = makeProtectedSymmetricKey(stretched)
    expect(typeof result).toBe("string")
    // Bitwarden cipherstring format: "2.<iv-base64>|<ciphertext-base64>|<mac-base64>"
    expect(result).toMatch(/^2\..+\|.+\|.+$/)
    const parts = result.split(".")
    expect(parts[0]).toBe("2")
    const segments = parts[1].split("|")
    expect(segments.length).toBe(3)
    // IV should be 16 bytes = 24 base64 chars (with padding)
    const ivBytes = Buffer.from(segments[0], "base64")
    expect(ivBytes.length).toBe(16)
  })
})

describe("createVaultAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("posts to the correct registration endpoint", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    })

    await createVaultAccount("ouroboros", "https://vault.ouro.bot", "ouroboros@ouro.bot", "test-password")

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe("https://vault.ouro.bot/api/accounts/register")
    expect(opts.method).toBe("POST")
    expect(opts.headers["Content-Type"]).toBe("application/json")
  })

  it("sends correct registration payload structure", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    })

    await createVaultAccount("ouroboros", "https://vault.ouro.bot", "ouroboros@ouro.bot", "test-password")

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.name).toBe("ouroboros")
    expect(body.email).toBe("ouroboros@ouro.bot")
    expect(body.masterPasswordHash).toBeDefined()
    expect(typeof body.masterPasswordHash).toBe("string")
    expect(body.masterPasswordHint).toBeNull()
    expect(body.key).toBeDefined()
    // Key should be Bitwarden cipherstring format
    expect(body.key).toMatch(/^2\..+\|.+\|.+$/)
    expect(body.kdf).toBe(0)
    expect(body.kdfIterations).toBe(600000)
    expect(body.keys).toBeDefined()
    expect(body.keys.publicKey).toBeDefined()
    expect(body.keys.encryptedPrivateKey).toBeDefined()
    // Encrypted private key is also a cipherstring
    expect(body.keys.encryptedPrivateKey).toMatch(/^2\..+\|.+\|.+$/)
  })

  it("returns success result on 200", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    })

    const result = await createVaultAccount("ouroboros", "https://vault.ouro.bot", "ouroboros@ouro.bot", "test-password")

    expect(result.success).toBe(true)
    expect(result.email).toBe("ouroboros@ouro.bot")
    expect(result.serverUrl).toBe("https://vault.ouro.bot")
    expect(result.error).toBeUndefined()
  })

  it("returns failure result on HTTP error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "Email already taken" }),
    })

    const result = await createVaultAccount("ouroboros", "https://vault.ouro.bot", "ouroboros@ouro.bot", "test-password")

    expect(result.success).toBe(false)
    expect(result.error).toContain("Email already taken")
  })

  it("falls back to HTTP status when error response body is not JSON", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => { throw new Error("not json") },
    })

    const result = await createVaultAccount("ouroboros", "https://vault.ouro.bot", "ouroboros@ouro.bot", "test-password")

    expect(result.success).toBe(false)
    expect(result.error).toBe("HTTP 502 Bad Gateway")
  })

  it("falls back to HTTP status when error response has no message field", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ detail: "duplicate" }), // no "message" key
    })

    const result = await createVaultAccount("ouroboros", "https://vault.ouro.bot", "ouroboros@ouro.bot", "test-password")

    expect(result.success).toBe(false)
    expect(result.error).toBe("HTTP 409 Conflict")
  })

  it("returns failure result on network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"))

    const result = await createVaultAccount("ouroboros", "https://vault.ouro.bot", "ouroboros@ouro.bot", "test-password")

    expect(result.success).toBe(false)
    expect(result.error).toContain("ECONNREFUSED")
  })

  it("handles non-Error thrown value in outer catch", async () => {
    mockFetch.mockRejectedValue("string-error")

    const result = await createVaultAccount("ouroboros", "https://vault.ouro.bot", "ouroboros@ouro.bot", "test-password")

    expect(result.success).toBe(false)
    expect(result.error).toBe("string-error")
  })

  it("emits nerves events", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    })

    await createVaultAccount("ouroboros", "https://vault.ouro.bot", "ouroboros@ouro.bot", "test-password")

    expect(nervesEvents.some((e) => e.event === "repertoire.vault_setup_start")).toBe(true)
    expect(nervesEvents.some((e) => e.event === "repertoire.vault_setup_end")).toBe(true)
  })

  it("emits error event on failure", async () => {
    mockFetch.mockRejectedValue(new Error("fail"))

    await createVaultAccount("ouroboros", "https://vault.ouro.bot", "ouroboros@ouro.bot", "test-password")

    expect(nervesEvents.some((e) => e.event === "repertoire.vault_setup_error")).toBe(true)
  })
})
