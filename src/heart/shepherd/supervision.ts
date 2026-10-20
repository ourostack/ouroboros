export const SHEPHERD_SUPERVISION_LIMIT = 200
export const SHEPHERD_SUPERVISION_STALE_MS = 30_000
export const SHEPHERD_OBSERVATION_FILE = "supervision-observation.json"
export const SHEPHERD_OBSERVATION_MAX_BYTES = 2 * 1024 * 1024
export const SHEPHERD_ALPHA_AUTOMATION_WARNING = "Automatic input is fail-closed: every trigger requires a current protected mandate and qualified native guarded input. Unsupported or unqualified hosts are observation-only. Automatic menu, navigation and control keys are refused. Stored policy and source tests are not proof of native runtime or editor qualification."
export const SHEPHERD_SUPERVISION_SOURCES = ["host", "guidance", "mandates", "returns", "custody", "notices"] as const
export type ShepherdSupervisionSource = typeof SHEPHERD_SUPERVISION_SOURCES[number]
export type ShepherdSourceHealth = "ok" | "missing" | "error"
export type ShepherdActivity = "working" | "idle" | "shell" | "unknown"
export type ShepherdAuthority = "active" | "absent" | "paused" | "ambiguous" | "unknown"
export type ShepherdTimelineKind = "observation" | "judgment" | "input_admitted" | "legacy_input_reported" | "input_unknown"
  | "notification_queued" | "notification_delivered" | "notification_unknown" | "recovery"

export interface ShepherdSupervisionError {
  source: ShepherdSupervisionSource | "replica"
  code: string
  detail: string
}
export interface ShepherdSupervisionManagedSession {
  kind: "agent_session"
  provider: "copilot" | "claude" | "codex"
  profileSha256: string
  qualification: "qualified" | "unqualified" | "unknown"
  qualificationReason: string | null
  workCoverage: "complete" | "unknown"
  /** Local request start, not a paint timestamp. Its age bounds capture age from above. */
  renderCaptureStartedAt: string | null
}
export interface ShepherdSupervisionManagedClaim {
  nativeRequestId: string
  provider: ShepherdSupervisionManagedSession["provider"]
  profileSha256: string
  receiptVersion: 1 | null
  /** False means unproven, not proof that no effects occurred. Null means no receipt. */
  editorInserted: boolean | null
  backendWriteAdmitted: boolean | null
  providerAcknowledged: boolean | null
  providerInputId: string | null
}
export interface ShepherdSupervisionSession {
  kind?: "agent_session"
  host: string
  session: string
  instance: string | null
  label: string
  harness: string | null
  project: string | null
  activity: ShepherdActivity
  observedAt: string | null
  lastDecision: string | null
  lastAction: "respond" | "let_through" | null
  lastReason: string | null
  lastActionAt: string | null
  withheldReason: string | null
  /** Stored policy evaluation, not proof of current input eligibility or native qualification. */
  authority: ShepherdAuthority
  capability: "supported" | "unsupported" | "unknown"
  managed?: ShepherdSupervisionManagedSession
}
export interface ShepherdSupervisionEvent {
  id: string
  host: string
  session: string
  instance: string | null
  at: string
  kind: ShepherdTimelineKind
  summary: string
}
export interface ShepherdSupervisionPage<T> {
  totalCount: number | null
  truncated: boolean
  items: T[]
}
export interface ShepherdSupervisionClaim {
  id: string
  host: string
  session: string
  instance: string | null
  state: "claimed" | "sent" | "not_sent" | "unknown"
  claimedAt: string
  reason: string | null
  retired: boolean
  managed?: ShepherdSupervisionManagedClaim
}
export interface ShepherdSupervisionCustody {
  revision: number | null
  bytes: number | null
  capacity: "normal" | "warning" | "refused" | "unknown"
  claims: ShepherdSupervisionPage<ShepherdSupervisionClaim>
}
export interface ShepherdSupervisionSnapshot {
  schemaVersion: 1
  agentName: string
  observedAt: string
  sourceHealth: Record<ShepherdSupervisionSource, ShepherdSourceHealth>
  sessions: ShepherdSupervisionPage<ShepherdSupervisionSession>
  timeline: ShepherdSupervisionPage<ShepherdSupervisionEvent>
  custody: ShepherdSupervisionCustody
  sourceErrors: ShepherdSupervisionError[]
}
export interface ShepherdObservationFreshness {
  status: "fresh" | "stale" | "unknown"
  observedAt: string | null
  ageMs: number | null
}
export interface ShepherdObservationClock {
  nowMs: number
  monotonicMs: number
}
/** IO callers retain this floor across reads; a wall-clock rollback cannot rejuvenate evidence. */
export function advanceShepherdObservationClock(
  previous: ShepherdObservationClock | null, wallMs: number, monotonicMs: number,
): ShepherdObservationClock {
  return { nowMs: previous === null ? wallMs
    : Math.max(wallMs, previous.nowMs + Math.max(0, monotonicMs - previous.monotonicMs)), monotonicMs }
}
/** A future stamp stays invalid until a newer, independently current observation replaces it. */
export function shepherdObservationClockBarrier(previous: number | null, observedAt: string | null, nowMs: number): number | null {
  const stampedAt = observedAt === null ? NaN : Date.parse(observedAt)
  if (!Number.isFinite(stampedAt)) return previous
  if (stampedAt > nowMs) return Math.max(previous ?? stampedAt, stampedAt)
  return previous !== null && stampedAt <= previous ? previous : null
}
export interface ShepherdSupervisionView extends Omit<ShepherdSupervisionSnapshot, "sessions" | "observedAt"> {
  freshness: ShepherdObservationFreshness
  health: "ok" | "degraded"
  counts: Record<ShepherdActivity, number> | null
  sessions: ShepherdSupervisionPage<ShepherdSupervisionSession & {
    freshness: ShepherdObservationFreshness
    lastDecisionLabel: string | null
  }>
}

function freshness(at: string | null, nowMs: number): ShepherdObservationFreshness {
  const ageMs = at === null ? NaN : nowMs - Date.parse(at)
  return !Number.isFinite(ageMs) || ageMs < 0
    ? { status: "unknown", observedAt: at, ageMs: null }
    : { status: ageMs > SHEPHERD_SUPERVISION_STALE_MS ? "stale" : "fresh", observedAt: at, ageMs }
}

export function shepherdManagedCaptureFresh(managed: ShepherdSupervisionManagedSession, nowMs: number): boolean {
  return freshness(managed.renderCaptureStartedAt, nowMs).status === "fresh"
}

/** Observation is not authority; aging may only weaken current claims, never promote them. */
export function buildShepherdSupervisionView(snapshot: ShepherdSupervisionSnapshot, nowMs: number): ShepherdSupervisionView {
  const current = freshness(snapshot.observedAt, nowMs)
  const hostAvailable = snapshot.sourceHealth.host === "ok" && current.status !== "unknown"
  const sessions = snapshot.sessions.items.map(row => {
    const observed = freshness(row.observedAt, nowMs)
    const fresh = hostAvailable && current.status === "fresh" && observed.status === "fresh"
      && (!row.managed || shepherdManagedCaptureFresh(row.managed, nowMs))
    return {
      ...row,
      freshness: observed,
      activity: fresh ? row.activity : "unknown" as const,
      authority: fresh && snapshot.sourceHealth.mandates === "ok" && snapshot.sourceHealth.guidance === "ok"
        ? row.authority : "unknown" as const,
      capability: fresh ? row.capability : "unknown" as const,
      ...(row.managed ? { managed: { ...row.managed, ...(!fresh ? {
        qualification: "unknown" as const, qualificationReason: "observation_not_current", workCoverage: "unknown" as const,
      } : {}) } } : {}),
      lastDecisionLabel: row.lastDecision === "done" ? "Agent reports finished" : row.lastDecision,
    }
  })
  const counts = hostAvailable ? { working: 0, idle: 0, shell: 0, unknown: 0 } : null
  if (counts) for (const row of sessions) counts[row.activity] += 1
  return {
    schemaVersion: 1,
    agentName: snapshot.agentName,
    freshness: current,
    health: snapshot.sourceErrors.length || Object.values(snapshot.sourceHealth).some(value => value !== "ok") ? "degraded" : "ok",
    sourceHealth: { ...snapshot.sourceHealth },
    counts,
    sessions: { ...snapshot.sessions, items: sessions },
    timeline: { ...snapshot.timeline, items: snapshot.timeline.items.map(event => ({
      ...event, summary: event.kind === "judgment" && event.summary === "done" ? "Agent reports finished" : event.summary,
    })) },
    custody: { ...snapshot.custody, claims: { ...snapshot.custody.claims, items: snapshot.custody.claims.items.map(claim => ({
      ...claim, ...(claim.managed ? { managed: { ...claim.managed } } : {}),
    })) } },
    sourceErrors: snapshot.sourceErrors.map(error => ({ ...error })),
  }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2000 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)
const nullableText = (value: unknown): value is string | null => value === null || text(value)
const date = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const oneOf = (value: unknown, values: readonly string[]): boolean => typeof value === "string" && values.includes(value)
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const digest = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const provider = (value: unknown): boolean => oneOf(value, ["copilot", "claude", "codex"])

function validManagedSession(value: unknown): value is ShepherdSupervisionManagedSession {
  return object(value) && exact(value, ["kind", "provider", "profileSha256", "qualification", "qualificationReason", "workCoverage", "renderCaptureStartedAt"])
    && value.kind === "agent_session" && provider(value.provider) && digest(value.profileSha256)
    && oneOf(value.qualification, ["qualified", "unqualified", "unknown"])
    && (value.qualification === "qualified" ? value.qualificationReason === null : text(value.qualificationReason))
    && oneOf(value.workCoverage, ["complete", "unknown"])
    && (value.renderCaptureStartedAt === null || date(value.renderCaptureStartedAt))
}
function validManagedClaim(value: unknown, state: unknown): value is ShepherdSupervisionManagedClaim {
  if (!object(value) || !exact(value, ["nativeRequestId", "provider", "profileSha256", "receiptVersion", "editorInserted",
    "backendWriteAdmitted", "providerAcknowledged", "providerInputId"])
    || typeof value.nativeRequestId !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.nativeRequestId)
    || !provider(value.provider) || !digest(value.profileSha256)) return false
  if (value.receiptVersion === null) return value.editorInserted === null && value.backendWriteAdmitted === null
    && value.providerAcknowledged === null && value.providerInputId === null && state !== "sent"
  return value.receiptVersion === 1
    && typeof value.editorInserted === "boolean" && typeof value.backendWriteAdmitted === "boolean"
    && typeof value.providerAcknowledged === "boolean" && nullableText(value.providerInputId)
    && (!value.backendWriteAdmitted || value.editorInserted) && (!value.providerAcknowledged || value.backendWriteAdmitted)
    && value.providerAcknowledged === (value.providerInputId !== null)
    && (state === "sent" ? value.editorInserted && value.backendWriteAdmitted && value.providerAcknowledged
      : state === "not_sent" ? !value.editorInserted && !value.backendWriteAdmitted && !value.providerAcknowledged
        : true)
}

function validPage<T>(value: unknown, validItem: (item: unknown) => item is T): value is ShepherdSupervisionPage<T> {
  return object(value) && exact(value, ["totalCount", "truncated", "items"])
    && (value.totalCount === null || count(value.totalCount)) && typeof value.truncated === "boolean"
    && Array.isArray(value.items) && value.items.length <= SHEPHERD_SUPERVISION_LIMIT && value.items.every(validItem)
    && (value.totalCount === null ? value.truncated : value.totalCount >= value.items.length
      && value.truncated === (value.totalCount > value.items.length))
}
function validSession(value: unknown): value is ShepherdSupervisionSession {
  return object(value) && exact(value, ["host", "session", "instance", "label", "harness", "project", "activity",
    "observedAt", "lastDecision", "lastAction", "lastReason", "lastActionAt", "withheldReason", "authority", "capability",
    ...(Object.hasOwn(value, "managed") ? ["managed"] : []), ...(Object.hasOwn(value, "kind") ? ["kind"] : [])])
    && text(value.host) && text(value.session) && nullableText(value.instance) && text(value.label)
    && nullableText(value.harness) && nullableText(value.project) && nullableText(value.lastDecision) && nullableText(value.withheldReason)
    && (value.lastAction === null || oneOf(value.lastAction, ["respond", "let_through"])) && nullableText(value.lastReason)
    && (value.lastActionAt === null || date(value.lastActionAt))
    && (value.observedAt === null || date(value.observedAt)) && oneOf(value.activity, ["working", "idle", "shell", "unknown"])
    && oneOf(value.authority, ["active", "absent", "paused", "ambiguous", "unknown"])
    && oneOf(value.capability, ["supported", "unsupported", "unknown"])
    && (!Object.hasOwn(value, "kind") || value.kind === "agent_session")
    && (!Object.hasOwn(value, "managed") || validManagedSession(value.managed)
      && (value.managed.renderCaptureStartedAt === null || typeof value.observedAt === "string"
        && Date.parse(value.managed.renderCaptureStartedAt) <= Date.parse(value.observedAt)))
}
function validEvent(value: unknown): value is ShepherdSupervisionEvent {
  return object(value) && exact(value, ["id", "host", "session", "instance", "at", "kind", "summary"])
    && text(value.id) && text(value.host) && text(value.session) && nullableText(value.instance) && date(value.at) && text(value.summary)
    && oneOf(value.kind, ["observation", "judgment", "input_admitted", "legacy_input_reported", "input_unknown", "notification_queued",
      "notification_delivered", "notification_unknown", "recovery"])
}
function validClaim(value: unknown): value is ShepherdSupervisionClaim {
  return object(value) && exact(value, ["id", "host", "session", "instance", "state", "claimedAt", "reason", "retired",
    ...(Object.hasOwn(value, "managed") ? ["managed"] : [])])
    && typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id)
    && text(value.host) && text(value.session) && nullableText(value.instance) && date(value.claimedAt)
    && nullableText(value.reason) && typeof value.retired === "boolean" && oneOf(value.state, ["claimed", "sent", "not_sent", "unknown"])
    && (!Object.hasOwn(value, "managed") || validManagedClaim(value.managed, value.state))
}
export function isShepherdSupervisionSnapshot(value: unknown): value is ShepherdSupervisionSnapshot {
  if (!object(value) || !exact(value, ["schemaVersion", "agentName", "observedAt", "sourceHealth", "sessions", "timeline", "custody", "sourceErrors"])
    || value.schemaVersion !== 1 || typeof value.agentName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value.agentName)
    || !date(value.observedAt) || !object(value.sourceHealth)
    || !exact(value.sourceHealth, [...SHEPHERD_SUPERVISION_SOURCES])
    || !Object.values(value.sourceHealth).every(health => oneOf(health, ["ok", "missing", "error"]))
    || !validPage(value.sessions, validSession) || !validPage(value.timeline, validEvent)
    || !object(value.custody) || !exact(value.custody, ["revision", "bytes", "capacity", "claims"])
    || !(value.custody.revision === null || count(value.custody.revision))
    || !(value.custody.bytes === null || count(value.custody.bytes))
    || !oneOf(value.custody.capacity, ["normal", "warning", "refused", "unknown"])
    || !validPage(value.custody.claims, validClaim)
    || !Array.isArray(value.sourceErrors) || value.sourceErrors.length > 50
    || !value.sourceErrors.every(error => object(error) && exact(error, ["source", "code", "detail"])
      && oneOf(error.source, [...SHEPHERD_SUPERVISION_SOURCES, "replica"]) && text(error.code) && text(error.detail))) return false
  const sessions = value.sessions
  const timeline = value.timeline
  const observedAt = value.observedAt
  return new Set(sessions.items.map(row => JSON.stringify([row.host, row.session]))).size === sessions.items.length
    && new Set(timeline.items.map(event => event.id)).size === timeline.items.length
    && new Set(value.custody.claims.items.map(claim => claim.id)).size === value.custody.claims.items.length
    && sessions.items.every(row => row.observedAt === null || Date.parse(row.observedAt) <= Date.parse(observedAt))
}
