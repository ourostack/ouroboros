import { EventEmitter, PassThrough } from "node:stream"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { FileFriendStore, type FriendRecord, type FriendStore } from "@ouro.bot/friends"

import type { OuroCliDeps } from "../../../heart/daemon/cli-types"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"
import { resolveFrontendFriendId, runOuroCli } from "../../../heart/daemon/cli-exec"
import { buildDefaultAgentTemplate } from "../../../heart/identity"

function friend(id: string): FriendRecord {
  return {
    id,
    name: "Ari",
    role: "family",
    trustLevel: "family",
    connections: [],
    externalIds: [{ provider: "local", externalId: "ari", linkedAt: "2026-09-04T00:00:00.000Z" }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    schemaVersion: 1,
  }
}

function store(records: FriendRecord[]): FriendStore {
  const values = new Map(records.map((record) => [record.id, record]))
  return {
    get: async (id) => values.get(id) ?? null,
    put: async (id, record) => { values.set(id, record) },
    delete: async (id) => { values.delete(id) },
    findByExternalId: async (provider, externalId) =>
      [...values.values()].find((record) =>
        record.externalIds.some((candidate) =>
          candidate.provider === provider && candidate.externalId === externalId)) ?? null,
    hasAnyFriends: async () => values.size > 0,
    listAll: async () => [...values.values()],
  }
}

describe("ouro acp-serve CLI", () => {
  it("parses the exact Boss frontend launch contract", () => {
    expect(parseOuroCommand([
      "acp-serve",
      "--agent",
      "Boss",
      "--friend-id",
      "friend-1",
      "--socket",
      "/tmp/ouro.sock",
      "--workbench-mcp",
      "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP",
    ])).toEqual({
      kind: "acp-serve",
      agent: "Boss",
      friendId: "friend-1",
      socketOverride: "/tmp/ouro.sock",
      workbenchMcp: "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP",
    })
    expect(parseOuroCommand(["acp-serve", "--agent", "Boss", "--workbench-mcp"])).toEqual({
      kind: "acp-serve",
      agent: "Boss",
      workbenchMcp: true,
    })
    expect(parseOuroCommand(["acp-serve", "--agent", "Boss"])).toEqual({
      kind: "acp-serve",
      agent: "Boss",
    })
    expect(parseOuroCommand([
      "acp-serve",
      "--agent",
      "Boss",
      "--workbench-mcp",
      "/Applications/OuroWorkbenchMCP",
      "--observe-only",
    ])).toEqual({
      kind: "acp-serve",
      agent: "Boss",
      workbenchMcp: "/Applications/OuroWorkbenchMCP",
      observeOnly: true,
    })
  })

  it.each([
    [[], "--agent"],
    [["--agent", "../Boss"], "safe agent"],
    [["--agent", "Boss", "--friend-id"], "--friend-id"],
    [["--agent", "Boss", "--socket"], "--socket"],
    [["--agent", "Boss", "--unknown"], "Usage"],
  ])("rejects invalid acp-serve arguments %#", (args, message) => {
    expect(() => parseOuroCommand(["acp-serve", ...args])).toThrow(message)
  })

  it("returns an existing explicit friend and rejects an unknown one", async () => {
    const existing = friend("11111111-1111-4111-8111-111111111111")
    const friendStore = store([existing])

    await expect(resolveFrontendFriendId({
      agent: "Boss",
      store: friendStore,
      explicitFriendId: existing.id,
      ownerUsername: "ari",
    })).resolves.toBe(existing.id)
    await expect(resolveFrontendFriendId({
      agent: "Boss",
      store: friendStore,
      explicitFriendId: "missing",
      ownerUsername: "ari",
    })).rejects.toThrow("friend not found")
  })

  it("resolves or creates the canonical local machine owner identity", async () => {
    const existing = friend("11111111-1111-4111-8111-111111111111")
    await expect(resolveFrontendFriendId({
      agent: "Boss",
      store: store([existing]),
      ownerUsername: "ari",
    })).resolves.toBe(existing.id)

    const empty = store([])
    const createdId = await resolveFrontendFriendId({ agent: "Boss", store: empty, ownerUsername: "ari" })
    expect(createdId).toMatch(/^[0-9a-f-]{36}$/)
    expect((await empty.get(createdId))?.externalIds).toEqual([
      expect.objectContaining({ provider: "local", externalId: "ari" }),
    ])
    await expect(resolveFrontendFriendId({ agent: "Boss", store: empty, ownerUsername: null }))
      .rejects.toThrow("machine owner")
    await expect(resolveFrontendFriendId({ agent: "../Boss", store: empty }))
      .rejects.toThrow("safe agent")

    const machineOwnerStore = store([])
    await expect(resolveFrontendFriendId({ agent: "Boss", store: machineOwnerStore }))
      .resolves.toMatch(/^[0-9a-f-]{36}$/)
  })

  it("validates the selected bundle before resolving its on-disk friend", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-friend-"))
    try {
      await expect(resolveFrontendFriendId({
        agent: "Missing",
        bundlesRoot,
        ownerUsername: "ari",
      })).rejects.toThrow("agent config")

      const agentRoot = path.join(bundlesRoot, "Boss.ouro")
      fs.mkdirSync(agentRoot, { recursive: true })
      fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify(buildDefaultAgentTemplate("Boss")))
      const friendId = await resolveFrontendFriendId({
        agent: "Boss",
        bundlesRoot,
        ownerUsername: "ari",
      })

      expect(await new FileFriendStore(path.join(agentRoot, "friends")).get(friendId)).toMatchObject({
        id: friendId,
        trustLevel: "family",
        externalIds: [expect.objectContaining({ provider: "local", externalId: "ari" })],
      })
    } finally {
      fs.rmSync(bundlesRoot, { recursive: true, force: true })
    }
  })

  it.each(["end", "close"] as const)("owns the ACP server until stdin %s", async (event) => {
    const input = new EventEmitter()
    const output = new PassThrough()
    const server = { start: vi.fn(), stop: vi.fn() }
    const createAcpServer = vi.fn(() => server)
    const resolveFriend = vi.fn(async () => "11111111-1111-4111-8111-111111111111")
    const mcpPath = "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP"
    const deps = {
      socketPath: "/tmp/ouro.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      acpServeInput: input,
      acpServeOutput: output,
      createAcpServer,
      resolveFrontendFriendId: resolveFriend,
      existsSync: (candidate: string) => candidate === mcpPath,
    } as unknown as OuroCliDeps

    const running = runOuroCli([
      "acp-serve",
      "--agent",
      "Boss",
      "--friend-id",
      "friend-explicit",
      "--workbench-mcp",
      mcpPath,
    ], deps)
    await vi.waitFor(() => expect(server.start).toHaveBeenCalledOnce())
    input.emit(event)

    await expect(running).resolves.toBe("")
    expect(resolveFriend).toHaveBeenCalledWith(expect.objectContaining({
      agent: "Boss",
      explicitFriendId: "friend-explicit",
    }))
    expect(createAcpServer).toHaveBeenCalledWith({
      agent: "Boss",
      friendId: "11111111-1111-4111-8111-111111111111",
      frontendSocketPath: "/tmp/ouro.sock.frontend",
      stdin: input,
      stdout: output,
      runtimeMcpServers: {
        ouro_workbench: { command: mcpPath, args: [] },
      },
    })
    expect(server.stop).toHaveBeenCalledOnce()
  })

  it("uses the default daemon frontend socket without optional runtime MCP injection", async () => {
    const input = new EventEmitter()
    const output = new PassThrough()
    const server = { start: vi.fn(), stop: vi.fn() }
    const createAcpServer = vi.fn(() => server)
    const resolveFriend = vi.fn(async () => "11111111-1111-4111-8111-111111111111")
    const deps = {
      socketPath: "/tmp/ouro.sock",
      bundlesRoot: "/tmp/bundles",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      acpServeInput: input,
      acpServeOutput: output,
      createAcpServer,
      resolveFrontendFriendId: resolveFriend,
    } as unknown as OuroCliDeps

    const running = runOuroCli(["acp-serve", "--agent", "Boss"], deps)
    await vi.waitFor(() => expect(server.start).toHaveBeenCalledOnce())
    input.emit("end")
    await running

    expect(resolveFriend).toHaveBeenCalledWith({
      agent: "Boss",
      bundlesRoot: "/tmp/bundles",
    })

    expect(createAcpServer).toHaveBeenCalledWith({
      agent: "Boss",
      friendId: "11111111-1111-4111-8111-111111111111",
      frontendSocketPath: "/tmp/ouro.sock.frontend",
      stdin: input,
      stdout: output,
    })
  })

  it("starts observe-only ACP without runtime MCP tools", async () => {
    const input = new EventEmitter()
    const output = new PassThrough()
    const server = { start: vi.fn(), stop: vi.fn() }
    const createAcpServer = vi.fn(() => server)
    const deps = {
      socketPath: "/tmp/ouro.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      acpServeInput: input,
      acpServeOutput: output,
      createAcpServer,
      resolveFrontendFriendId: vi.fn(async () => "friend-1"),
      existsSync: vi.fn(() => true),
    } as unknown as OuroCliDeps

    const running = runOuroCli([
      "acp-serve",
      "--agent",
      "Boss",
      "--workbench-mcp",
      "/Applications/OuroWorkbenchMCP",
      "--observe-only",
    ], deps)
    await vi.waitFor(() => expect(server.start).toHaveBeenCalledOnce())
    input.emit("end")
    await running

    expect(createAcpServer).toHaveBeenCalledWith(expect.objectContaining({
      agent: "Boss",
      friendId: "friend-1",
      disableTools: true,
    }))
    expect(createAcpServer.mock.calls[0]![0]).not.toHaveProperty("runtimeMcpServers")
  })
})
