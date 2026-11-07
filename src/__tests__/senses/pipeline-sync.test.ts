import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks, RunAgentOptions } from "../../heart/core"
import type { FriendRecord, ResolvedContext, ChannelCapabilities, Channel, FriendStore } from "@ouro.bot/friends"
import type { TrustGateResult } from "../../senses/trust-gate"
import type { UsageData } from "../../mind/context"
import type { PendingMessage } from "../../mind/pending"
import type { InboundTurnInput } from "../../senses/pipeline"
import { resetSharedCommandRegistry, resetDebugMode } from "../../senses/commands"

const mockFindBridgesForSession = vi.fn()
const mockListTargetSessionCandidates = vi.fn()
const mockListCodingSessions = vi.fn()

vi.mock("../../heart/daemon/socket-client", () => ({
  requestInnerWake: vi.fn(async () => null),
  sendDaemonCommand: vi.fn(),
  checkDaemonSocketAlive: vi.fn(),
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
}))

vi.mock("../../heart/bridges/manager", async () => {
  const actual = await vi.importActual<typeof import("../../heart/bridges/manager")>("../../heart/bridges/manager")
  return {
    ...actual,
    createBridgeManager: () => ({
      findBridgesForSession: (...args: any[]) => mockFindBridgesForSession(...args),
    }),
  }
})

vi.mock("../../heart/target-resolution", async () => {
  const actual = await vi.importActual<typeof import("../../heart/target-resolution")>("../../heart/target-resolution")
  return {
    ...actual,
    listTargetSessionCandidates: (...args: any[]) => mockListTargetSessionCandidates(...args),
  }
})

vi.mock("../../repertoire/coding", async () => {
  const actual = await vi.importActual<typeof import("../../repertoire/coding")>("../../repertoire/coding")
  return {
    ...actual,
    getCodingSessionManager: () => ({
      listSessions: (...args: any[]) => mockListCodingSessions(...args),
    }),
  }
})

vi.mock("../../heart/provider-ping", async () => ({
  runHealthInventory: vi.fn(),
}))

// ── Continuity mocks (needed for obligation episode emission coverage) ───
const mockReadPendingObligations = vi.fn().mockReturnValue([])
const mockEmitEpisode = vi.fn()

vi.mock("../../arc/obligations", async () => {
  const actual = await vi.importActual<typeof import("../../arc/obligations")>("../../arc/obligations")
  return {
    ...actual,
    readPendingObligations: (...args: any[]) => mockReadPendingObligations(...args),
  }
})

vi.mock("../../arc/episodes", async () => {
  const actual = await vi.importActual<typeof import("../../arc/episodes")>("../../arc/episodes")
  return {
    ...actual,
    emitEpisode: (...args: any[]) => mockEmitEpisode(...args),
    readRecentEpisodes: vi.fn().mockReturnValue([]),
  }
})

vi.mock("../../arc/cares", async () => {
  const actual = await vi.importActual<typeof import("../../arc/cares")>("../../arc/cares")
  return { ...actual, readActiveCares: vi.fn().mockReturnValue([]) }
})

vi.mock("../../heart/tempo", async () => {
  const actual = await vi.importActual<typeof import("../../heart/tempo")>("../../heart/tempo")
  return {
    ...actual,
    deriveTempo: vi.fn().mockReturnValue({ mode: "brief", significance: "low", reentryDepth: "warm", effectiveBudget: { min: 150, max: 250 } }),
  }
})

vi.mock("../../heart/temporal-view", async () => {
  const actual = await vi.importActual<typeof import("../../heart/temporal-view")>("../../heart/temporal-view")
  return {
    ...actual,
    buildTemporalView: vi.fn().mockReturnValue({ recentEpisodes: [], activeObligations: [], activeCares: [], openIntentions: [], peerPresence: [], tempo: "brief", assembledAt: new Date().toISOString() }),
  }
})

vi.mock("../../heart/start-of-turn-packet", async () => {
  const actual = await vi.importActual<typeof import("../../heart/start-of-turn-packet")>("../../heart/start-of-turn-packet")
  return {
    ...actual,
    buildStartOfTurnPacket: vi.fn().mockReturnValue({ plotLine: "", obligations: "", cares: "", presence: "", resumeHint: "", tempo: "brief", tokenBudget: { min: 150, max: 250 }, assembledAt: new Date().toISOString() }),
    renderStartOfTurnPacket: vi.fn().mockReturnValue(""),
  }
})

vi.mock("../../arc/presence", async () => {
  const actual = await vi.importActual<typeof import("../../arc/presence")>("../../arc/presence")
  return { ...actual, derivePresence: vi.fn().mockReturnValue({}), writePresence: vi.fn() }
})

vi.mock("../../heart/auth/auth-flow", async () => ({
  writeAgentProviderSelection: vi.fn(),
  loadAgentSecrets: vi.fn().mockReturnValue({
    secretsPath: "/mock/secrets.json",
    secrets: { providers: {} },
  }),
}))

const readAgentHomeElsewhereMock = vi.hoisted(() => vi.fn((): { machineId: string; machineName: string; since: string } | null => null))
vi.mock("../../heart/daemon/agent-discovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../heart/daemon/agent-discovery")>(),
  readAgentHomeElsewhere: readAgentHomeElsewhereMock,
}))
const postTurnPushMock = vi.hoisted(() => vi.fn((..._args: any[]): any => ({ ok: true })))
vi.mock("../../heart/sync", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../heart/sync")>(),
  preTurnPull: vi.fn(() => ({ ok: true })),
  postTurnPush: postTurnPushMock,
}))
vi.mock("../../heart/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../heart/config")>(),
  getSyncConfig: vi.fn(() => ({ enabled: true, remote: "origin" })),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/tmp/AgentBundles/testagent.ouro"),
  getAgentBundlesRoot: vi.fn(() => "/tmp/AgentBundles"),
  loadAgentConfig: vi.fn(() => ({
    version: 1,
    enabled: true,
    provider: "anthropic",
    phrases: { thinking: [], tool: [], followup: [] },
  })),
  setAgentName: vi.fn(),
}))

// ── Test helpers ──────────────────────────────────────────────────

function makeFriend(): FriendRecord {
  return {
    id: "friend-1",
    name: "Jordan",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-03-07T00:00:00.000Z",
    updatedAt: "2026-03-07T00:00:00.000Z",
    schemaVersion: 1,
  }
}

function makeCapabilities(): ChannelCapabilities {
  return {
    channel: "cli",
    senseType: "local",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: true,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  }
}

function makeCallbacks(): ChannelCallbacks {
  return {
    onModelStart: vi.fn(),
    onModelStreamStart: vi.fn(),
    onTextChunk: vi.fn(),
    onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
    onClearText: vi.fn(),
  }
}

function makeStore(): FriendStore {
  const f = makeFriend()
  return {
    get: vi.fn().mockResolvedValue(f),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    findByExternalId: vi.fn().mockResolvedValue(f),
    hasAnyFriends: vi.fn().mockResolvedValue(true),
    listAll: vi.fn().mockResolvedValue([f]),
  }
}

function makeInput(overrides: Partial<InboundTurnInput> = {}): InboundTurnInput {
  const friend = makeFriend()
  const caps = makeCapabilities()
  const context: ResolvedContext = { friend, channel: caps }

  return {
    channel: "cli" as Channel,
    capabilities: caps,
    messages: [{ role: "user", content: "hello" }] as ChatCompletionMessageParam[],
    callbacks: makeCallbacks(),
    friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
    sessionLoader: {
      loadOrCreate: vi.fn().mockResolvedValue({
        messages: [{ role: "system", content: "You are helpful." }],
        sessionPath: "/tmp/test-session.json",
      }),
    },
    pendingDir: "/tmp/pending",
    friendStore: makeStore(),
    enforceTrustGate: vi.fn().mockReturnValue({ allowed: true } as TrustGateResult),
    drainPending: vi.fn().mockReturnValue([] as PendingMessage[]),
    runAgent: vi.fn().mockResolvedValue({ usage: {}, outcome: "settled" }),
    postTurn: vi.fn(),
    accumulateFriendTokens: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────

import { baseToolDefinitions, editFileReadTracker } from "../../repertoire/tools-base"
import type { PostTurnPushResult, SyncResult } from "../../heart/sync"

describe("post-turn sync in the turn pipeline", () => {
  beforeEach(() => {
    mockFindBridgesForSession.mockReset().mockReturnValue([])
    mockListTargetSessionCandidates.mockReset().mockResolvedValue([])
    mockListCodingSessions.mockReset().mockReturnValue([])
    readAgentHomeElsewhereMock.mockReset().mockReturnValue(null)
    postTurnPushMock.mockReset().mockReturnValue({ ok: true })
    resetSharedCommandRegistry()
    resetDebugMode()
  })

  it("the reply is delivered before the push resolves", async () => {
    let pushSettled = false
    const push = new Promise<SyncResult>(() => {})
    push.then(() => { pushSettled = true })
    postTurnPushMock.mockReturnValue({ ok: true, push })
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const delivered: string[] = []
    const input = makeInput({
      runAgent: vi.fn(async (_messages: unknown, callbacks: ChannelCallbacks) => {
        callbacks.onTextChunk("hi there")
        return { usage: {} as UsageData, outcome: "settled" }
      }) as never,
    })
    ;(input.callbacks.onTextChunk as ReturnType<typeof vi.fn>).mockImplementation((text: string) => { delivered.push(text) })

    const result = await handleInboundTurn(input)

    expect(delivered).toEqual(["hi there"])
    expect(result.turnOutcome).toBe("settled")
    expect(postTurnPushMock).toHaveBeenCalledWith("/tmp/AgentBundles/testagent.ouro", { enabled: true, remote: "origin" })
    expect(pushSettled).toBe(false)
  })

  it("a sync that throws (EACCES on the lock) is logged and never replaces the turn's result", async () => {
    postTurnPushMock.mockImplementation(() => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }) })
    const nerves = await import("../../nerves/runtime")
    const emit = vi.spyOn(nerves, "emitNervesEvent")
    const { handleInboundTurn, startPostTurnSync } = await import("../../senses/pipeline")
    const input = makeInput({
      runAgent: vi.fn(async (_messages: unknown, callbacks: ChannelCallbacks) => {
        callbacks.onTextChunk("hi there")
        return { usage: {} as UsageData, outcome: "settled" }
      }) as never,
    })

    const result = await handleInboundTurn(input)
    expect(result.turnOutcome).toBe("settled")
    postTurnPushMock.mockImplementation(() => { throw "plain" })
    expect(() => startPostTurnSync("/tmp/AgentBundles/testagent.ouro", { enabled: true, remote: "origin" })).not.toThrow()

    const failed = emit.mock.calls.map(([event]) => event).filter((event) => event.event === "senses.post_turn_sync_error")
    expect(failed.map((event) => event.meta?.error)).toEqual(["EACCES: permission denied", "plain"])
    emit.mockRestore()
  })

  it("a rejected push is logged and never surfaces as an unhandled rejection", async () => {
    const { startPostTurnSync } = await import("../../senses/pipeline")
    const nerves = await import("../../nerves/runtime")
    const emit = vi.spyOn(nerves, "emitNervesEvent")
    let rejectPush: (err: unknown) => void = () => {}
    const push = new Promise<SyncResult>((_resolve, reject) => { rejectPush = reject })
    postTurnPushMock.mockReturnValue({ ok: true, push })

    startPostTurnSync("/tmp/AgentBundles/testagent.ouro", { enabled: true, remote: "origin" })
    rejectPush(new Error("boom"))
    await new Promise((resolve) => setImmediate(resolve))
    rejectPush = () => {}
    postTurnPushMock.mockReturnValue({ ok: true, push: Promise.reject("plain") })
    startPostTurnSync("/tmp/AgentBundles/testagent.ouro", { enabled: true, remote: "origin" })
    await new Promise((resolve) => setImmediate(resolve))

    const rejected = emit.mock.calls.map(([event]) => event).filter((event) => event.event === "senses.post_turn_push_rejected")
    expect(rejected.map((event) => event.meta?.error)).toEqual(["boom", "plain"])
    emit.mockRestore()
  })

  it("does nothing more when no push was started", async () => {
    const { startPostTurnSync } = await import("../../senses/pipeline")
    postTurnPushMock.mockReturnValue({ ok: true, paused: true, pausedUntil: "2026-11-06T00:00:00.000Z" })
    expect(() => startPostTurnSync("/tmp/AgentBundles/testagent.ouro", { enabled: true, remote: "origin" })).not.toThrow()
  })
})

describe("post-turn push against real git", () => {
  const OWNER = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false"]
  let root: string
  let savedHome: string | undefined
  let savedNoSystem: string | undefined

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-sync-")))
    savedHome = process.env.HOME
    savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM
    process.env.HOME = path.join(root, "empty-home")
    fs.mkdirSync(process.env.HOME)
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    editFileReadTracker.clear()
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem
    editFileReadTracker.clear()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("a concurrent edit_file during the push is neither lost nor half-committed", async () => {
    const remote = path.join(root, "remote.git")
    const owner = path.join(root, "owner")
    const agent = path.join(root, "agent.ouro")
    git(root, ["init", "-q", "--bare", "-b", "main", remote])
    git(root, ["clone", "-q", remote, owner])
    git(owner, ["checkout", "-q", "-b", "main"])
    fs.writeFileSync(path.join(owner, ".gitignore"), "state/\n")
    fs.writeFileSync(path.join(owner, "notes.md"), "line one\nline two\nline three\n")
    git(owner, [...OWNER, "add", "-A"])
    git(owner, [...OWNER, "commit", "-q", "-m", "seed"])
    git(owner, [...OWNER, "push", "-q", "-u", "origin", "main"])
    git(root, ["clone", "-q", remote, agent])
    // Hold the push open on the remote side until the test opens the gate.
    const started = path.join(root, "push-started")
    const gate = path.join(root, "push-gate")
    const wrapper = path.join(root, "slow-receive-pack.sh")
    fs.writeFileSync(wrapper, `#!/bin/sh\ntouch '${started}'\nwhile [ ! -f '${gate}' ]; do sleep 0.05; done\nexec git receive-pack "$@"\n`, { mode: 0o755 })
    git(agent, ["config", "remote.origin.receivepack", wrapper])

    const actual = await vi.importActual<typeof import("../../heart/sync")>("../../heart/sync")
    let turn: PostTurnPushResult | undefined
    postTurnPushMock.mockImplementation((agentRoot: string, config: never) => {
      turn = actual.postTurnPush(agentRoot, config, "testagent")
      return turn
    })
    const { startPostTurnSync } = await import("../../senses/pipeline")

    // The turn wrote a journal entry; the pipeline commits it and starts the push.
    fs.writeFileSync(path.join(agent, "journal.md"), "turn one\n")
    startPostTurnSync(agent, { enabled: true, remote: "origin" })
    expect(turn?.ok).toBe(true)
    const turnCommit = git(agent, ["rev-parse", "HEAD"])
    while (!fs.existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 20))

    // The next turn edits a file while that push is still in flight.
    const notes = path.join(agent, "notes.md")
    editFileReadTracker.add(notes)
    const editFile = baseToolDefinitions.find((d) => d.tool.function.name === "edit_file")!.handler
    await editFile({ path: notes, old_string: "line two\n", new_string: "line two, edited\nan added line\n" }, { agentRoot: agent } as never)
    const edited = "line one\nline two, edited\nan added line\nline three\n"
    expect(fs.readFileSync(notes, "utf-8")).toBe(edited)

    fs.writeFileSync(gate, "")
    const pushed = await turn!.push!
    expect(pushed.ok).toBe(true)

    // The push carried the first turn only; the edit is still on disk, uncommitted.
    expect(git(remote, ["--git-dir", remote, "rev-parse", "main"])).toBe(turnCommit)
    expect(git(remote, ["--git-dir", remote, "show", "main:notes.md"])).toBe("line one\nline two\nline three")
    expect(fs.readFileSync(notes, "utf-8")).toBe(edited)
    expect(git(agent, ["status", "--porcelain"])).toBe("M notes.md")

    // The next turn's commit carries the edit whole.
    startPostTurnSync(agent, { enabled: true, remote: "origin" })
    expect((await turn!.push!).ok).toBe(true)
    expect(git(agent, ["show", "--name-only", "--format=", "HEAD"])).toBe("notes.md")
    expect(`${git(remote, ["--git-dir", remote, "show", "main:notes.md"])}\n`).toBe(edited)
    expect(git(agent, ["status", "--porcelain"])).toBe("")
    expect(fs.existsSync(path.join(agent, ".git", "ouro-sync.lock"))).toBe(false)
  }, 30_000)
})
