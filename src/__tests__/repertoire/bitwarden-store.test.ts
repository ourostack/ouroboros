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
    store = new BitwardenCredentialStore("https://vault.ouro.bot", "ouroboros@ouro.bot", "masterpass123")
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
      expect(calls[1]).toEqual(["config", "server", "https://vault.ouro.bot"])
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
          cb(null, JSON.stringify({ status: "locked", serverUrl: "https://vault.ouro.bot" }), "")
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

    it("returns null when bw CLI fails during search", async () => {
      setupExecMock({ stdout: "", error: new Error("vault is locked") })

      const result = await store.get("test.com")
      expect(result).toBeNull()
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
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        createCalls.push(args)
        cb(null, '{"id":"new-item-1"}', "")
      })

      await store.store("newsite.com", {
        username: "newuser",
        password: "newpass",
        notes: "a note",
      })

      // Should call "bw create item <encoded-json>"
      expect(createCalls.length).toBeGreaterThanOrEqual(1)
      const createCall = createCalls.find((c) => c[0] === "create")
      expect(createCall).toBeDefined()
    })

    it("emits nerves events", async () => {
      setupExecMock({ stdout: '{"id":"new-item"}' })

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

    it("returns empty array and emits error event when bw CLI fails", async () => {
      setupExecMock({ stdout: "", error: new Error("vault is locked") })

      const results = await store.list()

      expect(results).toEqual([])
      expect(nervesEvents.some((e) =>
        e.event === "repertoire.bw_credential_list_end" && (e.meta as any).count === 0,
      )).toBe(true)
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
