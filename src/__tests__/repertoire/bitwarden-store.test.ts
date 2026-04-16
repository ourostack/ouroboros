import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock bw-installer — ensureBwCli resolves immediately (bw assumed present)
vi.mock("../../repertoire/bw-installer", () => ({
  ensureBwCli: vi.fn().mockResolvedValue("/usr/local/bin/bw"),
}))

// Mock child_process
const mockExecFile = vi.fn()

vi.mock("node:child_process", () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))

import { BitwardenCredentialStore } from "../../repertoire/bitwarden-store"

function setupExecMock(result: { stdout: string; stderr?: string; error?: Error }) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    // bw status always succeeds with "unlocked" so ensureSession skips login
    if (args[0] === "status") {
      cb(null, JSON.stringify({ status: "unlocked" }), "")
      return
    }
    // bw unlock (from ensureSession when status is "unlocked") returns a session token
    if (args[0] === "unlock") {
      cb(null, "mock-session-token", "")
      return
    }
    if (result.error) {
      cb(result.error, "", result.stderr ?? "")
    } else {
      cb(null, result.stdout, result.stderr ?? "")
    }
  })
}

describe("BitwardenCredentialStore", () => {
  let store: BitwardenCredentialStore

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    store = new BitwardenCredentialStore("https://vault.ouroboros.bot", "ouroboros@ouro.bot", "masterpass123")
  })

  describe("isReady", () => {
    it("returns true (always ready — auth is lazy)", () => {
      expect(store.isReady()).toBe(true)
    })
  })

  describe("login", () => {
    it("calls bw status, then config server, then bw login", async () => {
      const calls: string[][] = []
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        calls.push(args)
        // First call is status — return unauthenticated so login proceeds to config + login
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unauthenticated" }), "")
        } else {
          cb(null, '{"access_token":"session-token"}', "")
        }
      })

      await store.login()

      // First call: bw status
      expect(calls[0]).toEqual(["status"])
      // Second call: bw config server <url>
      expect(calls[1]).toEqual(["config", "server", "https://vault.ouroboros.bot"])
      // Third call: bw login
      expect(calls[2][0]).toBe("login")
      expect(calls[2][1]).toBe("ouroboros@ouro.bot")
    })

    it("caches the session token", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '{"access_token":"my-session-token"}', "")
      })

      await store.login()

      // Subsequent bw calls should include the session token
      // This is checked by the get/store/list/delete methods
      expect(store.isReady()).toBe(true)
    })

    it("handles JSON login output without access_token field", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '{"some_other_field":"value"}', "")
      })

      await store.login()

      // Should not throw — falls back to raw loginOutput.trim() via ??
      expect(store.isReady()).toBe(true)
    })

    it("handles raw string session token (non-JSON output)", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "raw-session-token-string", "")
      })

      await store.login()

      // Should not throw — falls back to raw string
      expect(store.isReady()).toBe(true)
    })

    it("unlocks when status is locked (skips login, runs unlock)", async () => {
      const calls: string[][] = []
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        calls.push(args)
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "locked", serverUrl: "https://vault.ouroboros.bot" }), "")
        } else if (args[0] === "unlock") {
          cb(null, "unlocked-session-token", "")
        } else {
          cb(null, "", "")
        }
      })

      await store.login()

      // Should call status, then unlock (no config server, no login)
      expect(calls[0]).toEqual(["status"])
      expect(calls[1][0]).toBe("unlock")
      expect(calls[1]).toContain("--raw")
      // Should NOT have called login
      expect(calls.find((c) => c[0] === "login")).toBeUndefined()
    })

    it("handles login failure", async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "login") {
          cb(new Error("invalid credentials"), "", "Username or password is incorrect")
        } else {
          cb(null, "", "")
        }
      })

      await expect(store.login()).rejects.toThrow(/bw CLI error/)
    })

    it("surfaces a wrong saved vault unlock secret clearly", async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "locked", serverUrl: "https://vault.ouroboros.bot" }), "")
          return
        }
        if (args[0] === "unlock") {
          cb(new Error("invalid master password"), "", "invalid master password")
          return
        }
        cb(null, "", "")
      })

      await expect(store.login()).rejects.toThrow(
        "bw CLI error: bw CLI rejected the saved vault unlock secret for this machine",
      )
    })

    it("does not swallow config-server failures that are not logout-required", async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unauthenticated" }), "")
          return
        }
        if (args[0] === "config") {
          cb(new Error("server unavailable"), "", "server unavailable")
          return
        }
        cb(null, "", "")
      })

      await expect(store.login()).rejects.toThrow("bw CLI error: server unavailable")
    })

    it("ignores the logout-required config-server failure and continues login", async () => {
      const calls: string[][] = []
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        calls.push(args)
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unauthenticated" }), "")
          return
        }
        if (args[0] === "config") {
          cb(new Error("logout required before server config can change"), "", "logout required before server config can change")
          return
        }
        if (args[0] === "login") {
          cb(null, "session-token", "")
          return
        }
        cb(null, "", "")
      })

      await store.login()

      expect(calls[0]).toEqual(["status"])
      expect(calls[1]).toEqual(["config", "server", "https://vault.ouroboros.bot"])
      expect(calls[2]).toEqual(["login", "ouroboros@ouro.bot", "masterpass123", "--raw"])
    })

    it("uses an isolated Bitwarden app data directory when configured", async () => {
      const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-appdata-"))
      const envCaptures: Array<Record<string, string | undefined>> = []
      const isolatedStore = new BitwardenCredentialStore("https://vault.ouroboros.bot", "ouroboros@ouro.bot", "masterpass123", { appDataDir })
      mockExecFile.mockImplementation((_cmd: string, args: string[], opts: any, cb: Function) => {
        envCaptures.push(opts?.env ?? {})
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unauthenticated" }), "")
        } else {
          cb(null, '{"access_token":"session-token"}', "")
        }
      })

      try {
        await isolatedStore.login()

        expect(fs.statSync(appDataDir).mode & 0o777).toBe(0o700)
        expect(envCaptures.length).toBeGreaterThan(0)
        expect(envCaptures.every((env) => env.BITWARDENCLI_APPDATA_DIR === appDataDir)).toBe(true)
      } finally {
        fs.rmSync(appDataDir, { recursive: true, force: true })
      }
    })
  })

  describe("get", () => {
    it("returns credential metadata for a domain", async () => {
      setupExecMock({
        stdout: JSON.stringify([{
          id: "item-1",
          name: "test.com",
          login: {
            username: "testuser",
            password: "secret123",
          },
          notes: "test note",
          revisionDate: "2026-01-15T00:00:00.000Z",
        }]),
      })

      const result = await store.get("test.com")

      expect(result).not.toBeNull()
      expect(result!.domain).toBe("test.com")
      expect(result!.username).toBe("testuser")
      expect(result!.notes).toBe("test note")
      // Password should NOT be in the result
      expect((result as any).password).toBeUndefined()
    })

    it("returns null when no item found", async () => {
      setupExecMock({ stdout: "[]" })

      const result = await store.get("nonexistent.com")
      expect(result).toBeNull()
    })

    it("throws when bw CLI fails during search", async () => {
      setupExecMock({ stdout: "", error: new Error("vault is locked") })

      await expect(store.get("test.com")).rejects.toThrow("bw CLI error:")
    })

    it("emits nerves events", async () => {
      setupExecMock({ stdout: "[]" })

      await store.get("test.com")

      expect(nervesEvents.some((e) => e.event === "repertoire.bw_credential_get_start")).toBe(true)
      expect(nervesEvents.some((e) => e.event === "repertoire.bw_credential_get_end")).toBe(true)
    })

    it("uses session token in bw env after login", async () => {
      const envCaptures: Array<Record<string, string | undefined>> = []
      mockExecFile.mockImplementation((_cmd: string, _args: string[], opts: any, cb: Function) => {
        envCaptures.push(opts?.env ?? {})
        // Return matching item for search calls
        cb(null, JSON.stringify([{
          id: "item-1",
          name: "test.com",
          login: { username: "u", password: "p" },
          revisionDate: "2026-01-01T00:00:00.000Z",
        }]), "")
      })

      // Login first to set session token
      await store.login()
      envCaptures.length = 0

      await store.get("test.com")

      // After login, BW_SESSION should be set in env
      expect(envCaptures.some((e) => e.BW_SESSION !== undefined)).toBe(true)
    })

    it("falls back for null notes and missing revisionDate", async () => {
      setupExecMock({
        stdout: JSON.stringify([{
          id: "item-1",
          name: "test.com",
          login: { username: "testuser" },
          notes: null,
          // no revisionDate
        }]),
      })

      const result = await store.get("test.com")

      expect(result).not.toBeNull()
      expect(result!.notes).toBeUndefined()
      // revisionDate falls back to current ISO string
      expect(result!.createdAt).toBeDefined()
      expect(result!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
    })
  })

  describe("getRawSecret", () => {
    it("returns the requested field from the vault item", async () => {
      setupExecMock({
        stdout: JSON.stringify([{
          id: "item-1",
          name: "api.example.com",
          login: {
            username: "apiuser",
            password: "api-secret-key",
          },
        }]),
      })

      const result = await store.getRawSecret("api.example.com", "password")
      expect(result).toBe("api-secret-key")
    })

    it("throws when item not found", async () => {
      setupExecMock({ stdout: "[]" })

      await expect(store.getRawSecret("missing.com", "password")).rejects.toThrow(/no credential found/)
    })

    it("throws when field not found", async () => {
      setupExecMock({
        stdout: JSON.stringify([{
          id: "item-1",
          name: "test.com",
          login: { username: "user" },
        }]),
      })

      await expect(store.getRawSecret("test.com", "password")).rejects.toThrow(/field "password" not found/)
    })

    it("reads arbitrary field from item when field is not password or username", async () => {
      setupExecMock({
        stdout: JSON.stringify([{
          id: "item-1",
          name: "test.com",
          login: { username: "user", password: "pass" },
          notes: "my-secret-note",
        }]),
      })

      const result = await store.getRawSecret("test.com", "notes")
      expect(result).toBe("my-secret-note")
    })

    it("returns username field when requested", async () => {
      setupExecMock({
        stdout: JSON.stringify([{
          id: "item-1",
          name: "test.com",
          login: { username: "testuser", password: "pass" },
        }]),
      })

      const result = await store.getRawSecret("test.com", "username")
      expect(result).toBe("testuser")
    })
  })

  describe("store", () => {
    it("creates a new vault item via bw create", async () => {
      const createCalls: string[][] = []
      const stdinWrites: string[] = []
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        createCalls.push(args)
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
        } else if (args[0] === "unlock") {
          cb(null, "session-token", "")
        } else if (args[0] === "list") {
          cb(null, "[]", "")
        } else {
          cb(null, '{"id":"new-item-1"}', "")
        }
        return { stdin: { end: vi.fn((value: string) => stdinWrites.push(value)) } }
      })

      await store.store("newsite.com", {
        username: "newuser",
        password: "newpass",
        notes: "a note",
      })

      expect(createCalls.length).toBeGreaterThanOrEqual(1)
      const createCall = createCalls.find((c) => c[0] === "create")
      expect(createCall).toEqual(["create", "item"])
      expect(createCall?.join(" ")).not.toContain("newpass")
      expect(stdinWrites).toHaveLength(1)
      const decoded = JSON.parse(Buffer.from(stdinWrites[0]!, "base64").toString("utf8")) as { login: { password: string } }
      expect(decoded.login.password).toBe("newpass")
    })

    it("edits an existing vault item instead of creating a duplicate", async () => {
      const calls: string[][] = []
      const stdinWrites: string[] = []
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        calls.push(args)
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
        } else if (args[0] === "unlock") {
          cb(null, "session-token", "")
        } else if (args[0] === "list") {
          cb(null, JSON.stringify([{ id: "existing-id", name: "existing.com", login: { username: "old", password: "old" } }]), "")
        } else {
          cb(null, '{"id":"existing-id"}', "")
        }
        return { stdin: { end: vi.fn((value: string) => stdinWrites.push(value)) } }
      })

      await store.store("existing.com", {
        username: "newuser",
        password: "newpass",
        notes: "new note",
      })

      expect(calls.find((call) => call[0] === "edit")).toEqual(["edit", "item", "existing-id"])
      expect(calls.find((call) => call[0] === "edit")?.join(" ")).not.toContain("newpass")
      expect(stdinWrites).toHaveLength(1)
      expect(calls.find((call) => call[0] === "create")).toBeUndefined()
    })

    it("redacts command argv and encoded payloads from bw CLI failures", async () => {
      const rawSecret = "provider-token-should-not-leak"
      const leakedEncodedPayload = Buffer
        .from(JSON.stringify({ login: { password: rawSecret } }))
        .toString("base64")

      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
        } else if (args[0] === "unlock") {
          cb(null, "session-token", "")
        } else if (args[0] === "list") {
          cb(null, "[]", "")
        } else if (args[0] === "create") {
          cb(new Error(`Command failed: bw create item ${leakedEncodedPayload}\n? Master password: [input is hidden]`), "", "")
        } else {
          cb(null, "", "")
        }
        return { stdin: { end: vi.fn() } }
      })

      let thrown: Error | null = null
      try {
        await store.store("providers/openai-codex", {
          username: "openai-codex",
          password: rawSecret,
        })
      } catch (error) {
        thrown = error as Error
      }

      expect(thrown).not.toBeNull()
      expect(thrown!.message).toContain("local Bitwarden session")
      expect(thrown!.message).not.toContain(leakedEncodedPayload)
      expect(thrown!.message).not.toContain(rawSecret)
      expect(thrown!.message).not.toContain("bw create item")
    })

    it("redacts command-only bw CLI failures even without stderr", async () => {
      const leakedEncodedPayload = Buffer
        .from(JSON.stringify({ login: { password: "another-secret" } }))
        .toString("base64")

      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
        } else if (args[0] === "unlock") {
          cb(null, "session-token", "")
        } else if (args[0] === "list") {
          cb(null, "[]", "")
        } else if (args[0] === "create") {
          cb(new Error(`Command failed: bw create item ${leakedEncodedPayload}`), "", "")
        } else {
          cb(null, "", "")
        }
        return { stdin: { end: vi.fn() } }
      })

      let thrown: Error | null = null
      try {
        await store.store("providers/minimax", {
          username: "minimax",
          password: "another-secret",
        })
      } catch (error) {
        thrown = error as Error
      }

      expect(thrown).not.toBeNull()
      expect(thrown!.message).toBe("bw CLI error: command failed")
      expect(thrown!.message).not.toContain(leakedEncodedPayload)
      expect(thrown!.message).not.toContain("another-secret")
      expect(thrown!.message).not.toContain("bw create item")
    })

    it("retries with a fresh session when search fails with an expired session", async () => {
      const stdinWrites: string[] = []
      const createCalls: string[][] = []
      let unlockCount = 0
      let searchCount = 0

      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
          return
        }
        if (args[0] === "unlock") {
          unlockCount += 1
          cb(null, `session-${unlockCount}`, "")
          return
        }
        if (args[0] === "list") {
          searchCount += 1
          if (searchCount === 1) {
            cb(new Error("Command failed: bw list items --search providers/openai-codex"), "", "Not logged in")
            return
          }
          cb(null, "[]", "")
          return
        }
        if (args[0] === "create") {
          createCalls.push(args)
          cb(null, '{"id":"created-after-retry"}', "")
          return { stdin: { end: vi.fn((value: string) => stdinWrites.push(value)) } }
        }
        cb(null, "", "")
      })

      await store.store("providers/openai-codex", {
        username: "openai-codex",
        password: "oauth-token",
      })

      expect(unlockCount).toBe(2)
      expect(searchCount).toBe(2)
      expect(createCalls).toEqual([["create", "item"]])
      expect(stdinWrites).toHaveLength(1)
    })

    it("retries once when create fails because the local session expired", async () => {
      const stdinWrites: string[] = []
      let unlockCount = 0
      let searchCount = 0
      let createCount = 0

      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
          return
        }
        if (args[0] === "unlock") {
          unlockCount += 1
          cb(null, `session-${unlockCount}`, "")
          return
        }
        if (args[0] === "list") {
          searchCount += 1
          cb(null, "[]", "")
          return
        }
        if (args[0] === "create") {
          createCount += 1
          if (createCount === 1) {
            cb(new Error("Command failed: bw create item"), "", "Session key is invalid or expired")
          } else {
            cb(null, '{"id":"created-after-create-retry"}', "")
          }
          return { stdin: { end: vi.fn((value: string) => stdinWrites.push(value)) } }
        }
        cb(null, "", "")
      })

      await store.store("providers/minimax", {
        username: "minimax",
        password: "minimax-token",
      })

      expect(unlockCount).toBe(2)
      expect(searchCount).toBe(2)
      expect(createCount).toBe(2)
      expect(stdinWrites).toHaveLength(2)
    })

    it("retries once when edit fails because the local session expired", async () => {
      const stdinWrites: string[] = []
      let unlockCount = 0
      let searchCount = 0
      let editCount = 0

      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
          return
        }
        if (args[0] === "unlock") {
          unlockCount += 1
          cb(null, `session-${unlockCount}`, "")
          return
        }
        if (args[0] === "list") {
          searchCount += 1
          cb(null, JSON.stringify([{ id: "existing-id", name: "providers/minimax" }]), "")
          return
        }
        if (args[0] === "edit") {
          editCount += 1
          if (editCount === 1) {
            cb(new Error("Command failed: bw edit item existing-id"), "", "Session key is invalid or expired")
          } else {
            cb(null, '{"id":"existing-id"}', "")
          }
          return { stdin: { end: vi.fn((value: string) => stdinWrites.push(value)) } }
        }
        cb(null, "", "")
      })

      await store.store("providers/minimax", {
        username: "minimax",
        password: "minimax-token",
      })

      expect(unlockCount).toBe(2)
      expect(searchCount).toBe(2)
      expect(editCount).toBe(2)
      expect(stdinWrites).toHaveLength(2)
    })

    it("stops before create when the pre-create lookup fails for a non-session reason", async () => {
      let createAttempted = false

      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
          return
        }
        if (args[0] === "unlock") {
          cb(null, "session-token", "")
          return
        }
        if (args[0] === "list") {
          cb(new Error("Command failed: bw list items --search providers/anthropic"), "", "server unavailable")
          return
        }
        if (args[0] === "create") {
          createAttempted = true
        }
        cb(null, "", "")
      })

      await expect(store.store("providers/anthropic", {
        username: "anthropic",
        password: "anthropic-token",
      })).rejects.toThrow("bw CLI error: server unavailable")
      expect(createAttempted).toBe(false)
    })

    it("creates a new item when search returns only fuzzy matches", async () => {
      const calls: string[][] = []

      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        calls.push(args)
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
          return
        }
        if (args[0] === "unlock") {
          cb(null, "session-token", "")
          return
        }
        if (args[0] === "list") {
          cb(null, JSON.stringify([{ id: "wrong-item", name: "providers/openai-codex-old" }]), "")
          return
        }
        if (args[0] === "create") {
          cb(null, '{"id":"created-exact"}', "")
          return { stdin: { end: vi.fn() } }
        }
        cb(null, "", "")
      })

      await store.store("providers/openai-codex", {
        username: "openai-codex",
        password: "oauth-token",
      })

      expect(calls.find((call) => call[0] === "edit")).toBeUndefined()
      expect(calls.find((call) => call[0] === "create")).toEqual(["create", "item"])
    })

    it("throws a sanitized error when search returns malformed items", async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
          return
        }
        if (args[0] === "unlock") {
          cb(null, "session-token", "")
          return
        }
        if (args[0] === "list") {
          cb(null, JSON.stringify([{ name: "providers/anthropic" }]), "")
          return
        }
        cb(null, "", "")
      })

      await expect(store.store("providers/anthropic", {
        username: "anthropic",
        password: "anthropic-token",
      })).rejects.toThrow("bw CLI error: invalid item from bw list items --search")
    })

    it("gives up after one fresh-session retry when create still needs re-auth", async () => {
      let unlockCount = 0
      let createCount = 0

      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
          return
        }
        if (args[0] === "unlock") {
          unlockCount += 1
          cb(null, `session-${unlockCount}`, "")
          return
        }
        if (args[0] === "list") {
          cb(null, "[]", "")
          return
        }
        if (args[0] === "create") {
          createCount += 1
          cb(new Error("Command failed: bw create item"), "", "? Master password: [input is hidden]")
          return { stdin: { end: vi.fn() } }
        }
        cb(null, "", "")
      })

      await expect(store.store("providers/github-copilot", {
        username: "github-copilot",
        password: "gh-token",
      })).rejects.toThrow("bw CLI error: bw CLI could not use the local Bitwarden session because it is locked, missing, or expired")

      expect(unlockCount).toBe(2)
      expect(createCount).toBe(2)
    })

    it("emits nerves events", async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unlocked" }), "")
        } else if (args[0] === "unlock") {
          cb(null, "session-token", "")
        } else if (args[0] === "list") {
          cb(null, "[]", "")
        } else {
          cb(null, '{"id":"new-item"}', "")
        }
        return { stdin: { end: vi.fn() } }
      })

      await store.store("test.com", { password: "pass" })

      expect(nervesEvents.some((e) => e.event === "repertoire.bw_credential_store_start")).toBe(true)
      expect(nervesEvents.some((e) => e.event === "repertoire.bw_credential_store_end")).toBe(true)
    })
  })

  describe("list", () => {
    it("returns all vault items as CredentialMeta", async () => {
      setupExecMock({
        stdout: JSON.stringify([
          {
            id: "1",
            name: "site-a.com",
            login: { username: "user-a" },
            notes: "note a",
            revisionDate: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "2",
            name: "site-b.com",
            login: { username: "user-b" },
            notes: null,
            revisionDate: "2026-02-01T00:00:00.000Z",
          },
        ]),
      })

      const results = await store.list()

      expect(results).toHaveLength(2)
      expect(results[0].domain).toBe("site-a.com")
      expect(results[0].username).toBe("user-a")
      expect(results[1].domain).toBe("site-b.com")
    })

    it("handles items with null notes and missing revisionDate in list", async () => {
      setupExecMock({
        stdout: JSON.stringify([
          {
            id: "1",
            name: "site.com",
            login: { username: "user" },
            notes: null,
            // no revisionDate
          },
        ]),
      })

      const results = await store.list()

      expect(results).toHaveLength(1)
      expect(results[0].notes).toBeUndefined()
      expect(results[0].createdAt).toBeDefined()
      expect(results[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
    })

    it("returns empty array when vault is empty", async () => {
      setupExecMock({ stdout: "[]" })

      const results = await store.list()
      expect(results).toEqual([])
    })

    it("throws when bw CLI fails", async () => {
      setupExecMock({ stdout: "", error: new Error("vault is locked") })

      await expect(store.list()).rejects.toThrow("bw CLI error:")
    })

    it("throws a sanitized error when bw returns invalid JSON", async () => {
      setupExecMock({ stdout: "{not-json" })

      await expect(store.list()).rejects.toThrow("bw CLI error: invalid JSON from bw list items")
    })

    it("throws a sanitized error when bw returns a non-array JSON payload", async () => {
      setupExecMock({ stdout: "{}" })

      await expect(store.list()).rejects.toThrow("bw CLI error: invalid JSON from bw list items")
    })

    it("throws a sanitized error when bw returns malformed items", async () => {
      setupExecMock({
        stdout: JSON.stringify([{ name: "site-a.com" }]),
      })

      await expect(store.list()).rejects.toThrow("bw CLI error: invalid item from bw list items")
    })

    it.each([
      ["entry is not an object", [123]],
      ["entry is missing a name", [{ id: "1" }]],
    ])("rejects malformed items when %s", async (_label, entries) => {
      setupExecMock({
        stdout: JSON.stringify(entries),
      })

      await expect(store.list()).rejects.toThrow("bw CLI error: invalid item from bw list items")
    })

    it.each([
      ["login is not an object", { id: "1", name: "site-a.com", login: "bad-login" }],
      ["login.username is not a string", { id: "1", name: "site-a.com", login: { username: 123 } }],
      ["login.password is not a string", { id: "1", name: "site-a.com", login: { password: 123 } }],
      ["login.uris is not an array", { id: "1", name: "site-a.com", login: { uris: "bad" } }],
      ["login uri entry is not an object", { id: "1", name: "site-a.com", login: { uris: ["bad"] } }],
      ["login uri string is not a string", { id: "1", name: "site-a.com", login: { uris: [{ uri: 123 }] } }],
      ["notes is not a string", { id: "1", name: "site-a.com", notes: 123 }],
      ["revisionDate is not a string", { id: "1", name: "site-a.com", revisionDate: 123 }],
    ])("rejects malformed items when %s", async (_label, item) => {
      setupExecMock({
        stdout: JSON.stringify([item]),
      })

      await expect(store.list()).rejects.toThrow("bw CLI error: invalid item from bw list items")
    })
  })

  describe("delete", () => {
    it("finds and deletes a vault item by domain", async () => {
      const deleteCalls: string[][] = []
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        deleteCalls.push(args)
        if (args[0] === "list" && args[1] === "items") {
          cb(null, JSON.stringify([{ id: "item-to-delete", name: "old.com" }]), "")
        } else {
          cb(null, "", "")
        }
      })

      const result = await store.delete("old.com")

      expect(result).toBe(true)
      const deleteCall = deleteCalls.find((c) => c[0] === "delete")
      expect(deleteCall).toBeDefined()
      expect(deleteCall![2]).toBe("item-to-delete")
    })

    it("returns false when item not found", async () => {
      setupExecMock({ stdout: "[]" })

      const result = await store.delete("nonexistent.com")
      expect(result).toBe(false)
    })
  })

  describe("retry logic", () => {
    it("retries on transient failure and succeeds on third attempt", async () => {
      let callCount = 0
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          callCount++
          if (callCount <= 2) {
            // First two status calls fail with transient error
            cb(new Error("ECONNREFUSED"), "", "")
          } else {
            cb(null, JSON.stringify({ status: "unauthenticated" }), "")
          }
          return
        }
        if (args[0] === "config") {
          cb(null, "", "")
          return
        }
        if (args[0] === "login") {
          cb(null, "session-token", "")
          return
        }
        cb(null, "", "")
      })

      await store.login()

      // Should have called status 3 times (2 failures + 1 success)
      expect(callCount).toBe(3)
    })

    it("gives up after max retries with clear error", async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(new Error("ECONNREFUSED"), "", "")
          return
        }
        cb(null, "", "")
      })

      await expect(store.login()).rejects.toThrow(/ECONNREFUSED/)
    })

    it("does NOT retry on auth failures (wrong password)", async () => {
      let statusCalls = 0
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          cb(null, JSON.stringify({ status: "unauthenticated" }), "")
          return
        }
        if (args[0] === "config") {
          cb(null, "", "")
          return
        }
        if (args[0] === "login") {
          statusCalls++
          cb(new Error("Username or password is incorrect"), "", "")
          return
        }
        cb(null, "", "")
      })

      await expect(store.login()).rejects.toThrow(/incorrect/)
      // Should only try login once — no retry on auth errors
      expect(statusCalls).toBe(1)
    })

    it("gives descriptive error when bw CLI is not installed (ENOENT)", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const err = new Error("spawn bw ENOENT") as NodeJS.ErrnoException
        err.code = "ENOENT"
        cb(err, "", "")
      })

      await expect(store.login()).rejects.toThrow(/bw CLI not found/)
      await expect(store.login()).rejects.toThrow(/https:\/\/bitwarden\.com\/help\/cli/)
    })

    it("uses exponential backoff timing (1s, 2s, 4s)", async () => {
      vi.useFakeTimers()

      let callCount = 0
      const callTimes: number[] = []

      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          callCount++
          callTimes.push(Date.now())
          if (callCount <= 2) {
            cb(new Error("ECONNREFUSED"), "", "")
          } else {
            cb(null, JSON.stringify({ status: "unauthenticated" }), "")
          }
          return
        }
        if (args[0] === "config") {
          cb(null, "", "")
          return
        }
        if (args[0] === "login") {
          cb(null, "session-token", "")
          return
        }
        cb(null, "", "")
      })

      const loginPromise = store.login()

      // Advance through backoff timers
      await vi.advanceTimersByTimeAsync(1000) // first retry after 1s
      await vi.advanceTimersByTimeAsync(2000) // second retry after 2s

      await loginPromise

      // Verify backoff intervals
      expect(callTimes).toHaveLength(3)
      const gap1 = callTimes[1] - callTimes[0]
      const gap2 = callTimes[2] - callTimes[1]
      expect(gap1).toBeGreaterThanOrEqual(1000)
      expect(gap2).toBeGreaterThanOrEqual(2000)

      vi.useRealTimers()
    })

    it("emits nerves events for retry attempts", async () => {
      let callCount = 0
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === "status") {
          callCount++
          if (callCount <= 1) {
            cb(new Error("ECONNREFUSED"), "", "")
          } else {
            cb(null, JSON.stringify({ status: "unauthenticated" }), "")
          }
          return
        }
        if (args[0] === "config") {
          cb(null, "", "")
          return
        }
        if (args[0] === "login") {
          cb(null, "session-token", "")
          return
        }
        cb(null, "", "")
      })

      await store.login()

      // Should have emitted a retry nerves event
      expect(nervesEvents.some((e) =>
        e.event === "repertoire.bw_login_retry",
      )).toBe(true)
    })
  })
})
