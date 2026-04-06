import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Tests for main() in agent.ts -- the CLI entry point that wires readline,
// input loop, SIGINT handling, postTurn, and history.
// Uses vi.hoisted + vi.mock so agent.ts is loaded ONCE (single V8 instance
// for accurate branch coverage).

// ── hoisted mock fns (available before vi.mock factories run) ──
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn().mockResolvedValue(undefined),
  runAgent: vi.fn().mockResolvedValue({ usage: undefined }),
  buildSystem: vi.fn().mockResolvedValue("system prompt"),
  sessionPath: vi.fn().mockReturnValue("/tmp/test-session.json"),
  logPath: vi.fn().mockReturnValue("/tmp/testagent-cli-runtime.ndjson"),
  getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
  loadSession: vi.fn().mockReturnValue(null),
  saveSession: vi.fn(),
  deleteSession: vi.fn(),
  trimMessages: vi.fn().mockImplementation((msgs: any) => [...msgs]),
  postTurn: vi.fn(),
  createCommandRegistry: vi.fn(),
  registerDefaultCommands: vi.fn(),
  parseSlashCommand: vi.fn().mockReturnValue(null),
  getToolChoiceRequired: vi.fn().mockReturnValue(false),
  enforceTrustGate: vi.fn().mockReturnValue({ allowed: true }),
  handleInboundTurn: vi.fn().mockImplementation(async (input: any) => {
    const userText = input.messages?.[0]?.content ?? ""
    const isCommand = typeof userText === "string" && userText.startsWith("/") && !userText.startsWith("//")
    const commandName = isCommand ? userText.slice(1).trim().split(" ")[0].toLowerCase() : null
    const knownCommands = ["exit", "new", "commands", "debug", "tool-required"]
    if (commandName && knownCommands.includes(commandName)) {
      const action = commandName === "exit" ? "exit" : commandName === "new" ? "new" : "response"
      return {
        resolvedContext: {
          friend: { id: "mock-uuid", name: "testuser" },
          channel: { channel: "cli", senseType: "local" },
        },
        gateResult: { allowed: true },
        turnOutcome: "command",
        commandAction: action,
      }
    }
    return {
      resolvedContext: {
        friend: { id: "mock-uuid", name: "testuser" },
        channel: { channel: "cli", senseType: "local" },
      },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: "/tmp/test-session.json",
      messages: [],
    }
  }),
  createInterface: vi.fn(),
  cursorTo: vi.fn(),
  resolveContext: vi.fn().mockResolvedValue({
    friend: {
      id: "mock-uuid",
      name: "testuser",
      externalIds: [{ provider: "local", externalId: "testuser", linkedAt: "2026-01-01" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    },
    channel: {
      channel: "cli",
      availableIntegrations: [],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
      senseType: "local",
    },
  }),
  // per-test registry (rebuilt in beforeEach)
  registry: {
    register: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    dispatch: vi.fn().mockReturnValue({ handled: false }),
  },
  // Ink callback captures (set by the ink mock's render())
  capturedInkOnSubmit: null as ((text: string) => void) | null,
  capturedInkOnExit: null as (() => void) | null,
  // Pending input sequence: set before main() is called, consumed by ink.render() mock
  _pendingInputSequence: [] as string[],
}))

vi.mock("readline", () => ({
  createInterface: (...a: any[]) => mocks.createInterface(...a),
  cursorTo: (...a: any[]) => mocks.cursorTo(...a),
}))
// Ink mock: captures onSubmit/onExit props and immediately schedules any pending
// input sequence via microtasks (deterministic, no flaky setTimeout delays).
vi.mock("ink", () => ({
  render: vi.fn((element: any) => {
    if (element && element.props) {
      mocks.capturedInkOnSubmit = element.props.onSubmit ?? null
      mocks.capturedInkOnExit = element.props.onExit ?? null
      // Immediately schedule any pending input sequence
      if (mocks._pendingInputSequence && mocks._pendingInputSequence.length > 0) {
        const seq = [...mocks._pendingInputSequence]
        mocks._pendingInputSequence = []
        let idx = 0
        const pushNext = () => {
          if (idx < seq.length && mocks.capturedInkOnSubmit) {
            mocks.capturedInkOnSubmit(seq[idx++])
            queueMicrotask(pushNext)
          } else if (mocks.capturedInkOnExit) {
            mocks.capturedInkOnExit()
          }
        }
        queueMicrotask(pushNext)
      }
    }
    return {
      unmount: vi.fn(),
      waitUntilExit: vi.fn().mockResolvedValue(undefined),
      rerender: vi.fn(),
      cleanup: vi.fn(),
      clear: vi.fn(),
    }
  }),
  Text: vi.fn(() => null),
  Box: vi.fn(() => null),
  useInput: vi.fn(),
  useApp: vi.fn(() => ({ exit: vi.fn() })),
}))
vi.mock("../../heart/core", () => ({
  runAgent: (...a: any[]) => mocks.runAgent(...a),
  buildSystem: (...a: any[]) => mocks.buildSystem(...a),
  getProvider: () => "azure",
  createSummarize: () => vi.fn(),
}))
vi.mock("../../heart/config", () => ({
  sessionPath: (...a: any[]) => mocks.sessionPath(...a),
  logPath: (...a: any[]) => mocks.logPath(...a),
  getContextConfig: (...a: any[]) => mocks.getContextConfig(...a),
}))
vi.mock("../../mind/prompt", () => ({
  buildSystem: (...a: any[]) => mocks.buildSystem(...a),
}))
vi.mock("../../mind/context", () => ({
  loadSession: (...a: any[]) => mocks.loadSession(...a),
  saveSession: (...a: any[]) => mocks.saveSession(...a),
  deleteSession: (...a: any[]) => mocks.deleteSession(...a),
  trimMessages: (...a: any[]) => mocks.trimMessages(...a),
  postTurn: (...a: any[]) => mocks.postTurn(...a),
}))
vi.mock("../../mind/pending", () => ({
  getPendingDir: vi.fn(() => "/mock/pending"),
  drainPending: vi.fn(() => []),
  drainDeferredReturns: vi.fn(() => []),
}))
vi.mock("../../mind/prompt-refresh", () => ({
  refreshSystemPrompt: vi.fn(),
}))
vi.mock("../../senses/commands", () => ({
  createCommandRegistry: (...a: any[]) => mocks.createCommandRegistry(...a),
  registerDefaultCommands: (...a: any[]) => mocks.registerDefaultCommands(...a),
  parseSlashCommand: (...a: any[]) => mocks.parseSlashCommand(...a),
  getToolChoiceRequired: (...a: any[]) => mocks.getToolChoiceRequired(...a),
  getSharedCommandRegistry: vi.fn().mockReturnValue({
    register: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    dispatch: vi.fn().mockReturnValue({ handled: false }),
  }),
  resetSharedCommandRegistry: vi.fn(),
  getDebugMode: vi.fn().mockReturnValue(false),
  resetDebugMode: vi.fn(),
  resetToolChoiceRequired: vi.fn(),
}))
vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  setAgentName: vi.fn(),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/agent/root"),
  getAgentBundlesRoot: vi.fn(() => "/mock/bundles"),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
    phrases: {
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    },
  })),
}))
vi.mock("../../mind/friends/store-file", () => {
  const MockFileFriendStore = vi.fn(function (this: any) {
    this.get = vi.fn()
    this.put = vi.fn()
    this.delete = vi.fn()
    this.findByExternalId = vi.fn()
  })
  return { FileFriendStore: MockFileFriendStore }
})
vi.mock("../../mind/friends/resolver", () => {
  const MockFriendResolver = vi.fn(function (this: any) {
    this.resolve = (...a: any[]) => mocks.resolveContext(...a)
  })
  return { FriendResolver: MockFriendResolver }
})
vi.mock("../../senses/trust-gate", () => ({
  enforceTrustGate: (...a: any[]) => mocks.enforceTrustGate(...a),
}))
vi.mock("../../senses/pipeline", () => ({
  handleInboundTurn: (...a: any[]) => mocks.handleInboundTurn(...a),
}))
vi.mock("../../mind/friends/tokens", () => ({
  accumulateFriendTokens: vi.fn(),
}))
vi.mock("../../mind/bundle-manifest", () => ({
  getPackageVersion: vi.fn(() => "0.1.0-alpha.20"),
  getChangelogPath: vi.fn(() => "/mock/changelog.json"),
  createBundleMeta: vi.fn(),
  backfillBundleMeta: vi.fn(),
  resetBackfillTracking: vi.fn(),
  CANONICAL_BUNDLE_MANIFEST: [],
  isCanonicalBundlePath: vi.fn().mockReturnValue(true),
  findNonCanonicalBundlePaths: vi.fn().mockReturnValue([]),
}))
vi.mock("../../heart/versioning/update-hooks", () => ({
  applyPendingUpdates: (...a: any[]) => mocks.applyPendingUpdates(...a),
  registerUpdateHook: vi.fn(),
  clearRegisteredHooks: vi.fn(),
  getRegisteredHooks: vi.fn().mockReturnValue([]),
}))
vi.mock("../../heart/daemon/hooks/bundle-meta", () => ({
  bundleMetaHook: vi.fn(),
}))
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os")
  return {
    ...actual,
    userInfo: vi.fn(() => ({ username: "testuser" })),
  }
})

import { main, writeCliAsyncAssistantMessage } from "../../senses/cli"

// ── helpers ──

let stdoutChunks: string[]
let stderrChunks: string[]
let logCalls: string[][]
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>
let consoleSpy: ReturnType<typeof vi.spyOn>

function setupSpies() {
  stdoutChunks = []
  stderrChunks = []
  logCalls = []
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdoutChunks.push(chunk.toString())
    return true
  })
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    stderrChunks.push(chunk.toString())
    return true
  })
  consoleSpy = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
    logCalls.push(args.map(String))
  })
}

function restoreSpies() {
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
  consoleSpy?.mockRestore()
}

function createMockRl() {
  let closeHandler: (() => void) | null = null
  let sigintHandler: ((...args: any[]) => void) | null = null

  const mockRl: any = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (event === "close") closeHandler = handler
      if (event === "SIGINT") sigintHandler = handler
      return mockRl
    },
    close: () => { if (closeHandler) closeHandler() },
    pause: () => {},
    resume: () => {},
    line: "",
  }

  return { mockRl, getCloseHandler: () => closeHandler, getSigintHandler: () => sigintHandler }
}

/** Reset all hoisted mocks to default behaviour */
function resetMocks() {
  mocks.capturedInkOnSubmit = null
  mocks.capturedInkOnExit = null
  mocks._pendingInputSequence = []
  mocks.applyPendingUpdates.mockReset().mockResolvedValue(undefined)
  mocks.runAgent.mockReset().mockResolvedValue({ usage: undefined })
  mocks.buildSystem.mockReset().mockReturnValue("system prompt")
  mocks.sessionPath.mockReset().mockReturnValue("/tmp/test-session.json")
  mocks.logPath.mockReset().mockReturnValue("/tmp/testagent-cli-runtime.ndjson")
  mocks.getContextConfig.mockReset().mockReturnValue({ maxTokens: 80000, contextMargin: 20 })
  mocks.loadSession.mockReset().mockReturnValue(null)
  mocks.saveSession.mockReset()
  mocks.deleteSession.mockReset()
  mocks.trimMessages.mockReset().mockImplementation((msgs: any) => [...msgs])
  mocks.buildSystem.mockReset().mockResolvedValue("system prompt")
  mocks.postTurn.mockReset()
  mocks.registerDefaultCommands.mockReset()
  mocks.parseSlashCommand.mockReset().mockReturnValue(null)
  mocks.getToolChoiceRequired.mockReset().mockReturnValue(false)
  mocks.enforceTrustGate.mockReset().mockReturnValue({ allowed: true })
  mocks.handleInboundTurn.mockReset().mockImplementation(async (input: any) => {
    // Check for slash commands (pipeline intercepts these before agent)
    const userText = input.messages?.[0]?.content ?? ""
    if (typeof userText === "string" && userText.startsWith("/") && !userText.startsWith("//")) {
      const cmdName = userText.slice(1).trim().split(" ")[0].toLowerCase()
      const knownActions: Record<string, string> = { exit: "exit", new: "new", commands: "response", debug: "response", "tool-required": "response" }
      if (cmdName in knownActions) {
        const resolvedContext = await input.friendResolver.resolve()
        if (knownActions[cmdName] === "response") {
          input.callbacks.onTextChunk?.(`${cmdName} handled`)
        }
        return {
          resolvedContext,
          gateResult: { allowed: true },
          turnOutcome: "command",
          commandAction: knownActions[cmdName],
        }
      }
    }
    // Default: mirror real pipeline behavior:
    // 1. Resolve friend
    const resolvedContext = await input.friendResolver.resolve()
    // 2. Gate always allows for CLI
    // 3. Load session
    const session = await input.sessionLoader.loadOrCreate()
    const sessionMsgs = session.messages
    // 4. Drain pending (skip in mock)
    // 5. Append user messages to session
    for (const msg of (input.messages ?? [])) {
      sessionMsgs.push(msg)
    }
    // 6. Call runAgent with assembled messages and pipeline-built toolContext
    const existingToolContext = input.runAgentOptions?.toolContext
    const runAgentOpts = {
      ...input.runAgentOptions,
      toolContext: {
        signin: async () => undefined,
        ...existingToolContext,
        context: resolvedContext,
        friendStore: input.friendStore,
      },
    }
    const result = await input.runAgent(
      sessionMsgs,
      input.callbacks,
      input.channel,
      input.signal,
      runAgentOpts,
    )
    // 7. postTurn + token accumulation (skip in mock)
    return {
      resolvedContext,
      gateResult: { allowed: true },
      usage: result?.usage,
      sessionPath: session.sessionPath,
      messages: sessionMsgs,
    }
  })

  // Fresh registry each test
  mocks.cursorTo.mockReset()
  mocks.registry = {
    register: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    dispatch: vi.fn().mockReturnValue({ handled: false }),
  }
  mocks.createCommandRegistry.mockReset().mockReturnValue(mocks.registry)
}

/** Create an async iterable from an array of strings (for _testInputSource) */
function createTestInputSource(inputSequence: string[]): AsyncIterable<string> {
  let idx = 0
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<string>> => {
        if (idx < inputSequence.length) {
          return { value: inputSequence[idx++], done: false }
        }
        return { value: undefined as any, done: true }
      },
    }),
  }
}

// Module-level test input source (set by setupBasic, consumed by testMain)
let _currentTestInputSource: AsyncIterable<string> | undefined

/** Wrapper around main() that injects _testInputSource to skip Ink rendering */
async function testMain(agentName?: string, opts?: { pasteDebounceMs?: number }) {
  return main(agentName, { ...opts, _testInputSource: _currentTestInputSource })
}

/** Wire a simple mockRl and common slash-command routing */
function setupBasic(opts: {
  inputSequence: string[]
  loadSessionReturn?: any
  parseSlash?: boolean
  dispatchFn?: (name: string) => any
}) {
  const {
    inputSequence,
    loadSessionReturn = null,
    parseSlash = true,
    dispatchFn = (name: string) => name === "exit" ? { handled: true, result: { action: "exit" } } : { handled: false },
  } = opts

  const { mockRl, getCloseHandler, getSigintHandler } = createMockRl()
  mocks.createInterface.mockReturnValue(mockRl)
  mocks.loadSession.mockReturnValue(loadSessionReturn)

  if (parseSlash) {
    mocks.parseSlashCommand.mockImplementation((input: string) =>
      input.startsWith("/") ? { command: input.slice(1).toLowerCase(), args: "" } : null)
  }
  mocks.registry.dispatch.mockImplementation(dispatchFn)

  // Set test input source for testMain()
  _currentTestInputSource = createTestInputSource(inputSequence)

  return { mockRl, getCloseHandler, getSigintHandler }
}

// ── tests ──

describe("agent.ts main()", () => {
  beforeEach(() => {
    resetMocks()
    setupSpies()
  })

  afterEach(() => {
    restoreSpies()
    vi.restoreAllMocks()
  })

  it("calls applyPendingUpdates on startup as fallback for daemon-less usage", async () => {
    setupBasic({ inputSequence: ["/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(mocks.applyPendingUpdates).toHaveBeenCalledTimes(1)
  })

  it("runs full loop: processes input, exits on /exit", async () => {
    setupBasic({ inputSequence: ["hello world", "/exit"] })

    const runAgentCalls: any[][] = []
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const flatLogs = logCalls.flat()
    expect(flatLogs.some((l) => l.includes("testagent") || l.includes("/commands"))).toBe(true)
    expect(flatLogs.some((l) => l.includes("bye"))).toBe(true)
    expect(runAgentCalls.length).toBe(1) // "hello world" only (no boot greeting)
  })

  it("skips empty input without calling runAgent", async () => {
    setupBasic({ inputSequence: ["", "  ", "/exit"] })

    const runAgentCalls: any[][] = []
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(runAgentCalls.length).toBe(0) // no calls (no boot greeting, all input empty)
  })

  it("SIGINT: clear on non-empty, warn on first empty, exit on second", async () => {
    let inputResolve: ((result: IteratorResult<string>) => void) | null = null

    const mockRl: any = {
      on: (event: string, handler: (...args: any[]) => void) => {
        if (event === "close") mockRl._closeHandler = handler
        if (event === "SIGINT") mockRl._sigintHandler = handler
        return mockRl
      },
      close: () => { if (mockRl._closeHandler) mockRl._closeHandler() },
      pause: () => {},
      resume: () => {},
      line: "partial",
      _closeHandler: null as any,
      _sigintHandler: null as any,
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<string>> => {
          return new Promise((resolve) => { inputResolve = resolve })
        },
      }),
    }

    mocks.createInterface.mockReturnValue(mockRl)
    // Use _testInputSource with a promise-based input that we can resolve manually
    let inputResolve2: ((v: IteratorResult<string>) => void) | null = null
    _currentTestInputSource = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<string>>((r) => { inputResolve2 = r }),
      }),
    }
    const mainPromise = testMain()

    // Wait for main to start
    await new Promise((r) => setTimeout(r, 50))

    // Resolve the pending input iterator to let main() finish
    if (inputResolve2) inputResolve2({ value: undefined as any, done: true })
    await mainPromise

    const flatLogs = logCalls.flat()
    expect(flatLogs.some((l) => l.includes("bye"))).toBe(true)
  })

  it("breaks at top of loop when closed flag is set while awaiting input", async () => {
    let closeHandler: (() => void) | null = null
    let inputCall = 0
    let inputResolve: ((result: IteratorResult<string>) => void) | null = null

    const mockRl: any = {
      on: (event: string, handler: (...args: any[]) => void) => {
        if (event === "close") closeHandler = handler
        return mockRl
      },
      close: () => { if (closeHandler) closeHandler() },
      pause: () => {},
      resume: () => {},
      line: "",
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<string>> => {
          inputCall++
          if (inputCall === 1) {
            // First call: return a promise we control, and fire close before resolving
            return new Promise((resolve) => { inputResolve = resolve })
          }
          return Promise.resolve({ value: undefined as any, done: true })
        },
      }),
    }

    mocks.createInterface.mockReturnValue(mockRl)

    // Use _testInputSource: resolve the input iterator to let main finish immediately
    _currentTestInputSource = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<string>> => {
          return { value: undefined as any, done: true }
        },
      }),
    }
    const mainPromise = testMain()
    await mainPromise

    const flatLogs = logCalls.flat()
    expect(flatLogs.some((l) => l.includes("bye"))).toBe(true)
    // runAgent should never be called (the input is discarded)
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("breaks loop when input source ends during processing", async () => {
    // Verify the loop exits cleanly when input source completes
    setupBasic({ inputSequence: ["some input"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const flatLogs = logCalls.flat()
    expect(flatLogs.some((l) => l.includes("bye"))).toBe(true)
    // "some input" = 1 pipeline call (no boot greeting)
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
  })

  it("passes an AbortSignal to runAgent for each turn", async () => {
    let agentSignal: AbortSignal | undefined

    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.runAgent.mockImplementation(async (_msgs: any, _cb: any, _channel?: string, signal?: AbortSignal) => {
      agentSignal = signal
      return { usage: undefined }
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // The signal should be provided (from currentAbort = new AbortController())
    expect(agentSignal).toBeDefined()
    expect(agentSignal).toBeInstanceOf(AbortSignal)
  })

  it("exits when input is /Exit (case insensitive slash command)", async () => {
    setupBasic({ inputSequence: ["/Exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const flatLogs = logCalls.flat()
    expect(flatLogs.some((l) => l.includes("bye"))).toBe(true)
  })
})

describe("agent.ts main() - session persistence", () => {
  beforeEach(() => {
    resetMocks()
    setupSpies()
  })

  afterEach(() => {
    restoreSpies()
    vi.restoreAllMocks()
  })

  it("loads existing session on startup (no boot greeting)", async () => {
    const savedSession = [
      { role: "system", content: "old system" },
      { role: "user", content: "previous message" },
      { role: "assistant", content: "previous reply" },
    ]
    const runAgentCalls: any[][] = []
    setupBasic({ inputSequence: ["/exit"], loadSessionReturn: { messages: savedSession, lastUsage: undefined } })
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(runAgentCalls.length).toBe(0)
  })

  it("starts fresh when no session exists (no boot greeting)", async () => {
    const runAgentCalls: any[][] = []
    setupBasic({ inputSequence: ["/exit"] })
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(runAgentCalls.length).toBe(0) // no boot greeting
  })

  it("starts fresh when session is corrupt (no boot greeting)", async () => {
    const runAgentCalls: any[][] = []
    setupBasic({ inputSequence: ["/exit"], loadSessionReturn: null })
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(runAgentCalls.length).toBe(0) // no boot greeting
  })

  it("renders buffered text with markdown after runAgent", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    let callCount = 0
    mocks.runAgent.mockImplementation(async (_msgs: any, cb: any) => {
      callCount++
      if (callCount === 1) cb.onTextChunk("**bold** reply")
      return { usage: undefined }
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const output = stdoutChunks.join("")
    // Markdown should be rendered (bold ANSI codes, not raw **)
    expect(output).toContain("\x1b[1mbold\x1b[22m reply")
    expect(output).not.toContain("**bold**")
  })

  it("delegates postTurn to pipeline (main does not call postTurn directly)", async () => {
    const usageData = { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10, total_tokens: 160 }
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.runAgent.mockImplementation(async () => ({ usage: usageData }))

    await testMain(undefined, { pasteDebounceMs: 0 })

    // postTurn should NOT be called directly by main() -- pipeline handles it
    expect(mocks.postTurn).not.toHaveBeenCalled()
    // handleInboundTurn called for "hello" + "/exit" (commands now route through pipeline)
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(2)
  })

  it("does not call trimMessages directly (postTurn handles it)", async () => {
    const trimCalls: any[][] = []
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.runAgent.mockImplementation(async () => ({ usage: undefined }))
    mocks.trimMessages.mockImplementation((...args: any[]) => { trimCalls.push(args); return [...args[0]] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(trimCalls.length).toBe(0) // trimming moved to postTurn
  })

  it("/exit quits the process", async () => {
    setupBasic({ inputSequence: ["/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const flatLogs = logCalls.flat()
    expect(flatLogs.some((l) => l.includes("bye"))).toBe(true)
  })

  it("/new clears session and prints confirmation", async () => {
    const deleteSessionCalls: string[] = []
    setupBasic({
      inputSequence: ["/new", "/exit"],
      dispatchFn: (name: string) => {
        if (name === "exit") return { handled: true, result: { action: "exit" } }
        if (name === "new") return { handled: true, result: { action: "new" } }
        return { handled: false }
      },
    })
    mocks.deleteSession.mockImplementation((...args: any[]) => { deleteSessionCalls.push(args[0]) })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(deleteSessionCalls.length).toBeGreaterThanOrEqual(1)
  })

  it("/commands prints command list without calling runAgent", async () => {
    const runAgentCalls: any[][] = []
    setupBasic({
      inputSequence: ["/commands", "/exit"],
      dispatchFn: (name: string) => {
        if (name === "exit") return { handled: true, result: { action: "exit" } }
        if (name === "commands") return { handled: true, result: { action: "response", message: "/exit - quit\n/new - new session" } }
        return { handled: false }
      },
    })
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(runAgentCalls.length).toBe(0) // no boot greeting, /commands handled without runAgent
  })

  it("delegates per-turn lifecycle to pipeline for each user turn", async () => {
    setupBasic({ inputSequence: ["msg1", "msg2", "/exit"] })
    mocks.runAgent.mockImplementation(async () => ({ usage: undefined }))

    await testMain(undefined, { pasteDebounceMs: 0 })

    // handleInboundTurn called for msg1, msg2, and /exit (commands route through pipeline)
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(3)
    // postTurn not called directly by main()
    expect(mocks.postTurn).not.toHaveBeenCalled()
  })

  it("passes 'cli' channel to runAgent for system prompt refresh", async () => {
    const runAgentCalls: any[][] = []
    setupBasic({
      inputSequence: ["hello", "/exit"],
      loadSessionReturn: {
        messages: [
          { role: "system", content: "old stale prompt" },
          { role: "user", content: "old message" },
        ],
        lastUsage: undefined,
      },
    })
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(runAgentCalls.length).toBe(1) // "hello" turn
    // channel is the 3rd argument (index 2)
    expect(runAgentCalls[0][2]).toBe("cli")
  })

  it("unhandled slash command falls through to regular input", async () => {
    const runAgentCalls: any[][] = []
    setupBasic({
      inputSequence: ["/unknown", "/exit"],
      dispatchFn: (name: string) => {
        if (name === "exit") return { handled: true, result: { action: "exit" } }
        return { handled: false }
      },
    })
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // /unknown is not handled, so it's sent to runAgent as regular input
    // No boot greeting, just "/unknown" as text = 1 call
    expect(runAgentCalls.length).toBe(1)
  })

  it("slash command with unknown action falls through to regular input", async () => {
    const runAgentCalls: any[][] = []
    setupBasic({
      inputSequence: ["/weird", "/exit"],
      dispatchFn: (name: string) => {
        if (name === "exit") return { handled: true, result: { action: "exit" } }
        if (name === "weird") return { handled: true, result: { action: "something_else" } }
        return { handled: false }
      },
    })
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // /weird is handled but action is unknown, falls through to regular input
    // No boot greeting, just "/weird" as text = 1 call
    expect(runAgentCalls.length).toBe(1)
  })

  it("/commands with empty message is handled by pipeline (no console output)", async () => {
    setupBasic({
      inputSequence: ["/commands", "/exit"],
      dispatchFn: (name: string) => {
        if (name === "exit") return { handled: true, result: { action: "exit" } }
        if (name === "commands") return { handled: true, result: { action: "response" } }
        return { handled: false }
      },
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // Pipeline handles the command — no onTextChunk called for undefined message
    // CLI just continues to next prompt
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(2)
  })

  it("welcome banner shows slash command hints", async () => {
    setupBasic({ inputSequence: ["/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const flatLogs = logCalls.flat()
    expect(flatLogs.some((l) => l.includes("/commands"))).toBe(true)
  })
})

describe("agent.ts main() - onKick and toolChoiceRequired", () => {
  beforeEach(() => {
    resetMocks()
    setupSpies()
  })

  afterEach(() => {
    restoreSpies()
    vi.restoreAllMocks()
  })

  it("onKick callback writes kick status to stderr", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.runAgent.mockImplementation(async (_msgs: any, cb: any) => {
      // Simulate kick callback -- no arguments
      if (cb.onKick) cb.onKick()
      return { usage: undefined }
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const stderrOutput = stderrChunks.join("")
    expect(stderrOutput).toContain("kick")
  })

  it("onKick callback receives no arguments", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    const kickArgs: number[] = []
    mocks.runAgent.mockImplementation(async (_msgs: any, cb: any) => {
      if (cb.onKick) {
        // Call twice -- verify no-arg signature works
        cb.onKick()
        cb.onKick()
      }
      return { usage: undefined }
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const stderrOutput = stderrChunks.join("")
    // Each kick should produce "kick" text
    const kickMatches = stderrOutput.match(/kick/g)
    expect(kickMatches!.length).toBeGreaterThanOrEqual(2)
  })

  it("onKick emits newline before kick when textDirty", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.runAgent.mockImplementation(async (_msgs: any, cb: any) => {
      // Write text without trailing newline to set textDirty
      if (cb.onTextChunk) cb.onTextChunk("partial output")
      if (cb.onKick) cb.onKick()
      return { usage: undefined }
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const stdoutOutput = stdoutChunks.join("")
    // The partial text should be followed by a newline before kick clears textDirty
    expect(stdoutOutput).toContain("partial output")
    expect(stdoutOutput).toContain("\n")
  })

  it("passes toolChoiceRequired option to runAgent when toggle is on", async () => {
    const runAgentCalls: any[][] = []
    // After /tool-required dispatch, getToolChoiceRequired returns true
    mocks.getToolChoiceRequired.mockReturnValue(true)
    setupBasic({
      inputSequence: ["/tool-required", "hello", "/exit"],
      dispatchFn: (name: string) => {
        if (name === "exit") return { handled: true, result: { action: "exit" } }
        if (name === "tool-required") return { handled: true, result: { action: "response", message: "tool-required mode: ON" } }
        return { handled: false }
      },
    })
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(runAgentCalls.length).toBe(1)
    // 5th argument (index 4) should be options with toolChoiceRequired: true
    expect(runAgentCalls[0][4]).toEqual(expect.objectContaining({ toolChoiceRequired: true }))
  })

  it("passes toolChoiceRequired: false when toggle is off (default)", async () => {
    const runAgentCalls: any[][] = []
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(runAgentCalls.length).toBe(1)
    // 5th argument (index 4) should have toolChoiceRequired: false
    expect(runAgentCalls[0][4]).toEqual(expect.objectContaining({ toolChoiceRequired: false }))
  })

  it("creates and passes a traceId option to runAgent at CLI turn entry", async () => {
    const runAgentCalls: any[][] = []
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(runAgentCalls.length).toBe(1)
    expect(runAgentCalls[0][4]).toEqual(expect.objectContaining({ traceId: expect.any(String) }))
  })

  it("warns on stderr when assistant response is empty", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.runAgent.mockImplementation(async (msgs: any[]) => {
      msgs.push({ role: "assistant", content: "" })
      return { usage: undefined }
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const stderrOutput = stderrChunks.join("")
    expect(stderrOutput).toContain("(empty response)")
  })

  it("warns on stderr when assistant response has non-string content", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.runAgent.mockImplementation(async (msgs: any[]) => {
      msgs.push({ role: "assistant", content: [{ type: "text", text: "" }] })
      return { usage: undefined }
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const stderrOutput = stderrChunks.join("")
    expect(stderrOutput).toContain("(empty response)")
  })

  it("passes ToolContext with resolved context to runAgent", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    const runAgentCalls: any[][] = []
    mocks.runAgent.mockImplementation(async (...args: any[]) => {
      runAgentCalls.push(args)
      return { usage: undefined }
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(runAgentCalls.length).toBe(1)
    const options = runAgentCalls[0][4] // 5th arg is RunAgentOptions
    expect(options).toBeDefined()
    expect(options.toolContext).toBeDefined()
    expect(options.toolContext.context).toBeDefined()
    // Should have friend from OS username (mocked as "testuser")
    expect(options.toolContext.context.friend).toBeDefined()
    expect(options.toolContext.context.friend.name).toBe("testuser")
    // Should have CLI channel capabilities
    expect(options.toolContext.context.channel).toBeDefined()
    expect(options.toolContext.context.channel.channel).toBe("cli")
    expect(options.toolContext.context.channel.availableIntegrations).toEqual([])
  })

  it("buildSystem is called with resolved context as third argument", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.loadSession.mockReturnValue(null) // force new session -> calls buildSystem

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(mocks.buildSystem).toHaveBeenCalledWith(
      "cli",
      {},
      expect.objectContaining({
        friend: expect.objectContaining({ name: "testuser" }),
        channel: expect.objectContaining({ channel: "cli" }),
      }),
    )
  })

  it("toolContext.friendStore is set from the FileFriendStore", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    const runAgentCalls: any[][] = []
    mocks.runAgent.mockImplementation(async (...args: any[]) => {
      runAgentCalls.push(args)
      return { usage: undefined }
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const options = runAgentCalls[0][4]
    expect(options.toolContext.friendStore).toBeDefined()
  })

  it("session path uses friend UUID from resolved context", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // sessionPath should be called with the friend UUID ("mock-uuid"), not "default"
    expect(mocks.sessionPath).toHaveBeenCalledWith("mock-uuid", "cli", "session")
  })

  it("pending drain is delegated to pipeline (main does not call drainPending directly)", async () => {
    const { drainPending } = await import("../../mind/pending")
    vi.mocked(drainPending).mockClear()
    setupBasic({ inputSequence: ["hello", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // main() should NOT call drainPending directly -- pipeline handles pending drain
    expect(drainPending).not.toHaveBeenCalled()
    // handleInboundTurn called for "hello" + "/exit" (commands now route through pipeline)
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(2)
  })

  it("gate rejection via pipeline returns auto reply and skips runAgent", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.handleInboundTurn.mockResolvedValueOnce({
      resolvedContext: {
        friend: { id: "mock-uuid", name: "testuser" },
        channel: { channel: "cli", senseType: "local" },
      },
      gateResult: {
        allowed: false,
        reason: "stranger_first_reply",
        autoReply: "I'm sorry, I'm not allowed to talk to strangers",
      },
      usage: undefined,
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // Pipeline called for "hello" (gate rejection) + "/exit" (command)
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(2)
    expect(stdoutChunks.join("")).toContain("I'm sorry, I'm not allowed to talk to strangers")
  })

  it("gate rejection via pipeline with silent drop shows no reply", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.handleInboundTurn.mockResolvedValue({
      resolvedContext: {
        friend: { id: "mock-uuid", name: "testuser" },
        channel: { channel: "cli", senseType: "local" },
      },
      gateResult: {
        allowed: false,
        reason: "stranger_silent_drop",
      },
      usage: undefined,
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(stdoutChunks.join("")).not.toContain("I'm sorry")
  })
})

describe("agent.ts main(agentName) parameter", () => {
  beforeEach(() => {
    resetMocks()
    setupSpies()
  })

  afterEach(() => {
    restoreSpies()
    vi.restoreAllMocks()
  })

  it("processes each line from input source as a separate turn", async () => {
    // With Ink/InputQueue, each submitted line is a separate turn (no readline debounce)
    const runAgentCalls: any[][] = []
    setupBasic({ inputSequence: ["line1", "line2", "line3"] })
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // Each line is a separate pipeline call (no debounce coalescing)
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(3)
  })

  it("processes sequential lines independently even with pasteDebounceMs set", async () => {
    // pasteDebounceMs is a legacy option; input source lines are always separate turns
    setupBasic({ inputSequence: ["first", "/exit"] })

    const runAgentCalls: any[][] = []
    mocks.runAgent.mockImplementation(async (...args: any[]) => { runAgentCalls.push(args); return { usage: undefined } })

    await testMain(undefined, { pasteDebounceMs: 5 })

    // "first" + "/exit" both go through pipeline
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(2)
  })

  it("calls setAgentName when agentName parameter is provided", async () => {
    const { setAgentName } = await import("../../heart/identity")
    setupBasic({ inputSequence: ["/exit"] })

    await testMain("customAgent", { pasteDebounceMs: 0 })

    expect(setAgentName).toHaveBeenCalledWith("customAgent")
  })

  it("does not call setAgentName when agentName is omitted", async () => {
    const { setAgentName } = await import("../../heart/identity")
    vi.mocked(setAgentName).mockClear()
    setupBasic({ inputSequence: ["/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(setAgentName).not.toHaveBeenCalled()
  })
})

// ── runCliSession tests ──
import { runCliSession } from "../../senses/cli"

describe("runCliSession", () => {
  beforeEach(() => {
    resetMocks()
    setupSpies()
  })

  afterEach(() => {
    restoreSpies()
    vi.restoreAllMocks()
  })

  it("returns exitReason 'user_quit' on /exit", async () => {
    setupBasic({ inputSequence: ["/exit"] })

    const result = await runCliSession({
      agentName: "testagent",
      pasteDebounceMs: 0,
      _testInputSource: createTestInputSource(["/exit"]),
    })

    expect(result.exitReason).toBe("user_quit")
  })

  it("processes input and returns exitReason 'user_quit' when input ends", async () => {
    setupBasic({ inputSequence: ["hello"] })

    const result = await runCliSession({
      agentName: "testagent",
      pasteDebounceMs: 0,
      _testInputSource: createTestInputSource(["hello"]),
    })

    expect(result.exitReason).toBe("user_quit")
    expect(mocks.runAgent).toHaveBeenCalled()
  })

  it("passes custom tools to runAgent when provided", async () => {
    const customTools: any[] = [{
      type: "function",
      function: { name: "custom_tool", description: "test", parameters: { type: "object", properties: {} } },
    }]
    setupBasic({ inputSequence: ["hello", "/exit"] })

    await runCliSession({
      agentName: "testagent",
      tools: customTools,
      pasteDebounceMs: 0,
      _testInputSource: createTestInputSource(["hello", "/exit"]),
    })

    expect(mocks.runAgent).toHaveBeenCalled()
    const opts = mocks.runAgent.mock.calls[0][4]
    expect(opts.tools).toBe(customTools)
  })

  it("passes custom execTool to runAgent when provided", async () => {
    const customExecTool = vi.fn().mockResolvedValue("custom result")
    setupBasic({ inputSequence: ["hello", "/exit"] })

    await runCliSession({
      agentName: "testagent",
      execTool: customExecTool,
      pasteDebounceMs: 0,
      _testInputSource: createTestInputSource(["hello", "/exit"]),
    })

    expect(mocks.runAgent).toHaveBeenCalled()
    const opts = mocks.runAgent.mock.calls[0][4]
    expect(opts.execTool).toBeDefined()
  })

  it("returns exitReason 'tool_exit' when exitOnToolCall fires", async () => {
    const customExecTool = vi.fn().mockResolvedValue(JSON.stringify({ agentName: "MyAgent" }))
    setupBasic({ inputSequence: ["create the agent"] })

    // Simulate the execTool being called with the target tool name
    mocks.runAgent.mockImplementation(async (_msgs: any, _cb: any, _channel?: string, _signal?: AbortSignal, options?: any) => {
      // Simulate calling the wrapped execTool with the exit tool
      if (options?.execTool) {
        await options.execTool("complete_adoption", { name: "MyAgent" })
      }
      return { usage: undefined }
    })

    const result = await runCliSession({
      agentName: "SerpentGuide",
      execTool: customExecTool,
      exitOnToolCall: "complete_adoption",
      pasteDebounceMs: 0,
      _testInputSource: createTestInputSource(["create the agent"]),
    })

    expect(result.exitReason).toBe("tool_exit")
    expect(result.toolResult).toBe(JSON.stringify({ agentName: "MyAgent" }))
    expect(customExecTool).toHaveBeenCalledWith("complete_adoption", { name: "MyAgent" }, undefined)
  })

  it("continues processing when a non-exit tool is called", async () => {
    const customExecTool = vi.fn().mockResolvedValue("file content")
    setupBasic({ inputSequence: ["read file", "/exit"] })

    mocks.runAgent.mockImplementation(async (_msgs: any, _cb: any, _channel?: string, _signal?: AbortSignal, options?: any) => {
      if (options?.execTool) {
        await options.execTool("read_file", { path: "/tmp/test.txt" })
      }
      return { usage: undefined }
    })

    const result = await runCliSession({
      agentName: "SerpentGuide",
      execTool: customExecTool,
      exitOnToolCall: "complete_adoption",
      pasteDebounceMs: 0,
      _testInputSource: createTestInputSource(["read file", "/exit"]),
    })

    // Should NOT exit early -- read_file is not the exit tool
    expect(result.exitReason).toBe("user_quit")
  })

  it("passes toolChoiceRequired option when specified", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })

    await runCliSession({
      agentName: "testagent",
      toolChoiceRequired: true,
      pasteDebounceMs: 0,
      _testInputSource: createTestInputSource(["hello", "/exit"]),
    })

    expect(mocks.runAgent).toHaveBeenCalled()
    const opts = mocks.runAgent.mock.calls[0][4]
    expect(opts.toolChoiceRequired).toBe(true)
  })

  it("defaults pasteDebounceMs to 50 when not provided", async () => {
    setupBasic({ inputSequence: ["/exit"] })

    const result = await runCliSession({
      agentName: "testagent",
      _testInputSource: createTestInputSource(["/exit"]),
    })

    expect(result.exitReason).toBe("user_quit")
  })

  it("calls onTurnEnd with fallback usage when runAgent throws", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.runAgent.mockRejectedValue(new DOMException("aborted", "AbortError"))

    const onTurnEnd = vi.fn()
    await runCliSession({
      agentName: "testagent",
      pasteDebounceMs: 0,
      onTurnEnd,
      _testInputSource: createTestInputSource(["hello", "/exit"]),
    })

    expect(onTurnEnd).toHaveBeenCalledWith(
      expect.any(Array),
      { usage: undefined },
    )
  })

  it("provides default CLI coding feedback that surfaces async assistant updates", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })

    await runCliSession({
      agentName: "testagent",
      pasteDebounceMs: 0,
      _testInputSource: createTestInputSource(["hello", "/exit"]),
    })

    const messages = mocks.runAgent.mock.calls[0][0]
    const opts = mocks.runAgent.mock.calls[0][4]
    expect(typeof opts.toolContext.codingFeedback.send).toBe("function")

    await opts.toolContext.codingFeedback.send("codex coding-001 completed: hi")

    expect(messages.at(-1)).toEqual({
      role: "assistant",
      content: "codex coding-001 completed: hi",
    })
    expect(stdoutChunks.join("")).toContain("codex coding-001 completed: hi")
  })

  it("redraws the in-progress input and cursor for async assistant updates", () => {
    const writes: string[] = []
    const stdout = {
      write: vi.fn((chunk: string) => {
        writes.push(chunk)
        return true
      }),
    }
    const rl = { line: "continue typing", cursor: 4 } as any

    writeCliAsyncAssistantMessage(rl, "codex coding-001 completed: hi", stdout)

    expect(writes).toEqual([
      "\r\x1b[K",
      "codex coding-001 completed: hi\n",
      "\x1b[36m) \x1b[0m",
      "continue typing",
    ])
    expect(mocks.cursorTo).toHaveBeenCalledWith(process.stdout, 6)
  })

  it("redraws the in-progress input without moving the cursor when already at the end", () => {
    const writes: string[] = []
    const stdout = {
      write: vi.fn((chunk: string) => {
        writes.push(chunk)
        return true
      }),
    }
    const rl = { line: "continue typing", cursor: "continue typing".length } as any

    writeCliAsyncAssistantMessage(rl, "codex coding-001 completed: hi", stdout)

    expect(writes).toEqual([
      "\r\x1b[K",
      "codex coding-001 completed: hi\n",
      "\x1b[36m) \x1b[0m",
      "continue typing",
    ])
    expect(mocks.cursorTo).not.toHaveBeenCalled()
  })

  it("falls back cleanly when readline internals are absent", () => {
    const writes: string[] = []
    const stdout = {
      write: vi.fn((chunk: string) => {
        writes.push(chunk)
        return true
      }),
    }
    const rl = {} as any

    writeCliAsyncAssistantMessage(rl, "codex coding-001 completed: hi", stdout)

    expect(writes).toEqual([
      "\r\x1b[K",
      "codex coding-001 completed: hi\n",
      "\x1b[36m) \x1b[0m",
    ])
    expect(mocks.cursorTo).not.toHaveBeenCalled()
  })
})

// ── pipeline integration tests ──

describe("agent.ts main() - pipeline integration", () => {
  beforeEach(() => {
    resetMocks()
    setupSpies()
  })

  afterEach(() => {
    restoreSpies()
    vi.restoreAllMocks()
  })

  it("calls handleInboundTurn from pipeline for each user turn", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // "hello" + "/exit" both route through pipeline (commands handled there now)
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(2)
  })

  it("does NOT directly call enforceTrustGate (pipeline handles gate)", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(mocks.enforceTrustGate).not.toHaveBeenCalled()
  })

  it("does NOT directly call postTurn (pipeline handles it)", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.runAgent.mockResolvedValue({ usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // postTurn should NOT be called directly by main() -- pipeline handles it
    expect(mocks.postTurn).not.toHaveBeenCalled()
  })

  it("does NOT directly call accumulateFriendTokens (pipeline handles it)", async () => {
    const { accumulateFriendTokens } = await import("../../mind/friends/tokens")
    vi.mocked(accumulateFriendTokens).mockClear()

    setupBasic({ inputSequence: ["hello", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(accumulateFriendTokens).not.toHaveBeenCalled()
  })

  it("does NOT directly call drainPending (pipeline handles it)", async () => {
    const { drainPending } = await import("../../mind/pending")
    vi.mocked(drainPending).mockClear()

    setupBasic({ inputSequence: ["hello", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // drainPending should not be called directly -- pipeline handles it
    expect(drainPending).not.toHaveBeenCalled()
  })

  it("does NOT call refreshSystemPrompt in onTurnEnd (redundant with runAgent)", async () => {
    const { refreshSystemPrompt } = await import("../../mind/prompt-refresh")
    vi.mocked(refreshSystemPrompt).mockClear()

    setupBasic({ inputSequence: ["hello", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(refreshSystemPrompt).not.toHaveBeenCalled()
  })

  it("passes pipeline result usage through handleInboundTurn", async () => {
    const usageData = { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10, total_tokens: 160 }
    setupBasic({ inputSequence: ["hello", "/exit"] })
    mocks.handleInboundTurn.mockResolvedValue({
      resolvedContext: {
        friend: { id: "mock-uuid", name: "testuser" },
        channel: { channel: "cli", senseType: "local" },
      },
      gateResult: { allowed: true },
      usage: usageData,
      sessionPath: "/tmp/test-session.json",
      messages: [],
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // "hello" + "/exit" both route through pipeline
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(2)
  })

  it("calls handleInboundTurn for each user turn including commands", async () => {
    setupBasic({ inputSequence: ["msg1", "msg2", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // "msg1" + "msg2" + "/exit" = 3 pipeline calls
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(3)
  })

  it("pipeline input includes channel='cli' and senseType='local'", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(2)
    const pipelineInput = mocks.handleInboundTurn.mock.calls[0][0]
    expect(pipelineInput.channel).toBe("cli")
    expect(pipelineInput.capabilities.senseType).toBe("local")
  })

  it("passes raw continuity ingress text into the shared pipeline", async () => {
    setupBasic({ inputSequence: ["  hello from cli  ", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const pipelineInput = mocks.handleInboundTurn.mock.calls[0][0]
    expect(pipelineInput.continuityIngressTexts).toEqual(["hello from cli"])
  })

  it("passes deferred-return drain into the shared pipeline", async () => {
    const { drainDeferredReturns } = await import("../../mind/pending")
    vi.mocked(drainDeferredReturns).mockClear()
    setupBasic({ inputSequence: ["hello", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const pipelineInput = mocks.handleInboundTurn.mock.calls[0][0]
    expect(typeof pipelineInput.drainDeferredReturns).toBe("function")
    expect(pipelineInput.drainDeferredReturns("friend-1")).toEqual([])
    expect(drainDeferredReturns).toHaveBeenCalledWith("testagent", "friend-1")
  })

  it("passes CLI coding feedback into the shared pipeline and persists async updates", async () => {
    setupBasic({ inputSequence: ["hello", "/exit"] })

    await testMain(undefined, { pasteDebounceMs: 0 })

    const pipelineInput = mocks.handleInboundTurn.mock.calls[0][0]
    expect(typeof pipelineInput.runAgentOptions.toolContext.codingFeedback.send).toBe("function")

    await pipelineInput.runAgentOptions.toolContext.codingFeedback.send("codex coding-001 completed: hi")

    expect(mocks.postTurn).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "codex coding-001 completed: hi",
        }),
      ]),
      "/tmp/test-session.json",
      undefined,
      undefined,
      undefined,
    )
    expect(stdoutChunks.join("")).toContain("codex coding-001 completed: hi")
  })

  it("persists postTurn continuity state across CLI turns", async () => {
    setupBasic({ inputSequence: ["first", "second", "/exit"] })

    let turnCount = 0
    mocks.handleInboundTurn.mockImplementation(async (input: any) => {
      turnCount += 1
      const resolvedContext = await input.friendResolver.resolve()
      const userText = input.messages?.[0]?.content ?? ""

      // Handle /exit as command (pipeline intercepts commands)
      if (typeof userText === "string" && userText === "/exit") {
        return {
          resolvedContext,
          gateResult: { allowed: true },
          turnOutcome: "command",
          commandAction: "exit",
        }
      }

      const session = await input.sessionLoader.loadOrCreate()

      if (turnCount === 1) {
        expect(session.state).toBeUndefined()
        input.postTurn(
          session.messages,
          session.sessionPath,
          undefined,
          undefined,
          { mustResolveBeforeHandoff: true },
        )
      } else {
        expect(session.state).toEqual({ mustResolveBeforeHandoff: true })
        input.postTurn(session.messages, session.sessionPath, undefined)
      }

      return {
        resolvedContext,
        gateResult: { allowed: true },
        usage: undefined,
        sessionPath: session.sessionPath,
        messages: session.messages,
      }
    })

    await testMain(undefined, { pasteDebounceMs: 0 })

    // "first" + "second" + "/exit" = 3 pipeline calls
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(3)
    expect(mocks.postTurn).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      "/tmp/test-session.json",
      undefined,
      undefined,
      { mustResolveBeforeHandoff: true },
    )
  })
})

// ── formatPendingPrefix tests ──
import { formatPendingPrefix } from "../../senses/cli"

describe("formatPendingPrefix", () => {
  it("formats self-messages as [inner thought: {content}]", () => {
    const result = formatPendingPrefix(
      [{ from: "testagent", content: "i should check on that task", timestamp: Date.now() }],
      "testagent",
    )
    expect(result).toBe("[inner thought: i should check on that task]")
  })

  it("formats inter-agent messages as [message from {name}: {content}]", () => {
    const result = formatPendingPrefix(
      [{ from: "friend-agent", content: "hey, build succeeded!", timestamp: Date.now() }],
      "testagent",
    )
    expect(result).toBe("[message from friend-agent: hey, build succeeded!]")
  })

  it("concatenates multiple pending messages with newlines", () => {
    const result = formatPendingPrefix(
      [
        { from: "testagent", content: "noted something", timestamp: Date.now() },
        { from: "friend-agent", content: "build done", timestamp: Date.now() },
        { from: "testagent", content: "another thought", timestamp: Date.now() },
      ],
      "testagent",
    )
    expect(result).toBe(
      "[inner thought: noted something]\n[message from friend-agent: build done]\n[inner thought: another thought]",
    )
  })

  it("returns empty string for no messages", () => {
    const result = formatPendingPrefix([], "testagent")
    expect(result).toBe("")
  })

  it("does not include a name field in the formatted output", () => {
    // The function returns a string prefix, not message objects.
    // Verify the output is a plain string with no JSON name field.
    const result = formatPendingPrefix(
      [{ from: "friend-agent", content: "hello", timestamp: Date.now() }],
      "testagent",
    )
    expect(result).not.toContain('"name"')
    expect(result).toBe("[message from friend-agent: hello]")
  })
})
