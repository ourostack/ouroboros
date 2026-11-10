import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { QuotaReading } from "./tranche"

/**
 * Quota readings for agents, from the same places the Copilot app balancer (`quota-balance.mjs`) keeps them:
 * its local state first (`~/.config/mac-fleet/quota-balance.json`), then the fleet gist (`<machine>.quota.txt`).
 * Agents publish their own burn to the same gist as `<machine>.<agent>.quota.txt`.
 */

export const LOCAL_BALANCER_STATE = path.join(".config", "mac-fleet", "quota-balance.json")

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null)

/** Readings from one balancer state object: `{ readings: { "login@host": { pct, overage_permitted, at, reset } } }`. */
export function readingsFromBalancerState(state: unknown, source: string): QuotaReading[] {
  if (!isRecord(state) || !isRecord(state.readings)) return []
  const out: QuotaReading[] = []
  for (const [key, raw] of Object.entries(state.readings)) {
    if (!isRecord(raw) || num(raw.pct) === null) continue
    out.push({
      key,
      leftPct: num(raw.pct),
      burnPerH: num(raw.burn_per_h),
      dryAt: str(raw.dry_at),
      overageOk: raw.overage_permitted === true,
      at: str(raw.at),
      reset: str(raw.reset),
      remaining: num(raw.remaining),
      entitlement: num(raw.entitlement),
      source,
    })
  }
  return out
}

const timeOf = (reading: QuotaReading): number => {
  const at = Date.parse(reading.at ?? "")
  return Number.isNaN(at) ? -Infinity : at
}

/** Freshest reading per account. On a tie the earlier list wins, so pass local readings first. */
export function mergeReadings(...lists: readonly QuotaReading[][]): QuotaReading[] {
  const out = new Map<string, QuotaReading>()
  for (const list of lists) {
    for (const reading of list) {
      const prev = out.get(reading.key)
      if (!prev || timeOf(reading) > timeOf(prev)) out.set(reading.key, reading)
    }
  }
  return [...out.values()]
}

/** Every reading in the fleet: local balancer state first, then each other Mac's `<machine>.quota.txt` in the gist. */
export function readFleetQuota(sources: { localState?: unknown; gist?: unknown }): QuotaReading[] {
  const local = readingsFromBalancerState(sources.localState, "local")
  const fleet: QuotaReading[][] = []
  const files = isRecord(sources.gist) && isRecord(sources.gist.files) ? sources.gist.files : {}
  for (const [name, file] of Object.entries(files)) {
    const match = /^([^.]+)\.quota\.txt$/.exec(name)
    if (!match || !isRecord(file) || typeof file.content !== "string") continue
    try {
      fleet.push(readingsFromBalancerState(JSON.parse(file.content), `fleet:${match[1]}`))
    } catch {
      // A half-written file is skipped; the next read picks it up.
    }
  }
  const readings = mergeReadings(local, ...fleet)
  emitNervesEvent({
    component: "engine",
    event: "engine.fleet_quota_read",
    message: "read fleet quota readings",
    meta: { local: local.length, gistFiles: fleet.length, accounts: readings.length },
  })
  return readings
}

/** A reading from an account's own `/copilot_internal/user` answer. */
export function directReading(key: string, body: unknown, at: string): QuotaReading | null {
  if (!isRecord(body) || !isRecord(body.quota_snapshots) || !isRecord(body.quota_snapshots.premium_interactions)) return null
  const snap = body.quota_snapshots.premium_interactions
  const leftPct = snap.unlimited === true ? 100 : num(snap.percent_remaining)
  if (leftPct === null) return null
  return {
    key,
    leftPct,
    burnPerH: null,
    dryAt: null,
    overageOk: snap.overage_permitted === true,
    at,
    reset: str(body.quota_reset_date_utc),
    remaining: num(snap.remaining),
    entitlement: num(snap.entitlement),
    source: "direct",
  }
}

export function agentBurnFileName(machine: string, agent: string): string {
  return `${machine}.${agent}.quota.txt`
}

export interface AgentBurn {
  agent: string
  /** The fleet's machine name (no dots), such as `laptop` or `aris-mac-mini`. */
  machine: string
  at: string
  current: string | null
  /** Model requests this agent sent in the last hour, per account (`login@host`). */
  requestsPerH: Record<string, number>
  /** The agent's latest reading of each account it bills. */
  readings: QuotaReading[]
}

/**
 * The agent's file, in the shape the Copilot app balancer reads (`parseAgentQuota` in quota-balance.mjs):
 * `{machine, agent, at, readings: [{key, leftPct, burnPerH, dryAt, overageOk, at, remaining, entitlement, reset}]}`.
 * `burnPerH` is this agent's own requests an hour on that account.
 */
export function agentBurnContent(burn: AgentBurn): string {
  const keys = [...new Set([...burn.readings.map((reading) => reading.key), ...Object.keys(burn.requestsPerH)])]
  const readings = keys.map((key) => {
    const reading = burn.readings.find((candidate) => candidate.key === key)
    return {
      key,
      leftPct: reading?.leftPct ?? null,
      burnPerH: burn.requestsPerH[key] ?? 0,
      dryAt: reading?.dryAt ?? null,
      overageOk: reading?.overageOk ?? false,
      at: reading?.at ?? burn.at,
      ...(reading?.remaining != null ? { remaining: reading.remaining } : {}),
      ...(reading?.entitlement != null ? { entitlement: reading.entitlement } : {}),
      ...(reading?.reset ? { reset: reading.reset } : {}),
    }
  })
  return `${JSON.stringify({ machine: burn.machine, agent: burn.agent, at: burn.at, current: burn.current, readings }, null, 2)}\n`
}

export interface FleetGist {
  gistId: string
  token: string
}

export interface FleetIo {
  fetch?: typeof fetch
  readFile?: (file: string) => string
  homeDir?: string
}

const gistUrl = (gistId: string) => `https://api.github.com/gists/${gistId}`
const gistHeaders = (token: string) => ({
  Authorization: `token ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "ouro-account-pool",
})

/** Load local balancer state and the fleet gist; either may be missing. */
export async function loadFleetQuota(gist: FleetGist | null, io: FleetIo = {}): Promise<QuotaReading[]> {
  const readFile = io.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"))
  let localState: unknown
  try {
    localState = JSON.parse(readFile(path.join(io.homeDir ?? os.homedir(), LOCAL_BALANCER_STATE)))
  } catch {
    localState = undefined
  }
  let gistBody: unknown
  if (gist) {
    try {
      const response = await (io.fetch ?? fetch)(gistUrl(gist.gistId), { headers: gistHeaders(gist.token), signal: AbortSignal.timeout(15000) })
      gistBody = response.ok ? await response.json() : undefined
    } catch {
      gistBody = undefined
    }
  }
  return readFleetQuota({ localState, gist: gistBody })
}

/** Write this agent's burn to the fleet gist. Returns false (never throws) when the gist can't be written. */
export async function publishAgentBurn(gist: FleetGist, burn: AgentBurn, io: FleetIo = {}): Promise<boolean> {
  let ok = false
  try {
    const response = await (io.fetch ?? fetch)(gistUrl(gist.gistId), {
      method: "PATCH",
      headers: { ...gistHeaders(gist.token), "Content-Type": "application/json" },
      body: JSON.stringify({ files: { [agentBurnFileName(burn.machine, burn.agent)]: { content: agentBurnContent(burn) } } }),
      signal: AbortSignal.timeout(15000),
    })
    ok = response.ok
  } catch {
    ok = false
  }
  emitNervesEvent({
    level: ok ? "info" : "warn",
    component: "engine",
    event: "engine.agent_burn_published",
    message: ok ? "published agent burn to the fleet gist" : "could not publish agent burn to the fleet gist",
    meta: { agent: burn.agent, machine: burn.machine, ok },
  })
  return ok
}
