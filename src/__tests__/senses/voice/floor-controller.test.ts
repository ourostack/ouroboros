import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { emitNervesEvent } = vi.hoisted(() => ({ emitNervesEvent: vi.fn() }))

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent,
}))

import { VoiceFloorController } from "../../../senses/voice/floor-controller"

const TRANSPORT = "twilio-media-stream" as const

describe("VoiceFloorController", () => {
  beforeEach(() => {
    emitNervesEvent.mockClear()
  })

  afterEach(() => {
    emitNervesEvent.mockReset()
  })

  it("exposes initial state and is not terminal", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT, agentName: "slugger", callId: "call-1" })
    expect(controller.state.phase).toBe("idle")
    expect(controller.state.floorOwner).toBe("none")
    expect(controller.isTerminal()).toBe(false)
  })

  it("applies events through the pure reducer and exposes the new state", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    const transition = controller.apply({ type: "call.connected", atMs: 0, callId: "call-1" })
    expect(transition.decision.allowed).toBe(true)
    expect(transition.state.phase).toBe("listening")
    expect(controller.state).toBe(transition.state)
  })

  it("emits senses.voice_floor_transition with rich meta on apply", () => {
    const controller = new VoiceFloorController({
      transport: TRANSPORT,
      agentName: "slugger",
      callId: "call-9",
    })
    controller.apply({ type: "call.connected", atMs: 0, callId: "call-9" })
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "senses",
        event: "senses.voice_floor_transition",
        message: expect.any(String),
        meta: expect.objectContaining({
          eventType: "call.connected",
          action: "allow",
          reason: "call_connected",
          phase: "listening",
          floorOwner: "none",
          callId: "call-9",
          agentName: "slugger",
          transport: TRANSPORT,
        }),
      }),
    )
  })

  it("canRequestResponse returns the decision and emits a request-decision telemetry event", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT, agentName: "slugger", callId: "call-2" })
    controller.apply({ type: "call.connected", atMs: 0, callId: "call-2" })
    emitNervesEvent.mockClear()
    const decision = controller.canRequestResponse({ responseId: "resp-1", reason: "user_turn" })
    expect(decision.allowed).toBe(true)
    expect(decision.action).toBe("allow")
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "senses",
        event: "senses.voice_floor_decision",
        meta: expect.objectContaining({
          query: "request",
          responseId: "resp-1",
          inputReason: "user_turn",
          action: "allow",
          reason: "ready_for_response",
          phase: "listening",
          floorOwner: "none",
          callId: "call-2",
          agentName: "slugger",
          transport: TRANSPORT,
          allowed: true,
        }),
      }),
    )
  })

  it("canRequestResponse reports delay when the caller owns the floor", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    controller.apply({ type: "call.connected", atMs: 0 })
    controller.apply({ type: "caller.speech.started", atMs: 10, turnId: "turn-a" })
    emitNervesEvent.mockClear()
    const decision = controller.canRequestResponse({ responseId: "resp-1" })
    expect(decision.allowed).toBe(false)
    expect(decision.action).toBe("delay")
    expect(decision.reason).toBe("caller_has_floor")
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.voice_floor_decision",
        meta: expect.objectContaining({ query: "request", action: "delay", allowed: false }),
      }),
    )
  })

  it("canSpeakToolHolding emits a tool_holding decision event", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    controller.apply({ type: "call.connected", atMs: 0 })
    controller.apply({ type: "tool.call.started", atMs: 1, toolCallId: "tc-1", toolName: "search" })
    emitNervesEvent.mockClear()
    const decision = controller.canSpeakToolHolding({ toolCallId: "tc-1", text: "one moment" })
    expect(decision.allowed).toBe(true)
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.voice_floor_decision",
        meta: expect.objectContaining({ query: "tool_holding", toolCallId: "tc-1", action: "allow" }),
      }),
    )
  })

  it("canSpeakToolResult emits a tool_result decision event and reports delay when not ready", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    controller.apply({ type: "call.connected", atMs: 0 })
    controller.apply({ type: "tool.call.started", atMs: 1, toolCallId: "tc-2" })
    emitNervesEvent.mockClear()
    const decision = controller.canSpeakToolResult({ toolCallId: "tc-2", text: "done" })
    expect(decision.allowed).toBe(false)
    expect(decision.action).toBe("delay")
    expect(decision.reason).toBe("tool_still_running")
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.voice_floor_decision",
        meta: expect.objectContaining({ query: "tool_result", toolCallId: "tc-2", action: "delay" }),
      }),
    )
  })

  it("isTerminal becomes true after hangup.requested and after call.ended", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    controller.apply({ type: "call.connected", atMs: 0 })
    expect(controller.isTerminal()).toBe(false)
    controller.apply({ type: "hangup.requested", atMs: 1 })
    expect(controller.isTerminal()).toBe(true)
    controller.apply({ type: "call.ended", atMs: 2 })
    expect(controller.isTerminal()).toBe(true)
  })

  it("summary delegates to the pure summarizer", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    controller.apply({ type: "call.connected", atMs: 0 })
    const summary = controller.summary()
    expect(summary).toContain("phase=listening")
    expect(summary).toContain("floor=none")
  })

  it("subscribers added with onTransition are called after every apply with the resulting transition", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    const calls: Array<{ phase: string; eventType: string; action: string }> = []
    const unsubscribe = controller.onTransition((transition) => {
      calls.push({
        phase: transition.state.phase,
        eventType: transition.event.type,
        action: transition.decision.action,
      })
    })
    controller.apply({ type: "call.connected", atMs: 0 })
    controller.apply({ type: "caller.speech.started", atMs: 1, turnId: "turn-a" })
    expect(calls).toEqual([
      { phase: "listening", eventType: "call.connected", action: "allow" },
      { phase: "caller-speaking", eventType: "caller.speech.started", action: "allow" },
    ])
    unsubscribe()
    controller.apply({ type: "caller.speech.ended", atMs: 2, turnId: "turn-a" })
    expect(calls).toHaveLength(2)
  })

  it("multiple subscribers all fire and unsubscribe is idempotent", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    const a = vi.fn()
    const b = vi.fn()
    const unsubA = controller.onTransition(a)
    controller.onTransition(b)
    controller.apply({ type: "call.connected", atMs: 0 })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    unsubA()
    unsubA()
    controller.apply({ type: "caller.speech.started", atMs: 1, turnId: "x" })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it("does not throw if a transition subscriber throws — other subscribers still fire", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    const noisy = vi.fn(() => {
      throw new Error("subscriber boom")
    })
    const quiet = vi.fn()
    controller.onTransition(noisy)
    controller.onTransition(quiet)
    expect(() => controller.apply({ type: "call.connected", atMs: 0 })).not.toThrow()
    expect(quiet).toHaveBeenCalledTimes(1)
  })

  it("stringifies non-Error subscriber throws in the listener-error event", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    controller.onTransition(() => {
      // eslint-disable-next-line no-throw-literal
      throw "raw string error"
    })
    emitNervesEvent.mockClear()
    controller.apply({ type: "call.connected", atMs: 0 })
    const errorCall = emitNervesEvent.mock.calls.find(
      ([payload]: [{ event: string }]) => payload.event === "senses.voice_floor_listener_error",
    )
    expect(errorCall).toBeDefined()
    expect(errorCall?.[0].meta).toMatchObject({ error: "raw string error" })
  })

  it("decision queries do not mutate floor state", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    controller.apply({ type: "call.connected", atMs: 0 })
    const stateBefore = controller.state
    controller.canRequestResponse({ responseId: "r" })
    controller.canSpeakToolHolding({ toolCallId: "t" })
    controller.canSpeakToolResult({ toolCallId: "t" })
    expect(controller.state).toBe(stateBefore)
  })

  it("supports an injected now() and an empty transport without crashing", () => {
    const now = vi.fn().mockReturnValue(1234)
    const controller = new VoiceFloorController({ transport: TRANSPORT, now })
    controller.apply({ type: "call.connected", atMs: 0 })
    const decision: { atMs?: number } = controller.canRequestResponse({ responseId: "r" })
    expect(decision.atMs).toBe(1234)
    expect(now).toHaveBeenCalled()
  })

  it("populates atMs for tool decisions from the now() injection", () => {
    const now = vi.fn().mockReturnValue(5678)
    const controller = new VoiceFloorController({ transport: TRANSPORT, now })
    controller.apply({ type: "call.connected", atMs: 0 })
    controller.apply({ type: "tool.call.started", atMs: 1, toolCallId: "tc-x" })
    const holding = controller.canSpeakToolHolding({ toolCallId: "tc-x", text: "hold on" })
    const result = controller.canSpeakToolResult({ toolCallId: "tc-x" })
    expect(holding.atMs).toBe(5678)
    expect(result.atMs).toBe(5678)
  })

  it("respects an explicit atMs override on decision queries", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT, now: () => 1 })
    controller.apply({ type: "call.connected", atMs: 0 })
    const decision = controller.canRequestResponse({ responseId: "r" }, 9999)
    expect(decision.atMs).toBe(9999)
  })

  it("transition telemetry includes the event atMs when available", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    emitNervesEvent.mockClear()
    controller.apply({ type: "call.connected", atMs: 4242 })
    const call = emitNervesEvent.mock.calls.find(
      ([payload]: [{ event: string }]) => payload.event === "senses.voice_floor_transition",
    )
    expect(call).toBeDefined()
    expect(call?.[0].meta).toMatchObject({ atMs: 4242 })
  })

  it("constructs with minimal options (only transport)", () => {
    const controller = new VoiceFloorController({ transport: "openai-sip" })
    expect(controller.state.phase).toBe("idle")
    controller.apply({ type: "call.connected", atMs: 0 })
    expect(controller.state.phase).toBe("listening")
  })

  it("uses Date.now by default when no now() injection is provided", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    controller.apply({ type: "call.connected", atMs: 0 })
    const decision = controller.canRequestResponse({ responseId: "r" })
    expect(typeof decision.atMs).toBe("number")
  })

  it("forwards the canRequestResponse atMs from the now() injection to the decision payload", () => {
    let stamp = 100
    const now = () => stamp
    const controller = new VoiceFloorController({ transport: TRANSPORT, now })
    controller.apply({ type: "call.connected", atMs: 0 })
    const first = controller.canRequestResponse({ responseId: "r1" })
    expect(first.atMs).toBe(100)
    stamp = 200
    const second = controller.canRequestResponse({ responseId: "r2" })
    expect(second.atMs).toBe(200)
  })

  it("apply() returns the same transition object that subscribers receive", () => {
    const controller = new VoiceFloorController({ transport: TRANSPORT })
    let captured: unknown = null
    controller.onTransition((transition) => {
      captured = transition
    })
    const returned = controller.apply({ type: "call.connected", atMs: 0 })
    expect(captured).toBe(returned)
  })
})
