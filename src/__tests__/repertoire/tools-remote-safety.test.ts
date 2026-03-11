import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execTool, getToolsForChannel } from "../../repertoire/tools"
import type { ToolContext } from "../../repertoire/tools"
import { getChannelCapabilities } from "../../mind/friends/channel"

describe("remote channel tool safety", () => {
  it("does not expose local cli/file tools to remote channel tool lists", () => {
    const tools = getToolsForChannel(getChannelCapabilities("teams"))
    const names = tools.map((t) => t.function.name)

    expect(names).not.toContain("shell")
    expect(names).not.toContain("read_file")
    expect(names).not.toContain("write_file")
    // git_commit and gh_cli have been fully removed from base tools, not just blocked
    expect(names).not.toContain("git_commit")
    expect(names).not.toContain("gh_cli")
  })

  it("file_ouroboros_bug appears in Teams tool list (integration tool, not blocked)", () => {
    const tools = getToolsForChannel(getChannelCapabilities("teams"))
    const names = tools.map((t) => t.function.name)

    expect(names).toContain("file_ouroboros_bug")
  })

  it("does not expose local cli/file tools to bluebubbles tool lists", () => {
    const tools = getToolsForChannel(getChannelCapabilities("bluebubbles"))
    const names = tools.map((t) => t.function.name)

    expect(names).not.toContain("shell")
    expect(names).not.toContain("read_file")
    expect(names).not.toContain("write_file")
    // git_commit and gh_cli have been fully removed from base tools
    expect(names).not.toContain("git_commit")
    expect(names).not.toContain("gh_cli")
  })

  it("exposes local tools for trusted one-to-one bluebubbles contexts", () => {
    const tools = getToolsForChannel(
      getChannelCapabilities("bluebubbles"),
      undefined,
      {
        friend: {
          id: "friend-1",
          name: "Ari",
          trustLevel: "family",
          externalIds: [{ provider: "imessage-handle", externalId: "ari@mendelow.me", linkedAt: "2026-03-08T00:00:00.000Z" }],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("bluebubbles"),
      },
    )
    const names = tools.map((t) => t.function.name)

    expect(names).toContain("shell")
    expect(names).toContain("read_file")
    expect(names).toContain("write_file")
    // git_commit and gh_cli have been fully removed from base tools
    expect(names).not.toContain("git_commit")
    expect(names).not.toContain("gh_cli")
  })

  it("allows local tools for family in group bluebubbles contexts (trust-level only)", () => {
    const tools = getToolsForChannel(
      getChannelCapabilities("bluebubbles"),
      undefined,
      {
        friend: {
          id: "group-1",
          name: "Consciousness TBD",
          trustLevel: "family",
          externalIds: [{ provider: "imessage-handle", externalId: "group:any;+;group-guid", linkedAt: "2026-03-08T00:00:00.000Z" }],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("bluebubbles"),
      },
    )
    const names = tools.map((t) => t.function.name)

    expect(names).toContain("shell")
    expect(names).toContain("read_file")
  })

  it("exposes local tools for trusted one-to-one teams contexts", () => {
    const tools = getToolsForChannel(
      getChannelCapabilities("teams"),
      undefined,
      {
        friend: {
          id: "friend-2",
          name: "Jordan",
          trustLevel: "friend",
          externalIds: [{ provider: "teams-user", externalId: "8:orgid:user-guid", linkedAt: "2026-03-08T00:00:00.000Z" }],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("teams"),
      },
    )
    const names = tools.map((t) => t.function.name)

    expect(names).toContain("shell")
    expect(names).toContain("read_file")
  })

  it("treats missing externalIds as a non-shared trusted remote context", () => {
    const tools = getToolsForChannel(
      getChannelCapabilities("bluebubbles"),
      undefined,
      {
        friend: {
          id: "friend-4",
          name: "Casey",
          trustLevel: "family",
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("bluebubbles"),
      },
    )
    const names = tools.map((t) => t.function.name)

    expect(names).toContain("shell")
    expect(names).toContain("read_file")
  })

  it("treats undefined trustLevel as friend (backward compat — legacy friends keep tool access)", () => {
    const tools = getToolsForChannel(
      getChannelCapabilities("bluebubbles"),
      undefined,
      {
        friend: {
          id: "friend-legacy",
          name: "Legacy Friend",
          // trustLevel intentionally omitted — pre-trust-level friend records
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          schemaVersion: 1,
        } as any,
        channel: getChannelCapabilities("bluebubbles"),
      },
    )
    const names = tools.map((t) => t.function.name)

    expect(names).toContain("shell")
    expect(names).toContain("read_file")
  })

  it("allows local tools for family in teams conversations (trust-level only)", () => {
    const tools = getToolsForChannel(
      getChannelCapabilities("teams"),
      undefined,
      {
        friend: {
          id: "friend-3",
          name: "Project Group",
          trustLevel: "family",
          externalIds: [{ provider: "teams-conversation", externalId: "19:conversation-id", linkedAt: "2026-03-08T00:00:00.000Z" }],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("teams"),
      },
    )
    const names = tools.map((t) => t.function.name)

    expect(names).toContain("shell")
    expect(names).toContain("read_file")
  })

  it("returns explanatory denial messaging when remote context attempts local shell execution", async () => {
    const remoteContext = {
      signin: async () => undefined,
      context: {
        identity: {
          id: "friend-1",
          displayName: "Test Friend",
          externalIds: [],
          tenantMemberships: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("teams"),
        memory: null,
      },
    } as unknown as ToolContext

    const result = await execTool("shell", { command: "echo hello" }, remoteContext)

    expect(result.toLowerCase()).toContain("can't do that")
    expect(result.toLowerCase()).toContain("trust")
  })

  it("returns explanatory denial messaging when bluebubbles context attempts local shell execution", async () => {
    const remoteContext = {
      signin: async () => undefined,
      context: {
        friend: {
          id: "friend-1",
          name: "Test Friend",
          trustLevel: "stranger",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("bluebubbles"),
      },
    } as unknown as ToolContext

    const result = await execTool("shell", { command: "echo hello" }, remoteContext)

    expect(result.toLowerCase()).toContain("can't do that")
    expect(result.toLowerCase()).toContain("trust")
  })

  it("keeps local tools blocked for stranger one-to-one bluebubbles contexts", async () => {
    const tools = getToolsForChannel(
      getChannelCapabilities("bluebubbles"),
      undefined,
      {
        friend: {
          id: "friend-4",
          name: "Unknown",
          trustLevel: "stranger",
          externalIds: [{ provider: "imessage-handle", externalId: "unknown@example.com", linkedAt: "2026-03-08T00:00:00.000Z" }],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("bluebubbles"),
      },
    )

    expect(tools.map((t) => t.function.name)).not.toContain("shell")

    const result = await execTool("shell", { command: "echo hello" }, {
      signin: async () => undefined,
      context: {
        friend: {
          id: "friend-4",
          name: "Unknown",
          trustLevel: "stranger",
          externalIds: [{ provider: "imessage-handle", externalId: "unknown@example.com", linkedAt: "2026-03-08T00:00:00.000Z" }],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("bluebubbles"),
      },
    } as unknown as ToolContext)

    expect(result.toLowerCase()).toContain("can't do that")
    expect(result.toLowerCase()).toContain("trust")
  })

  it("allows local file reads for trusted one-to-one bluebubbles contexts", async () => {
    const filePath = path.join(os.tmpdir(), `bb-tools-${Date.now()}.txt`)
    fs.writeFileSync(filePath, "hello from trusted dm", "utf8")

    const remoteContext = {
      signin: async () => undefined,
      context: {
        friend: {
          id: "friend-1",
          name: "Ari",
          trustLevel: "family",
          externalIds: [{ provider: "imessage-handle", externalId: "ari@mendelow.me", linkedAt: "2026-03-08T00:00:00.000Z" }],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("bluebubbles"),
      },
    } as unknown as ToolContext

    try {
      const result = await execTool("read_file", { path: filePath }, remoteContext)
      expect(result).toContain("hello from trusted dm")
    } finally {
      fs.unlinkSync(filePath)
    }
  })
})
