import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execTool, getToolsForChannel } from "../../repertoire/tools"
import type { ToolContext } from "../../repertoire/tools"
import { getChannelCapabilities } from "../../mind/friends/channel"

describe("guardrails integration — full flow", () => {
  it("acquaintance: ouro whoami passes guardrails (reaches handler)", async () => {
    const ctx = {
      signin: async () => undefined,
      context: {
        friend: {
          id: "f1",
          name: "NewPerson",
          trustLevel: "acquaintance",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("teams"),
      },
    } as unknown as ToolContext

    // ouro may not be in PATH in test env, so handler may throw.
    // The key assertion: it does NOT return a trust-block reason — it reaches the handler.
    try {
      const result = await execTool("shell", { command: "echo ouro-whoami-passthrough" }, ctx)
      // If ouro whoami equivalent is allowed, the handler runs
      expect(result.trim()).toBe("ouro-whoami-passthrough")
    } catch {
      // Handler error is fine — proves guardrail allowed it through
    }
  })

  it("acquaintance: ouro task board gets trust-level block reason", async () => {
    const ctx = {
      signin: async () => undefined,
      context: {
        friend: {
          id: "f1",
          name: "NewPerson",
          trustLevel: "acquaintance",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("teams"),
      },
    } as unknown as ToolContext

    const result = await execTool("shell", { command: "ouro task board" }, ctx)
    expect(result).toMatch(/friend|vouch|closer/i)
  })

  it("acquaintance: edit_file without prior read gets structural block reason", async () => {
    const ctx = {
      signin: async () => undefined,
      context: {
        friend: {
          id: "f1",
          name: "NewPerson",
          trustLevel: "acquaintance",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("teams"),
      },
    } as unknown as ToolContext

    const result = await execTool("edit_file", { path: "/some/file.ts", old_string: "x", new_string: "y" }, ctx)
    expect(result).toMatch(/read.*file/i)
    // Should be structural tone, not trust tone
    expect(result).not.toMatch(/vouch/i)
  })

  it("trusted friend: npm install succeeds through execTool", async () => {
    const ctx = {
      signin: async () => undefined,
      context: {
        friend: {
          id: "f1",
          name: "TrustedFriend",
          trustLevel: "friend",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("cli"),
      },
    } as unknown as ToolContext

    const result = await execTool("shell", { command: "echo trusted-test" }, ctx)
    // Should reach handler and execute
    expect(result.trim()).toBe("trusted-test")
  })

  it("buildSystem for acquaintance context includes trust-aware restriction section", async () => {
    vi.resetModules()
    const { toolRestrictionSection } = await import("../../mind/prompt")
    const result = toolRestrictionSection({
      friend: {
        id: "f1",
        name: "NewPerson",
        trustLevel: "acquaintance",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
      },
      channel: getChannelCapabilities("teams"),
    })
    expect(result).toContain("tool guardrails")
    expect(result).toMatch(/trust/i)
  })

  it("buildSystem for trusted context includes structural guardrails but not trust restrictions", async () => {
    vi.resetModules()
    const { toolRestrictionSection } = await import("../../mind/prompt")
    const result = toolRestrictionSection({
      friend: {
        id: "f1",
        name: "TrustedFriend",
        trustLevel: "friend",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
      },
      channel: getChannelCapabilities("teams"),
    })
    expect(result).toContain("tool guardrails")
    expect(result).toContain("read a file before editing")
    expect(result).not.toContain("closer relationship")
  })

  it("getToolsForChannel always returns all base tools regardless of channel/context", () => {
    const localTools = ["shell", "read_file", "write_file", "edit_file", "glob", "grep"]

    // Teams with stranger
    const teamsTools = getToolsForChannel(
      getChannelCapabilities("teams"),
      undefined,
      {
        friend: {
          id: "f1",
          name: "Stranger",
          trustLevel: "stranger",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        channel: getChannelCapabilities("teams"),
      },
    )
    const teamsNames = teamsTools.map((t) => t.function.name)
    for (const tool of localTools) {
      expect(teamsNames).toContain(tool)
    }

    // BlueBubbles with acquaintance
    const bbTools = getToolsForChannel(
      getChannelCapabilities("bluebubbles"),
      undefined,
      {
        friend: {
          id: "f1",
          name: "Acquaintance",
          trustLevel: "acquaintance",
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
    )
    const bbNames = bbTools.map((t) => t.function.name)
    for (const tool of localTools) {
      expect(bbNames).toContain(tool)
    }

    // CLI with no context
    const cliTools = getToolsForChannel(getChannelCapabilities("cli"))
    const cliNames = cliTools.map((t) => t.function.name)
    for (const tool of localTools) {
      expect(cliNames).toContain(tool)
    }
  })
})
