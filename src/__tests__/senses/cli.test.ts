import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ChannelCallbacks } from "../../heart/core"

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
    phrases: {
      thinking: ["test thinking"],
      tool: ["test tool"],
      followup: ["test followup"],
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

import { getPhrases } from "../../mind/phrases"

describe("CLI adapter - createCliCallbacks", () => {
  let stdoutChunks: string[]
  let stderrChunks: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutChunks = []
    stderrChunks = []
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      stdoutChunks.push(chunk.toString())
      return true
    })
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("is exported from agent.ts", async () => {
    const agent = await import("../../senses/cli")
    expect(typeof agent.createCliCallbacks).toBe("function")
  })

  it("returns an object implementing ChannelCallbacks", async () => {
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()
    expect(typeof callbacks.onModelStart).toBe("function")
    expect(typeof callbacks.onModelStreamStart).toBe("function")
    expect(typeof callbacks.onTextChunk).toBe("function")
    expect(typeof callbacks.onToolStart).toBe("function")
    expect(typeof callbacks.onToolEnd).toBe("function")
    expect(typeof callbacks.onError).toBe("function")
  })

  it("exposes flushNow as a function (for the `speak` tool)", async () => {
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()
    expect(typeof callbacks.flushNow).toBe("function")
  })

  it("flushNow after onTextChunk does not throw and writes nothing additional", async () => {
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()
    callbacks.onTextChunk("hello")
    const writesBefore = stdoutChunks.length
    expect(() => callbacks.flushNow!()).not.toThrow()
    // CLI flushes on every onTextChunk (via streamer/wrapper) — flushNow is a noop
    expect(stdoutChunks.length).toBe(writesBefore)
  })
})

describe("CLI adapter - continuity ingress texts", () => {
  it("returns the trimmed user input as the raw continuity ingress text", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    expect((agent as any).getCliContinuityIngressTexts("  hey can you check this  ")).toEqual(["hey can you check this"])
  })

  it("drops empty CLI input from continuity ingress text", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    expect((agent as any).getCliContinuityIngressTexts("   ")).toEqual([])
  })
})

describe("CLI adapter - renderMarkdown", () => {
  it("renders **bold** as ANSI bold", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    expect(agent.renderMarkdown("hello **world**")).toBe("hello \x1b[1mworld\x1b[22m")
  })

  it("renders *italic* as ANSI italic", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    expect(agent.renderMarkdown("hello *world*")).toBe("hello \x1b[3mworld\x1b[23m")
  })

  it("renders `code` as ANSI cyan", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    expect(agent.renderMarkdown("use `npm install`")).toBe("use \x1b[36mnpm install\x1b[39m")
  })

  it("renders code blocks as ANSI dim", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    const input = "code:\n```\nconst x = 1\n```"
    const expected = "code:\n\x1b[2mconst x = 1\x1b[22m"
    expect(agent.renderMarkdown(input)).toBe(expected)
  })

  it("passes plain text through unchanged", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    expect(agent.renderMarkdown("no markdown here")).toBe("no markdown here")
  })

  it("does not render markdown inside code blocks", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    const input = "```\n**not bold**\n```"
    const expected = "\x1b[2m**not bold**\x1b[22m"
    expect(agent.renderMarkdown(input)).toBe(expected)
  })

  it("does not render markdown inside inline code", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    expect(agent.renderMarkdown("`**not bold**`")).toBe("\x1b[36m**not bold**\x1b[39m")
  })

  it("handles bold and italic together", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    expect(agent.renderMarkdown("**bold** and *italic*")).toBe(
      "\x1b[1mbold\x1b[22m and \x1b[3mitalic\x1b[23m"
    )
  })

  it("handles code blocks with language specifier", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    const input = "```ts\nconst x = 1\n```"
    const expected = "\x1b[2mconst x = 1\x1b[22m"
    expect(agent.renderMarkdown(input)).toBe(expected)
  })
})

describe("CLI adapter - MarkdownStreamer", () => {
  let MarkdownStreamer: typeof import("../../senses/cli").MarkdownStreamer

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../senses/cli")
    MarkdownStreamer = mod.MarkdownStreamer
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("passes plain text through immediately", () => {
    const s = new MarkdownStreamer()
    expect(s.push("hello world")).toBe("hello world")
  })

  it("buffers bold marker split across chunks", () => {
    const s = new MarkdownStreamer()
    const out1 = s.push("hello **")
    // "hello " is flushed, "**" opens bold buffering
    expect(out1).toBe("hello ")
    const out2 = s.push("bold")
    // still inside bold, nothing flushed
    expect(out2).toBe("")
    const out3 = s.push("** rest")
    // bold closes, rest flushed
    expect(out3).toContain("\x1b[1mbold\x1b[22m")
    expect(out3).toContain(" rest")
  })

  it("buffers inline code split across chunks", () => {
    const s = new MarkdownStreamer()
    const out1 = s.push("use `")
    expect(out1).toBe("use ")
    const out2 = s.push("npm install")
    expect(out2).toBe("")
    const out3 = s.push("` ok")
    expect(out3).toContain("\x1b[36mnpm install\x1b[39m")
    expect(out3).toContain(" ok")
  })

  it("buffers code block split across chunks", () => {
    const s = new MarkdownStreamer()
    const out1 = s.push("code:\n```")
    expect(out1).toBe("code:\n")
    const out2 = s.push("\nconst x = 1\n")
    expect(out2).toBe("")
    const out3 = s.push("``` done")
    expect(out3).toContain("\x1b[2m")
    expect(out3).toContain("const x = 1")
    expect(out3).toContain(" done")
  })

  it("holds back partial marker at end of chunk", () => {
    const s = new MarkdownStreamer()
    // single * at end could be start of ** or italic
    const out1 = s.push("hello *")
    expect(out1).toBe("hello ")
    // next chunk completes **
    const out2 = s.push("*bold**")
    expect(out2).toContain("\x1b[1mbold\x1b[22m")
  })

  it("holds back single backtick at end of chunk", () => {
    const s = new MarkdownStreamer()
    const out1 = s.push("use `")
    expect(out1).toBe("use ")
    const out2 = s.push("cmd` ok")
    expect(out2).toContain("\x1b[36mcmd\x1b[39m")
    expect(out2).toContain(" ok")
  })

  it("holds back double backtick at end of chunk (prefix of ```)", () => {
    const s = new MarkdownStreamer()
    const out1 = s.push("code: ``")
    // "code: " flushed, "``" held back (prefix of ```)
    expect(out1).toBe("code: ")
    const out2 = s.push("`\nconst x = 1\n```")
    expect(out2).toContain("\x1b[2m")
    expect(out2).toContain("const x = 1")
  })

  it("flush renders remaining buffer literally on stream end", () => {
    const s = new MarkdownStreamer()
    s.push("unclosed **bold")
    const out = s.flush()
    // Should render the raw ** and text literally (no ANSI bold)
    expect(out).toContain("**bold")
  })

  it("flush renders incomplete inline code literally", () => {
    const s = new MarkdownStreamer()
    s.push("unclosed `code")
    const out = s.flush()
    expect(out).toContain("`code")
  })

  it("reset clears buffer state", () => {
    const s = new MarkdownStreamer()
    s.push("**open")
    s.reset()
    expect(s.push("plain")).toBe("plain")
  })

  it("handles complete markdown in single chunk", () => {
    const s = new MarkdownStreamer()
    const out = s.push("**bold** and `code`")
    expect(out).toContain("\x1b[1mbold\x1b[22m")
    expect(out).toContain("\x1b[36mcode\x1b[39m")
  })

  it("handles italic split across chunks", () => {
    const s = new MarkdownStreamer()
    const out1 = s.push("hello *")
    expect(out1).toBe("hello ")
    // next chunk doesn't start with *, so it's italic
    const out2 = s.push("italic* rest")
    expect(out2).toContain("\x1b[3mitalic\x1b[23m")
    expect(out2).toContain(" rest")
  })

  it("handles multiple sequential markers", () => {
    const s = new MarkdownStreamer()
    const out = s.push("**a** then `b`")
    expect(out).toContain("\x1b[1ma\x1b[22m")
    expect(out).toContain("\x1b[36mb\x1b[39m")
  })

  it("holds back lone marker prefix that could start a longer marker", () => {
    const s = new MarkdownStreamer()
    // Buffer is just "*" — could be start of "**"
    const out1 = s.push("*")
    expect(out1).toBe("")
    const out2 = s.push("*bold**")
    expect(out2).toContain("\x1b[1mbold\x1b[22m")
  })

  it("consecutive pushes without markers accumulate nothing", () => {
    const s = new MarkdownStreamer()
    expect(s.push("hello ")).toBe("hello ")
    expect(s.push("world")).toBe("world")
    expect(s.flush()).toBe("")
  })
})

describe("CLI adapter - streaming onTextChunk with MarkdownStreamer", () => {
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

  it("bold split across two chunks renders correctly after flush", () => {
    callbacks.onTextChunk("hello **")
    callbacks.onTextChunk("world**")
    callbacks.flushMarkdown()
    const output = stdoutChunks.join("")
    expect(output).toContain("hello ")
    expect(output).toContain("\x1b[1mworld\x1b[22m")
  })

  it("inline code split across chunks renders correctly", () => {
    callbacks.onTextChunk("use `")
    callbacks.onTextChunk("npm install")
    callbacks.onTextChunk("` now")
    callbacks.flushMarkdown()
    const output = stdoutChunks.join("")
    expect(output).toContain("\x1b[36mnpm install\x1b[39m")
  })

  it("complete markdown in single chunk renders immediately", () => {
    callbacks.onTextChunk("**bold** text")
    callbacks.flushMarkdown()
    const output = stdoutChunks.join("")
    expect(output).toContain("\x1b[1mbold\x1b[22m")
    expect(output).toContain(" text")
  })

  it("flushMarkdown renders incomplete markers literally", () => {
    callbacks.onTextChunk("unclosed **bold")
    callbacks.flushMarkdown()
    const output = stdoutChunks.join("")
    expect(output).toContain("**bold")
  })

  it("onModelStart resets streamer state", () => {
    callbacks.onTextChunk("**open")
    callbacks.onModelStart()
    callbacks.onTextChunk("plain text")
    callbacks.flushMarkdown()
    const output = stdoutChunks.join("")
    expect(output).toBe("plain text")
  })
})

describe("CLI adapter - onReasoningChunk and onTextChunk rendering", () => {
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

  it("onTextChunk streams text to stdout (flushed via wrapper)", () => {
    callbacks.onTextChunk("hello world")
    callbacks.flushMarkdown()
    expect(stdoutChunks.join("")).toBe("hello world")
  })

  it("onTextChunk applies markdown rendering", () => {
    callbacks.onTextChunk("hello **world**")
    callbacks.flushMarkdown()
    expect(stdoutChunks.join("")).toBe("hello \x1b[1mworld\x1b[22m")
  })

  it("onReasoningChunk keeps reasoning private", () => {
    callbacks.onReasoningChunk("reasoning")
    expect(stdoutChunks.join("")).toBe("")
  })

  it("reasoning then content streams only the answer text", () => {
    callbacks.onReasoningChunk("thinking")
    callbacks.onTextChunk("answer")
    callbacks.flushMarkdown()
    expect(stdoutChunks.join("")).toBe("answer")
  })

  it("text-only response has no reasoning separator", () => {
    callbacks.onTextChunk("just text")
    callbacks.flushMarkdown()
    const output = stdoutChunks.join("")
    expect(output).toBe("just text")
  })

  it("multiple reasoning chunks remain hidden before text", () => {
    callbacks.onReasoningChunk("step1")
    callbacks.onReasoningChunk("step2")
    callbacks.onTextChunk("answer")
    callbacks.flushMarkdown()
    expect(stdoutChunks.join("")).toBe("answer")
  })

  it("onModelStart resets reasoning state for new turn", () => {
    callbacks.onReasoningChunk("thinking")
    callbacks.onModelStart()
    stdoutChunks.length = 0
    callbacks.onTextChunk("answer")
    callbacks.flushMarkdown()
    const output = stdoutChunks.join("")
    expect(output).toBe("answer")
    expect(output).not.toContain("\n\n")
  })

  it("multiple reasoning chunks stay private", () => {
    callbacks.onReasoningChunk("chunk1")
    callbacks.onReasoningChunk("chunk2")
    expect(stdoutChunks.join("")).toBe("")
  })

  it("content-only: no dim codes on stdout", () => {
    callbacks.onTextChunk("just text")
    callbacks.flushMarkdown()
    const output = stdoutChunks.join("")
    expect(output).toBe("just text")
    expect(output).not.toContain("\x1b[2m")
  })
})

describe("CLI adapter - onModelStart", () => {
  it("starts spinner on stderr", async () => {
    const stderrChunks: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onModelStart()
    // Spinner writes to stderr
    expect(stderrChunks.length).toBeGreaterThan(0)

    // Clean up spinner interval
    callbacks.flushMarkdown()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })
})

describe("CLI adapter - onModelStreamStart", () => {
  it("is a no-op (content callbacks handle spinner stopping)", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onModelStart()
    stderrChunks.length = 0
    callbacks.onModelStreamStart()
    // onModelStreamStart is a no-op — spinner is NOT stopped here
    const output = stderrChunks.join("")
    expect(output).not.toContain("\x1b[K")

    // onTextChunk stops the spinner instead
    stderrChunks.length = 0
    callbacks.onTextChunk("hello")
    const afterText = stderrChunks.join("")
    expect(afterText).toContain("\x1b[K")

    callbacks.flushMarkdown()
    vi.restoreAllMocks()
  })

  it("handles stop without prior start (no interval to clear)", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")

    // Directly test Spinner.stop() without start() — covers the this.iv === null branch
    const s = new agent.Spinner("test")
    expect(() => s.stop()).not.toThrow()

    vi.restoreAllMocks()
  })

  it("interval callback fires and advances spinner frame", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")

    // Start spinner and let the setInterval callback fire
    const s = new agent.Spinner("test")
    s.start()
    await new Promise((r) => setTimeout(r, 100))
    s.stop()

    vi.restoreAllMocks()
  })

  it("stop with success message writes green check output", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")

    const s = new agent.Spinner("test")
    s.stop("done")

    const output = stderrChunks.join("")
    expect(output).toContain("\u2713")
    expect(output).toContain("done")

    vi.restoreAllMocks()
  })
})

describe("CLI adapter - onToolStart", () => {
  it("starts a spinner with a phrase from TOOL_PHRASES", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onToolStart("read_file", { path: "/tmp/test.txt" })
    const output = stderrChunks.join("")
    expect(getPhrases().tool.some(p => output.includes(p))).toBe(true)

    // Clean up
    callbacks.onToolEnd("read_file", "/tmp/test.txt", true)
    vi.restoreAllMocks()
  })

  it("emits newline before spinner when text was streamed without trailing newline", async () => {
    const stdoutChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onModelStart()
    callbacks.onTextChunk("some text")
    callbacks.flushMarkdown()
    stdoutChunks.length = 0
    callbacks.onToolStart("read_file", { path: "x" })
    // Should have emitted a \n to avoid spinner clobbering text
    expect(stdoutChunks.join("")).toContain("\n")

    callbacks.onToolEnd("read_file", "x", true)
    vi.restoreAllMocks()
  })
})

describe("CLI adapter - speak is invisible (flow-control)", () => {
  it("onToolStart('speak', ...) does NOT start a spinner — no phrase rotation, no tool spinner text", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onToolStart("speak", { message: "hello friend" })
    const output = stderrChunks.join("")

    // No tool-spinner phrase should be written (those would be the "running..." style phrases)
    for (const phrase of getPhrases().tool) {
      expect(output).not.toContain(phrase)
    }

    callbacks.onToolEnd("speak", "message=hello friend", true)
    vi.restoreAllMocks()
  })

  it("onToolEnd('speak', ...) writes nothing to stderr (flow-control tools are invisible)", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    // Reset chunks so we only capture writes from onToolEnd
    stderrChunks.length = 0
    callbacks.onToolEnd("speak", "message=hi", true)
    const output = stderrChunks.join("")

    // No green check, no red cross, no "speak" word for the result line
    expect(output).not.toContain("✓")
    expect(output).not.toContain("✗")
    expect(output).not.toContain("speak")

    vi.restoreAllMocks()
  })
})

describe("CLI tool-display flow control", () => {
  it("FLOW_CONTROL_TOOLS includes 'speak' so writeToolStart/writeToolEnd skip it", async () => {
    const toolDisplay = await import("../../senses/cli/tool-display")
    // Reach into the module — both writers should noop for speak
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })

    toolDisplay.writeToolStart("speak", { message: "hello" })
    toolDisplay.writeToolEnd("speak", "message=hello", true)
    expect(stderrChunks.join("")).toBe("")

    vi.restoreAllMocks()
  })
})

describe("CLI adapter - onToolEnd", () => {
  it("writes green formatted tool result on success", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onToolStart("read_file", { path: "/tmp/test.txt" })
    callbacks.onToolEnd("read_file", "/tmp/test.txt", true)
    const output = stderrChunks.join("")
    // Uses shared formatter: "checkmark read_file /tmp/test.txt"
    expect(output).toContain("\u2713")
    expect(output).toContain("read_file")
    expect(output).toContain("/tmp/test.txt")
    // Green ANSI
    expect(output).toContain("\x1b[32m")

    vi.restoreAllMocks()
  })

  it("writes red formatted tool result on failure", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onToolStart("read_file", { path: "/tmp/test.txt" })
    callbacks.onToolEnd("read_file", "/tmp/test.txt", false)
    const output = stderrChunks.join("")
    // Uses shared formatter: "cross read_file /tmp/test.txt"
    expect(output).toContain("\u2717")
    expect(output).toContain("read_file")
    expect(output).toContain("/tmp/test.txt")
    // Red ANSI
    expect(output).toContain("\x1b[31m")

    vi.restoreAllMocks()
  })

  it("handles empty argSummary without extra formatting", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onToolStart("get_current_time", {})
    callbacks.onToolEnd("get_current_time", "", true)
    const output = stderrChunks.join("")
    // Uses shared formatter: "checkmark get_current_time" (no parens for empty summary)
    expect(output).toContain("\u2713")
    expect(output).toContain("get_current_time")
    expect(output).not.toContain("()")

    vi.restoreAllMocks()
  })

  it("keeps stderr output channel-native and emits structured channel events", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onToolEnd("read_file", "/tmp/test.txt", true)

    expect(stderrChunks.join("")).toContain("\u2713")
    expect(stderrChunks.join("")).toContain("read_file")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.tool_display",
      component: "senses",
    }))

    vi.restoreAllMocks()
  })
})

describe("CLI adapter - onError", () => {
  it("writes terminal error to stderr with red ANSI", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onError(new Error("connection failed"), "terminal")
    const output = stderrChunks.join("")
    expect(output).toContain("Error: connection failed")
    expect(output).toContain("\x1b[31m")

    vi.restoreAllMocks()
  })

  it("shows transient error as ephemeral spinner message", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onModelStart() // start spinner
    stderrChunks.length = 0
    callbacks.onError(new Error("retrying..."), "transient")
    const output = stderrChunks.join("")
    // Transient errors use spinner.fail() which shows the message ephemerally
    expect(output).toContain("retrying...")

    vi.restoreAllMocks()
  })

  it("clears active spinner before showing terminal error", async () => {
    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onModelStart() // start spinner
    stderrChunks.length = 0
    callbacks.onError(new Error("timeout"), "terminal")
    const output = stderrChunks.join("")
    expect(output).toContain("Error: timeout")

    vi.restoreAllMocks()
  })
})

describe("CLI adapter - phrase rotation", () => {
  let stderrChunks: string[]
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrChunks = []
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("onModelStart uses a THINKING_PHRASES phrase", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onModelStart()
    const output = stderrChunks.join("")
    expect(getPhrases().thinking.some(p => output.includes(p))).toBe(true)

    callbacks.flushMarkdown()
  })

  it("onModelStart after tool uses FOLLOWUP_PHRASES", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    // First model call
    callbacks.onModelStart()
    callbacks.onTextChunk("text")
    callbacks.flushMarkdown()
    // Tool run
    callbacks.onToolStart("read_file", { path: "x" })
    callbacks.onToolEnd("read_file", "x", true)
    // Second model call — should use followup phrases
    stderrChunks.length = 0
    callbacks.onModelStart()
    const output = stderrChunks.join("")
    expect(getPhrases().followup.some(p => output.includes(p))).toBe(true)

    callbacks.flushMarkdown()
  })

  it("spinner rotates phrase after 1.5s", async () => {
    vi.useFakeTimers()

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onModelStart()
    const firstOutput = stderrChunks.join("")

    stderrChunks.length = 0
    vi.advanceTimersByTime(1500)
    const secondOutput = stderrChunks.join("")

    // After rotation, output should contain a phrase from the pool
    expect(getPhrases().thinking.some(p => secondOutput.includes(p))).toBe(true)

    callbacks.flushMarkdown()
    vi.useRealTimers()
  })

  it("onTextChunk stops phrase rotation", async () => {
    vi.useFakeTimers()

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onModelStart()
    callbacks.onTextChunk("hello")

    stderrChunks.length = 0
    vi.advanceTimersByTime(3000)
    // No more spinner output after content callback stopped it
    const output = stderrChunks.join("")
    expect(output).toBe("")

    callbacks.flushMarkdown()
    vi.useRealTimers()
  })

  it("onReasoningChunk leaves the thinking spinner running", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    callbacks.onModelStart() // starts spinner
    stderrChunks.length = 0
    callbacks.onReasoningChunk("thinking")
    // Reasoning stays private, so the spinner remains the visible indicator.
    const output = stderrChunks.join("")
    expect(output).toBe("")

    callbacks.flushMarkdown()
  })

  it("onClearText resets the markdown streamer", async () => {
    const localStdout: string[] = []
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      localStdout.push(chunk.toString())
      return true
    })

    vi.resetModules()
    const agent = await import("../../senses/cli")
    const callbacks = agent.createCliCallbacks()

    // Push some text then clear
    callbacks.onTextChunk("partial content")
    callbacks.onClearText?.()
    // Push new text — should not include the old partial
    localStdout.length = 0
    callbacks.onTextChunk("fresh")
    callbacks.flushMarkdown()
    const output = localStdout.join("")
    expect(output).toContain("fresh")
    expect(output).not.toContain("partial")

    vi.restoreAllMocks()
  })
})

describe("createDebouncedLines", () => {
  it("yields every line even with slow consumer (no swallowed input)", async () => {
    vi.resetModules()
    const { createDebouncedLines } = await import("../../senses/cli")

    // Simulate a readline-like async iterator: lines arrive with gaps > debounce
    async function* slowSource() {
      yield "line1"
      await new Promise((r) => setTimeout(r, 200))
      yield "line2"
      await new Promise((r) => setTimeout(r, 200))
      yield "line3"
    }

    const collected: string[] = []
    for await (const input of createDebouncedLines(slowSource(), 50)) {
      collected.push(input)
      // Simulate slow processing (like runAgent taking time)
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(collected).toEqual(["line1", "line2", "line3"])
  })

  it("merges rapid-fire lines into one batch (paste detection)", async () => {
    vi.resetModules()
    const { createDebouncedLines } = await import("../../senses/cli")

    // Lines arrive faster than debounce window
    async function* rapidSource() {
      yield "a"
      yield "b"
      yield "c"
    }

    const collected: string[] = []
    for await (const input of createDebouncedLines(rapidSource(), 50)) {
      collected.push(input)
    }
    expect(collected).toEqual(["a\nb\nc"])
  })

  it("passes through directly with debounceMs=0", async () => {
    vi.resetModules()
    const { createDebouncedLines } = await import("../../senses/cli")

    async function* source() {
      yield "x"
      yield "y"
    }

    const collected: string[] = []
    for await (const input of createDebouncedLines(source(), 0)) {
      collected.push(input)
    }
    expect(collected).toEqual(["x", "y"])
  })
})

describe("StreamingWordWrapper", () => {
  let StreamingWordWrapper: typeof import("../../senses/cli").StreamingWordWrapper

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../senses/cli")
    StreamingWordWrapper = mod.StreamingWordWrapper
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("passes short text through without wrapping", () => {
    const w = new StreamingWordWrapper(40)
    const out = w.push("hello world")
    // Short text stays in buffer until newline or flush
    expect(out).toBe("")
    expect(w.flush()).toBe("hello world")
  })

  it("wraps at word boundary when line exceeds width", () => {
    const w = new StreamingWordWrapper(10)
    const out = w.push("hello world today")
    // "hello world" is 11 chars, wraps before "world" (on 'd' of world, col > 10)
    // then "world today" wraps again
    const full = out + w.flush()
    expect(full).toContain("\n")
    // Should not break "hello" or "world" mid-word
    const lines = full.split("\n")
    expect(lines.every(l => !l.includes("hell\n") && !l.includes("worl\n"))).toBe(true)
  })

  it("preserves explicit newlines", () => {
    const w = new StreamingWordWrapper(80)
    const out = w.push("line one\nline two")
    const full = out + w.flush()
    expect(full).toBe("line one\nline two")
  })

  it("handles character-by-character input", () => {
    const w = new StreamingWordWrapper(10)
    let out = ""
    for (const ch of "hello world foo") {
      out += w.push(ch)
    }
    out += w.flush()
    // "hello world" would wrap: "hello" then "world foo"
    expect(out).toContain("\n")
    // Should break at word boundary
    const lines = out.split("\n")
    expect(lines[0]).toBe("hello")
  })

  it("hard wraps words longer than width", () => {
    const w = new StreamingWordWrapper(5)
    let out = ""
    out += w.push("abcdefghij")
    out += w.flush()
    // 10-char word in 5-col terminal: hard wrap after 5 chars
    expect(out).toContain("\n")
    expect(out.split("\n")[0]).toBe("abcde")
  })

  it("ignores ANSI escapes for width calculation", () => {
    const w = new StreamingWordWrapper(10)
    // The ANSI codes are zero-width, so "bold" is only 4 visible chars
    let out = ""
    out += w.push("\x1b[1mbold\x1b[22m text")
    out += w.flush()
    // visible: "bold text" = 9 chars, fits in 10 cols
    expect(out).not.toContain("\n")
    expect(out).toContain("\x1b[1m")
  })

  it("reset clears state for new turn", () => {
    const w = new StreamingWordWrapper(10)
    w.push("partial")
    w.reset()
    const out = w.push("fresh") + w.flush()
    expect(out).toBe("fresh")
    expect(out).not.toContain("partial")
  })

  it("drops space at wrap point", () => {
    const w = new StreamingWordWrapper(5)
    let out = ""
    out += w.push("abc defgh")
    out += w.flush()
    const lines = out.split("\n")
    // "abc d" is 5 chars, then on 'e' col becomes 6 > 5, wraps at space after "abc"
    // Actually: "abc " is 4 visible, then "d" makes it 5, then "e" is col 6 and "d" starts new line
    // Let me trace: a(1) b(2) c(3) ' '(4) d(5) e(6 > 5, break at lastSpace=3 -> "abc\n" + "de..."
    expect(lines[0]).toBe("abc")
    expect(lines[1]).toBe("defgh")
  })
})

describe("CLI adapter - echoed input summary wrapping", () => {
  it("preserves explicit blank lines when wrapping echoed input summaries", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    expect((agent as any).wrapCliText("alpha\n\nbeta", 10)).toEqual(["alpha", "", "beta"])
  })

  it("wraps long echoed input summaries at whitespace", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    expect(
      (agent as any).wrapCliText(
        "> otherwise we'll accidentally keep working in some random feature branch when we shouldn't",
        24,
      ),
    ).toEqual([
      "> otherwise we'll",
      "accidentally keep",
      "working in some random",
      "feature branch when we",
      "shouldn't",
    ])
  })

  it("splits a leading long word only when it cannot fit on one line", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    expect((agent as any).wrapCliText("supercalifragilistic", 6)).toEqual(["superc", "alifra", "gilist", "ic"])
  })

  it("splits a later long word after flushing the current wrapped line", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    expect((agent as any).wrapCliText("alpha supercalifragilistic", 6)).toEqual([
      "alpha",
      "superc",
      "alifra",
      "gilist",
      "ic",
    ])
  })

  it("formats echoed input summary by clearing every echoed row before writing the wrapped summary", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    const rendered = (agent as any).formatEchoedInputSummary("alpha beta gamma\ndelta epsilon", 12)
    expect(rendered).toContain("\x1b[4A")
    expect((rendered.match(/\x1b\[K/g) ?? []).length).toBe(4)
    expect(rendered).toContain("alpha beta")
    expect(rendered).toContain("gamma")
    expect(rendered).toContain("(+1")
    expect(rendered).toContain("lines)")
  })

  it("formats a single-row echoed input summary without an extra upward jump", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    const rendered = (agent as any).formatEchoedInputSummary("short", 20)
    expect(rendered).toContain("\x1b[1A")
    expect(rendered).toContain("\r\x1b[K")
    expect(rendered).not.toContain("\x1b[0A")
    expect(rendered).toContain("\x1b[1m> short\x1b[0m")
  })

  it("formatEchoedInputSummary wraps pasted multi-line input correctly", async () => {
    // This test verifies the formatting function independently.
    // With the Ink migration, runCliSession no longer calls formatEchoedInputSummary
    // directly -- input echo is handled by the Ink InputArea component.
    // The function is still exported for potential use elsewhere.
    vi.resetModules()
    const agent = await import("../../senses/cli")
    const result = agent.formatEchoedInputSummary(
      "otherwise we'll accidentally keep working in some random feature branch when we shouldn't",
      24,
    )
    expect(result).toContain("some random")
    expect(result).toContain("feature branch")
  })
})
