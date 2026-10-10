import { describe, expect, it, vi } from "vitest"
import { getChannelCapabilities, type ResolvedContext } from "@ouro.bot/friends"
import { selectToolsForChannel } from "../../repertoire/tools"
import type { ToolContext } from "../../repertoire/tools-base"
import {
  createVoiceLocalAudioToolDefinition,
  defaultLocalAudioToolDeps,
  localAudioToolGate,
  ownerConsentsToSilentJoin,
  voiceLocalAudioToolDefinition,
  type LocalAudioToolDeps,
} from "../../repertoire/tools-voice-local"

const join = vi.hoisted(() => ({
  launchLocalAudioJoin: vi.fn(async () => ({ ok: true, message: "launched" })),
  defaultLaunchSpawn: vi.fn(() => vi.fn()),
  runLocalAudioLeave: vi.fn(async () => "left"),
  runLocalAudioStatus: vi.fn(async () => "status"),
}))
vi.mock("../../senses/voice/local-audio-join", () => join)

const NAME = "voice_join_local_audio"

function resolved(options: { trust?: string; channel?: string; group?: boolean; name?: string } = {}): ResolvedContext {
  return {
    friend: { id: "ari", name: options.name ?? "Ari", trustLevel: options.trust ?? "family", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "", updatedAt: "", schemaVersion: 1 },
    channel: getChannelCapabilities((options.channel ?? "cli") as never),
    isGroupChat: options.group ?? false,
  } as unknown as ResolvedContext
}

function names(context: ResolvedContext | undefined, extra: Record<string, unknown> = {}): string[] {
  const capabilities = context ? context.channel : getChannelCapabilities("cli")
  return selectToolsForChannel(capabilities, undefined, context, undefined, undefined, undefined, { ...extra } as never)
    .ordinary.map((definition) => definition.tool.function.name)
}

describe("voice_join_local_audio is offered only in a direct family text session", () => {
  it("is offered to family on every direct text channel", () => {
    for (const channel of ["cli", "bluebubbles", "telegram"]) {
      expect(names(resolved({ channel }))).toContain(NAME)
    }
  })

  it("is never offered in Teams, which cannot confirm a one-to-one chat", () => {
    expect(names(resolved({ channel: "teams" }))).not.toContain(NAME)
    expect(localAudioToolGate({ context: resolved({ channel: "teams" }) })).toMatchObject({ ok: false, reason: expect.stringMatching(/Teams cannot confirm/) })
  })

  it("is never offered on voice, inner, mail, a2a, mcp, or in a group chat", () => {
    for (const channel of ["voice", "inner", "mail", "a2a", "mcp"]) {
      expect(names(resolved({ channel })), channel).not.toContain(NAME)
    }
    expect(names(resolved({ group: true }))).not.toContain(NAME)
  })

  it("is never offered below family trust, or without a resolved friend", () => {
    for (const trust of ["friend", "acquaintance", "stranger"]) expect(names(resolved({ trust }))).not.toContain(NAME)
    expect(names(undefined)).not.toContain(NAME)
  })

  it("is never offered to autonomous, delegated, external-event or relationship-scoped turns", () => {
    const context = resolved()
    expect(names(context, { habitSession: { toolPolicy: { outwardMessagingAllowed: true, grantedTools: [] } } })).not.toContain(NAME)
    for (const kind of ["await", "habit", "external-event", "instinct", "scheduler"]) {
      expect(names(context, { autonomousTurnKind: kind }), kind).not.toContain(NAME)
    }
    expect(names(context, { currentExternalEvent: { eventId: "e" } })).not.toContain(NAME)
    expect(names(context, { delegatedCommand: { commandId: "c" } })).not.toContain(NAME)
    expect(names(context, { voiceCall: { requestEnd: vi.fn() } })).not.toContain(NAME)
    expect(names(context, { relationshipAuthorization: { profileId: "p", advertisedToolNames: [NAME] } })).not.toContain(NAME)
  })

  it("declares no device arguments", () => {
    const properties = Object.keys((voiceLocalAudioToolDefinition.tool.function.parameters as { properties: object }).properties)
    expect(properties.sort()).toEqual(["action", "occasion", "owner_alone", "participants", "silent_consent"])
  })

  it("explains each reason the gate says no", () => {
    expect(localAudioToolGate({ context: undefined })).toMatchObject({ ok: false, reason: expect.stringMatching(/friend/i) })
    expect(localAudioToolGate({ context: { channel: resolved().channel } as never })).toMatchObject({ ok: false, reason: expect.stringMatching(/friend/i) })
    expect(localAudioToolGate({ context: { friend: resolved().friend } as never })).toMatchObject({ ok: false, reason: expect.stringMatching(/friend/i) })
    expect(localAudioToolGate({ context: resolved({ trust: "friend" }) })).toMatchObject({ ok: false, reason: expect.stringMatching(/family/i) })
    expect(localAudioToolGate({ context: resolved({ channel: "voice" }) })).toMatchObject({ ok: false, reason: expect.stringMatching(/direct text/i) })
    expect(localAudioToolGate({ context: resolved({ group: true }) })).toMatchObject({ ok: false, reason: expect.stringMatching(/group/i) })
    expect(localAudioToolGate({ context: resolved(), autonomousTurnKind: "habit" })).toMatchObject({ ok: false, reason: expect.stringMatching(/automatic|autonomous/i) })
    expect(localAudioToolGate({ context: resolved() })).toEqual({ ok: true })
  })
})

function makeDeps(): LocalAudioToolDeps & { launch: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  return {
    launch: vi.fn(async () => ({ ok: true, callSid: "local-audio-abc", message: "Joined local audio session local-audio-abc." })),
    leave: vi.fn(async () => "Left local audio session local-audio-abc."),
    status: vi.fn(async () => "Local audio session local-audio-abc is joined."),
  }
}

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    signin: async () => undefined,
    agentName: "slugger",
    context: resolved(),
    currentSession: { friendId: "ari", channel: "cli", key: "session", sessionPath: "/x" },
    ...extra,
  } as ToolContext
}

describe("voice_join_local_audio handler", () => {
  it("launches a join for the owner with the stated facts and the current session as the notify target", async () => {
    const deps = makeDeps()
    const handler = createVoiceLocalAudioToolDefinition(deps).handler
    const result = await handler({ participants: "Ari and Sam", occasion: "podcast prep", owner_alone: false }, ctx())
    expect(deps.launch).toHaveBeenCalledWith({
      agentName: "slugger", friendId: "ari", participants: "Ari and Sam", occasion: "podcast prep", mode: "conversation",
      ownerName: "Ari", notify: { friendId: "ari", channel: "cli", key: "session" },
    })
    expect(result).toContain("local-audio-abc")
    expect(result).toMatch(/BlackHole 2ch/)
  })

  it("passes owner-alone, and a silent-consent statement only when the owner's current message contains it verbatim", async () => {
    const deps = makeDeps()
    const handler = createVoiceLocalAudioToolDefinition(deps).handler
    const consent = "Everyone agreed to a silent join with no announcement."
    await handler({ owner_alone: true, silent_consent: consent }, ctx({ currentUserMessage: `Join the call. ${consent} Thanks!` }))
    expect(deps.launch).toHaveBeenCalledWith(expect.objectContaining({ ownerAlone: true, silentConsent: consent }))
    const result = await handler({ owner_alone: true }, ctx({ currentUserMessage: "join" }))
    expect(result).toContain("local-audio-abc")
    expect(deps.launch.mock.calls.at(-1)![0]).not.toHaveProperty("silentConsent")
  })

  it("refuses a silent join when the consent statement is not in the owner's own current message, or the message is unavailable", async () => {
    const deps = makeDeps()
    const handler = createVoiceLocalAudioToolDefinition(deps).handler
    for (const currentUserMessage of ["join the call please", undefined, ""]) {
      const result = await handler({ silent_consent: "everyone agreed" }, ctx({ currentUserMessage }))
      expect(result).toMatch(/silent join/i)
      expect(result).toMatch(/--silent-consent|owner's own words|announce/i)
    }
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it("matches a whole consent sentence ignoring whitespace, case and end punctuation", async () => {
    const deps = makeDeps()
    await createVoiceLocalAudioToolDefinition(deps).handler({ silent_consent: "everyone   consented to a silent join" }, ctx({ currentUserMessage: "ok, join.\nEveryone consented to a silent join!" }))
    expect(deps.launch).toHaveBeenCalled()
  })

  it("refuses fragments, short or off-topic sentences, and consent without a silent-join request", () => {
    const message = "Hop on the call with Dana. Everyone agreed to a silent join today. We are fine with being recorded."
    expect(ownerConsentsToSilentJoin(message, "the call")).toBe(false)
    expect(ownerConsentsToSilentJoin(message, "Everyone agreed to a silent join")).toBe(false)
    expect(ownerConsentsToSilentJoin(message, "We are fine with being recorded.")).toBe(false)
    expect(ownerConsentsToSilentJoin(message, "Hop on the call with Dana.")).toBe(false)
    expect(ownerConsentsToSilentJoin("silent ok agreed", "silent ok agreed")).toBe(false)
    expect(ownerConsentsToSilentJoin(message, "Everyone agreed to a silent join today.")).toBe(true)
    expect(ownerConsentsToSilentJoin(undefined, "Everyone agreed to a silent join today.")).toBe(false)
  })

  it("falls back to the cli session for notification and omits it on other channels without a session", async () => {
    const deps = makeDeps()
    const handler = createVoiceLocalAudioToolDefinition(deps).handler
    await handler({}, ctx({ currentSession: undefined }))
    expect(deps.launch).toHaveBeenLastCalledWith(expect.objectContaining({ notify: { friendId: "ari", channel: "cli", key: "session" } }))
    const result = await handler({}, ctx({ currentSession: undefined, context: resolved({ channel: "bluebubbles" }) }))
    expect(deps.launch.mock.calls.at(-1)![0]).not.toHaveProperty("notify")
    expect(result).toMatch(/could not notify|no session/i)
  })

  it("reports a failed launch with its exact reason", async () => {
    const deps = makeDeps()
    deps.launch.mockResolvedValueOnce({ ok: false, message: "BlackHole 2ch is muted (input and output). Unmute it..." })
    const result = await createVoiceLocalAudioToolDefinition(deps).handler({}, ctx())
    expect(result).toContain("did not join")
    expect(result).toContain("BlackHole 2ch is muted")
  })

  it("leaves and reports status", async () => {
    const deps = makeDeps()
    const handler = createVoiceLocalAudioToolDefinition(deps).handler
    expect(await handler({ action: "leave" }, ctx())).toBe("Left local audio session local-audio-abc.")
    expect(deps.leave).toHaveBeenCalledWith("slugger")
    expect(await handler({ action: "status" }, ctx())).toBe("Local audio session local-audio-abc is joined.")
    expect(deps.status).toHaveBeenCalledWith("slugger")
  })

  it("refuses any device or physical input argument", async () => {
    const deps = makeDeps()
    const handler = createVoiceLocalAudioToolDefinition(deps).handler
    for (const key of ["device", "input_device", "microphone", "output_device", "input", "capture_device"]) {
      const result = await handler({ [key]: "Built-in Microphone" }, ctx())
      expect(result, key).toMatch(/never listens to a physical|only uses the BlackHole/i)
    }
    expect(await handler({ action: "dance" }, ctx())).toMatch(/action must be/i)
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it("re-checks the gate at execution time", async () => {
    const deps = makeDeps()
    const handler = createVoiceLocalAudioToolDefinition(deps).handler
    expect(await handler({}, ctx({ context: resolved({ trust: "friend" }) }))).toMatch(/not available.*family/i)
    expect(await handler({}, ctx({ context: resolved({ channel: "voice" }) }))).toMatch(/not available.*direct text/i)
    expect(await handler({}, ctx({ autonomousTurnKind: "habit" } as never))).toMatch(/not available/i)
    expect(await handler({}, undefined)).toMatch(/not available/i)
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it("requires the agent name", async () => {
    const deps = makeDeps()
    const result = await createVoiceLocalAudioToolDefinition(deps).handler({}, ctx({ agentName: undefined }))
    expect(deps.launch).not.toHaveBeenCalled()
    expect(result).toMatch(/no agent name/)
  })
})

describe("defaultLocalAudioToolDeps", () => {
  it("launches over the installed CLI entry with the agent's private join log", async () => {
    const deps = defaultLocalAudioToolDeps({ agentRoot: () => "/agents/slugger.ouro" })
    const result = await deps.launch({ agentName: "slugger" })
    expect(result).toEqual({ ok: true, message: "launched" })
    const [request, launchDeps] = join.launchLocalAudioJoin.mock.calls[0] as unknown as [unknown, Record<string, unknown> & { sleep: (ms: number) => Promise<void>; now: () => number; agentRoot: (n: string) => string }]
    expect(request).toEqual({ agentName: "slugger" })
    expect(launchDeps.execPath).toBe(process.execPath)
    expect(String(launchDeps.cliEntry)).toMatch(/heart\/daemon\/ouro-entry\.js$/)
    expect(launchDeps.timeoutMs).toBe(300_000)
    expect(launchDeps.agentRoot("x")).toBe("/agents/slugger.ouro")
    expect(join.defaultLaunchSpawn).toHaveBeenCalledWith(expect.objectContaining({ dir: "/agents/slugger.ouro/state/voice/local-audio" }))
    await launchDeps.sleep(1)
    expect(launchDeps.now()).toBeGreaterThan(0)
  })

  it("lets callers supply the launch mechanics", async () => {
    const launch = { execPath: "node", cliEntry: "entry.js", spawn: vi.fn(), sleep: vi.fn(), now: vi.fn(), timeoutMs: 5 }
    await defaultLocalAudioToolDeps({ agentRoot: () => "/r", launch: launch as never }).launch({ agentName: "slugger" })
    expect(join.launchLocalAudioJoin.mock.calls.at(-1)![1]).toMatchObject({ execPath: "node", cliEntry: "entry.js", timeoutMs: 5 })
  })

  it("leaves and reports status through the join runner", async () => {
    const deps = defaultLocalAudioToolDeps({ agentRoot: () => "/r" })
    expect(await deps.leave("slugger")).toBe("left")
    expect(await deps.status("slugger")).toBe("status")
    expect(join.runLocalAudioLeave).toHaveBeenCalledWith("slugger", { agentRoot: expect.any(Function) })
  })

  it("defaults the agent root to the real bundle root", async () => {
    const deps = defaultLocalAudioToolDeps()
    await deps.status("slugger")
    const passed = join.runLocalAudioStatus.mock.calls.at(-1)![1] as { agentRoot: (n: string) => string }
    expect(passed.agentRoot("slugger")).toMatch(/slugger/)
  })
})
