import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock child_process for CLI fallback
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}))

import { execFile } from "child_process"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

import {
  BitwardenClient,
  getBitwardenClient,
  resetBitwardenClient,
} from "../../repertoire/bitwarden-client"
import type { VaultConfig, VaultItem, VaultItemHandle } from "../../repertoire/bitwarden-client"

// Helper to make execFile resolve with stdout
function mockExecFileSuccess(stdout: string): void {
  vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
    // execFile(cmd, args, opts, callback) or execFile(cmd, args, callback)
    const cb = typeof _opts === "function" ? _opts : callback
    cb(null, stdout, "")
    return {} as any
  })
}

function mockExecFileError(errorMessage: string, exitCode = 1): void {
  vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
    const cb = typeof _opts === "function" ? _opts : callback
    const err = Object.assign(new Error(errorMessage), { code: exitCode })
    cb(err, "", errorMessage)
    return {} as any
  })
}

describe("BitwardenClient", () => {
  let client: BitwardenClient

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    client = new BitwardenClient()
  })

  afterEach(() => {
    resetBitwardenClient()
  })

  describe("connect()", () => {
    it("connects via CLI when SDK is not available", async () => {
      // Mock bw status to return unlocked status
      mockExecFileSuccess(JSON.stringify({
        status: { data: { template: { status: "unlocked" } } },
      }))

      const config: VaultConfig = {
        accessToken: "test-session-key",
        mode: "cli",
      }
      await client.connect(config)
      expect(client.isConnected()).toBe(true)
    })

    it("stores session key as private state, not as env var", async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))

      const config: VaultConfig = {
        accessToken: "secret-session-key",
        mode: "cli",
      }
      await client.connect(config)

      // Verify session key is not in process.env
      expect(process.env.BW_SESSION).toBeUndefined()
      expect(client.isConnected()).toBe(true)
    })

    it("throws descriptive error on bad credentials", async () => {
      mockExecFileError("Invalid master password.")

      const config: VaultConfig = {
        accessToken: "bad-key",
        mode: "cli",
      }
      await expect(client.connect(config)).rejects.toThrow(/Invalid master password/)
    })

    it("emits nerves events for connect start and end", async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))

      await client.connect({ accessToken: "key", mode: "cli" })

      const startEvents = nervesEvents.filter((e) => e.event === "client.vault_connect_start")
      const endEvents = nervesEvents.filter((e) => e.event === "client.vault_connect_end")
      expect(startEvents.length).toBeGreaterThanOrEqual(1)
      expect(endEvents.length).toBeGreaterThanOrEqual(1)
    })

    it("emits nerves error event on connect failure", async () => {
      mockExecFileError("CLI not found")

      await expect(client.connect({ accessToken: "key", mode: "cli" })).rejects.toThrow()

      const errorEvents = nervesEvents.filter((e) => e.event === "client.vault_connect_error")
      expect(errorEvents.length).toBeGreaterThanOrEqual(1)
      expect(errorEvents[0].meta).toBeDefined()
    })

    it("falls back to CLI when SDK dynamic import fails", async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))

      // mode: undefined triggers SDK-first attempt
      await client.connect({ accessToken: "key" })
      expect(client.isConnected()).toBe(true)
    })
  })

  describe("getItem()", () => {
    beforeEach(async () => {
      // Connect first
      mockExecFileSuccess(JSON.stringify({ success: true }))
      await client.connect({ accessToken: "session-key", mode: "cli" })
      vi.clearAllMocks()
      nervesEvents.length = 0
    })

    it("returns parsed item without raw password fields", async () => {
      const cliResponse = JSON.stringify({
        success: true,
        data: {
          id: "item-123",
          name: "Test Login",
          type: 1,
          notes: "some notes",
          login: {
            username: "user@test.com",
            password: "secret-password-should-be-stripped",
            uris: [{ uri: "https://example.com" }],
          },
          fields: [{ name: "apiKey", value: "key-123" }],
        },
      })
      mockExecFileSuccess(cliResponse)

      const item = await client.getItem("item-123")

      expect(item.id).toBe("item-123")
      expect(item.name).toBe("Test Login")
      expect(item.type).toBe(1)
      expect(item.login?.username).toBe("user@test.com")
      expect(item.login?.uris).toEqual([{ uri: "https://example.com" }])
      // Password should be stripped
      expect((item.login as any)?.password).toBeUndefined()
    })

    it("throws 'vault not connected' when not connected", async () => {
      const disconnectedClient = new BitwardenClient()
      await expect(disconnectedClient.getItem("id")).rejects.toThrow(/vault not connected/)
    })

    it("emits nerves events for getItem start and end", async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: { id: "x", name: "X", type: 1 },
      }))

      await client.getItem("x")

      const starts = nervesEvents.filter((e) => e.event === "client.request_start")
      const ends = nervesEvents.filter((e) => e.event === "client.request_end")
      expect(starts.length).toBeGreaterThanOrEqual(1)
      expect(ends.length).toBeGreaterThanOrEqual(1)
    })

    it("emits nerves error event when getItem fails", async () => {
      mockExecFileError("Item not found")

      await expect(client.getItem("missing")).rejects.toThrow()

      const errors = nervesEvents.filter((e) => e.event === "client.error")
      expect(errors.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe("createItem()", () => {
    beforeEach(async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))
      await client.connect({ accessToken: "session-key", mode: "cli" })
      vi.clearAllMocks()
      nervesEvents.length = 0
    })

    it("creates item with structured fields and returns handle", async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: { id: "new-item-1", name: "API Key", type: 1 },
      }))

      const handle = await client.createItem("API Key", { apiKey: "secret123", service: "weather" })

      expect(handle.id).toBe("new-item-1")
      expect(handle.name).toBe("API Key")
      expect(handle.type).toBe(1)
    })

    it("emits nerves events for create", async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: { id: "new", name: "Test", type: 1 },
      }))

      await client.createItem("Test", { key: "val" })

      expect(nervesEvents.some((e) => e.event === "client.request_start")).toBe(true)
      expect(nervesEvents.some((e) => e.event === "client.request_end")).toBe(true)
    })
  })

  describe("listItems()", () => {
    beforeEach(async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))
      await client.connect({ accessToken: "session-key", mode: "cli" })
      vi.clearAllMocks()
      nervesEvents.length = 0
    })

    it("returns matching items with search filter", async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: {
          data: [
            { id: "1", name: "Weather API", type: 1 },
            { id: "2", name: "Weather Backup", type: 1 },
          ],
        },
      }))

      const items = await client.listItems("Weather")

      expect(items).toHaveLength(2)
      expect(items[0].id).toBe("1")
      expect(items[0].name).toBe("Weather API")
    })

    it("returns all items with no search filter", async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: {
          data: [
            { id: "1", name: "Item A", type: 1 },
          ],
        },
      }))

      const items = await client.listItems()

      expect(items).toHaveLength(1)
    })

    it("emits nerves events for list", async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: { data: [] },
      }))

      await client.listItems()

      expect(nervesEvents.some((e) => e.event === "client.request_start")).toBe(true)
      expect(nervesEvents.some((e) => e.event === "client.request_end")).toBe(true)
    })
  })

  describe("deleteItem()", () => {
    beforeEach(async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))
      await client.connect({ accessToken: "session-key", mode: "cli" })
      vi.clearAllMocks()
      nervesEvents.length = 0
    })

    it("removes item by ID", async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))

      await client.deleteItem("item-to-delete")

      expect(execFile).toHaveBeenCalled()
      const callArgs = vi.mocked(execFile).mock.calls[0]
      expect(callArgs[1]).toContain("item-to-delete")
    })

    it("emits nerves events for delete", async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))

      await client.deleteItem("id")

      expect(nervesEvents.some((e) => e.event === "client.request_start")).toBe(true)
      expect(nervesEvents.some((e) => e.event === "client.request_end")).toBe(true)
    })

    it("emits error event when delete fails", async () => {
      mockExecFileError("Delete failed")

      await expect(client.deleteItem("id")).rejects.toThrow()

      expect(nervesEvents.some((e) => e.event === "client.error")).toBe(true)
    })
  })

  describe("disconnect()", () => {
    it("sets connected to false and clears session key", async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))
      await client.connect({ accessToken: "key", mode: "cli" })
      expect(client.isConnected()).toBe(true)

      await client.disconnect()
      expect(client.isConnected()).toBe(false)
    })

    it("emits nerves event for disconnect", async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))
      await client.connect({ accessToken: "key", mode: "cli" })
      nervesEvents.length = 0

      await client.disconnect()

      expect(nervesEvents.some((e) => e.event === "client.vault_disconnect")).toBe(true)
    })
  })

  describe("isConnected()", () => {
    it("returns false before connect", () => {
      expect(client.isConnected()).toBe(false)
    })

    it("returns true after connect", async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))
      await client.connect({ accessToken: "key", mode: "cli" })
      expect(client.isConnected()).toBe(true)
    })

    it("returns false after disconnect", async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))
      await client.connect({ accessToken: "key", mode: "cli" })
      await client.disconnect()
      expect(client.isConnected()).toBe(false)
    })
  })

  describe("getRawSecret()", () => {
    beforeEach(async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))
      await client.connect({ accessToken: "session-key", mode: "cli" })
      vi.clearAllMocks()
      nervesEvents.length = 0
    })

    it("returns raw secret value for a specific field", async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: {
          id: "item-123",
          name: "Weather API",
          type: 1,
          fields: [
            { name: "apiKey", value: "raw-secret-value" },
            { name: "other", value: "other-val" },
          ],
          login: { password: "pass123" },
        },
      }))

      const secret = await client.getRawSecret("item-123", "apiKey")
      expect(secret).toBe("raw-secret-value")
    })

    it("returns login password when fieldName is 'password'", async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: {
          id: "item-123",
          name: "Login",
          type: 1,
          login: { password: "my-password" },
          fields: [],
        },
      }))

      const secret = await client.getRawSecret("item-123", "password")
      expect(secret).toBe("my-password")
    })

    it("throws when field not found", async () => {
      mockExecFileSuccess(JSON.stringify({
        success: true,
        data: {
          id: "item-123",
          name: "Test",
          type: 1,
          fields: [{ name: "other", value: "val" }],
          login: {},
        },
      }))

      await expect(client.getRawSecret("item-123", "missing")).rejects.toThrow(/field "missing" not found/)
    })

    it("throws when not connected", async () => {
      const disconnectedClient = new BitwardenClient()
      await expect(disconnectedClient.getRawSecret("id", "field")).rejects.toThrow(/vault not connected/)
    })
  })

  describe("SDK fallback behavior", () => {
    it("falls back to CLI when SDK import fails and logs helpful message", async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))

      // Default mode (undefined) tries SDK first, falls back to CLI
      await client.connect({ accessToken: "key" })

      expect(client.isConnected()).toBe(true)
      // Should have emitted a fallback info event
      const fallbackEvents = nervesEvents.filter(
        (e) => e.event === "client.vault_sdk_fallback",
      )
      expect(fallbackEvents.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe("CLI fallback getItem", () => {
    beforeEach(async () => {
      mockExecFileSuccess(JSON.stringify({ success: true }))
      await client.connect({ accessToken: "test-session", mode: "cli" })
      vi.clearAllMocks()
      nervesEvents.length = 0
    })

    it("calls bw get item with --session flag and parses JSON", async () => {
      const itemData = {
        success: true,
        data: {
          id: "cli-item",
          name: "CLI Test",
          type: 1,
          login: { username: "user" },
        },
      }
      mockExecFileSuccess(JSON.stringify(itemData))

      const item = await client.getItem("cli-item")

      expect(item.id).toBe("cli-item")
      // Verify --session flag is used (not env var)
      const callArgs = vi.mocked(execFile).mock.calls[0]
      expect(callArgs[1]).toContain("--session")
    })
  })
})

describe("getBitwardenClient()", () => {
  beforeEach(() => {
    resetBitwardenClient()
  })

  it("returns a singleton BitwardenClient instance", () => {
    const a = getBitwardenClient()
    const b = getBitwardenClient()
    expect(a).toBe(b)
  })

  it("returns a new instance after reset", () => {
    const a = getBitwardenClient()
    resetBitwardenClient()
    const b = getBitwardenClient()
    expect(a).not.toBe(b)
  })
})
