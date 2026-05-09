import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: vi.fn(),
    createTask: vi.fn(),
    updateStatus: vi.fn(),
    boardStatus: vi.fn(),
    boardAction: vi.fn(),
    boardDeps: vi.fn(),
    boardSessions: vi.fn(),
  }),
}))

const mockRunInnerDialogTurn = vi.fn()
const mockRequestInnerWake = vi.fn()
const mockSendProactiveBlueBubblesMessageToSession = vi.fn()
const mockSendProactiveTeamsMessageToSession = vi.fn()
const mockPlaceConfiguredTwilioPhoneCall = vi.fn()

vi.mock("../../senses/inner-dialog", () => ({
  runInnerDialogTurn: (...args: any[]) => mockRunInnerDialogTurn(...args),
}))

vi.mock("../../heart/daemon/socket-client", () => ({
  requestInnerWake: (...args: any[]) => mockRequestInnerWake(...args),
}))

vi.mock("../../senses/bluebubbles", () => ({
  sendProactiveBlueBubblesMessageToSession: (...args: any[]) =>
    mockSendProactiveBlueBubblesMessageToSession(...args),
}))

vi.mock("../../senses/teams", () => ({
  sendProactiveTeamsMessageToSession: (...args: any[]) =>
    mockSendProactiveTeamsMessageToSession(...args),
}))

vi.mock("../../senses/voice/twilio-phone-runtime", () => ({
  placeConfiguredTwilioPhoneCall: (...args: any[]) =>
    mockPlaceConfiguredTwilioPhoneCall(...args),
}))

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/agent-root"),
  getAgentName: vi.fn(() => "testagent"),
  loadAgentConfig: vi.fn(() => ({
    provider: "anthropic",
    context: { maxTokens: 80000, contextMargin: 20 },
    phrases: { thinking: [], tool: [], followup: [] },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
}))

const mockCreateObligation = vi.fn()
vi.mock("../../arc/obligations", async (importOriginal) => ({
  ...await importOriginal() as any,
  createReturnObligation: (...args: any[]) => mockCreateObligation(...args),
  generateObligationId: vi.fn(() => "1709900001000-testid"),
}))

import * as fs from "fs"

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReset()
  vi.mocked(fs.readFileSync).mockReset()
  vi.mocked(fs.writeFileSync).mockReset()
  vi.mocked(fs.readdirSync).mockReset()
  vi.mocked(fs.mkdirSync).mockReset()
  mockRunInnerDialogTurn.mockReset()
  mockRequestInnerWake.mockReset()
  mockSendProactiveBlueBubblesMessageToSession.mockReset()
  mockSendProactiveTeamsMessageToSession.mockReset()
  mockPlaceConfiguredTwilioPhoneCall.mockReset()
  mockPlaceConfiguredTwilioPhoneCall.mockResolvedValue({
    outboundId: "outbound-test",
    callSid: "CAOUT",
    status: "queued",
    webhookUrl: "https://voice.example.test/voice/agents/testagent/twilio/outgoing/outbound-test",
    statusCallbackUrl: "https://voice.example.test/voice/agents/testagent/twilio/outgoing/outbound-test/status",
  })
  mockRequestInnerWake.mockResolvedValue(null)
  mockEmitNervesEvent.mockReset()
  mockCreateObligation.mockReset()
})

describe("send_message tool", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  function makeTrustedBlueBubblesTurnContext(overrides: Partial<any> = {}): any {
    return {
      currentSession: {
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat:any;-;ari@icloud.com",
        sessionPath: "/mock/agent-root/state/sessions/friend-uuid-1/bluebubbles/chat.json",
      },
      context: {
        friend: {
          id: "friend-uuid-1",
          name: "Ari",
          trustLevel: "friend",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-03-14T00:00:00.000Z",
          updatedAt: "2026-03-14T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: {
          channel: "bluebubbles",
          senseType: "open",
          availableIntegrations: [],
          supportsMarkdown: true,
          supportsStreaming: true,
          supportsRichCards: false,
          maxMessageLength: 1000,
        },
      },
      ...overrides,
    }
  }

  function makeTrustedTeamsTurnContext(overrides: Partial<any> = {}): any {
    return {
      currentSession: {
        friendId: "friend-uuid-1",
        channel: "teams",
        key: "ari-thread",
        sessionPath: "/mock/agent-root/state/sessions/friend-uuid-1/teams/ari-thread.json",
      },
      context: {
        friend: {
          id: "friend-uuid-1",
          name: "Ari",
          trustLevel: "friend",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-03-14T00:00:00.000Z",
          updatedAt: "2026-03-14T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: {
          channel: "teams",
          senseType: "open",
          availableIntegrations: [],
          supportsMarkdown: true,
          supportsStreaming: true,
          supportsRichCards: false,
          maxMessageLength: 1000,
        },
      },
      botApi: { id: "bot-123" },
      ...overrides,
    }
  }

  function mockVoiceFriendRecord(overrides: Partial<any> = {}): any {
    const record = {
      id: "friend-uuid-1",
      name: "Ari",
      trustLevel: "friend",
      externalIds: [
        {
          provider: "imessage-handle",
          externalId: "+15551234567",
          linkedAt: "2026-03-14T00:00:00.000Z",
        },
      ],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-03-14T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z",
      schemaVersion: 1,
      ...overrides,
    }
    vi.mocked(fs.existsSync).mockImplementation((filePath) =>
      String(filePath).endsWith("/friends/friend-uuid-1.json"),
    )
    vi.mocked(fs.readdirSync).mockReturnValue(["friend-uuid-1.json"] as any)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(record))
    return record
  }

  it("is registered in baseToolDefinitions", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")
    expect(tool).toBeDefined()
    expect(tool!.tool.function.parameters).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["friendId", "channel", "content"]),
    })
  })

  it("writes a pending message file", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    const result = await tool.handler({
      friendId: "friend-uuid-1",
      channel: "cli",
      content: "hey, how's the build going?",
    })

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/mock/agent-root/state/pending/friend-uuid-1/cli/session",
      { recursive: true },
    )
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\/mock\/agent-root\/state\/pending\/friend-uuid-1\/cli\/session\/\d+-.+\.json$/),
      expect.any(String),
    )
    // Verify the written content
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written.from).toBe("testagent")
    expect(written.content).toBe("hey, how's the build going?")
    expect(written.channel).toBe("cli")
    expect(result).toContain("queued")
  })

  it("uses custom key when provided", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    await tool.handler({
      friendId: "friend-uuid-1",
      channel: "teams",
      key: "thread-42",
      content: "check this out",
    })

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/mock/agent-root/state/pending/friend-uuid-1/teams/thread-42",
      { recursive: true },
    )
  })

  it("defaults key to 'session'", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    await tool.handler({
      friendId: "friend-uuid-1",
      channel: "cli",
      content: "hello",
    })

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/mock/agent-root/state/pending/friend-uuid-1/cli/session",
      { recursive: true },
    )
  })

  it("includes timestamp in pending file content", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    await tool.handler({
      friendId: "friend-uuid-1",
      channel: "cli",
      content: "time check",
    })

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written.timestamp).toBeDefined()
    expect(typeof written.timestamp).toBe("number")
  })

  it("keeps generic outreach on truthful queued status instead of echoing the full outbound body", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    const longContent = "a".repeat(100)
    const result = await tool.handler({
      friendId: "friend-uuid-1",
      channel: "cli",
      content: longContent,
    })

    expect(result.toLowerCase()).toContain("queued for later")
    expect(result).not.toContain("a".repeat(100))
  })

  it("delivers immediately for a trusted explicit cross-chat request instead of only pretending the message queued", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: true })

    const result = await tool.handler({
      friendId: "group-uuid",
      channel: "bluebubbles",
      key: "chat:any;+;project-group-123",
      content: "tell the group the plan changed",
    }, {
      currentSession: {
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat:any;-;ari@icloud.com",
        sessionPath: "/mock/agent-root/state/sessions/friend-uuid-1/bluebubbles/chat.json",
      },
      context: {
        friend: {
          id: "friend-uuid-1",
          name: "Ari",
          trustLevel: "friend",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-03-14T00:00:00.000Z",
          updatedAt: "2026-03-14T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: {
          channel: "bluebubbles",
          senseType: "open",
          availableIntegrations: [],
          supportsMarkdown: true,
          supportsStreaming: true,
          supportsRichCards: false,
          maxMessageLength: 1000,
        },
      } as any,
    } as any)

    expect(result).toContain("delivered")
    expect(result).not.toContain("queued for delivery")
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it("returns a blocked result when an untrusted asking chat tries to force explicit cross-chat delivery", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    const result = await tool.handler({
      friendId: "group-uuid",
      channel: "bluebubbles",
      key: "chat:any;+;project-group-123",
      content: "tell the group the plan changed",
    }, {
      currentSession: {
        friendId: "friend-uuid-2",
        channel: "bluebubbles",
        key: "chat:any;-;new-person@icloud.com",
        sessionPath: "/mock/agent-root/state/sessions/friend-uuid-2/bluebubbles/chat.json",
      },
      context: {
        friend: {
          id: "friend-uuid-2",
          name: "New Person",
          trustLevel: "acquaintance",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-03-14T00:00:00.000Z",
          updatedAt: "2026-03-14T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: {
          channel: "bluebubbles",
          senseType: "open",
          availableIntegrations: [],
          supportsMarkdown: true,
          supportsStreaming: true,
          supportsRichCards: false,
          maxMessageLength: 1000,
        },
      } as any,
    } as any)

    expect(result.toLowerCase()).toContain("blocked")
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(mockSendProactiveBlueBubblesMessageToSession).not.toHaveBeenCalled()
  })

  it("reports queued-for-later truthfully when live cross-chat delivery is unavailable", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    const result = await tool.handler({
      friendId: "friend-uuid-3",
      channel: "cli",
      key: "session",
      content: "carry this over later",
    }, {
      currentSession: {
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat:any;-;ari@icloud.com",
        sessionPath: "/mock/agent-root/state/sessions/friend-uuid-1/bluebubbles/chat.json",
      },
      context: {
        friend: {
          id: "friend-uuid-1",
          name: "Ari",
          trustLevel: "friend",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-03-14T00:00:00.000Z",
          updatedAt: "2026-03-14T00:00:00.000Z",
          schemaVersion: 1,
        },
        channel: {
          channel: "bluebubbles",
          senseType: "open",
          availableIntegrations: [],
          supportsMarkdown: true,
          supportsStreaming: true,
          supportsRichCards: false,
          maxMessageLength: 1000,
        },
      } as any,
    } as any)

    expect(result.toLowerCase()).toContain("queued")
    expect(result.toLowerCase()).not.toContain("delivered now")
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\/mock\/agent-root\/state\/pending\/friend-uuid-3\/cli\/session\/\d+-.+\.json$/),
      expect.any(String),
    )
  })

  it("reports a blocked result when bluebubbles cannot resolve a routable target", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "missing_target" })

    const result = await tool.handler({
      friendId: "group-uuid",
      channel: "bluebubbles",
      key: "chat:any;+;missing-group",
      content: "tell the group this could not route",
    }, makeTrustedBlueBubblesTurnContext())

    expect(result.toLowerCase()).toContain("blocked")
    expect(result).toContain("could not resolve a routable target")
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it("returns a blocked result without queuing when bluebubbles reports blocked_meta_content", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "blocked_meta_content" })

    const result = await tool.handler({
      friendId: "group-uuid",
      channel: "bluebubbles",
      key: "chat:any;+;project-group-123",
      content: "[surfaced from inner dialog] should not leak",
    }, makeTrustedBlueBubblesTurnContext())

    expect(result.toLowerCase()).toContain("blocked")
    expect(result).toContain("blocked: contains internal meta markers")
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it("reports a failed result when bluebubbles live send errors", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "send_error" })

    const result = await tool.handler({
      friendId: "group-uuid",
      channel: "bluebubbles",
      key: "chat:any;+;project-group-123",
      content: "this live send will fail",
    }, makeTrustedBlueBubblesTurnContext())

    expect(result.toLowerCase()).toContain("failed")
    expect(result).toContain("bluebubbles send failed")
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it("falls back to truthful queued status when bluebubbles live delivery is unavailable", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "trust_skip" })

    const result = await tool.handler({
      friendId: "group-uuid",
      channel: "bluebubbles",
      key: "chat:any;+;project-group-123",
      content: "queue this for the next active turn",
    }, makeTrustedBlueBubblesTurnContext())

    expect(result.toLowerCase()).toContain("queued for later")
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\/mock\/agent-root\/state\/pending\/group-uuid\/bluebubbles\/chat:any;\+\;project-group-123\/\d+-.+\.json$/),
      expect.any(String),
    )
  })

  it("reports delivered-now truthfully for a trusted explicit teams cross-chat request", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!
    mockSendProactiveTeamsMessageToSession.mockResolvedValue({ delivered: true })

    const result = await tool.handler({
      friendId: "friend-uuid-4",
      channel: "teams",
      key: "target-thread",
      content: "carry this into Teams right now",
    }, makeTrustedTeamsTurnContext())

    expect(result.toLowerCase()).toContain("delivered")
    expect(result).toContain("sent to the active teams chat now")
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it("reports a blocked result when teams cannot resolve a routable target", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!
    mockSendProactiveTeamsMessageToSession.mockResolvedValue({ delivered: false, reason: "missing_target" })

    const result = await tool.handler({
      friendId: "friend-uuid-4",
      channel: "teams",
      key: "target-thread",
      content: "this teams send has no route",
    }, makeTrustedTeamsTurnContext())

    expect(result.toLowerCase()).toContain("blocked")
    expect(result).toContain("teams could not resolve a routable target")
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it("reports a failed result when teams live send errors", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!
    mockSendProactiveTeamsMessageToSession.mockResolvedValue({ delivered: false, reason: "send_error" })

    const result = await tool.handler({
      friendId: "friend-uuid-4",
      channel: "teams",
      key: "target-thread",
      content: "this teams send will fail",
    }, makeTrustedTeamsTurnContext())

    expect(result.toLowerCase()).toContain("failed")
    expect(result).toContain("teams send failed")
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it("falls back to truthful queued status when teams live delivery is unavailable", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    const result = await tool.handler({
      friendId: "friend-uuid-4",
      channel: "teams",
      key: "target-thread",
      content: "queue this teams message for later",
    }, makeTrustedTeamsTurnContext({ botApi: undefined }))

    expect(result.toLowerCase()).toContain("queued for later")
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\/mock\/agent-root\/state\/pending\/friend-uuid-4\/teams\/target-thread\/\d+-.+\.json$/),
      expect.any(String),
    )
  })

  it("falls back to truthful queued status when teams adapter reports undelivered without a specific reason", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!
    mockSendProactiveTeamsMessageToSession.mockResolvedValue({ delivered: false })

    const result = await tool.handler({
      friendId: "friend-uuid-4",
      channel: "teams",
      key: "target-thread",
      content: "queue this teams message when the adapter cannot say more",
    }, makeTrustedTeamsTurnContext())

    expect(result.toLowerCase()).toContain("queued for later")
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\/mock\/agent-root\/state\/pending\/friend-uuid-4\/teams\/target-thread\/\d+-.+\.json$/),
      expect.any(String),
    )
  })

  it("places a voice call for send_message channel=voice instead of queuing text", async () => {
    mockVoiceFriendRecord()
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    const result = await tool.handler({
      friendId: "ari",
      channel: "voice",
      key: "twilio-phone-ari-via-15551234567",
      content: "call Ari and say hello",
      voiceAudioSource: "tone",
      voiceAudioLabel: "hello tone",
      voiceAudioToneHz: "440",
      voiceAudioDurationMs: "80",
    })

    expect(result.toLowerCase()).toContain("delivered now")
    expect(result).toContain("voice call initiated")
    expect(mockPlaceConfiguredTwilioPhoneCall).toHaveBeenCalledWith({
      agentName: "testagent",
      friendId: "friend-uuid-1",
      to: "+15551234567",
      reason: "call Ari and say hello",
      initialAudio: {
        source: "tone",
        label: "hello tone",
        toneHz: 440,
        durationMs: 80,
      },
    })
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it("blocks send_message channel=voice to untrusted friends without queuing a fallback", async () => {
    mockVoiceFriendRecord({ trustLevel: "stranger" })
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    const result = await tool.handler({
      friendId: "ari",
      channel: "voice",
      content: "call Ari anyway",
    })

    expect(result.toLowerCase()).toContain("blocked")
    expect(result).toContain("voice calls are limited to trusted friends")
    expect(mockPlaceConfiguredTwilioPhoneCall).not.toHaveBeenCalled()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it("blocks send_message channel=voice when no phone number is available", async () => {
    mockVoiceFriendRecord({ externalIds: [] })
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    const result = await tool.handler({
      friendId: "ari",
      channel: "voice",
      content: "call Ari without a number",
    })

    expect(result.toLowerCase()).toContain("blocked")
    expect(result).toContain("no phone number is available for voice call")
    expect(mockPlaceConfiguredTwilioPhoneCall).not.toHaveBeenCalled()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  describe("self-routing special case", () => {
    it("routes friendId='self' to inner dialog pending dir regardless of channel", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "teams",
        content: "note to self",
      })

      // Self always routes to inner dialog pending dir, NOT to the specified channel
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        "/mock/agent-root/state/pending/self/inner/dialog",
        { recursive: true },
      )
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/^\/mock\/agent-root\/state\/pending\/self\/inner\/dialog\/\d+-.+\.json$/),
        expect.any(String),
      )
    })

    it("routes friendId='self' with channel='cli' to inner dialog pending dir", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "keep this for later",
      })

      // Even when channel is 'cli', self goes to inner dialog
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        "/mock/agent-root/state/pending/self/inner/dialog",
        { recursive: true },
      )
    })

    it("routes friendId='self' with channel='bluebubbles' to inner dialog pending dir", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "bluebubbles",
        content: "a thought for myself",
      })

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        "/mock/agent-root/state/pending/self/inner/dialog",
        { recursive: true },
      )
    })

    it("preserves original friendId and channel in the written envelope even when self-routed", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "teams",
        content: "note to self",
      })

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
      expect(written.from).toBe("testagent")
      expect(written.friendId).toBe("self")
      expect(written.channel).toBe("teams")
      expect(written.content).toBe("note to self")
    })

    it("tags outward delegated self-messages with the originating friend session and bridge", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "bluebubbles",
        content: "think this through",
      }, {
        currentSession: {
          friendId: "friend-uuid-1",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/mock/agent-root/state/sessions/friend-uuid-1/bluebubbles/chat.json",
        },
        activeBridges: [
          {
            id: "bridge-1",
            objective: "carry Ari across cli and bluebubbles",
            summary: "same work, two surfaces",
            lifecycle: "active",
            runtime: "idle",
            createdAt: "2026-03-13T20:00:00.000Z",
            updatedAt: "2026-03-13T20:00:00.000Z",
            attachedSessions: [
              {
                friendId: "friend-uuid-1",
                channel: "bluebubbles",
                key: "chat",
                sessionPath: "/mock/agent-root/state/sessions/friend-uuid-1/bluebubbles/chat.json",
              },
            ],
            task: null,
          },
        ],
      } as any)

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
      expect(written.delegatedFrom).toEqual({
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat",
        bridgeId: "bridge-1",
      })
    })

    it("tags outward delegated self-messages without a bridge id when no active bridge matches", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "bluebubbles",
        content: "think this through too",
      }, {
        currentSession: {
          friendId: "friend-uuid-1",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/mock/agent-root/state/sessions/friend-uuid-1/bluebubbles/chat.json",
        },
        activeBridges: [],
      } as any)

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
      expect(written.delegatedFrom).toEqual({
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat",
      })
    })

    it("keeps purely inner self-thought private by omitting delegated origin metadata", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "inner",
        content: "private thought",
      }, {
        currentSession: {
          friendId: "self",
          channel: "inner",
          key: "dialog",
          sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
        },
      } as any)

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
      expect(written.delegatedFrom).toBeUndefined()
    })

    it("creates a return obligation with obligationId when delegating from outer session", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "inner",
        content: "think about penguins",
      }, {
        currentSession: {
          friendId: "friend-uuid-1",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/mock/agent-root/state/sessions/friend-uuid-1/bluebubbles/chat.json",
        },
        activeBridges: [],
      } as any)

      expect(mockCreateObligation).toHaveBeenCalledWith(
        "testagent",
        expect.objectContaining({
          id: "1709900001000-testid",
          origin: { friendId: "friend-uuid-1", channel: "bluebubbles", key: "chat" },
          status: "queued",
          delegatedContent: "think about penguins",
        }),
      )

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
      expect(written.obligationId).toBe("1709900001000-testid")
    })

    it("truncates long delegated content in obligation to 120 characters", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      const longContent = "a".repeat(200)
      await tool.handler({
        friendId: "self",
        channel: "inner",
        content: longContent,
      }, {
        currentSession: {
          friendId: "friend-uuid-1",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/mock/agent-root/state/sessions/friend-uuid-1/bluebubbles/chat.json",
        },
        activeBridges: [],
      } as any)

      expect(mockCreateObligation).toHaveBeenCalledWith(
        "testagent",
        expect.objectContaining({
          delegatedContent: "a".repeat(117) + "...",
        }),
      )
    })

    it("does not create an obligation for inner-to-inner self messages", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "inner",
        content: "private thought",
      }, {
        currentSession: {
          friendId: "self",
          channel: "inner",
          key: "dialog",
          sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
        },
      } as any)

      expect(mockCreateObligation).not.toHaveBeenCalled()
    })

    it("does NOT self-route when friendId is a regular UUID", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      // existsSync returns true for session dir so name resolution is skipped
      vi.mocked(fs.existsSync).mockReturnValue(true)
      // BB deliverer returns trust_skip so delivery falls through to queuing
      mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "trust_skip" })

      await tool.handler({
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        content: "hey friend",
      })

      // Regular friend routes to the specified channel, NOT inner dialog
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        "/mock/agent-root/state/pending/friend-uuid-1/bluebubbles/session",
        { recursive: true },
      )
    })

    it("self-routing ignores custom key and always uses 'dialog'", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "cli",
        key: "custom-key",
        content: "internal thought",
      })

      // Self always routes to inner/dialog, ignoring the custom key
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        "/mock/agent-root/state/pending/self/inner/dialog",
        { recursive: true },
      )
    })

    it("confirmation message mentions self routing", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      const result = await tool.handler({
        friendId: "self",
        channel: "teams",
        content: "keep this",
      })

      // Should indicate inward routing, not the original outward channel
      expect(result).toContain("inner")
      expect(result).toContain("queued to inner/dialog")
    })

    it("falls back to an immediate inner turn when no daemon wake path is available", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRunInnerDialogTurn.mockResolvedValue({
        messages: [{ role: "assistant", content: "penguins surfaced." }],
        sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      })

      const result = await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "think about penguins",
      })

      expect(mockRunInnerDialogTurn).toHaveBeenCalledTimes(1)
      expect(result).toBe([
        "inner work: completed",
        "queued to inner/dialog",
        "wake: inline fallback",
        "penguins surfaced.",
      ].join("\n"))
    })

    it("uses daemon-managed wake when available and skips the inline fallback", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRequestInnerWake.mockResolvedValue({
        ok: true,
        message: "woke inner dialog for testagent",
      })

      const result = await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "notice this now",
      })

      expect(mockRequestInnerWake).toHaveBeenCalledWith("testagent")
      expect(mockRunInnerDialogTurn).not.toHaveBeenCalled()
      expect(result).toBe("i've queued this thought for private attention. it'll come up when my inner dialog is free.")
    })

    it("falls back to an immediate inner turn when daemon wake rejects", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRequestInnerWake.mockRejectedValue(new Error("socket unavailable"))
      mockRunInnerDialogTurn.mockResolvedValue({
        messages: [{ role: "assistant", content: "picked up inline." }],
        sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      })

      await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "keep thinking",
      })

      expect(mockRunInnerDialogTurn).toHaveBeenCalledTimes(1)
    })

    it("surfaces inline fallback failures instead of masking them as queued success", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRunInnerDialogTurn.mockRejectedValue(new Error("inner dialog failed"))

      await expect(tool.handler({
        friendId: "self",
        channel: "cli",
        content: "keep going",
      })).rejects.toThrow("inner dialog failed")
    })

    it("reports no outward result when the inline fallback finishes without assistant text", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRunInnerDialogTurn.mockResolvedValue({
        messages: [],
        sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      })

      const result = await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "sit with this quietly",
      })

      expect(result).toContain("inner work: completed")
      expect(result).toContain("queued to inner/dialog")
      expect(result).toContain("wake: inline fallback")
      expect(result).toContain("no outward result")
    })

    it("reports no outward result when the inline fallback returns without a messages payload", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRunInnerDialogTurn.mockResolvedValue(undefined)

      const result = await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "hold this lightly",
      })

      expect(result).toContain("inner work: completed")
      expect(result).toContain("queued to inner/dialog")
      expect(result).toContain("wake: inline fallback")
      expect(result).toContain("no outward result")
    })

    it("truncates long surfaced previews in the inline fallback response", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRunInnerDialogTurn.mockResolvedValue({
        messages: [{ role: "assistant", content: "a".repeat(160) }],
        sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      })

      const result = await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "stretch the preview",
      })

      expect(result).toContain("inner work: completed")
      expect(result).toContain("queued to inner/dialog")
      expect(result).toContain("wake: inline fallback")
      expect(result).toContain("...")
      expect(result).not.toContain("a".repeat(160))
    })

    it("extracts surfaced previews from structured assistant content arrays", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRunInnerDialogTurn.mockResolvedValue({
        messages: [{
          role: "assistant",
          content: [
            "penguins",
            { type: "text", text: "formal little blokes" },
            { type: "image_url", image_url: { url: "https://example.test/penguin.png" } },
          ] as any,
        }],
        sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      })

      const result = await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "let the image-thought settle",
      })

      expect(result).toContain("inner work: completed")
      expect(result).toContain("queued to inner/dialog")
      expect(result).toContain("wake: inline fallback")
      expect(result).toContain("penguins")
    })

    it("extracts surfaced previews from settle-only inner turns", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRunInnerDialogTurn.mockResolvedValue({
        messages: [{
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tc_1",
              type: "function",
              function: {
                name: "settle",
                arguments: JSON.stringify({
                  answer: "formal little blokes",
                  intent: "complete",
                }),
              },
            },
          ],
        }],
        sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      })

      const result = await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "let the thought conclude cleanly",
      })

      expect(result).toContain("inner work: completed")
      expect(result).toContain("queued to inner/dialog")
      expect(result).toContain("wake: inline fallback")
      expect(result).toContain("formal little blokes")
    })

    it("treats non-array assistant content as no outward result", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRunInnerDialogTurn.mockResolvedValue({
        messages: [{
          role: "assistant",
          content: { type: "text", text: "not in the expected array shape" } as any,
        }],
        sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      })

      const result = await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "hold a strangely-shaped reply",
      })

      expect(result).toContain("inner work: completed")
      expect(result).toContain("queued to inner/dialog")
      expect(result).toContain("wake: inline fallback")
      expect(result).toContain("no outward result")
    })

    it("sets obligationStatus to 'pending' on the envelope when self-routing with delegatedFrom", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "bluebubbles",
        content: "think this through",
      }, {
        currentSession: {
          friendId: "friend-uuid-1",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/mock/agent-root/state/sessions/friend-uuid-1/bluebubbles/chat.json",
        },
        activeBridges: [],
      } as any)

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
      expect(written.obligationStatus).toBe("pending")
    })

    it("does NOT set obligationStatus when self-routing without delegatedFrom", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "inner",
        content: "private thought",
      }, {
        currentSession: {
          friendId: "self",
          channel: "inner",
          key: "dialog",
          sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
        },
      } as any)

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
      expect(written.obligationStatus).toBeUndefined()
    })

    it("emits repertoire.obligation_created nerves event when obligation is created", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "bluebubbles",
        content: "reflect on this",
      }, {
        currentSession: {
          friendId: "friend-uuid-1",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/mock/agent-root/state/sessions/friend-uuid-1/bluebubbles/chat.json",
        },
        activeBridges: [],
      } as any)

      const obligationEvent = mockEmitNervesEvent.mock.calls.find(
        (call: any[]) => call[0]?.event === "repertoire.obligation_created",
      )
      expect(obligationEvent).toBeDefined()
      expect(obligationEvent![0].component).toBe("repertoire")
      expect(obligationEvent![0].meta).toEqual(expect.objectContaining({
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat",
      }))
    })

    it("does NOT emit obligation_created when self-routing without delegatedFrom", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "inner",
        content: "private thought",
      }, {
        currentSession: {
          friendId: "self",
          channel: "inner",
          key: "dialog",
          sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
        },
      } as any)

      const obligationEvent = mockEmitNervesEvent.mock.calls.find(
        (call: any[]) => call[0]?.event === "repertoire.obligation_created",
      )
      expect(obligationEvent).toBeUndefined()
    })

    it("defers the inline fallback to a microtask when already in inner dialog", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!
      const queuedCallbacks: Array<() => void> = []
      const queueMicrotaskSpy = vi
        .spyOn(globalThis, "queueMicrotask")
        .mockImplementation((callback: VoidFunction) => {
          queuedCallbacks.push(callback)
        })

      mockRunInnerDialogTurn.mockResolvedValue({
        messages: [{ role: "assistant", content: "i kept the thread alive." }],
        sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      })

      await tool.handler(
        {
          friendId: "self",
          channel: "inner",
          content: "stay with this",
        },
        {
          context: {
            friend: {} as any,
            channel: { channel: "inner" } as any,
          },
          signin: async () => undefined,
        },
      )

      expect(queueMicrotaskSpy).toHaveBeenCalledTimes(1)
      expect(mockRunInnerDialogTurn).not.toHaveBeenCalled()
      queuedCallbacks[0]?.()
      expect(mockRunInnerDialogTurn).toHaveBeenCalledTimes(1)
      queueMicrotaskSpy.mockRestore()
    })
  })
})
