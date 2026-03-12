import { describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

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
        { role: "user", content: "...time passing. anything stirring?\n\nlast i remember: all looks good." },
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
            { id: "tc_1", type: "function", function: { name: "memory_search", arguments: "{}" } },
            { id: "tc_2", type: "function", function: { name: "shell", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "tc_1", content: "results" },
        { role: "tool", tool_call_id: "tc_2", content: "ok" },
        { role: "assistant", content: "found something interesting." },
      ])

      const turns = parseInnerDialogSession(sessionPath)

      expect(turns).toHaveLength(1)
      expect(turns[0].tools).toEqual(["memory_search", "shell"])
      expect(turns[0].response).toBe("found something interesting.")
    })

    it("extracts response from final_answer tool call when content is null", () => {
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
            { id: "tc_2", type: "function", function: { name: "final_answer", arguments: "{\"answer\":\"checked the files. all good.\"}" } },
          ],
        },
      ])

      const turns = parseInnerDialogSession(sessionPath)

      expect(turns).toHaveLength(1)
      expect(turns[0].response).toBe("checked the files. all good.")
      expect(turns[0].tools).toEqual(["shell"])
    })

    it("excludes final_answer from tool names list", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "memory_search", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "tc_1", content: "results" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_2", type: "function", function: { name: "final_answer", arguments: "{\"answer\":\"done\"}" } },
          ],
        },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].tools).toEqual(["memory_search"])
      expect(turns[0].tools).not.toContain("final_answer")
    })

    it("extracts final_answer when mixed with other tool calls in same message", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "memory_save", arguments: "{}" } },
            { id: "tc_2", type: "function", function: { name: "final_answer", arguments: "{\"answer\":\"saved and done.\"}" } },
          ],
        },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].response).toBe("saved and done.")
      expect(turns[0].tools).toEqual(["memory_save"])
    })

    it("handles final_answer with malformed arguments", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "final_answer", arguments: "not json" } },
          ],
        },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].response).toBe("")
    })

    it("handles final_answer with missing arguments field", () => {
      const sessionPath = tmpSessionFile([
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "final_answer" } },
          ],
        },
      ])

      const turns = parseInnerDialogSession(sessionPath)
      expect(turns[0].response).toBe("")
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
        { type: "heartbeat", prompt: "anything?", response: "nothing new.", tools: ["memory_search"] },
      ], 10)

      expect(output).toContain("--- boot ---")
      expect(output).toContain("checking in.")
      expect(output).toContain("--- heartbeat ---")
      expect(output).toContain("tools: memory_search")
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
    it("calls onNewTurns when session file is updated with new turns", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-test-"))
      const sessionPath = path.join(dir, "dialog.json")

      // Start with one turn
      fs.writeFileSync(sessionPath, JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "waking up.\n\nwhat needs my attention?" },
          { role: "assistant", content: "first thought." },
        ],
      }))

      const received: string[] = []
      const stop = followThoughts(sessionPath, (formatted) => {
        received.push(formatted)
      }, 100)

      // Add a second turn
      fs.writeFileSync(sessionPath, JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "waking up.\n\nwhat needs my attention?" },
          { role: "assistant", content: "first thought." },
          { role: "user", content: "...time passing. anything stirring?" },
          { role: "assistant", content: "second thought." },
        ],
      }))

      // Wait for poll to detect the change
      await new Promise((resolve) => setTimeout(resolve, 300))

      stop()
      expect(received.length).toBeGreaterThanOrEqual(1)
      expect(received[0]).toContain("second thought.")
      expect(received[0]).not.toContain("first thought.")

      fs.rmSync(dir, { recursive: true, force: true })
    })

    it("does not call onNewTurns when turn count stays the same", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-test-"))
      const sessionPath = path.join(dir, "dialog.json")

      const data = JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "waking up.\n\nwhat needs my attention?" },
          { role: "assistant", content: "same thought." },
        ],
      })
      fs.writeFileSync(sessionPath, data)

      const received: string[] = []
      const stop = followThoughts(sessionPath, (formatted) => {
        received.push(formatted)
      }, 100)

      // Touch the file without adding turns
      fs.writeFileSync(sessionPath, data)

      await new Promise((resolve) => setTimeout(resolve, 300))

      stop()
      expect(received).toHaveLength(0)

      fs.rmSync(dir, { recursive: true, force: true })
    })

    it("returns cleanup function that stops watching", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-test-"))
      const sessionPath = path.join(dir, "dialog.json")

      fs.writeFileSync(sessionPath, JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "waking up.\n\nwhat needs my attention?" },
          { role: "assistant", content: "initial." },
        ],
      }))

      const received: string[] = []
      const stop = followThoughts(sessionPath, (formatted) => {
        received.push(formatted)
      }, 100)

      // Stop immediately
      stop()

      // Add a new turn after stopping
      fs.writeFileSync(sessionPath, JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "waking up.\n\nwhat needs my attention?" },
          { role: "assistant", content: "initial." },
          { role: "user", content: "...time passing. anything stirring?" },
          { role: "assistant", content: "should not appear." },
        ],
      }))

      await new Promise((resolve) => setTimeout(resolve, 300))

      expect(received).toHaveLength(0)

      fs.rmSync(dir, { recursive: true, force: true })
    })
  })
})
