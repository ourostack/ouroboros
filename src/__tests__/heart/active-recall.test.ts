import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

describe("active recall", () => {
  let tmpDir: string
  let diaryRoot: string
  let journalDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "active-recall-"))
    diaryRoot = path.join(tmpDir, "diary")
    journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(diaryRoot, { recursive: true })
    fs.mkdirSync(journalDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeFact(text: string, embedding: number[] = []): void {
    const fact = {
      id: `fact-${Math.random()}`,
      text,
      source: "tool:diary_write",
      createdAt: "2026-04-12T00:00:00Z",
      embedding,
    }
    fs.appendFileSync(path.join(diaryRoot, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")
  }

  function writeJournalIndex(): void {
    fs.writeFileSync(
      path.join(journalDir, ".index.json"),
      JSON.stringify([
        {
          filename: "auth-notes.md",
          preview: "I kept a note that auth uses device code login",
          embedding: [1, 0, 0],
          mtime: Date.now(),
        },
      ]),
      "utf8",
    )
  }

  it("injects found recall as first-person notes the agent chose to keep", async () => {
    writeFact("auth uses OAuth device code login")
    writeJournalIndex()
    const { injectActiveRecall } = await import("../../heart/active-recall")
    const judge = vi.fn(async (input) => {
      expect(input.query).toBe("how does auth work?")
      expect(input.candidates.some((candidate) => candidate.source.kind === "diary")).toBe(true)
      expect(input.candidates.some((candidate) => candidate.source.kind === "journal")).toBe(true)
      expect(input.candidates.some((candidate) => candidate.source.kind === "friend-note")).toBe(true)
      return { status: "found" as const, note: "auth uses OAuth device code login", sourceIndexes: [0] }
    })
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "how does auth work?" },
    ]

    const outcome = await injectActiveRecall(messages, {
      diaryRoot,
      journalDir,
      friend: {
        id: "ari",
        name: "Ari",
        role: "primary",
        trustLevel: "family",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { auth: { value: "prefers deliberate recall phrasing", savedAt: "2026-04-12T00:00:00Z" } },
        totalTokens: 0,
        createdAt: "2026-04-12T00:00:00Z",
        updatedAt: "2026-04-12T00:00:00Z",
        schemaVersion: 1,
      },
      judge,
    })

    expect(outcome.status).toBe("found")
    expect(messages[0].content).toContain("## notes I chose to keep")
    expect(messages[0].content).toContain("I chose to keep this:")
    expect(messages[0].content).toContain("auth uses OAuth device code login")
    expect(messages[0].content).not.toContain("## recalled context")
  })

  it("does not inject anything for none, timeout, or error outcomes", async () => {
    writeFact("billing notes are intentionally unrelated")
    const { injectActiveRecall } = await import("../../heart/active-recall")
    const baseMessages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "billing notes" },
    ]

    const noneMessages = structuredClone(baseMessages)
    const noneOutcome = await injectActiveRecall(noneMessages, {
      diaryRoot,
      journalDir,
      judge: async () => ({ status: "none" as const, pressure: ["not relevant"] }),
    })

    const timeoutMessages = structuredClone(baseMessages)
    const timeoutOutcome = await injectActiveRecall(timeoutMessages, {
      diaryRoot,
      journalDir,
      timeoutMs: 1,
      judge: async () => new Promise(() => {}),
    })

    const errorMessages = structuredClone(baseMessages)
    const errorOutcome = await injectActiveRecall(errorMessages, {
      diaryRoot,
      journalDir,
      judge: async () => {
        throw new Error("judge failed")
      },
    })

    expect(noneOutcome.status).toBe("none")
    expect(timeoutOutcome.status).toBe("timeout")
    expect(errorOutcome.status).toBe("error")
    expect(noneMessages[0].content).toBe("system prompt")
    expect(timeoutMessages[0].content).toBe("system prompt")
    expect(errorMessages[0].content).toBe("system prompt")
  })

  it("skips recall when the turn is not eligible", async () => {
    const { injectActiveRecall } = await import("../../heart/active-recall")
    const judge = vi.fn()
    const noSystem: any[] = [{ role: "user", content: "hello" }]
    const noUser: any[] = [{ role: "system", content: "system prompt" }]

    const noSystemOutcome = await injectActiveRecall(noSystem, { diaryRoot, journalDir, judge })
    const noUserOutcome = await injectActiveRecall(noUser, { diaryRoot, journalDir, judge })

    expect(noSystemOutcome.status).toBe("none")
    expect(noUserOutcome.status).toBe("none")
    expect(judge).not.toHaveBeenCalled()
  })
})

describe("active recall model judge", () => {
  it("uses a no-tools boxed provider call and parses found JSON", async () => {
    const { createActiveRecallJudge } = await import("../../heart/active-recall")
    const runtime = {
      resetTurnState: vi.fn(),
      streamTurn: vi.fn(async () => ({
        content: JSON.stringify({ status: "found", note: "I wrote down the auth flow", sourceIndexes: [0] }),
        toolCalls: [],
        outputItems: [],
      })),
    }
    const judge = createActiveRecallJudge(runtime)
    const result = await judge({
      query: "auth",
      candidates: [
        {
          text: "auth uses OAuth device code login",
          source: { kind: "diary", label: "diary", ref: "fact-1" },
        },
      ],
    })

    expect(result.status).toBe("found")
    expect(runtime.resetTurnState).toHaveBeenCalled()
    expect(runtime.streamTurn).toHaveBeenCalledWith(expect.objectContaining({
      activeTools: [],
      toolChoiceRequired: false,
    }))
  })

  it("returns none for invalid or non-json model output", async () => {
    const { createActiveRecallJudge } = await import("../../heart/active-recall")
    const runtime = {
      resetTurnState: vi.fn(),
      streamTurn: vi.fn(async () => ({ content: "sure, here you go", toolCalls: [], outputItems: [] })),
    }
    const judge = createActiveRecallJudge(runtime)

    const result = await judge({
      query: "auth",
      candidates: [{ text: "auth note", source: { kind: "diary", label: "diary" } }],
    })

    expect(result).toEqual({ status: "none", pressure: ["invalid active recall judge output"] })
  })
})
