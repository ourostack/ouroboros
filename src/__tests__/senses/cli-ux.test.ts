import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Readable, Writable } from "node:stream"

describe("CLI UX - InputController", () => {
  let origStdinOn: typeof process.stdin.on
  let origStdinRemoveListener: typeof process.stdin.removeListener
  let stdinListeners: Record<string, ((...args: any[]) => void)[]>

  beforeEach(() => {
    stdinListeners = {}
    origStdinOn = process.stdin.on
    origStdinRemoveListener = process.stdin.removeListener
    process.stdin.on = vi.fn().mockImplementation((event: string, handler: any) => {
      if (!stdinListeners[event]) stdinListeners[event] = []
      stdinListeners[event].push(handler)
      return process.stdin
    }) as any
    process.stdin.removeListener = vi.fn().mockImplementation((event: string, handler: any) => {
      if (stdinListeners[event]) {
        stdinListeners[event] = stdinListeners[event].filter(h => h !== handler)
      }
      return process.stdin
    }) as any
  })

  afterEach(() => {
    process.stdin.on = origStdinOn
    process.stdin.removeListener = origStdinRemoveListener
    vi.restoreAllMocks()
  })

  it("is exported from agent.ts", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    expect(typeof agent.InputController).toBe("function")
  })

  it("suppress() pauses readline and listens on stdin for data", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_chunk, _enc, cb) { cb(); return true } }) as any
    const readline = await import("readline")
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })
    const pauseSpy = vi.spyOn(rl, "pause")

    const ctrl = new agent.InputController(rl)
    ctrl.suppress()

    expect(pauseSpy).toHaveBeenCalled()
    expect(process.stdin.on).toHaveBeenCalledWith("data", expect.any(Function))

    rl.close()
  })

  it("restore() resumes readline and removes stdin listener", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_chunk, _enc, cb) { cb(); return true } }) as any
    const readline = await import("readline")
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })
    const resumeSpy = vi.spyOn(rl, "resume")

    const ctrl = new agent.InputController(rl)
    ctrl.suppress()
    ctrl.restore()

    expect(resumeSpy).toHaveBeenCalled()
    expect(process.stdin.removeListener).toHaveBeenCalledWith("data", expect.any(Function))

    // Double restore is a no-op
    ctrl.restore()

    rl.close()
  })

  it("suppress() calls onInterrupt when Ctrl-C (0x03) is received", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_chunk, _enc, cb) { cb(); return true } }) as any
    const readline = await import("readline")
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })

    const onInterrupt = vi.fn()
    const ctrl = new agent.InputController(rl)
    ctrl.suppress(onInterrupt)

    // Simulate Ctrl-C byte
    const dataHandler = stdinListeners["data"]?.[0]
    expect(dataHandler).toBeDefined()
    dataHandler(Buffer.from([0x03]))

    expect(onInterrupt).toHaveBeenCalled()

    rl.close()
  })

  it("suppress() swallows non-Ctrl-C input", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_chunk, _enc, cb) { cb(); return true } }) as any
    const readline = await import("readline")
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })

    const onInterrupt = vi.fn()
    const ctrl = new agent.InputController(rl)
    ctrl.suppress(onInterrupt)

    // Simulate regular keystroke — should be swallowed, not trigger interrupt
    const dataHandler = stdinListeners["data"]?.[0]
    dataHandler(Buffer.from("a"))

    expect(onInterrupt).not.toHaveBeenCalled()

    rl.close()
  })

  it("restore() handles null dataHandler when suppressed", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_chunk, _enc, cb) { cb(); return true } }) as any
    const readline = await import("readline")
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })
    const resumeSpy = vi.spyOn(rl, "resume")

    const ctrl = new agent.InputController(rl)
    // Force suppressed=true without a dataHandler (defensive edge case)
    ;(ctrl as any).suppressed = true
    ;(ctrl as any).dataHandler = null
    ctrl.restore()

    expect(resumeSpy).toHaveBeenCalled()
    // removeListener should NOT be called since dataHandler was null
    expect(process.stdin.removeListener).not.toHaveBeenCalled()

    rl.close()
  })

  it("suppress() is idempotent", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_chunk, _enc, cb) { cb(); return true } }) as any
    const readline = await import("readline")
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })

    const ctrl = new agent.InputController(rl)
    ctrl.suppress()
    ctrl.suppress() // should be idempotent
    expect(process.stdin.on).toHaveBeenCalledTimes(1)

    rl.close()
  })
})

describe("CLI UX - Ctrl-C handling", () => {
  it("handleSigint is exported from agent.ts", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    expect(typeof agent.handleSigint).toBe("function")
  })

  it("clears input when buffer is non-empty", async () => {
    vi.resetModules()
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    const agent = await import("../../senses/cli")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_chunk, _enc, cb) { cb(); return true } }) as any
    const readline = await import("readline")
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })

    const result = agent.handleSigint(rl, "some partial input")
    expect(result).toBe("clear")

    rl.close()
    vi.restoreAllMocks()
  })

  it("shows warning when buffer is empty on first press", async () => {
    vi.resetModules()
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    const agent = await import("../../senses/cli")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_chunk, _enc, cb) { cb(); return true } }) as any
    const readline = await import("readline")
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })

    const result = agent.handleSigint(rl, "")
    expect(result).toBe("warn")

    rl.close()
    vi.restoreAllMocks()
  })

  it("returns exit on second consecutive Ctrl-C with empty buffer", async () => {
    vi.resetModules()
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    const agent = await import("../../senses/cli")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_chunk, _enc, cb) { cb(); return true } }) as any
    const readline = await import("readline")
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })

    agent.handleSigint(rl, "")
    const result = agent.handleSigint(rl, "")
    expect(result).toBe("exit")

    rl.close()
    vi.restoreAllMocks()
  })

  it("resets exit warning after non-empty input", async () => {
    vi.resetModules()
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    const agent = await import("../../senses/cli")

    const mockStdin = new Readable({ read() {} }) as any
    const mockStdout = new Writable({ write(_chunk, _enc, cb) { cb(); return true } }) as any
    const readline = await import("readline")
    const rl = readline.createInterface({ input: mockStdin, output: mockStdout, terminal: false })

    agent.handleSigint(rl, "")
    agent.handleSigint(rl, "text")
    const result = agent.handleSigint(rl, "")
    expect(result).toBe("warn")

    rl.close()
    vi.restoreAllMocks()
  })
})

describe("CLI UX - History", () => {
  it("addHistory is exported from agent.ts", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    expect(typeof agent.addHistory).toBe("function")
  })

  it("adds entries to history array", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    const history: string[] = []
    agent.addHistory(history, "first command")
    agent.addHistory(history, "second command")
    expect(history).toEqual(["first command", "second command"])
  })

  it("does not add empty strings to history", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    const history: string[] = []
    agent.addHistory(history, "")
    agent.addHistory(history, "  ")
    expect(history).toHaveLength(0)
  })

  it("does not add duplicate consecutive entries", async () => {
    vi.resetModules()
    const agent = await import("../../senses/cli")
    const history: string[] = []
    agent.addHistory(history, "same command")
    agent.addHistory(history, "same command")
    expect(history).toEqual(["same command"])
  })
})
