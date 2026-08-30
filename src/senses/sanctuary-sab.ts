import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { emitNervesEvent } from "../nerves/runtime"

const DEFAULT_INI_PATH = "/run/sanctuary/sabnzbd.ini"
const BASE_URL = "http://127.0.0.1:8090/api"

export interface SanctuarySabQueueSnapshot {
  paused: boolean
  status: string
  queuedJobs: number
  observedAt: string
  stateDigest: string
}

function apiKey(iniPath: string): string {
  let contents = ""
  try { contents = readFileSync(iniPath, "utf8") } catch { throw new Error("SAB queue verification credential is unavailable") }
  const value = contents.match(/^\s*api_key\s*=\s*(\S+)\s*$/mu)?.[1]
  if (!value) throw new Error("SAB queue verification credential is unavailable")
  return value
}

function queuedJobs(value: unknown): number {
  const parsed = typeof value === "string" && /^\d{1,7}$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0 || Number(parsed) > 1_000_000) throw new Error("SAB queue response is malformed")
  return Number(parsed)
}

export function createSanctuarySabClient(options: { iniPath?: string; fetch?: typeof fetch; now?: () => string } = {}) {
  const iniPath = options.iniPath ?? DEFAULT_INI_PATH
  const fetchImpl = options.fetch ?? fetch
  let cachedApiKey: string | null = null
  const request = async (mode: "queue" | "resume"): Promise<Response> => {
    cachedApiKey ??= apiKey(iniPath)
    let response: Response
    try {
      response = await fetchImpl(`${BASE_URL}?mode=${mode}${mode === "queue" ? "&output=json" : ""}&apikey=${encodeURIComponent(cachedApiKey)}`, { signal: AbortSignal.timeout(15_000) })
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
