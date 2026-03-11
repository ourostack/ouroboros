// Integration tests for the full per-turn pipeline.
// These test through handleInboundTurn with the REAL enforceTrustGate and
// REAL getChannelCapabilities — mocking only external I/O (fs, runAgent, postTurn).

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks, RunAgentOptions } from "../../heart/core"
import type {
  Channel,
  ChannelCapabilities,
  FriendRecord,
  ResolvedContext,
} from "../../mind/friends/types"
import type { FriendStore } from "../../mind/friends/store"
import type { UsageData } from "../../mind/context"
import type { PendingMessage } from "../../mind/pending"
import { handleInboundTurn } from "../../senses/pipeline"
import type { InboundTurnInput } from "../../senses/pipeline"
import { enforceTrustGate, STRANGER_AUTO_REPLY } from "../../senses/trust-gate"
import { getChannelCapabilities } from "../../mind/friends/channel"
import { getToolsForChannel } from "../../repertoire/tools"
import { parseOuroCommand } from "../../heart/daemon/daemon-cli"

// ── Shared helpers ──────────────────────────────────────────────────

const LOCAL_TOOL_NAMES = new Set(["shell", "read_file", "write_file", "edit_file", "glob", "grep"])

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
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
    ...overrides,
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
  }
}

function makeStore(friend?: FriendRecord): FriendStore {
  const f = friend ?? makeFriend()
  return {
    get: vi.fn().mockResolvedValue(f),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    findByExternalId: vi.fn().mockResolvedValue(f),
    hasAnyFriends: vi.fn().mockResolvedValue(true),
    listAll: vi.fn().mockResolvedValue([f]),
  }
}

const usageData: UsageData = {
  input_tokens: 100,
  output_tokens: 50,
  reasoning_tokens: 10,
  total_tokens: 160,
}

function makeSession() {
  return {
    messages: [{ role: "system" as const, content: "You are helpful." }],
    sessionPath: "/tmp/test-session.json",
  }
}

// Build a full InboundTurnInput using REAL enforceTrustGate (not mocked),
// with all I/O deps mocked.
function makeIntegrationInput(overrides: Partial<InboundTurnInput> = {}): InboundTurnInput {
  const friend = makeFriend()
  const caps = getChannelCapabilities("cli")
  const context: ResolvedContext = { friend, channel: caps }

  return {
    channel: "cli" as Channel,
    capabilities: caps,
    messages: [{ role: "user", content: "hello" }] as ChatCompletionMessageParam[],
    callbacks: makeCallbacks(),
    friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
    sessionLoader: { loadOrCreate: vi.fn().mockResolvedValue(makeSession()) },
    pendingDir: "/tmp/pending",
    friendStore: makeStore(friend),
    // REAL trust gate — the point of integration tests
    enforceTrustGate,
    drainPending: vi.fn().mockReturnValue([] as PendingMessage[]),
    runAgent: vi.fn().mockResolvedValue({ usage: usageData }),
    postTurn: vi.fn(),
    accumulateFriendTokens: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ── Integration scenarios ───────────────────────────────────────────

describe("pipeline integration — full UX/AX scenarios", () => {
  let bundleRoot: string

  beforeEach(() => {
    bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-int-"))
  })

  // ── Scenario 1: Family DMs on BB -> full turn, full tools ─────────

  describe("scenario 1: family DMs on BB", () => {
    it("runs full turn with full tools (pipeline to completion, no tool blocking)", async () => {
      const friend = makeFriend({ trustLevel: "family", name: "Mom" })
      const caps = getChannelCapabilities("bluebubbles")
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeIntegrationInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        friendStore: makeStore(friend),
        // Use real enforceTrustGate — family on open sense should be allowed
      })

      const result = await handleInboundTurn(input)

      // Gate allows
      expect(result.gateResult.allowed).toBe(true)
      // Full pipeline ran
      expect(input.runAgent).toHaveBeenCalledTimes(1)
      expect(input.postTurn).toHaveBeenCalledTimes(1)
      expect(input.accumulateFriendTokens).toHaveBeenCalledTimes(1)
      expect(result.usage).toEqual(usageData)

      // Full tools: family on BB gets all base tools including local ones
      const toolsAvailable = getToolsForChannel(caps, undefined, context)
      const toolNames = toolsAvailable.map((t) => t.function.name)
      for (const localTool of LOCAL_TOOL_NAMES) {
        expect(toolNames).toContain(localTool)
      }
    })
  })

  // ── Scenario 2: Stranger DMs on BB -> auto-reply, no agent turn ───

  describe("scenario 2: stranger DMs on BB", () => {
    it("auto-replies once, no agent turn (runAgent not called), inner notice written", async () => {
      const friend = makeFriend({ trustLevel: "stranger", name: "RandomPerson" })
      const caps = getChannelCapabilities("bluebubbles")
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeIntegrationInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        provider: "imessage-handle",
        externalId: "stranger-int-1",
        // Real trust gate needs bundleRoot for file I/O
        enforceTrustGate: (gateInput) =>
          enforceTrustGate({
            ...gateInput,
            bundleRoot,
            now: () => new Date("2026-03-10T10:00:00.000Z"),
          }),
      })

      const result = await handleInboundTurn(input)

      // Gate rejects with auto-reply
      expect(result.gateResult.allowed).toBe(false)
      if (!result.gateResult.allowed) {
        expect(result.gateResult.reason).toBe("stranger_first_reply")
        expect(result.gateResult.autoReply).toBe(STRANGER_AUTO_REPLY)
      }

      // No agent turn
      expect(input.runAgent).not.toHaveBeenCalled()
      expect(input.postTurn).not.toHaveBeenCalled()
      expect(input.accumulateFriendTokens).not.toHaveBeenCalled()

      // Inner notice was written to pending dir
      const innerPendingDir = path.join(bundleRoot, "state", "pending", "self", "inner", "dialog")
      expect(fs.existsSync(innerPendingDir)).toBe(true)
      const files = fs.readdirSync(innerPendingDir)
      expect(files.length).toBeGreaterThanOrEqual(1)
      const notice = JSON.parse(fs.readFileSync(path.join(innerPendingDir, files[0]), "utf-8"))
      expect(notice.from).toBe("instinct")
      expect(notice.content).toContain("stranger")
    })
  })

  // ── Scenario 3: Same stranger again -> silent drop ────────────────

  describe("scenario 3: same stranger again", () => {
    it("silently drops (no auto-reply, no agent turn)", async () => {
      const friend = makeFriend({ trustLevel: "stranger", name: "RandomPerson" })
      const caps = getChannelCapabilities("bluebubbles")
      const context: ResolvedContext = { friend, channel: caps }
      const gateWithBundle = (gateInput: Parameters<typeof enforceTrustGate>[0]) =>
        enforceTrustGate({
          ...gateInput,
          bundleRoot,
          now: () => new Date("2026-03-10T10:00:00.000Z"),
        })

      // First contact (auto-reply)
      const input1 = makeIntegrationInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        provider: "imessage-handle",
        externalId: "stranger-int-repeat",
        enforceTrustGate: gateWithBundle,
      })
      const result1 = await handleInboundTurn(input1)
      expect(result1.gateResult.allowed).toBe(false)
      if (!result1.gateResult.allowed) {
        expect(result1.gateResult.reason).toBe("stranger_first_reply")
      }

      // Second contact (silent drop)
      const input2 = makeIntegrationInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        provider: "imessage-handle",
        externalId: "stranger-int-repeat",
        enforceTrustGate: gateWithBundle,
      })
      const result2 = await handleInboundTurn(input2)

      expect(result2.gateResult.allowed).toBe(false)
      if (!result2.gateResult.allowed) {
        expect(result2.gateResult.reason).toBe("stranger_silent_drop")
        // No autoReply property on silent drop
        expect("autoReply" in result2.gateResult).toBe(false)
      }

      // No agent turn for either attempt
      expect(input2.runAgent).not.toHaveBeenCalled()
    })
  })

  // ── Scenario 4: Acquaintance DMs on BB (1:1) -> blocked ───────────

  describe("scenario 4: acquaintance DMs on BB (1:1)", () => {
    it("blocks with contextual reply and writes inner notice (no existing group)", async () => {
      const friend = makeFriend({ trustLevel: "acquaintance", name: "WorkBuddy" })
      const caps = getChannelCapabilities("bluebubbles")
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeIntegrationInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        provider: "imessage-handle",
        externalId: "acq-int-1",
        isGroupChat: false,
        hasExistingGroupWithFamily: false,
        enforceTrustGate: (gateInput) =>
          enforceTrustGate({
            ...gateInput,
            bundleRoot,
            now: () => new Date("2026-03-10T10:05:00.000Z"),
          }),
      })

      const result = await handleInboundTurn(input)

      expect(result.gateResult.allowed).toBe(false)
      if (!result.gateResult.allowed) {
        expect(result.gateResult.reason).toBe("acquaintance_1on1_no_group")
        expect(result.gateResult.autoReply).toContain("a group chat")
      }

      // No agent turn
      expect(input.runAgent).not.toHaveBeenCalled()

      // Inner notice written
      const innerPendingDir = path.join(bundleRoot, "state", "pending", "self", "inner", "dialog")
      expect(fs.existsSync(innerPendingDir)).toBe(true)
      const files = fs.readdirSync(innerPendingDir)
      expect(files.length).toBeGreaterThanOrEqual(1)
      const notice = JSON.parse(fs.readFileSync(path.join(innerPendingDir, files[0]), "utf-8"))
      expect(notice.from).toBe("instinct")
      expect(notice.content).toContain("acquaintance")
    })

    it("blocks with 'our group chat' when acquaintance has existing group with family", async () => {
      const friend = makeFriend({ trustLevel: "acquaintance", name: "WorkBuddy" })
      const caps = getChannelCapabilities("bluebubbles")
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeIntegrationInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        provider: "imessage-handle",
        externalId: "acq-int-2",
        isGroupChat: false,
        hasExistingGroupWithFamily: true,
        enforceTrustGate: (gateInput) =>
          enforceTrustGate({
            ...gateInput,
            bundleRoot,
            now: () => new Date("2026-03-10T10:06:00.000Z"),
          }),
      })

      const result = await handleInboundTurn(input)

      expect(result.gateResult.allowed).toBe(false)
      if (!result.gateResult.allowed) {
        expect(result.gateResult.reason).toBe("acquaintance_1on1_has_group")
        expect(result.gateResult.autoReply).toContain("our group chat")
      }
    })
  })

  // ── Scenario 5: Acquaintance in BB group WITH family -> allowed, restricted tools

  describe("scenario 5: acquaintance in BB group with family", () => {
    it("allows through pipeline, but tools are restricted (no local tools)", async () => {
      const friend = makeFriend({ trustLevel: "acquaintance", name: "WorkBuddy" })
      const caps = getChannelCapabilities("bluebubbles")
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeIntegrationInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        friendStore: makeStore(friend),
        isGroupChat: true,
        groupHasFamilyMember: true,
        // Real trust gate with bundleRoot (acquaintance resolves bundleRoot before group check)
        enforceTrustGate: (gateInput) =>
          enforceTrustGate({
            ...gateInput,
            bundleRoot,
            now: () => new Date("2026-03-10T10:08:00.000Z"),
          }),
      })

      const result = await handleInboundTurn(input)

      // Gate allows
      expect(result.gateResult.allowed).toBe(true)
      // Full pipeline ran
      expect(input.runAgent).toHaveBeenCalledTimes(1)
      expect(input.postTurn).toHaveBeenCalledTimes(1)
      expect(input.accumulateFriendTokens).toHaveBeenCalledTimes(1)

      // But tools are restricted — acquaintance on remote channel gets no local tools
      const toolsAvailable = getToolsForChannel(caps, undefined, context)
      const toolNames = toolsAvailable.map((t) => t.function.name)
      for (const localTool of LOCAL_TOOL_NAMES) {
        expect(toolNames).not.toContain(localTool)
      }
    })
  })

  // ── Scenario 6: Acquaintance in BB group WITHOUT family -> blocked ─

  describe("scenario 6: acquaintance in BB group without family", () => {
    it("blocks silently (no auto-reply, no agent turn)", async () => {
      const friend = makeFriend({ trustLevel: "acquaintance", name: "WorkBuddy" })
      const caps = getChannelCapabilities("bluebubbles")
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeIntegrationInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        isGroupChat: true,
        groupHasFamilyMember: false,
        enforceTrustGate: (gateInput) =>
          enforceTrustGate({
            ...gateInput,
            bundleRoot,
            now: () => new Date("2026-03-10T10:10:00.000Z"),
          }),
      })

      const result = await handleInboundTurn(input)

      expect(result.gateResult.allowed).toBe(false)
      if (!result.gateResult.allowed) {
        expect(result.gateResult.reason).toBe("acquaintance_group_no_family")
        // No autoReply for group-no-family
        expect("autoReply" in result.gateResult).toBe(false)
      }
      expect(input.runAgent).not.toHaveBeenCalled()
    })
  })

  // ── Scenario 7: Stranger on Teams -> allowed, restricted tools ────

  describe("scenario 7: stranger on Teams", () => {
    it("allows through gate (closed sense), but tools are restricted", async () => {
      const friend = makeFriend({ trustLevel: "stranger", name: "NewHire" })
      const caps = getChannelCapabilities("teams")
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeIntegrationInput({
        channel: "teams",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        friendStore: makeStore(friend),
        provider: "aad",
        externalId: "aad-stranger-1",
        // Real trust gate — closed sense always allows
      })

      const result = await handleInboundTurn(input)

      // Gate allows (closed sense)
      expect(result.gateResult.allowed).toBe(true)
      // Pipeline ran
      expect(input.runAgent).toHaveBeenCalledTimes(1)
      expect(input.postTurn).toHaveBeenCalledTimes(1)

      // Tools restricted — stranger on remote channel gets no local tools
      const toolsAvailable = getToolsForChannel(caps, undefined, context)
      const toolNames = toolsAvailable.map((t) => t.function.name)
      for (const localTool of LOCAL_TOOL_NAMES) {
        expect(toolNames).not.toContain(localTool)
      }
    })
  })

  // ── Scenario 8: CLI user -> no gate, full tools ───────────────────

  describe("scenario 8: CLI user", () => {
    it("no gate enforcement, full tools regardless of trust level", async () => {
      // Even a stranger on CLI gets full tools (local sense type)
      const friend = makeFriend({ trustLevel: "stranger", name: "TerminalUser" })
      const caps = getChannelCapabilities("cli")
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeIntegrationInput({
        channel: "cli",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        friendStore: makeStore(friend),
        // Real trust gate — CLI/local always allows
      })

      const result = await handleInboundTurn(input)

      // Gate allows
      expect(result.gateResult.allowed).toBe(true)
      // Full pipeline ran
      expect(input.runAgent).toHaveBeenCalledTimes(1)
      expect(input.postTurn).toHaveBeenCalledTimes(1)
      expect(input.accumulateFriendTokens).toHaveBeenCalledTimes(1)

      // Full tools — CLI is not a remote channel, so no blocking
      const toolsAvailable = getToolsForChannel(caps, undefined, context)
      const toolNames = toolsAvailable.map((t) => t.function.name)
      for (const localTool of LOCAL_TOOL_NAMES) {
        expect(toolNames).toContain(localTool)
      }
    })

    it("family on CLI also gets full tools", async () => {
      const friend = makeFriend({ trustLevel: "family", name: "Admin" })
      const caps = getChannelCapabilities("cli")
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeIntegrationInput({
        channel: "cli",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        friendStore: makeStore(friend),
      })

      const result = await handleInboundTurn(input)

      expect(result.gateResult.allowed).toBe(true)
      expect(input.runAgent).toHaveBeenCalledTimes(1)

      const toolsAvailable = getToolsForChannel(caps, undefined, context)
      const toolNames = toolsAvailable.map((t) => t.function.name)
      for (const localTool of LOCAL_TOOL_NAMES) {
        expect(toolNames).toContain(localTool)
      }
    })
  })

  // ── Scenario 9: ouro commands with --agent flag ───────────────────

  describe("scenario 9: ouro commands with --agent flag", () => {
    it("parses whoami --agent slugger", () => {
      const cmd = parseOuroCommand(["whoami", "--agent", "slugger"])
      expect(cmd).toEqual({ kind: "whoami", agent: "slugger" })
    })

    it("parses friend list --agent slugger", () => {
      const cmd = parseOuroCommand(["friend", "list", "--agent", "slugger"])
      expect(cmd).toEqual({ kind: "friend.list", agent: "slugger" })
    })

    it("parses friend show <id> --agent slugger", () => {
      const cmd = parseOuroCommand(["friend", "show", "abc-123", "--agent", "slugger"])
      expect(cmd).toEqual({ kind: "friend.show", friendId: "abc-123", agent: "slugger" })
    })

    it("parses task board --agent slugger", () => {
      const cmd = parseOuroCommand(["task", "board", "--agent", "slugger"])
      expect(cmd).toEqual({ kind: "task.board", agent: "slugger" })
    })

    it("parses task board <status> --agent slugger", () => {
      const cmd = parseOuroCommand(["task", "board", "processing", "--agent", "slugger"])
      expect(cmd).toEqual({ kind: "task.board", status: "processing", agent: "slugger" })
    })

    it("parses session list --agent slugger", () => {
      const cmd = parseOuroCommand(["session", "list", "--agent", "slugger"])
      expect(cmd).toEqual({ kind: "session.list", agent: "slugger" })
    })

    it("parses whoami without --agent (no agent field)", () => {
      const cmd = parseOuroCommand(["whoami"])
      expect(cmd).toEqual({ kind: "whoami" })
      expect((cmd as any).agent).toBeUndefined()
    })

    it("parses friend create --name Bob --trust friend --agent slugger", () => {
      const cmd = parseOuroCommand(["friend", "create", "--name", "Bob", "--trust", "friend", "--agent", "slugger"])
      expect(cmd).toEqual({ kind: "friend.create", name: "Bob", trustLevel: "friend", agent: "slugger" })
    })

    it("parses task create --agent slugger", () => {
      const cmd = parseOuroCommand(["task", "create", "My Task", "--agent", "slugger"])
      expect(cmd).toEqual({ kind: "task.create", title: "My Task", agent: "slugger" })
    })
  })

  // ── Cross-scenario: friend on BB gets full tools (family equivalence) ─

  describe("cross-scenario: friend trust on BB", () => {
    it("friend on BB gets full tools same as family", async () => {
      const friend = makeFriend({ trustLevel: "friend", name: "BestFriend" })
      const caps = getChannelCapabilities("bluebubbles")
      const context: ResolvedContext = { friend, channel: caps }

      const input = makeIntegrationInput({
        channel: "bluebubbles",
        capabilities: caps,
        friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
        friendStore: makeStore(friend),
      })

      const result = await handleInboundTurn(input)

      expect(result.gateResult.allowed).toBe(true)
      expect(input.runAgent).toHaveBeenCalledTimes(1)

      const toolsAvailable = getToolsForChannel(caps, undefined, context)
      const toolNames = toolsAvailable.map((t) => t.function.name)
      for (const localTool of LOCAL_TOOL_NAMES) {
        expect(toolNames).toContain(localTool)
      }
    })
  })

  // ── Cross-scenario: gate + tools consistency matrix ───────────────

  describe("gate + tools consistency matrix", () => {
    const scenarios: Array<{
      label: string
      trustLevel: FriendRecord["trustLevel"]
      channel: Channel
      expectAllowed: boolean
      expectLocalTools: boolean
      isGroupChat?: boolean
      groupHasFamilyMember?: boolean
    }> = [
      { label: "family on BB", trustLevel: "family", channel: "bluebubbles", expectAllowed: true, expectLocalTools: true },
      { label: "friend on BB", trustLevel: "friend", channel: "bluebubbles", expectAllowed: true, expectLocalTools: true },
      { label: "acquaintance on BB 1:1", trustLevel: "acquaintance", channel: "bluebubbles", expectAllowed: false, expectLocalTools: false },
      { label: "stranger on BB", trustLevel: "stranger", channel: "bluebubbles", expectAllowed: false, expectLocalTools: false },
      { label: "family on Teams", trustLevel: "family", channel: "teams", expectAllowed: true, expectLocalTools: true },
      { label: "stranger on Teams", trustLevel: "stranger", channel: "teams", expectAllowed: true, expectLocalTools: false },
      { label: "acquaintance on Teams", trustLevel: "acquaintance", channel: "teams", expectAllowed: true, expectLocalTools: false },
      { label: "family on CLI", trustLevel: "family", channel: "cli", expectAllowed: true, expectLocalTools: true },
      { label: "stranger on CLI", trustLevel: "stranger", channel: "cli", expectAllowed: true, expectLocalTools: true },
      { label: "acquaintance in BB group+family", trustLevel: "acquaintance", channel: "bluebubbles", expectAllowed: true, expectLocalTools: false, isGroupChat: true, groupHasFamilyMember: true },
    ]

    for (const s of scenarios) {
      it(`${s.label}: allowed=${s.expectAllowed}, localTools=${s.expectLocalTools}`, async () => {
        const friend = makeFriend({ trustLevel: s.trustLevel })
        const caps = getChannelCapabilities(s.channel)
        const context: ResolvedContext = { friend, channel: caps }

        const input = makeIntegrationInput({
          channel: s.channel,
          capabilities: caps,
          friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
          friendStore: makeStore(friend),
          isGroupChat: s.isGroupChat,
          groupHasFamilyMember: s.groupHasFamilyMember,
          enforceTrustGate: (gateInput) =>
            enforceTrustGate({
              ...gateInput,
              bundleRoot,
              now: () => new Date("2026-03-10T10:20:00.000Z"),
            }),
        })

        const result = await handleInboundTurn(input)
        expect(result.gateResult.allowed).toBe(s.expectAllowed)

        if (s.expectAllowed) {
          expect(input.runAgent).toHaveBeenCalledTimes(1)
        } else {
          expect(input.runAgent).not.toHaveBeenCalled()
        }

        // Tool availability check
        const toolsAvailable = getToolsForChannel(caps, undefined, context)
        const toolNames = toolsAvailable.map((t) => t.function.name)
        for (const localTool of LOCAL_TOOL_NAMES) {
          if (s.expectLocalTools) {
            expect(toolNames).toContain(localTool)
          } else {
            expect(toolNames).not.toContain(localTool)
          }
        }
      })
    }
  })
})
