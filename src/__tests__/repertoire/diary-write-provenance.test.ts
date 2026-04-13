import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { DiaryEntry, DiaryEntryProvenance } from "../../mind/diary"
import type { ToolContext } from "../../repertoire/tools-base"
import type { ResolvedContext, ChannelCapabilities, FriendRecord } from "../../mind/friends/types"

let agentRoot = ""

vi.mock("../../heart/identity", () => ({
  getAgentName: () => "test-agent",
  getAgentRoot: () => agentRoot,
}))
vi.mock("../../heart/config", () => ({
  getOpenAIEmbeddingsApiKey: () => "",
  getIntegrationsConfig: () => ({}),
}))
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "friend-alice",
    name: "alice",
    trustLevel: "family",
    connections: [],
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

function makeChannelCapabilities(channel: "cli" | "teams" | "bluebubbles" | "inner" | "mcp"): ChannelCapabilities {
  return {
    channel,
    senseType: "human",
    availableIntegrations: [],
    supportsMarkdown: true,
    supportsStreaming: true,
    supportsRichCards: false,
    maxMessageLength: 4000,
  }
}

describe("diary_write handler provenance extraction", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diary-write-prov-"))
    fs.mkdirSync(path.join(agentRoot, "diary"), { recursive: true })
  })

  async function getDiaryWriteHandler() {
    const { notesToolDefinitions } = await import("../../repertoire/tools-notes")
    const def = notesToolDefinitions.find((d) => d.tool.function.name === "diary_write")
    expect(def).toBeDefined()
    return def!.handler
  }

  it("passes full provenance when ToolContext has channel + friend + trust", async () => {
    const handler = await getDiaryWriteHandler()
    const friend = makeFriend({ id: "f-1", name: "alice", trustLevel: "family" })
    const ctx: Partial<ToolContext> = {
      context: {
        friend,
        channel: makeChannelCapabilities("bluebubbles"),
      } as ResolvedContext,
    }

    await handler({ entry: "test entry with full context" }, ctx as ToolContext)

    const factsPath = path.join(agentRoot, "diary", "facts.jsonl")
    const line = fs.readFileSync(factsPath, "utf8").trim()
    const parsed = JSON.parse(line) as DiaryEntry
    expect(parsed.provenance).toBeDefined()
    expect(parsed.provenance!.tool).toBe("diary_write")
    expect(parsed.provenance!.channel).toBe("bluebubbles")
    expect(parsed.provenance!.friendId).toBe("f-1")
    expect(parsed.provenance!.friendName).toBe("alice")
    expect(parsed.provenance!.trust).toBe("family")
  })

  it("passes provenance with only channel when no friend in context", async () => {
    const handler = await getDiaryWriteHandler()
    const ctx: Partial<ToolContext> = {
      context: {
        channel: makeChannelCapabilities("teams"),
        friend: makeFriend(),
      } as ResolvedContext,
    }
    // Override friend to simulate no friend -- use a context with channel only
    // We need to craft a context that has channel but friend fields are minimal
    const minimalCtx: Partial<ToolContext> = {
      context: {
        channel: makeChannelCapabilities("cli"),
      } as unknown as ResolvedContext,
    }

    await handler({ entry: "test entry channel only" }, minimalCtx as ToolContext)

    const factsPath = path.join(agentRoot, "diary", "facts.jsonl")
    const line = fs.readFileSync(factsPath, "utf8").trim()
    const parsed = JSON.parse(line) as DiaryEntry
    expect(parsed.provenance).toBeDefined()
    expect(parsed.provenance!.tool).toBe("diary_write")
    expect(parsed.provenance!.channel).toBe("cli")
    expect(parsed.provenance!.friendId).toBeUndefined()
    expect(parsed.provenance!.friendName).toBeUndefined()
    expect(parsed.provenance!.trust).toBeUndefined()
  })

  it("does not include provenance when ctx is undefined", async () => {
    const handler = await getDiaryWriteHandler()

    await handler({ entry: "test entry no ctx" }, undefined as unknown as ToolContext)

    const factsPath = path.join(agentRoot, "diary", "facts.jsonl")
    const line = fs.readFileSync(factsPath, "utf8").trim()
    const parsed = JSON.parse(line) as DiaryEntry
    expect(parsed.provenance).toBeUndefined()
  })

  it("does not include provenance when ctx has no context property", async () => {
    const handler = await getDiaryWriteHandler()
    const ctx: Partial<ToolContext> = {}

    await handler({ entry: "test entry empty ctx" }, ctx as ToolContext)

    const factsPath = path.join(agentRoot, "diary", "facts.jsonl")
    const line = fs.readFileSync(factsPath, "utf8").trim()
    const parsed = JSON.parse(line) as DiaryEntry
    expect(parsed.provenance).toBeUndefined()
  })

  it("creates provenance with only tool when context has no channel or friend", async () => {
    const handler = await getDiaryWriteHandler()
    const ctx: Partial<ToolContext> = {
      context: {} as unknown as ResolvedContext,
    }

    await handler({ entry: "test entry context no channel no friend" }, ctx as ToolContext)

    const factsPath = path.join(agentRoot, "diary", "facts.jsonl")
    const line = fs.readFileSync(factsPath, "utf8").trim()
    const parsed = JSON.parse(line) as DiaryEntry
    expect(parsed.provenance).toBeDefined()
    expect(parsed.provenance!.tool).toBe("diary_write")
    expect(parsed.provenance!.channel).toBeUndefined()
    expect(parsed.provenance!.friendId).toBeUndefined()
    expect(parsed.provenance!.friendName).toBeUndefined()
    expect(parsed.provenance!.trust).toBeUndefined()
  })

  it("always sets tool field to diary_write in provenance", async () => {
    const handler = await getDiaryWriteHandler()
    const friend = makeFriend({ id: "f-2", name: "bob", trustLevel: "stranger" })
    const ctx: Partial<ToolContext> = {
      context: {
        friend,
        channel: makeChannelCapabilities("mcp"),
      } as ResolvedContext,
    }

    await handler({ entry: "test entry tool field" }, ctx as ToolContext)

    const factsPath = path.join(agentRoot, "diary", "facts.jsonl")
    const line = fs.readFileSync(factsPath, "utf8").trim()
    const parsed = JSON.parse(line) as DiaryEntry
    expect(parsed.provenance!.tool).toBe("diary_write")
  })
})
