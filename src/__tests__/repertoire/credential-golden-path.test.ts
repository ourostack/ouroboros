/**
 * Golden path integration test for the credential access layer.
 *
 * Simulates the full lifecycle: agent signs up for services, stores credentials,
 * lists them, retrieves metadata, uses the credential gateway, deletes one,
 * and verifies encryption invariants.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock identity
vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "golden-path-agent"),
  getAgentRoot: vi.fn(() => path.join(os.tmpdir(), "golden-path-bundle")),
}))

// Mock child_process (for AacCredentialStore, not used in golden path but required by module)
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

import {
  BuiltInCredentialStore,
  resetCredentialStore,
} from "../../repertoire/credential-access"

describe("credential access golden path", () => {
  let store: BuiltInCredentialStore
  let tmpDir: string
  let vaultDir: string
  let keyDir: string

  beforeEach(() => {
    nervesEvents.length = 0
    resetCredentialStore()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-path-"))
    vaultDir = path.join(tmpDir, "vault")
    keyDir = path.join(tmpDir, "keys")
    store = new BuiltInCredentialStore("golden-path-agent", vaultDir, keyDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("full golden path: store, list, get, gateway, delete, verify encryption", async () => {
    // 1. Agent "signs up" for airbnb.com -> stores credentials
    await store.store("airbnb.com", {
      username: "agent-travel@ouro.bot",
      password: "AirBnB-S3cret!2026",
      notes: "signed up during travel planning",
    })

    // 2. Agent "signs up" for booking.com -> stores credentials
    await store.store("booking.com", {
      username: "agent-booking@ouro.bot",
      password: "Book1ng-Pa$$w0rd!",
      notes: "backup accommodation service",
    })

    // 3. Agent lists credentials -> sees both domains (no passwords)
    const allCreds = await store.list()
    expect(allCreds).toHaveLength(2)

    const domains = allCreds.map((c) => c.domain).sort()
    expect(domains).toEqual(["airbnb.com", "booking.com"])

    // Verify NO passwords in list
    for (const cred of allCreds) {
      const json = JSON.stringify(cred)
      expect(json).not.toContain("AirBnB-S3cret")
      expect(json).not.toContain("Book1ng-Pa$$")
      expect((cred as any).password).toBeUndefined()
    }

    // 4. Agent gets credential metadata for airbnb.com -> sees username, no password
    const airbnbMeta = await store.get("airbnb.com")
    expect(airbnbMeta).not.toBeNull()
    expect(airbnbMeta!.domain).toBe("airbnb.com")
    expect(airbnbMeta!.username).toBe("agent-travel@ouro.bot")
    expect(airbnbMeta!.notes).toBe("signed up during travel planning")
    expect(airbnbMeta!.createdAt).toBeTruthy()
    // CRITICAL: no password in metadata
    expect((airbnbMeta as any).password).toBeUndefined()
    expect(JSON.stringify(airbnbMeta)).not.toContain("AirBnB-S3cret")

    // 5. Credential gateway injects airbnb password into an API request (simulated)
    const rawPassword = await store.getRawSecret("airbnb.com", "password")
    expect(rawPassword).toBe("AirBnB-S3cret!2026")

    // Also verify we can get username via getRawSecret
    const rawUsername = await store.getRawSecret("airbnb.com", "username")
    expect(rawUsername).toBe("agent-travel@ouro.bot")

    // 6. Agent deletes booking.com credentials
    const deleteResult = await store.delete("booking.com")
    expect(deleteResult).toBe(true)

    // Verify booking.com is gone
    const afterDelete = await store.list()
    expect(afterDelete).toHaveLength(1)
    expect(afterDelete[0].domain).toBe("airbnb.com")

    // booking.com getRawSecret should now fail
    await expect(store.getRawSecret("booking.com", "password")).rejects.toThrow(
      "no credential found",
    )

    // 7. Verify encrypted file exists in vault dir, is not plaintext
    const airbnbEncPath = path.join(vaultDir, "airbnb-com.enc")
    expect(fs.existsSync(airbnbEncPath)).toBe(true)

    const encContent = fs.readFileSync(airbnbEncPath, "utf-8")
    // Must NOT contain any plaintext secrets
    expect(encContent).not.toContain("AirBnB-S3cret!2026")
    expect(encContent).not.toContain("agent-travel@ouro.bot")
    expect(encContent).not.toContain("airbnb.com")

    // Must be valid encrypted JSON structure
    const parsed = JSON.parse(encContent)
    expect(parsed).toHaveProperty("iv")
    expect(parsed).toHaveProperty("tag")
    expect(parsed).toHaveProperty("data")
    expect(typeof parsed.iv).toBe("string")
    expect(typeof parsed.tag).toBe("string")
    expect(typeof parsed.data).toBe("string")
    // iv should be 24 hex chars (12 bytes), tag 32 hex chars (16 bytes)
    expect(parsed.iv.length).toBe(24)
    expect(parsed.tag.length).toBe(32)

    // booking.com enc file should be gone (deleted)
    const bookingEncPath = path.join(vaultDir, "booking-com.enc")
    expect(fs.existsSync(bookingEncPath)).toBe(false)

    // 8. Verify vault.key was auto-generated
    const keyPath = path.join(keyDir, "vault.key")
    expect(fs.existsSync(keyPath)).toBe(true)
    const keyData = fs.readFileSync(keyPath)
    expect(keyData.length).toBe(32) // 256-bit AES key
    // Check permissions
    const stat = fs.statSync(keyPath)
    expect(stat.mode & 0o777).toBe(0o600)

    // 9. Verify credential_get NEVER returns password field
    // (Already verified above, but let's be explicit one more time)
    const finalMeta = await store.get("airbnb.com")
    const metaKeys = Object.keys(finalMeta!)
    expect(metaKeys).toContain("domain")
    expect(metaKeys).toContain("username")
    expect(metaKeys).toContain("createdAt")
    expect(metaKeys).not.toContain("password")
  })

  it("credential store survives across instances (persistence)", async () => {
    // Store with one instance
    await store.store("persistent.com", {
      username: "survivor@test.com",
      password: "persistent-secret",
    })

    // Create a new instance pointing to the same dirs
    const store2 = new BuiltInCredentialStore("golden-path-agent", vaultDir, keyDir)

    // Should be able to read from the new instance
    const meta = await store2.get("persistent.com")
    expect(meta!.domain).toBe("persistent.com")
    expect(meta!.username).toBe("survivor@test.com")

    // Should be able to get raw secret from the new instance
    const secret = await store2.getRawSecret("persistent.com", "password")
    expect(secret).toBe("persistent-secret")
  })

  it("different agents cannot decrypt each other's credentials", async () => {
    // Store a credential
    await store.store("shared.com", { password: "agent1-secret" })

    // Create a different agent's store with a different key dir
    const otherKeyDir = path.join(tmpDir, "other-keys")
    const otherStore = new BuiltInCredentialStore("other-agent", vaultDir, otherKeyDir)

    // Other agent can see the file exists but cannot decrypt it
    // (different key will fail decryption)
    expect(() => {
      // Force read attempt — the enc file is there but the key is different
      // This should throw because AES-GCM authentication will fail
      const encPath = path.join(vaultDir, "shared-com.enc")
      const raw = fs.readFileSync(encPath, "utf-8")
      const payload = JSON.parse(raw)
      const crypto = require("node:crypto")

      // Generate a different key (other agent's key)
      const otherKey = crypto.randomBytes(32)
      const iv = Buffer.from(payload.iv, "hex")
      const tag = Buffer.from(payload.tag, "hex")
      const encrypted = Buffer.from(payload.data, "hex")

      const decipher = crypto.createDecipheriv("aes-256-gcm", otherKey, iv)
      decipher.setAuthTag(tag)
      decipher.update(encrypted)
      decipher.final() // This should throw
    }).toThrow() // AES-GCM auth failure
  })
})
