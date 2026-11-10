import { spawnSync as defaultSpawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { DEFAULT_TRANCHE_CAPS, pickByTranche, trancheCap, usedPct, type QuotaReading } from "../quota/tranche"
import { directReading, mergeReadings, type AgentBurn } from "../quota/fleet-readings"

/**
 * A provider account pool. The accounts are discovered, never hard-coded: they are the GitHub accounts
 * signed in to the Copilot app (its consumption page), each checked on its own host. Between turns the
 * agent stays on its account until that account reaches the current quota tranche; on a 402 or 429 it
 * moves at once and retries that turn on the next account. Every move is one line in
 * `state/account-switches.jsonl`.
 */

export interface PoolAccount {
  login: string
  host: string
  baseUrl: string
  githubToken: string
}

export type PoolEligibility = "work" | "personal" | string[]

/** `accountPool` in agent.json. Read when `ouro auth` discovers the pool. */
export interface AccountPoolSettings {
  /** Which accounts this agent may bill: "work" (Microsoft accounts), "personal", or `login@host` globs. */
  eligible?: PoolEligibility
  /** Where the agent publishes its burn and reads the fleet's readings. */
  fleet?: { gistId: string; user?: string; machine?: string }
}

export interface DiscoveredAccount {
  login: string
  host: string
  copilot: boolean
}

export interface DiscoveryDeps {
  spawnSync?: typeof defaultSpawnSync
  fetch?: typeof fetch
  homeDir?: string
  now?: () => Date
}

export const accountKey = (account: { login: string; host: string }): string => `${account.login}@${account.host}`

/**
 * This Mac's name for the fleet gist: macOS's LocalHostName (unique on the network, and what the fleet tooling
 * keys Macs by), else the host name, lowercased with no dots. Generic host names such as "Mac" would make two
 * machines write one file.
 */
export function defaultMachineName(deps: { spawnSync?: typeof defaultSpawnSync; hostname?: () => string; platform?: NodeJS.Platform } = {}): string {
  let name = ""
  if ((deps.platform ?? process.platform) === "darwin") {
    const result = spawnOf(deps)("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 3000 })
    name = result.status === 0 ? String(result.stdout ?? "").trim() : ""
  }
  if (!name) name = (deps.hostname ?? os.hostname)().split(".")[0]
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
}

export function apiBaseForHost(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://api.${host}`
}

/** A Microsoft account: a GitHub Enterprise (ghe.com) host, or the EMU `_microsoft` login on github.com. */
export function isWorkAccount(key: string): boolean {
  const at = key.lastIndexOf("@")
  const login = key.slice(0, at)
  const host = key.slice(at + 1).toLowerCase()
  return host.endsWith(".ghe.com") || /_microsoft$/i.test(login)
}

export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
  return new RegExp(`^${escaped}$`, "i").test(value)
}

export function isEligible(key: string, eligible: PoolEligibility = "work"): boolean {
  if (eligible === "work") return isWorkAccount(key)
  if (eligible === "personal") return !isWorkAccount(key)
  return eligible.some((pattern) => globMatch(pattern, key))
}

/* v8 ignore next -- tests always inject spawnSync; the default is for production @preserve */
const spawnOf = (deps: DiscoveryDeps): typeof defaultSpawnSync => deps.spawnSync ?? defaultSpawnSync

function cleanGhEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].filter(Boolean).join(":") }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  delete env.GH_ENTERPRISE_TOKEN
  delete env.GH_HOST
  return env
}

/**
 * The accounts signed in to the Copilot app, from its own database, in the app's order (default first, then
 * sign-in order): the order accounts are filled in. Null when the app isn't installed.
 */
export function readAppAccounts(deps: DiscoveryDeps = {}): DiscoveredAccount[] | null {
  const spawnSync = spawnOf(deps)
  const db = path.join(deps.homeDir ?? os.homedir(), ".copilot", "data.db")
  const result = spawnSync("/usr/bin/sqlite3", ["-readonly", "-json", "-cmd", ".timeout 3000", db,
    "SELECT login, host, settings_json FROM accounts WHERE kind = 'github' ORDER BY is_default DESC, created_at, rowid"], { encoding: "utf8", timeout: 15000 })
  if (result.status !== 0 || typeof result.stdout !== "string") return null
  try {
    const rows = result.stdout.trim() ? JSON.parse(result.stdout) as Array<Record<string, unknown>> : []
    return rows.map((row) => {
      let settings: Record<string, unknown> = {}
      try {
        settings = JSON.parse(String(row.settings_json ?? "{}")) as Record<string, unknown>
      } catch {
        settings = {}
      }
      return {
        login: String(row.login),
        host: String(row.host),
        copilot: settings.copilotAccess !== false && settings.copilotAppEnabled !== false,
      }
    })
  } catch {
    return null
  }
}

/** The accounts the GitHub CLI is signed in to, for machines without the Copilot app. */
export function readGhAccounts(deps: DiscoveryDeps = {}): DiscoveredAccount[] {
  const spawnSync = spawnOf(deps)
  const result = spawnSync("gh", ["auth", "status", "--json", "hosts"], { encoding: "utf8", timeout: 15000, env: cleanGhEnv() })
  try {
    const hosts = (JSON.parse(String(result.stdout)) as { hosts?: Record<string, Array<{ login?: string; state?: string }>> }).hosts ?? {}
    return Object.entries(hosts).flatMap(([host, users]) => users
      .filter((user) => user.state === "success" && typeof user.login === "string")
      .map((user) => ({ login: user.login as string, host, copilot: true })))
  } catch {
    return []
  }
}

export interface DiscoveredPoolAccount extends PoolAccount {
  reading: QuotaReading | null
}

/**
 * One account, on its own host: its token from `gh auth token --hostname <host> --user <login>`, then
 * `/copilot_internal/user` on that host for its Copilot API endpoint. A token for another login is refused.
 */
export async function discoverAccount(login: string, host: string, deps: DiscoveryDeps = {}): Promise<DiscoveredPoolAccount> {
  const spawnSync = spawnOf(deps)
  const doFetch = deps.fetch ?? fetch
  const key = accountKey({ login, host })
  const tokenResult = spawnSync("gh", ["auth", "token", "--hostname", host, "--user", login], { encoding: "utf8", timeout: 10000, env: cleanGhEnv() })
  const githubToken = tokenResult.status === 0 ? String(tokenResult.stdout ?? "").trim() : ""
  if (!githubToken) throw new Error(`${key}: the GitHub CLI has no token for this account (run \`gh auth login --hostname ${host}\`)`)
  const response = await doFetch(`${apiBaseForHost(host)}/copilot_internal/user`, {
    headers: { Authorization: `token ${githubToken}`, Accept: "application/json", "User-Agent": "ouro-account-pool" },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`${key}: Copilot discovery failed (HTTP ${response.status})`)
  const body = await response.json() as { login?: string; endpoints?: { api?: string } }
  if (typeof body.login === "string" && body.login.toLowerCase() !== login.toLowerCase()) {
    throw new Error(`${key}: the token belongs to ${body.login}, so it is refused`)
  }
  const baseUrl = body.endpoints?.api
  if (!baseUrl) throw new Error(`${key}: Copilot discovery returned no endpoints.api`)
  const at = (deps.now ?? (() => new Date()))().toISOString()
  return { login, host, baseUrl, githubToken, reading: directReading(key, body, at) }
}

export interface PoolDiscovery {
  accounts: PoolAccount[]
  readings: QuotaReading[]
  skipped: Array<{ key: string; reason: string }>
}

/** Discover every eligible account the Copilot app (or, without it, the GitHub CLI) is signed in to. */
export async function discoverAccountPool(settings: AccountPoolSettings, deps: DiscoveryDeps = {}): Promise<PoolDiscovery> {
  const signedIn = readAppAccounts(deps) ?? readGhAccounts(deps)
  const skipped: PoolDiscovery["skipped"] = []
  const candidates: DiscoveredAccount[] = []
  for (const account of signedIn) {
    const key = accountKey(account)
    if (!account.copilot) skipped.push({ key, reason: "Copilot is off for this account" })
    else if (!isEligible(key, settings.eligible)) skipped.push({ key, reason: "not eligible for this agent" })
    else if (!candidates.some((seen) => accountKey(seen) === key)) candidates.push(account)
  }
  const results = await Promise.all(candidates.map(async (account) => {
    try {
      return await discoverAccount(account.login, account.host, deps)
    } catch (error) {
      skipped.push({ key: accountKey(account), reason: error instanceof Error ? error.message : String(error) })
      return null
    }
  }))
  const found = results.filter((account): account is DiscoveredPoolAccount => account !== null)
  emitNervesEvent({
    component: "engine",
    event: "engine.account_pool_discovered",
    message: "discovered the provider account pool",
    meta: { accounts: found.map(accountKey), skipped: skipped.map((entry) => `${entry.key}: ${entry.reason}`) },
  })
  return {
    accounts: found.map(({ login, host, baseUrl, githubToken }) => ({ login, host, baseUrl, githubToken })),
    readings: found.flatMap((account) => (account.reading ? [account.reading] : [])),
    skipped,
  }
}

export function serializeAccountPool(accounts: readonly PoolAccount[]): string {
  return JSON.stringify(accounts.map(({ login, host, baseUrl, githubToken }) => ({ login, host, baseUrl, githubToken })))
}

export function parseAccountPool(raw: unknown): PoolAccount[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is PoolAccount => !!entry && typeof entry === "object"
      && typeof entry.login === "string" && typeof entry.host === "string"
      && typeof entry.baseUrl === "string" && typeof entry.githubToken === "string")
  } catch {
    return []
  }
}

export interface ChooseOptions {
  current?: string | null
  /** `login@host` → epoch ms until which the account refused requests (a 402 or 429). */
  refused?: Record<string, number>
  now?: number
  caps?: readonly number[]
}

/**
 * The account for the next turn among accounts not refused right now, in pool order: by tranche; when every
 * account with a reading is spent, enterprise overage (the current account first); then an account with no
 * reading yet. Null when none can serve.
 */
export function chooseAccount(pool: readonly PoolAccount[], readings: readonly QuotaReading[], options: ChooseOptions = {}): PoolAccount | null {
  const now = options.now ?? Date.now()
  const refused = options.refused ?? {}
  const current = options.current ?? null
  const order = pool.map(accountKey)
  const eligible = order.filter((key) => !(refused[key] > now))
  const cap = trancheCap(readings, eligible, options.caps ?? DEFAULT_TRANCHE_CAPS)
  const map = new Map(readings.map((reading) => [reading.key, reading]))
  const overage = (key: string | null): key is string => key !== null && eligible.includes(key) && map.get(key)?.overageOk === true
  const key = pickByTranche(current, readings, eligible, order, cap)
    ?? (overage(current) ? current : eligible.find(overage))
    ?? eligible.find((candidate) => usedPct(map.get(candidate)) === null)
  return pool.find((account) => accountKey(account) === key) ?? null
}

/** Until when an account refuses requests: Retry-After when given, the quota reset for a spent quota, else 5 minutes. */
export function refusalUntil(status: number, error: unknown, reset: string | null | undefined, now: number): number {
  const headers = (error as { headers?: unknown } | null)?.headers
  const retryAfter = headers && typeof (headers as Headers).get === "function"
    ? (headers as Headers).get("retry-after")
    : (headers as Record<string, string> | undefined)?.["retry-after"]
  const seconds = Number(retryAfter)
  if (retryAfter && Number.isFinite(seconds) && seconds > 0) return now + seconds * 1000
  const message = error instanceof Error ? error.message : String(error)
  // Only a spent quota waits for the reset; a plain "rate limit exceeded" is a short throttle.
  if (status === 402 || /quota|billing/i.test(message)) {
    const resetAt = Date.parse(reset ?? "")
    if (Number.isFinite(resetAt) && resetAt > now) return resetAt
    const date = new Date(now)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  }
  return now + 5 * 60 * 1000
}

export type SwitchReason = "start" | "tranche" | "402" | "429"

export interface AccountSwitch {
  at: string
  agent: string
  from: string | null
  to: string
  reason: SwitchReason
  cap?: number
  fromLeftPct?: number | null
  toLeftPct?: number | null
  refusedUntil?: string
}

export interface AccountPoolOptions {
  agent: string
  machine?: string
  /** `<agent root>/state/account-switches.jsonl`. */
  switchLog: string
  /**
   * `<agent root>/state/account-burn/`: each of the agent's processes writes its own last-hour request counts
   * here, so the published burn is the agent's total, not one process's.
   */
  burnDir?: string
  /**
   * `<agent root>/state/account-refusals.json`: `login@host` → epoch ms until which the account refuses requests.
   * Shared by the agent's processes, so one 402 or 429 benches an account for all of them, not once per process.
   */
  refusalsFile?: string
  /** This Mac's fleet name when `machine` isn't given; defaults to `defaultMachineName`. */
  machineName?: () => string
  now?: () => number
  appendLine?: (file: string, line: string) => void
  /** Fresh readings (local balancer state, fleet gist, and each account's own answer). */
  loadReadings?: () => Promise<QuotaReading[]>
  publishBurn?: (burn: AgentBurn) => Promise<boolean>
  refreshMs?: number
  /** Least time between gist writes; default 30 minutes. */
  publishMs?: number
  /** Rewrite an unchanged file after this long, so it never goes stale; default 5 hours. */
  republishMs?: number
  caps?: readonly number[]
}

function defaultAppendLine(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, line, "utf8")
}

const HOUR_MS = 60 * 60 * 1000

export class AccountPool {
  readonly accounts: readonly PoolAccount[]
  readings: QuotaReading[] = []
  readonly refused: Record<string, number> = {}
  private currentKey: string | null = null
  private requests: Array<{ key: string; at: number }> = []
  private lastRefresh = -Infinity
  private lastPublish = -Infinity
  private lastPublished = ""
  private loadedReadings = false
  private machineName: string | null = null
  private refreshing: Promise<void> | null = null
  private readonly options: AccountPoolOptions

  constructor(accounts: readonly PoolAccount[], options: AccountPoolOptions) {
    if (accounts.length === 0) throw new Error("an account pool needs at least one account")
    this.accounts = accounts
    this.options = options
    this.loadSharedRefusals()
  }

  /** Take in refusals another of the agent's processes recorded; the later end wins. */
  private loadSharedRefusals(): void {
    const file = this.options.refusalsFile
    if (!file) return
    try {
      const shared = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      for (const [key, until] of Object.entries(shared)) {
        if (typeof until === "number" && until > this.now() && !(this.refused[key] >= until)) this.refused[key] = until
      }
    } catch {
      // No file yet, or another process is mid-write: nothing to take in.
    }
  }

  private saveSharedRefusals(): void {
    const file = this.options.refusalsFile
    if (!file) return
    this.loadSharedRefusals()
    const live = Object.fromEntries(Object.entries(this.refused).filter(([, until]) => until > this.now()))
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(live))
      fs.renameSync(temp, file)
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "engine",
        event: "engine.account_refusals_save_failed",
        message: "could not share account refusals with the agent's other processes",
        // fs only throws Errors.
        meta: { agent: this.options.agent, error: (error as Error).message },
      })
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private find(key: string | null): PoolAccount | undefined {
    return this.accounts.find((account) => accountKey(account) === key)
  }

  private leftPct(key: string | null): number | null {
    return this.readings.find((reading) => reading.key === key)?.leftPct ?? null
  }

  currentKeyOrNull(): string | null {
    return this.currentKey
  }

  current(): PoolAccount {
    return this.find(this.currentKey) ?? this.accounts[0]
  }

  setReadings(readings: readonly QuotaReading[]): void {
    this.readings = mergeReadings(this.readings, [...readings])
  }

  /** Refresh readings in the background when they are stale; never blocks a turn. */
  refreshIfStale(): Promise<void> {
    const load = this.options.loadReadings
    if (!load || this.refreshing || this.now() - this.lastRefresh < (this.options.refreshMs ?? 5 * 60 * 1000)) {
      return this.refreshing ?? Promise.resolve()
    }
    this.lastRefresh = this.now()
    this.refreshing = load()
      .then((readings) => {
        this.setReadings(readings)
        this.loadedReadings = true
        this.publishIfDue()
      })
      .catch((error: unknown) => {
        emitNervesEvent({
          level: "warn",
          component: "engine",
          event: "engine.account_pool_refresh_failed",
          message: "could not refresh account pool readings",
          meta: { agent: this.options.agent, error: error instanceof Error ? error.message : String(error) },
        })
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  /** Called between turns: stay on the current account until it reaches the tranche cap. */
  beforeTurn(): PoolAccount {
    void this.refreshIfStale()
    this.loadSharedRefusals()
    const previous = this.currentKey
    const caps = this.options.caps ?? DEFAULT_TRANCHE_CAPS
    const next = chooseAccount(this.accounts, this.readings, { current: previous, refused: this.refused, now: this.now(), caps })
      ?? this.current()
    const nextKey = accountKey(next)
    if (nextKey !== previous) {
      const eligible = this.accounts.map(accountKey).filter((key) => !(this.refused[key] > this.now()))
      this.currentKey = nextKey
      this.logSwitch({ from: previous, to: nextKey, reason: previous === null ? "start" : "tranche", cap: trancheCap(this.readings, eligible, caps) })
    }
    return next
  }

  /**
   * The account `key` refused a request with a 402 or 429: mark it refused until it can serve again and
   * move to the next account. Returns the account to retry on, or null when no other account can serve.
   */
  onRefusal(key: string, status: 402 | 429, error: unknown): PoolAccount | null {
    const reset = this.readings.find((reading) => reading.key === key)?.reset
    const until = refusalUntil(status, error, reset, this.now())
    this.refused[key] = until
    this.saveSharedRefusals()
    const next = chooseAccount(this.accounts, this.readings, { current: null, refused: this.refused, now: this.now(), caps: this.options.caps })
    if (!next || accountKey(next) === key) {
      emitNervesEvent({
        level: "warn",
        component: "engine",
        event: "engine.account_pool_exhausted",
        message: "no other account in the pool can take this turn",
        meta: { agent: this.options.agent, refused: key, status },
      })
      return null
    }
    const nextKey = accountKey(next)
    this.currentKey = nextKey
    this.logSwitch({ from: key, to: nextKey, reason: String(status) as SwitchReason, refusedUntil: new Date(until).toISOString() })
    return next
  }

  /** Count one model request against `key`, and publish this agent's burn when it is due. */
  recordRequest(key: string): void {
    const now = this.now()
    this.requests = [...this.requests.filter((entry) => now - entry.at < HOUR_MS), { key, at: now }]
    this.shareRequests()
    this.publishIfDue()
  }

  /**
   * Rewrite this agent's file in the fleet gist when it has changed, at most every 30 minutes (GitHub allows
   * 100 gist writes an hour per user, shared by the whole fleet), and at least every 5 hours so the balancer,
   * which trusts a reading for 6 hours, keeps it. Never before readings have loaded, so a process that just
   * started never blanks the agent's published readings. Switching accounts never waits on this.
   */
  publishIfDue(): void {
    const now = this.now()
    const publish = this.options.publishBurn
    const loaded = this.loadedReadings || !this.options.loadReadings
    if (!publish || !loaded || now - this.lastPublish < (this.options.publishMs ?? 30 * 60 * 1000)) return
    const content = {
      current: this.currentKey,
      requestsPerH: this.agentBurnPerH(now),
      readings: this.accounts.map(accountKey).flatMap((key) => {
        const found = this.readings.find((reading) => reading.key === key)
        return found ? [found] : []
      }),
    }
    const signature = JSON.stringify(content)
    const stale = now - this.lastPublish >= (this.options.republishMs ?? 5 * 60 * 60 * 1000)
    if (signature === this.lastPublished && !stale) return
    this.lastPublish = now
    this.lastPublished = signature
    void publish({
      agent: this.options.agent,
      machine: this.options.machine ?? (this.machineName ??= (this.options.machineName ?? defaultMachineName)()),
      at: new Date(now).toISOString(),
      ...content,
    })
  }

  /** Share this process's last-hour request times with the agent's other processes. */
  private shareRequests(): void {
    const dir = this.options.burnDir
    if (!dir) return
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ requests: this.requests }))
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "engine",
        event: "engine.account_burn_share_failed",
        message: "could not share this process's burn with the agent's other processes",
        // fs only throws Errors.
        meta: { agent: this.options.agent, error: (error as Error).message },
      })
    }
  }

  /** Requests in the hour before `now` across all of this agent's processes, counted from each one's request times. */
  agentBurnPerH(now: number): Record<string, number> {
    const total: Record<string, number> = {}
    const count = (requests: ReadonlyArray<{ key?: unknown; at?: unknown }>) => {
      for (const entry of requests) {
        if (typeof entry.key !== "string" || typeof entry.at !== "number" || now - entry.at >= HOUR_MS || entry.at > now) continue
        total[entry.key] = (total[entry.key] ?? 0) + 1
      }
    }
    count(this.requests)
    const dir = this.options.burnDir
    let names: string[] = []
    try {
      names = dir ? fs.readdirSync(dir) : []
    } catch {
      names = []
    }
    for (const name of names) {
      if (name === `${process.pid}.json` || !name.endsWith(".json")) continue
      try {
        const other = JSON.parse(fs.readFileSync(path.join(dir as string, name), "utf8")) as { requests?: unknown }
        if (Array.isArray(other.requests)) count(other.requests as Array<{ key?: unknown; at?: unknown }>)
      } catch {
        // Another process is mid-write; its counts join the next publish.
      }
    }
    return total
  }

  burnPerH(): Record<string, number> {
    const now = this.now()
    const out: Record<string, number> = {}
    for (const entry of this.requests) if (now - entry.at < HOUR_MS) out[entry.key] = (out[entry.key] ?? 0) + 1
    return out
  }

  private logSwitch(change: Omit<AccountSwitch, "at" | "agent" | "fromLeftPct" | "toLeftPct">): void {
    const record: AccountSwitch = {
      at: new Date(this.now()).toISOString(),
      agent: this.options.agent,
      ...change,
      fromLeftPct: this.leftPct(change.from),
      toLeftPct: this.leftPct(change.to),
    }
    try {
      (this.options.appendLine ?? defaultAppendLine)(this.options.switchLog, `${JSON.stringify(record)}\n`)
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "engine",
        event: "engine.account_switch_log_failed",
        message: "could not write the account switch log",
        meta: { agent: this.options.agent, error: error instanceof Error ? error.message : String(error) },
      })
    }
    emitNervesEvent({
      component: "engine",
      event: "engine.account_switched",
      message: `switched account ${record.from ?? "(none)"} -> ${record.to} (${record.reason})`,
      meta: { ...record },
    })
  }
}

/** Each pool account's own reading, from its host's `/copilot_internal/user`. */
export async function fetchDirectReadings(accounts: readonly PoolAccount[], deps: DiscoveryDeps = {}): Promise<QuotaReading[]> {
  const doFetch = deps.fetch ?? fetch
  const at = (deps.now ?? (() => new Date()))().toISOString()
  const readings = await Promise.all(accounts.map(async (account) => {
    try {
      const response = await doFetch(`${apiBaseForHost(account.host)}/copilot_internal/user`, {
        headers: { Authorization: `token ${account.githubToken}`, Accept: "application/json", "User-Agent": "ouro-account-pool" },
        signal: AbortSignal.timeout(15000),
      })
      return response.ok ? directReading(accountKey(account), await response.json(), at) : null
    } catch {
      return null
    }
  }))
  return readings.filter((reading): reading is QuotaReading => reading !== null)
}

export interface PooledCaller<C> {
  account(): PoolAccount
  client(): C
  /** Run one model request. On a 402 or 429 it moves to the next account and retries once. */
  call<T>(request: (client: C, account: PoolAccount) => Promise<T>): Promise<T>
}

/** One turn's view of the pool: the account is chosen once, between turns, and changes only on a refusal. */
export function createPooledCaller<C>(pool: AccountPool, makeClient: (account: PoolAccount) => C): PooledCaller<C> {
  let account = pool.beforeTurn()
  const clients = new Map<string, C>()
  const clientFor = (target: PoolAccount): C => {
    const key = accountKey(target)
    if (!clients.has(key)) clients.set(key, makeClient(target))
    return clients.get(key) as C
  }
  return {
    account: () => account,
    client: () => clientFor(account),
    async call<T>(request: (client: C, account: PoolAccount) => Promise<T>): Promise<T> {
      pool.recordRequest(accountKey(account))
      try {
        return await request(clientFor(account), account)
      } catch (error) {
        const status = (error as { status?: unknown } | null)?.status
        if (status !== 402 && status !== 429) throw error
        const next = pool.onRefusal(accountKey(account), status, error)
        if (!next) throw error
        account = next
        pool.recordRequest(accountKey(account))
        return await request(clientFor(account), account)
      }
    },
  }
}

const pools = new Map<string, { fingerprint: string; pool: AccountPool }>()

/** One pool per agent per process, kept across turns so the current account and refusals persist. */
export function getAccountPool(accounts: readonly PoolAccount[], options: AccountPoolOptions): AccountPool {
  const fingerprint = serializeAccountPool(accounts)
  const cached = pools.get(options.agent)
  if (cached && cached.fingerprint === fingerprint) return cached.pool
  const pool = new AccountPool(accounts, options)
  pools.set(options.agent, { fingerprint, pool })
  return pool
}

export function resetAccountPools(): void {
  pools.clear()
}
