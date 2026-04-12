import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

describe("kept notes", () => {
  let tmpDir: string
  let diaryRoot: string
  let journalDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kept-notes-"))
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

  it("injects a found diary note with source-specific first-person phrasing", async () => {
    writeFact("auth uses OAuth device code login")
    writeJournalIndex()
    const { injectKeptNotes } = await import("../../heart/kept-notes")
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

    const outcome = await injectKeptNotes(messages, {
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
        notes: { auth: { value: "prefers deliberate phrasing", savedAt: "2026-04-12T00:00:00Z" } },
        totalTokens: 0,
        createdAt: "2026-04-12T00:00:00Z",
        updatedAt: "2026-04-12T00:00:00Z",
        schemaVersion: 1,
      },
      judge,
    })

    expect(outcome.status).toBe("found")
    expect(messages[0].content).toContain("## from my diary")
    expect(messages[0].content).toContain("This may matter now:")
    expect(messages[0].content).toContain("I kept this:")
    expect(messages[0].content).toContain("auth uses OAuth device code login")
  })

  it("does not inject anything for none, timeout, or error outcomes", async () => {
    writeFact("billing notes are intentionally unrelated")
    const { injectKeptNotes } = await import("../../heart/kept-notes")
    const baseMessages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "billing notes" },
    ]

    const noneMessages = structuredClone(baseMessages)
    const noneOutcome = await injectKeptNotes(noneMessages, {
      diaryRoot,
      journalDir,
      judge: async () => ({ status: "none" as const, pressure: ["not relevant"] }),
    })

    const timeoutMessages = structuredClone(baseMessages)
    const timeoutOutcome = await injectKeptNotes(timeoutMessages, {
      diaryRoot,
      journalDir,
      timeoutMs: 1,
      judge: async () => new Promise(() => {}),
    })

    const errorMessages = structuredClone(baseMessages)
    const errorOutcome = await injectKeptNotes(errorMessages, {
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

  it("handles boundary cases without surfacing brittle notes", async () => {
    writeFact("auth notes should remain available")
    fs.writeFileSync(path.join(journalDir, ".index.json"), JSON.stringify({ malformed: true }), "utf8")
    const { gatherKeptNotesCandidates, injectKeptNotes, renderKeptNotesOutcome } = await import("../../heart/kept-notes")

    expect(gatherKeptNotesCandidates("a", { diaryRoot, journalDir })).toEqual([])
    expect(gatherKeptNotesCandidates("auth", {
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
        notes: undefined,
        totalTokens: 0,
        createdAt: "2026-04-12T00:00:00Z",
        updatedAt: "2026-04-12T00:00:00Z",
        schemaVersion: 1,
      } as any,
    }).map((candidate) => candidate.source.kind)).toEqual(["diary"])
    expect(renderKeptNotesOutcome({ status: "timeout", elapsedMs: 1 })).toBeNull()
    expect(renderKeptNotesOutcome({
      status: "found",
      note: "journal auth note",
      sources: [{ kind: "journal", label: "journal", ref: "auth.md" }],
      elapsedMs: 1,
    })).toContain("## from my journal")
    expect(renderKeptNotesOutcome({
      status: "found",
      note: "friend auth note",
      sources: [{ kind: "friend-note", label: "friend note: Ari", ref: "auth" }],
      elapsedMs: 1,
    })).toContain("## from my friend notes")
    expect(renderKeptNotesOutcome({
      status: "found",
      note: "paired auth note",
      sources: [
        { kind: "diary", label: "diary", ref: "fact-1" },
        { kind: "journal", label: "journal", ref: "auth.md" },
      ],
      elapsedMs: 1,
    })).toContain("## from my diary and my journal")
    expect(renderKeptNotesOutcome({
      status: "found",
      note: "cross-source auth note",
      sources: [
        { kind: "diary", label: "diary", ref: "fact-1" },
        { kind: "journal", label: "journal", ref: "auth.md" },
        { kind: "friend-note", label: "friend note: Ari", ref: "auth" },
      ],
      elapsedMs: 1,
    })).toContain("## from my diary, my journal, and my friend notes")
    expect(renderKeptNotesOutcome({
      status: "fuzzy",
      hint: "I might have kept the auth trail",
      sources: [{ kind: "diary", label: "diary", ref: "fact-1" }],
      elapsedMs: 1,
    })).not.toContain("I may have kept something related:")

    const emptySourceMessages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "auth" },
    ]
    const emptySourceOutcome = await injectKeptNotes(emptySourceMessages, {
      diaryRoot,
      journalDir,
      judge: async () => ({ status: "found" as const, note: "I kept the auth path", sourceIndexes: [] }),
    })

    const invalidSourceMessages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "auth" },
    ]
    const invalidSourceOutcome = await injectKeptNotes(invalidSourceMessages, {
      diaryRoot,
      journalDir,
      judge: async () => ({ status: "found" as const, note: "I kept the auth path", sourceIndexes: [0.5, 99] } as any),
    })

    const stringErrorMessages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "auth" },
    ]
    const stringErrorOutcome = await injectKeptNotes(stringErrorMessages, {
      diaryRoot,
      journalDir,
      judge: async () => {
        throw "string failure" // eslint-disable-line no-throw-literal
      },
    })

    const blankUserOutcome = await injectKeptNotes([
      { role: "system", content: "system prompt" },
      { role: "user", content: "   " },
    ] as any[], {
      diaryRoot,
      journalDir,
      judge: async () => ({ status: "found" as const, note: "I kept a thing" }),
    })

    expect(emptySourceOutcome).toMatchObject({ status: "found", sources: [] })
    expect(invalidSourceOutcome).toMatchObject({ status: "found", sources: [] })
    expect(stringErrorOutcome).toMatchObject({ status: "error", reason: "string failure" })
    expect(blankUserOutcome.status).toBe("none")
    expect(emptySourceMessages[0].content).toContain("I kept the auth path")
    expect(emptySourceMessages[0].content).not.toContain("I kept this: I kept the auth path")
  })

  it("injects a fuzzy diary note as a first-person kept-note hint", async () => {
    writeFact("oauth sometimes points to the device code flow")
    const { injectKeptNotes } = await import("../../heart/kept-notes")
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "oauth details" },
    ]

    const outcome = await injectKeptNotes(messages, {
      diaryRoot,
      journalDir,
      judge: async () => ({ status: "fuzzy" as const, hint: "device code flow might matter", sourceIndexes: [0] }),
    })

    expect(outcome.status).toBe("fuzzy")
    expect(messages[0].content).toContain("## from my diary")
    expect(messages[0].content).toContain("This is only a possible match; I should verify it before relying on it:")
    expect(messages[0].content).toContain("I may have kept something related: device code flow might matter")
  })

  it("skips kept notes when the turn is not eligible", async () => {
    const { injectKeptNotes } = await import("../../heart/kept-notes")
    const judge = vi.fn()
    const noSystem: any[] = [{ role: "user", content: "hello" }]
    const noUser: any[] = [{ role: "system", content: "system prompt" }]

    const noSystemOutcome = await injectKeptNotes(noSystem, { diaryRoot, journalDir, judge })
    const noUserOutcome = await injectKeptNotes(noUser, { diaryRoot, journalDir, judge })

    expect(noSystemOutcome.status).toBe("none")
    expect(noUserOutcome.status).toBe("none")
    expect(judge).not.toHaveBeenCalled()
  })
})

describe("kept notes model judge", () => {
  it("uses a no-tools boxed provider call and parses found JSON", async () => {
    const { createKeptNotesJudge } = await import("../../heart/kept-notes")
    const signal = new AbortController().signal
    const runtime = {
      resetTurnState: vi.fn(),
      streamTurn: vi.fn(async () => ({
        content: JSON.stringify({ status: "found", note: "I wrote down the auth flow", sourceIndexes: [0] }),
        toolCalls: [],
        outputItems: [],
      })),
    }
    const judge = createKeptNotesJudge(runtime, signal)
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
      reasoningEffort: "low",
      signal,
      toolChoiceRequired: false,
    }))
    const request = runtime.streamTurn.mock.calls[0][0]
    request.callbacks.onModelStart()
    request.callbacks.onModelStreamStart()
    request.callbacks.onTextChunk("chunk")
    request.callbacks.onReasoningChunk("thinking")
    request.callbacks.onToolStart("tool", { arg: "value" })
    request.callbacks.onToolEnd("tool", "done", true)
    request.callbacks.onError(new Error("no-op"), "transient")
  })

  it("returns none for invalid or non-json model output", async () => {
    const { createKeptNotesJudge } = await import("../../heart/kept-notes")
    const runtime = {
      resetTurnState: vi.fn(),
      streamTurn: vi.fn(async () => ({ content: "sure, here you go", toolCalls: [], outputItems: [] })),
    }
    const judge = createKeptNotesJudge(runtime)

    const result = await judge({
      query: "auth",
      candidates: [{ text: "auth note", source: { kind: "diary", label: "diary" } }],
    })

    expect(result).toEqual({ status: "none", pressure: ["invalid kept notes judge output"] })
  })

  it("parses fuzzy and none JSON while sanitizing source indexes and pressure", async () => {
    const { createKeptNotesJudge } = await import("../../heart/kept-notes")
    const runtime = {
      resetTurnState: vi.fn(),
      streamTurn: vi.fn()
        .mockResolvedValueOnce({
          content: JSON.stringify({ status: "found", note: " I kept the auth flow " }),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ status: "fuzzy", hint: "I might have kept the auth trail", sourceIndexes: [0, "bad", 99] }),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ status: "none", pressure: ["weak overlap", 7] }),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ status: "fuzzy", hint: " maybe the auth trail " }),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ status: "none" }),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          content: JSON.stringify([]),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          content: JSON.stringify(null),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          content: JSON.stringify("invalid"),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ status: "found", note: "   " }),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ status: "found", note: 7 }),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ status: "fuzzy", hint: "   " }),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ status: "fuzzy", hint: 7 }),
          toolCalls: [],
          outputItems: [],
        })
        .mockResolvedValueOnce({
          toolCalls: [],
          outputItems: [],
        }),
    }
    const judge = createKeptNotesJudge(runtime)
    const input = {
      query: "auth",
      candidates: [{ text: "auth note", source: { kind: "diary" as const, label: "diary" } }],
    }

    await expect(judge(input)).resolves.toEqual({
      status: "found",
      note: "I kept the auth flow",
      sourceIndexes: undefined,
    })
    await expect(judge(input)).resolves.toEqual({
      status: "fuzzy",
      hint: "I might have kept the auth trail",
      sourceIndexes: [0, 99],
    })
    await expect(judge(input)).resolves.toEqual({ status: "none", pressure: ["weak overlap"] })
    await expect(judge(input)).resolves.toEqual({
      status: "fuzzy",
      hint: "maybe the auth trail",
      sourceIndexes: undefined,
    })
    await expect(judge(input)).resolves.toEqual({ status: "none", pressure: [] })
    await expect(judge(input)).resolves.toEqual({ status: "none", pressure: ["invalid kept notes judge output"] })
    await expect(judge(input)).resolves.toEqual({ status: "none", pressure: ["invalid kept notes judge output"] })
    await expect(judge(input)).resolves.toEqual({ status: "none", pressure: ["invalid kept notes judge output"] })
    await expect(judge(input)).resolves.toEqual({ status: "none", pressure: ["invalid kept notes judge output"] })
    await expect(judge(input)).resolves.toEqual({ status: "none", pressure: ["invalid kept notes judge output"] })
    await expect(judge(input)).resolves.toEqual({ status: "none", pressure: ["invalid kept notes judge output"] })
    await expect(judge(input)).resolves.toEqual({ status: "none", pressure: ["invalid kept notes judge output"] })
    await expect(judge(input)).resolves.toEqual({ status: "none", pressure: ["invalid kept notes judge output"] })
  })
})
