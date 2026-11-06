import { describe, expect, it } from "vitest"
import {
  applyVoiceFloorEvent,
  canRequestVoiceResponse,
  canSpeakToolHolding,
  canSpeakToolResult,
  createInitialVoiceFloorState,
  replayVoiceFloorEvents,
  summarizeVoiceFloorState,
  type VoiceFloorEvent,
  type VoiceFloorState,
} from "../../../senses/voice/floor-control"

function apply(state: VoiceFloorState, event: VoiceFloorEvent): VoiceFloorState {
  return applyVoiceFloorEvent(state, event).state
}

describe("voice floor control", () => {
  it("moves a connected call through listening, thinking, speaking, and back to listening", () => {
    let state = createInitialVoiceFloorState()

    expect(state).toMatchObject({
      phase: "idle",
      floorOwner: "none",
      pendingToolCallIds: [],
      staleToolCallIds: [],
      terminal: false,
    })

    state = apply(state, { type: "call.connected", atMs: 0, callId: "call-1" })
    expect(state).toMatchObject({ phase: "listening", floorOwner: "none", callId: "call-1" })

    state = apply(state, { type: "caller.transcript.final", atMs: 700, turnId: "turn-1", text: "hello" })
    expect(canRequestVoiceResponse(state, { responseId: "response-1", reason: "answer_turn" })).toMatchObject({
      allowed: true,
      action: "allow",
      reason: "ready_for_response",
    })

    state = apply(state, { type: "assistant.response.requested", atMs: 760, responseId: "response-1", reason: "answer_turn" })
    expect(state).toMatchObject({
      phase: "thinking",
      floorOwner: "none",
      pendingSpeech: { responseId: "response-1", reason: "answer_turn" },
    })
    expect(canRequestVoiceResponse(state, { responseId: "response-queued" })).toMatchObject({
      allowed: false,
      action: "delay",
      reason: "response_pending",
    })

    const speechStart = applyVoiceFloorEvent(state, { type: "assistant.speech.started", atMs: 820, responseId: "response-1" })
    expect(speechStart.decision).toMatchObject({
      allowed: true,
      action: "allow",
      reason: "assistant_speech_allowed",
    })
    state = speechStart.state
    expect(state).toMatchObject({ phase: "speaking", floorOwner: "assistant", activeAssistantSpeechId: "response-1" })
    expect(canRequestVoiceResponse(state, { responseId: "response-2" })).toMatchObject({
      allowed: false,
      action: "delay",
      reason: "assistant_has_floor",
    })

    state = apply(state, { type: "assistant.speech.done", atMs: 1_200, responseId: "response-1" })
    expect(state).toMatchObject({ phase: "listening", floorOwner: "none", activeAssistantSpeechId: undefined })
    expect(summarizeVoiceFloorState(state)).toBe("phase=listening floor=none pendingTools=none staleTools=none")
  })

  it("cancels assistant speech when the caller barges in and delays new speech until the caller turn lands", () => {
    const replay = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0, callId: "call-1" },
      { type: "assistant.response.requested", atMs: 100, responseId: "greeting", reason: "greeting" },
      { type: "assistant.speech.started", atMs: 180, responseId: "greeting" },
      { type: "caller.speech.started", atMs: 420, turnId: "turn-1" },
    ])

    expect(replay.steps.at(-1)?.decision).toMatchObject({
      allowed: false,
      action: "cancel",
      reason: "caller_barge_in",
      responseId: "greeting",
      interruptionTurnId: "turn-1",
    })
    expect(replay.state).toMatchObject({
      phase: "interrupted",
      floorOwner: "caller",
      activeAssistantSpeechId: "greeting",
      interruption: { turnId: "turn-1", interruptedSpeechId: "greeting", atMs: 420 },
    })
    expect(canRequestVoiceResponse(replay.state, { responseId: "too-early" })).toMatchObject({
      allowed: false,
      action: "delay",
      reason: "caller_has_floor",
    })

    let state = apply(replay.state, { type: "assistant.speech.cancelled", atMs: 440, responseId: "greeting", reason: "caller_barge_in" })
    expect(state).toMatchObject({ phase: "caller-speaking", floorOwner: "caller", activeAssistantSpeechId: undefined })

    state = apply(state, { type: "caller.speech.ended", atMs: 900, turnId: "turn-1" })
    expect(state).toMatchObject({ phase: "listening", floorOwner: "none" })
    state = apply(state, { type: "caller.transcript.final", atMs: 1_050, turnId: "turn-1", text: "actually one more thing" })
    expect(canRequestVoiceResponse(state, { responseId: "response-1" })).toMatchObject({
      allowed: true,
      action: "allow",
      reason: "ready_for_response",
    })
    expect(summarizeVoiceFloorState(state)).toContain("interruption=turn-1@greeting")
  })

  it("keeps tool presence short and only speaks current tool results when the caller is not holding the floor", () => {
    let state = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "caller.transcript.final", atMs: 200, turnId: "turn-1", text: "check weather" },
      { type: "tool.call.started", atMs: 260, toolCallId: "weather-1", toolName: "weather_lookup", turnId: "turn-1" },
    ]).state

    expect(state).toMatchObject({ phase: "tool-running", floorOwner: "none", pendingToolCallIds: ["weather-1"] })
    expect(canSpeakToolResult(state, { toolCallId: "weather-1" })).toMatchObject({
      allowed: false,
      action: "delay",
      reason: "tool_still_running",
    })
    expect(canSpeakToolHolding(state, { toolCallId: "weather-1", text: "Checking now." })).toMatchObject({
      allowed: true,
      action: "allow",
      reason: "tool_presence_allowed",
    })
    expect(canSpeakToolHolding(state, {
      toolCallId: "weather-1",
      text: "Still checking the answer now please wait",
    })).toMatchObject({
      allowed: false,
      action: "suppress",
      reason: "tool_holding_too_long",
    })

    state = apply(state, { type: "tool.holding.spoken", atMs: 500, toolCallId: "weather-1", text: "Checking now." })
    state = apply(state, { type: "tool.call.completed", atMs: 900, toolCallId: "weather-1", turnId: "turn-1" })
    expect(state).toMatchObject({ phase: "tool-result-ready", pendingToolCallIds: ["weather-1"] })
    expect(canSpeakToolResult(state, { toolCallId: "weather-1" })).toMatchObject({
      allowed: true,
      action: "allow",
      reason: "tool_result_ready",
    })

    state = apply(state, { type: "tool.result.spoken", atMs: 1_000, toolCallId: "weather-1", text: "It is clear." })
    expect(state).toMatchObject({ phase: "listening", pendingToolCallIds: [], spokenToolCallIds: ["weather-1"] })
  })

  it("suppresses stale tool results after a newer caller turn starts", () => {
    const replay = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "caller.transcript.final", atMs: 100, turnId: "turn-1", text: "research this" },
      { type: "tool.call.started", atMs: 140, toolCallId: "research-1", toolName: "search", turnId: "turn-1" },
      { type: "caller.speech.started", atMs: 600, turnId: "turn-2" },
      { type: "caller.speech.ended", atMs: 900, turnId: "turn-2" },
      { type: "caller.transcript.final", atMs: 1_000, turnId: "turn-2", text: "wait, make it shorter" },
      { type: "tool.call.completed", atMs: 1_050, toolCallId: "research-1", turnId: "turn-1" },
    ])

    expect(replay.state).toMatchObject({
      phase: "suppressing",
      pendingToolCallIds: [],
      staleToolCallIds: ["research-1"],
      latestCallerTurnId: "turn-2",
    })
    expect(replay.steps.at(-1)?.decision).toMatchObject({
      allowed: false,
      action: "suppress",
      reason: "newer_user_turn_started",
      toolCallId: "research-1",
    })
    expect(canSpeakToolResult(replay.state, { toolCallId: "research-1" })).toMatchObject({
      allowed: false,
      action: "suppress",
      reason: "stale_tool_result",
    })
    expect(canSpeakToolHolding(replay.state, { toolCallId: "research-1", text: "Still checking." })).toMatchObject({
      allowed: false,
      action: "suppress",
      reason: "stale_tool_result",
    })
  })

  it("treats hangup as terminal for pending responses and tools", () => {
    let state = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "caller.transcript.final", atMs: 100, turnId: "turn-1", text: "bye after checking" },
      { type: "tool.call.started", atMs: 140, toolCallId: "weather-1", toolName: "weather_lookup", turnId: "turn-1" },
      { type: "hangup.requested", atMs: 300, reason: "caller_done" },
    ]).state

    expect(state).toMatchObject({ phase: "hangup", floorOwner: "terminal", hangupRequested: true, pendingToolCallIds: ["weather-1"] })
    expect(canRequestVoiceResponse(state, { responseId: "after-hangup" })).toMatchObject({
      allowed: false,
      action: "suppress",
      reason: "hangup_terminal",
    })
    expect(canSpeakToolHolding(state, { toolCallId: "weather-1", text: "Checking now." })).toMatchObject({
      allowed: false,
      action: "suppress",
      reason: "hangup_terminal",
    })
    expect(canSpeakToolResult(state, { toolCallId: "weather-1" })).toMatchObject({
      allowed: false,
      action: "suppress",
      reason: "hangup_terminal",
    })

    const afterResponse = applyVoiceFloorEvent(state, {
      type: "assistant.response.requested",
      atMs: 320,
      responseId: "after-hangup",
      reason: "late_followup",
    })
    expect(afterResponse.decision).toMatchObject({ allowed: false, action: "suppress", reason: "hangup_terminal" })
    expect(afterResponse.state).toEqual(state)

    state = apply(state, { type: "call.ended", atMs: 500 })
    expect(state).toMatchObject({ phase: "ended", floorOwner: "terminal", terminal: true })
  })

  it("handles duplicate events deterministically and rejects unknown event types", () => {
    const duplicateTool = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "tool.call.started", atMs: 100, toolCallId: "tool-1", toolName: "lookup" },
      { type: "tool.call.started", atMs: 120, toolCallId: "tool-1", toolName: "lookup" },
      { type: "tool.call.completed", atMs: 200, toolCallId: "tool-1" },
      { type: "tool.call.completed", atMs: 220, toolCallId: "tool-1" },
    ])

    expect(duplicateTool.state.pendingToolCallIds).toEqual(["tool-1"])
    expect(duplicateTool.steps[2]?.decision).toMatchObject({
      allowed: true,
      action: "allow",
      reason: "duplicate_tool_start_ignored",
    })
    expect(duplicateTool.steps[4]?.decision).toMatchObject({
      allowed: true,
      action: "allow",
      reason: "duplicate_tool_completion_ignored",
    })

    const strayCompletion = applyVoiceFloorEvent(createInitialVoiceFloorState(), {
      type: "tool.call.completed",
      atMs: 20,
      toolCallId: "missing-tool",
    })
    expect(strayCompletion.decision).toMatchObject({
      allowed: false,
      action: "suppress",
      reason: "missing_tool_call",
      toolCallId: "missing-tool",
    })
    expect(canSpeakToolHolding(createInitialVoiceFloorState(), { toolCallId: "missing-tool", text: "Checking." })).toMatchObject({
      allowed: false,
      action: "suppress",
      reason: "missing_tool_call",
    })
    expect(canSpeakToolResult(createInitialVoiceFloorState(), { toolCallId: "missing-tool" })).toMatchObject({
      allowed: false,
      action: "suppress",
      reason: "missing_tool_result",
    })

    const cancelledWithoutInterruption = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "assistant.response.requested", atMs: 100, responseId: "response-1" },
      { type: "assistant.speech.started", atMs: 120, responseId: "response-1" },
      { type: "assistant.speech.cancelled", atMs: 150, responseId: "response-1", reason: "local_shutdown" },
    ])
    expect(cancelledWithoutInterruption.state).toMatchObject({
      phase: "listening",
      floorOwner: "none",
      activeAssistantSpeechId: undefined,
    })

    const callerFloor = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "tool.call.started", atMs: 100, toolCallId: "tool-2", toolName: "lookup" },
      { type: "caller.speech.started", atMs: 140, turnId: "turn-1" },
    ]).state
    expect(canSpeakToolResult(callerFloor, { toolCallId: "tool-2" })).toMatchObject({
      allowed: false,
      action: "delay",
      reason: "caller_has_floor",
    })
    expect(canSpeakToolHolding(callerFloor, { toolCallId: "tool-2", text: "Checking." })).toMatchObject({
      allowed: false,
      action: "delay",
      reason: "caller_has_floor",
    })
    expect(applyVoiceFloorEvent(callerFloor, {
      type: "assistant.speech.started",
      atMs: 180,
      responseId: "too-soon",
    }).decision).toMatchObject({
      allowed: false,
      action: "delay",
      reason: "caller_has_floor",
    })

    const pendingSpeech = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "assistant.response.requested", atMs: 100, responseId: "response-1" },
      { type: "assistant.speech.started", atMs: 120, responseId: "response-1" },
      { type: "tool.call.started", atMs: 130, toolCallId: "tool-3", toolName: "lookup" },
      { type: "assistant.speech.done", atMs: 180, responseId: "response-1" },
    ]).state
    expect(pendingSpeech.phase).toBe("tool-running")
    expect(summarizeVoiceFloorState(pendingSpeech)).toContain("pendingTools=tool-3")
    expect(canSpeakToolHolding(pendingSpeech, { toolCallId: "tool-3" })).toMatchObject({
      allowed: true,
      action: "allow",
      reason: "tool_presence_allowed",
    })

    const readyWhileSpeaking = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "assistant.response.requested", atMs: 100, responseId: "response-2" },
      { type: "assistant.speech.started", atMs: 120, responseId: "response-2" },
      { type: "tool.call.started", atMs: 130, toolCallId: "tool-4", toolName: "lookup" },
      { type: "tool.call.completed", atMs: 160, toolCallId: "tool-4" },
      { type: "assistant.speech.done", atMs: 200, responseId: "response-2" },
    ]).state
    expect(readyWhileSpeaking.phase).toBe("tool-result-ready")

    const interruptedBeforeCancel = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "assistant.response.requested", atMs: 100, responseId: "response-3" },
      { type: "assistant.speech.started", atMs: 120, responseId: "response-3" },
      { type: "caller.speech.started", atMs: 140, turnId: "turn-interrupt" },
      { type: "caller.speech.ended", atMs: 180, turnId: "turn-interrupt" },
      { type: "caller.transcript.final", atMs: 220, turnId: "turn-interrupt", text: "hold on" },
    ]).state
    expect(interruptedBeforeCancel).toMatchObject({
      phase: "interrupted",
      floorOwner: "caller",
      activeAssistantSpeechId: "response-3",
    })
    expect(summarizeVoiceFloorState(interruptedBeforeCancel)).toContain("activeSpeech=response-3")
    expect(applyVoiceFloorEvent(interruptedBeforeCancel, {
      type: "assistant.response.requested",
      atMs: 240,
      responseId: "too-early",
    }).decision).toMatchObject({
      allowed: false,
      action: "delay",
      reason: "caller_has_floor",
    })

    const mismatchedSpeechDone = applyVoiceFloorEvent(createInitialVoiceFloorState(), {
      type: "assistant.speech.done",
      atMs: 40,
      responseId: "missing-speech",
    })
    expect(mismatchedSpeechDone.state).toMatchObject({ phase: "listening", floorOwner: "none" })
    const mismatchedCancel = applyVoiceFloorEvent(createInitialVoiceFloorState(), {
      type: "assistant.speech.cancelled",
      atMs: 50,
      responseId: "missing-speech",
    })
    expect(mismatchedCancel.state).toMatchObject({ phase: "listening", floorOwner: "none" })

    const rejectedHolding = applyVoiceFloorEvent(pendingSpeech, {
      type: "tool.holding.spoken",
      atMs: 210,
      toolCallId: "tool-3",
      text: "This holding phrase is much much too long",
    })
    expect(rejectedHolding.decision).toMatchObject({
      allowed: false,
      action: "suppress",
      reason: "tool_holding_too_long",
    })

    const staleWhileCallerTalks = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "caller.transcript.final", atMs: 100, turnId: "turn-a", text: "research" },
      { type: "tool.call.started", atMs: 120, toolCallId: "tool-5", turnId: "turn-a" },
      { type: "caller.speech.started", atMs: 200, turnId: "turn-b" },
      { type: "tool.call.completed", atMs: 220, toolCallId: "tool-5", turnId: "turn-a" },
    ]).state
    expect(staleWhileCallerTalks).toMatchObject({ phase: "caller-speaking", floorOwner: "caller", staleToolCallIds: ["tool-5"] })

    const readyWhileCallerTalks = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "caller.speech.started", atMs: 100, turnId: "turn-c" },
      { type: "tool.call.started", atMs: 120, toolCallId: "tool-6", turnId: "turn-c" },
      { type: "tool.call.completed", atMs: 150, toolCallId: "tool-6", turnId: "turn-c" },
    ]).state
    expect(readyWhileCallerTalks).toMatchObject({ phase: "caller-speaking", floorOwner: "caller", pendingToolCallIds: ["tool-6"] })

    const runningTool = replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "tool.call.started", atMs: 100, toolCallId: "tool-7" },
    ]).state
    expect(applyVoiceFloorEvent(runningTool, {
      type: "tool.result.spoken",
      atMs: 130,
      toolCallId: "tool-7",
    }).decision).toMatchObject({
      allowed: false,
      action: "delay",
      reason: "tool_still_running",
    })

    const terminalSummary = summarizeVoiceFloorState(replayVoiceFloorEvents([
      { type: "call.connected", atMs: 0 },
      { type: "hangup.requested", atMs: 100 },
      { type: "call.ended", atMs: 140 },
    ]).state)
    expect(terminalSummary).toContain("hangup=requested")
    expect(terminalSummary).toContain("terminal=true")

    expect(() => applyVoiceFloorEvent(createInitialVoiceFloorState(), {
      type: "assistant.started",
      atMs: 10,
    } as unknown as VoiceFloorEvent)).toThrow("unknown voice floor event: assistant.started")
  })

  describe("caller.turn.dismissed", () => {
    it("releases the floor when the matching caller turn currently owns it", () => {
      let state = createInitialVoiceFloorState()
      state = apply(state, { type: "call.connected", atMs: 0, callId: "call-1" })
      state = apply(state, { type: "caller.speech.started", atMs: 10, turnId: "turn-a" })
      expect(state).toMatchObject({ phase: "caller-speaking", floorOwner: "caller" })

      const transition = applyVoiceFloorEvent(state, {
        type: "caller.turn.dismissed",
        atMs: 20,
        turnId: "turn-a",
        reason: "coordinated_tool_start",
      })
      expect(transition.decision).toMatchObject({
        allowed: true,
        action: "allow",
        reason: "caller_turn_dismissed",
        atMs: 20,
      })
      expect(transition.state).toMatchObject({
        phase: "thinking",
        floorOwner: "none",
      })
      // The caller turn id is preserved in callerTurnIds so future stale-tool
      // checks can still reason about its ordering.
      expect(transition.state.callerTurnIds).toContain("turn-a")
    })

    it("is a no-op when the turn id does not match the latest caller turn", () => {
      let state = createInitialVoiceFloorState()
      state = apply(state, { type: "call.connected", atMs: 0 })
      state = apply(state, { type: "caller.speech.started", atMs: 10, turnId: "turn-a" })

      const transition = applyVoiceFloorEvent(state, {
        type: "caller.turn.dismissed",
        atMs: 20,
        turnId: "turn-b",
      })
      expect(transition.decision).toMatchObject({
        allowed: false,
        action: "suppress",
        reason: "stale_caller_turn",
      })
      expect(transition.state).toMatchObject({ phase: "caller-speaking", floorOwner: "caller" })
    })

    it("is a no-op when the matching caller turn no longer owns the floor", () => {
      let state = createInitialVoiceFloorState()
      state = apply(state, { type: "call.connected", atMs: 0 })
      state = apply(state, { type: "caller.speech.started", atMs: 10, turnId: "turn-a" })
      state = apply(state, { type: "caller.transcript.final", atMs: 20, turnId: "turn-a", text: "hi" })
      expect(state).toMatchObject({ phase: "thinking", floorOwner: "none" })

      const transition = applyVoiceFloorEvent(state, {
        type: "caller.turn.dismissed",
        atMs: 30,
        turnId: "turn-a",
      })
      expect(transition.decision).toMatchObject({
        allowed: true,
        action: "allow",
        reason: "caller_turn_already_released",
      })
      expect(transition.state).toMatchObject({ phase: "thinking", floorOwner: "none" })
    })

    it("is suppressed by the hangup short-circuit when the call is already terminal", () => {
      let state = createInitialVoiceFloorState()
      state = apply(state, { type: "call.connected", atMs: 0 })
      state = apply(state, { type: "caller.speech.started", atMs: 10, turnId: "turn-a" })
      state = apply(state, { type: "hangup.requested", atMs: 15 })

      const transition = applyVoiceFloorEvent(state, {
        type: "caller.turn.dismissed",
        atMs: 20,
        turnId: "turn-a",
      })
      expect(transition.decision).toMatchObject({
        allowed: false,
        action: "suppress",
        reason: "hangup_terminal",
      })
      expect(transition.state.terminal).toBe(false)
      expect(transition.state.hangupRequested).toBe(true)
    })

    it("releases an active interruption back into a normal listening phase", () => {
      let state = createInitialVoiceFloorState()
      state = apply(state, { type: "call.connected", atMs: 0 })
      state = apply(state, { type: "assistant.response.requested", atMs: 1, responseId: "resp-1" })
      state = apply(state, { type: "assistant.speech.started", atMs: 2, responseId: "resp-1" })
      state = apply(state, { type: "caller.speech.started", atMs: 3, turnId: "turn-a" })
      expect(state).toMatchObject({ phase: "interrupted", floorOwner: "caller" })

      const transition = applyVoiceFloorEvent(state, {
        type: "caller.turn.dismissed",
        atMs: 4,
        turnId: "turn-a",
      })
      expect(transition.decision).toMatchObject({
        allowed: true,
        action: "allow",
        reason: "caller_turn_dismissed",
      })
      // Assistant is still mid-speech, so the floor returns to the assistant.
      expect(transition.state).toMatchObject({ phase: "speaking", floorOwner: "assistant" })
    })
  })
})
