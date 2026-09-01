import { createHash } from "node:crypto"

import { emitNervesEvent } from "../nerves/runtime"

const BASE_URL = "http://127.0.0.1:8090/api"
export const SANCTUARY_SAB_CREDENTIAL_UNAVAILABLE = "SAB queue verification credential is unavailable"
export type SanctuarySabReadUnavailableCode = "credential_unavailable" | "request_unavailable" | "malformed_response"

export function sanctuarySabReadUnavailableCode(error: unknown): SanctuarySabReadUnavailableCode | undefined {
  if (!(error instanceof Error)) return undefined
  if (error.message === SANCTUARY_SAB_CREDENTIAL_UNAVAILABLE) return "credential_unavailable"
  if (error.message === "SAB queue request failed") return "request_unavailable"
  if (error.message === "SAB queue response is malformed") return "malformed_response"
  return undefined
}

export interface SanctuarySabQueueSnapshot {
  paused: boolean
  status: string
  queuedJobs: number
  observedAt: string
  stateDigest: string
}

function queuedJobs(value: unknown): number {
  const parsed = typeof value === "string" && /^\d{1,7}$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0 || Number(parsed) > 1_000_000) throw new Error("SAB queue response is malformed")
  return Number(parsed)
}

export function createSanctuarySabClient(options: { loadApiKey: () => Promise<string>; fetch?: typeof fetch; now?: () => string }) {
  const fetchImpl = options.fetch ?? fetch
  const request = async (mode: "queue" | "resume"): Promise<Response> => {
    let apiKey: string
    try { apiKey = (await options.loadApiKey()).trim() } catch { throw new Error(SANCTUARY_SAB_CREDENTIAL_UNAVAILABLE) }
    if (!apiKey) throw new Error(SANCTUARY_SAB_CREDENTIAL_UNAVAILABLE)
    let response: Response
    try {
      response = await fetchImpl(`${BASE_URL}?mode=${mode}${mode === "queue" ? "&output=json" : ""}&apikey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15_000) })
    } catch {
      throw new Error("SAB queue request failed")
    }
    if (!response.ok) throw new Error("SAB queue request failed")
    return response
  }
  const readQueue = async (): Promise<SanctuarySabQueueSnapshot> => {
    const response = await request("queue")
    const body = await response.json() as unknown
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("SAB queue response is malformed")
    const queue = (body as Record<string, unknown>).queue
    if (!queue || typeof queue !== "object" || Array.isArray(queue)) throw new Error("SAB queue response is malformed")
    const fields = queue as Record<string, unknown>
    if (typeof fields.paused !== "boolean" || (fields.status !== undefined && (typeof fields.status !== "string" || Buffer.byteLength(fields.status) > 64))) throw new Error("SAB queue response is malformed")
    const status = typeof fields.status === "string" ? fields.status : "unknown"
    const jobs = fields.noofslots === undefined ? 0 : queuedJobs(fields.noofslots)
    const observedAt = options.now?.() ?? new Date().toISOString()
    const stateDigest = createHash("sha256").update(JSON.stringify({ paused: fields.paused, status, queuedJobs: jobs })).digest("hex")
    return { paused: fields.paused, status, queuedJobs: jobs, observedAt, stateDigest }
  }
  return {
    readQueue,
    async resumeQueue() {
      const before = await readQueue()
      if (!before.paused) {
        const receiptDigest = createHash("sha256").update(`sabnzbd.resume\0${before.stateDigest}\0${before.stateDigest}`).digest("hex")
        return { changed: false, before, after: before, verified: true, receiptDigest }
      }
      const response = await request("resume")
      await response.body?.cancel().catch(() => undefined)
      const after = await readQueue()
      if (after.paused) throw new Error("SAB queue resume could not be verified")
      const receiptDigest = createHash("sha256").update(`sabnzbd.resume\0${before.stateDigest}\0${after.stateDigest}`).digest("hex")
      return { changed: true, before, after, verified: true, receiptDigest }
    },
  }
}

emitNervesEvent({ component: "senses", event: "senses.sanctuary_sab_loaded", message: "typed Sanctuary SAB queue client loaded", meta: { operations: 2 } })
