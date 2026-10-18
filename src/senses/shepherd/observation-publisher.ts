import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { readShepherdMandates, resolveShepherdMandate } from "../../heart/shepherd/mandates"
import {
  isShepherdSupervisionSnapshot, SHEPHERD_OBSERVATION_FILE, SHEPHERD_OBSERVATION_MAX_BYTES, SHEPHERD_SUPERVISION_LIMIT,
  type ShepherdSupervisionSnapshot, type ShepherdSupervisionSource, type ShepherdSupervisionEvent, type ShepherdSupervisionPage,
  type ShepherdSupervisionCustody, type ShepherdSupervisionError,
} from "../../heart/shepherd/supervision"
import { emitNervesEvent } from "../../nerves/runtime"
import { applicableGuidance, readGuidance } from "./guidance"
import { readNoticeOutbox } from "./notice-outbox"
import { readCheckInSnapshot } from "./recovery"
import { checkInStorePath, validateCustodyDirectory } from "./checkin-store"
import { returnsLogPath, shepherdStateDir } from "./returns"
import { redactSecrets } from "./redact"
import type { ShepherdHostObservation } from "./host"

type EventPage = ShepherdSupervisionPage<ShepherdSupervisionEvent>
interface ReturnSummary {
  at: string; host: string; session: string; transition: string; kind: string
  action: "respond" | "let_through"; reason: string
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const kinds = new Set(["premature", "gate", "done", "working", "waiting", "unclear", "error", "loop_guard"])
const safe = (value: string): string => redactSecrets(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").trim().slice(0, 2000) || "(unnamed)"
const idFor = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const iso = (at: string): string => {
  if (!Number.isFinite(Date.parse(at))) throw new Error("Invalid observation source timestamp")
  return new Date(at).toISOString()
}
const emptyPage = (): EventPage => ({ totalCount: 0, truncated: false, items: [] })
const unknownCustody = (): ShepherdSupervisionCustody => ({
  revision: null, bytes: null, capacity: "unknown", claims: { totalCount: null, truncated: true, items: [] },
})
function page(events: ShepherdSupervisionEvent[], totalCount?: number | null): EventPage {
  const unique = [...new Map(events.map(event => [event.id, event])).values()]
  const count = totalCount === undefined ? unique.length : totalCount
  const items = unique.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, SHEPHERD_SUPERVISION_LIMIT)
  return { items, totalCount: count, truncated: count === null || count > items.length }
}

/** Unlike the legacy convenience reader, a malformed row never becomes a healthy empty history. */
function readReturnSummaries(root: string): ReturnSummary[] | null {
  const file = returnsLogPath(root)
  const metadata = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!metadata) return null
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > SHEPHERD_OBSERVATION_MAX_BYTES) throw new Error("Invalid returns source")
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  let raw: string
  try {
    const opened = fs.fstatSync(fd)
    if (opened.ino !== metadata.ino || opened.dev !== metadata.dev) throw new Error("Returns source changed")
    const bytes = Buffer.alloc(SHEPHERD_OBSERVATION_MAX_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const received = fs.readSync(fd, bytes, size, bytes.length - size, null)
      if (!received) break
      size += received
    }
    if (size > SHEPHERD_OBSERVATION_MAX_BYTES) throw new Error("Returns source exceeds limit")
    raw = bytes.toString("utf8", 0, size)
  } finally { fs.closeSync(fd) }
  return raw.split("\n").filter(line => line.trim()).map(line => {
    const value: unknown = JSON.parse(line)
    if (!object(value) || typeof value.at !== "string" || typeof value.host !== "string" || typeof value.session !== "string"
      || typeof value.transition !== "string" || typeof value.kind !== "string" || !kinds.has(value.kind)
      || !value.host || !value.session || !value.transition || (value.action !== "respond" && value.action !== "let_through")
      || typeof value.reason !== "string") throw new Error("Invalid returns source schema")
    return { at: iso(value.at), host: safe(value.host), session: safe(value.session), transition: value.transition, kind: value.kind,
      action: value.action, reason: safe(value.reason) }
  })
}

export function createShepherdObservationPublisher(options: {
  agentRoot: string
  agentName: string
  host: string
  now?: () => number
}): {
  observe(observation: ShepherdHostObservation): boolean
  refresh(): boolean
  stop(): void
} {
  const now = options.now ?? Date.now
  let stopped = false
  let observed: ShepherdHostObservation | null = null
  let returns: ReturnSummary[] = []
  let custody = unknownCustody()
  const events: Record<"returns" | "custody" | "notices", EventPage> = { returns: emptyPage(), custody: emptyPage(), notices: emptyPage() }
  let observations = emptyPage()

  function projectAndPublish(): boolean {
    const at = now()
    const health: ShepherdSupervisionSnapshot["sourceHealth"] = {
      host: observed && !observed.error ? "ok" : "missing", guidance: "ok", mandates: "ok", returns: "ok", custody: "ok", notices: "ok",
    }
    const errors: ShepherdSupervisionError[] = []
    const fail = (source: ShepherdSupervisionSource): void => {
      health[source] = "error"
      errors.push({ source, code: "read_failed", detail: `The ${source} source could not be read. Any retained history is not current.` })
    }
    const read = <T>(source: ShepherdSupervisionSource, fn: () => T): T | null => {
      try { return fn() } catch { fail(source); return null }
    }
    const guidance = read("guidance", () => readGuidance(options.agentRoot))
    const mandates = read("mandates", () => readShepherdMandates(options.agentRoot))
    try {
      const current = readReturnSummaries(options.agentRoot)
      if (current === null) health.returns = "missing"
      else {
        returns = current
        events.returns = page(current.map(record => ({
          id: `return:${idFor([record.host, record.session, record.transition, record.at])}`,
          host: record.host, session: record.session, instance: null, at: record.at, kind: "judgment", summary: record.kind,
        })))
      }
    } catch { fail("returns") }
    try {
      const current = readCheckInSnapshot(checkInStorePath(options.agentRoot), { limit: SHEPHERD_SUPERVISION_LIMIT })
      if (current.state === "missing") health.custody = "missing"
      else {
        custody = {
          revision: current.revision, bytes: current.bytes, capacity: current.capacity,
          claims: { totalCount: current.totalCount, truncated: current.nextCursor !== null, items: current.entries.map(entry => ({
            id: entry.id, host: safe(entry.host), session: safe(entry.session), instance: entry.instance === null ? null : safe(entry.instance),
            state: entry.state, claimedAt: iso(entry.claimedAt), reason: entry.reason === null ? null : safe(entry.reason), retired: entry.retired,
          })) },
        }
        events.custody = page(current.entries.flatMap(entry => {
          const base = { host: safe(entry.host), session: safe(entry.session), instance: entry.instance === null ? null : safe(entry.instance) }
          const boundAdmission = entry.receipt?.requestId === entry.id && entry.receipt.surfaceId === entry.session
            && entry.receipt.processInstance === entry.instance && entry.receipt.pasteAdmitted && entry.receipt.submitAdmitted
          return [{
            ...base, id: `input:${entry.id}`, at: iso(entry.claimedAt),
            kind: entry.state === "sent" ? boundAdmission ? "input_admitted" as const : "legacy_input_reported" as const
              : entry.state === "not_sent" ? "observation" as const : "input_unknown" as const,
            summary: entry.state === "sent" ? boundAdmission ? "Bound host receipt reports paste and submit admission; not proof of task completion"
              : "Legacy dispatcher reported sent; no qualified bound paste-and-submit receipt. Not proof of input admission or task completion."
              : entry.state === "not_sent" ? "Input refused; no terminal input"
                : "Claim held; input outcome is unknown. Reconcile evidence, do not retry blindly.",
          }, ...entry.reconciliations.map(receipt => ({
            ...base, id: `recovery:${entry.id}:${receipt.revision}`, at: iso(receipt.at),
            kind: "recovery" as const, summary: `Owner acknowledged recovery: ${receipt.resolution}; original state ${receipt.originalState}`,
          }))]
        }), current.nextCursor === null ? undefined : null)
      }
    } catch { fail("custody") }
    try {
      events.notices = page(readNoticeOutbox(options.agentRoot).flatMap(entry => {
        const base = { host: safe(entry.record.host), session: safe(entry.record.session), instance: null }
        return [{
          ...base, id: `notice:${entry.id}`, at: iso(entry.record.at), kind: "notification_queued" as const, summary: "Owner notification queued",
        }, ...Object.entries(entry.deliveries).map(([recipient, delivery]) => ({
          ...base, id: `notice:${entry.id}:${idFor(recipient)}`, at: iso(delivery.at),
          kind: delivery.state === "sent" ? "notification_delivered" as const
            : delivery.state === "unknown" ? "notification_unknown" as const : "notification_queued" as const,
          summary: delivery.state === "sent" ? "Owner notification accepted by transport; not proof the owner read it"
            : delivery.state === "unknown" ? "Owner notification delivery is unknown" : "Owner notification pending transport",
        }))]
      }))
    } catch { fail("notices") }
    if (observed?.error) errors.push({ source: "host", code: observed.error, detail: observed.error === "sense_stopped"
      ? "The Shepherd sense is stopped. Retained observations are historical."
      : "The terminal host is unavailable. Retained observations are historical." })
    const sessions = (observed?.sessions ?? []).slice(0, SHEPHERD_SUPERVISION_LIMIT).map(row => {
      const session = row.session
      let authority: "active" | "absent" | "paused" | "ambiguous" | "unknown" = "unknown"
      let withheldReason = row.error ? "Terminal could not be read; no current policy assessment" : "Guarded automatic input is not qualified for this host"
      if (row.error && errors.length < 50) errors.push({ source: "host", code: "row_read_failed", detail: `Terminal ${safe(session.id)} could not be read` })
      if (guidance && mandates) {
        if (applicableGuidance(guidance, { host: options.host, session: session.id, cwd: session.cwd ?? null, task: null }).paused) authority = "paused"
        else if (session.cwd) {
          const resolution = resolveShepherdMandate(mandates, {
            project: session.cwd, host: options.host, session: session.id, ...(session.instance ? { instance: session.instance } : {}),
          }, at)
          authority = resolution.state === "authorized" ? "active" : resolution.reason === "ambiguous_mandates" ? "ambiguous" : "absent"
        } else authority = "absent"
        if (authority === "paused") withheldReason = "Stored terminal pause is set"
        else if (authority === "absent") withheldReason = "No applicable stored mandate; legacy automatic paths are not uniformly mandate-enforced"
        else if (authority === "ambiguous") withheldReason = "Multiple stored mandates apply; policy scope is ambiguous"
      }
      const last = returns.filter(record => record.host === options.host && record.session === safe(session.id)).sort((a, b) => b.at.localeCompare(a.at))[0]
      return {
        host: safe(options.host), session: safe(session.id), instance: session.instance ? safe(session.instance) : null,
        label: safe(session.title || session.ref || session.id), harness: session.agent ? safe(session.agent) : null,
        project: session.cwd ? safe(session.cwd) : null, activity: row.activity,
        observedAt: row.observedAt === null ? null : new Date(row.observedAt).toISOString(),
        lastDecision: last?.kind ?? null, lastAction: last?.action ?? null, lastReason: last?.reason ?? null,
        lastActionAt: last?.at ?? null, withheldReason, authority, capability: "unsupported" as const,
      }
    })
    const allEvents = [...Object.values(events), observations]
    const total = allEvents.some(value => value.totalCount === null) ? null : allEvents.reduce((sum, value) => sum + value.totalCount!, 0)
    const snapshot: ShepherdSupervisionSnapshot = {
      schemaVersion: 1, agentName: options.agentName, observedAt: new Date(observed?.at ?? at).toISOString(),
      sourceHealth: health, sourceErrors: errors,
      sessions: { totalCount: observed ? observed.sessions.length : null,
        truncated: !observed || observed.sessions.length > sessions.length, items: sessions },
      timeline: page(allEvents.flatMap(value => value.items), total), custody,
    }
    try {
      if (!isShepherdSupervisionSnapshot(snapshot)) throw new Error("Invalid bounded observation projection")
      const encoded = JSON.stringify(snapshot)
      if (Buffer.byteLength(encoded) > SHEPHERD_OBSERVATION_MAX_BYTES) throw new Error("Observation exceeds publication limit")
      const dir = shepherdStateDir(options.agentRoot)
      validateCustodyDirectory(dir, true)
      const temporary = path.join(dir, `${SHEPHERD_OBSERVATION_FILE}.${randomUUID()}.tmp`)
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temporary, path.join(dir, SHEPHERD_OBSERVATION_FILE))
      const directory = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
      return true
    } catch {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_observation_failed",
        message: "Could not publish a safe Shepherd observation; the previous replica must age out", meta: { agent: options.agentName } })
      return false
    }
  }
  function publish(): boolean {
    try { return projectAndPublish() } catch {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_observation_failed",
        message: "Could not assemble a Shepherd observation; the previous replica must age out", meta: { agent: options.agentName } })
      return false
    }
  }
  return {
    observe(observation) {
      if (stopped) return false
      observed = structuredClone(observation)
      if (!observation.error) {
        const current = observation.sessions.slice(0, SHEPHERD_SUPERVISION_LIMIT).map(row => ({
          id: `observation:${idFor([options.host, row.session.id, row.session.instance ?? null, observation.at])}`,
          host: safe(options.host), session: safe(row.session.id), instance: row.session.instance ? safe(row.session.instance) : null,
          at: new Date(observation.at).toISOString(), kind: "observation" as const,
          summary: row.error ? "Terminal observation failed" : `Observed terminal activity: ${row.activity}`,
        }))
        const unique = new Map([...current, ...observations.items].map(event => [event.id, event]))
        observations = page([...unique.values()], (observations.totalCount ?? 0)
          + current.filter(event => !observations.items.some(previous => previous.id === event.id)).length)
      }
      return publish()
    },
    refresh() { return !stopped && publish() },
    stop() {
      if (stopped) return
      observed = { ...(observed ?? { at: 0, sessions: [] }), error: "sense_stopped" }
      publish()
      stopped = true
    },
  }
}
