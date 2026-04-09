import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { DiaryEntry } from "../../mind/diary"

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

describe("recall tool handler provenance output", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recall-tool-prov-"))
    fs.mkdirSync(path.join(agentRoot, "diary"), { recursive: true })
  })

  async function getRecallHandler() {
    const { memoryToolDefinitions } = await import("../../repertoire/tools-memory")
    const def = memoryToolDefinitions.find((d) => d.tool.function.name === "recall")
    expect(def).toBeDefined()
    return def!.handler
  }

  function writeFacts(facts: DiaryEntry[]) {
    const factsPath = path.join(agentRoot, "diary", "facts.jsonl")
    fs.writeFileSync(factsPath, facts.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8")
  }

  it("includes provenance fields when diary entry has full provenance", async () => {
    const handler = await getRecallHandler()
    writeFacts([{
      id: "prov-1",
      text: "alice prefers dark mode",
      source: "tool:diary_write",
      createdAt: "2026-04-08T00:00:00.000Z",
      embedding: [],
      provenance: {
        tool: "diary_write",
        channel: "bluebubbles",
        friendId: "f-1",
        friendName: "alice",
        trust: "family",
      },
    }])

    const result = await handler({ query: "dark mode" })
    expect(result).toContain("[diary] alice prefers dark mode")
    expect(result).toContain("source=tool:diary_write")
    expect(result).toContain("channel=bluebubbles")
    expect(result).toContain("friend=alice")
    expect(result).toContain("trust=family")
  })

  it("works normally when entry has no provenance (backwards compat)", async () => {
    const handler = await getRecallHandler()
    writeFacts([{
      id: "old-1",
      text: "bob likes tea",
      source: "tool:diary_write",
      createdAt: "2026-04-08T00:00:00.000Z",
      embedding: [],
    }])

    const result = await handler({ query: "tea" })
    expect(result).toContain("[diary] bob likes tea")
    expect(result).toContain("source=tool:diary_write")
    expect(result).not.toContain("channel=")
    expect(result).not.toContain("friend=")
    expect(result).not.toContain("trust=")
  })

  it("renders only defined provenance fields (partial)", async () => {
    const handler = await getRecallHandler()
    writeFacts([{
      id: "partial-1",
      text: "system preference noted via cli",
      source: "tool:diary_write",
      createdAt: "2026-04-08T00:00:00.000Z",
      embedding: [],
      provenance: {
        tool: "diary_write",
        channel: "cli",
      },
    }])

    const result = await handler({ query: "system preference" })
    expect(result).toContain("channel=cli")
    expect(result).not.toContain("friend=")
    expect(result).not.toContain("trust=")
  })

  it("renders provenance with only tool field (no channel, friend, or trust)", async () => {
    const handler = await getRecallHandler()
    writeFacts([{
      id: "tool-only-1",
      text: "minimal provenance entry",
      source: "tool:diary_write",
      createdAt: "2026-04-08T00:00:00.000Z",
      embedding: [],
      provenance: {
        tool: "diary_write",
      },
    }])

    const result = await handler({ query: "minimal provenance" })
    expect(result).toContain("[diary] minimal provenance entry")
    expect(result).toContain("source=tool:diary_write")
    expect(result).not.toContain("channel=")
    expect(result).not.toContain("friend=")
    expect(result).not.toContain("trust=")
  })
})
