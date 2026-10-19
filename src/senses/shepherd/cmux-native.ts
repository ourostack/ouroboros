import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"
import { CmuxSocketError, type CmuxClient } from "./client"
import { SHEPHERD_NATIVE_CAUSALITY_BLOCKER, type HostSession, type ShepherdContinuationRequest, type ShepherdContinuationResult, type ShepherdHostCapabilities, type ShepherdInspection, type ShepherdNativeInputReceipt } from "./host"
import { redactSecrets } from "./redact"

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const DIGEST = /^[0-9a-f]{64}$/
const uuid = (value: unknown): string | null => typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string" && value.trim().length > 0
const nullableBoolean = (value: unknown): value is boolean | null => value === null || typeof value === "boolean"
const digest = (text: string): string => createHash("sha256").update(text).digest("hex")
const signature = (value: ShepherdInspection): string => digest(JSON.stringify(value))
function invalid(): never { throw new CmuxSocketError("protocol", "Invalid native Shepherd evidence") }

interface Binding {
  signature: string
  token: string | null
  expiresAt: number | null
  monotonicDeadline: number
  hostInstance: string
  workspaceId: string
  surfaceId: string
  processInstance: string | null
}

/** Native-only authority. Legacy tree fields supply presentation and conservative focus, never process scope. */
export function createCmuxNativeInput(client: CmuxClient, now: () => number) {
  const inspections = new WeakMap<ShepherdInspection, Binding>()

  async function capabilities(): Promise<ShepherdHostCapabilities> {
    let response: Record<string, unknown>
    try {
      response = await client.call("system.capabilities")
    } catch (error) {
      if (error instanceof CmuxSocketError && error.code === "method_not_found") {
        return { state: "unsupported", reason: "native_guarded_discovery_unavailable" }
      }
      throw error
    }
    const native = response.shepherd_guarded_input
    if (native === undefined) return { state: "unsupported", reason: "native_guarded_input_unavailable" }
    if (!record(native) || native.protocol_version !== 1 ||
      native.state !== "unqualified" && native.state !== "qualified" ||
      !Array.isArray(native.agents) || !native.agents.every(agent => typeof agent === "string" && agent.trim().length > 0)) invalid()
    if (native.state === "unqualified") {
      return { state: "unqualified", protocolVersion: 1, agents: [...native.agents],
        ...(native.qualification_reason === SHEPHERD_NATIVE_CAUSALITY_BLOCKER
          ? { reason: SHEPHERD_NATIVE_CAUSALITY_BLOCKER } : {}) }
    }
    if (native.qualification_reason === SHEPHERD_NATIVE_CAUSALITY_BLOCKER) invalid()
    return { state: "qualified", protocolVersion: 1, agents: [...native.agents] }
  }

  async function inspect(session: HostSession, workspaceId: string): Promise<ShepherdInspection> {
    const started = performance.now()
    const response = await client.call("surface.shepherd.inspect", { workspace_id: workspaceId, surface_id: session.id })
    const receivedAt = performance.now()
    const latency = receivedAt - started
    const sampledAt = now()
    const snapshot = response.snapshot
    if (response.protocol_version !== 1 || !uuid(response.host_instance) || !record(snapshot) ||
      uuid(snapshot.workspace_id) !== uuid(workspaceId) || !uuid(workspaceId) ||
      uuid(snapshot.surface_id) !== uuid(session.id) || !uuid(session.id) ||
      !nullableText(snapshot.process_instance) || !nullableText(snapshot.agent) || !nullableText(snapshot.cwd) || !nullableText(snapshot.tty) ||
      !counter(snapshot.surface_generation) || !counter(snapshot.input_revision) || !counter(snapshot.focus_revision) ||
      typeof snapshot.focused !== "boolean" || !nullableBoolean(snapshot.idle) || !nullableBoolean(snapshot.background_work) ||
      typeof snapshot.accepts_immediate_input !== "boolean" || typeof snapshot.screen_fingerprint !== "string" ||
      typeof snapshot.outside_composer_fingerprint !== "string" ||
      snapshot.outside_composer_fingerprint !== "" && !DIGEST.test(snapshot.outside_composer_fingerprint) ||
      !record(snapshot.composer) || !["unknown", "empty", "draft", "dialog"].includes(String(snapshot.composer.state)) ||
      (snapshot.composer.state === "empty" ? snapshot.composer.draft_length !== 0 :
        snapshot.composer.state === "draft" ? !counter(snapshot.composer.draft_length) || snapshot.composer.draft_length === 0 :
          snapshot.composer.draft_length !== null) ||
      typeof response.observed_at_uptime_seconds !== "number" || !Number.isFinite(response.observed_at_uptime_seconds) || response.observed_at_uptime_seconds < 0 ||
      !counter(response.observed_at_unix_ms) || !Number.isFinite(sampledAt) || sampledAt < 0 ||
      response.screen !== null && typeof response.screen !== "string") invalid()
    const raw = response.screen
    if (typeof raw === "string" && (!DIGEST.test(snapshot.screen_fingerprint) || digest(raw) !== snapshot.screen_fingerprint)) invalid()
    const nativeToken = response.token
    if (nativeToken !== null && (!record(nativeToken) || !uuid(nativeToken.id) ||
      typeof nativeToken.expires_at_uptime_seconds !== "number" || !Number.isFinite(nativeToken.expires_at_uptime_seconds))) invalid()
    const lifetime = record(nativeToken) ? (nativeToken.expires_at_uptime_seconds as number - response.observed_at_uptime_seconds) * 1_000 : 0
    const remaining = lifetime - latency
    const focused = session.focused || snapshot.focused
    const ready = typeof raw === "string" && snapshot.process_instance !== null && snapshot.agent !== null &&
      snapshot.cwd !== null && snapshot.tty !== null && snapshot.outside_composer_fingerprint !== "" &&
      snapshot.idle === true && snapshot.background_work === false && snapshot.composer.state === "empty" &&
      snapshot.accepts_immediate_input && !focused
    const usable = ready && lifetime > 0 && lifetime <= 2_000 && remaining > 0 && latency >= 0
    const token = usable && record(nativeToken) ? uuid(nativeToken.id) : null
    const expiresAt = token ? sampledAt + remaining : null
    const value: ShepherdInspection = {
      session: { ...session, agent: snapshot.agent, cwd: snapshot.cwd, tty: snapshot.tty,
        instance: snapshot.process_instance, focused },
      instance: snapshot.process_instance,
      screen: typeof raw === "string" ? redactSecrets(raw) : "",
      screenFingerprint: typeof raw === "string" ? snapshot.screen_fingerprint : "",
      activity: raw === null || snapshot.idle === null ? "unknown" : snapshot.idle ? "idle" : "working",
      composer: raw !== null && snapshot.composer.state === "empty" ? "empty" :
        raw !== null && snapshot.composer.state === "draft" ? "draft" : "unknown",
      backgroundWork: snapshot.background_work,
      guarded: { workspaceId: uuid(workspaceId)!, hostInstance: uuid(response.host_instance)!,
        surfaceGeneration: snapshot.surface_generation, inputRevision: snapshot.input_revision, focusRevision: snapshot.focus_revision,
        token, expiresAtUnixMs: expiresAt },
    }
    inspections.set(value, { signature: signature(value), token, expiresAt, monotonicDeadline: receivedAt + remaining,
      hostInstance: value.guarded!.hostInstance,
      workspaceId: value.guarded!.workspaceId, surfaceId: value.session.id, processInstance: value.instance })
    return value
  }

  function receipt(response: Record<string, unknown>, requestId: string, bound: Binding): ShepherdNativeInputReceipt {
    const state = response.state
    if (response.protocol_version !== 1 || uuid(response.request_id) !== uuid(requestId) ||
      uuid(response.host_instance) !== bound.hostInstance || uuid(response.workspace_id) !== bound.workspaceId ||
      uuid(response.surface_id) !== uuid(bound.surfaceId) || response.process_instance !== bound.processInstance ||
      !bound.processInstance || typeof response.reason !== "string" || !response.reason || response.reason.length > 256 ||
      typeof response.paste_admitted !== "boolean" || typeof response.submit_admitted !== "boolean" ||
      response.submit_admitted && !response.paste_admitted ||
      state !== "accepted" && state !== "not_sent" && state !== "unknown" ||
      state === "accepted" && (!response.paste_admitted || !response.submit_admitted) ||
      state === "not_sent" && (response.paste_admitted || response.submit_admitted)) invalid()
    return { requestId, hostInstance: bound.hostInstance, workspaceId: bound.workspaceId, surfaceId: bound.surfaceId,
      processInstance: bound.processInstance, state, reason: response.reason,
      pasteAdmitted: response.paste_admitted, submitAdmitted: response.submit_admitted }
  }

  async function continueInput(request: ShepherdContinuationRequest, canSend: () => boolean): Promise<ShepherdContinuationResult> {
    const bound = inspections.get(request.expected)
    const fresh = () => !!bound?.token && bound.expiresAt !== null && Number.isFinite(now()) &&
      now() < bound.expiresAt && performance.now() < bound.monotonicDeadline && signature(request.expected) === bound.signature
    if (!bound || !fresh() || !uuid(request.requestId) || !request.text || request.text !== request.text.trim() ||
      request.text.length > 2_000 || Buffer.byteLength(request.text, "utf8") > 4_096 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(request.text)) {
      return { state: "not_sent", reason: "native_observation_or_text_unavailable" }
    }
    const current = await capabilities()
    if (current.state !== "qualified" || !request.expected.session.agent || !current.agents.includes(request.expected.session.agent) || !fresh()) {
      return { state: "not_sent", reason: "native_guarded_input_not_qualified_or_expired" }
    }
    let recorded: ShepherdNativeInputReceipt
    try {
      recorded = receipt(await client.call("surface.shepherd.continue", {
        request_id: request.requestId, token: bound.token, text: request.text,
      }, () => fresh() && canSend()), request.requestId, bound)
    } catch (error) {
      if (error instanceof CmuxSocketError && error.code === "not_sent") return { state: "not_sent", reason: "parent_dispatch_guard_invalidated" }
      try {
        recorded = receipt(await client.call("surface.shepherd.receipt", { request_id: request.requestId }), request.requestId, bound)
      } catch {
        throw new CmuxSocketError("unknown", "Native Shepherd input outcome is unknown; no exact bound receipt is available")
      }
    }
    return { state: recorded.state === "accepted" ? "sent" : recorded.state, receipt: recorded }
  }
  return { capabilities, inspect, continueInput }
}
