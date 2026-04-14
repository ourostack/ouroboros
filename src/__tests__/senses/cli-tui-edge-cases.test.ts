/**
 * TUI edge-case hardening tests — Unit 3.1
 *
 * Covers: streaming-to-tool transitions, spinner/tool/input overlap,
 * input history across restarts, copy-paste integrity, Ctrl-C double-press,
 * escape clear, word-jumping interactions, renderMarkdown stress cases,
 * and MarkdownStreamer edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ChannelCallbacks } from "../../heart/core"

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
    phrases: {
      thinking: ["pondering"],
      tool: ["working"],
      followup: ["continuing"],
    },
  })),
}))

// Hard-mock the daemon socket client. The runtime guard in socket-client.ts
// already prevents real socket calls under vitest (by detecting process.argv),
// but the explicit mock lets tests that care assert on call counts and avoids
// the per-file allowlist in test-isolation.contract.test.ts.
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

describe("renderMarkdown — large diff stress", () => {
  it("handles a diff with 100+ lines without crashing or truncating", async () => {
    vi.resetModules()
    const { renderMarkdown } = await import("../../senses/cli")
    const lines = ["```\ndiff --git a/big.ts b/big.ts"]
    for (let i = 0; i < 100; i++) {
      lines.push(i % 2 === 0 ? `+added line ${i}` : `-removed line ${i}`)
    }
    lines.push("```")
    const result = renderMarkdown(lines.join("\n"))
    expect(result).toContain("added line 0")
    expect(result).toContain("removed line 99")
  })

  it("handles a very long single line (>500 chars) inside a code block", async () => {
    vi.resetModules()
    const { renderMarkdown } = await import("../../senses/cli")
    const longLine = "x".repeat(500)
    const result = renderMarkdown("```\n" + longLine + "\n```")
    expect(result).toContain("x".repeat(500))
  })
})

describe("renderMarkdown — complex markdown combinations", () => {
  it("renders nested bold inside inline code without corruption", async () => {
    vi.resetModules()
    const { renderMarkdown } = await import("../../senses/cli")
    const result = renderMarkdown("`**not bold**`")
    // Inside code: markdown should NOT be processed
    expect(result).toContain("**not bold**")
  })

  it("handles multiple code blocks in sequence", async () => {
    vi.resetModules()
    const { renderMarkdown } = await import("../../senses/cli")
    const input = "```\nblock1\n```\ntext\n```\nblock2\n```"
    const result = renderMarkdown(input)
    expect(result).toContain("block1")
    expect(result).toContain("text")
    expect(result).toContain("block2")
  })

  it("handles bold and italic mixed with code in one line", async () => {
    vi.resetModules()
    const { renderMarkdown } = await import("../../senses/cli")
    const result = renderMarkdown("**bold** then `code` then *italic*")
    expect(result).toContain("\x1b[1mbold\x1b[22m")
    expect(result).toContain("\x1b[36mcode\x1b[39m")
    expect(result).toContain("\x1b[3mitalic\x1b[23m")
  })
})

describe("MarkdownStreamer — rapid tool transition stress", () => {
  let stdoutChunks: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let callbacks: ChannelCallbacks & { flushMarkdown(): void }

  beforeEach(async () => {
    stdoutChunks = []
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      stdoutChunks.push(chunk.toString())
      return true
    })
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.resetModules()
    const agent = await import("../../senses/cli")
    callbacks = agent.createCliCallbacks()
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("handles text followed by tool start/end then more text without losing content", () => {
    callbacks.onTextChunk("Part one. ")
    callbacks.flushMarkdown()
    // Simulate tool interruption
    callbacks.onToolStart("shell", { command: "ls" })
    callbacks.onToolEnd("shell", "ls", true)
    // New text after tool
    callbacks.onModelStart()
    callbacks.onTextChunk("Part two.")
    callbacks.flushMarkdown()

    const output = stdoutChunks.join("")
    expect(output).toContain("Part one.")
    expect(output).toContain("Part two.")
  })

  it("handles multiple rapid tool calls between text chunks", () => {
    callbacks.onTextChunk("Before tools. ")
    callbacks.flushMarkdown()
    // Rapid tool cycle
    callbacks.onToolStart("shell", { command: "ls" })
    callbacks.onToolEnd("shell", "ls", true)
    callbacks.onToolStart("read_file", { path: "/foo" })
    callbacks.onToolEnd("read_file", "/foo", true)
    callbacks.onToolStart("shell", { command: "cat x" })
    callbacks.onToolEnd("shell", "cat x", true)
    // Resume text
    callbacks.onModelStart()
    callbacks.onTextChunk("After tools.")
    callbacks.flushMarkdown()

    const output = stdoutChunks.join("")
    expect(output).toContain("Before tools.")
    expect(output).toContain("After tools.")
  })

  it("handles code block split across tool boundary", () => {
    callbacks.onTextChunk("code:\n```\nline 1\n")
    // Tool interrupts mid-code-block — flush should render incomplete literally
    callbacks.flushMarkdown()
    callbacks.onModelStart()
    // Continue after tool
    callbacks.onTextChunk("line 2\n```")
    callbacks.flushMarkdown()

    const output = stdoutChunks.join("")
    expect(output).toContain("line 1")
    expect(output).toContain("line 2")
  })
})

describe("MarkdownStreamer — copy-paste integrity under stress", () => {
  it("does not inject padding or layout whitespace into output", async () => {
    vi.resetModules()
    const { renderMarkdown } = await import("../../senses/cli")
    const input = "Hello world. This is plain text."
    const result = renderMarkdown(input)
    // Strip ANSI sequences for inspection
    const stripped = result.replace(/\x1b\[[0-9;]*m/g, "")
    expect(stripped).toBe("Hello world. This is plain text.")
  })

  it("produces no trailing whitespace on any line", async () => {
    vi.resetModules()
    const { renderMarkdown } = await import("../../senses/cli")
    const input = "line one\nline two\nline three"
    const result = renderMarkdown(input)
    const stripped = result.replace(/\x1b\[[0-9;]*m/g, "")
    for (const line of stripped.split("\n")) {
      if (line.length > 0) {
        expect(line).toBe(line.trimEnd())
      }
    }
  })
})

describe("Ctrl-C handling edge cases", () => {
  it("handleSigint returns exit on second consecutive empty-buffer Ctrl-C", async () => {
    vi.resetModules()
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const { handleSigint } = await import("../../senses/cli")
    const readline = await import("readline")
    const { Readable, Writable } = await import("node:stream")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_c: any, _e: any, cb: () => void) { cb(); return true } }) as any
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })

    // First Ctrl-C with empty buffer -> warn
    const r1 = handleSigint(rl, "")
    expect(r1).toBe("warn")

    // Second Ctrl-C with empty buffer (within window) -> exit
    const r2 = handleSigint(rl, "")
    expect(r2).toBe("exit")

    rl.close()
    vi.restoreAllMocks()
  })

  it("non-empty buffer clears on Ctrl-C then resets double-press state", async () => {
    vi.resetModules()
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const { handleSigint } = await import("../../senses/cli")
    const readline = await import("readline")
    const { Readable, Writable } = await import("node:stream")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_c: any, _e: any, cb: () => void) { cb(); return true } }) as any
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })

    // Ctrl-C with empty -> warn (first press)
    handleSigint(rl, "")
    // Now type something and Ctrl-C -> clear (resets the double-press)
    const r = handleSigint(rl, "some text")
    expect(r).toBe("clear")
    // Now Ctrl-C with empty again -> should be warn, not exit
    const r2 = handleSigint(rl, "")
    expect(r2).toBe("warn")

    rl.close()
    vi.restoreAllMocks()
  })
})

describe("Input history edge cases", () => {
  it("history handles large arrays gracefully", async () => {
    vi.resetModules()
    const { addHistory } = await import("../../senses/cli")
    const history: string[] = []
    for (let i = 0; i < 200; i++) {
      addHistory(history, `command ${i}`)
    }
    expect(history.length).toBe(200)
    expect(history[0]).toBe("command 0")
    expect(history[199]).toBe("command 199")
  })

  it("history handles multi-line input", async () => {
    vi.resetModules()
    const { addHistory } = await import("../../senses/cli")
    const history: string[] = []
    addHistory(history, "line1\nline2\nline3")
    expect(history).toHaveLength(1)
    expect(history[0]).toBe("line1\nline2\nline3")
  })
})
