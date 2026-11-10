import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AccountPool,
  accountKey,
  apiBaseForHost,
  chooseAccount,
  createPooledCaller,
  defaultMachineName,
  discoverAccount,
  discoverAccountPool,
  fetchDirectReadings,
  getAccountPool,
  globMatch,
  isEligible,
  isWorkAccount,
  parseAccountPool,
  readAppAccounts,
  readGhAccounts,
  refusalUntil,
  resetAccountPools,
  serializeAccountPool,
  type PoolAccount,
} from "../../../heart/providers/account-pool"
import type { QuotaReading } from "../../../heart/quota/tranche"

const MSFT: PoolAccount = { login: "ari", host: "msft.ghe.com", baseUrl: "https://copilot-api.msft.ghe.com", githubToken: "t-msft" }
const MSCOM: PoolAccount = { login: "ari", host: "microsoft.ghe.com", baseUrl: "https://copilot-api.microsoft.ghe.com", githubToken: "t-mscom" }
const EMU: PoolAccount = { login: "ari_microsoft", host: "github.com", baseUrl: "https://api.enterprise.githubcopilot.com", githubToken: "t-emu" }

const NOW = Date.parse("2026-11-10T03:00:00.000Z")

const reading = (key: string, usedPct: number, extra: Partial<QuotaReading> = {}): QuotaReading => ({
  key,
  leftPct: 100 - usedPct,
  burnPerH: null,
  dryAt: null,
  overageOk: true,
  at: new Date(NOW).toISOString(),
  reset: "2026-12-01T00:00:00.000Z",
  ...extra,
})

type SpawnResult = { status: number; stdout: string }
function spawnMock(handler: (cmd: string, args: string[]) => SpawnResult) {
  return vi.fn((cmd: string, args: string[]) => handler(cmd, args)) as unknown as typeof import("child_process").spawnSync
}

function copilotUser(login: string, api: string, pct = 50) {
  return { login, endpoints: { api }, quota_reset_date_utc: "2026-12-01T00:00:00.000Z", quota_snapshots: { premium_interactions: { percent_remaining: pct, overage_permitted: true } } }
}

function pool(accounts: PoolAccount[] = [MSFT, MSCOM, EMU], extra: Partial<ConstructorParameters<typeof AccountPool>[1]> = {}) {
  const lines: string[] = []
  let now = NOW
  const instance = new AccountPool(accounts, {
    agent: "ouroboros",
    machine: "laptop",
    switchLog: "/bundle/state/account-switches.jsonl",
    now: () => now,
    appendLine: (_file, line) => { lines.push(line) },
    ...extra,
  })
  return { pool: instance, lines, records: () => lines.map((line) => JSON.parse(line)), advance: (ms: number) => { now += ms } }
}

afterEach(() => {
  resetAccountPools()
  vi.unstubAllGlobals()
})

describe("account keys, hosts and eligibility", () => {
  it("keys accounts as login@host", () => {
    expect(accountKey(MSFT)).toBe("ari@msft.ghe.com")
  })

  it("discovers each account on its own host's API", () => {
    expect(apiBaseForHost("github.com")).toBe("https://api.github.com")
    expect(apiBaseForHost("msft.ghe.com")).toBe("https://api.msft.ghe.com")
    expect(apiBaseForHost("microsoft.ghe.com")).toBe("https://api.microsoft.ghe.com")
  })

  it("treats GHE hosts and the EMU login as work accounts", () => {
    expect(isWorkAccount("ari@msft.ghe.com")).toBe(true)
    expect(isWorkAccount("ari@microsoft.ghe.com")).toBe(true)
    expect(isWorkAccount("ari_microsoft@github.com")).toBe(true)
    expect(isWorkAccount("ari@github.com")).toBe(false)
  })

  it("lets work agents bill only work accounts and personal agents only personal ones", () => {
    expect(isEligible("ari@msft.ghe.com")).toBe(true)
    expect(isEligible("ari@github.com", "work")).toBe(false)
    expect(isEligible("ari@github.com", "personal")).toBe(true)
    expect(isEligible("ari@msft.ghe.com", "personal")).toBe(false)
    expect(isEligible("ari@msft.ghe.com", ["*@msft.ghe.com"])).toBe(true)
    expect(isEligible("ari@github.com", ["*@msft.ghe.com"])).toBe(false)
  })

  it("matches globs literally apart from *", () => {
    expect(globMatch("*@msft.ghe.com", "ARI@msft.ghe.com")).toBe(true)
    expect(globMatch("*@msft.ghe.com", "ari@msftXghe.com")).toBe(false)
  })
})

describe("readAppAccounts", () => {
  it("reads the GitHub accounts signed in to the Copilot app", () => {
    const rows = [
      { login: "ari", host: "msft.ghe.com", settings_json: "{}" },
      { login: "ari", host: "old.ghe.com", settings_json: JSON.stringify({ copilotAccess: false }) },
      { login: "ari", host: "off.ghe.com", settings_json: JSON.stringify({ copilotAppEnabled: false }) },
      { login: "ari", host: "bad.ghe.com", settings_json: "{nope" },
      { login: "ari", host: "none.ghe.com", settings_json: null },
    ]
    const spawnSync = spawnMock(() => ({ status: 0, stdout: JSON.stringify(rows) }))
    expect(readAppAccounts({ spawnSync, homeDir: "/Users/x" })).toEqual([
      { login: "ari", host: "msft.ghe.com", copilot: true },
      { login: "ari", host: "old.ghe.com", copilot: false },
      { login: "ari", host: "off.ghe.com", copilot: false },
      { login: "ari", host: "bad.ghe.com", copilot: true },
      { login: "ari", host: "none.ghe.com", copilot: true },
    ])
    const args = vi.mocked(spawnSync).mock.calls[0][1] as string[]
    expect(args).toContain("/Users/x/.copilot/data.db")
    expect(args.at(-1)).toContain("ORDER BY is_default DESC, created_at, rowid")
  })

  it("returns an empty list for an app with no accounts, and null when the app can't be read", () => {
    expect(readAppAccounts({ spawnSync: spawnMock(() => ({ status: 0, stdout: "" })) })).toEqual([])
    expect(readAppAccounts({ spawnSync: spawnMock(() => ({ status: 1, stdout: "" })) })).toBeNull()
    expect(readAppAccounts({ spawnSync: spawnMock(() => ({ status: 0, stdout: "{bad" })) })).toBeNull()
    expect(readAppAccounts({ spawnSync: spawnMock(() => ({ status: 0, stdout: undefined as unknown as string })) })).toBeNull()
  })
})

describe("readGhAccounts", () => {
  it("reads the GitHub CLI's signed-in accounts", () => {
    const hosts = { hosts: { "github.com": [{ login: "ari", state: "success" }, { login: "gone", state: "error" }], "msft.ghe.com": [{ state: "success" }] } }
    const spawnSync = spawnMock(() => ({ status: 0, stdout: JSON.stringify(hosts) }))
    expect(readGhAccounts({ spawnSync })).toEqual([{ login: "ari", host: "github.com", copilot: true }])
    const env = (vi.mocked(spawnSync).mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env
    expect(env.GH_TOKEN).toBeUndefined()
  })

  it("returns nothing when gh can't answer", () => {
    expect(readGhAccounts({ spawnSync: spawnMock(() => ({ status: 1, stdout: "" })) })).toEqual([])
    expect(readGhAccounts({ spawnSync: spawnMock(() => ({ status: 0, stdout: "{}" })) })).toEqual([])
  })
})

describe("discoverAccount", () => {
  const gh = spawnMock((_cmd, args) => ({ status: 0, stdout: `token-for-${args[3]}\n` }))

  it("uses the account's own host for the token and for discovery", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(copilotUser("ari", "https://copilot-api.msft.ghe.com", 95.4))))
    const found = await discoverAccount("ari", "msft.ghe.com", { spawnSync: gh, fetch: fetchMock as unknown as typeof fetch, now: () => new Date(NOW) })
    expect(vi.mocked(gh).mock.calls[0][1]).toEqual(["auth", "token", "--hostname", "msft.ghe.com", "--user", "ari"])
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://api.msft.ghe.com/copilot_internal/user")
    expect(found).toMatchObject({ login: "ari", host: "msft.ghe.com", baseUrl: "https://copilot-api.msft.ghe.com", githubToken: "token-for-msft.ghe.com" })
    expect(found.reading).toMatchObject({ key: "ari@msft.ghe.com", leftPct: 95.4, source: "direct" })
  })

  it("refuses a token that belongs to another login", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(copilotUser("someone-else", "https://x"))))
    await expect(discoverAccount("ari", "msft.ghe.com", { spawnSync: gh, fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(/belongs to someone-else, so it is refused/)
  })

  it("fails clearly without a gh token, on an HTTP error, or without endpoints.api", async () => {
    const noToken = spawnMock(() => ({ status: 1, stdout: "" }))
    await expect(discoverAccount("ari", "msft.ghe.com", { spawnSync: noToken })).rejects.toThrow(/gh auth login --hostname msft.ghe.com/)
    const emptyToken = spawnMock(() => ({ status: 0, stdout: undefined as unknown as string }))
    await expect(discoverAccount("ari", "msft.ghe.com", { spawnSync: emptyToken })).rejects.toThrow(/no token/)
    const unauthorized = vi.fn(async () => new Response("{}", { status: 401 }))
    await expect(discoverAccount("ari", "msft.ghe.com", { spawnSync: gh, fetch: unauthorized as unknown as typeof fetch })).rejects.toThrow(/HTTP 401/)
    const noEndpoint = vi.fn(async () => new Response(JSON.stringify({ login: "ari" })))
    await expect(discoverAccount("ari", "msft.ghe.com", { spawnSync: gh, fetch: noEndpoint as unknown as typeof fetch })).rejects.toThrow(/no endpoints.api/)
  })

  it("defaults to the global fetch and clock", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ endpoints: { api: "https://copilot-api.msft.ghe.com" } }))))
    await expect(discoverAccount("ari", "msft.ghe.com", { spawnSync: gh })).resolves.toMatchObject({ baseUrl: "https://copilot-api.msft.ghe.com", reading: null })
  })
})

describe("discoverAccountPool", () => {
  const appRows = [
    { login: "ari", host: "github.com", settings_json: "{}" },
    { login: "ari_microsoft", host: "github.com", settings_json: "{}" },
    { login: "ari", host: "microsoft.ghe.com", settings_json: "{}" },
    { login: "ari", host: "msft.ghe.com", settings_json: "{}" },
    { login: "ari", host: "msft.ghe.com", settings_json: "{}" },
    { login: "ari", host: "off.ghe.com", settings_json: JSON.stringify({ copilotAccess: false }) },
  ]
  const spawnSync = spawnMock((cmd, args) => {
    if (cmd === "/usr/bin/sqlite3") return { status: 0, stdout: JSON.stringify(appRows) }
    return { status: 0, stdout: `${args[5]}@${args[3]}` }
  })
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("https://api.github.com")) return new Response("{}", { status: 401 })
    const host = new URL(url).hostname.replace(/^api\./, "")
    return new Response(JSON.stringify(copilotUser("ari", `https://copilot-api.${host}`, host === "msft.ghe.com" ? 95 : 28)))
  })

  it("discovers every eligible account signed in to the app, in the app's order", async () => {
    const found = await discoverAccountPool({ eligible: "work" }, { spawnSync, fetch: fetchMock as unknown as typeof fetch })
    expect(found.accounts.map(accountKey)).toEqual(["ari@microsoft.ghe.com", "ari@msft.ghe.com"])
    expect(found.accounts[1]).toEqual({ login: "ari", host: "msft.ghe.com", baseUrl: "https://copilot-api.msft.ghe.com", githubToken: "ari@msft.ghe.com" })
    expect(found.readings.map((r) => [r.key, r.leftPct])).toEqual([["ari@microsoft.ghe.com", 28], ["ari@msft.ghe.com", 95]])
    expect(found.skipped).toEqual(expect.arrayContaining([
      { key: "ari@github.com", reason: "not eligible for this agent" },
      { key: "ari@off.ghe.com", reason: "Copilot is off for this account" },
      { key: "ari_microsoft@github.com", reason: "ari_microsoft@github.com: Copilot discovery failed (HTTP 401)" },
    ]))
  })

  it("falls back to the GitHub CLI's accounts without the app", async () => {
    const ghOnly = spawnMock((cmd, args) => {
      if (cmd === "/usr/bin/sqlite3") return { status: 1, stdout: "" }
      if (args[1] === "status") return { status: 0, stdout: JSON.stringify({ hosts: { "msft.ghe.com": [{ login: "ari", state: "success" }], "microsoft.ghe.com": [{ login: "ari", state: "success" }] } }) }
      return { status: 0, stdout: "tok" }
    })
    const noQuota = vi.fn(async (url: string) => new Response(JSON.stringify({ login: "ari", endpoints: { api: url.replace("/copilot_internal/user", "") } })))
    const found = await discoverAccountPool({}, { spawnSync: ghOnly, fetch: noQuota as unknown as typeof fetch })
    expect(found.accounts.map(accountKey)).toEqual(["ari@msft.ghe.com", "ari@microsoft.ghe.com"])
    expect(found.readings).toEqual([])
  })

  it("records a non-Error discovery failure", async () => {
    const throwing = vi.fn(async () => { throw "boom" })
    const found = await discoverAccountPool({ eligible: ["ari@msft.ghe.com"] }, { spawnSync, fetch: throwing as unknown as typeof fetch })
    expect(found.accounts).toEqual([])
    expect(found.skipped).toContainEqual({ key: "ari@msft.ghe.com", reason: "boom" })
  })
})

describe("serializeAccountPool and parseAccountPool", () => {
  it("round-trips only the account fields", () => {
    const raw = serializeAccountPool([{ ...MSFT, extra: 1 } as PoolAccount])
    expect(parseAccountPool(raw)).toEqual([MSFT])
  })

  it("ignores anything that isn't a pool", () => {
    expect(parseAccountPool(undefined)).toEqual([])
    expect(parseAccountPool("  ")).toEqual([])
    expect(parseAccountPool("{bad")).toEqual([])
    expect(parseAccountPool("{}")).toEqual([])
    expect(parseAccountPool(JSON.stringify([null, { login: "x" }, MSCOM]))).toEqual([MSCOM])
  })
})

describe("chooseAccount", () => {
  const readings = [reading("ari@msft.ghe.com", 5), reading("ari@microsoft.ghe.com", 71), reading("ari_microsoft@github.com", 100, { overageOk: false })]

  it("fills accounts by tranche in pool order", () => {
    expect(chooseAccount([MSFT, MSCOM, EMU], readings, { now: NOW })).toBe(MSFT)
    expect(chooseAccount([MSCOM, MSFT, EMU], readings, { now: NOW })).toBe(MSFT)
  })

  it("stays on the current account below the cap", () => {
    expect(chooseAccount([MSFT, MSCOM], [reading("ari@msft.ghe.com", 5), reading("ari@microsoft.ghe.com", 10)], { current: "ari@microsoft.ghe.com" })).toBe(MSCOM)
  })

  it("skips refused accounts until their refusal ends, and spent accounts without overage", () => {
    expect(chooseAccount([MSFT, MSCOM, EMU], readings, { now: NOW, refused: { "ari@msft.ghe.com": NOW + 1000 } })).toBe(MSCOM)
    expect(chooseAccount([MSFT, MSCOM, EMU], readings, { now: NOW, refused: { "ari@msft.ghe.com": NOW - 1 } })).toBe(MSFT)
    expect(chooseAccount([EMU], readings, { now: NOW })).toBeNull()
  })

  it("uses enterprise overage once every account is spent, the current account first", () => {
    const spent = [reading("ari@msft.ghe.com", 100), reading("ari@microsoft.ghe.com", 100), reading("ari_microsoft@github.com", 100, { overageOk: false })]
    expect(chooseAccount([EMU, MSFT, MSCOM], spent, { current: "ari@microsoft.ghe.com" })).toBe(MSCOM)
    expect(chooseAccount([EMU, MSFT, MSCOM], spent, { current: "ari_microsoft@github.com" })).toBe(MSFT)
  })

  it("tries an account with no reading before giving up", () => {
    expect(chooseAccount([EMU, MSFT], [reading("ari_microsoft@github.com", 100, { overageOk: false })], {})).toBe(MSFT)
    expect(chooseAccount([MSFT, MSCOM], [], {})).toBe(MSFT)
  })
})

describe("refusalUntil", () => {
  it("honors Retry-After, as Headers or as a plain object", () => {
    expect(refusalUntil(429, { headers: new Headers({ "retry-after": "30" }) }, null, NOW)).toBe(NOW + 30_000)
    expect(refusalUntil(429, { headers: { "retry-after": "2" } }, null, NOW)).toBe(NOW + 2000)
  })

  it("refuses a spent quota until its reset, or the first of next month", () => {
    expect(refusalUntil(402, new Error("payment required"), "2026-12-01T00:00:00.000Z", NOW)).toBe(Date.parse("2026-12-01T00:00:00.000Z"))
    expect(refusalUntil(429, new Error("429 quota exceeded"), null, NOW)).toBe(Date.parse("2026-12-01T00:00:00.000Z"))
    expect(refusalUntil(429, "billing limit reached", "2026-01-01T00:00:00.000Z", NOW)).toBe(Date.parse("2026-12-01T00:00:00.000Z"))
  })

  it("refuses a plain rate limit for five minutes", () => {
    expect(refusalUntil(429, new Error("too many requests"), null, NOW)).toBe(NOW + 5 * 60_000)
    expect(refusalUntil(429, new Error("429 Rate limit exceeded"), "2026-12-01T00:00:00.000Z", NOW)).toBe(NOW + 5 * 60_000)
    expect(refusalUntil(429, null, null, NOW)).toBe(NOW + 5 * 60_000)
    expect(refusalUntil(429, { headers: { "retry-after": "soon" } }, null, NOW)).toBe(NOW + 5 * 60_000)
    // A rejected credential waits an hour, so a revoked token costs one request an hour, not one a turn.
    expect(refusalUntil(401, new Error("401 Bad credentials"), "2026-12-01T00:00:00.000Z", NOW)).toBe(NOW + 60 * 60_000)
  })
})

describe("AccountPool", () => {
  it("needs at least one account", () => {
    expect(() => new AccountPool([], { agent: "a", switchLog: "/x" })).toThrow(/at least one account/)
  })

  it("starts on the first account by tranche and logs the start", () => {
    const { pool: p, records } = pool()
    p.setReadings([reading("ari@msft.ghe.com", 5), reading("ari@microsoft.ghe.com", 71)])
    expect(p.currentKeyOrNull()).toBeNull()
    expect(accountKey(p.current())).toBe("ari@msft.ghe.com")
    expect(p.beforeTurn()).toBe(MSFT)
    expect(records()).toEqual([{ at: "2026-11-10T03:00:00.000Z", agent: "ouroboros", from: null, to: "ari@msft.ghe.com", reason: "start", cap: 30, fromLeftPct: null, toLeftPct: 95 }])
  })

  it("switches between turns only when the account reaches the tranche cap", () => {
    const { pool: p, records } = pool([MSFT, MSCOM])
    p.setReadings([reading("ari@msft.ghe.com", 20), reading("ari@microsoft.ghe.com", 10)])
    p.beforeTurn()
    p.beforeTurn()
    expect(records()).toHaveLength(1)
    p.setReadings([reading("ari@msft.ghe.com", 30, { at: "2026-11-10T04:00:00.000Z" })])
    expect(p.beforeTurn()).toBe(MSCOM)
    expect(records()[1]).toMatchObject({ from: "ari@msft.ghe.com", to: "ari@microsoft.ghe.com", reason: "tranche", cap: 30, fromLeftPct: 70, toLeftPct: 90 })
  })

  it("stays put when every account is refused", () => {
    const { pool: p } = pool([MSFT])
    p.refused["ari@msft.ghe.com"] = NOW + 1000
    expect(p.beforeTurn()).toBe(MSFT)
  })

  it("on a 429 marks the account refused until its reset, switches, and logs it", () => {
    const { pool: p, records } = pool([MSFT, MSCOM])
    p.setReadings([reading("ari@msft.ghe.com", 5), reading("ari@microsoft.ghe.com", 71)])
    p.beforeTurn()
    expect(p.onRefusal("ari@msft.ghe.com", 429, new Error("429 quota exceeded"))).toBe(MSCOM)
    expect(p.refused["ari@msft.ghe.com"]).toBe(Date.parse("2026-12-01T00:00:00.000Z"))
    expect(records()[1]).toMatchObject({ from: "ari@msft.ghe.com", to: "ari@microsoft.ghe.com", reason: "429", refusedUntil: "2026-12-01T00:00:00.000Z" })
    expect(p.beforeTurn()).toBe(MSCOM)
  })

  it("returns null when no other account can take the turn", () => {
    const { pool: p, records } = pool([MSFT])
    p.beforeTurn()
    expect(p.onRefusal("ari@msft.ghe.com", 402, new Error("payment required"))).toBeNull()
    expect(records()).toHaveLength(1)
    const two = pool([MSFT, EMU])
    two.pool.setReadings([reading("ari_microsoft@github.com", 100, { overageOk: false })])
    expect(two.pool.onRefusal("ari@msft.ghe.com", 429, new Error("rate"))).toBeNull()
  })

  it("counts requests per account over the last hour and publishes burn when due", async () => {
    const publishBurn = vi.fn(async () => true)
    const { pool: p, advance } = pool([MSFT, MSCOM], { publishBurn, publishMs: 1000 })
    p.beforeTurn()
    p.recordRequest("ari@msft.ghe.com")
    p.recordRequest("ari@msft.ghe.com")
    expect(publishBurn).toHaveBeenCalledTimes(1)
    expect(publishBurn).toHaveBeenCalledWith({ agent: "ouroboros", machine: "laptop", at: "2026-11-10T03:00:00.000Z", current: "ari@msft.ghe.com", requestsPerH: { "ari@msft.ghe.com": 1 }, readings: [] })
    advance(2000)
    p.recordRequest("ari@microsoft.ghe.com")
    expect(publishBurn).toHaveBeenCalledTimes(2)
    expect(p.burnPerH()).toEqual({ "ari@msft.ghe.com": 2, "ari@microsoft.ghe.com": 1 })
    advance(60 * 60 * 1000 - 1000)
    expect(p.burnPerH()).toEqual({ "ari@microsoft.ghe.com": 1 })
  })

  it("writes the gist at most every 30 minutes, only when the content changed, and at least every 5 hours", () => {
    const publishBurn = vi.fn(async () => true)
    const { pool: p, advance } = pool([MSFT], { publishBurn })
    p.beforeTurn()
    p.recordRequest("ari@msft.ghe.com")
    expect(publishBurn).toHaveBeenCalledTimes(1)
    advance(29 * 60 * 1000)
    p.recordRequest("ari@msft.ghe.com")
    expect(publishBurn).toHaveBeenCalledTimes(1)
    advance(60 * 1000)
    p.recordRequest("ari@msft.ghe.com")
    expect(publishBurn).toHaveBeenCalledTimes(2)
    expect(publishBurn.mock.calls[1][0]).toMatchObject({ requestsPerH: { "ari@msft.ghe.com": 3 } })
    // Nothing changes after the requests age out: one write with the empty burn, then quiet until five hours pass.
    advance(2 * 60 * 60 * 1000)
    p.publishIfDue()
    expect(publishBurn).toHaveBeenCalledTimes(3)
    advance(60 * 60 * 1000)
    p.publishIfDue()
    expect(publishBurn).toHaveBeenCalledTimes(3)
    advance(4 * 60 * 60 * 1000)
    p.publishIfDue()
    expect(publishBurn).toHaveBeenCalledTimes(4)
  })

  it("holds the 30-minute floor across the agent's processes, through a shared publish record", () => {
    const publishedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-account-published-")), "state", "account-burn-published.json")
    const publishBurn = vi.fn(async () => true)
    const first = pool([MSFT], { publishBurn, publishedFile })
    first.pool.beforeTurn()
    first.pool.recordRequest("ari@msft.ghe.com")
    expect(publishBurn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(publishedFile, "utf8"))).toMatchObject({ at: NOW })
    // Another process (a sense, or the worker after a restart) starts 10 minutes later: it holds off.
    const second = pool([MSFT], { publishBurn, publishedFile })
    second.advance(10 * 60 * 1000)
    second.pool.beforeTurn()
    second.pool.recordRequest("ari@msft.ghe.com")
    expect(publishBurn).toHaveBeenCalledTimes(1)
    // Past the floor, the content changed, so it writes, and the first process then holds off in turn.
    second.advance(25 * 60 * 1000)
    second.pool.recordRequest("ari@msft.ghe.com")
    expect(publishBurn).toHaveBeenCalledTimes(2)
    first.advance(36 * 60 * 1000)
    first.pool.publishIfDue()
    expect(publishBurn).toHaveBeenCalledTimes(2)
    // A record without a signature still holds the floor.
    const third = pool([MSFT], { publishBurn, publishedFile })
    fs.writeFileSync(publishedFile, JSON.stringify({ at: NOW, signature: 7 }))
    third.pool.publishIfDue()
    expect(publishBurn).toHaveBeenCalledTimes(2)
    // A half-written record is ignored.
    fs.writeFileSync(publishedFile, "{half")
    const fourth = pool([MSFT], { publishBurn, publishedFile })
    fourth.pool.publishIfDue()
    expect(publishBurn).toHaveBeenCalledTimes(3)
  })

  it("still publishes when the publish record can't be shared", () => {
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-account-published-")), "file")
    fs.writeFileSync(blocker, "x")
    const publishBurn = vi.fn(async () => true)
    const { pool: p } = pool([MSFT], { publishBurn, publishedFile: path.join(blocker, "account-burn-published.json") })
    p.publishIfDue()
    expect(publishBurn).toHaveBeenCalledTimes(1)
  })

  it("doesn't publish until readings have loaded, so a new process never blanks the agent's readings", async () => {
    const publishBurn = vi.fn(async () => true)
    let release: (readings: QuotaReading[]) => void = () => {}
    const loadReadings = vi.fn(() => new Promise<QuotaReading[]>((resolve) => { release = resolve }))
    const { pool: p } = pool([MSFT], { publishBurn, loadReadings })
    p.beforeTurn()
    p.recordRequest("ari@msft.ghe.com")
    expect(publishBurn).not.toHaveBeenCalled()
    release([reading("ari@msft.ghe.com", 10)])
    await p.refreshIfStale()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(publishBurn).toHaveBeenCalledTimes(1)
    expect(publishBurn.mock.calls[0][0]).toMatchObject({ requestsPerH: { "ari@msft.ghe.com": 1 }, readings: [reading("ari@msft.ghe.com", 10)] })
  })

  it("publishes the agent's burn across its processes, counted from each one's request times", () => {
    const burnDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-account-burn-"))
    fs.writeFileSync(path.join(burnDir, "1.json"), JSON.stringify({ requests: [
      { key: "ari@msft.ghe.com", at: NOW - 60_000 },
      { key: "ari@microsoft.ghe.com", at: NOW - 30_000 },
      { key: "ari@msft.ghe.com", at: NOW - 2 * 60 * 60 * 1000 },
      { key: "ari@msft.ghe.com", at: NOW + 60_000 },
      { key: 7, at: NOW },
      { key: "ari@msft.ghe.com" },
    ] }))
    fs.writeFileSync(path.join(burnDir, "2.json"), "{half")
    fs.writeFileSync(path.join(burnDir, "3.json"), JSON.stringify({ totals: 9 }))
    fs.writeFileSync(path.join(burnDir, "notes.txt"), "x")
    const publishBurn = vi.fn(async () => true)
    const { pool: p, advance } = pool([MSFT, MSCOM], { publishBurn, burnDir })
    p.recordRequest("ari@msft.ghe.com")
    expect(publishBurn.mock.calls[0][0]).toMatchObject({ requestsPerH: { "ari@msft.ghe.com": 2, "ari@microsoft.ghe.com": 1 } })
    expect(JSON.parse(fs.readFileSync(path.join(burnDir, `${process.pid}.json`), "utf8"))).toEqual({ requests: [{ key: "ari@msft.ghe.com", at: NOW }] })
    advance(60 * 60 * 1000 - 45_000)
    // An hour on, the other process's older request has aged out without it writing anything.
    expect(p.agentBurnPerH(NOW + 60 * 60 * 1000 - 45_000)).toEqual({ "ari@msft.ghe.com": 2, "ari@microsoft.ghe.com": 1 })
    expect(p.agentBurnPerH(NOW + 2 * 60 * 60 * 1000)).toEqual({})
  })

  it("falls back to this process's burn when the shared folder can't be used", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-account-burn-")), "not-a-dir")
    fs.writeFileSync(file, "x")
    const publishBurn = vi.fn(async () => true)
    const { pool: p } = pool([MSFT], { publishBurn, burnDir: file })
    p.recordRequest("ari@msft.ghe.com")
    expect(publishBurn.mock.calls[0][0]).toMatchObject({ requestsPerH: { "ari@msft.ghe.com": 1 } })
    expect(p.agentBurnPerH(NOW)).toEqual({ "ari@msft.ghe.com": 1 })
  })

  it("shares refusals with the agent's other processes, so each process doesn't pay the same 429", () => {
    const refusalsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-account-refusals-")), "state", "account-refusals.json")
    const first = pool([EMU, MSCOM], { refusalsFile })
    first.pool.beforeTurn()
    expect(first.pool.onRefusal("ari_microsoft@github.com", 429, new Error("429 quota exceeded"))).toBe(MSCOM)
    expect(JSON.parse(fs.readFileSync(refusalsFile, "utf8"))).toEqual({ "ari_microsoft@github.com": Date.parse("2026-12-01T00:00:00.000Z") })
    // A new process starts on the next account, without trying the refused one.
    const second = pool([EMU, MSCOM], { refusalsFile })
    expect(second.pool.beforeTurn()).toBe(MSCOM)
    expect(second.records().map((r) => [r.to, r.reason])).toEqual([["ari@microsoft.ghe.com", "start"]])
  })

  it("takes in refusals recorded after it started, keeps the later end, and ignores stale or malformed entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-account-refusals-"))
    const refusalsFile = path.join(dir, "account-refusals.json")
    const { pool: p } = pool([EMU, MSCOM, MSFT], { refusalsFile })
    expect(p.beforeTurn()).toBe(EMU)
    p.refused["ari@microsoft.ghe.com"] = NOW + 10_000
    fs.writeFileSync(refusalsFile, JSON.stringify({
      "ari_microsoft@github.com": NOW + 60_000,
      "ari@microsoft.ghe.com": NOW + 5_000,
      "old@github.com": NOW - 1,
      "bad@github.com": "soon",
    }))
    expect(p.beforeTurn()).toBe(MSFT)
    expect(p.refused).toEqual({ "ari_microsoft@github.com": NOW + 60_000, "ari@microsoft.ghe.com": NOW + 10_000 })
    fs.writeFileSync(refusalsFile, "{half")
    expect(p.beforeTurn()).toBe(MSFT)
  })

  it("still switches when refusals can't be shared", () => {
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-account-refusals-")), "file")
    fs.writeFileSync(blocker, "x")
    const { pool: p } = pool([EMU, MSCOM], { refusalsFile: path.join(blocker, "account-refusals.json") })
    p.beforeTurn()
    expect(p.onRefusal("ari_microsoft@github.com", 429, new Error("429 quota exceeded"))).toBe(MSCOM)
  })

  it("names the machine once, from this Mac's own name, when none is configured", () => {
    const publishBurn = vi.fn(async () => true)
    const machineName = vi.fn(() => "aris-mac-mini")
    const p = new AccountPool([MSFT], { agent: "a", switchLog: "/x", appendLine: () => {}, publishBurn, machineName, publishMs: 0 })
    p.recordRequest("ari@msft.ghe.com")
    p.recordRequest("ari@msft.ghe.com")
    expect(publishBurn.mock.calls.map((call) => (call[0] as { machine: string }).machine)).toEqual(["aris-mac-mini", "aris-mac-mini"])
    expect(machineName).toHaveBeenCalledTimes(1)
    const q = new AccountPool([MSFT], { agent: "a", switchLog: "/x", appendLine: () => {}, publishBurn })
    q.recordRequest("ari@msft.ghe.com")
    expect((publishBurn.mock.calls[2][0] as { machine: string }).machine).not.toContain(".")
  })

  it("uses the Mac balancer's machine name, else macOS's LocalHostName, else the host name, lowercased with no dots", () => {
    const scutil = (status: number, stdout: string) => spawnMock(() => ({ status, stdout }))
    const none = () => { throw new Error("ENOENT") }
    const state = (value: unknown) => (file: string) => {
      expect(file).toBe(path.join("/h", ".config", "mac-fleet", "quota-balance.json"))
      return JSON.stringify(value)
    }
    expect(defaultMachineName({ homeDir: "/h", readFile: state({ last: { machine: " laptop " } }), platform: "darwin", spawnSync: scutil(0, "Aris-MacBook-Pro") })).toBe("laptop")
    expect(defaultMachineName({ homeDir: "/h", readFile: state({ last: { machine: 7 } }), platform: "darwin", spawnSync: scutil(0, "Aris-MacBook-Pro\n") })).toBe("aris-macbook-pro")
    expect(defaultMachineName({ homeDir: "/h", readFile: state(null), platform: "linux", hostname: () => "Box" })).toBe("box")
    expect(defaultMachineName({ readFile: none, platform: "darwin", spawnSync: scutil(1, ""), hostname: () => "Mac.lan" })).toBe("mac")
    expect(defaultMachineName({ readFile: none, platform: "darwin", spawnSync: scutil(0, undefined as unknown as string), hostname: () => "Box" })).toBe("box")
    expect(defaultMachineName({ readFile: none, platform: "linux", hostname: () => "My Host.example.com" })).toBe("my-host")
    expect(defaultMachineName({ homeDir: "/nonexistent-home", platform: "linux" })).toBe(os.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-"))
    expect(typeof defaultMachineName()).toBe("string")
  })


  it("refreshes readings in the background, at most once per interval, and republishes them", async () => {
    const loadReadings = vi.fn(async () => [reading("ari@msft.ghe.com", 40)])
    const publishBurn = vi.fn(async () => true)
    const { pool: p, advance } = pool([MSFT, MSCOM], { loadReadings, refreshMs: 1000, publishBurn })
    const first = p.refreshIfStale()
    expect(p.refreshIfStale()).toBe(first)
    await first
    expect(p.readings).toEqual([reading("ari@msft.ghe.com", 40)])
    expect(publishBurn.mock.calls[0][0]).toMatchObject({ readings: [reading("ari@msft.ghe.com", 40)] })
    await p.refreshIfStale()
    expect(loadReadings).toHaveBeenCalledTimes(1)
    advance(1000)
    await p.refreshIfStale()
    expect(loadReadings).toHaveBeenCalledTimes(2)
  })

  it("keeps going when readings can't be loaded", async () => {
    const loadReadings = vi.fn(async () => { throw new Error("offline") })
    const { pool: p } = pool([MSFT], { loadReadings })
    await p.refreshIfStale()
    const nonError = pool([MSFT], { loadReadings: vi.fn(async () => { throw "down" }) })
    await nonError.pool.refreshIfStale()
    expect(p.readings).toEqual([])
    await new AccountPool([MSFT], { agent: "a", switchLog: "/x" }).refreshIfStale()
  })

  it("keeps going when the switch log can't be written", () => {
    const p = new AccountPool([MSFT], { agent: "a", switchLog: "/x", appendLine: () => { throw new Error("read-only") } })
    expect(p.beforeTurn()).toBe(MSFT)
    const q = new AccountPool([MSFT], { agent: "a", switchLog: "/x", appendLine: () => { throw "nope" } })
    expect(q.beforeTurn()).toBe(MSFT)
  })

  it("writes state/account-switches.jsonl by default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-account-pool-"))
    const switchLog = path.join(dir, "state", "account-switches.jsonl")
    new AccountPool([MSFT], { agent: "a", switchLog }).beforeTurn()
    expect(JSON.parse(fs.readFileSync(switchLog, "utf8").trim())).toMatchObject({ agent: "a", to: "ari@msft.ghe.com", reason: "start" })
  })
})

describe("createPooledCaller", () => {
  const status = (code: number, message = `${code} quota exceeded`) => Object.assign(new Error(message), { status: code })

  it("chooses the account once and reuses its client", async () => {
    const { pool: p } = pool([MSFT, MSCOM])
    const makeClient = vi.fn((account: PoolAccount) => ({ token: account.githubToken }))
    const caller = createPooledCaller(p, makeClient)
    expect(caller.account()).toBe(MSFT)
    expect(caller.client()).toEqual({ token: "t-msft" })
    await expect(caller.call(async (client, account) => `${client.token}:${account.host}`)).resolves.toBe("t-msft:msft.ghe.com")
    expect(makeClient).toHaveBeenCalledTimes(1)
    expect(p.burnPerH()).toEqual({ "ari@msft.ghe.com": 1 })
  })

  it("on a 429 switches at once and retries that turn once on the next account", async () => {
    const { pool: p, records } = pool([MSFT, MSCOM])
    const caller = createPooledCaller(p, (account) => account.githubToken)
    const request = vi.fn(async (token: string) => {
      if (token === "t-msft") throw status(429)
      return "ok"
    })
    await expect(caller.call(request)).resolves.toBe("ok")
    expect(request.mock.calls.map((call) => call[0])).toEqual(["t-msft", "t-mscom"])
    expect(caller.account()).toBe(MSCOM)
    expect(records().map((r) => r.reason)).toEqual(["start", "429"])
    expect(p.burnPerH()).toEqual({ "ari@msft.ghe.com": 1, "ari@microsoft.ghe.com": 1 })
  })

  it("on a 401 benches the account for an hour, logs it, and retries once on the next account; later turns skip it", async () => {
    const { pool: p, records, advance } = pool([MSFT, MSCOM])
    const request = vi.fn(async (token: string) => {
      if (token === "t-msft") throw status(401, "Bad credentials")
      return "ok"
    })
    await expect(createPooledCaller(p, (account) => account.githubToken).call(request)).resolves.toBe("ok")
    expect(request.mock.calls.map((call) => call[0])).toEqual(["t-msft", "t-mscom"])
    expect(records().map((r) => [r.from, r.to, r.reason, r.refusedUntil])).toEqual([
      [null, "ari@msft.ghe.com", "start", undefined],
      ["ari@msft.ghe.com", "ari@microsoft.ghe.com", "401", new Date(NOW + 60 * 60_000).toISOString()],
    ])
    advance(30 * 60_000)
    await createPooledCaller(p, (account) => account.githubToken).call(request)
    expect(request.mock.calls.map((call) => call[0])).toEqual(["t-msft", "t-mscom", "t-mscom"])
  })

  it("retries only once, even if the next account also refuses", async () => {
    const { pool: p } = pool([MSFT, MSCOM, EMU])
    const caller = createPooledCaller(p, (account) => account.githubToken)
    const request = vi.fn(async () => { throw status(402, "payment required") })
    await expect(caller.call(request)).rejects.toThrow("payment required")
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("rethrows other errors, and a refusal no other account can take", async () => {
    const { pool: p } = pool([MSFT, MSCOM])
    const caller = createPooledCaller(p, (account) => account.githubToken)
    await expect(caller.call(async () => { throw status(500, "server") })).rejects.toThrow("server")
    await expect(caller.call(async () => { throw null })).rejects.toBeNull()
    const single = createPooledCaller(pool([MSFT]).pool, (account) => account.githubToken)
    await expect(single.call(async () => { throw status(429) })).rejects.toThrow("429 quota exceeded")
  })
})

describe("fetchDirectReadings", () => {
  it("reads each account on its own host and skips failures", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization
      if (auth === "token t-emu") throw new Error("offline")
      if (url.includes("microsoft.ghe.com")) return new Response("{}", { status: 500 })
      return new Response(JSON.stringify(copilotUser("ari", "https://x", 95)))
    })
    const readings = await fetchDirectReadings([MSFT, MSCOM, EMU], { fetch: fetchMock as unknown as typeof fetch, now: () => new Date(NOW) })
    expect(readings).toEqual([expect.objectContaining({ key: "ari@msft.ghe.com", leftPct: 95, at: "2026-11-10T03:00:00.000Z" })])
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://api.msft.ghe.com/copilot_internal/user")
  })

  it("defaults to the global fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })))
    await expect(fetchDirectReadings([MSFT])).resolves.toEqual([])
  })
})

describe("getAccountPool", () => {
  it("keeps one pool per agent across turns, and a new one when the accounts change", () => {
    const options = { agent: "ouroboros", switchLog: "/x", appendLine: () => {} }
    const first = getAccountPool([MSFT, MSCOM], options)
    expect(getAccountPool([MSFT, MSCOM], options)).toBe(first)
    expect(getAccountPool([MSCOM], options)).not.toBe(first)
    resetAccountPools()
    expect(getAccountPool([MSCOM], options)).not.toBe(first)
  })
})
