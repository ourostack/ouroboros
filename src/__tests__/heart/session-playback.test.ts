import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { formatPlaybackReport, runSessionPlayback } from "../../heart/session-playback"
import { runSessionPlaybackCli } from "../../heart/session-playback-cli"

const tempFiles: string[] = []

function tempFile(content: unknown): string {
  const file = path.join(os.tmpdir(), `ouro-session-playback-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(file, JSON.stringify(content))
  tempFiles.push(file)
  return file
}

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    try { fs.unlinkSync(file) } catch { /* ignore */ }
  }
})

describe("runSessionPlayback", () => {
  it("reports zero changes for a clean legacy envelope", () => {
    const sessionPath = tempFile({
      version: 1,
      messages: [
        { role: "system", content: "you are a helpful agent" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    })
    const report = runSessionPlayback({ sessionPath })
    expect(report.envelopeShape).toBe("legacy")
    expect(report.totals).toEqual({ dropped: 0, modifiedContent: 0, syntheticAdded: 0 })
  })

  it("flags inline <think> reasoning that the sanitize pass would strip", () => {
    const sessionPath = tempFile({
      version: 1,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "do thing" },
        {
          role: "assistant",
          content: "<think>let me think about this</think>ok done",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "noop", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
    })
    const report = runSessionPlayback({ sessionPath })
    const modified = report.changes.find((change) => change.action === "modified-content")
    expect(modified).toBeDefined()
    expect(modified?.preview).toContain("<think>")
    expect(report.totals.modifiedContent).toBe(1)
  })

  it("flags an orphan tool result whose preceding assistant has no matching tool_call", () => {
    const sessionPath = tempFile({
      version: 1,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "do thing" },
        { role: "tool", tool_call_id: "call_orphan", content: "stale result" },
      ],
    })
    const report = runSessionPlayback({ sessionPath })
    const dropped = report.changes.find((change) => change.action === "dropped")
    expect(dropped).toBeDefined()
    expect(dropped?.toolCallId).toBe("call_orphan")
    expect(report.totals.dropped).toBe(1)
  })

  it("returns 'unknown' shape for an unrecognized envelope", () => {
    const sessionPath = tempFile({ this_is_not_a_session: true })
    const report = runSessionPlayback({ sessionPath })
    expect(report.envelopeShape).toBe("unknown")
    expect(report.inputMessageCount).toBe(0)
  })

  it("formats a human-readable report with changes", () => {
    const report = runSessionPlayback({
      sessionPath: "fake/path",
      raw: {
        version: 1,
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "<think>hmm</think>ok" },
        ],
      },
    })
    const formatted = formatPlaybackReport(report)
    expect(formatted).toContain("Session playback: fake/path")
    expect(formatted).toContain("modified-content")
  })
})

describe("runSessionPlaybackCli", () => {
  it("prints help and exits 0 when --help is passed alongside a path", () => {
    const sessionPath = tempFile({ version: 1, messages: [] })
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
    try {
      const code = runSessionPlaybackCli([sessionPath, "--help"])
      expect(code).toBe(0)
      expect(logs.join("\n")).toContain("usage: ouro session-playback")
    } finally {
      console.log = original
    }
  })

  it("prints help when called with no args and exits with code 2", () => {
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
    try {
      const code = runSessionPlaybackCli([])
      expect(code).toBe(2)
      expect(logs.join("\n")).toContain("usage: ouro session-playback")
    } finally {
      console.log = original
    }
  })

  it("prints --json output when requested", () => {
    const sessionPath = tempFile({
      version: 1,
      messages: [{ role: "user", content: "hi" }],
    })
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
    try {
      const code = runSessionPlaybackCli([sessionPath, "--json"])
      expect(code).toBe(0)
      const parsed = JSON.parse(logs.join("\n"))
      expect(parsed.envelopeShape).toBe("legacy")
      expect(parsed.inputMessageCount).toBe(1)
    } finally {
      console.log = original
    }
  })

  it("prints the human-readable report by default and reports zero changes", () => {
    const sessionPath = tempFile({
      version: 1,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    })
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
    try {
      const code = runSessionPlaybackCli([sessionPath])
      expect(code).toBe(0)
      const output = logs.join("\n")
      expect(output).toContain("Session playback:")
      expect(output).toContain("no repairs would apply.")
    } finally {
      console.log = original
    }
  })
})
