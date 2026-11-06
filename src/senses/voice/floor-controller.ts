import { emitNervesEvent } from "../../nerves/runtime"
import {
  applyVoiceFloorEvent,
  canRequestVoiceResponse,
  canSpeakToolHolding as pureCanSpeakToolHolding,
  canSpeakToolResult as pureCanSpeakToolResult,
  createInitialVoiceFloorState,
  summarizeVoiceFloorState,
  type VoiceFloorDecision,
  type VoiceFloorEvent,
  type VoiceFloorResponseRequestInput,
  type VoiceFloorState,
  type VoiceFloorToolSpeechInput,
  type VoiceFloorTransition,
} from "./floor-control"

export type VoiceFloorTransport = "twilio-media-stream" | "openai-sip"

export interface VoiceFloorControllerOptions {
  transport: VoiceFloorTransport
  agentName?: string
  callId?: string
  now?: () => number
}

export type VoiceFloorTransitionListener = (transition: VoiceFloorTransition) => void

export class VoiceFloorController {
  private currentState: VoiceFloorState = createInitialVoiceFloorState()
  private readonly transport: VoiceFloorTransport
  private readonly agentName?: string
  private readonly now: () => number
  private callId?: string
  private listeners: VoiceFloorTransitionListener[] = []

  constructor(options: VoiceFloorControllerOptions) {
    this.transport = options.transport
    this.agentName = options.agentName
    this.callId = options.callId
    this.now = options.now ?? Date.now
  }

  get state(): VoiceFloorState {
    return this.currentState
  }

  isTerminal(): boolean {
    return this.currentState.terminal || this.currentState.hangupRequested
  }

  summary(): string {
    return summarizeVoiceFloorState(this.currentState)
  }

  onTransition(listener: VoiceFloorTransitionListener): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index >= 0) this.listeners.splice(index, 1)
    }
  }

  apply(event: VoiceFloorEvent): VoiceFloorTransition {
    const transition = applyVoiceFloorEvent(this.currentState, event)
    this.currentState = transition.state
    if (event.type === "call.connected" && event.callId) this.callId = event.callId
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_floor_transition",
      message: `voice floor transition ${event.type} -> ${transition.state.phase}`,
      meta: this.meta({
        eventType: event.type,
        action: transition.decision.action,
        reason: transition.decision.reason,
        allowed: transition.decision.allowed,
        atMs: event.atMs,
      }),
    })
    for (const listener of [...this.listeners]) {
      try {
        listener(transition)
      } catch (error) {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.voice_floor_listener_error",
          message: "voice floor transition listener threw",
          meta: this.meta({ error: error instanceof Error ? error.message : String(error) }),
        })
      }
    }
    return transition
  }

  canRequestResponse(input: VoiceFloorResponseRequestInput, atMs?: number): VoiceFloorDecision {
    const decision = canRequestVoiceResponse(this.currentState, input)
    const stamped: VoiceFloorDecision = { ...decision, atMs: atMs ?? this.now() }
    this.emitDecision("request", stamped, { responseId: input.responseId, inputReason: input.reason })
    return stamped
  }

  canSpeakToolHolding(input: VoiceFloorToolSpeechInput, atMs?: number): VoiceFloorDecision {
    const decision = pureCanSpeakToolHolding(this.currentState, input)
    const stamped: VoiceFloorDecision = { ...decision, atMs: atMs ?? this.now() }
    this.emitDecision("tool_holding", stamped, { toolCallId: input.toolCallId })
    return stamped
  }

  canSpeakToolResult(input: VoiceFloorToolSpeechInput, atMs?: number): VoiceFloorDecision {
    const decision = pureCanSpeakToolResult(this.currentState, input)
    const stamped: VoiceFloorDecision = { ...decision, atMs: atMs ?? this.now() }
    this.emitDecision("tool_result", stamped, { toolCallId: input.toolCallId })
    return stamped
  }

  private emitDecision(query: "request" | "tool_holding" | "tool_result", decision: VoiceFloorDecision, extra: Record<string, unknown>): void {
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_floor_decision",
      message: `voice floor decision ${query} ${decision.action} (${decision.reason})`,
      meta: this.meta({
        query,
        action: decision.action,
        reason: decision.reason,
        allowed: decision.allowed,
        atMs: decision.atMs,
        ...extra,
      }),
    })
  }

  private meta(extra: Record<string, unknown>): Record<string, unknown> {
    const base: Record<string, unknown> = {
      phase: this.currentState.phase,
      floorOwner: this.currentState.floorOwner,
      transport: this.transport,
    }
    if (this.agentName) base.agentName = this.agentName
    if (this.callId) base.callId = this.callId
    return { ...base, ...extra }
  }
}
