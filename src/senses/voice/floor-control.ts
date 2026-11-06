import { emitNervesEvent } from "../../nerves/runtime"

export type VoiceFloorOwner = "none" | "caller" | "assistant" | "terminal"

export type VoiceFloorPhase =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "caller-speaking"
  | "tool-running"
  | "tool-result-ready"
  | "interrupted"
  | "suppressing"
  | "hangup"
  | "ended"

export type VoiceFloorDecisionAction = "allow" | "delay" | "cancel" | "suppress"

export interface VoiceFloorDecision {
  allowed: boolean
  action: VoiceFloorDecisionAction
  reason: string
  atMs?: number
  responseId?: string
  toolCallId?: string
  interruptionTurnId?: string
}

export interface VoiceFloorPendingSpeech {
  responseId: string
  reason?: string
}

export interface VoiceFloorInterruption {
  turnId: string
  interruptedSpeechId: string
  atMs: number
}

export type VoiceFloorToolStatus = "running" | "ready" | "spoken" | "stale"

export interface VoiceFloorToolCallState {
  toolCallId: string
  toolName?: string
  turnId?: string
  status: VoiceFloorToolStatus
  startedAtMs: number
  completedAtMs?: number
}

export interface VoiceFloorState {
  phase: VoiceFloorPhase
  floorOwner: VoiceFloorOwner
  terminal: boolean
  hangupRequested: boolean
  pendingToolCallIds: string[]
  staleToolCallIds: string[]
  spokenToolCallIds: string[]
  callerTurnIds: string[]
  toolCalls: Record<string, VoiceFloorToolCallState>
  callId?: string
  latestCallerTurnId?: string
  activeAssistantSpeechId?: string
  pendingSpeech?: VoiceFloorPendingSpeech
  interruption?: VoiceFloorInterruption
}

export type VoiceFloorEvent =
  | { type: "call.connected"; atMs: number; callId?: string }
  | { type: "caller.speech.started"; atMs: number; turnId: string }
  | { type: "caller.speech.ended"; atMs: number; turnId: string }
  | { type: "caller.transcript.final"; atMs: number; turnId: string; text?: string }
  | { type: "caller.turn.dismissed"; atMs: number; turnId: string; reason?: string }
  | { type: "assistant.response.requested"; atMs: number; responseId: string; reason?: string }
  | { type: "assistant.speech.started"; atMs: number; responseId: string }
  | { type: "assistant.speech.done"; atMs: number; responseId: string }
  | { type: "assistant.speech.cancelled"; atMs: number; responseId: string; reason?: string }
  | { type: "tool.call.started"; atMs: number; toolCallId: string; toolName?: string; turnId?: string }
  | { type: "tool.holding.spoken"; atMs: number; toolCallId: string; text: string; responseId?: string }
  | { type: "tool.call.completed"; atMs: number; toolCallId: string; turnId?: string }
  | { type: "tool.result.spoken"; atMs: number; toolCallId: string; text?: string; responseId?: string }
  | { type: "hangup.requested"; atMs: number; reason?: string }
  | { type: "call.ended"; atMs: number }

export interface VoiceFloorTransition {
  event: VoiceFloorEvent
  state: VoiceFloorState
  decision: VoiceFloorDecision
}

export interface VoiceFloorReplay {
  state: VoiceFloorState
  steps: VoiceFloorTransition[]
}

export interface VoiceFloorResponseRequestInput {
  responseId: string
  reason?: string
}

export interface VoiceFloorToolSpeechInput {
  toolCallId: string
  text?: string
}

const MAX_TOOL_HOLDING_WORDS = 6

export function createInitialVoiceFloorState(): VoiceFloorState {
  return {
    phase: "idle",
    floorOwner: "none",
    terminal: false,
    hangupRequested: false,
    pendingToolCallIds: [],
    staleToolCallIds: [],
    spokenToolCallIds: [],
    callerTurnIds: [],
    toolCalls: {},
  }
}

function decision(
  allowed: boolean,
  action: VoiceFloorDecisionAction,
  reason: string,
  details: Omit<VoiceFloorDecision, "action" | "allowed" | "reason"> = {},
): VoiceFloorDecision {
  return { allowed, action, reason, ...details }
}

function copyState(state: VoiceFloorState): VoiceFloorState {
  return {
    ...state,
    pendingToolCallIds: [...state.pendingToolCallIds],
    staleToolCallIds: [...state.staleToolCallIds],
    spokenToolCallIds: [...state.spokenToolCallIds],
    callerTurnIds: [...state.callerTurnIds],
    toolCalls: { ...state.toolCalls },
  }
}

function withUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value]
}

function withoutValue(values: string[], value: string): string[] {
  return values.filter((candidate) => candidate !== value)
}

function rememberCallerTurn(state: VoiceFloorState, turnId: string): void {
  state.latestCallerTurnId = turnId
  state.callerTurnIds = withUnique(state.callerTurnIds, turnId)
}

function hasNewerCallerTurn(state: VoiceFloorState, turnId: string | undefined): boolean {
  if (!turnId || !state.latestCallerTurnId || state.latestCallerTurnId === turnId) return false
  const originalIndex = state.callerTurnIds.indexOf(turnId)
  const latestIndex = state.callerTurnIds.indexOf(state.latestCallerTurnId)
  return originalIndex >= 0 && latestIndex > originalIndex
}

function toolState(state: VoiceFloorState, toolCallId: string): VoiceFloorToolCallState | undefined {
  return state.toolCalls[toolCallId]
}

function setToolState(state: VoiceFloorState, nextTool: VoiceFloorToolCallState): void {
  state.toolCalls = { ...state.toolCalls, [nextTool.toolCallId]: nextTool }
}

function phaseAfterAssistantSpeech(state: VoiceFloorState): VoiceFloorPhase {
  const pendingTools = state.pendingToolCallIds.map((toolCallId) => state.toolCalls[toolCallId]).filter(Boolean)
  if (pendingTools.some((tool) => tool.status === "ready")) return "tool-result-ready"
  if (pendingTools.some((tool) => tool.status === "running")) return "tool-running"
  return "listening"
}

function suppressForHangup(state: VoiceFloorState, event: VoiceFloorEvent): VoiceFloorTransition {
  return {
    event,
    state,
    decision: decision(false, "suppress", "hangup_terminal", { atMs: event.atMs }),
  }
}

export function canRequestVoiceResponse(state: VoiceFloorState, input: VoiceFloorResponseRequestInput): VoiceFloorDecision {
  if (state.terminal || state.hangupRequested || state.floorOwner === "terminal") {
    return decision(false, "suppress", "hangup_terminal", { responseId: input.responseId })
  }
  if (state.floorOwner === "caller" || state.phase === "caller-speaking" || state.phase === "interrupted") {
    return decision(false, "delay", "caller_has_floor", { responseId: input.responseId })
  }
  if (state.floorOwner === "assistant" || state.activeAssistantSpeechId) {
    return decision(false, "delay", "assistant_has_floor", { responseId: input.responseId })
  }
  if (state.pendingSpeech) {
    return decision(false, "delay", "response_pending", { responseId: input.responseId })
  }
  return decision(true, "allow", "ready_for_response", { responseId: input.responseId })
}

export function canSpeakToolHolding(state: VoiceFloorState, input: VoiceFloorToolSpeechInput): VoiceFloorDecision {
  if (state.terminal || state.hangupRequested || state.floorOwner === "terminal") {
    return decision(false, "suppress", "hangup_terminal", { toolCallId: input.toolCallId })
  }
  if (state.floorOwner === "caller" || state.phase === "caller-speaking" || state.phase === "interrupted") {
    return decision(false, "delay", "caller_has_floor", { toolCallId: input.toolCallId })
  }
  const tool = toolState(state, input.toolCallId)
  if (!tool || tool.status === "spoken") {
    return decision(false, "suppress", "missing_tool_call", { toolCallId: input.toolCallId })
  }
  if (tool.status === "stale" || state.staleToolCallIds.includes(input.toolCallId)) {
    return decision(false, "suppress", "stale_tool_result", { toolCallId: input.toolCallId })
  }
  const words = input.text?.trim().split(/\s+/).filter(Boolean).length ?? 0
  if (words > MAX_TOOL_HOLDING_WORDS) {
    return decision(false, "suppress", "tool_holding_too_long", { toolCallId: input.toolCallId })
  }
  return decision(true, "allow", "tool_presence_allowed", { toolCallId: input.toolCallId })
}

export function canSpeakToolResult(state: VoiceFloorState, input: VoiceFloorToolSpeechInput): VoiceFloorDecision {
  if (state.terminal || state.hangupRequested || state.floorOwner === "terminal") {
    return decision(false, "suppress", "hangup_terminal", { toolCallId: input.toolCallId })
  }
  if (state.floorOwner === "caller" || state.phase === "caller-speaking" || state.phase === "interrupted") {
    return decision(false, "delay", "caller_has_floor", { toolCallId: input.toolCallId })
  }
  const tool = toolState(state, input.toolCallId)
  if (!tool || tool.status === "spoken") {
    return decision(false, "suppress", "missing_tool_result", { toolCallId: input.toolCallId })
  }
  if (tool.status === "stale" || state.staleToolCallIds.includes(input.toolCallId)) {
    return decision(false, "suppress", "stale_tool_result", { toolCallId: input.toolCallId })
  }
  if (tool.status !== "ready") {
    return decision(false, "delay", "tool_still_running", { toolCallId: input.toolCallId })
  }
  return decision(true, "allow", "tool_result_ready", { toolCallId: input.toolCallId })
}

function applyConnected(state: VoiceFloorState, event: Extract<VoiceFloorEvent, { type: "call.connected" }>): VoiceFloorTransition {
  const next = copyState(state)
  next.phase = "listening"
  next.floorOwner = "none"
  next.terminal = false
  next.hangupRequested = false
  next.callId = event.callId
  return { event, state: next, decision: decision(true, "allow", "call_connected", { atMs: event.atMs }) }
}

function applyCallerSpeechStarted(
  state: VoiceFloorState,
  event: Extract<VoiceFloorEvent, { type: "caller.speech.started" }>,
): VoiceFloorTransition {
  const next = copyState(state)
  rememberCallerTurn(next, event.turnId)
  next.floorOwner = "caller"
  if (state.activeAssistantSpeechId) {
    next.phase = "interrupted"
    next.interruption = {
      turnId: event.turnId,
      interruptedSpeechId: state.activeAssistantSpeechId,
      atMs: event.atMs,
    }
    return {
      event,
      state: next,
      decision: decision(false, "cancel", "caller_barge_in", {
        atMs: event.atMs,
        responseId: state.activeAssistantSpeechId,
        interruptionTurnId: event.turnId,
      }),
    }
  }
  next.phase = "caller-speaking"
  return { event, state: next, decision: decision(true, "allow", "caller_floor_started", { atMs: event.atMs }) }
}

function applyCallerSpeechEnded(
  state: VoiceFloorState,
  event: Extract<VoiceFloorEvent, { type: "caller.speech.ended" }>,
): VoiceFloorTransition {
  const next = copyState(state)
  rememberCallerTurn(next, event.turnId)
  if (!next.activeAssistantSpeechId) {
    next.floorOwner = "none"
    next.phase = "listening"
  }
  return { event, state: next, decision: decision(true, "allow", "caller_floor_released", { atMs: event.atMs }) }
}

function applyCallerTranscriptFinal(
  state: VoiceFloorState,
  event: Extract<VoiceFloorEvent, { type: "caller.transcript.final" }>,
): VoiceFloorTransition {
  const next = copyState(state)
  rememberCallerTurn(next, event.turnId)
  if (!next.activeAssistantSpeechId) {
    next.floorOwner = "none"
    next.phase = "thinking"
  }
  return { event, state: next, decision: decision(true, "allow", "caller_turn_ready", { atMs: event.atMs }) }
}

function applyCallerTurnDismissed(
  state: VoiceFloorState,
  event: Extract<VoiceFloorEvent, { type: "caller.turn.dismissed" }>,
): VoiceFloorTransition {
  if (state.latestCallerTurnId !== event.turnId) {
    return {
      event,
      state,
      decision: decision(false, "suppress", "stale_caller_turn", { atMs: event.atMs }),
    }
  }
  if (state.floorOwner !== "caller") {
    return {
      event,
      state,
      decision: decision(true, "allow", "caller_turn_already_released", { atMs: event.atMs }),
    }
  }
  const next = copyState(state)
  if (next.activeAssistantSpeechId) {
    next.floorOwner = "assistant"
    next.phase = "speaking"
  } else {
    next.floorOwner = "none"
    next.phase = "thinking"
  }
  next.interruption = undefined
  return {
    event,
    state: next,
    decision: decision(true, "allow", "caller_turn_dismissed", { atMs: event.atMs }),
  }
}

function applyAssistantResponseRequested(
  state: VoiceFloorState,
  event: Extract<VoiceFloorEvent, { type: "assistant.response.requested" }>,
): VoiceFloorTransition {
  const requestDecision = canRequestVoiceResponse(state, { responseId: event.responseId, reason: event.reason })
  if (!requestDecision.allowed) return { event, state, decision: { ...requestDecision, atMs: event.atMs } }
  const next = copyState(state)
  next.phase = "thinking"
  next.floorOwner = "none"
  next.pendingSpeech = { responseId: event.responseId, reason: event.reason }
  return { event, state: next, decision: { ...requestDecision, atMs: event.atMs } }
}

function applyAssistantSpeechStarted(
  state: VoiceFloorState,
  event: Extract<VoiceFloorEvent, { type: "assistant.speech.started" }>,
): VoiceFloorTransition {
  const requestDecision = state.floorOwner === "caller"
    ? decision(false, "delay", "caller_has_floor", { atMs: event.atMs, responseId: event.responseId })
    : decision(true, "allow", "assistant_speech_allowed", { atMs: event.atMs, responseId: event.responseId })
  if (!requestDecision.allowed) return { event, state, decision: requestDecision }
  const next = copyState(state)
  next.phase = "speaking"
  next.floorOwner = "assistant"
  next.activeAssistantSpeechId = event.responseId
  next.pendingSpeech = undefined
  return { event, state: next, decision: requestDecision }
}

function applyAssistantSpeechDone(
  state: VoiceFloorState,
  event: Extract<VoiceFloorEvent, { type: "assistant.speech.done" }>,
): VoiceFloorTransition {
  const next = copyState(state)
  if (next.activeAssistantSpeechId === event.responseId) next.activeAssistantSpeechId = undefined
  if (next.floorOwner === "assistant") next.floorOwner = "none"
  next.phase = phaseAfterAssistantSpeech(next)
  return { event, state: next, decision: decision(true, "allow", "assistant_speech_done", { atMs: event.atMs, responseId: event.responseId }) }
}

function applyAssistantSpeechCancelled(
  state: VoiceFloorState,
  event: Extract<VoiceFloorEvent, { type: "assistant.speech.cancelled" }>,
): VoiceFloorTransition {
  const next = copyState(state)
  if (next.activeAssistantSpeechId === event.responseId) next.activeAssistantSpeechId = undefined
  if (next.interruption) {
    next.floorOwner = "caller"
    next.phase = "caller-speaking"
  } else {
    next.floorOwner = "none"
    next.phase = phaseAfterAssistantSpeech(next)
  }
  return {
    event,
    state: next,
    decision: decision(true, "allow", "assistant_speech_cancelled", { atMs: event.atMs, responseId: event.responseId }),
  }
}

function applyToolStarted(state: VoiceFloorState, event: Extract<VoiceFloorEvent, { type: "tool.call.started" }>): VoiceFloorTransition {
  if (state.toolCalls[event.toolCallId]) {
    return {
      event,
      state,
      decision: decision(true, "allow", "duplicate_tool_start_ignored", { atMs: event.atMs, toolCallId: event.toolCallId }),
    }
  }
  const next = copyState(state)
  next.pendingToolCallIds = withUnique(next.pendingToolCallIds, event.toolCallId)
  setToolState(next, {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    turnId: event.turnId ?? next.latestCallerTurnId,
    status: "running",
    startedAtMs: event.atMs,
  })
  if (next.floorOwner === "none") next.phase = "tool-running"
  return { event, state: next, decision: decision(true, "allow", "tool_started", { atMs: event.atMs, toolCallId: event.toolCallId }) }
}

function applyToolHoldingSpoken(
  state: VoiceFloorState,
  event: Extract<VoiceFloorEvent, { type: "tool.holding.spoken" }>,
): VoiceFloorTransition {
  const holdingDecision = canSpeakToolHolding(state, { toolCallId: event.toolCallId, text: event.text })
  if (!holdingDecision.allowed) return { event, state, decision: { ...holdingDecision, atMs: event.atMs } }
  return { event, state, decision: { ...holdingDecision, atMs: event.atMs } }
}

function applyToolCompleted(state: VoiceFloorState, event: Extract<VoiceFloorEvent, { type: "tool.call.completed" }>): VoiceFloorTransition {
  const existing = toolState(state, event.toolCallId)
  if (!existing) {
    return {
      event,
      state,
      decision: decision(false, "suppress", "missing_tool_call", { atMs: event.atMs, toolCallId: event.toolCallId }),
    }
  }
  if (existing.status !== "running") {
    return {
      event,
      state,
      decision: decision(true, "allow", "duplicate_tool_completion_ignored", { atMs: event.atMs, toolCallId: event.toolCallId }),
    }
  }
  const turnId = event.turnId ?? existing.turnId
  const next = copyState(state)
  if (hasNewerCallerTurn(next, turnId)) {
    next.pendingToolCallIds = withoutValue(next.pendingToolCallIds, event.toolCallId)
    next.staleToolCallIds = withUnique(next.staleToolCallIds, event.toolCallId)
    setToolState(next, { ...existing, turnId, status: "stale", completedAtMs: event.atMs })
    if (next.floorOwner === "none") next.phase = "suppressing"
    return {
      event,
      state: next,
      decision: decision(false, "suppress", "newer_user_turn_started", { atMs: event.atMs, toolCallId: event.toolCallId }),
    }
  }
  setToolState(next, { ...existing, turnId, status: "ready", completedAtMs: event.atMs })
  next.pendingToolCallIds = withUnique(next.pendingToolCallIds, event.toolCallId)
  if (next.floorOwner === "none") next.phase = "tool-result-ready"
  return { event, state: next, decision: decision(true, "allow", "tool_result_ready", { atMs: event.atMs, toolCallId: event.toolCallId }) }
}

function applyToolResultSpoken(
  state: VoiceFloorState,
  event: Extract<VoiceFloorEvent, { type: "tool.result.spoken" }>,
): VoiceFloorTransition {
  const resultDecision = canSpeakToolResult(state, { toolCallId: event.toolCallId, text: event.text })
  if (!resultDecision.allowed) return { event, state, decision: { ...resultDecision, atMs: event.atMs } }
  const existing = toolState(state, event.toolCallId)!
  const next = copyState(state)
  setToolState(next, { ...existing, status: "spoken" })
  next.pendingToolCallIds = withoutValue(next.pendingToolCallIds, event.toolCallId)
  next.spokenToolCallIds = withUnique(next.spokenToolCallIds, event.toolCallId)
  next.phase = phaseAfterAssistantSpeech(next)
  return { event, state: next, decision: { ...resultDecision, atMs: event.atMs } }
}

function applyHangupRequested(state: VoiceFloorState, event: Extract<VoiceFloorEvent, { type: "hangup.requested" }>): VoiceFloorTransition {
  const next = copyState(state)
  next.phase = "hangup"
  next.floorOwner = "terminal"
  next.hangupRequested = true
  return { event, state: next, decision: decision(true, "allow", "hangup_requested", { atMs: event.atMs }) }
}

function applyCallEnded(state: VoiceFloorState, event: Extract<VoiceFloorEvent, { type: "call.ended" }>): VoiceFloorTransition {
  const next = copyState(state)
  next.phase = "ended"
  next.floorOwner = "terminal"
  next.terminal = true
  next.hangupRequested = true
  return { event, state: next, decision: decision(true, "allow", "call_ended", { atMs: event.atMs }) }
}

export function applyVoiceFloorEvent(state: VoiceFloorState, event: VoiceFloorEvent): VoiceFloorTransition {
  if (state.hangupRequested && event.type !== "call.ended" && event.type !== "hangup.requested") return suppressForHangup(state, event)
  switch (event.type) {
    case "call.connected":
      return applyConnected(state, event)
    case "caller.speech.started":
      return applyCallerSpeechStarted(state, event)
    case "caller.speech.ended":
      return applyCallerSpeechEnded(state, event)
    case "caller.transcript.final":
      return applyCallerTranscriptFinal(state, event)
    case "caller.turn.dismissed":
      return applyCallerTurnDismissed(state, event)
    case "assistant.response.requested":
      return applyAssistantResponseRequested(state, event)
    case "assistant.speech.started":
      return applyAssistantSpeechStarted(state, event)
    case "assistant.speech.done":
      return applyAssistantSpeechDone(state, event)
    case "assistant.speech.cancelled":
      return applyAssistantSpeechCancelled(state, event)
    case "tool.call.started":
      return applyToolStarted(state, event)
    case "tool.holding.spoken":
      return applyToolHoldingSpoken(state, event)
    case "tool.call.completed":
      return applyToolCompleted(state, event)
    case "tool.result.spoken":
      return applyToolResultSpoken(state, event)
    case "hangup.requested":
      return applyHangupRequested(state, event)
    case "call.ended":
      return applyCallEnded(state, event)
    default:
      throw new Error(`unknown voice floor event: ${String((event as { type?: unknown }).type)}`)
  }
}

export function replayVoiceFloorEvents(events: VoiceFloorEvent[]): VoiceFloorReplay {
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_floor_replay_start",
    message: "starting Voice floor-control replay",
    meta: { events: events.length },
  })
  let state = createInitialVoiceFloorState()
  const steps: VoiceFloorTransition[] = []
  for (const event of events) {
    const transition = applyVoiceFloorEvent(state, event)
    steps.push(transition)
    state = transition.state
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_floor_replay_end",
    message: "finished Voice floor-control replay",
    meta: { events: events.length, phase: state.phase, floorOwner: state.floorOwner },
  })
  return { state, steps }
}

function listSummary(values: string[]): string {
  return values.length > 0 ? values.join(",") : "none"
}

export function summarizeVoiceFloorState(state: VoiceFloorState): string {
  const parts = [
    `phase=${state.phase}`,
    `floor=${state.floorOwner}`,
  ]
  if (state.activeAssistantSpeechId) parts.push(`activeSpeech=${state.activeAssistantSpeechId}`)
  parts.push(`pendingTools=${listSummary(state.pendingToolCallIds)}`)
  parts.push(`staleTools=${listSummary(state.staleToolCallIds)}`)
  if (state.interruption) parts.push(`interruption=${state.interruption.turnId}@${state.interruption.interruptedSpeechId}`)
  if (state.hangupRequested) parts.push("hangup=requested")
  if (state.terminal) parts.push("terminal=true")
  return parts.join(" ")
}
