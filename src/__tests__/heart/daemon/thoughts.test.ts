import { describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs")
  return {
    ...actual,
    watchFile: vi.fn(actual.watchFile),
    unwatchFile: vi.fn(actual.unwatchFile),
  }
})

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { parseInnerDialogSession, formatThoughtTurns, getInnerDialogSessionPath, followThoughts } from "../../../heart/daemon/thoughts"

describe("thoughts", () => {
  function tmpSessionFile(messages: unknown[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thoughts-test-"))
    const filePath = path.join(dir, "dialog.json")
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, messages }))
    return filePath
  }

  describe("parseInnerDialogSession", () => {
    it("parses boot + heartbeat turns", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        { role: "assistant", content: "checking in. all looks good." },
        { role: "user", content: "...time passing. anything stirring?\n\nlast checkpoint: all looks good." },
        { role: "assistant", content: "nothing new. resting." },
      ])

      const turns = parseInnerDialogSession(sessionPath)

      expect(turns).toHaveLength(2)
      expect(turns[0].type).toBe("boot")
      expect(turns[0].response).toBe("checking in. all looks good.")
      expect(turns[1].type).toBe("heartbeat")
      expect(turns[1].response).toBe("nothing new. resting.")
    })

    it("parses task-triggered turns", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "a task needs my attention.\n\n## task: habits/daily-standup\n---\ntype: habit\n---\nDo standup." },
        { role: "assistant", content: "sent standup summary." },
      ])

      const turns = parseInnerDialogSession(sessionPath)

      expect(turns).toHaveLength(1)
      expect(turns[0].type).toBe("task")
      expect(turns[0].taskId).toBe("habits/daily-standup")
      expect(turns[0].response).toBe("sent standup summary.")
    })

    it("extracts tool call names from assistant messages", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "search_notes", arguments: "{}" } },
            { id: "tc_2", type: "function", function: { name: "shell", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "tc_1", content: "results" },
        { role: "tool", tool_call_id: "tc_2", content: "ok" },
        { role: "assistant", content: "found something interesting." },
      ])

      const turns = parseInnerDialogSession(sessionPath)

      expect(turns).toHaveLength(1)
      expect(turns[0].tools).toEqual(["search_notes", "shell"])
      expect(turns[0].response).toBe("found something interesting.")
    })

    it("extracts response from settle tool call when content is null", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "shell", arguments: "{\"command\":\"ls\"}" } },
          ],
        },
        { role: "tool", tool_call_id: "tc_1", content: "file1 file2" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_2", type: "function", function: { name: "settle", arguments: "{\"answer\":\"checked the files. all good.\"}" } },
          ],
        },
      ])

      const turns = parseInnerDialogSession(sessionPath)

      expect(turns).toHaveLength(1)
      expect(turns[0].response).toBe("checked the files. all good.")
      expect(turns[0].tools).toEqual(["shell"])
    })

    it("excludes settle from tool names list", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "search_notes", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "tc_1", content: "results" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_2", type: "function", function: { name: "settle", arguments: "{\"answer\":\"done\"}" } },
          ],
        },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].tools).toEqual(["search_notes"])
      expect(turns[0].tools).not.toContain("settle")
    })

    it("extracts settle when mixed with other tool calls in same message", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "diary_write", arguments: "{}" } },
            { id: "tc_2", type: "function", function: { name: "settle", arguments: "{\"answer\":\"saved and done.\"}" } },
          ],
        },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].response).toBe("saved and done.")
      expect(turns[0].tools).toEqual(["diary_write"])
    })

    it("handles settle with malformed arguments", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "settle", arguments: "not json" } },
          ],
        },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].response).toBe("")
    })

    it("handles settle with missing arguments field", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "settle" } },
          ],
        },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].response).toBe("")
    })

    it("ignores malformed tool-call function payloads while continuing to parse the turn", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: "not-an-object" },
            { id: "tc_2", type: "function", function: { name: 42, arguments: "{\"answer\":\"hidden\"}" } },
          ],
        },
        { role: "assistant", content: "still here." },
      ])

      const turns = parseInnerDialogSession(sessionPath)

      expect(turns).toHaveLength(1)
      expect(turns[0].tools).toEqual([])
      expect(turns[0].response).toBe("still here.")
    })

    it("returns empty array for nonexistent file", () => {
      expect(parseInnerDialogSession("/tmp/nonexistent-dialog.json")).toEqual([])
    })

    it("returns empty array for invalid JSON", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thoughts-test-"))
      const filePath = path.join(dir, "dialog.json")
      fs.writeFileSync(filePath, "not json")

      expect(parseInnerDialogSession(filePath)).toEqual([])
    })

    it("returns empty array for wrong version", () => {
      const filePath = tmpSessionFile([])
      fs.writeFileSync(filePath, JSON.stringify({ version: 99, messages: [] }))

      expect(parseInnerDialogSession(filePath)).toEqual([])
    })

    it("handles assistant with structured content arrays", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        { role: "assistant", content: [{ type: "text", text: "structured response" }] },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].response).toBe("structured response")
    })

    it("handles non-text elements in structured content arrays", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        { role: "assistant", content: [{ type: "image", url: "http://example.com" }, { type: "text", text: "after image" }] },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].response).toContain("after image")
    })

    it("skips orphan non-user messages before first user turn", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "orphan assistant message" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        { role: "assistant", content: "real response." },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns).toHaveLength(1)
      expect(turns[0].response).toBe("real response.")
    })

    it("handles null content in assistant message", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        { role: "assistant", content: null },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns).toHaveLength(1)
      expect(turns[0].response).toBe("")
    })

    it("handles mixed string and object elements in content array", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        { role: "assistant", content: ["plain text", { type: "text", text: "structured" }] },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].response).toContain("plain text")
      expect(turns[0].response).toContain("structured")
    })

    it("handles tool calls without function name", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "real_tool", arguments: "{}" } },
            { id: "tc_2", type: "function", function: { name: "", arguments: "{}" } },
            { id: "tc_3", type: "custom" },
          ],
        },
        { role: "tool", tool_call_id: "tc_1", content: "ok" },
        { role: "assistant", content: "done." },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].tools).toEqual(["real_tool"])
    })

    it("handles turn with no assistant response", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns).toHaveLength(1)
      expect(turns[0].response).toBe("")
    })
  })

  describe("formatThoughtTurns", () => {
    it("formats turns with type labels and responses", () => {
      const output = formatThoughtTurns([
        { type: "boot", prompt: "waking up.", response: "checking in.", tools: [] },
        { type: "heartbeat", prompt: "anything?", response: "nothing new.", tools: ["search_notes"] },
      ], 10)

      expect(output).toContain("--- boot ---")
      expect(output).toContain("checking in.")
      expect(output).toContain("--- heartbeat ---")
      expect(output).toContain("tools: search_notes")
      expect(output).toContain("nothing new.")
    })

    it("shows task ID in label for task turns", () => {
      const output = formatThoughtTurns([
        { type: "task", prompt: "task", response: "done.", tools: [], taskId: "habits/standup" },
      ], 10)

      expect(output).toContain("--- task: habits/standup ---")
    })

    it("returns all turns when lastN is 0", () => {
      const turns = [
        { type: "boot" as const, prompt: "waking up.", response: "first.", tools: [] },
        { type: "heartbeat" as const, prompt: "anything?", response: "second.", tools: [] },
      ]
      const output = formatThoughtTurns(turns, 0)

      expect(output).toContain("first.")
      expect(output).toContain("second.")
    })

    it("limits to last N turns", () => {
      const turns = Array.from({ length: 20 }, (_, i) => ({
        type: "heartbeat" as const,
        prompt: `prompt ${i}`,
        response: `response ${i}`,
        tools: [],
      }))

      const output = formatThoughtTurns(turns, 3)

      expect(output).toContain("response 17")
      expect(output).toContain("response 18")
      expect(output).toContain("response 19")
      expect(output).not.toContain("response 16")
    })

    it("returns fallback message for empty turns", () => {
      expect(formatThoughtTurns([], 10)).toBe("no inner dialog activity")
    })

    it("shows (no response) for empty response", () => {
      const output = formatThoughtTurns([
        { type: "boot", prompt: "waking up.", response: "", tools: [] },
      ], 10)

      expect(output).toContain("(no response)")
    })
  })

  describe("getInnerDialogSessionPath", () => {
    it("returns correct path", () => {
      const result = getInnerDialogSessionPath("/home/agent/slugger.ouro")
      expect(result).toBe("/home/agent/slugger.ouro/state/sessions/self/inner/dialog.json")
    })
  })

  describe("followThoughts", () => {
    function writeThoughtSession(sessionPath: string, messages: unknown[]): void {
      fs.writeFileSync(sessionPath, JSON.stringify({ version: 1, messages }))
    }

    function captureWatchListener() {
      let listener: ((curr: fs.Stats, prev: fs.Stats) => void) | undefined
      const watchSpy = vi.mocked(fs.watchFile).mockImplementation(((pathArg, options, callback) => {
        listener = callback
        return undefined as unknown as fs.StatWatcher
      }) as typeof fs.watchFile)
      const unwatchSpy = vi.mocked(fs.unwatchFile).mockImplementation((() => undefined) as typeof fs.unwatchFile)

      return {
        invoke(sessionPath: string) {
          const stats = fs.statSync(sessionPath)
          listener?.(stats, stats)
        },
        watchSpy,
        unwatchSpy,
      }
    }

    it("calls onNewTurns when session file is updated with new turns", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-test-"))
      const sessionPath = path.join(dir, "dialog.json")

      writeThoughtSession(sessionPath, [
        { role: "system", content: "system" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        { role: "assistant", content: "first thought." },
      ])

      const { invoke, watchSpy, unwatchSpy } = captureWatchListener()

      try {
        const received: string[] = []
        const stop = followThoughts(sessionPath, (formatted) => {
          received.push(formatted)
        }, 100)

        writeThoughtSession(sessionPath, [
          { role: "system", content: "system" },
          { role: "user", content: "waking up.\n\nwhat needs my attention?" },
          { role: "assistant", content: "first thought." },
          { role: "user", content: "...time passing. anything stirring?" },
          { role: "assistant", content: "second thought." },
        ])

        invoke(sessionPath)
        stop()

        expect(watchSpy).toHaveBeenCalledWith(sessionPath, { interval: 100 }, expect.any(Function))
        expect(received).toHaveLength(1)
        expect(received[0]).toContain("second thought.")
        expect(received[0]).not.toContain("first thought.")
      } finally {
        watchSpy.mockReset()
        unwatchSpy.mockReset()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it("does not call onNewTurns when turn count stays the same", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-test-"))
      const sessionPath = path.join(dir, "dialog.json")

      const initialMessages = [
        { role: "system", content: "system" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        { role: "assistant", content: "same thought." },
      ]
      writeThoughtSession(sessionPath, initialMessages)

      const { invoke, watchSpy, unwatchSpy } = captureWatchListener()

      try {
        const received: string[] = []
        const stop = followThoughts(sessionPath, (formatted) => {
          received.push(formatted)
        }, 100)

        writeThoughtSession(sessionPath, initialMessages)
        invoke(sessionPath)
        stop()

        expect(received).toHaveLength(0)
      } finally {
        watchSpy.mockReset()
        unwatchSpy.mockReset()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it("returns cleanup function that stops watching", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-test-"))
      const sessionPath = path.join(dir, "dialog.json")

      writeThoughtSession(sessionPath, [
        { role: "system", content: "system" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        { role: "assistant", content: "initial." },
      ])

      const { watchSpy, unwatchSpy } = captureWatchListener()

      try {
        const received: string[] = []
        const stop = followThoughts(sessionPath, (formatted) => {
          received.push(formatted)
        }, 100)

        stop()

        expect(received).toHaveLength(0)
        expect(unwatchSpy).toHaveBeenCalledWith(sessionPath)
      } finally {
        watchSpy.mockReset()
        unwatchSpy.mockReset()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("deriveInnerDialogStatus", () => {
    it("derives pending status from queued self-messages", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      expect(typeof thoughts.deriveInnerDialogStatus).toBe("function")
      expect(thoughts.deriveInnerDialogStatus(
        [{ from: "slugger", content: "think about penguins", timestamp: 1 }],
        [],
      )).toEqual({
        queue: "queued to inner/dialog",
        wake: "awaiting inner session",
        processing: "pending",
        surfaced: "nothing yet",
      })
    })

    it("derives surfaced preview from the latest processed pending turn", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      expect(typeof thoughts.deriveInnerDialogStatus).toBe("function")
      expect(thoughts.deriveInnerDialogStatus(
        [],
        [{
          type: "heartbeat",
          prompt: "## pending messages\n[pending from slugger]: think about penguins\n\n...time passing. anything stirring?",
          response: "formal little blokes.",
          tools: [],
        }],
      )).toEqual({
        queue: "clear",
        wake: "completed",
        processing: "processed",
        surfaced: '"formal little blokes."',
      })
    })

    it("reports processing started when runtime state says the inner turn is still active", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      expect(thoughts.deriveInnerDialogStatus(
        [],
        [{
          type: "heartbeat",
          prompt: "## pending messages\n[pending from slugger]: think about penguins\n\n...time passing. anything stirring?",
          response: "formal little blokes.",
          tools: [],
        }],
        {
          status: "running",
          reason: "instinct",
          startedAt: "2026-03-12T00:00:00.000Z",
        },
      )).toEqual({
        queue: "clear",
        wake: "in progress",
        processing: "started",
        surfaced: "nothing yet",
      })
    })

    it("keeps queued state visible while runtime state is active and pending remains", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      expect(thoughts.deriveInnerDialogStatus(
        [{ from: "slugger", content: "think about penguins", timestamp: 1 }],
        [],
        {
          status: "running",
          reason: "instinct",
          startedAt: "2026-03-12T00:00:00.000Z",
        },
      )).toEqual({
        queue: "queued to inner/dialog",
        wake: "queued behind active turn",
        processing: "pending",
        surfaced: "nothing yet",
      })
    })

    it("returns idle status when nothing is queued or recently surfaced", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      expect(thoughts.deriveInnerDialogStatus(
        [],
        [{
          type: "heartbeat",
          prompt: "[pending from slugger] malformed pending marker",
          response: "",
          tools: [],
        }],
      )).toEqual({
        queue: "clear",
        wake: "idle",
        processing: "idle",
        surfaced: "nothing recent",
      })
    })

    it("formats no-result and truncated surfaced values explicitly", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      expect(thoughts.formatSurfacedValue("")).toBe("no outward result")
      expect(thoughts.formatSurfacedValue("a".repeat(140), 20)).toBe('"aaaaaaaaaaaaaaaaa..."')
    })

    it("formats full inner-dialog status lines for terminal output", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      expect(thoughts.formatInnerDialogStatus({
        queue: "queued to inner/dialog",
        wake: "in progress",
        processing: "started",
        surfaced: '"formal little blokes"',
      })).toBe([
        "queue: queued to inner/dialog",
        "wake: in progress",
        "processing: started",
        'surfaced: "formal little blokes"',
      ].join("\n"))
    })

    it("ignores unreadable or malformed pending files when reading status from disk", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")
      const pendingDir = fs.mkdtempSync(path.join(os.tmpdir(), "thoughts-pending-"))
      fs.writeFileSync(path.join(pendingDir, "000.json.processing"), "{not-json")
      fs.writeFileSync(path.join(pendingDir, "001.json"), JSON.stringify({
        from: "slugger",
        content: 42,
        timestamp: 1,
      }))

      expect(thoughts.readInnerDialogStatus("/tmp/nonexistent-dialog.json", pendingDir)).toEqual({
        queue: "clear",
        wake: "idle",
        processing: "idle",
        surfaced: "nothing recent",
      })

      const notADirectoryPath = path.join(os.tmpdir(), `thoughts-pending-file-${Date.now()}.json`)
      fs.writeFileSync(notADirectoryPath, "{}")

      expect(thoughts.readInnerDialogStatus("/tmp/nonexistent-dialog.json", notADirectoryPath)).toEqual({
        queue: "clear",
        wake: "idle",
        processing: "idle",
        surfaced: "nothing recent",
      })

      fs.unlinkSync(notADirectoryPath)
    })

    it("prefers live runtime state over stale processed transcript state", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thoughts-runtime-"))
      const sessionPath = path.join(dir, "dialog.json")
      const runtimePath = path.join(dir, "runtime.json")

      fs.writeFileSync(sessionPath, JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "system" },
          {
            role: "user",
            content: "## pending messages\n[pending from slugger]: think about penguins\n\n...time passing. anything stirring?",
          },
          { role: "assistant", content: "formal little blokes." },
        ],
      }))
      fs.writeFileSync(runtimePath, JSON.stringify({
        status: "running",
        reason: "instinct",
        startedAt: "2026-03-12T00:00:00.000Z",
      }))

      expect(thoughts.readInnerDialogStatus(sessionPath, path.join(dir, "pending"), runtimePath)).toEqual({
        queue: "clear",
        wake: "in progress",
        processing: "started",
        surfaced: "nothing yet",
      })

      fs.rmSync(dir, { recursive: true, force: true })
    })

    it("ignores malformed runtime metadata fields while preserving valid status", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thoughts-runtime-"))
      const sessionPath = path.join(dir, "dialog.json")
      const pendingDir = path.join(dir, "pending")
      const runtimePath = path.join(dir, "runtime.json")

      fs.mkdirSync(pendingDir, { recursive: true })
      fs.writeFileSync(sessionPath, JSON.stringify({ version: 1, messages: [] }))
      fs.writeFileSync(runtimePath, JSON.stringify({
        status: "idle",
        reason: "mystery",
        startedAt: 42,
        lastCompletedAt: false,
      }))

      expect(thoughts.readInnerDialogStatus(sessionPath, pendingDir, runtimePath)).toEqual({
        queue: "clear",
        wake: "idle",
        processing: "idle",
        surfaced: "nothing recent",
      })

      fs.rmSync(dir, { recursive: true, force: true })
    })

    it("includes origin info when pending messages have delegatedFrom", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      const status = thoughts.deriveInnerDialogStatus(
        [{
          from: "testagent",
          content: "think about penguins",
          timestamp: 1,
          delegatedFrom: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
        }],
        [],
      )
      expect(status.origin).toEqual({
        friendId: "friend-1",
        channel: "bluebubbles",
        key: "chat",
      })
    })

    it("includes contentSnippet from first pending message", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      const status = thoughts.deriveInnerDialogStatus(
        [{
          from: "testagent",
          content: "think about penguins and their formal attire",
          timestamp: 1,
          delegatedFrom: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
        }],
        [],
      )
      expect(status.contentSnippet).toBe("think about penguins and their formal attire")
    })

    it("truncates contentSnippet to 80 chars", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      const longContent = "a".repeat(100)
      const status = thoughts.deriveInnerDialogStatus(
        [{
          from: "testagent",
          content: longContent,
          timestamp: 1,
          delegatedFrom: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
        }],
        [],
      )
      expect(status.contentSnippet!.length).toBeLessThanOrEqual(80)
    })

    it("sets obligationPending when pending messages have obligationStatus 'pending'", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      const status = thoughts.deriveInnerDialogStatus(
        [{
          from: "testagent",
          content: "think about penguins",
          timestamp: 1,
          delegatedFrom: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
          obligationStatus: "pending",
        }],
        [],
      )
      expect(status.obligationPending).toBe(true)
    })

    it("does not set origin or obligationPending when pending messages lack delegatedFrom", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      const status = thoughts.deriveInnerDialogStatus(
        [{ from: "testagent", content: "plain thought", timestamp: 1 }],
        [],
      )
      expect(status.origin).toBeUndefined()
      expect(status.obligationPending).toBeUndefined()
    })

    it("renders origin info in formatInnerDialogStatus", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      const formatted = thoughts.formatInnerDialogStatus({
        queue: "queued to inner/dialog",
        wake: "awaiting inner session",
        processing: "pending",
        surfaced: "nothing yet",
        origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
        contentSnippet: "think about penguins",
        obligationPending: true,
      })
      expect(formatted).toContain("origin: friend-1/bluebubbles/chat")
      expect(formatted).toContain("think about penguins")
      expect(formatted).toContain("obligation: pending")
    })

    it("omits origin line from formatInnerDialogStatus when origin is absent", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")

      const formatted = thoughts.formatInnerDialogStatus({
        queue: "clear",
        wake: "idle",
        processing: "idle",
        surfaced: "nothing recent",
      })
      expect(formatted).not.toContain("origin:")
      expect(formatted).not.toContain("obligation:")
    })

    it("accepts lastCompletedAt when runtime metadata is otherwise idle", async () => {
      const thoughts = await import("../../../heart/daemon/thoughts")
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thoughts-runtime-"))
      const sessionPath = path.join(dir, "dialog.json")
      const pendingDir = path.join(dir, "pending")
      const runtimePath = path.join(dir, "runtime.json")

      fs.mkdirSync(pendingDir, { recursive: true })
      fs.writeFileSync(sessionPath, JSON.stringify({ version: 1, messages: [] }))
      fs.writeFileSync(runtimePath, JSON.stringify({
        status: "idle",
        lastCompletedAt: "2026-03-12T00:00:00.000Z",
      }))

      expect(thoughts.readInnerDialogStatus(sessionPath, pendingDir, runtimePath)).toEqual({
        queue: "clear",
        wake: "idle",
        processing: "idle",
        surfaced: "nothing recent",
      })

      fs.rmSync(dir, { recursive: true, force: true })
    })
  })
})
