import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type OpenAI from "openai"
import type { DiaryEntry } from "../../mind/diary"

const mockGetOpenAIEmbeddingsApiKey = vi.fn()
const mockGetAgentRoot = vi.fn()

vi.mock("../../heart/config", () => ({
  getOpenAIEmbeddingsApiKey: () => mockGetOpenAIEmbeddingsApiKey(),
}))
vi.mock("../../heart/identity", () => ({
  getAgentRoot: () => mockGetAgentRoot(),
}))
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import {
  injectAssociativeRecall,
  type EmbeddingProvider,
} from "../../mind/associative-recall"

describe("associative recall provenance display", () => {
  beforeEach(() => {
    mockGetOpenAIEmbeddingsApiKey.mockReset().mockReturnValue("test-key")
    mockGetAgentRoot.mockReset().mockReturnValue("/mock/agent")
  })

  function writeFactsWithProvenance(diaryRoot: string, facts: DiaryEntry[]) {
    fs.mkdirSync(diaryRoot, { recursive: true })
    fs.writeFileSync(
      path.join(diaryRoot, "facts.jsonl"),
      facts.map((f) => JSON.stringify(f)).join("\n"),
      "utf8",
    )
  }

  const provider: EmbeddingProvider = {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => [1, 0])
    },
  }

  it("includes provenance fields in recall result text when present", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recall-prov-"))
    const fact: DiaryEntry = {
      id: "prov-1",
      text: "alice prefers dark mode",
      source: "tool:diary_write",
      createdAt: "2026-04-08T00:00:00.000Z",
      embedding: [0.99, 0.01],
      provenance: {
        tool: "diary_write",
        channel: "bluebubbles",
        friendId: "f-1",
        friendName: "alice",
        trust: "family",
      },
    }
    writeFactsWithProvenance(diaryRoot, [fact])

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base prompt" },
      { role: "user", content: "dark mode preference" },
    ]

    await injectAssociativeRecall(messages, { provider, diaryRoot, minScore: 0, topK: 1 })

    const content = messages[0].content as string
    expect(content).toContain("channel=bluebubbles")
    expect(content).toContain("friend=alice")
    expect(content).toContain("trust=family")
    expect(content).toContain("source=tool:diary_write")
  })

  it("works normally when diary entry has no provenance (backwards compat)", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recall-prov-"))
    const fact: DiaryEntry = {
      id: "old-1",
      text: "bob likes tea",
      source: "tool:diary_write",
      createdAt: "2026-04-08T00:00:00.000Z",
      embedding: [0.99, 0.01],
    }
    writeFactsWithProvenance(diaryRoot, [fact])

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base prompt" },
      { role: "user", content: "tea preference" },
    ]

    await injectAssociativeRecall(messages, { provider, diaryRoot, minScore: 0, topK: 1 })

    const content = messages[0].content as string
    expect(content).toContain("[diary] bob likes tea")
    expect(content).toContain("source=tool:diary_write")
    expect(content).not.toContain("channel=")
    expect(content).not.toContain("friend=")
    expect(content).not.toContain("trust=")
  })

  it("renders only defined provenance fields (partial: channel only)", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recall-prov-"))
    const fact: DiaryEntry = {
      id: "partial-1",
      text: "system preference noted",
      source: "tool:diary_write",
      createdAt: "2026-04-08T00:00:00.000Z",
      embedding: [0.99, 0.01],
      provenance: {
        tool: "diary_write",
        channel: "cli",
      },
    }
    writeFactsWithProvenance(diaryRoot, [fact])

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base prompt" },
      { role: "user", content: "system preference" },
    ]

    await injectAssociativeRecall(messages, { provider, diaryRoot, minScore: 0, topK: 1 })

    const content = messages[0].content as string
    expect(content).toContain("channel=cli")
    expect(content).not.toContain("friend=")
    expect(content).not.toContain("trust=")
  })
})
